//! Pub/Sub engine errors as the console answers them: the engine's own
//! words stay the message, the console adds the fix, and the gRPC code name
//! rides beside `error` as `grpcCode` (for tests and tools; nothing in the
//! UI branches on it).

use firenook_pubsub_front::{PubsubError, RedeliverError, RunScheduleError};
use serde_json::json;

use crate::api_error::ApiError;

/// The fix for an id the engine refused.
const ID_FIX: &str = "Ids start with a letter and use 3–255 of A–Z a–z 0–9 - _ . ~ + %, and may not start with goog.";
/// The fix for a message a topic's schema refused.
const SCHEMA_FIX: &str =
    "The data does not match the topic's schema. Check it in the composer, which names the field.";
/// The fix for a resource that does not exist.
const MISSING_FIX: &str =
    "Create the topic, or check the project id: topics under other projects are listed separately.";
/// The fix for a subscription that does not exist.
const MISSING_SUBSCRIPTION_FIX: &str = "Create the subscription, or check the project id: subscriptions under other projects are listed separately.";

/// An engine error with its code mapped to the console's and its fix.
pub(crate) fn pubsub_error(error: PubsubError) -> ApiError {
    let code = error.status_name();
    let PubsubError { message, .. } = error;
    let mapped = match code {
        "NOT_FOUND" => {
            let fix = if message.starts_with("Subscription") {
                MISSING_SUBSCRIPTION_FIX
            } else if message.starts_with("Topic") {
                MISSING_FIX
            } else {
                "Check the name: it is not in this emulator."
            };
            ApiError::not_found(message).with_fix(fix)
        }
        "ALREADY_EXISTS" => ApiError::already_exists(message),
        "INVALID_ARGUMENT" | "OUT_OF_RANGE" => {
            let error = ApiError::invalid(message.clone());
            if message.starts_with("Invalid [") {
                error.with_fix(ID_FIX)
            } else if message == "Could not parse message" {
                error.with_fix(SCHEMA_FIX)
            } else if message.is_empty() {
                // The exactly-once stale acknowledgement answers with no
                // message at all.
                ApiError::invalid(
                    "The acknowledgement was refused (INVALID_ARGUMENT with no message).",
                )
                .with_fix(
                    "The lease had expired or the message was already acknowledged, so another delivery may hold it.",
                )
            } else {
                error
            }
        }
        "FAILED_PRECONDITION" => ApiError::precondition(message),
        "UNIMPLEMENTED" => ApiError::invalid(message)
            .with_fix("The emulator does not implement this (the official one does not either)."),
        "UNKNOWN" if message == "Application error processing RPC" => ApiError::invalid(message)
            .with_fix("The filter did not parse. Check it in the filter field, which shows where."),
        "RESOURCE_EXHAUSTED" => ApiError::exhausted(message),
        "UNAVAILABLE" => ApiError::unavailable(message),
        _ => ApiError::internal(message),
    };
    mapped.with_extra("grpcCode", json!(code))
}

/// What the routes that need Functions answer when the suite has none.
pub(crate) fn functions_absent() -> ApiError {
    ApiError::unavailable(
        "Functions is not running in this engine, so there are no deliveries to functions.",
    )
    .with_fix(
        "Add a Functions codebase to firebase.json, or start the engine with functions in --only.",
    )
}

/// A console redelivery's refusal.
pub(crate) fn redeliver_error(error: &RedeliverError) -> ApiError {
    match error {
        RedeliverError::MessageNotKept => ApiError::not_found(error.to_string()).with_fix(
            "Publish it again from the message's menu, which copies its data and attributes.",
        ),
        RedeliverError::NotATarget => ApiError::invalid(error.to_string())
            .with_fix("Pick one of the functions listed on the topic."),
        RedeliverError::BackgroundPaused => {
            ApiError::conflict(error.to_string()).with_fix("Resume background triggers.")
        }
        RedeliverError::Stopped => ApiError::unavailable(error.to_string()),
    }
}

/// A schedule control's refusal.
pub(crate) fn schedule_error(error: &RunScheduleError) -> ApiError {
    match error {
        RunScheduleError::NotScheduled => ApiError::not_found(error.to_string())
            .with_fix("The function may have been removed by a reload; refresh the list."),
        RunScheduleError::BackgroundPaused => {
            ApiError::conflict(error.to_string()).with_fix("Resume background triggers.")
        }
        RunScheduleError::Publish(_) => ApiError::precondition(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_words_stay_and_gain_a_fix() {
        let error = pubsub_error(PubsubError::invalid_name("topics", "projects/p/topics/1x"));
        assert_eq!(error.status(), axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(
            error.detail().message,
            "Invalid [topics] name: (name=projects/p/topics/1x)"
        );
        assert_eq!(error.detail().fix.as_deref(), Some(ID_FIX));
        let missing = pubsub_error(PubsubError::not_found("Topic not found"));
        assert_eq!(missing.status(), axum::http::StatusCode::NOT_FOUND);
        assert_eq!(missing.detail().fix.as_deref(), Some(MISSING_FIX));
        let stale = pubsub_error(PubsubError::invalid_argument(""));
        assert!(stale.detail().message.contains("INVALID_ARGUMENT"));
        let precondition = pubsub_error(PubsubError::failed_precondition(
            "Subscription is detached.",
        ));
        assert_eq!(
            precondition.status(),
            axum::http::StatusCode::PRECONDITION_FAILED
        );
        let filter = pubsub_error(PubsubError::application_error());
        assert_eq!(filter.status(), axum::http::StatusCode::BAD_REQUEST);
        let conflict = schedule_error(&RunScheduleError::BackgroundPaused);
        assert_eq!(conflict.status(), axum::http::StatusCode::CONFLICT);
        assert_eq!(
            conflict.detail().message,
            "Background triggers are paused, so the tick was not published."
        );
    }
}
