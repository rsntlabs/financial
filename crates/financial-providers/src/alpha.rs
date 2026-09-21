use crate::{Needs, PricePoint, Provider, Request};
use async_trait::async_trait;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::Mutex;
use yfinance_core::{
    alpha::{normalize, MAPPINGS},
    dataset::Dataset,
    provider::fetch_statement,
};

pub struct Alpha {
    key: String,
    gate: Arc<Mutex<()>>,
}
impl Alpha {
    pub fn new(key: &str) -> Result<Self, String> {
        Self::with_gate(key, Arc::new(Mutex::new(())))
    }
    pub(crate) fn with_gate(key: &str, gate: Arc<Mutex<()>>) -> Result<Self, String> {
        if key.is_empty() || key.len() > 128 || !key.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err("Invalid Alpha Vantage API key.".into());
        }
        Ok(Self {
            key: key.into(),
            gate,
        })
    }
}
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl Provider for Alpha {
    fn name(&self) -> &'static str {
        "Alpha Vantage"
    }
    async fn financials(&self, request: &Request, needs: &Needs) -> Result<Dataset, String> {
        let _permit = self.gate.lock().await;
        fetch_financials(request, needs, |function| {
            fetch_statement(&self.key, &request.ticker, function)
        })
        .await
    }
    async fn prices(&self, ticker: &str) -> Result<Option<Vec<PricePoint>>, String> {
        let _permit = self.gate.lock().await;
        let body = fetch_statement(&self.key, ticker, "TIME_SERIES_DAILY").await?;
        if body["Meta Data"]["2. Symbol"].as_str() != Some(ticker)
            || body["Meta Data"]["4. Output Size"].as_str() != Some("Full size")
        {
            return Err("Full daily history unavailable.".into());
        }
        let points = body["Time Series (Daily)"]
            .as_object()
            .ok_or("Prices unavailable.")?
            .iter()
            .map(|(date, row)| {
                Ok(PricePoint {
                    date: date.clone(),
                    close: yfinance_core::alpha::number(&row["4. close"])
                        .ok_or("Invalid daily close.")?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Some(points))
    }
}

async fn fetch_financials<F, Fut>(
    request: &Request,
    needs: &Needs,
    mut fetch: F,
) -> Result<Dataset, String>
where
    F: FnMut(&'static str) -> Fut,
    Fut: std::future::Future<Output = Result<serde_json::Value, String>>,
{
    let mut data = Dataset::new();
    for (section, function) in [
        ("income", "INCOME_STATEMENT"),
        ("balance", "BALANCE_SHEET"),
        ("cashflow", "CASH_FLOW"),
    ] {
        let fields = MAPPINGS.iter().find(|(s, _)| *s == section).unwrap().1;
        let derived = match section {
            "balance" => &["annualGrossPPE", "annualWorkingCapital"][..],
            "cashflow" => &["annualFreeCashFlow"][..],
            _ => &[],
        };
        if !fields.iter().any(|(_, m)| needs.metrics.contains(*m))
            && !derived.iter().any(|m| needs.metrics.contains(*m))
        {
            continue;
        }
        let body = match fetch(function).await {
            Ok(body) if body["symbol"].as_str() == Some(&request.ticker) => body,
            _ => {
                data.warnings
                    .push(format!("Alpha Vantage {section} unavailable."));
                continue;
            }
        };
        let mut payload = json!({"income":{"annualReports":[]}, "balance":{"annualReports":[]}, "cashflow":{"annualReports":[]}});
        payload[section] = body;
        if let Ok(normalized) = normalize(&payload) {
            let mut next: Dataset = serde_json::from_value(json!({"schemaVersion":1, "metrics":normalized["metrics"], "currency":normalized["currency"], "name":null})).map_err(|_| "Invalid Alpha Vantage data.")?;
            for (metric, row) in &next.metrics {
                next.sources.insert(
                    metric.clone(),
                    row.keys()
                        .map(|end| (end.clone(), "Alpha Vantage".into()))
                        .collect(),
                );
            }
            data.merge(next);
        }
    }
    if needs.name {
        if let Ok(body) = fetch("OVERVIEW").await {
            if body["Symbol"].as_str() == Some(&request.ticker) {
                data.name = body["Name"]
                    .as_str()
                    .filter(|n| !n.is_empty())
                    .map(str::to_owned);
            }
        }
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeSet, sync::Mutex};
    #[tokio::test]
    async fn only_endpoint_that_can_fill_remaining_fields_is_called() {
        let calls = Mutex::new(vec![]);
        let needs = Needs {
            metrics: BTreeSet::from(["annualNetPPE".into(), "annualBasicEPS".into()]),
            name: false,
        };
        let data = fetch_financials(&Request::new("test",5,None).unwrap(),&needs,|function| {
            calls.lock().unwrap().push(function);
            std::future::ready(Ok(json!({"symbol":"TEST","annualReports":[{"fiscalDateEnding":"2025-12-31","reportedCurrency":"USD","propertyPlantEquipment":"100"}]})))
        }).await.unwrap();
        assert_eq!(*calls.lock().unwrap(), ["BALANCE_SHEET"]);
        assert_eq!(data.value("annualNetPPE", "2025-12-31"), Some(100.));
        let needs = Needs {
            metrics: BTreeSet::from(["annualBasicEPS".into()]),
            name: false,
        };
        fetch_financials(&Request::new("test", 5, None).unwrap(), &needs, |_| {
            panic!("Unsupported EPS must not spend an API request");
            #[allow(unreachable_code)]
            std::future::ready(Err("unexpected".into()))
        })
        .await
        .unwrap();
    }
}
