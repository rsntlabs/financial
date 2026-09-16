//! Opt-in network smoke test: cargo run -p financial-providers --example yahoo_smoke
use financial_providers::{yahoo::Yahoo, Needs, Provider, Request};
use yfinance_core::dataset::Dataset;
#[tokio::main]
async fn main() -> Result<(), String> {
    let yahoo = Yahoo::new()?;
    let request = Request::new("AAPL", 5, None)?;
    let data = yahoo
        .financials(&request, &Needs::remaining(&Dataset::new(), &request))
        .await?;
    println!(
        "Yahoo metrics: {}, currency: {:?}, warnings: {:?}",
        data.metrics.len(),
        data.currency,
        data.warnings
    );
    let prices = yahoo.prices("AAPL").await?;
    println!(
        "Yahoo daily sessions: {}",
        prices.as_ref().map_or(0, Vec::len)
    );
    if data.metrics.is_empty() || prices.is_none_or(|p| p.is_empty()) {
        return Err("Live Yahoo coverage was unavailable.".into());
    }
    Ok(())
}
