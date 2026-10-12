//! Cloud Tasks refusals as the console answers them, each with what to do.

use firenook_tasks_front::{ControlError, EnqueueError, QueueParts};

use crate::api_error::ApiError;

/// A queue named by its parts, for a sentence ("processOrder in
/// us-central1"), or "this queue" when the key names none.
fn named(parts: Option<&QueueParts>) -> String {
    parts.map_or_else(|| "this queue".to_owned(), |parts| parts.queue.clone())
}

/// No queue under the key.
pub(crate) fn unknown_queue() -> ApiError {
    ApiError::not_found("No queue is registered under this key.").with_fix(
        "Pick a queue from the list: queues register from onTaskDispatched exports or a client's POST …/queues/{queue}.",
    )
}

/// An enqueue's refusal.
pub(crate) fn enqueue_error(
    error: &EnqueueError,
    parts: Option<&QueueParts>,
    name: Option<&str>,
) -> ApiError {
    match error {
        EnqueueError::UnknownQueue => unknown_queue(),
        EnqueueError::NameReserved => ApiError::conflict(format!(
            "A task named {} was enqueued before in this run.",
            name.unwrap_or("this")
        ))
        .with_fix(
            "The emulator keeps every task name until it stops. Leave the id empty or pick another.",
        ),
        EnqueueError::QueueFull { capacity } => ApiError::conflict(format!(
            "{} holds {} pending tasks, the emulator's capacity.",
            named(parts),
            crate::messaging::shared::count_text(u64::try_from(*capacity).unwrap_or(0))
        ))
        .with_fix("Purge it or let it drain."),
        EnqueueError::TooLarge { .. } => ApiError::too_large(error.to_string())
            .with_fix("Send less data: the Admin SDK would be refused the same task."),
        EnqueueError::Invalid(reason) => ApiError::invalid(reason.clone()),
        EnqueueError::UnknownTask => unknown_task(parts),
    }
}

/// No task of the queue has the id.
pub(crate) fn unknown_task(parts: Option<&QueueParts>) -> ApiError {
    ApiError::not_found(format!("No task of {} has this id.", named(parts)))
        .with_fix("It may have finished: look in History.")
}

/// A console control's refusal.
pub(crate) fn control_error(error: ControlError, parts: Option<&QueueParts>) -> ApiError {
    match error {
        ControlError::UnknownQueue => unknown_queue(),
        ControlError::UnknownTask => unknown_task(parts),
        ControlError::Busy => {
            ApiError::conflict(format!("Every dispatch slot of {} is busy.", named(parts)))
                .with_fix("Wait for a running task to finish, or raise maxConcurrentDispatches.")
        }
        ControlError::Running => ApiError::conflict("The task's request is in flight.")
            .with_fix("Wait for the attempt to finish; Stop retrying applies after it."),
        ControlError::NotInSlot => ApiError::precondition(error.to_string())
            .with_fix("Delete it instead: a pending task has made no attempt yet."),
    }
}

/// A task id as the URL carries it.
pub(crate) fn task_id(text: &str) -> Result<u64, ApiError> {
    text.trim()
        .parse()
        .map_err(|_| ApiError::invalid(format!("`{text}` is not a task id; ids are numbers.")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusals_say_what_to_do() {
        let parts = QueueParts {
            project: "demo".to_owned(),
            location: "us-central1".to_owned(),
            queue: "processOrder".to_owned(),
        };
        let reserved = enqueue_error(&EnqueueError::NameReserved, Some(&parts), Some("order-1"));
        assert_eq!(reserved.status(), axum::http::StatusCode::CONFLICT);
        assert_eq!(
            reserved.detail().message,
            "A task named order-1 was enqueued before in this run."
        );
        let full = enqueue_error(
            &EnqueueError::QueueFull { capacity: 10_000 },
            Some(&parts),
            None,
        );
        assert_eq!(
            full.detail().message,
            "processOrder holds 10,000 pending tasks, the emulator's capacity."
        );
        let busy = control_error(ControlError::Busy, Some(&parts));
        assert_eq!(
            busy.detail().message,
            "Every dispatch slot of processOrder is busy."
        );
        let large = enqueue_error(
            &EnqueueError::TooLarge {
                size: 101 * 1024,
                limit: 100 * 1024,
            },
            Some(&parts),
            None,
        );
        assert_eq!(large.status(), axum::http::StatusCode::PAYLOAD_TOO_LARGE);
    }
}
