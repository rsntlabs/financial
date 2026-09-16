//! Native data acquisition: Yahoo, then SEC EDGAR, then optional Alpha Vantage.
//! The browser/WASM analysis crate stays independent of native networking crates.
pub mod alpha;
pub mod edgar;
pub mod yahoo;
use async_trait::async_trait;
use chrono::{Datelike, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use yfinance_core::{
    dataset::{fiscal_year, Dataset},
    statements::SECTIONS,
};

#[derive(Clone, Debug)]
pub struct Request {
    pub ticker: String,
    pub years: u32,
    pub end_year: Option<i32>,
}
impl Request {
    pub fn new(ticker: &str, years: u32, end_year: Option<i32>) -> Result<Self, String> {
        if !(5..=10).contains(&years) || end_year.is_some_and(|y| !(1900..=2200).contains(&y)) {
            return Err("Choose five to ten fiscal years and a valid ending year.".into());
        }
        Ok(Self {
            ticker: yfinance_core::normalize_ticker(ticker)?,
            years,
            end_year,
        })
    }
}
#[derive(Debug)]
pub struct Needs {
    pub metrics: BTreeSet<String>,
    pub name: bool,
}
impl Needs {
    pub fn remaining(data: &Dataset, request: &Request) -> Self {
        let revenue = data.metrics.get("annualTotalRevenue");
        let end = request
            .end_year
            .or_else(|| revenue?.keys().filter_map(|d| fiscal_year(d)).max())
            .unwrap_or(Utc::now().year() - 1);
        let metrics = SECTIONS
            .iter()
            .flat_map(|(_, rows)| rows.iter())
            .filter_map(|(_, key, _)| {
                let missing = (end - request.years as i32 + 1..=end).any(|year| {
                    let date =
                        revenue.and_then(|r| r.keys().find(|d| fiscal_year(d) == Some(year)));
                    date.is_none_or(|d| data.value(key, d).is_none())
                });
                missing.then(|| (*key).to_owned())
            })
            .collect();
        Self {
            metrics,
            name: data.name.as_ref().is_none_or(|n| n.is_empty()),
        }
    }
    pub fn empty(&self) -> bool {
        self.metrics.is_empty() && !self.name
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PricePoint {
    pub date: String,
    pub close: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prices {
    pub ticker: String,
    pub fetched_at: String,
    pub points: Vec<PricePoint>,
    pub source: String,
    pub output_size: String,
}
#[async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &'static str;
    async fn financials(&self, request: &Request, needs: &Needs) -> Result<Dataset, String>;
    // SEC has no market prices. Unsupported capabilities cost no API request.
    async fn prices(&self, _ticker: &str) -> Result<Option<Vec<PricePoint>>, String> {
        Ok(None)
    }
}

pub struct ProviderChain<'a> {
    providers: Vec<&'a dyn Provider>,
}
impl<'a> ProviderChain<'a> {
    pub fn new(
        yahoo: &'a dyn Provider,
        edgar: &'a dyn Provider,
        alpha: Option<&'a dyn Provider>,
    ) -> Self {
        let mut providers = vec![yahoo, edgar];
        if let Some(alpha) = alpha {
            providers.push(alpha);
        }
        Self { providers }
    }
    pub async fn financials(&self, request: &Request) -> Result<Dataset, String> {
        let mut data = Dataset::new();
        data.fetched_at = Utc::now().to_rfc3339();
        for provider in &self.providers {
            let needs = Needs::remaining(&data, request);
            if needs.empty() {
                break;
            }
            match tokio::time::timeout(
                std::time::Duration::from_secs(75),
                provider.financials(request, &needs),
            )
            .await
            .unwrap_or_else(|_| Err("Provider timed out.".into()))
            {
                Ok(next) => {
                    data.merge(next);
                    data.derive();
                }
                Err(_) => data.warnings.push(format!(
                    "{} unavailable; tried the next provider.",
                    provider.name()
                )),
            }
        }
        if data
            .metrics
            .get("annualTotalRevenue")
            .is_none_or(|v| v.is_empty())
        {
            return Err("No annual revenue available from Yahoo Finance or SEC EDGAR. An optional Alpha Vantage key may provide additional coverage.".into());
        }
        if !Needs::remaining(&data, request).metrics.is_empty() {
            data.warnings.push("Some requested metrics or fiscal years remain unavailable. Missing values are shown as gaps; an optional Alpha Vantage key may add coverage.".into());
        }
        let sources: BTreeSet<_> = data
            .sources
            .values()
            .flat_map(|r| r.values().cloned())
            .collect();
        data.warnings.push(format!(
            "Sources: {}.",
            sources.into_iter().collect::<Vec<_>>().join(", ")
        ));
        Ok(data)
    }
    pub async fn prices(&self, ticker: &str) -> Result<Prices, String> {
        let ticker = yfinance_core::normalize_ticker(ticker)?;
        for provider in &self.providers {
            if let Ok(Some(mut points)) = provider.prices(&ticker).await {
                if points.iter().any(|p| {
                    chrono::NaiveDate::parse_from_str(&p.date, "%Y-%m-%d").is_err()
                        || !p.close.is_finite()
                        || p.close <= 0.
                }) {
                    continue;
                }
                points.sort_by(|a, b| a.date.cmp(&b.date));
                points.dedup_by(|a, b| a.date == b.date);
                if !points.is_empty() {
                    return Ok(Prices {
                        ticker,
                        fetched_at: Utc::now().to_rfc3339(),
                        points,
                        source: provider.name().into(),
                        output_size: "full".into(),
                    });
                }
            }
        }
        Err("Daily prices unavailable from Yahoo Finance. An optional Alpha Vantage key with full-history access may provide coverage.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    struct Fake<'a> {
        name: &'static str,
        data: Result<Dataset, String>,
        calls: &'a Mutex<Vec<String>>,
        prices: Option<Vec<PricePoint>>,
    }
    #[async_trait]
    impl Provider for Fake<'_> {
        fn name(&self) -> &'static str {
            self.name
        }
        async fn financials(&self, _: &Request, needs: &Needs) -> Result<Dataset, String> {
            assert!(!needs.empty());
            self.calls.lock().unwrap().push(self.name.into());
            self.data.clone()
        }
        async fn prices(&self, _: &str) -> Result<Option<Vec<PricePoint>>, String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("{} prices", self.name));
            Ok(self.prices.clone())
        }
    }
    fn dataset(source: &str, complete: bool) -> Dataset {
        let mut data = Dataset::new();
        data.currency = Some("USD".into());
        data.name = Some("Test".into());
        for y in 2021..=2025 {
            for (_, rows) in SECTIONS {
                for (_, key, _) in *rows {
                    if complete || *key == "annualTotalRevenue" {
                        data.insert(key, &format!("{y}-12-31"), 100., source);
                    }
                }
            }
        }
        data
    }
    #[tokio::test]
    async fn preferred_provider_complete_means_no_fallback_calls() {
        let calls = Mutex::new(vec![]);
        let yahoo = Fake {
            name: "Yahoo",
            data: Ok(dataset("Yahoo", true)),
            calls: &calls,
            prices: None,
        };
        let edgar = Fake {
            name: "EDGAR",
            data: Err("down".into()),
            calls: &calls,
            prices: None,
        };
        let alpha = Fake {
            name: "Alpha",
            data: Err("must not call".into()),
            calls: &calls,
            prices: None,
        };
        ProviderChain::new(&yahoo, &edgar, Some(&alpha))
            .financials(&Request::new("test", 5, None).unwrap())
            .await
            .unwrap();
        assert_eq!(*calls.lock().unwrap(), ["Yahoo"]);
    }
    #[tokio::test]
    async fn edgar_fills_partial_yahoo_and_skips_paid_provider() {
        let calls = Mutex::new(vec![]);
        let mut y = dataset("Yahoo", false);
        y.metrics
            .get_mut("annualTotalRevenue")
            .unwrap()
            .insert("2025-12-31".into(), 0.);
        let yahoo = Fake {
            name: "Yahoo",
            data: Ok(y),
            calls: &calls,
            prices: None,
        };
        let edgar = Fake {
            name: "EDGAR",
            data: Ok(dataset("EDGAR", true)),
            calls: &calls,
            prices: None,
        };
        let alpha = Fake {
            name: "Alpha",
            data: Err("must not call".into()),
            calls: &calls,
            prices: None,
        };
        let result = ProviderChain::new(&yahoo, &edgar, Some(&alpha))
            .financials(&Request::new("test", 5, None).unwrap())
            .await
            .unwrap();
        assert_eq!(*calls.lock().unwrap(), ["Yahoo", "EDGAR"]);
        assert_eq!(result.value("annualTotalRevenue", "2025-12-31"), Some(0.));
        assert_eq!(result.sources["annualTotalRevenue"]["2025-12-31"], "Yahoo");
        assert_eq!(result.sources["annualBasicEPS"]["2025-12-31"], "EDGAR");
    }
    #[tokio::test]
    async fn failures_and_partial_history_reach_alpha_last_but_key_is_optional() {
        let calls = Mutex::new(vec![]);
        let yahoo = Fake {
            name: "Yahoo",
            data: Err("down".into()),
            calls: &calls,
            prices: None,
        };
        let edgar = Fake {
            name: "EDGAR",
            data: Ok(dataset("EDGAR", false)),
            calls: &calls,
            prices: None,
        };
        let alpha = Fake {
            name: "Alpha",
            data: Ok(dataset("Alpha", true)),
            calls: &calls,
            prices: None,
        };
        ProviderChain::new(&yahoo, &edgar, Some(&alpha))
            .financials(&Request::new("test", 5, None).unwrap())
            .await
            .unwrap();
        assert_eq!(*calls.lock().unwrap(), ["Yahoo", "EDGAR", "Alpha"]);
        calls.lock().unwrap().clear();
        let partial = ProviderChain::new(&yahoo, &edgar, None)
            .financials(&Request::new("test", 10, None).unwrap())
            .await
            .unwrap();
        assert!(partial.warnings.iter().any(|w| w.contains("gaps")));
        assert_eq!(*calls.lock().unwrap(), ["Yahoo", "EDGAR"]);
    }
    #[tokio::test]
    async fn prices_prefer_yahoo_and_allow_unsupported_edgar() {
        let calls = Mutex::new(vec![]);
        let yahoo = Fake {
            name: "Yahoo",
            data: Err("unused".into()),
            calls: &calls,
            prices: Some(vec![PricePoint {
                date: "2025-12-31".into(),
                close: 10.,
            }]),
        };
        let edgar = Fake {
            name: "EDGAR",
            data: Err("unused".into()),
            calls: &calls,
            prices: None,
        };
        let alpha = Fake {
            name: "Alpha",
            data: Err("unused".into()),
            calls: &calls,
            prices: yahoo.prices.clone(),
        };
        assert_eq!(
            ProviderChain::new(&yahoo, &edgar, Some(&alpha))
                .prices("test")
                .await
                .unwrap()
                .source,
            "Yahoo"
        );
        assert_eq!(*calls.lock().unwrap(), ["Yahoo prices"]);
        calls.lock().unwrap().clear();
        let unavailable = Fake {
            prices: None,
            ..yahoo
        };
        assert_eq!(
            ProviderChain::new(&unavailable, &edgar, Some(&alpha))
                .prices("test")
                .await
                .unwrap()
                .source,
            "Alpha"
        );
        assert_eq!(
            *calls.lock().unwrap(),
            ["Yahoo prices", "EDGAR prices", "Alpha prices"]
        );
    }
    #[test]
    fn history_coverage_and_invalid_requests() {
        let data = dataset("Yahoo", true);
        assert!(Needs::remaining(&data, &Request::new("test", 5, None).unwrap()).empty());
        assert!(!Needs::remaining(&data, &Request::new("test", 10, None).unwrap()).empty());
        assert!(!Needs::remaining(&data, &Request::new("test", 5, Some(2024)).unwrap()).empty());
        assert!(Request::new("../bad", 5, None).is_err());
    }
}
