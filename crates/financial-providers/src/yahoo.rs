use crate::{Needs, PricePoint, Provider, Request};
use async_trait::async_trait;
use yfinance_core::dataset::Dataset;
use yfinance_rs::{FundamentalsBuilder, HistoryBuilder, Money, Range, YfClient};

pub struct Yahoo {
    client: YfClient,
}
impl Yahoo {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            client: YfClient::builder()
                .user_agent("Mozilla/5.0")
                .timeout(std::time::Duration::from_secs(25))
                .build()
                .map_err(|_| "Could not initialize Yahoo client.")?,
        })
    }
}
fn insert(data: &mut Dataset, end: &str, metric: &str, money: Option<Money>) {
    let Some(money) = money else {
        return;
    };
    let currency = money.currency().to_string();
    if data.currency.as_ref().is_some_and(|c| c != &currency) {
        return;
    }
    let Ok(value) = money.amount().to_string().parse::<f64>() else {
        return;
    };
    data.currency = Some(currency);
    data.insert(metric, end, value, "Yahoo Finance");
}
#[async_trait]
impl Provider for Yahoo {
    fn name(&self) -> &'static str {
        "Yahoo Finance"
    }
    async fn financials(&self, request: &Request, needs: &Needs) -> Result<Dataset, String> {
        let mut data = Dataset::new();
        let f = FundamentalsBuilder::new(&self.client, &request.ticker);
        // A failed statement must not discard the other statements.
        match f.income_statement(false, None).await {
            Ok(rows) => {
                for row in rows {
                    let end = row.period.to_string();
                    for (key, money) in [
                        ("annualTotalRevenue", row.total_revenue),
                        ("annualGrossProfit", row.gross_profit),
                        ("annualOperatingIncome", row.operating_income),
                        ("annualNetIncome", row.net_income),
                    ] {
                        insert(&mut data, &end, key, money);
                    }
                }
            }
            Err(_) => data
                .warnings
                .push("Yahoo income statement unavailable.".into()),
        }
        match f.balance_sheet(false, None).await {
            Ok(rows) => {
                for row in rows {
                    let end = row.period.to_string();
                    for (key, money) in [
                        ("annualTotalAssets", row.total_assets),
                        (
                            "annualTotalLiabilitiesNetMinorityInterest",
                            row.total_liabilities,
                        ),
                        ("annualStockholdersEquity", row.total_equity),
                        ("annualCashAndCashEquivalents", row.cash),
                        ("annualLongTermDebt", row.long_term_debt),
                        ("annualCurrentAssets", row.current_assets),
                        ("annualCurrentLiabilities", row.current_liabilities),
                        ("annualAccountsReceivable", row.accounts_receivable),
                        ("annualInventory", row.inventory),
                        ("annualAccountsPayable", row.accounts_payable),
                        ("annualNetPPE", row.net_property_plant_equipment),
                    ] {
                        insert(&mut data, &end, key, money);
                    }
                }
            }
            Err(_) => data
                .warnings
                .push("Yahoo balance sheet unavailable.".into()),
        }
        match f.cashflow(false, None).await {
            Ok(rows) => {
                for row in rows {
                    let end = row.period.to_string();
                    for (key, money) in [
                        ("annualOperatingCashFlow", row.operating_cashflow),
                        ("annualCapitalExpenditure", row.capital_expenditures),
                        ("annualFreeCashFlow", row.free_cash_flow),
                        (
                            "annualDepreciationAmortizationDepletion",
                            row.depreciation_and_amortization,
                        ),
                        ("annualNetIncome", row.net_income),
                    ] {
                        insert(&mut data, &end, key, money);
                    }
                }
            }
            Err(_) => data
                .warnings
                .push("Yahoo cash flow statement unavailable.".into()),
        }
        if needs.name {
            if let Ok(profile) =
                yfinance_rs::profile::load_profile(&self.client, &request.ticker).await
            {
                use yfinance_rs::profile::Profile;
                data.name = match profile {
                    Profile::Company(c) => Some(c.name),
                    Profile::Fund(f) => Some(f.name),
                    _ => None,
                };
            }
        }
        match extended_statement(&request.ticker).await {
            Ok(extra) => data.merge(extra),
            Err(_) => data
                .warnings
                .push("Additional Yahoo statement rows unavailable.".into()),
        }
        Ok(data)
    }
    async fn prices(&self, ticker: &str) -> Result<Option<Vec<PricePoint>>, String> {
        let response = HistoryBuilder::new(&self.client, ticker)
            .range(Range::Max)
            .auto_adjust(false)
            .fetch_full()
            .await
            .map_err(|_| "Yahoo prices unavailable.")?;
        let timezone = response.meta.and_then(|m| m.timezone);
        Ok(Some(
            response
                .candles
                .into_iter()
                .filter_map(|c| {
                    let date = timezone
                        .map(|tz| c.ts.with_timezone(&tz).date_naive())
                        .unwrap_or(c.ts.date_naive());
                    Some(PricePoint {
                        date: date.to_string(),
                        close: c.ohlc.close.as_decimal().to_string().parse().ok()?,
                    })
                })
                .collect(),
        ))
    }
}

// yfinance-rs projects a subset of statement rows. Query the same Yahoo endpoint
// for the dashboard's remaining metric IDs before considering another provider.
async fn extended_statement(ticker: &str) -> Result<Dataset, String> {
    use reqwest::header::{COOKIE, SET_COOKIE};
    use serde_json::Value;
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|_| "Yahoo transport unavailable.")?;
    let response = http
        .get("https://fc.yahoo.com")
        .send()
        .await
        .map_err(|_| "Yahoo session unavailable.")?;
    let cookie = response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|v| v.split(';').next())
        .collect::<Vec<_>>()
        .join("; ");
    if cookie.is_empty() {
        return Err("Yahoo session unavailable.".into());
    }
    let crumb = http
        .get("https://query1.finance.yahoo.com/v1/test/getcrumb")
        .header(COOKIE, &cookie)
        .send()
        .await
        .map_err(|_| "Yahoo authentication unavailable.")?
        .error_for_status()
        .map_err(|_| "Yahoo authentication rejected.")?
        .text()
        .await
        .map_err(|_| "Yahoo authentication unreadable.")?;
    if crumb.is_empty() || crumb.len() > 128 || crumb.chars().any(|c| c.is_whitespace() || c == '<')
    {
        return Err("Yahoo authentication invalid.".into());
    }
    let metrics: std::collections::BTreeSet<_> = yfinance_core::statements::SECTIONS
        .iter()
        .flat_map(|(_, rows)| rows.iter().map(|(_, key, _)| *key))
        .collect();
    let mut url = reqwest::Url::parse(
        "https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/",
    )
    .unwrap();
    url.path_segments_mut().unwrap().push(ticker);
    url.query_pairs_mut()
        .append_pair("symbol", ticker)
        .append_pair("type", &metrics.into_iter().collect::<Vec<_>>().join(","))
        .append_pair("period1", "0")
        .append_pair(
            "period2",
            &(chrono::Utc::now().timestamp() + 86400).to_string(),
        )
        .append_pair("crumb", &crumb);
    let body: Value = http
        .get(url)
        .header(COOKIE, cookie)
        .send()
        .await
        .map_err(|_| "Yahoo extended statements unavailable.")?
        .error_for_status()
        .map_err(|_| "Yahoo extended statements rejected.")?
        .json()
        .await
        .map_err(|_| "Yahoo extended statements unreadable.")?;
    normalize_timeseries(&body)
}
fn normalize_timeseries(body: &serde_json::Value) -> Result<Dataset, String> {
    if !body["timeseries"]["error"].is_null() {
        return Err("Yahoo extended statements unavailable.".into());
    }
    let rows = body["timeseries"]["result"]
        .as_array()
        .ok_or("No Yahoo extended statements.")?;
    let keys: std::collections::BTreeSet<_> = yfinance_core::statements::SECTIONS
        .iter()
        .flat_map(|(_, rows)| rows.iter().map(|(_, key, _)| *key))
        .collect();
    let mut data = Dataset::new();
    for row in rows {
        let Some(key) = row["meta"]["type"][0].as_str().filter(|k| keys.contains(k)) else {
            continue;
        };
        let Some(values) = row[key].as_array() else {
            continue;
        };
        for value in values {
            if value["periodType"].as_str() != Some("12M") {
                continue;
            }
            let (Some(end), Some(currency), Some(number)) = (
                value["asOfDate"].as_str(),
                value["currencyCode"].as_str(),
                yfinance_core::alpha::number(&value["reportedValue"]["raw"]),
            ) else {
                continue;
            };
            if data.currency.as_ref().is_some_and(|c| c != currency) {
                return Err("Yahoo extended statements have mixed currencies.".into());
            }
            data.currency = Some(currency.into());
            data.insert(key, end, number, "Yahoo Finance");
        }
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn extended_rows_accept_only_annual_finite_matching_currency_data() {
        let mut body = json!({"timeseries":{"result":[{"meta":{"type":["annualBasicEPS"]},"annualBasicEPS":[
            {"asOfDate":"2025-12-31","periodType":"12M","currencyCode":"USD","reportedValue":{"raw":0}},
            {"asOfDate":"2024-12-31","periodType":"3M","currencyCode":"USD","reportedValue":{"raw":99}}
        ]}]}});
        let data = normalize_timeseries(&body).unwrap();
        assert_eq!(data.value("annualBasicEPS", "2025-12-31"), Some(0.));
        assert_eq!(data.value("annualBasicEPS", "2024-12-31"), None);
        body["timeseries"]["result"][0]["annualBasicEPS"][1]["periodType"] = json!("12M");
        body["timeseries"]["result"][0]["annualBasicEPS"][1]["currencyCode"] = json!("EUR");
        assert!(normalize_timeseries(&body).is_err());
    }
}
