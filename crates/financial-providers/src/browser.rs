use crate::{
    alpha::Alpha,
    edgar::{Edgar, TickerEntry},
    yahoo::Yahoo,
    Provider, ProviderChain, Request,
};
use wasm_bindgen::prelude::*;

// Reuse authentication and SEC caches within the tab; keys live only for each call.
#[wasm_bindgen]
pub struct BrowserProviders {
    yahoo: Yahoo,
    edgar: Edgar,
}

#[wasm_bindgen]
impl BrowserProviders {
    /// `proxy_base` is the deployed Cloudflare Worker origin (e.g.
    /// `https://financials-provider-proxy.example.workers.dev`) that proxies
    /// Yahoo Finance and SEC EDGAR requests; see docs/providers.md.
    #[wasm_bindgen(constructor)]
    pub fn new(proxy_base: String) -> Result<BrowserProviders, String> {
        Ok(Self {
            yahoo: Yahoo::new(&proxy_base)?,
            edgar: Edgar::new(&proxy_base)?,
        })
    }

    pub async fn financials(
        &self,
        ticker: String,
        api_key: String,
        years: u32,
        end_year: Option<i32>,
    ) -> Result<String, String> {
        let request = Request::new(&ticker, years, end_year)?;
        let alpha = alpha(&api_key)?;
        let chain = self.chain(alpha.as_ref());
        serde_json::to_string(&chain.financials(&request).await?)
            .map_err(|_| "Invalid financial data.".into())
    }

    pub async fn prices(&self, ticker: String, api_key: String) -> Result<String, String> {
        let alpha = alpha(&api_key)?;
        let chain = self.chain(alpha.as_ref());
        let prices = chain.prices(&ticker).await?;
        serde_json::to_string(&prices).map_err(|_| "Invalid price data.".into())
    }

    /// The option chain nearest `horizon_days`, for the Greeks-driven options
    /// outlook. Yahoo is the only provider that quotes contracts, so there is
    /// no fallback chain and no API key involved.
    pub async fn options(&self, ticker: String, horizon_days: u32) -> Result<String, String> {
        let chain = self.yahoo.option_chain(&ticker, horizon_days).await?;
        serde_json::to_string(&chain).map_err(|_| "Invalid option chain data.".into())
    }

    /// Every SEC-registered ticker and company name, for the search dropdown.
    pub async fn tickers(&self) -> Result<String, String> {
        let tickers = self.edgar.tickers().await?;
        serde_json::to_string(&tickers).map_err(|_| "Invalid ticker data.".into())
    }

    /// Hands back a ticker list this page saved earlier, filling the SEC
    /// ticker -> CIK map (see `Edgar::prime_tickers`) without a request. A page
    /// that has one no longer waits for that file to download before the
    /// company facts behind the first search can be asked for.
    #[wasm_bindgen(js_name = primeTickers)]
    pub async fn prime_tickers(&self, tickers: String) -> Result<(), String> {
        let entries: Vec<TickerEntry> =
            serde_json::from_str(&tickers).map_err(|_| "Invalid ticker data.".to_string())?;
        self.edgar.prime_tickers(entries).await;
        Ok(())
    }
}

impl BrowserProviders {
    fn chain<'a>(&'a self, alpha: Option<&'a Alpha>) -> ProviderChain<'a> {
        ProviderChain::new(&self.yahoo, &self.edgar, alpha.map(|a| a as &dyn Provider))
    }
}

fn alpha(key: &str) -> Result<Option<Alpha>, String> {
    if key.is_empty() {
        return Ok(None);
    }
    Alpha::new(key).map(Some)
}
