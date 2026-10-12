//! The request-body extractor every console route uses instead of
//! `axum::Json`, so a rejection is always an [`ApiError`] the console can
//! show, never axum's plain text.

use axum::body::{Body, to_bytes};
use axum::extract::{FromRequest, Request};
use axum::http::header;
use serde::de::DeserializeOwned;

use crate::api_error::ApiError;

/// The largest body a console route accepts unless it declares its own
/// limit with [`BodyLimit`].
pub(crate) const DEFAULT_LIMIT: usize = 64 * 1024;

/// A route's own body limit, set as a request extension by a layer on the
/// route (`.layer(Extension(BodyLimit(10 * 1024 * 1024)))`), read by
/// [`ConsoleJson`].
#[derive(Clone, Copy, Debug)]
pub(crate) struct BodyLimit(pub(crate) usize);

/// A JSON request body. A missing or wrong content type is 415, a body over
/// the route's limit is 413 naming the limit ("This request is 12.4 MB;
/// this route accepts up to 10 MB."), malformed JSON or an unknown field
/// (for types that deny them) is 400 with what was wrong.
#[derive(Debug)]
pub(crate) struct ConsoleJson<T>(pub(crate) T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for ConsoleJson<T> {
    type Rejection = ApiError;

    async fn from_request(request: Request, _state: &S) -> Result<Self, Self::Rejection> {
        let is_json = request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .is_some_and(|media| {
                let media = media.trim();
                media.eq_ignore_ascii_case("application/json")
                    || (media.len() > 5
                        && media[..media.len() - 5].contains('/')
                        && media.to_ascii_lowercase().ends_with("+json"))
            });
        if !is_json {
            return Err(ApiError::media_type("This route takes a JSON body.")
                .with_fix("Send the body with content-type: application/json."));
        }
        let limit = request
            .extensions()
            .get::<BodyLimit>()
            .map_or(DEFAULT_LIMIT, |limit| limit.0);
        let declared = request
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok());
        let too_large = |size: Option<u64>| {
            let message = match size {
                Some(size) => format!(
                    "This request is {}; this route accepts up to {}.",
                    format_bytes(size),
                    format_bytes(u64::try_from(limit).unwrap_or(u64::MAX))
                ),
                None => format!(
                    "This request is larger than {}, the most this route accepts.",
                    format_bytes(u64::try_from(limit).unwrap_or(u64::MAX))
                ),
            };
            ApiError::too_large(message)
        };
        if let Some(size) = declared
            && size > u64::try_from(limit).unwrap_or(u64::MAX)
        {
            return Err(too_large(Some(size)));
        }
        let body: Body = request.into_body();
        let bytes = to_bytes(body, limit)
            .await
            .map_err(|_| too_large(declared))?;
        serde_json::from_slice(&bytes)
            .map(ConsoleJson)
            .map_err(|error| ApiError::invalid(format!("This request body is not valid: {error}.")))
    }
}

/// `512 B`, `64 KB`, `12.4 MB`: powers of 1024, at most one decimal.
fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut unit = 0;
    #[allow(
        clippy::cast_precision_loss,
        reason = "a size shown to a person, to one decimal"
    )]
    let mut value = bytes as f64;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        return format!("{bytes} B");
    }
    let text = format!("{value:.1}");
    format!("{} {}", text.trim_end_matches(".0"), UNITS[unit])
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use axum::routing::post;
    use axum::{Extension, Router};
    use serde::Deserialize;
    use tower::ServiceExt as _;

    use super::*;

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Body {
        name: String,
    }

    fn router() -> Router {
        let echo = || async |ConsoleJson(body): ConsoleJson<Body>| body.name;
        Router::new().route("/small", post(echo())).route(
            "/big",
            post(echo()).layer(Extension(BodyLimit(10 * 1024 * 1024))),
        )
    }

    /// Sends `body` as an HTTP client would: with its length when it has
    /// one.
    async fn send(
        uri: &str,
        content_type: Option<&str>,
        body: impl Into<axum::body::Body>,
    ) -> (StatusCode, serde_json::Value) {
        let body: axum::body::Body = body.into();
        let mut request = Request::post(uri);
        if let Some(content_type) = content_type {
            request = request.header(header::CONTENT_TYPE, content_type);
        }
        if let Some(length) = axum::body::HttpBody::size_hint(&body).exact() {
            request = request.header(header::CONTENT_LENGTH, length);
        }
        let response = router()
            .oneshot(request.body(body).expect("request"))
            .await
            .expect("response");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| serde_json::Value::String(String::from_utf8_lossy(&bytes).into()));
        (status, value)
    }

    #[tokio::test]
    async fn a_good_body_reaches_the_handler() {
        let (status, body) = send(
            "/small",
            Some("application/json; charset=utf-8"),
            r#"{"name":"ada"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "ada");
    }

    #[tokio::test]
    async fn every_rejection_is_an_api_error() {
        let (status, body) = send("/small", Some("text/plain"), r#"{"name":"ada"}"#).await;
        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(body["error"]["code"], "unsupported-media-type");
        let (status, body) = send("/small", None, r#"{"name":"ada"}"#).await;
        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{body}");
        let (status, body) = send("/small", Some("application/json"), "{nope").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "invalid-argument");
        let message = body["error"]["message"].as_str().expect("message");
        assert!(
            message.starts_with("This request body is not valid: "),
            "{message}"
        );
        let (status, body) = send(
            "/small",
            Some("application/json"),
            r#"{"name":"ada","extra":1}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"]["message"]
                .as_str()
                .expect("message")
                .contains("unknown field `extra`"),
            "{body}"
        );
    }

    #[tokio::test]
    async fn a_body_over_the_limit_names_the_limit() {
        let big = format!(r#"{{"name":"{}"}}"#, "a".repeat(70 * 1024));
        let (status, body) = send("/small", Some("application/json"), big.clone()).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(body["error"]["code"], "payload-too-large");
        assert_eq!(
            body["error"]["message"],
            "This request is 70 KB; this route accepts up to 64 KB."
        );
        // The route's own limit applies instead.
        let (status, _) = send("/big", Some("application/json"), big).await;
        assert_eq!(status, StatusCode::OK);
        // A streamed body with no length is cut at the limit too.
        let chunks =
            futures_util::stream::iter((0..80).map(|_| Ok::<_, std::io::Error>(vec![b' '; 1024])));
        let (status, body) = send(
            "/small",
            Some("application/json"),
            axum::body::Body::from_stream(chunks),
        )
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(
            body["error"]["message"],
            "This request is larger than 64 KB, the most this route accepts."
        );
    }

    #[test]
    fn sizes_read_as_the_console_writes_them() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(64 * 1024), "64 KB");
        assert_eq!(format_bytes(10 * 1024 * 1024), "10 MB");
        assert_eq!(format_bytes(13_002_342), "12.4 MB");
        assert_eq!(format_bytes(1_572_864), "1.5 MB");
    }
}
