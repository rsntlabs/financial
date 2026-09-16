use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderValue, Method, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use financial_providers::{
    alpha::Alpha, edgar::Edgar, yahoo::Yahoo, Provider, ProviderChain, Request,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tower_http::{cors::CorsLayer, services::ServeDir};

struct App {
    yahoo: Arc<dyn Provider>,
    edgar: Arc<dyn Provider>,
    slots: tokio::sync::Semaphore,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Query {
    ticker: String,
    #[serde(default)]
    api_key: String,
    #[serde(default = "ten")]
    years: u32,
    end_year: Option<i32>,
}
fn ten() -> u32 {
    10
}
type ApiResult = Result<axum::response::Response, (StatusCode, Json<Value>)>;
fn error(status: StatusCode, message: String) -> (StatusCode, Json<Value>) {
    (status, Json(json!({"error":message})))
}
async fn acquire(app: Arc<App>, query: Query, prices: bool) -> ApiResult {
    let request = Request::new(&query.ticker, query.years, query.end_year)
        .map_err(|e| error(StatusCode::BAD_REQUEST, e))?;
    let alpha = if query.api_key.is_empty() {
        None
    } else {
        Some(Alpha::new(&query.api_key).map_err(|e| error(StatusCode::BAD_REQUEST, e))?)
    };
    let _permit = app.slots.try_acquire().map_err(|_| {
        error(
            StatusCode::TOO_MANY_REQUESTS,
            "Provider service is busy. Try again shortly.".into(),
        )
    })?;
    let chain = ProviderChain::new(
        app.yahoo.as_ref(),
        app.edgar.as_ref(),
        alpha.as_ref().map(|a| a as &dyn Provider),
    );
    let result = tokio::time::timeout(Duration::from_secs(240), async {
        if prices {
            serde_json::to_value(chain.prices(&request.ticker).await?)
                .map_err(|_| "Invalid price data.".into())
        } else {
            serde_json::to_value(chain.financials(&request).await?)
                .map_err(|_| "Invalid financial data.".into())
        }
    })
    .await
    .map_err(|_| {
        error(
            StatusCode::GATEWAY_TIMEOUT,
            "Provider request timed out. Try again.".into(),
        )
    })?
    .map_err(|e| error(StatusCode::BAD_GATEWAY, e))?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(result)).into_response())
}
async fn financials(State(app): State<Arc<App>>, Json(query): Json<Query>) -> ApiResult {
    acquire(app, query, false).await
}
async fn prices(State(app): State<Arc<App>>, Json(query): Json<Query>) -> ApiResult {
    acquire(app, query, true).await
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let user_agent = std::env::var("SEC_USER_AGENT")
        .map_err(|_| "Set SEC_USER_AGENT to your application name and real contact email.")?;
    let app = Arc::new(App {
        yahoo: Arc::new(Yahoo::new()?),
        edgar: Arc::new(Edgar::new(&user_agent)?),
        slots: tokio::sync::Semaphore::new(4),
    });
    let mut router = api_router(app);
    if let Ok(origin) = std::env::var("WEB_ORIGIN") {
        router = router.layer(
            CorsLayer::new()
                .allow_origin(origin.parse::<HeaderValue>()?)
                .allow_methods([Method::POST, Method::GET])
                .allow_headers([header::CONTENT_TYPE]),
        );
    }
    let static_dir = std::env::var("WEB_DIST").unwrap_or_else(|_| "web/dist".into());
    router = router.fallback_service(ServeDir::new(static_dir));
    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3001".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    eprintln!("Financial provider service listening on {bind}");
    axum::serve(listener, router).await?;
    Ok(())
}

fn api_router(app: Arc<App>) -> Router {
    Router::new()
        .route(
            "/api/health",
            get(|| async { Json(json!({"status":"ok"})) }),
        )
        .route("/api/financials", post(financials))
        .route("/api/prices", post(prices))
        .layer(DefaultBodyLimit::max(4096))
        .with_state(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::Request as HttpRequest,
    };
    use financial_providers::Needs;
    use tower::ServiceExt;
    use yfinance_core::dataset::Dataset;
    struct Free;
    #[async_trait::async_trait]
    impl Provider for Free {
        fn name(&self) -> &'static str {
            "Free"
        }
        async fn financials(&self, _: &Request, _: &Needs) -> Result<Dataset, String> {
            let mut data = Dataset::new();
            data.currency = Some("USD".into());
            data.name = Some("Test".into());
            for year in 2016..=2025 {
                for (_, rows) in yfinance_core::statements::SECTIONS {
                    for (_, metric, _) in *rows {
                        data.insert(metric, &format!("{year}-12-31"), 100., "Free");
                    }
                }
            }
            Ok(data)
        }
    }
    fn app() -> Router {
        api_router(Arc::new(App {
            yahoo: Arc::new(Free),
            edgar: Arc::new(Free),
            slots: tokio::sync::Semaphore::new(4),
        }))
    }
    #[tokio::test]
    async fn keyless_http_request_returns_normalized_data_and_disables_caching() {
        let response = app()
            .oneshot(
                HttpRequest::post("/api/financials")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"ticker":"test"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1_000_000).await.unwrap())
                .unwrap();
        assert_eq!(body["schemaVersion"], 1);
        assert_eq!(body["sources"]["annualTotalRevenue"]["2025-12-31"], "Free");
    }
    #[tokio::test]
    async fn invalid_input_is_rejected_without_echoing_keys() {
        for body in [
            r#"{"ticker":"../bad","apiKey":"SECRET"}"#,
            r#"{"ticker":"TEST","apiKey":"SECRET&bad"}"#,
            r#"{"ticker":"TEST","years":1}"#,
        ] {
            let response = app()
                .oneshot(
                    HttpRequest::post("/api/financials")
                        .header("content-type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let body =
                String::from_utf8(to_bytes(response.into_body(), 4096).await.unwrap().to_vec())
                    .unwrap();
            assert!(!body.contains("SECRET"));
        }
    }
}
