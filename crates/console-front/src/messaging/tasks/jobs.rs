//! Cloud Tasks' bulk work on the foundation's job registry: Run now
//! (`tasks.run`) and Delete (`tasks.delete`) over named tasks or every task
//! a filter matches in a queue.

use axum::extract::State;
use axum::response::Response;
use firenook_tasks_front::{ControlError, RowKey};
use futures_util::FutureExt as _;
use serde::Deserialize;

use super::errors::{control_error, unknown_queue};
use super::filters::task_query;
use super::types::{TasksBulkBody, TasksTaskState};
use super::{TasksApi, convert};
use crate::api_error::ApiError;
use crate::jobs::{BulkTarget, accepted};
use crate::json::ConsoleJson;
use crate::messaging::TasksConsole;
use crate::messaging::shared::{counted, u64_of};

/// Rows a job reads per page while it resolves a query.
const PAGE: usize = 500;

#[derive(Clone, Copy)]
enum Verb {
    Run,
    Delete,
}

/// Where a task query reads: the list route's own params.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TasksScope {
    #[serde(default)]
    queue: Option<String>,
    #[serde(default)]
    state: Option<TasksTaskState>,
}

/// `POST /tasks/tasks:run`.
pub(crate) async fn run_tasks(
    State(api): State<TasksApi>,
    ConsoleJson(body): ConsoleJson<TasksBulkBody>,
) -> Result<Response, ApiError> {
    bulk(&api, &body, Verb::Run)
}

/// `POST /tasks/tasks:delete`.
pub(crate) async fn delete_tasks(
    State(api): State<TasksApi>,
    ConsoleJson(body): ConsoleJson<TasksBulkBody>,
) -> Result<Response, ApiError> {
    bulk(&api, &body, Verb::Delete)
}

/// The task ids a target names: row keys or ids, or every task a query
/// matches.
fn task_ids(
    console: &TasksConsole,
    queue: &str,
    target: &BulkTarget,
) -> Result<Vec<Result<u64, String>>, ApiError> {
    match target {
        BulkTarget::Keys { keys } => Ok(keys
            .iter()
            .map(|key| {
                key.parse::<RowKey>()
                    .map(|key| key.id)
                    .or_else(|()| key.trim().parse::<u64>().map_err(|_| ()))
                    .map_err(|()| key.clone())
            })
            .collect()),
        BulkTarget::Query { q, scope } => {
            let scope: TasksScope = if scope.is_null() {
                TasksScope::default()
            } else {
                serde_json::from_value(scope.clone()).map_err(|error| {
                    ApiError::invalid(format!("This query's scope is not valid: {error}."))
                })?
            };
            if scope.queue.as_deref().is_some_and(|scoped| scoped != queue) {
                return Err(ApiError::invalid(
                    "The query's scope names another queue than the action.",
                ));
            }
            let filter = task_query(Some(q))?;
            let state = scope.state.map(convert::state_filter);
            let mut ids = Vec::new();
            let mut after = None;
            loop {
                let page = console
                    .runtime
                    .tasks_page(queue, state, &filter, after, None, PAGE)
                    .ok_or_else(unknown_queue)?;
                ids.extend(page.rows.iter().map(|row| Ok(row.id)));
                match page.next {
                    Some(next) => after = Some(next),
                    None => break,
                }
            }
            Ok(ids)
        }
    }
}

fn bulk(api: &TasksApi, body: &TasksBulkBody, verb: Verb) -> Result<Response, ApiError> {
    let console = api.console()?;
    body.target.check()?;
    let parts = console
        .runtime
        .queue_parts(&body.queue)
        .ok_or_else(unknown_queue)?;
    let ids = task_ids(&console, &body.queue, &body.target)?;
    let total = u64_of(ids.len());
    let tasks = counted(total, "task", "tasks");
    let (kind, title) = match verb {
        Verb::Run => ("tasks.run", format!("Run {tasks} of {} now", parts.queue)),
        Verb::Delete => ("tasks.delete", format!("Delete {tasks} of {}", parts.queue)),
    };
    let queue = body.queue.clone();
    let job = api
        .jobs
        .start("tasks", kind, title, Some(total), move |handle| {
            async move {
                for (done, id) in ids.iter().enumerate() {
                    if done % PAGE == 0 {
                        if handle.cancelled() {
                            return Ok(());
                        }
                        handle.progress(u64_of(done));
                        tokio::task::yield_now().await;
                    }
                    let id = match id {
                        Ok(id) => *id,
                        Err(key) => {
                            handle.failed_item(key, "This is not a task row or a task id.");
                            continue;
                        }
                    };
                    let result = match verb {
                        Verb::Run => console.runtime.run_now(&queue, id).map(|_| ()),
                        Verb::Delete => console.runtime.remove_by_id(&queue, id),
                    };
                    match result {
                        Ok(()) => {}
                        // A task that finished meanwhile needs nothing more.
                        Err(ControlError::UnknownTask) => handle.skipped(1),
                        Err(error) => handle.failed_item(
                            &id.to_string(),
                            control_error(error, Some(&parts)).detail().message.clone(),
                        ),
                    }
                }
                handle.progress(u64_of(ids.len()));
                Ok(())
            }
            .boxed()
        })?;
    Ok(accepted(job))
}
