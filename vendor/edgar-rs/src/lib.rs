//! # edgar-rs
//!
//! A Rust client for the SEC EDGAR API.
//!
//! EDGAR (Electronic Data Gathering, Analysis, and Retrieval) is the SEC's
//! system for receiving, processing, and disseminating company filings.
//!
//! This client covers the full public EDGAR API:
//! - Company tickers: CIK-to-ticker mapping
//! - Submissions: company metadata and filing history
//! - Documents: individual filing document content
//! - Company Concepts: XBRL data for a single concept from a company
//! - Company Facts: all XBRL facts for a company
//! - Frames: aggregated XBRL data across all companies for a period
//! - Full-Text Search: search across all filing text content
//!
//! All requests are rate-limited to 10 requests per second by default,
//! as required by the SEC EDGAR fair access policy.
//!
//! # Example
//!
//! ```no_run
//! # async fn example() -> edgar_rs::Result<()> {
//! let client = edgar_rs::ClientBuilder::new("MyApp/1.0 contact@example.com")
//!     .build()?;
//!
//! let tickers = client.get_tickers().await?;
//! let submission = client.get_submission(320193_u64.into()).await?;
//! let concept = client.get_company_concept(
//!     320193_u64.into(), "us-gaap", "Revenues"
//! ).await?;
//! # Ok(())
//! # }
//! ```

mod cik;
mod client;
mod error;
mod models;

pub use cik::Cik;
pub use client::{Client, ClientBuilder};
pub use error::{Error, Result};
pub use models::{
    Address, Addresses, CompanyConcept, CompanyFacts, ConceptFacts, Fact, FilingFile,
    FilingHistory, FilingSet, FormerName, Frame, FrameData, SearchHit, SearchOptions, SearchResult,
    Submission, Ticker,
};

#[doc(hidden)]
pub use models::{EftsHit, EftsHits, EftsResponse, EftsSource, EftsTotal};
