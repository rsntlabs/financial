use reqwest::StatusCode;

/// Errors returned by the SEC EDGAR client.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// HTTP request failed (network, DNS, TLS, timeout, etc.).
    #[error("request to {endpoint} failed: {source}")]
    Request {
        endpoint: String,
        source: reqwest::Error,
    },

    /// SEC API returned a non-success status code.
    #[error("edgar: {message} (status {status}, endpoint {endpoint})")]
    Api {
        status: StatusCode,
        endpoint: String,
        message: String,
    },

    /// JSON deserialization failed.
    #[error("failed to parse response from {endpoint}: {source}")]
    Decode {
        endpoint: String,
        source: reqwest::Error,
    },

    /// Response body could not be interpreted as expected.
    #[error("failed to decode response from {endpoint}: {message}")]
    DecodeBody { endpoint: String, message: String },

    /// Client configuration error (e.g., missing user agent).
    #[error("invalid client configuration: {0}")]
    Config(String),
}

impl Error {
    /// Returns `true` if the SEC API responded with HTTP 429 (Too Many Requests).
    pub fn is_rate_limited(&self) -> bool {
        matches!(self, Error::Api { status, .. } if *status == StatusCode::TOO_MANY_REQUESTS)
    }

    /// Returns `true` if the SEC API responded with HTTP 404 (Not Found).
    pub fn is_not_found(&self) -> bool {
        matches!(self, Error::Api { status, .. } if *status == StatusCode::NOT_FOUND)
    }
}

/// A specialized `Result` type for SEC EDGAR operations.
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_rate_limited_returns_true_for_429() {
        let err = Error::Api {
            status: StatusCode::TOO_MANY_REQUESTS,
            endpoint: "https://example.com".into(),
            message: "rate limited".into(),
        };
        assert!(err.is_rate_limited());
        assert!(!err.is_not_found());
    }

    #[test]
    fn is_not_found_returns_true_for_404() {
        let err = Error::Api {
            status: StatusCode::NOT_FOUND,
            endpoint: "https://example.com".into(),
            message: "not found".into(),
        };
        assert!(err.is_not_found());
        assert!(!err.is_rate_limited());
    }

    #[test]
    fn is_rate_limited_returns_false_for_other_status() {
        let err = Error::Api {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            endpoint: "https://example.com".into(),
            message: "server error".into(),
        };
        assert!(!err.is_rate_limited());
        assert!(!err.is_not_found());
    }

    #[test]
    fn is_rate_limited_returns_false_for_non_api_errors() {
        let err = Error::Config("test".into());
        assert!(!err.is_rate_limited());
        assert!(!err.is_not_found());
    }

    #[test]
    fn config_error_display() {
        let err = Error::Config("missing user agent".into());
        assert_eq!(
            err.to_string(),
            "invalid client configuration: missing user agent"
        );
    }

    #[test]
    fn api_error_display() {
        let err = Error::Api {
            status: StatusCode::NOT_FOUND,
            endpoint: "https://data.sec.gov/test".into(),
            message: "unexpected status 404 Not Found".into(),
        };
        let msg = err.to_string();
        assert!(msg.contains("404 Not Found"));
        assert!(msg.contains("https://data.sec.gov/test"));
    }

    #[test]
    fn decode_body_error_display() {
        let err = Error::DecodeBody {
            endpoint: "https://example.com".into(),
            message: "not valid UTF-8".into(),
        };
        let msg = err.to_string();
        assert!(msg.contains("not valid UTF-8"));
        assert!(msg.contains("https://example.com"));
    }

    #[test]
    fn error_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Error>();
    }
}
