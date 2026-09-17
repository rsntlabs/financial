use crate::{alpha::Alpha, edgar::Edgar, yahoo::Yahoo, Provider, ProviderChain, Request};
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
