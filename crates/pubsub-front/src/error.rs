//! The error the broker raises, carried to gRPC as a `Status` and to
//! HTTP/JSON as the official emulator's `{ "error": { code, message, status } }`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use tonic::Code;

/// A failed Pub/Sub operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PubsubError {
    pub code: Code,
    pub message: String,
}

impl PubsubError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(Code::InvalidArgument, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(Code::NotFound, message)
    }

    pub fn already_exists(message: impl Into<String>) -> Self {
        Self::new(Code::AlreadyExists, message)
    }

    pub fn failed_precondition(message: impl Into<String>) -> Self {
        Self::new(Code::FailedPrecondition, message)
    }

    pub fn out_of_range(message: impl Into<String>) -> Self {
        Self::new(Code::OutOfRange, message)
    }

    pub fn unimplemented(message: impl Into<String>) -> Self {
        Self::new(Code::Unimplemented, message)
    }

    /// The official emulator's answer when one of its own checks throws.
    #[must_use]
    pub fn application_error() -> Self {
        Self::new(Code::Unknown, "Application error processing RPC")
    }

    /// `Invalid [topics] name: (name=...)`.
    #[must_use]
    pub fn invalid_name(collection: &str, name: &str) -> Self {
        Self::invalid_argument(format!("Invalid [{collection}] name: (name={name})"))
    }

    /// The HTTP status the official transcoder maps this code to.
    #[must_use]
    pub fn http_status(&self) -> StatusCode {
        match self.code {
            Code::InvalidArgument | Code::FailedPrecondition | Code::OutOfRange => {
                StatusCode::BAD_REQUEST
            }
            Code::NotFound => StatusCode::NOT_FOUND,
            Code::AlreadyExists | Code::Aborted => StatusCode::CONFLICT,
            Code::PermissionDenied => StatusCode::FORBIDDEN,
            Code::Unauthenticated => StatusCode::UNAUTHORIZED,
            Code::ResourceExhausted => StatusCode::TOO_MANY_REQUESTS,
            Code::Unimplemented => StatusCode::NOT_IMPLEMENTED,
            Code::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            Code::DeadlineExceeded => StatusCode::GATEWAY_TIMEOUT,
            Code::Cancelled => StatusCode::from_u16(499).unwrap_or(StatusCode::BAD_REQUEST),
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// The `google.rpc.Code` name (`INVALID_ARGUMENT`).
    #[must_use]
    pub fn status_name(&self) -> &'static str {
        match self.code {
            Code::Ok => "OK",
            Code::Cancelled => "CANCELLED",
            Code::Unknown => "UNKNOWN",
            Code::InvalidArgument => "INVALID_ARGUMENT",
            Code::DeadlineExceeded => "DEADLINE_EXCEEDED",
            Code::NotFound => "NOT_FOUND",
            Code::AlreadyExists => "ALREADY_EXISTS",
            Code::PermissionDenied => "PERMISSION_DENIED",
            Code::ResourceExhausted => "RESOURCE_EXHAUSTED",
            Code::FailedPrecondition => "FAILED_PRECONDITION",
            Code::Aborted => "ABORTED",
            Code::OutOfRange => "OUT_OF_RANGE",
            Code::Unimplemented => "UNIMPLEMENTED",
            Code::Internal => "INTERNAL",
            Code::Unavailable => "UNAVAILABLE",
            Code::DataLoss => "DATA_LOSS",
            Code::Unauthenticated => "UNAUTHENTICATED",
        }
    }

    /// The official HTTP error body: compact JSON, `message` omitted when
    /// empty, `/` escaped the way its Gson writer does.
    #[must_use]
    pub fn http_body(&self) -> String {
        let status = self.http_status().as_u16();
        let name = self.status_name();
        if self.message.is_empty() {
            format!("{{\"error\":{{\"code\":{status},\"status\":\"{name}\"}}}}")
        } else {
            let message = serde_json::to_string(&self.message)
                .unwrap_or_default()
                .replace('/', "\\/");
            format!(
                "{{\"error\":{{\"code\":{status},\"message\":{message},\"status\":\"{name}\"}}}}"
            )
        }
    }
}

impl From<PubsubError> for tonic::Status {
    fn from(error: PubsubError) -> Self {
        Self::new(error.code, error.message)
    }
}

impl IntoResponse for PubsubError {
    fn into_response(self) -> Response {
        (
            self.http_status(),
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            self.http_body(),
        )
            .into_response()
    }
}

impl std::fmt::Display for PubsubError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.status_name(), self.message)
    }
}

impl std::error::Error for PubsubError {}
