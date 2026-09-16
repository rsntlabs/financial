//! Provider-neutral annual data. Values are in reporting units, never millions.
use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dataset {
    pub schema_version: u32,
    pub name: Option<String>,
    pub currency: Option<String>,
    pub metrics: BTreeMap<String, BTreeMap<String, f64>>,
    #[serde(default)]
    pub sources: BTreeMap<String, BTreeMap<String, String>>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub fetched_at: String,
}

pub fn fiscal_year(end: &str) -> Option<i32> {
    let date = NaiveDate::parse_from_str(end, "%Y-%m-%d").ok()?;
    Some(date.year() - i32::from(date.month() == 1 && date.day() <= 7))
}

impl Dataset {
    pub fn new() -> Self {
        Self {
            schema_version: 1,
            ..Self::default()
        }
    }

    pub fn insert(&mut self, metric: &str, end: &str, value: f64, source: &str) {
        if !value.is_finite() || fiscal_year(end).is_none() {
            return;
        }
        let row = self.metrics.entry(metric.into()).or_default();
        if row.contains_key(end) {
            return;
        }
        row.insert(end.into(), value);
        self.sources
            .entry(metric.into())
            .or_default()
            .insert(end.into(), source.into());
    }

    /// Call in priority order. Unknown or conflicting currencies cannot be combined.
    /// Exact fiscal dates must agree; never align different periods merely by year.
    pub fn merge(&mut self, other: Self) {
        if self.name.is_none() {
            self.name = other.name;
        }
        self.warnings.extend(other.warnings);
        if other.metrics.is_empty() {
            return;
        }
        if other.currency.is_none() || (!self.metrics.is_empty() && self.currency != other.currency)
        {
            self.warnings.push(
                "Skipped financial values with unknown or conflicting reporting currency.".into(),
            );
            return;
        }
        self.currency = other.currency;
        let ends: BTreeMap<_, _> = self
            .metrics
            .get("annualTotalRevenue")
            .into_iter()
            .flat_map(|r| r.keys())
            .filter_map(|end| Some((fiscal_year(end)?, end.clone())))
            .collect();
        for (metric, values) in other.metrics {
            for (end, value) in values {
                if ends
                    .get(&fiscal_year(&end).unwrap_or_default())
                    .is_some_and(|e| e != &end)
                {
                    continue;
                }
                let source = other
                    .sources
                    .get(&metric)
                    .and_then(|r| r.get(&end))
                    .map(String::as_str)
                    .unwrap_or("Unknown");
                self.insert(&metric, &end, value, source);
            }
        }
    }

    pub fn value(&self, metric: &str, end: &str) -> Option<f64> {
        self.metrics.get(metric)?.get(end).copied()
    }

    pub fn derive(&mut self) {
        let ends: BTreeSet<_> = self
            .metrics
            .values()
            .flat_map(|v| v.keys().cloned())
            .collect();
        for end in ends {
            for (target, left, right, subtract_abs) in [
                (
                    "annualFreeCashFlow",
                    "annualOperatingCashFlow",
                    "annualCapitalExpenditure",
                    true,
                ),
                (
                    "annualWorkingCapital",
                    "annualCurrentAssets",
                    "annualCurrentLiabilities",
                    false,
                ),
                (
                    "annualGrossProfit",
                    "annualTotalRevenue",
                    "annualCostOfRevenue",
                    true,
                ),
            ] {
                if let (Some(a), Some(b)) = (self.value(left, &end), self.value(right, &end)) {
                    let sources = format!(
                        "Derived: {} / {}",
                        self.sources
                            .get(left)
                            .and_then(|r| r.get(&end))
                            .map(String::as_str)
                            .unwrap_or("Unknown"),
                        self.sources
                            .get(right)
                            .and_then(|r| r.get(&end))
                            .map(String::as_str)
                            .unwrap_or("Unknown")
                    );
                    self.insert(
                        target,
                        &end,
                        a - if subtract_abs { b.abs() } else { b },
                        &sources,
                    );
                }
            }
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("Unsupported financial data version.".into());
        }
        if self.metrics.values().any(|row| {
            row.iter()
                .any(|(d, v)| fiscal_year(d).is_none() || !v.is_finite())
        }) {
            return Err("Invalid annual financial data.".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn data(currency: Option<&str>, end: &str, value: f64) -> Dataset {
        let mut d = Dataset::new();
        d.currency = currency.map(str::to_owned);
        d.insert("annualTotalRevenue", end, value, "Test");
        d
    }
    #[test]
    fn currency_and_fiscal_periods_must_match() {
        let mut d = data(Some("USD"), "2025-12-31", 1.);
        d.merge(data(Some("EUR"), "2024-12-31", 2.));
        d.merge(data(None, "2023-12-31", 3.));
        d.merge(data(Some("USD"), "2025-09-30", 4.));
        assert_eq!(d.metrics["annualTotalRevenue"].len(), 1);
        d.merge(data(Some("USD"), "2024-12-31", 5.));
        assert_eq!(d.value("annualTotalRevenue", "2024-12-31"), Some(5.));
        d.insert("annualNetIncome", "2024-12-31", f64::NAN, "bad");
        assert_eq!(d.value("annualNetIncome", "2024-12-31"), None);
    }
    #[test]
    fn normalized_payload_runs_in_existing_analysis_engine() {
        let mut d = data(Some("USD"), "2025-12-31", 100e6);
        d.insert("annualOperatingCashFlow", "2025-12-31", 30e6, "Yahoo");
        d.insert("annualCapitalExpenditure", "2025-12-31", -10e6, "EDGAR");
        d.derive();
        let report = crate::analyze("TEST", &serde_json::to_value(d).unwrap(), 5, None).unwrap();
        assert_eq!(report.points[4].free_cash_flow, Some(20.));
    }
}
