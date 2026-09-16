//! Request construction and API error parsing belong to alpha_vantage.
//! Its transport extension point bridges its Send futures to the single-threaded browser.
use alpha_vantage::{api::ApiClient, client::HttpClient, error::Error};
use async_trait::async_trait;
use serde_json::Value;

struct Transport;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(
    inline_js = "export async function alphaFetch(url) { const response = await fetch(url, {signal: AbortSignal.timeout(25000), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'}); if (!response.ok) throw response.status === 429 ? 'quota' : response.status === 408 || response.status >= 500 ? 'temporary' : 'rejected'; return await response.text(); } export function alphaDelay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }"
)]
extern "C" {
    #[wasm_bindgen::prelude::wasm_bindgen(js_name = alphaFetch)]
    fn alpha_fetch(url: &str) -> js_sys::Promise;
    #[wasm_bindgen::prelude::wasm_bindgen(js_name = alphaDelay)]
    fn alpha_delay(ms: u32) -> js_sys::Promise;
}

#[async_trait]
impl HttpClient for Transport {
    async fn get_alpha_vantage_provider_output(&self, path: &str) -> Result<String, Error> {
        #[cfg(target_arch = "wasm32")]
        {
            // WASM executes on one browser thread. SendWrapper checks this invariant
            // and avoids modifying/vendoring the crate's Send-based transport trait.
            send_wrapper::SendWrapper::new(async {
                let value = wasm_bindgen_futures::JsFuture::from(alpha_fetch(path))
                    .await
                    .map_err(|error| match error.as_string().as_deref() {
                        Some("quota") => Error::AlphaVantageNote("request limit".into()),
                        Some("rejected") => {
                            Error::AlphaVantageErrorMessage("HTTP request rejected".into())
                        }
                        _ => Error::GetRequestFailed,
                    })?;
                value.as_string().ok_or(Error::DecodeJsonToStruct)
            })
            .await
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let response = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(25))
                .build()
                .map_err(|_| Error::CreateUrl)?
                .get(path)
                .send()
                .await
                .map_err(|_| Error::GetRequestFailed)?;
            let status = response.status();
            if status.as_u16() == 429 {
                return Err(Error::AlphaVantageNote("request limit".into()));
            }
            if status.is_server_error() || status.as_u16() == 408 {
                return Err(Error::GetRequestFailed);
            }
            if !status.is_success() {
                return Err(Error::AlphaVantageErrorMessage(
                    "HTTP request rejected".into(),
                ));
            }
            response.text().await.map_err(|_| Error::GetRequestFailed)
        }
    }
    async fn get_rapid_api_provider_output(
        &self,
        _path: &str,
        _key: &str,
    ) -> Result<String, Error> {
        Err(Error::CreateUrl)
    }
}

// Three retries after the initial attempt, independently for each endpoint.
const RETRY_DELAYS: [u32; 3] = [1000, 2000, 4000];

fn is_quota_limit(error: &Error) -> bool {
    match error {
        Error::AlphaVantageInformation(message)
        | Error::AlphaVantageNote(message)
        | Error::AlphaVantageErrorMessage(message) => {
            let message = message.to_ascii_lowercase();
            ["limit", "frequency", "requests", "quota"]
                .iter()
                .any(|word| message.contains(word))
        }
        _ => false,
    }
}

async fn request_with_retries<T, F, Fut, S, Sleep>(mut request: F, mut sleep: S) -> Result<T, Error>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, Error>>,
    S: FnMut(u32) -> Sleep,
    Sleep: std::future::Future<Output = ()>,
{
    for delay in RETRY_DELAYS {
        match request().await {
            Err(error) if matches!(error, Error::GetRequestFailed) || is_quota_limit(&error) => {
                sleep(delay).await;
            }
            result => return result,
        }
    }
    request().await
}

async fn wait_before_retry(ms: u32) {
    #[cfg(target_arch = "wasm32")]
    {
        let _ = wasm_bindgen_futures::JsFuture::from(alpha_delay(ms)).await;
    }
    #[cfg(not(target_arch = "wasm32"))]
    tokio::time::sleep(std::time::Duration::from_millis(ms.into())).await;
}

pub async fn fetch_statement(key: &str, ticker: &str, function: &str) -> Result<Value, String> {
    let ticker = crate::normalize_ticker(ticker)?;
    if key.is_empty() || key.len() > 128 || !key.bytes().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Enter your Alpha Vantage API key (letters and numbers only).".into());
    }
    if ![
        "INCOME_STATEMENT",
        "BALANCE_SHEET",
        "CASH_FLOW",
        "OVERVIEW",
        "TIME_SERIES_DAILY",
    ]
    .contains(&function)
    {
        return Err("Unsupported financial data request.".into());
    }
    let api = ApiClient::set_api(key, Transport);
    // Request every available daily session, rather than the default 100-session window.
    // The crate's documented custom builder covers statements and price endpoints.
    // Validated/encoded inputs are needed because that builder concatenates its query.
    let ticker = ticker.replace('^', "%5E").replace('=', "%3D");
    request_with_retries(
        || async {
            let mut request = api.custom(function);
            request.extra_params("symbol", &ticker);
            if function == "TIME_SERIES_DAILY" {
                request.extra_params("outputsize", "full");
            }
            request.json::<Value>().await
        },
        wait_before_retry,
    ).await.map_err(|error| {
        // Never echo provider messages or URLs: they can include the user's key.
        match error {
            error if is_quota_limit(&error) =>
                "Alpha Vantage's request limit was still reached after 3 automatic retries. Use a saved stock or try again when your allowance resets.".into(),
            Error::AlphaVantageInformation(_) | Error::AlphaVantageErrorMessage(_)
                if function == "TIME_SERIES_DAILY" =>
                "Alpha Vantage rejected the full price history request. Full daily history requires a premium Alpha Vantage key. Check your key, ticker and plan access in Data settings.".into(),
            Error::AlphaVantageInformation(_) | Error::AlphaVantageErrorMessage(_) =>
                "Alpha Vantage rejected the request. Check your API key, ticker and plan access in Data settings.".into(),
            Error::GetRequestFailed => "Could not reach Alpha Vantage after 3 automatic retries. Check your connection and try again. Saved stocks still work.".into(),
            _ => "Alpha Vantage returned an unreadable response. No data was saved.".into(),
        }
    })
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub async fn fetch_alpha_statement(
    key: String,
    ticker: String,
    function: String,
) -> Result<String, String> {
    serde_json::to_string(&fetch_statement(&key, &ticker, &function).await?)
        .map_err(|_| "Invalid response".into())
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::VecDeque};

    fn run(results: Vec<Result<u8, Error>>) -> (Result<u8, Error>, Vec<u32>, usize) {
        let results = RefCell::new(VecDeque::from(results));
        let waits = RefCell::new(Vec::new());
        let calls = std::cell::Cell::new(0);
        let result = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(request_with_retries(
                || {
                    calls.set(calls.get() + 1);
                    std::future::ready(results.borrow_mut().pop_front().expect("unexpected retry"))
                },
                |ms| {
                    waits.borrow_mut().push(ms);
                    std::future::ready(())
                },
            ));
        (result, waits.into_inner(), calls.get())
    }

    #[test]
    fn retries_three_times_with_backoff_and_stops_on_success() {
        let (result, waits, calls) = run(vec![
            Err(Error::GetRequestFailed),
            Err(Error::GetRequestFailed),
            Err(Error::GetRequestFailed),
            Ok(7),
        ]);
        assert_eq!(result.unwrap(), 7);
        assert_eq!(waits, [1000, 2000, 4000]);
        assert_eq!(calls, 4);
        let (_, waits, calls) = run(vec![Err(Error::GetRequestFailed), Ok(7)]);
        assert_eq!(waits, [1000]);
        assert_eq!(calls, 2);
    }

    #[test]
    fn bounds_failures_and_does_not_retry_provider_rejections() {
        let (result, waits, calls) = run((0..4).map(|_| Err(Error::GetRequestFailed)).collect());
        assert!(matches!(result, Err(Error::GetRequestFailed)));
        assert_eq!(calls, 4);
        assert_eq!(waits.len(), 3);
        for error in [
            Error::AlphaVantageErrorMessage("bad key".into()),
            Error::DecodeJsonToStruct,
        ] {
            let (result, waits, calls) = run(vec![Err(error)]);
            assert!(result.is_err());
            assert!(waits.is_empty());
            assert_eq!(calls, 1);
        }
    }
    #[test]
    fn quota_responses_retry_and_share_the_same_attempt_budget() {
        let (result, waits, calls) = run(vec![
            Err(Error::AlphaVantageNote("request limit".into())),
            Err(Error::GetRequestFailed),
            Err(Error::AlphaVantageInformation("API QUOTA exceeded".into())),
            Ok(7),
        ]);
        assert_eq!(result.unwrap(), 7);
        assert_eq!(waits, [1000, 2000, 4000]);
        assert_eq!(calls, 4);
        let (result, waits, calls) = run((0..4)
            .map(|_| Err(Error::AlphaVantageErrorMessage("API rate limit".into())))
            .collect());
        assert!(result.is_err());
        assert_eq!(waits, [1000, 2000, 4000]);
        assert_eq!(calls, 4);
    }
}
