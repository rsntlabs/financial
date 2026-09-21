use crate::{Needs, Provider, Request};
use async_trait::async_trait;
use chrono::NaiveDate;
use edgar_rs::{CompanyFacts, Fact};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashMap},
    time::Duration,
};
use tokio::sync::Mutex;
use web_time::Instant;
use yfinance_core::dataset::Dataset;

#[derive(Deserialize, Serialize)]
pub struct TickerEntry {
    pub ticker: String,
    pub name: String,
    /// The issuer's SEC CIK, which company facts are requested by. Every entry
    /// carries it so a page holding a saved list can hand the lookup map back
    /// (see `prime_tickers`) instead of downloading the SEC ticker file again
    /// before the first company can be opened.
    pub cik: u64,
}

// Ordered aliases: prefer consolidated revenue and income over narrower concepts.
const MAPPINGS: &[(&str, &[&str], bool)] = &[
    (
        "annualTotalRevenue",
        &[
            "RevenueFromContractWithCustomerExcludingAssessedTax",
            "Revenues",
            "SalesRevenueNet",
        ],
        false,
    ),
    (
        "annualCostOfRevenue",
        &["CostOfRevenue", "CostOfGoodsAndServicesSold"],
        false,
    ),
    ("annualGrossProfit", &["GrossProfit"], false),
    ("annualOperatingIncome", &["OperatingIncomeLoss"], false),
    ("annualNetIncome", &["NetIncomeLoss", "ProfitLoss"], false),
    ("annualBasicEPS", &["EarningsPerShareBasic"], false),
    ("annualDilutedEPS", &["EarningsPerShareDiluted"], false),
    (
        "annualCashAndCashEquivalents",
        &["CashAndCashEquivalentsAtCarryingValue"],
        true,
    ),
    (
        "annualAccountsReceivable",
        &["AccountsReceivableNetCurrent"],
        true,
    ),
    ("annualInventory", &["InventoryNet"], true),
    ("annualCurrentAssets", &["AssetsCurrent"], true),
    ("annualNetPPE", &["PropertyPlantAndEquipmentNet"], true),
    ("annualGrossPPE", &["PropertyPlantAndEquipmentGross"], true),
    ("annualTotalNonCurrentAssets", &["AssetsNoncurrent"], true),
    ("annualTotalAssets", &["Assets"], true),
    ("annualAccountsPayable", &["AccountsPayableCurrent"], true),
    ("annualCurrentLiabilities", &["LiabilitiesCurrent"], true),
    ("annualLongTermDebt", &["LongTermDebtNoncurrent"], true),
    (
        "annualTotalNonCurrentLiabilitiesNetMinorityInterest",
        &["LiabilitiesNoncurrent"],
        true,
    ),
    (
        "annualTotalLiabilitiesNetMinorityInterest",
        &["Liabilities"],
        true,
    ),
    (
        "annualRetainedEarnings",
        &["RetainedEarningsAccumulatedDeficit"],
        true,
    ),
    ("annualStockholdersEquity", &["StockholdersEquity"], true),
    (
        "annualOperatingCashFlow",
        &["NetCashProvidedByUsedInOperatingActivities"],
        false,
    ),
    (
        "annualCapitalExpenditure",
        &["PaymentsToAcquirePropertyPlantAndEquipment"],
        false,
    ),
    (
        "annualDepreciationAmortizationDepletion",
        &["DepreciationDepletionAndAmortization"],
        false,
    ),
    (
        "annualInvestingCashFlow",
        &["NetCashProvidedByUsedInInvestingActivities"],
        false,
    ),
    (
        "annualIssuanceOfDebt",
        &["ProceedsFromIssuanceOfLongTermDebt"],
        false,
    ),
    (
        "annualRepaymentOfDebt",
        &["RepaymentsOfLongTermDebt"],
        false,
    ),
    (
        "annualRepurchaseOfCapitalStock",
        &["PaymentsForRepurchaseOfCommonStock"],
        false,
    ),
    (
        "annualCashDividendsPaid",
        &["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"],
        false,
    ),
    (
        "annualFinancingCashFlow",
        &["NetCashProvidedByUsedInFinancingActivities"],
        false,
    ),
    (
        "annualChangesInCash",
        &["CashAndCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect"],
        false,
    ),
];
fn annual(f: &Fact) -> bool {
    if !matches!(
        f.form.as_str(),
        "10-K" | "10-K/A" | "20-F" | "20-F/A" | "40-F" | "40-F/A"
    ) || f.fp != "FY"
        || !f.val.is_finite()
    {
        return false;
    }
    let Some(start) = f
        .start
        .as_deref()
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
    else {
        return false;
    };
    let Ok(end) = NaiveDate::parse_from_str(&f.end, "%Y-%m-%d") else {
        return false;
    };
    (330..=380).contains(&(end - start).num_days())
}

pub fn normalize(facts: &CompanyFacts) -> Dataset {
    let mut data = Dataset::new();
    data.name = Some(facts.entity_name.clone());
    let Some(gaap) = facts.facts.get("us-gaap") else {
        data.warnings.push(
            "SEC issuer has no supported US GAAP facts; other providers may supply statements."
                .into(),
        );
        return data;
    };
    let currencies: BTreeSet<_> = MAPPINGS[0]
        .1
        .iter()
        .filter_map(|tag| gaap.get(*tag))
        .flat_map(|c| &c.units)
        .filter(|(unit, facts)| unit.len() == 3 && facts.iter().any(annual))
        .map(|(u, _)| u.clone())
        .collect();
    if currencies.len() != 1 {
        data.warnings.push(
            "SEC reporting currency is ambiguous or unavailable; skipped financial values.".into(),
        );
        return data;
    }
    let currency = currencies.into_iter().next().unwrap();
    let ends: BTreeSet<_> = MAPPINGS[0]
        .1
        .iter()
        .filter_map(|tag| gaap.get(*tag))
        .filter_map(|c| c.units.get(&currency))
        .flatten()
        .filter(|f| annual(f))
        .map(|f| f.end.clone())
        .collect();
    data.currency = Some(currency.clone());
    for (metric, tags, instant) in MAPPINGS {
        let unit = if metric.ends_with("EPS") {
            format!("{currency}/shares")
        } else {
            currency.clone()
        };
        for tag in *tags {
            let Some(values) = gaap.get(*tag).and_then(|c| c.units.get(&unit)) else {
                continue;
            };
            let mut values: Vec<_> = values
                .iter()
                .filter(|f| {
                    if *instant {
                        f.start.is_none()
                            && ends.contains(&f.end)
                            && matches!(
                                f.form.as_str(),
                                "10-K" | "10-K/A" | "20-F" | "20-F/A" | "40-F" | "40-F/A"
                            )
                    } else {
                        annual(f)
                    }
                })
                .collect();
            // Restated comparative facts use the actual period end, never filing fiscal-year metadata.
            values.sort_by(|a, b| b.filed.cmp(&a.filed).then_with(|| b.accn.cmp(&a.accn)));
            for f in values {
                data.insert(metric, &f.end, f.val, "SEC EDGAR");
            }
        }
    }
    data.derive();
    data
}
struct Cache {
    tickers: HashMap<String, (u64, String)>,
    tickers_at: Instant,
    facts: Option<(String, Instant, CompanyFacts)>,
}
pub struct Edgar {
    client: edgar_rs::Client,
    http: reqwest::Client,
    tickers_url: String,
    cache: Mutex<Cache>,
}

const SEC_TICKERS_PATH: &str = "/files/company_tickers.json";
const TICKERS_TTL: Duration = Duration::from_secs(24 * 60 * 60);
fn new_cache() -> Mutex<Cache> {
    Mutex::new(Cache {
        tickers: HashMap::new(),
        tickers_at: Instant::now(),
        facts: None,
    })
}

#[cfg(not(target_arch = "wasm32"))]
impl Edgar {
    pub fn new(user_agent: &str) -> Result<Self, String> {
        if !user_agent.contains('@') {
            return Err(
                "Set SEC_USER_AGENT to your application name and real contact email.".into(),
            );
        }
        let http = reqwest::Client::builder()
            .user_agent(user_agent)
            .timeout(Duration::from_secs(25))
            .build()
            .map_err(|_| "Invalid SEC user agent.")?;
        // edgar-rs does not apply its user agent when a custom client is supplied.
        let client = edgar_rs::ClientBuilder::new(user_agent)
            .http_client(http.clone())
            .rate_limit(5)
            .build()
            .map_err(|_| "Could not initialize SEC client.")?;
        Ok(Self {
            client,
            http,
            tickers_url: format!("https://www.sec.gov{SEC_TICKERS_PATH}"),
            cache: new_cache(),
        })
    }
}

// SEC EDGAR does not grant CORS to arbitrary origins, so the browser build
// routes through a same-origin Cloudflare Worker that injects the real
// SEC_USER_AGENT. The 5 req/s limiter below is per browser tab, not global:
// the Worker itself does not throttle aggregate traffic across tabs or users.
#[cfg(target_arch = "wasm32")]
impl Edgar {
    pub fn new(proxy_base: &str) -> Result<Self, String> {
        let proxy_base = proxy_base.trim_end_matches('/');
        let sec_base = format!("{proxy_base}/sec");
        let tickers_url = format!("{sec_base}{SEC_TICKERS_PATH}");
        let http = reqwest::Client::new();
        let client = edgar_rs::ClientBuilder::new("Financials browser (proxied)")
            .http_client(http.clone())
            .base_sec_url(sec_base.clone())
            .base_data_url(sec_base)
            .rate_limit(5)
            .build()
            .map_err(|_| "Could not initialize SEC client.")?;
        Ok(Self {
            client,
            http,
            tickers_url,
            cache: new_cache(),
        })
    }
}
impl Edgar {
    async fn refresh_tickers(&self, cache: &mut Cache) -> Result<(), String> {
        if !cache.tickers.is_empty() && cache.tickers_at.elapsed() <= TICKERS_TTL {
            return Ok(());
        }
        // Preserve share classes: edgar-rs get_tickers keys by CIK, discarding duplicate CIK tickers.
        let tickers: HashMap<String, edgar_rs::Ticker> = self
            .http
            .get(&self.tickers_url)
            .send()
            .await
            .map_err(|_| "SEC ticker lookup unavailable.")?
            .error_for_status()
            .map_err(|_| "SEC ticker lookup rejected.")?
            .json()
            .await
            .map_err(|_| "SEC ticker lookup unreadable.")?;
        cache.tickers = tickers
            .into_values()
            .map(|t| (t.ticker.replace('.', "-"), (t.cik, t.title)))
            .collect();
        cache.tickers_at = Instant::now();
        Ok(())
    }

    /// Every SEC-registered ticker and company name, for client-side search.
    pub async fn tickers(&self) -> Result<Vec<TickerEntry>, String> {
        let mut cache = self.cache.lock().await;
        self.refresh_tickers(&mut cache).await?;
        Ok(cache
            .tickers
            .iter()
            .map(|(ticker, (cik, name))| TickerEntry {
                ticker: ticker.clone(),
                name: name.clone(),
                cik: *cik,
            })
            .collect())
    }

    /// Loads the ticker -> CIK map from a list a caller saved earlier, so the
    /// statements path can ask for company facts straight away rather than
    /// waiting on the SEC ticker file first. A map already downloaded in this
    /// process is left alone: it is at least as fresh as anything handed back
    /// here, and may be mid-request behind the same lock.
    pub async fn prime_tickers(&self, entries: Vec<TickerEntry>) {
        if entries.is_empty() {
            return;
        }
        let mut cache = self.cache.lock().await;
        if !cache.tickers.is_empty() {
            return;
        }
        cache.tickers = entries
            .into_iter()
            .map(|entry| (entry.ticker.replace('.', "-"), (entry.cik, entry.name)))
            .collect();
        cache.tickers_at = Instant::now();
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl Provider for Edgar {
    fn name(&self) -> &'static str {
        "SEC EDGAR"
    }
    async fn financials(&self, request: &Request, _needs: &Needs) -> Result<Dataset, String> {
        let mut cache = self.cache.lock().await;
        if let Some((ticker, at, facts)) = &cache.facts {
            if ticker == &request.ticker && at.elapsed() < Duration::from_secs(3600) {
                return Ok(normalize(facts));
            }
        }
        self.refresh_tickers(&mut cache).await?;
        let cik = cache
            .tickers
            .get(&request.ticker.replace('.', "-"))
            .map(|(cik, _)| *cik)
            .ok_or("No SEC issuer for this ticker.")?;
        let facts = self
            .client
            .get_company_facts(cik.into())
            .await
            .map_err(|_| "SEC facts unavailable.")?;
        let data = normalize(&facts);
        cache.facts = Some((request.ticker.clone(), Instant::now(), facts));
        Ok(data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn annual_facts_use_actual_end_dates_latest_restatements_and_correct_units() {
        let fact = |start: &str, end: &str, value: f64, filed: &str| json!({"start":start,"end":end,"val":value,"filed":filed,"form":"10-K","fp":"FY","fy":2025,"accn":filed});
        let facts: CompanyFacts = serde_json::from_value(json!({"cik":1,"entityName":"Test","facts":{"us-gaap":{
            "Revenues":{"label":"Revenue","description":"","units":{"USD":[
                fact("2023-01-01","2023-12-31",100.,"2024-02-01"),
                fact("2023-01-01","2023-12-31",110.,"2025-02-01"),
                fact("2024-10-01","2024-12-31",30.,"2025-02-01")]}},
            "Assets":{"label":"Assets","description":"","units":{"USD":[{"end":"2023-12-31","val":200.,"filed":"2025-02-01","form":"10-K","fp":"FY","fy":2025,"accn":"a"},{"end":"2024-09-30","val":999.,"filed":"2025-02-01","form":"10-K","fp":"FY","accn":"a"}]}},
            "EarningsPerShareBasic":{"label":"EPS","description":"","units":{"USD/shares":[fact("2023-01-01","2023-12-31",2.,"2025-02-01")],"shares":[fact("2023-01-01","2023-12-31",999.,"2025-02-01")]}}
        }}})).unwrap();
        let data = normalize(&facts);
        assert_eq!(data.value("annualTotalRevenue", "2023-12-31"), Some(110.));
        assert_eq!(data.value("annualTotalRevenue", "2024-12-31"), None);
        assert_eq!(data.value("annualTotalAssets", "2023-12-31"), Some(200.));
        assert_eq!(data.value("annualTotalAssets", "2024-09-30"), None);
        assert_eq!(data.value("annualBasicEPS", "2023-12-31"), Some(2.));
    }
}
