//! One error shape for the whole Console API.
//!
//! Every console route answers a failure as `{ "error": { "code", "message",
//! "fix"? } }` with a status that matches the code, so the console can branch
//! on what went wrong (a section still starting, a name already taken) and
//! show the sentence and the fix as they are. A route that has more to say
//! than a sentence (the rules routes' compiler diagnostics) adds it beside
//! `error` with [`ApiError::with_extra`]. Sections add no codes of their own:
//! the twelve here are the vocabulary.

use std::fmt;

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{Map, Value};
use ts_rs::TS;

/// What kind of failure an error is, for code that branches on it; the
/// message is for people.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    /// 400: the request is malformed or names something impossible.
    InvalidArgument,
    /// 403: refused by security rules or by the request guard.
    PermissionDenied,
    /// 404: nothing at that name.
    NotFound,
    /// 409: something with that name already exists.
    AlreadyExists,
    /// 412: a condition the request depends on does not hold (the thing
    /// changed since it was read; not enough free space for a snapshot).
    FailedPrecondition,
    /// 409: the request conflicts with the current state: background
    /// triggers are paused, another job is running, a task name was used
    /// recently, a queue is full, a rules file the console may not save.
    Conflict,
    /// 503: the service is still starting; retry when the section is ready.
    Starting,
    /// 503: the service cannot answer now (it is stopping), or it is not part
    /// of this suite, and then always with the fix that turns it on.
    Unavailable,
    /// 413: the request or the answer would be too large (the route names
    /// its limit).
    PayloadTooLarge,
    /// 429: a limit of the console's channel was reached (live connections
    /// or subscriptions), or a service's own quota.
    ResourceExhausted,
    /// 415: a mutation without a JSON body or the console header, or a media
    /// type the route cannot handle (no thumbnail or archive for this type).
    UnsupportedMediaType,
    /// 500: a fault in the engine.
    Internal,
}

impl ErrorCode {
    /// The HTTP status every answer with this code carries.
    #[must_use]
    pub const fn status(self) -> StatusCode {
        match self {
            Self::InvalidArgument => StatusCode::BAD_REQUEST,
            Self::PermissionDenied => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::AlreadyExists | Self::Conflict => StatusCode::CONFLICT,
            Self::FailedPrecondition => StatusCode::PRECONDITION_FAILED,
            Self::Starting | Self::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::ResourceExhausted => StatusCode::TOO_MANY_REQUESTS,
            Self::UnsupportedMediaType => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

/// The body of every Console API error.
#[derive(Clone, Debug, Serialize, TS)]
pub struct ApiErrorBody {
    pub error: ApiErrorDetail,
}

/// What went wrong.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorDetail {
    pub code: ErrorCode,
    /// What went wrong, as a sentence.
    pub message: String,
    /// How to fix it, when the developer can.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fix: Option<String>,
}

/// A Console API error: a status, the detail, and optional top-level extras
/// (the rules routes keep their `diagnostics` array beside `error`).
#[derive(Clone, Debug)]
pub struct ApiError {
    detail: ApiErrorDetail,
    extra: Map<String, Value>,
}

impl ApiError {
    fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            detail: ApiErrorDetail {
                code,
                message: message.into(),
                fix: None,
            },
            extra: Map::new(),
        }
    }

    /// 400 `invalid-argument`.
    #[must_use]
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument, message)
    }

    /// 403 `permission-denied`.
    #[must_use]
    pub fn permission_denied(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::PermissionDenied, message)
    }

    /// 404 `not-found`.
    #[must_use]
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    /// 409 `already-exists`.
    #[must_use]
    pub fn already_exists(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::AlreadyExists, message)
    }

    /// 412 `failed-precondition`.
    #[must_use]
    pub fn precondition(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::FailedPrecondition, message)
    }

    /// 409 `conflict`.
    #[must_use]
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, message)
    }

    /// 503 `starting`: `service` ("Functions") is not up yet, and the page
    /// that asked fills in by itself once it is.
    #[must_use]
    pub fn starting(service: &str) -> Self {
        Self::new(ErrorCode::Starting, format!("{service} is still starting."))
            .with_fix("This page fills in by itself when it is ready.")
    }

    /// 503 `unavailable`.
    #[must_use]
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unavailable, message)
    }

    /// 413 `payload-too-large`.
    #[must_use]
    pub fn too_large(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::PayloadTooLarge, message)
    }

    /// 429 `resource-exhausted`.
    #[must_use]
    pub fn exhausted(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ResourceExhausted, message)
    }

    /// 415 `unsupported-media-type`.
    #[must_use]
    pub fn media_type(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::UnsupportedMediaType, message)
    }

    /// 500 `internal`.
    #[must_use]
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    /// Says how to fix it.
    #[must_use]
    pub fn with_fix(mut self, fix: impl Into<String>) -> Self {
        self.detail.fix = Some(fix.into());
        self
    }

    /// Adds `key` beside `error` in the body (`diagnostics`, `span`, …).
    /// `error` itself cannot be replaced this way.
    #[must_use]
    pub fn with_extra(mut self, key: &str, value: Value) -> Self {
        if key != "error" {
            self.extra.insert(key.to_owned(), value);
        }
        self
    }

    /// What went wrong, as the body's `error` carries it.
    #[must_use]
    pub const fn detail(&self) -> &ApiErrorDetail {
        &self.detail
    }

    /// The HTTP status of the answer.
    #[must_use]
    pub const fn status(&self) -> StatusCode {
        self.detail.code.status()
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.detail.message)
    }
}

impl std::error::Error for ApiError {}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status();
        let mut body = self.extra;
        body.insert(
            "error".to_owned(),
            // The detail is strings and an enum; it always serializes.
            serde_json::to_value(&self.detail).unwrap_or(Value::Null),
        );
        (status, Json(Value::Object(body))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use axum::body::to_bytes;
    use serde_json::json;

    use super::*;

    async fn answer(error: ApiError) -> (StatusCode, Value) {
        let response = error.into_response();
        let status = response.status();
        assert_eq!(
            response.headers()[axum::http::header::CONTENT_TYPE],
            "application/json"
        );
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        (status, serde_json::from_slice(&body).expect("json"))
    }

    #[tokio::test]
    async fn every_code_answers_with_its_status_and_its_spelling() {
        let cases = [
            (ApiError::invalid("m"), 400, "invalid-argument"),
            (ApiError::permission_denied("m"), 403, "permission-denied"),
            (ApiError::not_found("m"), 404, "not-found"),
            (ApiError::already_exists("m"), 409, "already-exists"),
            (ApiError::precondition("m"), 412, "failed-precondition"),
            (ApiError::conflict("m"), 409, "conflict"),
            (ApiError::starting("Functions"), 503, "starting"),
            (ApiError::unavailable("m"), 503, "unavailable"),
            (ApiError::too_large("m"), 413, "payload-too-large"),
            (ApiError::exhausted("m"), 429, "resource-exhausted"),
            (ApiError::media_type("m"), 415, "unsupported-media-type"),
            (ApiError::internal("m"), 500, "internal"),
        ];
        for (error, status, code) in cases {
            let (answered, body) = answer(error).await;
            assert_eq!(answered.as_u16(), status, "{code}");
            assert_eq!(body["error"]["code"], code);
        }
    }

    #[tokio::test]
    async fn the_body_is_the_detail_with_the_fix_only_when_there_is_one() {
        let (_, body) = answer(ApiError::not_found("no such thing")).await;
        assert_eq!(
            body,
            json!({ "error": { "code": "not-found", "message": "no such thing" } })
        );
        let (_, body) = answer(ApiError::starting("Functions")).await;
        assert_eq!(
            body,
            json!({ "error": {
                "code": "starting",
                "message": "Functions is still starting.",
                "fix": "This page fills in by itself when it is ready.",
            } })
        );
    }

    #[tokio::test]
    async fn extras_sit_beside_the_error_and_never_replace_it() {
        let error = ApiError::invalid("these rules did not compile; nothing changed")
            .with_extra("diagnostics", json!([{ "line": 3 }]))
            .with_extra("error", json!("ignored"));
        assert_eq!(error.detail().code, ErrorCode::InvalidArgument);
        let (status, body) = answer(error).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["diagnostics"], json!([{ "line": 3 }]));
        assert_eq!(
            body["error"]["message"],
            "these rules did not compile; nothing changed"
        );
    }
}
