//! Error responses in the official emulator's JSON shape
//! (`{ "error": { code, message, errors: [...], status? } }`).

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value as JsonValue, json};

/// One API error as the official emulator serializes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub code: u16,
    pub status: Option<&'static str>,
    pub message: String,
    pub errors: Vec<JsonValue>,
}

impl ApiError {
    fn with_reason(code: u16, status: Option<&'static str>, message: String, reason: &str) -> Self {
        Self {
            code,
            status,
            errors: vec![json!({ "message": message, "reason": reason })],
            message,
        }
    }

    /// `BadRequestError`: `400` with the default `invalid`/`global` detail.
    pub fn bad_request(message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            code: 400,
            status: None,
            errors: vec![json!({ "message": message, "reason": "invalid", "domain": "global" })],
            message,
        }
    }

    /// `BadRequestError` with an explicit reason (used for `HttpBadRequestError`).
    pub fn bad_request_reason(message: impl Into<String>, reason: &str) -> Self {
        Self::with_reason(400, None, message.into(), reason)
    }

    /// `InvalidArgumentError`: `400 INVALID_ARGUMENT`.
    pub fn invalid_argument(message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            code: 400,
            status: Some("INVALID_ARGUMENT"),
            errors: vec![json!({ "message": message, "reason": "invalid", "domain": "global" })],
            message,
        }
    }

    /// `InvalidArgumentError` for an unparsable body (`parseError` detail).
    pub fn parse_error(message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            code: 400,
            status: Some("INVALID_ARGUMENT"),
            errors: vec![json!({ "message": message, "domain": "global", "reason": "parseError" })],
            message,
        }
    }

    /// `UnauthenticatedError`: `401 UNAUTHENTICATED` with the recorded detail.
    #[must_use]
    pub fn unauthenticated(message: &str, detail_message: &str, reason: &str) -> Self {
        Self {
            code: 401,
            status: Some("UNAUTHENTICATED"),
            message: message.to_owned(),
            errors: vec![json!({
                "message": detail_message,
                "domain": "global",
                "reason": reason,
                "location": "Authorization",
                "locationType": "header",
            })],
        }
    }

    /// `PermissionDeniedError`: `403 PERMISSION_DENIED`.
    pub fn permission_denied(message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            code: 403,
            status: Some("PERMISSION_DENIED"),
            errors: vec![json!({ "message": message, "reason": "forbidden", "domain": "global" })],
            message,
        }
    }

    /// `NotFoundError`: `404 NOT_FOUND`.
    #[must_use]
    pub fn not_found() -> Self {
        Self::with_reason(404, Some("NOT_FOUND"), "Not Found".to_owned(), "notFound")
    }

    /// `InternalError`: `500 INTERNAL` with the reason the emulator recorded.
    pub fn internal(message: impl Into<String>, reason: &str) -> Self {
        Self::with_reason(500, Some("INTERNAL"), message.into(), reason)
    }

    /// `UnknownError`: `500 UNKNOWN`.
    pub fn unknown(message: impl Into<String>, reason: &str) -> Self {
        Self::with_reason(500, Some("UNKNOWN"), message.into(), reason)
    }

    /// `NotImplementedError`: `501 NOT_IMPLEMENTED`.
    pub fn not_implemented(message: impl Into<String>) -> Self {
        Self::with_reason(
            501,
            Some("NOT_IMPLEMENTED"),
            message.into(),
            "unimplemented",
        )
    }

    /// The `{ "error": ... }` document.
    #[must_use]
    pub fn to_json(&self) -> JsonValue {
        let mut error = json!({
            "code": self.code,
            "message": self.message,
            "errors": self.errors,
        });
        if let Some(status) = self.status {
            error["status"] = json!(status);
        }
        json!({ "error": error })
    }

    #[must_use]
    pub fn is_bad_request(&self) -> bool {
        self.code == 400 && self.status.is_none()
    }

    #[must_use]
    pub fn is_not_implemented(&self) -> bool {
        self.code == 501
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        crate::pretty_json(status, &self.to_json())
    }
}

/// `assert(condition, "MESSAGE")`: a `BadRequestError` when the condition fails.
macro_rules! ensure {
    ($condition:expr, $message:expr) => {
        if !($condition) {
            return Err($crate::error::ApiError::bad_request($message));
        }
    };
}

/// `assert(value, "MESSAGE")` on an `Option`: the inner value, or a `BadRequestError`.
macro_rules! require {
    ($option:expr, $message:expr) => {
        match $option {
            Some(value) => value,
            None => return Err($crate::error::ApiError::bad_request($message)),
        }
    };
}

pub(crate) use ensure;
pub(crate) use require;
