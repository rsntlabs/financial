//! Alpha Vantage annual statements mapped to the application's stable metric IDs.
//! Numeric strings are parsed strictly: missing values never become zero.
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|v| v.is_finite())
}

pub const MAPPINGS: &[(&str, &[(&str, &str)])] = &[
    (
        "income",
        &[
            ("totalRevenue", "annualTotalRevenue"),
            ("costOfRevenue", "annualCostOfRevenue"),
            ("grossProfit", "annualGrossProfit"),
            ("operatingIncome", "annualOperatingIncome"),
            ("ebit", "annualEBIT"),
            ("ebitda", "annualEBITDA"),
            ("netIncome", "annualNetIncome"),
        ],
    ),
    (
        "balance",
        &[
            (
                "cashAndCashEquivalentsAtCarryingValue",
                "annualCashAndCashEquivalents",
            ),
            ("currentNetReceivables", "annualAccountsReceivable"),
            ("inventory", "annualInventory"),
            ("totalCurrentAssets", "annualCurrentAssets"),
            ("propertyPlantEquipment", "annualNetPPE"),
            ("totalNonCurrentAssets", "annualTotalNonCurrentAssets"),
            ("totalAssets", "annualTotalAssets"),
            ("currentAccountsPayable", "annualAccountsPayable"),
            ("currentDebt", "annualCurrentDebt"),
            ("totalCurrentLiabilities", "annualCurrentLiabilities"),
            ("longTermDebt", "annualLongTermDebt"),
            ("shortLongTermDebtTotal", "annualTotalDebt"),
            (
                "totalNonCurrentLiabilities",
                "annualTotalNonCurrentLiabilitiesNetMinorityInterest",
            ),
            (
                "totalLiabilities",
                "annualTotalLiabilitiesNetMinorityInterest",
            ),
            ("retainedEarnings", "annualRetainedEarnings"),
            ("totalShareholderEquity", "annualStockholdersEquity"),
        ],
    ),
    (
        "cashflow",
        &[
            (
                "depreciationDepletionAndAmortization",
                "annualDepreciationAmortizationDepletion",
            ),
            ("operatingCashflow", "annualOperatingCashFlow"),
            ("capitalExpenditures", "annualCapitalExpenditure"),
            ("cashflowFromInvestment", "annualInvestingCashFlow"),
            (
                "proceedsFromIssuanceOfLongTermDebtAndCapitalSecuritiesNet",
                "annualIssuanceOfDebt",
            ),
            (
                "paymentsForRepurchaseOfEquity",
                "annualRepurchaseOfCapitalStock",
            ),
            ("dividendPayout", "annualCashDividendsPaid"),
            ("cashflowFromFinancing", "annualFinancingCashFlow"),
            ("changeInCashAndCashEquivalents", "annualChangesInCash"),
        ],
    ),
];

pub fn normalize(payload: &Value) -> Result<Value, String> {
    let mut metrics: BTreeMap<String, BTreeMap<String, f64>> = BTreeMap::new();
    let mut currencies = BTreeSet::new();
    for (section, fields) in MAPPINGS {
        let response = &payload[section];
        for key in ["Error Message", "Information", "Note"] {
            if response[key].is_string() {
                return Err(format!("Alpha Vantage could not return the {section} statement. Check your API key and request allowance."));
            }
        }
        let reports = response["annualReports"]
            .as_array()
            .ok_or_else(|| format!("Alpha Vantage returned no annual {section} statements."))?;
        for report in reports {
            let Some(date) = report["fiscalDateEnding"]
                .as_str()
                .filter(|d| super::year(d).is_some())
            else {
                continue;
            };
            if let Some(currency) = report["reportedCurrency"]
                .as_str()
                .filter(|c| !c.is_empty() && *c != "None")
            {
                currencies.insert(currency.to_owned());
            }
            for (field, key) in *fields {
                if let Some(value) = number(&report[field]) {
                    // Keep the first (most recent provider version) when dates repeat.
                    metrics
                        .entry((*key).into())
                        .or_default()
                        .entry(date.into())
                        .or_insert(value);
                }
            }
            let derived = match *section {
                "balance" => vec![
                    (
                        "annualGrossPPE",
                        number(&report["propertyPlantEquipment"])
                            .zip(number(&report["accumulatedDepreciationAmortizationPPE"]))
                            .map(|(net, accumulated)| net + accumulated.abs()),
                    ),
                    (
                        "annualWorkingCapital",
                        number(&report["totalCurrentAssets"])
                            .zip(number(&report["totalCurrentLiabilities"]))
                            .map(|(a, l)| a - l),
                    ),
                ],
                "cashflow" => vec![(
                    "annualFreeCashFlow",
                    number(&report["operatingCashflow"])
                        .zip(number(&report["capitalExpenditures"]))
                        .map(|(cash, capex)| cash - capex.abs()),
                )],
                _ => vec![],
            };
            for (key, value) in derived {
                if let Some(value) = value.filter(|v| v.is_finite()) {
                    metrics
                        .entry(key.into())
                        .or_default()
                        .entry(date.into())
                        .or_insert(value);
                }
            }
        }
    }
    if currencies.len() > 1 {
        return Err("Alpha Vantage returned mixed reporting currencies. These statements cannot be compared safely.".into());
    }
    Ok(json!({
        "metrics":metrics, "currency":currencies.into_iter().next(),
        "name":payload["overview"]["Name"], "fetchedAt":payload["fetchedAt"],
        "warnings":[
            "Source: Alpha Vantage. D&A uses the cash flow statement and includes depletion where reported.",
            "Gross PP&E is derived from net PP&E plus accumulated depreciation; working capital is current assets minus current liabilities; free cash flow is operating cash flow minus absolute CAPEX.",
            "Current receivables may include non-trade receivables. Debt issuance uses net long-term debt and capital-security proceeds. Unsupported rows (including basic/diluted EPS, debt repayments and cash-position balances) remain unavailable.",
            "Revenue segments are not supplied by these Alpha Vantage endpoints."
        ]
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        json!({"income":{"annualReports":[{"fiscalDateEnding":"2021-12-31","reportedCurrency":"USD","totalRevenue":"100000000","grossProfit":"60000000","netIncome":"-5000000"}]},
        "balance":{"annualReports":[{"fiscalDateEnding":"2021-12-31","reportedCurrency":"USD","propertyPlantEquipment":"80000000","accumulatedDepreciationAmortizationPPE":"20000000","totalCurrentAssets":"50","totalCurrentLiabilities":"30"}]},
        "cashflow":{"annualReports":[{"fiscalDateEnding":"2021-12-31","reportedCurrency":"USD","capitalExpenditures":"20000000","operatingCashflow":"30000000","depreciationDepletionAndAmortization":"10000000"}]}})
    }
    #[test]
    fn maps_strings_cashflow_and_derived_values() {
        let report = super::super::analyze("TEST", &fixture(), 5, Some(2021)).unwrap();
        let p = &report.points[4];
        assert_eq!(p.net_income, Some(-5.));
        assert_eq!(p.gross_margin, Some(0.6));
        assert_eq!(p.free_cash_flow, Some(10.));
        assert_eq!(p.da_ppe, Some(0.1));
        assert_eq!(p.capex_da, Some(2.));
        assert!(report.points[0].revenue.is_none());
    }
    #[test]
    fn missing_values_are_not_zero_and_currencies_must_match() {
        for value in [json!("None"), json!(""), json!("NaN"), json!(null)] {
            assert!(number(&value).is_none());
        }
        assert_eq!(number(&json!("0")), Some(0.));
        let mut data = fixture();
        data["cashflow"]["annualReports"][0]["capitalExpenditures"] = json!("None");
        assert!(super::super::analyze("TEST", &data, 5, Some(2021))
            .unwrap()
            .points[4]
            .free_cash_flow
            .is_none());
        data["balance"]["annualReports"][0]["reportedCurrency"] = json!("EUR");
        assert!(normalize(&data).unwrap_err().contains("mixed"));
        data["balance"] = json!({"Note":"rate limit"});
        assert!(normalize(&data).is_err());
    }
}
