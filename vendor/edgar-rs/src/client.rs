use std::collections::HashMap;
use std::num::NonZeroU32;
use std::sync::Arc;

use governor::clock::DefaultClock;
use governor::state::{InMemoryState, NotKeyed};
use governor::{Quota, RateLimiter};

use crate::cik::Cik;
use crate::error::{Error, Result};
use crate::models::*;

const DEFAULT_RATE_LIMIT: u32 = 10;

const BASE_SEC_URL: &str = "https://www.sec.gov";
const BASE_DATA_URL: &str = "https://data.sec.gov";
const BASE_EFTS_URL: &str = "https://efts.sec.gov";

type Limiter = RateLimiter<NotKeyed, InMemoryState, DefaultClock>;

/// An async HTTP client for the SEC EDGAR API.
///
/// Handles rate limiting, User-Agent headers, and JSON deserialization.
/// Construct via [`ClientBuilder`].
///
/// # Example
/// ```no_run
/// # async fn example() -> edgar_rs::Result<()> {
/// let client = edgar_rs::ClientBuilder::new("MyApp/1.0 contact@example.com")
///     .build()?;
///
/// let tickers = client.get_tickers().await?;
/// # Ok(())
/// # }
/// ```
#[derive(Debug)]
pub struct Client {
    http: reqwest::Client,
    limiter: Arc<Limiter>,
    base_sec_url: String,
    base_data_url: String,
    base_efts_url: String,
}

/// Builder for constructing a [`Client`].
pub struct ClientBuilder {
    user_agent: String,
    rate_limit: u32,
    http_client: Option<reqwest::Client>,
    base_sec_url: Option<String>,
    base_data_url: Option<String>,
    base_efts_url: Option<String>,
}

impl ClientBuilder {
    /// Creates a new builder. The user agent is required by SEC EDGAR policy.
    /// Typically in the format `"AppName/Version contact@email.com"`.
    pub fn new(user_agent: impl Into<String>) -> Self {
        Self {
            user_agent: user_agent.into(),
            rate_limit: DEFAULT_RATE_LIMIT,
            http_client: None,
            base_sec_url: None,
            base_data_url: None,
            base_efts_url: None,
        }
    }

    /// Override the default rate limit of 10 requests per second.
    /// Setting a value above 10 is not recommended per SEC fair access policy.
    pub fn rate_limit(mut self, requests_per_second: u32) -> Self {
        self.rate_limit = requests_per_second;
        self
    }

    /// Provide a pre-configured `reqwest::Client`.
    /// Useful for custom timeouts, proxies, or testing.
    /// Note: the User-Agent default header on this client will be overridden.
    pub fn http_client(mut self, client: reqwest::Client) -> Self {
        self.http_client = Some(client);
        self
    }

    /// Override the base SEC URL (for testing).
    #[doc(hidden)]
    pub fn base_sec_url(mut self, url: impl Into<String>) -> Self {
        self.base_sec_url = Some(url.into());
        self
    }

    /// Override the base data URL (for testing).
    #[doc(hidden)]
    pub fn base_data_url(mut self, url: impl Into<String>) -> Self {
        self.base_data_url = Some(url.into());
        self
    }

    /// Override the base EFTS URL (for testing).
    #[doc(hidden)]
    pub fn base_efts_url(mut self, url: impl Into<String>) -> Self {
        self.base_efts_url = Some(url.into());
        self
    }

    /// Build the [`Client`]. Returns an error if configuration is invalid.
    pub fn build(self) -> Result<Client> {
        if self.user_agent.is_empty() {
            return Err(Error::Config(
                "user-agent is required by SEC EDGAR policy".into(),
            ));
        }

        let http = match self.http_client {
            Some(c) => c,
            None => {
                let mut headers = reqwest::header::HeaderMap::new();
                headers.insert(
                    reqwest::header::USER_AGENT,
                    reqwest::header::HeaderValue::from_str(&self.user_agent).map_err(|_| {
                        Error::Config("user-agent contains invalid header characters".into())
                    })?,
                );
                reqwest::Client::builder()
                    .default_headers(headers)
                    .build()
                    .map_err(|e| Error::Config(format!("failed to build HTTP client: {e}")))?
            }
        };

        let quota = Quota::per_second(
            NonZeroU32::new(self.rate_limit)
                .ok_or_else(|| Error::Config("rate limit must be > 0".into()))?,
        );
        let limiter = Arc::new(RateLimiter::direct(quota));

        Ok(Client {
            http,
            limiter,
            base_sec_url: self.base_sec_url.unwrap_or_else(|| BASE_SEC_URL.to_owned()),
            base_data_url: self
                .base_data_url
                .unwrap_or_else(|| BASE_DATA_URL.to_owned()),
            base_efts_url: self
                .base_efts_url
                .unwrap_or_else(|| BASE_EFTS_URL.to_owned()),
        })
    }
}

impl Client {
    /// Internal: wait for rate limiter, send GET request, check status, return body as bytes.
    async fn get_bytes(&self, url: &str) -> Result<Vec<u8>> {
        self.limiter.until_ready().await;

        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| Error::Request {
                endpoint: url.to_owned(),
                source: e,
            })?;

        let status = response.status();
        if !status.is_success() {
            return Err(Error::Api {
                status,
                endpoint: url.to_owned(),
                message: format!("unexpected status {status}"),
            });
        }

        response
            .bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| Error::Request {
                endpoint: url.to_owned(),
                source: e,
            })
    }

    /// Internal: GET + JSON deserialization.
    async fn get_json<T: serde::de::DeserializeOwned>(&self, url: &str) -> Result<T> {
        self.limiter.until_ready().await;

        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| Error::Request {
                endpoint: url.to_owned(),
                source: e,
            })?;

        let status = response.status();
        if !status.is_success() {
            return Err(Error::Api {
                status,
                endpoint: url.to_owned(),
                message: format!("unexpected status {status}"),
            });
        }

        response.json::<T>().await.map_err(|e| Error::Decode {
            endpoint: url.to_owned(),
            source: e,
        })
    }

    // ─── Public API Methods ────────────────────────────

    /// Fetches the complete mapping of CIK numbers to ticker symbols.
    /// The returned map is keyed by CIK number as a string.
    pub async fn get_tickers(&self) -> Result<HashMap<String, Ticker>> {
        let url = format!("{}/files/company_tickers.json", self.base_sec_url);
        let raw: HashMap<String, Ticker> = self.get_json(&url).await?;
        let result = raw.into_values().map(|t| (t.cik.to_string(), t)).collect();
        Ok(result)
    }

    /// Fetches company submission data for the given CIK.
    /// Includes company metadata and recent filing history.
    pub async fn get_submission(&self, cik: Cik) -> Result<Submission> {
        let url = format!(
            "{}/submissions/CIK{}.json",
            self.base_data_url,
            cik.to_padded_string()
        );
        self.get_json(&url).await
    }

    /// Fetches a specific filing document from EDGAR.
    /// The accession number should be in dashed format (e.g., `"0000320193-24-000123"`);
    /// dashes are stripped automatically for the URL path.
    pub async fn get_document(
        &self,
        cik: Cik,
        accession: &str,
        primary_doc: &str,
    ) -> Result<String> {
        let clean_acc = accession.replace('-', "");
        let url = format!(
            "{}/Archives/edgar/data/{}/{}/{}",
            self.base_sec_url,
            cik.to_padded_string(),
            clean_acc,
            primary_doc
        );
        let bytes = self.get_bytes(&url).await?;
        String::from_utf8(bytes).map_err(|e| Error::DecodeBody {
            endpoint: url,
            message: format!("response is not valid UTF-8: {e}"),
        })
    }

    /// Fetches all XBRL disclosures for a single concept from a company.
    /// Taxonomy is typically `"us-gaap"`, `"dei"`, `"ifrs-full"`, `"srt"`, or `"invest"`.
    /// Tag is the concept name, e.g., `"AccountsPayableCurrent"` or `"Revenues"`.
    pub async fn get_company_concept(
        &self,
        cik: Cik,
        taxonomy: &str,
        tag: &str,
    ) -> Result<CompanyConcept> {
        let url = format!(
            "{}/api/xbrl/companyconcept/CIK{}/{}/{}.json",
            self.base_data_url,
            cik.to_padded_string(),
            taxonomy,
            tag
        );
        self.get_json(&url).await
    }

    /// Fetches all XBRL facts for a company in a single call.
    /// The response can be very large (multi-MB) as it includes every concept
    /// the company has ever reported.
    pub async fn get_company_facts(&self, cik: Cik) -> Result<CompanyFacts> {
        let url = format!(
            "{}/api/xbrl/companyfacts/CIK{}.json",
            self.base_data_url,
            cik.to_padded_string()
        );
        self.get_json(&url).await
    }

    /// Fetches aggregated XBRL data across all companies for a given
    /// concept, unit, and period.
    ///
    /// Period format examples:
    /// - `"CY2023"` for annual
    /// - `"CY2023Q1"` for quarterly duration
    /// - `"CY2023Q1I"` for quarterly instantaneous
    pub async fn get_frame(
        &self,
        taxonomy: &str,
        tag: &str,
        unit: &str,
        period: &str,
    ) -> Result<Frame> {
        let url = format!(
            "{}/api/xbrl/frames/{}/{}/{}/{}.json",
            self.base_data_url, taxonomy, tag, unit, period
        );
        self.get_json(&url).await
    }

    /// Performs a full-text search across EDGAR filings.
    /// The query string supports wildcards (`*`), boolean operators (`OR`, `NOT`),
    /// and exact phrase matching with quotes.
    pub async fn search(
        &self,
        query: &str,
        options: Option<&SearchOptions>,
    ) -> Result<SearchResult> {
        let mut params = vec![("q".to_owned(), query.to_owned())];

        if let Some(opts) = options {
            if !opts.forms.is_empty() {
                params.push(("forms".to_owned(), opts.forms.join(",")));
            }
            if opts.date_start.is_some() || opts.date_end.is_some() {
                params.push(("dateRange".to_owned(), "custom".to_owned()));
                if let Some(ref start) = opts.date_start {
                    params.push(("startdt".to_owned(), start.clone()));
                }
                if let Some(ref end) = opts.date_end {
                    params.push(("enddt".to_owned(), end.clone()));
                }
            }
            if let Some(from) = opts.from
                && from > 0
            {
                params.push(("from".to_owned(), from.to_string()));
            }
        }

        let url = reqwest::Url::parse_with_params(
            &format!("{}/LATEST/search-index", self.base_efts_url),
            &params,
        )
        .map_err(|e| Error::Config(format!("failed to build search URL: {e}")))?;

        let raw: EftsResponse = self.get_json(url.as_str()).await?;

        let hits = raw
            .hits
            .hits
            .into_iter()
            .map(|h| SearchHit {
                id: h.id,
                score: h.score,
                ciks: h.source.ciks,
                display_names: h.source.display_names,
                form: h.source.form.unwrap_or_default(),
                file_date: h.source.file_date.unwrap_or_default(),
                period_ending: h.source.period_ending,
                accession_number: h.source.adsh.unwrap_or_default(),
                file_type: h.source.file_type.unwrap_or_default(),
                file_description: h.source.file_description.unwrap_or_default(),
            })
            .collect();

        Ok(SearchResult {
            total: raw.hits.total.value,
            hits,
        })
    }
}
