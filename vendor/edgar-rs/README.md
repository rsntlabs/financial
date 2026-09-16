# edgar-rs

[![Crates.io](https://img.shields.io/crates/v/edgar-rs.svg)](https://crates.io/crates/edgar-rs)
[![Documentation](https://docs.rs/edgar-rs/badge.svg)](https://docs.rs/edgar-rs)
[![CI](https://github.com/haut/edgar-rs/actions/workflows/ci.yml/badge.svg)](https://github.com/haut/edgar-rs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Async Rust client for the [SEC EDGAR](https://www.sec.gov/edgar) API with built-in rate limiting.

## Features

- Full coverage of the EDGAR public API (tickers, submissions, documents, XBRL, full-text search)
- Automatic rate limiting (10 req/s default, per SEC fair access policy)
- Strongly typed responses with serde
- `Cik` newtype for type-safe CIK number handling
- Async/await with reqwest and tokio

## Installation

```sh
cargo add edgar-rs
```

Or add to your `Cargo.toml`:

```toml
[dependencies]
edgar-rs = "0.1"
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
```

## Quick start

```rust,no_run
use edgar_rs::{ClientBuilder, Cik};

#[tokio::main]
async fn main() -> edgar_rs::Result<()> {
    // SEC requires a User-Agent identifying your application
    let client = ClientBuilder::new("MyApp/1.0 contact@example.com")
        .build()?;

    // Fetch all company tickers
    let tickers = client.get_tickers().await?;
    println!("Total tickers: {}", tickers.len());

    // Get Apple's submission data
    let submission = client.get_submission(Cik::new(320193)).await?;
    println!("Company: {}", submission.name);

    Ok(())
}
```

## API coverage

| Method | Description |
|--------|-------------|
| `get_tickers()` | CIK-to-ticker mapping for all companies |
| `get_submission(cik)` | Company metadata and filing history |
| `get_document(cik, accession, doc)` | Individual filing document content |
| `get_company_concept(cik, taxonomy, tag)` | XBRL data for a single concept |
| `get_company_facts(cik)` | All XBRL facts for a company |
| `get_frame(taxonomy, tag, unit, period)` | Aggregated XBRL data across all companies |
| `search(query, options)` | Full-text search across filings |

## Rate limiting

SEC EDGAR requires all automated tools to limit requests to 10 per second. This client enforces that by default. You can adjust it via `ClientBuilder::rate_limit()`, but going above 10 is not recommended.

## License

MIT
