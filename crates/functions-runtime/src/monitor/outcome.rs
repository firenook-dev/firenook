//! How an answered invocation ended, read from what the worker answered.
//!
//! Pure and cheap: only callables and blocking functions look at the kept
//! response, and only at its first 4 KiB (a JSON error body) or its last
//! 4 KiB (a streaming callable's final frame). Every other answer is its
//! status. The runtime's own endings (a timeout, a crash, a worker that did
//! not start, a paused or removed function, a handler that threw) are named
//! by the dispatch path and never classified here.

use serde_json::Value;

use super::types::{FunctionKind, InvocationOutcome};

/// The most of the kept response [`classify_outcome`] reads at either end.
pub const OUTCOME_HEAD_BYTES: usize = 4 * 1024;

/// An outcome and, for a callable or a blocking function that refused, the
/// error's status word (`INVALID_ARGUMENT`, `PERMISSION_DENIED`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Classified {
    pub outcome: InvocationOutcome,
    pub callable_status: Option<String>,
}

/// Classifies an answered invocation: a callable answering 400 or more, or a
/// streaming callable whose last event is an `error`, is a `CallableError`;
/// a blocking function answering an `error` body is `Blocked` (it did its
/// job) and any other 2xx `Allowed`; otherwise 2xx (and 1xx, 3xx) is
/// `Succeeded`, 4xx `ClientError` and 5xx `Failed`.
#[must_use]
pub fn classify_outcome(
    kind: FunctionKind,
    status: u16,
    content_type: Option<&str>,
    kept: &[u8],
) -> Classified {
    let by_status = || match status {
        400..=499 => InvocationOutcome::ClientError,
        500.. => InvocationOutcome::Failed,
        _ => InvocationOutcome::Succeeded,
    };
    match kind {
        FunctionKind::Callable => {
            let streaming = content_type.is_some_and(|value| value.contains("text/event-stream"));
            if streaming {
                if let Some(status_word) = last_event_error(kept) {
                    return Classified {
                        outcome: InvocationOutcome::CallableError,
                        callable_status: Some(status_word),
                    };
                }
            } else if status >= 400 {
                return Classified {
                    outcome: InvocationOutcome::CallableError,
                    callable_status: json_error_status(head(kept)),
                };
            }
            Classified {
                outcome: by_status(),
                callable_status: None,
            }
        }
        FunctionKind::Blocking => {
            if status < 500
                && let Some(error) = json_error(head(kept))
            {
                return Classified {
                    outcome: InvocationOutcome::Blocked,
                    callable_status: error.status,
                };
            }
            Classified {
                outcome: if (200..300).contains(&status) {
                    InvocationOutcome::Allowed
                } else {
                    by_status()
                },
                callable_status: None,
            }
        }
        _ => Classified {
            outcome: by_status(),
            callable_status: None,
        },
    }
}

fn head(kept: &[u8]) -> &[u8] {
    &kept[..kept.len().min(OUTCOME_HEAD_BYTES)]
}

fn tail(kept: &[u8]) -> &[u8] {
    &kept[kept.len().saturating_sub(OUTCOME_HEAD_BYTES)..]
}

/// A JSON error body: `{"error": {"status": …, "message": …}}`.
struct ErrorBody {
    status: Option<String>,
}

/// The error a body holds, when it is a JSON object with an `error` object.
fn json_error(bytes: &[u8]) -> Option<ErrorBody> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let error = value.get("error")?;
    if !error.is_object() {
        return None;
    }
    Some(ErrorBody {
        status: error
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn json_error_status(bytes: &[u8]) -> Option<String> {
    json_error(bytes).and_then(|error| error.status)
}

/// The `error.status` of a streaming callable's last `data:` event, when
/// that event is an error. A callable stream ends with one `data:` event
/// holding `{"result": …}` or `{"error": …}`.
fn last_event_error(kept: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(tail(kept));
    let data = text
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix("data:"))?;
    json_error(data.trim().as_bytes())
        .map(|error| error.status.unwrap_or_else(|| "UNKNOWN".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(
        kind: FunctionKind,
        status: u16,
        content_type: Option<&str>,
        body: &str,
    ) -> Classified {
        classify_outcome(kind, status, content_type, body.as_bytes())
    }

    #[test]
    fn plain_answers_follow_their_status() {
        for (status, expected) in [
            (200, InvocationOutcome::Succeeded),
            (204, InvocationOutcome::Succeeded),
            (302, InvocationOutcome::Succeeded),
            (400, InvocationOutcome::ClientError),
            (404, InvocationOutcome::ClientError),
            (500, InvocationOutcome::Failed),
            (503, InvocationOutcome::Failed),
        ] {
            assert_eq!(
                outcome(FunctionKind::Http, status, None, "").outcome,
                expected,
                "{status}"
            );
        }
        assert_eq!(
            outcome(
                FunctionKind::Firestore,
                200,
                None,
                "{\"status\":\"acknowledged\"}"
            )
            .outcome,
            InvocationOutcome::Succeeded
        );
    }

    #[test]
    fn a_callable_error_body_names_its_status() {
        let error = outcome(
            FunctionKind::Callable,
            400,
            Some("application/json; charset=utf-8"),
            r#"{"error":{"message":"bad","status":"INVALID_ARGUMENT"}}"#,
        );
        assert_eq!(error.outcome, InvocationOutcome::CallableError);
        assert_eq!(error.callable_status.as_deref(), Some("INVALID_ARGUMENT"));
        let unreadable = outcome(FunctionKind::Callable, 500, None, "Internal");
        assert_eq!(unreadable.outcome, InvocationOutcome::CallableError);
        assert_eq!(unreadable.callable_status, None);
        let ok = outcome(FunctionKind::Callable, 200, None, r#"{"result":1}"#);
        assert_eq!(ok.outcome, InvocationOutcome::Succeeded);
    }

    #[test]
    fn a_streaming_callable_ends_with_its_last_event() {
        let failed = outcome(
            FunctionKind::Callable,
            200,
            Some("text/event-stream"),
            "data: {\"message\":\"chunk\"}\n\ndata: {\"error\":{\"status\":\"INTERNAL\",\"message\":\"x\"}}\n\n",
        );
        assert_eq!(failed.outcome, InvocationOutcome::CallableError);
        assert_eq!(failed.callable_status.as_deref(), Some("INTERNAL"));
        let fine = outcome(
            FunctionKind::Callable,
            200,
            Some("text/event-stream"),
            "data: {\"message\":\"chunk\"}\n\ndata: {\"result\":\"done\"}\n\n",
        );
        assert_eq!(fine.outcome, InvocationOutcome::Succeeded);
        // Only the end of a long stream is read.
        let long = format!(
            "{}data: {{\"error\":{{\"status\":\"ABORTED\"}}}}\n\n",
            "data: {\"message\":\"x\"}\n\n".repeat(2_000)
        );
        let late = outcome(
            FunctionKind::Callable,
            200,
            Some("text/event-stream"),
            &long,
        );
        assert_eq!(late.callable_status.as_deref(), Some("ABORTED"));
    }

    #[test]
    fn blocking_functions_allow_or_block() {
        let allowed = outcome(FunctionKind::Blocking, 200, None, r#"{"userRecord":{}}"#);
        assert_eq!(allowed.outcome, InvocationOutcome::Allowed);
        let blocked = outcome(
            FunctionKind::Blocking,
            400,
            None,
            r#"{"error":{"status":"PERMISSION_DENIED","message":"no"}}"#,
        );
        assert_eq!(blocked.outcome, InvocationOutcome::Blocked);
        assert_eq!(
            blocked.callable_status.as_deref(),
            Some("PERMISSION_DENIED")
        );
        let crashed = outcome(FunctionKind::Blocking, 500, None, "boom");
        assert_eq!(crashed.outcome, InvocationOutcome::Failed);
        let refused = outcome(FunctionKind::Blocking, 403, None, "nope");
        assert_eq!(refused.outcome, InvocationOutcome::ClientError);
    }
}
