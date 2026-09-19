//! Platform-independent parsing and financial calculations. This crate is built
//! as wasm32-unknown-unknown; provider transport uses browser fetch on WASM.
pub mod alpha;
pub mod composition;
pub mod dataset;
pub mod greeks;
pub mod options;
pub mod provider;
pub mod statements;
use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

// Deserialize as well as Serialize: the options engine takes a report the
// dashboard has already analyzed, rather than repeating the statement work.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Report {
    pub ticker: String,
    pub name: String,
    pub currency: Option<String>,
    pub years: Vec<i32>,
    pub points: Vec<Point>,
    pub statements: Vec<Section>,
    /// The balance sheet as shares of its own totals, one entry per year in
    /// `years`, for the rings the balance-sheet panel draws.
    pub composition: Vec<composition::Composition>,
    pub warnings: Vec<String>,
    pub fetched_at: String,
    pub stream_names: Vec<String>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Point {
    pub year: i32,
    pub end: Option<String>,
    pub revenue: Option<f64>,
    pub net_income: Option<f64>,
    pub gross_profit: Option<f64>,
    pub gross_margin: Option<f64>,
    pub operating_cash_flow: Option<f64>,
    pub free_cash_flow: Option<f64>,
    pub capex: Option<f64>,
    pub da: Option<f64>,
    pub da_revenue: Option<f64>,
    pub da_ppe: Option<f64>,
    pub capex_da: Option<f64>,
    pub revenue_growth: Option<f64>,
    pub net_margin: Option<f64>,
    pub streams: BTreeMap<String, f64>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Section {
    pub name: String,
    pub rows: Vec<StatementRow>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StatementRow {
    pub label: String,
    pub subtotal: bool,
    pub per_share: bool,
    pub values: Vec<Option<f64>>,
    pub percent_revenue: Vec<Option<f64>>,
    pub change_yoy: Vec<Option<f64>>,
}

pub fn normalize_ticker(ticker: &str) -> Result<String, String> {
    let ticker = ticker.trim().to_uppercase();
    if ticker.is_empty()
        || ticker.len() > 20
        || !ticker
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-^=".contains(&c))
        || !ticker.bytes().any(|c| c.is_ascii_alphanumeric())
    {
        return Err("Enter a valid ticker symbol, such as AAPL, BRK-B, or 7203.T.".into());
    }
    Ok(ticker)
}
fn year(date: &str) -> Option<i32> {
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    Some(date.year() - i32::from(date.month() == 1 && date.day() <= 7))
}
fn ratio(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(a), Some(b)) if b > 0.0 => finite(a / b),
        _ => None,
    }
}
fn finite(v: f64) -> Option<f64> {
    v.is_finite().then_some(v)
}
fn growth(current: Option<f64>, previous: Option<f64>) -> Option<f64> {
    match (current, previous) {
        (Some(c), Some(p)) if p != 0.0 => finite((c - p) / p.abs()),
        _ => None,
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn analyze_financials(
    ticker: &str,
    payload: &str,
    years: u32,
    end_year: Option<i32>,
) -> Result<String, String> {
    let payload: Value =
        serde_json::from_str(payload).map_err(|_| "The data response was not valid JSON.")?;
    let report = analyze(ticker, &payload, years, end_year)?;
    serde_json::to_string(&report).map_err(|e| e.to_string())
}

/// Ranks option structures for a ticker from an analyzed report, its daily
/// prices and one option chain. `payload` is
/// `{ report, prices, chain, settings }`; see `options::Input`.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn analyze_options(payload: &str) -> Result<String, String> {
    let input: options::Input = serde_json::from_str(payload)
        .map_err(|_| "The options request was not valid JSON.".to_string())?;
    let outlook = options::recommend(&input)?;
    serde_json::to_string(&outlook).map_err(|e| e.to_string())
}

pub fn analyze(
    ticker: &str,
    payload: &Value,
    count: u32,
    end_year: Option<i32>,
) -> Result<Report, String> {
    let ticker = normalize_ticker(ticker)?;
    if !(3..=10).contains(&count) {
        return Err("Choose between three and ten fiscal years.".into());
    }
    if end_year.is_some_and(|y| !(1900..=2200).contains(&y)) {
        return Err("Invalid ending fiscal year.".into());
    }
    let normalized = if payload.get("schemaVersion").is_some() {
        let data: dataset::Dataset =
            serde_json::from_value(payload.clone()).map_err(|_| "Invalid provider data.")?;
        data.validate()?;
        serde_json::to_value(data).map_err(|_| "Invalid provider data.")?
    } else {
        alpha::normalize(payload)?
    };
    let data: BTreeMap<String, BTreeMap<String, f64>> =
        serde_json::from_value(normalized["metrics"].clone())
            .map_err(|_| "Invalid annual metrics.")?;
    let revenue = data
        .get("annualTotalRevenue")
        .filter(|d| !d.is_empty())
        .ok_or("No annual revenue available. Check the ticker or try another company.")?;
    let mut ends = BTreeMap::new();
    for end in revenue.keys() {
        if let Some(y) = year(end) {
            ends.insert(y, end.clone());
        }
    }
    let latest = *ends
        .keys()
        .next_back()
        .ok_or("No valid annual reporting dates.")?;
    let end = end_year.unwrap_or(latest);
    let years: Vec<_> = (end - count as i32 + 1..=end).collect();
    let value = |key: &str, y: i32| -> Option<f64> { data.get(key)?.get(ends.get(&y)?).copied() };
    let currency = normalized["currency"].as_str().map(str::to_owned);
    let mut warnings = Vec::new();
    if currency.is_none() {
        warnings.push("Reporting currency was not supplied; monetary values use the company's reporting units.".into());
    }
    if let Some(notes) = normalized["warnings"].as_array() {
        warnings.extend(notes.iter().filter_map(Value::as_str).map(str::to_owned));
    }
    let points: Vec<_> = years
        .iter()
        .map(|&y| {
            let revenue = value("annualTotalRevenue", y);
            let net = value("annualNetIncome", y);
            let gross = value("annualGrossProfit", y)
                .or_else(|| Some(revenue? - value("annualCostOfRevenue", y)?.abs()));
            let capex = value("annualCapitalExpenditure", y).map(f64::abs);
            let da = value("annualDepreciationAmortizationDepletion", y);
            let ocf = value("annualOperatingCashFlow", y);
            let fcf = value("annualFreeCashFlow", y).or_else(|| Some(ocf? - capex?));
            let million = |v: Option<f64>| v.map(|v| v / 1e6);
            Point {
                year: y,
                end: ends.get(&y).cloned(),
                revenue: million(revenue),
                net_income: million(net),
                gross_profit: million(gross),
                gross_margin: ratio(gross, revenue),
                operating_cash_flow: million(ocf),
                free_cash_flow: million(fcf),
                capex: million(capex),
                da: million(da),
                da_revenue: ratio(da, revenue),
                da_ppe: ratio(da, value("annualGrossPPE", y)),
                capex_da: ratio(capex, da),
                revenue_growth: growth(revenue, value("annualTotalRevenue", y - 1)),
                net_margin: ratio(net, revenue),
                streams: BTreeMap::new(),
            }
        })
        .collect();
    for point in &points {
        let mut missing = Vec::new();
        for (name, v) in [
            ("revenue", point.revenue),
            ("net income", point.net_income),
            ("gross profit", point.gross_profit),
            ("CAPEX", point.capex),
            ("D&A", point.da),
            ("operating cash flow", point.operating_cash_flow),
        ] {
            if v.is_none() {
                missing.push(name);
            }
        }
        if !missing.is_empty() {
            warnings.push(format!(
                "FY {}: {} unavailable. Missing values are shown as gaps.",
                point.year,
                missing.join(", ")
            ));
        }
    }
    if !points.iter().any(|p| p.revenue.is_some()) {
        return Err("No annual financials are available in this date range. Choose a different ending year.".into());
    }
    let sections = statements::SECTIONS
        .iter()
        .map(|(name, metrics)| Section {
            name: (*name).into(),
            rows: metrics
                .iter()
                .map(|(label, key, subtotal)| {
                    let values: Vec<_> = years.iter().map(|y| value(key, *y)).collect();
                    let per_share = label.ends_with("EPS");
                    let percent_revenue = years
                        .iter()
                        .map(|y| {
                            if per_share {
                                None
                            } else {
                                ratio(value(key, *y), value("annualTotalRevenue", *y))
                            }
                        })
                        .collect();
                    let change_yoy = years
                        .iter()
                        .enumerate()
                        .map(|(i, y)| {
                            if i == 0 {
                                None
                            } else {
                                growth(value(key, *y), value(key, *y - 1))
                            }
                        })
                        .collect();
                    StatementRow {
                        label: (*label).into(),
                        subtotal: *subtotal,
                        per_share,
                        values,
                        percent_revenue,
                        change_yoy,
                    }
                })
                .collect(),
        })
        .collect();
    let composed = years
        .iter()
        .map(|&y| composition::compose(y, ends.get(&y).cloned(), &|key| value(key, y)))
        .collect();
    let mut report = Report {
        ticker: ticker.clone(),
        name: normalized["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(&ticker)
            .into(),
        currency,
        years,
        points,
        statements: sections,
        composition: composed,
        warnings,
        fetched_at: payload["fetchedAt"].as_str().unwrap_or("").into(),
        stream_names: Vec::new(),
    };
    // Optional provider-supplied segments. Never invent categories from total revenue.
    if let Some(streams) = payload["revenueStreams"].as_object() {
        let mut names = BTreeSet::new();
        for point in &mut report.points {
            let Some(entry) = streams.get(&point.year.to_string()) else {
                continue;
            };
            let Some(values) = entry["values"].as_object() else {
                continue;
            };
            let valid_currency = entry["currency"].as_str() == report.currency.as_deref();
            let valid_end = entry["end"].as_str() == point.end.as_deref();
            let items: BTreeMap<String, f64> = values
                .iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_f64().and_then(finite)?)))
                .collect();
            let sum: f64 = items.values().sum();
            let total = point.revenue.unwrap_or(0.0) * 1e6;
            if valid_currency
                && valid_end
                && items.len() == values.len()
                && items.len() >= 2
                && items.values().all(|v| *v >= 0.0)
                && (sum - total).abs() <= (total.abs() * 0.0001).max(1.0)
            {
                names.extend(items.keys().cloned());
                point.streams = items.into_iter().map(|(k, v)| (k, v / 1e6)).collect();
            } else {
                report.warnings.push(format!(
                    "FY {}: revenue breakdown did not reconcile; no allocations are shown.",
                    point.year
                ));
            }
        }
        report.stream_names = names.into_iter().collect();
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn payload() -> Value {
        let reports: Vec<_> = (2021..=2025).map(|y| json!({
            "fiscalDateEnding": format!("{y}-12-31"), "reportedCurrency":"USD",
            "totalRevenue":"100000000", "netIncome":"-5000000", "grossProfit":"60000000",
            "capitalExpenditures":"-20000000", "depreciationDepletionAndAmortization":"10000000", "operatingCashflow":"30000000"
        })).collect();
        json!({"income":{"annualReports":reports}, "balance":{"annualReports":[]}, "cashflow":{"annualReports":reports}})
    }

    #[test]
    fn computes_money_ratios_and_cash_outflows() {
        let report = analyze("test", &payload(), 5, None).unwrap();
        let point = &report.points[4];
        assert_eq!(report.ticker, "TEST");
        assert_eq!(report.years, vec![2021, 2022, 2023, 2024, 2025]);
        assert_eq!(point.revenue, Some(100.0));
        assert_eq!(point.net_income, Some(-5.0));
        assert_eq!(point.gross_margin, Some(0.6));
        assert_eq!(point.capex, Some(20.0));
        assert_eq!(point.capex_da, Some(2.0));
        assert_eq!(point.free_cash_flow, Some(10.0));
        assert_eq!(report.statements[0].rows[0].values[0], Some(100e6));
    }
    #[test]
    fn handles_missing_history_zero_ratios_and_invalid_symbols() {
        let mut data = payload();
        data["income"]["annualReports"][0]["totalRevenue"] = json!(0);
        let report = analyze("TEST", &data, 5, Some(2024)).unwrap();
        assert_eq!(report.points[0].revenue, None);
        assert_eq!(report.points[1].gross_margin, None);
        assert!(analyze("../../x", &data, 5, None).is_err());
        assert!(analyze("TEST", &data, 2, None).is_err());
        assert!(analyze("TEST", &data, 3, None).is_ok());
        assert!(analyze("TEST", &json!({}), 5, None).is_err());
    }
    #[test]
    fn accepts_only_reconciled_revenue_breakdowns() {
        let mut data = payload();
        data["revenueStreams"] = json!({"2025":{"end":"2025-12-31","currency":"USD","values":{"Products":60e6,"Services":40e6}}});
        assert_eq!(
            analyze("TEST", &data, 5, None).unwrap().points[4]
                .streams
                .len(),
            2
        );
        data["revenueStreams"]["2025"]["values"]["Products"] = json!(80e6);
        assert!(analyze("TEST", &data, 5, None)
            .unwrap()
            .stream_names
            .is_empty());
    }
}
