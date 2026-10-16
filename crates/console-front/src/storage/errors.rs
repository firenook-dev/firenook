//! Storage's errors in the Console API's one shape. Storage adds no error
//! code: a rules refusal is `permission-denied`, a type with no thumbnail
//! is `unsupported-media-type`, a stale metageneration is
//! `failed-precondition`. A console request's refusal carries its
//! explanation beside the error (`decision`, `line`, `noRuleset`,
//! `evaluation`, `request`), so "See why" works after the decision left
//! the engine's window.

use firenook_storage_front::ConsoleError;
use serde_json::{Value, json};

use super::rules::{evaluate_request, evaluate_result};
use crate::api_error::ApiError;

impl From<ConsoleError> for ApiError {
    fn from(error: ConsoleError) -> Self {
        match error {
            ConsoleError::Invalid(message) => Self::invalid(message),
            ConsoleError::NotFound(message) => Self::not_found(message),
            ConsoleError::AlreadyExists(message) => Self::already_exists(message),
            ConsoleError::Conflict(message) => Self::conflict(message),
            ConsoleError::Unsupported(message) => Self::media_type(message),
            ConsoleError::TooLarge(message) => Self::too_large(message),
            ConsoleError::Unavailable(message) => Self::unavailable(message),
            ConsoleError::Internal(message) => Self::internal(message),
            ConsoleError::Precondition { message, current } => Self::precondition(message)
                .with_fix("Load the new version and try again.")
                .with_extra("current", json!(current.to_string())),
            ConsoleError::Denied {
                message,
                fix,
                refusal,
                no_ruleset,
            } => {
                let mut denied = Self::permission_denied(message);
                if let Some(fix) = fix {
                    denied = denied.with_fix(fix);
                }
                let (decision, line, evaluation, request) = refusal.map_or(
                    (Value::Null, Value::Null, Value::Null, Value::Null),
                    |refusal| {
                        (
                            json!(refusal.decision),
                            json!(refusal.line),
                            refusal
                                .evaluation
                                .as_ref()
                                .map(evaluate_result)
                                .map_or(Value::Null, |result| {
                                    serde_json::to_value(result).unwrap_or_default()
                                }),
                            refusal
                                .request
                                .as_ref()
                                .map(evaluate_request)
                                .map_or(Value::Null, |request| {
                                    serde_json::to_value(request).unwrap_or_default()
                                }),
                        )
                    },
                );
                denied
                    .with_extra("decision", decision)
                    .with_extra("line", line)
                    .with_extra("noRuleset", json!(no_ruleset))
                    .with_extra("evaluation", evaluation)
                    .with_extra("request", request)
            }
        }
    }
}
