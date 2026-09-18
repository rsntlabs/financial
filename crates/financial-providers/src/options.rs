//! Yahoo option-chain acquisition and normalization.
//!
//! Yahoo quotes an option chain one expiration at a time: the bare endpoint
//! answers with every expiration date plus the contracts of the nearest one,
//! and `?date=<epoch>` selects another. The dashboard wants the expiration
//! closest to the user's horizon, so at most two requests are made.
use chrono::{DateTime, NaiveDate, Utc};
use serde_json::Value;
use yfinance_core::greeks::Kind;
use yfinance_core::options::{Chain, Quote};

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value["raw"].as_f64())
        .filter(|v| v.is_finite())
}
/// Yahoo timestamps every expiration as an epoch second at UTC midnight.
pub fn epoch_date(epoch: i64) -> Option<String> {
    Some(DateTime::from_timestamp(epoch, 0)?.date_naive().to_string())
}

/// The raw expiration epochs, which is what Yahoo's `date` query parameter
/// expects; the normalized chain carries the same dates as calendar strings.
pub fn expiration_epochs(body: &Value) -> Vec<i64> {
    body["optionChain"]["result"][0]["expirationDates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_i64)
        .collect()
}

/// The expiration nearest the requested horizon, as an epoch second, out of the
/// dates Yahoo lists. Expirations already past are never selected.
pub fn pick_expiration(epochs: &[i64], today: NaiveDate, horizon_days: u32) -> Option<i64> {
    epochs
        .iter()
        .copied()
        .filter_map(|epoch| {
            let days = (NaiveDate::parse_from_str(&epoch_date(epoch)?, "%Y-%m-%d").ok()? - today)
                .num_days();
            (days >= 1).then_some((epoch, days))
        })
        .min_by_key(|(_, days)| (days - i64::from(horizon_days)).abs())
        .map(|(epoch, _)| epoch)
}

fn quotes(rows: &Value, kind: Kind, expiration: &str, out: &mut Vec<Quote>) {
    for row in rows.as_array().into_iter().flatten() {
        let (Some(contract), Some(strike)) = (
            row["contractSymbol"].as_str(),
            number(&row["strike"]).filter(|s| *s > 0.0),
        ) else {
            continue;
        };
        // A contract's own expiration wins over the chain's, so a mixed
        // response can never mislabel a strike's time to expiry.
        let expiration = row["expiration"]
            .as_i64()
            .and_then(epoch_date)
            .unwrap_or_else(|| expiration.to_owned());
        out.push(Quote {
            contract: contract.into(),
            expiration,
            strike,
            kind,
            bid: number(&row["bid"]),
            ask: number(&row["ask"]),
            last: number(&row["lastPrice"]),
            volume: number(&row["volume"]),
            open_interest: number(&row["openInterest"]),
            implied_volatility: number(&row["impliedVolatility"]),
        });
    }
}

/// Parses one `v7/finance/options` response. `ticker` is the symbol requested,
/// used when Yahoo echoes none of its own.
pub fn normalize(body: &Value, ticker: &str) -> Result<Chain, String> {
    if !body["optionChain"]["error"].is_null() {
        return Err("Yahoo option chain unavailable.".into());
    }
    let result = body["optionChain"]["result"]
        .get(0)
        .ok_or("No option chain for this symbol.")?;
    let quote = &result["quote"];
    let spot = number(&quote["regularMarketPrice"])
        .or_else(|| number(&quote["postMarketPrice"]))
        .or_else(|| number(&quote["regularMarketPreviousClose"]))
        .filter(|p| *p > 0.0)
        .ok_or("Yahoo did not quote an underlying price for this symbol.")?;
    let expirations: Vec<String> = result["expirationDates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| epoch_date(v.as_i64()?))
        .collect();
    let mut warnings = Vec::new();
    let mut contracts = Vec::new();
    for entry in result["options"].as_array().into_iter().flatten() {
        let expiration = entry["expirationDate"]
            .as_i64()
            .and_then(epoch_date)
            .unwrap_or_default();
        quotes(&entry["calls"], Kind::Call, &expiration, &mut contracts);
        quotes(&entry["puts"], Kind::Put, &expiration, &mut contracts);
    }
    if contracts.is_empty() {
        return Err("Yahoo listed no option contracts for this expiration.".into());
    }
    // Yahoo reports this as a decimal fraction; anything else is not a yield.
    let dividend_yield = number(&quote["trailingAnnualDividendYield"])
        .filter(|y| (0.0..=0.5).contains(y))
        .or_else(|| {
            warnings.push(
                "No dividend yield was quoted; the model assumes the stock pays none.".into(),
            );
            None
        });
    Ok(Chain {
        ticker: result["underlyingSymbol"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(ticker)
            .to_uppercase(),
        spot,
        currency: quote["currency"].as_str().map(str::to_uppercase),
        fetched_at: Utc::now().to_rfc3339(),
        dividend_yield,
        expirations,
        quotes: contracts,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    // 2026-01-16 and 2026-02-20, UTC midnight.
    const JANUARY: i64 = 1_768_521_600;
    const FEBRUARY: i64 = 1_771_545_600;
    fn body() -> Value {
        json!({"optionChain":{"error":null,"result":[{
            "underlyingSymbol":"test",
            "expirationDates":[JANUARY, FEBRUARY],
            "quote":{"regularMarketPrice":101.5,"currency":"usd","trailingAnnualDividendYield":0.004},
            "options":[{"expirationDate":FEBRUARY,
                "calls":[{"contractSymbol":"TEST260220C00100000","strike":100,"bid":5.0,"ask":5.4,
                          "lastPrice":5.2,"volume":120,"openInterest":4300,"impliedVolatility":0.31,
                          "expiration":FEBRUARY}],
                "puts":[{"contractSymbol":"TEST260220P00100000","strike":100,"bid":3.0,"ask":3.4,
                         "lastPrice":3.1,"openInterest":2100,"impliedVolatility":0.33,
                         "expiration":FEBRUARY},
                        {"contractSymbol":"broken","strike":0}]}]}]}})
    }
    #[test]
    fn normalizes_both_sides_of_the_chain_and_drops_unusable_rows() {
        let chain = normalize(&body(), "fallback").unwrap();
        assert_eq!((chain.ticker.as_str(), chain.spot), ("TEST", 101.5));
        assert_eq!(chain.currency.as_deref(), Some("USD"));
        assert_eq!(chain.dividend_yield, Some(0.004));
        assert_eq!(chain.expirations, ["2026-01-16", "2026-02-20"]);
        assert_eq!(chain.quotes.len(), 2);
        let call = &chain.quotes[0];
        assert_eq!((call.kind, call.strike), (Kind::Call, 100.0));
        assert_eq!(call.expiration, "2026-02-20");
        assert_eq!(
            (call.bid, call.ask, call.open_interest),
            (Some(5.0), Some(5.4), Some(4300.0))
        );
        assert_eq!(chain.quotes[1].kind, Kind::Put);
    }
    #[test]
    fn reports_upstream_errors_and_empty_or_unpriced_chains() {
        let mut broken = body();
        broken["optionChain"]["error"] = json!("Not Found");
        assert!(normalize(&broken, "TEST").is_err());
        assert!(normalize(&json!({}), "TEST").is_err());
        let mut unpriced = body();
        unpriced["optionChain"]["result"][0]["quote"]["regularMarketPrice"] = json!(0);
        assert!(normalize(&unpriced, "TEST").is_err());
        let mut empty = body();
        empty["optionChain"]["result"][0]["options"] = json!([]);
        assert!(normalize(&empty, "TEST").is_err());
    }
    #[test]
    fn expiration_choice_is_the_closest_future_date_to_the_horizon() {
        let today = NaiveDate::from_ymd_opt(2026, 1, 2).unwrap();
        let dates = expiration_epochs(&body());
        assert_eq!(dates, [JANUARY, FEBRUARY]);
        assert_eq!(pick_expiration(&dates, today, 14), Some(JANUARY));
        assert_eq!(pick_expiration(&dates, today, 45), Some(FEBRUARY));
        // Everything already expired is unusable, whatever the horizon.
        let late = NaiveDate::from_ymd_opt(2026, 3, 1).unwrap();
        assert_eq!(pick_expiration(&dates, late, 30), None);
    }
}
