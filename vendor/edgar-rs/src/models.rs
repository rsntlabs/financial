use std::collections::HashMap;

use serde::{Deserialize, Deserializer, Serialize};

/// Deserializes a JSON `null` as the type's default value (e.g., `""` for String, `0` for i32).
/// This matches Go's behavior where null JSON values become zero values.
fn nullable<'de, D, T>(deserializer: D) -> std::result::Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Option::<T>::deserialize(deserializer).map(Option::unwrap_or_default)
}

// ─── Tickers ────────────────────────────────────────────

/// A company entry from the SEC EDGAR company tickers list.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Ticker {
    #[serde(rename = "cik_str")]
    pub cik: u64,
    pub ticker: String,
    pub title: String,
}

// ─── Submissions ────────────────────────────────────────

/// Company submission data from the SEC EDGAR submissions endpoint.
/// Includes company metadata and filing history.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submission {
    pub cik: String,
    pub entity_type: String,
    pub sic: String,
    #[serde(rename = "sicDescription")]
    pub sic_description: String,
    pub insider_transaction_for_owner_exists: i32,
    pub insider_transaction_for_issuer_exists: i32,
    pub name: String,
    pub tickers: Vec<String>,
    pub exchanges: Vec<String>,
    pub ein: String,
    pub description: String,
    pub website: String,
    pub investor_website: String,
    pub category: String,
    pub fiscal_year_end: String,
    pub state_of_incorporation: String,
    pub state_of_incorporation_description: String,
    pub addresses: Addresses,
    pub phone: String,
    pub flags: String,
    pub former_names: Vec<FormerName>,
    pub filings: FilingHistory,
    #[serde(default)]
    pub lei: Option<String>,
    #[serde(default)]
    pub owner_org: Option<String>,
}

/// Mailing and business addresses for a company.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Addresses {
    pub mailing: Address,
    pub business: Address,
}

/// A physical address associated with a company filing.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Address {
    #[serde(default)]
    pub street1: Option<String>,
    #[serde(default)]
    pub street2: Option<String>,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub state_or_country: Option<String>,
    #[serde(default)]
    pub zip_code: Option<String>,
    #[serde(default)]
    pub state_or_country_description: Option<String>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub country_code: Option<String>,
    #[serde(default)]
    pub foreign_state_territory: Option<String>,
    #[serde(default)]
    pub is_foreign_location: Option<i32>,
}

/// A previous name used by a company.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FormerName {
    pub name: String,
    pub from: String,
    pub to: String,
}

/// Recent filing set plus references to additional historical files.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FilingHistory {
    pub recent: FilingSet,
    pub files: Vec<FilingFile>,
}

/// Reference to a supplemental filing history JSON file.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilingFile {
    pub name: String,
    pub filing_count: i32,
    pub filing_from: String,
    pub filing_to: String,
}

/// Parallel arrays of filing attributes. Each index `i` across all vectors
/// represents a single filing record.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilingSet {
    pub accession_number: Vec<String>,
    pub filing_date: Vec<String>,
    pub report_date: Vec<String>,
    pub acceptance_date_time: Vec<String>,
    pub act: Vec<String>,
    pub form: Vec<String>,
    pub file_number: Vec<String>,
    pub film_number: Vec<String>,
    pub items: Vec<String>,
    pub size: Vec<i64>,
    #[serde(rename = "isXBRL")]
    pub is_xbrl: Vec<i32>,
    #[serde(rename = "isInlineXBRL")]
    pub is_inline_xbrl: Vec<i32>,
    pub primary_document: Vec<String>,
    pub primary_doc_description: Vec<String>,
    #[serde(rename = "core_type", default)]
    pub core_type: Vec<String>,
}

// ─── XBRL: Company Concept ─────────────────────────────

/// All disclosures for a single XBRL concept from a single company,
/// grouped by unit of measure.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyConcept {
    pub cik: u64,
    pub taxonomy: String,
    pub tag: String,
    #[serde(deserialize_with = "nullable")]
    pub label: String,
    #[serde(deserialize_with = "nullable")]
    pub description: String,
    pub entity_name: String,
    pub units: HashMap<String, Vec<Fact>>,
}

// ─── XBRL: Company Facts ───────────────────────────────

/// All XBRL facts for a company, organized by taxonomy then tag.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyFacts {
    pub cik: u64,
    pub entity_name: String,
    pub facts: HashMap<String, HashMap<String, ConceptFacts>>,
}

/// Label, description, and unit-grouped facts for a single XBRL concept.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ConceptFacts {
    #[serde(deserialize_with = "nullable")]
    pub label: String,
    #[serde(deserialize_with = "nullable")]
    pub description: String,
    pub units: HashMap<String, Vec<Fact>>,
}

/// A single XBRL fact disclosure.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Fact {
    #[serde(default)]
    pub start: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub end: String,
    pub val: f64,
    #[serde(deserialize_with = "nullable")]
    pub accn: String,
    #[serde(default)]
    pub fy: Option<i32>,
    #[serde(deserialize_with = "nullable")]
    pub fp: String,
    #[serde(deserialize_with = "nullable")]
    pub form: String,
    #[serde(deserialize_with = "nullable")]
    pub filed: String,
    #[serde(default)]
    pub frame: Option<String>,
}

// ─── XBRL: Frames ──────────────────────────────────────

/// Aggregated XBRL data across all companies for a given concept,
/// unit, and period.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Frame {
    pub taxonomy: String,
    pub tag: String,
    pub ccp: String,
    pub uom: String,
    pub label: String,
    pub description: String,
    pub pts: i32,
    pub data: Vec<FrameData>,
}

/// A single entity's fact within a Frame.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameData {
    pub accn: String,
    pub cik: u64,
    pub entity_name: String,
    pub loc: String,
    #[serde(default)]
    pub start: Option<String>,
    pub end: String,
    pub val: f64,
}

// ─── Full-Text Search ──────────────────────────────────

/// Response from the EDGAR full-text search endpoint.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SearchResult {
    pub total: u64,
    pub hits: Vec<SearchHit>,
}

/// A single filing match from a full-text search.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SearchHit {
    pub id: String,
    pub score: f64,
    pub ciks: Vec<String>,
    pub display_names: Vec<String>,
    pub form: String,
    pub file_date: String,
    #[serde(default)]
    pub period_ending: Option<String>,
    pub accession_number: String,
    pub file_type: String,
    pub file_description: String,
}

/// Configuration for a full-text search query.
#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    /// Filter results to specific form types (e.g., "10-K", "8-K").
    pub forms: Vec<String>,
    /// Filter results filed on or after this date (YYYY-MM-DD).
    pub date_start: Option<String>,
    /// Filter results filed on or before this date (YYYY-MM-DD).
    pub date_end: Option<String>,
    /// Pagination offset (results are returned 100 at a time).
    pub from: Option<u32>,
}

// ─── Internal: EFTS Elasticsearch response ─────────────

#[derive(Debug, Deserialize, Serialize)]
pub struct EftsResponse {
    pub hits: EftsHits,
    #[serde(rename = "_shards", default)]
    pub shards: Option<serde_json::Value>,
    #[serde(default)]
    pub aggregations: Option<serde_json::Value>,
    #[serde(default)]
    pub query: Option<serde_json::Value>,
    #[serde(default)]
    pub timed_out: Option<bool>,
    #[serde(default)]
    pub took: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct EftsHits {
    pub total: EftsTotal,
    pub hits: Vec<EftsHit>,
    #[serde(default)]
    pub max_score: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct EftsTotal {
    pub value: u64,
    #[serde(default)]
    pub relation: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct EftsHit {
    #[serde(rename = "_id")]
    pub id: String,
    #[serde(rename = "_score")]
    pub score: f64,
    #[serde(rename = "_source")]
    pub source: EftsSource,
    #[serde(rename = "_index", default)]
    pub index: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct EftsSource {
    #[serde(default)]
    pub ciks: Vec<String>,
    #[serde(default)]
    pub display_names: Vec<String>,
    #[serde(default)]
    pub form: Option<String>,
    #[serde(default)]
    pub file_date: Option<String>,
    #[serde(default)]
    pub period_ending: Option<String>,
    #[serde(default)]
    pub adsh: Option<String>,
    #[serde(default)]
    pub file_type: Option<String>,
    #[serde(default)]
    pub file_description: Option<String>,
    #[serde(default)]
    pub biz_locations: Vec<serde_json::Value>,
    #[serde(default)]
    pub biz_states: Vec<serde_json::Value>,
    #[serde(default)]
    pub file_num: Vec<serde_json::Value>,
    #[serde(default)]
    pub film_num: Vec<serde_json::Value>,
    #[serde(default)]
    pub inc_states: Vec<serde_json::Value>,
    #[serde(default)]
    pub items: Vec<serde_json::Value>,
    #[serde(default)]
    pub root_forms: Vec<serde_json::Value>,
    #[serde(default)]
    pub sequence: Option<serde_json::Value>,
    #[serde(default)]
    pub sics: Vec<serde_json::Value>,
    #[serde(default)]
    pub xsl: Option<serde_json::Value>,
}
