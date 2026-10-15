//! Cloud Tasks' console routes, under `/api/v1/tasks`: the queues with
//! their figures, configuration and refusals; a queue's live tasks and
//! history; one task's detail with its attempts and retry plan; enqueue
//! (the one console path, held to the wire's 100 KiB); the task and queue
//! controls; bulk run and delete as jobs.
//!
//! A queue is addressed by its opaque engine key (`queue=` in queries,
//! `queue` in bodies) and a task by the console's decimal id, never by
//! name (generated names begin with a slash).

pub(crate) mod convert;
pub(crate) mod errors;
pub(crate) mod filters;
pub(crate) mod jobs;
pub(crate) mod search;
pub(crate) mod topics;
pub(crate) mod types;

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use firenook_tasks_front::inspect::TaskQuery;
use firenook_tasks_front::{ConsoleTask, QueueParts, RowKey, RunNow};
use serde::Deserialize;

use self::errors::{control_error, enqueue_error, task_id, unknown_queue, unknown_task};
use self::filters::{TASK_FIELDS, task_query};
use self::types::{
    TasksEnqueueBody, TasksHistoryRow, TasksHoldBody, TasksOutcome, TasksPurgeBody,
    TasksPurgeResult, TasksQueue, TasksQueueList, TasksQueueRef, TasksRunResult, TasksTaskDetail,
    TasksTaskRef, TasksTaskRow, TasksTaskState,
};
use super::TasksConsole;
use super::shared::{u32_of, u64_of};
use crate::api_error::ApiError;
use crate::jobs::JobRegistry;
use crate::json::{BodyLimit, ConsoleJson};
use crate::late::Late;
use crate::paging::{
    BatchGetItem, BatchGetRequest, BatchGetResponse, DEFAULT_LIMIT, ListMeta, MAX_LIMIT, Page,
    PageBuilder, Total, decode_cursor, page_of,
};

/// The largest body a Tasks route takes (an enqueue is held to 100 KiB as
/// the Admin SDK would send it, which the engine checks itself).
const BODY: usize = 1024 * 1024;

/// What every Tasks route reaches.
#[derive(Clone)]
pub(crate) struct TasksApi {
    pub(crate) late: Late<TasksConsole>,
    pub(crate) jobs: JobRegistry,
    /// The configured project, the default of `?project=`.
    pub(crate) project: Arc<str>,
}

impl TasksApi {
    fn console(&self) -> Result<TasksConsole, ApiError> {
        self.late.get()
    }

    fn project(&self, asked: Option<&str>) -> String {
        asked
            .filter(|project| !project.is_empty())
            .unwrap_or(&self.project)
            .to_owned()
    }
}

/// `/api/v1/tasks/...`.
pub(crate) fn router(api: TasksApi) -> Router {
    Router::new()
        .route("/tasks/queues", get(queues))
        .route("/tasks/queue", get(queue))
        .route("/tasks/tasks", get(tasks).post(enqueue))
        .route("/tasks/tasks/meta", get(tasks_meta))
        .route("/tasks/tasks:batchGet", post(tasks_batch))
        .route("/tasks/tasks:run", post(jobs::run_tasks))
        .route("/tasks/tasks:delete", post(jobs::delete_tasks))
        .route("/tasks/task", get(task).delete(delete_task))
        .route("/tasks/task/run", post(run_task))
        .route("/tasks/task/stop", post(stop_task))
        .route("/tasks/task/enqueue-again", post(enqueue_again))
        .route("/tasks/queue/pause", post(pause_queue))
        .route("/tasks/queue/resume", post(resume_queue))
        .route("/tasks/queue/purge", post(purge_queue))
        .route("/tasks/queue/hold", post(hold_queue))
        .route("/tasks/history", get(history))
        .route("/tasks/history/meta", get(history_meta))
        .route("/tasks/history:batchGet", post(history_batch))
        .layer(Extension(BodyLimit(BODY)))
        .with_state(api)
}

type Answer<T> = Result<Json<T>, ApiError>;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectQuery {
    #[serde(default)]
    project: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueQuery {
    queue: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TasksQuery {
    queue: String,
    #[serde(default)]
    state: Option<TasksTaskState>,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TasksScope {
    queue: String,
    #[serde(default)]
    state: Option<TasksTaskState>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskQueryParams {
    queue: String,
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryQuery {
    queue: String,
    #[serde(default)]
    outcome: Option<TasksOutcome>,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

fn limit_of(limit: Option<u32>) -> usize {
    usize::try_from(limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)).unwrap_or(100)
}

fn cursors<K: serde::de::DeserializeOwned>(
    cursor: Option<&str>,
    before: Option<&str>,
) -> Result<(Option<K>, Option<K>), ApiError> {
    if cursor.is_some() && before.is_some() {
        return Err(ApiError::invalid(
            "A page is read after `cursor` or before `before`, not both.",
        ));
    }
    Ok((
        cursor.map(decode_cursor).transpose()?,
        before.map(decode_cursor).transpose()?,
    ))
}

/// A row key as a cursor carries it.
pub(crate) fn row_key(text: &str) -> Result<RowKey, ApiError> {
    text.parse()
        .map_err(|()| ApiError::invalid(format!("`{text}` is not a task row key.")))
}

fn parts(console: &TasksConsole, key: &str) -> Option<QueueParts> {
    console.runtime.queue_parts(key)
}

fn queue_of(console: &TasksConsole, key: &str) -> Result<TasksQueue, ApiError> {
    console
        .runtime
        .queue_view(key)
        .as_ref()
        .map(convert::queue)
        .ok_or_else(unknown_queue)
}

/// A task's row as it is now (its detail's, pending, slotted or finished).
fn task_row(console: &TasksConsole, key: &str, id: u64) -> Result<TasksTaskRow, ApiError> {
    console
        .runtime
        .task_view(key, id)
        .map(|detail| convert::row(&detail.row))
        .ok_or_else(|| unknown_task(parts(console, key).as_ref()))
}

// ------------------------------------------------------------ queues

async fn queues(
    State(api): State<TasksApi>,
    Query(query): Query<ProjectQuery>,
) -> Answer<TasksQueueList> {
    let console = api.console()?;
    let project = api.project(query.project.as_deref());
    let list = console.runtime.queues_view(Some(&project));
    let items: Vec<TasksQueue> = list.queues.iter().map(convert::queue).collect();
    let count = u64_of(items.len());
    Ok(Json(TasksQueueList {
        page: Page {
            items,
            next_cursor: None,
            prev_cursor: None,
            total: Some(Total { count, exact: true }),
            scanned: None,
        },
        project,
        projects: list.projects,
        rejected_registrations: list.rejected.iter().map(convert::rejected).collect(),
        refused: list.refused.iter().map(convert::refused).collect(),
        revision: list.revision,
    }))
}

async fn queue(State(api): State<TasksApi>, Query(query): Query<QueueQuery>) -> Answer<TasksQueue> {
    let console = api.console()?;
    Ok(Json(queue_of(&console, &query.queue)?))
}

async fn pause_queue(
    State(api): State<TasksApi>,
    ConsoleJson(body): ConsoleJson<TasksQueueRef>,
) -> Answer<TasksQueue> {
    set_paused(&api, &body.queue, true)
}

async fn resume_queue(
    State(api): State<TasksApi>,
    ConsoleJson(body): ConsoleJson<TasksQueueRef>,
) -> Answer<TasksQueue> {
    set_paused(&api, &body.queue, false)
}

fn set_paused(api: &TasksApi, key: &str, paused: bool) -> Answer<TasksQueue> {
    let console = api.console()?;
    console
        .runtime
        .set_paused(key, paused)
        .map_err(|error| control_error(error, parts(&console, key).as_ref()))?;
    Ok(Json(queue_of(&console, key)?))
}

async fn purge_queue(
    State(api): State<TasksApi>,
    ConsoleJson(body): ConsoleJson<TasksPurgeBody>,
) -> Answer<TasksPurgeResult> {
    let console = api.console()?;
    let (removed, stopped) = console
        .runtime
        .purge(&body.queue, body.stop_retrying)
        .map_err(|error| control_error(error, parts(&console, &body.queue).as_ref()))?;
    Ok(Json(TasksPurgeResult { removed, stopped }))
}

async fn hold_queue(
    State(api): State<TasksApi>,
    ConsoleJson(body): ConsoleJson<TasksHoldBody>,
) -> Answer<TasksQueue> {
    let console = api.console()?;
    console
        .runtime
        .set_hold_scheduled(&body.queue, body.enabled)
        .map_err(|error| control_error(error, parts(&console, &body.queue).as_ref()))?;
    Ok(Json(queue_of(&console, &body.queue)?))
}

// ------------------------------------------------------------ tasks

async fn tasks(
    State(api): State<TasksApi>,
    Query(query): Query<TasksQuery>,
) -> Answer<Page<TasksTaskRow>> {
    let console = api.console()?;
    let filter = task_query(query.q.as_deref())?;
    let (after, before) = cursors::<String>(query.cursor.as_deref(), query.before.as_deref())?;
    let after = after.as_deref().map(row_key).transpose()?;
    let before = before.as_deref().map(row_key).transpose()?;
    let limit = limit_of(query.limit);
    let page = console
        .runtime
        .tasks_page(
            &query.queue,
            query.state.map(convert::state_filter),
            &filter,
            after,
            before,
            limit,
        )
        .ok_or_else(unknown_queue)?;
    let total = Some(Total {
        count: u64_of(page.total),
        exact: true,
    });
    let mut builder = PageBuilder::new(limit);
    let mut truncated = false;
    for row in &page.rows {
        if !builder.push(convert::row(row), row.key.to_string()) {
            truncated = true;
            break;
        }
    }
    Ok(Json(builder.finish(
        page.next.is_some() || truncated,
        page.previous.is_some(),
        total,
        None,
    )))
}

async fn tasks_meta() -> Json<ListMeta> {
    Json(ListMeta {
        sortable: Vec::new(),
        default_sort: "slot,id:asc".to_owned(),
        fields: TASK_FIELDS.infos(),
    })
}

async fn tasks_batch(
    State(api): State<TasksApi>,
    Query(scope): Query<TasksScope>,
    ConsoleJson(request): ConsoleJson<BatchGetRequest>,
) -> Answer<BatchGetResponse<TasksTaskRow>> {
    request.check()?;
    let console = api.console()?;
    let filter = task_query(request.q.as_deref())?;
    let (starts, end) = request.window::<String>()?;
    let starts: Vec<Option<RowKey>> = starts
        .iter()
        .map(|start| start.as_deref().map(row_key).transpose())
        .collect::<Result<_, _>>()?;
    let end = end.as_deref().map(row_key).transpose()?;
    let keys: Vec<Option<RowKey>> = request
        .keys
        .iter()
        .map(|key| key.parse::<RowKey>().ok())
        .collect();
    let known: Vec<RowKey> = keys.iter().flatten().copied().collect();
    let mut rows = console.runtime.task_rows(&scope.queue, &known).into_iter();
    let wanted = scope.state.map(convert::state_filter);
    let items = request
        .keys
        .iter()
        .zip(keys)
        .map(|(text, key)| {
            let row = key
                .and_then(|_| rows.next().and_then(|(_, row)| row))
                .filter(|row| wanted.is_none_or(|state| row.state == state))
                .filter(|row| filter_matches(&filter, row));
            BatchGetItem {
                key: text.clone(),
                page: row
                    .as_ref()
                    .and_then(|row| page_of(&row.key, &starts, end.as_ref()))
                    .map(u32_of),
                row: row.as_ref().map(convert::row),
            }
        })
        .collect();
    Ok(Json(BatchGetResponse { items }))
}

fn filter_matches(filter: &TaskQuery, row: &firenook_tasks_front::inspect::TaskRow) -> bool {
    filter.clauses.is_empty() || filter.matches_row(row)
}

async fn task(
    State(api): State<TasksApi>,
    Query(query): Query<TaskQueryParams>,
) -> Answer<TasksTaskDetail> {
    let console = api.console()?;
    let id = task_id(&query.id)?;
    let detail = console
        .runtime
        .task_view(&query.queue, id)
        .ok_or_else(|| unknown_task(parts(&console, &query.queue).as_ref()))?;
    Ok(Json(convert::detail(&detail, console.monitor.as_ref())))
}

async fn enqueue(
    State(api): State<TasksApi>,
    ConsoleJson(body): ConsoleJson<TasksEnqueueBody>,
) -> Result<Response, ApiError> {
    let console = api.console()?;
    let task = ConsoleTask {
        data: body.data.clone(),
        raw_body: body.raw_body.clone(),
        id: body.name.clone().filter(|name| !name.trim().is_empty()),
        headers: body
            .headers
            .iter()
            .map(|header| (header.name.clone(), header.value.clone()))
            .collect(),
        schedule_delay_seconds: body.schedule_delay_seconds,
        dispatch_deadline_seconds: body.dispatch_deadline_seconds,
        url: body.url.clone().filter(|url| !url.trim().is_empty()),
    };
    let enqueued = console
        .enqueue_console(&body.queue, task)
        .map_err(|error| {
            enqueue_error(
                &error,
                parts(&console, &body.queue).as_ref(),
                body.name.as_deref(),
            )
        })?;
    let row = task_row(&console, &enqueued.key, enqueued.id)?;
    Ok((StatusCode::CREATED, Json(row)).into_response())
}

fn run_message(run: RunNow) -> TasksRunResult {
    match run {
        RunNow::Started => TasksRunResult {
            started: true,
            message:
                "It took a free slot and is sent on the next tick, past the queue's rate and pause."
                    .to_owned(),
        },
        RunNow::BackoffSkipped => TasksRunResult {
            started: true,
            message: "Its backoff was skipped: it is sent on the next tick.".to_owned(),
        },
        RunNow::AlreadyStarting => TasksRunResult {
            started: false,
            message: "It already holds a slot and is sent on the next tick.".to_owned(),
        },
    }
}

async fn run_task(
    State(api): State<TasksApi>,
    ConsoleJson(body): ConsoleJson<TasksTaskRef>,
) -> Answer<TasksRunResult> {
    let console = api.console()?;
    let run = console
        .runtime
        .run_now(&body.queue, task_id(&body.id)?)
        .map_err(|error| control_error(error, parts(&console, &body.queue).as_ref()))?;
    Ok(Json(run_message(run)))
}

async fn stop_task(
    State(api): State<TasksApi>,
    ConsoleJson(body): ConsoleJson<TasksTaskRef>,
) -> Answer<TasksTaskRow> {
    let console = api.console()?;
    let id = task_id(&body.id)?;
    console
        .runtime
        .stop_retrying(&body.queue, id)
        .map_err(|error| control_error(error, parts(&console, &body.queue).as_ref()))?;
    Ok(Json(task_row(&console, &body.queue, id)?))
}

async fn enqueue_again(
    State(api): State<TasksApi>,
    ConsoleJson(body): ConsoleJson<TasksTaskRef>,
) -> Result<Response, ApiError> {
    let console = api.console()?;
    let enqueued = console
        .runtime
        .enqueue_again(&body.queue, task_id(&body.id)?)
        .map_err(|error| enqueue_error(&error, parts(&console, &body.queue).as_ref(), None))?;
    let row = task_row(&console, &enqueued.key, enqueued.id)?;
    Ok((StatusCode::CREATED, Json(row)).into_response())
}

async fn delete_task(
    State(api): State<TasksApi>,
    ConsoleJson(body): ConsoleJson<TasksTaskRef>,
) -> Result<StatusCode, ApiError> {
    let console = api.console()?;
    console
        .runtime
        .remove_by_id(&body.queue, task_id(&body.id)?)
        .map_err(|error| control_error(error, parts(&console, &body.queue).as_ref()))?;
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------ history

async fn history(
    State(api): State<TasksApi>,
    Query(query): Query<HistoryQuery>,
) -> Answer<Page<TasksHistoryRow>> {
    let console = api.console()?;
    let filter = task_query(query.q.as_deref())?;
    let (after, before) = cursors::<u64>(query.cursor.as_deref(), query.before.as_deref())?;
    let limit = limit_of(query.limit);
    let page = console
        .runtime
        .history_page(
            &query.queue,
            query.outcome.map(convert::outcome_filter),
            &filter,
            after,
            before,
            limit,
        )
        .ok_or_else(unknown_queue)?;
    let mut builder = PageBuilder::new(limit);
    let mut truncated = false;
    for row in &page.rows {
        if !builder.push(convert::history(row), row.sequence) {
            truncated = true;
            break;
        }
    }
    Ok(Json(builder.finish(
        page.next.is_some() || truncated,
        page.previous.is_some(),
        Some(Total {
            count: u64_of(page.total),
            exact: true,
        }),
        None,
    )))
}

async fn history_meta() -> Json<ListMeta> {
    Json(ListMeta {
        sortable: Vec::new(),
        default_sort: "finishedAt:desc".to_owned(),
        fields: TASK_FIELDS.infos(),
    })
}

async fn history_batch(
    State(api): State<TasksApi>,
    Query(scope): Query<QueueQuery>,
    ConsoleJson(request): ConsoleJson<BatchGetRequest>,
) -> Answer<BatchGetResponse<TasksHistoryRow>> {
    request.check()?;
    let console = api.console()?;
    let filter = task_query(request.q.as_deref())?;
    let (starts, end) = request.window::<u64>()?;
    let sequences: Vec<Option<u64>> = request
        .keys
        .iter()
        .map(|key| key.parse::<u64>().ok())
        .collect();
    let known: Vec<u64> = sequences.iter().flatten().copied().collect();
    let mut rows = console
        .runtime
        .history_rows(&scope.queue, &known)
        .into_iter();
    let items = request
        .keys
        .iter()
        .zip(sequences)
        .map(|(text, sequence)| {
            let row = sequence
                .and_then(|_| rows.next().and_then(|(_, row)| row))
                .filter(|row| filter.clauses.is_empty() || filter.matches_history(row));
            // Newest first: page `i` holds the sequences from its start down.
            let page = row.as_ref().and_then(|row| {
                let index = starts
                    .iter()
                    .rposition(|start| start.is_none_or(|start| start >= row.sequence))?;
                if index + 1 == starts.len() && end.is_some_and(|end| row.sequence < end) {
                    return None;
                }
                Some(u32_of(index))
            });
            BatchGetItem {
                key: text.clone(),
                row: row.as_ref().map(convert::history),
                page,
            }
        })
        .collect();
    Ok(Json(BatchGetResponse { items }))
}

/// Cloud Tasks' TypeScript bindings.
#[cfg(test)]
pub(crate) fn export_bindings(config: &ts_rs::Config) {
    use ts_rs::TS as _;
    macro_rules! export {
        ($($name:ty),* $(,)?) => {
            $( <$name>::export_all(config).expect("TypeScript bindings written"); )*
        };
    }
    export!(
        types::TasksQueueList,
        types::TasksQueue,
        types::TasksTaskRow,
        types::TasksTaskDetail,
        types::TasksHistoryRow,
        types::TasksEnqueueBody,
        types::TasksQueueRef,
        types::TasksTaskRef,
        types::TasksPurgeBody,
        types::TasksHoldBody,
        types::TasksBulkBody,
        types::TasksPurgeResult,
        types::TasksRunResult,
        types::TasksCountersFrame,
        types::TasksQueuesChanged,
        types::TasksStale,
        types::TasksFinishedBatch,
    );
}

#[cfg(test)]
mod tests;
