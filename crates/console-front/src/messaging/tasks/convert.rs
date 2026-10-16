//! The Tasks read models as the console API's types, with each attempt's
//! invocation joined from compute's record.

use firenook_functions_runtime::Monitor;
use firenook_tasks_front::inspect::{
    BodyPreview, ConfigView, FinishedView, HistoryRow, OutcomeCounts, PlannedAttempt,
    QueueCounters, QueueView, RefusedView, TaskDetail, TaskRow, TaskState,
};
use firenook_tasks_front::{AttemptRecord, QueueOrigin, RejectedQueue, TaskOutcome};

use super::types::{
    TasksAttempt, TasksBodyPreview, TasksConfigValue, TasksFinished, TasksHeader, TasksHistoryRow,
    TasksLadderStep, TasksOutcome, TasksOutcomeCounts, TasksPlannedAttempt, TasksQueue,
    TasksQueueConfig, TasksQueueCounters, TasksQueueFunction, TasksQueueOrigin, TasksRefused,
    TasksRejectedQueue, TasksReplaced, TasksTaskDetail, TasksTaskRow, TasksTaskState,
};
use crate::entity::EntityRef;
use crate::messaging::shared::{millis, second_window, stamped_ten_seconds, time, time_of};

pub(crate) fn state(state: TaskState) -> TasksTaskState {
    match state {
        TaskState::Pending => TasksTaskState::Pending,
        TaskState::Held => TasksTaskState::Held,
        TaskState::Dispatching => TasksTaskState::Dispatching,
        TaskState::Running => TasksTaskState::Running,
        TaskState::Backoff => TasksTaskState::Backoff,
        TaskState::Finished => TasksTaskState::Finished,
    }
}

pub(crate) fn state_filter(state: TasksTaskState) -> TaskState {
    match state {
        TasksTaskState::Pending => TaskState::Pending,
        TasksTaskState::Held => TaskState::Held,
        TasksTaskState::Dispatching => TaskState::Dispatching,
        TasksTaskState::Running => TaskState::Running,
        TasksTaskState::Backoff => TaskState::Backoff,
        TasksTaskState::Finished => TaskState::Finished,
    }
}

pub(crate) fn outcome(outcome: TaskOutcome) -> TasksOutcome {
    match outcome {
        TaskOutcome::Succeeded => TasksOutcome::Succeeded,
        TaskOutcome::Failed => TasksOutcome::Failed,
        TaskOutcome::Cancelled => TasksOutcome::Cancelled,
        TaskOutcome::Deleted => TasksOutcome::Deleted,
        TaskOutcome::Purged => TasksOutcome::Purged,
        TaskOutcome::Replaced => TasksOutcome::Replaced,
    }
}

pub(crate) fn outcome_filter(outcome: TasksOutcome) -> TaskOutcome {
    match outcome {
        TasksOutcome::Succeeded => TaskOutcome::Succeeded,
        TasksOutcome::Failed => TaskOutcome::Failed,
        TasksOutcome::Cancelled => TaskOutcome::Cancelled,
        TasksOutcome::Deleted => TaskOutcome::Deleted,
        TasksOutcome::Purged => TaskOutcome::Purged,
        TasksOutcome::Replaced => TaskOutcome::Replaced,
    }
}

fn body(preview: &BodyPreview) -> TasksBodyPreview {
    TasksBodyPreview {
        json: preview.json,
        text: preview.text.clone(),
        truncated: preview.truncated,
        data_member: preview.data_member,
        size: preview.size,
    }
}

fn config(view: &ConfigView) -> TasksQueueConfig {
    TasksQueueConfig {
        max_attempts: view.max_attempts,
        max_retry_seconds: view.max_retry_seconds,
        min_backoff_seconds: view.min_backoff_seconds,
        max_backoff_seconds: view.max_backoff_seconds,
        max_doublings: view.max_doublings,
        max_concurrent_dispatches: view.max_concurrent_dispatches,
        max_dispatches_per_second: view.max_dispatches_per_second,
        values: view
            .values
            .iter()
            .map(|value| TasksConfigValue {
                key: value.key.clone(),
                value: value.value.clone(),
                provided: value.provided,
                unused: value.unused,
            })
            .collect(),
        ladder: view
            .ladder
            .iter()
            .map(|step| TasksLadderStep {
                attempt: step.attempt,
                backoff_seconds: step.backoff_seconds,
                after_seconds: step.after_seconds,
                last: step.last,
            })
            .collect(),
    }
}

fn outcomes(counts: OutcomeCounts) -> TasksOutcomeCounts {
    TasksOutcomeCounts {
        succeeded: counts.succeeded,
        failed: counts.failed,
        cancelled: counts.cancelled,
        deleted: counts.deleted,
        purged: counts.purged,
        replaced: counts.replaced,
    }
}

pub(crate) fn counters(counters: &QueueCounters) -> TasksQueueCounters {
    TasksQueueCounters {
        key: counters.key.clone(),
        pending: counters.pending,
        held: counters.held,
        dispatching: counters.dispatching,
        running: counters.running,
        backoff: counters.backoff,
        slots: counters.slots,
        slots_in_use: counters.slots_in_use,
        tokens: counters.tokens,
        max_tokens: counters.max_tokens,
        refilled_at: time(counters.refilled_at),
        max_dispatches_per_second: counters.max_dispatches_per_second,
        dispatched: second_window(&counters.dispatched),
        failed: stamped_ten_seconds(&counters.failed),
        oldest_pending_at: time_of(counters.oldest_pending_at),
        history: counters.history,
        outcomes: outcomes(counters.outcomes),
    }
}

pub(crate) fn queue(view: &QueueView) -> TasksQueue {
    TasksQueue {
        key: view.key.clone(),
        project: view.parts.project.clone(),
        location: view.parts.location.clone(),
        id: view.parts.queue.clone(),
        origin: match view.origin {
            QueueOrigin::Function => TasksQueueOrigin::Function,
            QueueOrigin::Client => TasksQueueOrigin::Client,
        },
        function: view.function.as_ref().map(|function| TasksQueueFunction {
            function_id: function.function_id.clone(),
            name: function.name.clone(),
            region: function.region.clone(),
            function_ref: EntityRef::function(&function.function_id),
            invocations_ref: EntityRef::invocations(&format!("function:{}", function.function_id)),
        }),
        default_uri: view.default_uri.clone(),
        registered_at: time(view.registered_at),
        registrations: view.registrations,
        last_replaced: view.last_replaced.map(|replaced| TasksReplaced {
            at: time(replaced.at),
            dropped: replaced.dropped,
        }),
        config: config(&view.config),
        paused: view.paused,
        hold_scheduled: view.hold_scheduled,
        counters: counters(&view.counters),
        history_capacity: view.history_capacity,
        history_dropped: view.history_dropped,
    }
}

pub(crate) fn rejected(rejected: &RejectedQueue) -> TasksRejectedQueue {
    TasksRejectedQueue {
        function_id: rejected.function_id.clone(),
        name: rejected.name.clone(),
        region: rejected.region.clone(),
        reason: rejected.reason.clone(),
        at: time(rejected.at),
    }
}

pub(crate) fn refused(view: &RefusedView) -> TasksRefused {
    let refused = &view.refused;
    TasksRefused {
        first_at: time(refused.first_at),
        last_at: time(refused.last_at),
        count: refused.count,
        operation: refused.operation.to_owned(),
        project: refused.queue.project.clone(),
        location: refused.queue.location.clone(),
        queue: refused.queue.queue.clone(),
        status: refused.status,
        error: refused.error.clone(),
        suggestion: view.suggestion.clone(),
    }
}

pub(crate) fn row(row: &TaskRow) -> TasksTaskRow {
    TasksTaskRow {
        key: row.key.to_string(),
        id: row.id.to_string(),
        name: row.name.clone(),
        short_name: row.short_name.clone(),
        generated: row.generated,
        state: state(row.state),
        position: row.position,
        enqueued_at: time(row.enqueued_at),
        origin: row.origin.as_str().to_owned(),
        schedule_time: row.schedule_time.clone(),
        due_at: time_of(row.due_at),
        attempt: row.attempt,
        max_runs: row.max_runs,
        execution_count: row.execution_count,
        previous_response: row.previous_response,
        last_error: row.last_error.clone(),
        last_attempt_at: time_of(row.last_attempt_at),
        next_attempt_at: time_of(row.next_attempt_at),
        deadline_seconds: row.deadline.as_secs_f64(),
        url: row.url.clone(),
        body: body(&row.body),
        stop_requested: row.stop_requested,
    }
}

/// One attempt, with the invocation it caused while compute keeps it.
pub(crate) fn attempt(record: &AttemptRecord, monitor: Option<&Monitor>) -> TasksAttempt {
    TasksAttempt {
        attempt: record.attempt,
        started_at: time(record.started_at),
        duration_ms: millis(record.duration),
        status: record.status,
        error: record.error.clone(),
        response: record.response.clone(),
        counted_execution: record.counted_execution,
        retry_count: record.retry_count,
        invocation: monitor
            .and_then(|monitor| {
                // Compute keys an attempt by the headers it was sent with,
                // whose X-CloudTasks-TaskName is the name's last segment.
                let short = record.task_name.rsplit('/').next().unwrap_or_default();
                monitor.by_task(&record.queue_key, short, record.retry_count)
            })
            .map(|invocation| EntityRef::invocation(&invocation.id)),
    }
}

fn planned(attempt: &PlannedAttempt) -> TasksPlannedAttempt {
    TasksPlannedAttempt {
        attempt: attempt.attempt,
        earliest_at: time(attempt.earliest_at),
        backoff_seconds: attempt.backoff_seconds,
        last: attempt.last,
    }
}

fn finished(view: &FinishedView) -> TasksFinished {
    TasksFinished {
        outcome: outcome(view.outcome),
        at: time(view.at),
        took_ms: millis(view.took),
    }
}

fn headers(headers: &[(String, String)]) -> Vec<TasksHeader> {
    headers
        .iter()
        .map(|(name, value)| TasksHeader {
            name: name.clone(),
            value: value.clone(),
        })
        .collect()
}

pub(crate) fn detail(detail: &TaskDetail, monitor: Option<&Monitor>) -> TasksTaskDetail {
    TasksTaskDetail {
        task: row(&detail.row),
        headers: headers(&detail.headers),
        dispatch_headers: headers(&detail.dispatch_headers),
        body: detail.body.clone(),
        data: detail.data.clone(),
        attempts: detail
            .attempts
            .iter()
            .map(|record| attempt(record, monitor))
            .collect(),
        omitted_attempts: detail.omitted_attempts,
        retry_plan: detail.retry_plan.iter().map(planned).collect(),
        stops: detail.stops.clone(),
        finished: detail.finished.as_ref().map(finished),
    }
}

pub(crate) fn history(row: &HistoryRow) -> TasksHistoryRow {
    TasksHistoryRow {
        id: row.sequence.to_string(),
        task_id: row.id.to_string(),
        name: row.name.clone(),
        short_name: row.short_name.clone(),
        outcome: outcome(row.outcome),
        enqueued_at: time(row.enqueued_at),
        finished_at: time(row.finished_at),
        attempts: row.attempts,
        last_status: row.last_status,
        last_error: row.last_error.clone(),
        took_ms: millis(row.took),
        body: body(&row.body),
    }
}
