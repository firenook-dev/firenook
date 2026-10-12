//! Pub/Sub's bulk work on the foundation's job registry: publishing many
//! messages (repeated, on an interval, or again from the history) as
//! `pubsub.publish`, and acknowledging or releasing backlog rows as
//! `pubsub.ack` and `pubsub.release`. Each answers `202` with the job at
//! once; progress rides the `jobs` topic; every job checks `cancelled()`
//! between batches and ends with the suite.

use std::time::{Duration, SystemTime};

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use firenook_pubsub_front::OutgoingMessage;
use firenook_pubsub_front::templates::{self, Draft};
use futures_util::FutureExt as _;
use serde::Deserialize;

use super::errors::pubsub_error;
use super::filters::message_query;
use super::types::{
    PubsubBacklogJobBody, PubsubData, PubsubOutgoingMessage, PubsubPreview, PubsubPublishJobBody,
};
use super::{LARGE_BODY, PubsubApi, backlog_key, draft, preview};
use crate::api_error::ApiError;
use crate::jobs::{BulkTarget, JobHandle, accepted};
use crate::messaging::PubsubConsole;
use crate::messaging::shared::{count_text, counted, u64_of};

/// Messages one broker batch publishes.
const BATCH: usize = 1_000;
/// Messages an `again` target may name or match at most.
const AGAIN_MAX: usize = 100_000;
/// How long a job on an interval sleeps between checks for cancellation.
const CHECK_EVERY: Duration = Duration::from_millis(250);
/// Rows an ack or release job reads per page while it resolves a query.
const PAGE: usize = 500;

/// The intervals a publish job may wait between messages.
const INTERVALS: [u32; 4] = [0, 100, 1_000, 5_000];

/// The bytes a draft sends, estimated before expansion.
fn draft_size(message: &PubsubOutgoingMessage) -> u64 {
    let data = match &message.data {
        PubsubData::Text(text) | PubsubData::Json(text) | PubsubData::AvroJson(text) => text.len(),
        PubsubData::Base64(text) => text.len() / 4 * 3,
    };
    let attributes: usize = message
        .attributes
        .iter()
        .map(|(key, value)| key.len() + value.len())
        .sum();
    u64_of(data + attributes + message.ordering_key.as_ref().map_or(0, String::len))
}

/// `210 MB`, as a size reads in a sentence (powers of 1024).
fn size_text(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    #[allow(
        clippy::cast_precision_loss,
        reason = "a size shown to a person, to one decimal"
    )]
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        let text = format!("{value:.1}");
        format!("{} {}", text.trim_end_matches(".0"), UNITS[unit])
    }
}

fn interval_text(interval_ms: u32) -> &'static str {
    match interval_ms {
        100 => ", ten a second",
        1_000 => ", one a second",
        5_000 => ", one every five seconds",
        _ => "",
    }
}

fn topic_id(topic: &str) -> &str {
    topic.rsplit('/').next().unwrap_or(topic)
}

/// Where an `again` query reads: the list route's own params.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoryScope {
    #[serde(default)]
    topic: Option<String>,
    #[serde(default)]
    expr: Option<String>,
}

/// `POST /pubsub/messages:publish`.
pub(crate) async fn publish_job(
    State(api): State<PubsubApi>,
    crate::json::ConsoleJson(body): crate::json::ConsoleJson<PubsubPublishJobBody>,
) -> Result<Response, ApiError> {
    let console = api.console()?;
    console
        .runtime
        .broker()
        .get_topic(&body.topic)
        .map_err(pubsub_error)?;
    if !INTERVALS.contains(&body.interval_ms) {
        return Err(ApiError::invalid(format!(
            "An interval is 0, 100, 1,000 or 5,000 ms, not {}.",
            body.interval_ms
        )));
    }
    let repeat = body.repeat.unwrap_or(1);
    if !(1..=1_000).contains(&repeat) {
        return Err(ApiError::invalid(format!(
            "A publish repeats each message 1 to 1,000 times, not {repeat}."
        )));
    }
    match (&body.target, body.messages.is_empty()) {
        (Some(target), true) => {
            target.check()?;
            publish_again(&api, console, &body, target)
        }
        (None, false) => publish_new(&api, console, &body, repeat),
        (Some(_), false) => Err(ApiError::invalid(
            "A publish sends new messages or publishes kept ones again, not both.",
        )),
        (None, true) => Err(ApiError::invalid("No messages to publish.")
            .with_fix("Write a message, or pick messages of the topic to publish again.")),
    }
}

fn publish_new(
    api: &PubsubApi,
    console: PubsubConsole,
    body: &PubsubPublishJobBody,
    repeat: u32,
) -> Result<Response, ApiError> {
    let per_round: u64 = body.messages.iter().map(draft_size).sum();
    let size = per_round.saturating_mul(u64::from(repeat));
    if size > u64_of(LARGE_BODY) {
        let repeated = if repeat > 1 {
            format!(
                " after repeating it {} times",
                count_text(u64::from(repeat))
            )
        } else {
            String::new()
        };
        return Err(ApiError::too_large(format!(
            "This publish would be {}{repeated}; the console publishes up to 64 MiB at once.",
            size_text(size)
        ))
        .with_fix("Lower the count, or publish with an interval."));
    }
    if body.dry_run {
        return Ok(Json(preview(
            &console,
            &body.topic,
            &body.messages[0],
            body.template,
        ))
        .into_response());
    }
    let drafts: Vec<Draft> = body.messages.iter().map(draft).collect();
    let schema = console.runtime.broker().topic_schema(&body.topic);
    // Every draft as message 1 to n, before anything is sent: a draft that
    // cannot become a message refuses the publish, not its 500th copy.
    templates::prepare_all(
        &drafts,
        SystemTime::now(),
        body.template,
        schema.as_ref().map(|(schema, _)| schema.as_ref()),
    )
    .map_err(|error| ApiError::invalid(error.to_string()))?;
    let total = u64_of(drafts.len()) * u64::from(repeat);
    let title = format!(
        "Publishing {} to {}{}",
        counted(total, "message", "messages"),
        topic_id(&body.topic),
        interval_text(body.interval_ms)
    );
    let topic = body.topic.clone();
    let template = body.template;
    let interval = Duration::from_millis(u64::from(body.interval_ms));
    let job = api.jobs.start(
        "pubsub",
        "pubsub.publish",
        title,
        Some(total),
        move |handle| {
            async move {
                let schema = console.runtime.broker().topic_schema(&topic);
                let schema = schema.as_ref().map(|(schema, _)| schema.as_ref());
                let mut done = 0_u64;
                let mut batch = Vec::new();
                let mut index = 0_u64;
                for _ in 0..repeat {
                    for draft in &drafts {
                        if handle.cancelled() {
                            return Ok(());
                        }
                        index += 1;
                        let message =
                            templates::prepare(draft, index, SystemTime::now(), template, schema)
                                .map_err(|error| ApiError::invalid(error.to_string()))?;
                        batch.push(message);
                        if interval.is_zero() && batch.len() < BATCH {
                            continue;
                        }
                        done += send(&console, &topic, std::mem::take(&mut batch))?;
                        handle.progress(done);
                        if !interval.is_zero() && index < total && wait(&handle, interval).await {
                            return Ok(());
                        }
                    }
                }
                if !batch.is_empty() {
                    done += send(&console, &topic, batch)?;
                    handle.progress(done);
                }
                Ok(())
            }
            .boxed()
        },
    )?;
    Ok(accepted(job))
}

/// Publishes one batch, counting it.
fn send(
    console: &PubsubConsole,
    topic: &str,
    batch: Vec<OutgoingMessage>,
) -> Result<u64, ApiError> {
    let count = u64_of(batch.len());
    console
        .publish_from_console(topic, batch)
        .map_err(pubsub_error)?;
    Ok(count)
}

/// Sleeps `interval`, checking for cancellation; `true` when cancelled.
async fn wait(handle: &JobHandle, interval: Duration) -> bool {
    let mut left = interval;
    while !left.is_zero() {
        if handle.cancelled() {
            return true;
        }
        let step = left.min(CHECK_EVERY);
        tokio::time::sleep(step).await;
        left -= step;
    }
    handle.cancelled()
}

/// The ids an `again` target names, oldest first.
fn again_ids(
    console: &PubsubConsole,
    topic: &str,
    target: &BulkTarget,
) -> Result<Vec<Result<u64, String>>, ApiError> {
    match target {
        BulkTarget::Keys { keys } => Ok(keys
            .iter()
            .map(|key| key.trim().parse::<u64>().map_err(|_| key.clone()))
            .collect()),
        BulkTarget::Query { q, scope } => {
            let scope: HistoryScope = if scope.is_null() {
                HistoryScope::default()
            } else {
                serde_json::from_value(scope.clone()).map_err(|error| {
                    ApiError::invalid(format!("This query's scope is not valid: {error}."))
                })?
            };
            if scope.topic.as_deref().is_some_and(|scoped| scoped != topic) {
                return Err(ApiError::invalid(
                    "The query's scope names another topic than the publish.",
                ));
            }
            let filter = message_query(Some(q), scope.expr.as_deref())?;
            let broker = console.runtime.broker();
            let mut ids = Vec::new();
            let mut cursor = None;
            while let Some(page) = broker.history_page(topic, &filter, cursor, None, PAGE) {
                ids.extend(page.rows.iter().map(|row| row.message.id));
                if ids.len() > AGAIN_MAX {
                    return Err(ApiError::invalid(format!(
                        "This query matches more than {} messages; narrow it.",
                        count_text(u64_of(AGAIN_MAX))
                    )));
                }
                match page.next_cursor {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
            ids.reverse();
            Ok(ids.into_iter().map(Ok).collect())
        }
    }
}

/// The first kept message of an `again` target, as the publish would send
/// it.
fn again_preview(
    console: &PubsubConsole,
    topic: &str,
    ids: &[Result<u64, String>],
) -> PubsubPreview {
    let broker = console.runtime.broker();
    let first = ids
        .iter()
        .filter_map(|id| id.as_ref().ok())
        .find_map(|id| broker.history_message(topic, *id));
    match first {
        Some(message) => {
            let text = String::from_utf8(message.message.data.clone()).ok();
            PubsubPreview {
                data_base64: text.is_none().then(|| BASE64.encode(&message.message.data)),
                data_text: text,
                attributes: message
                    .message
                    .attributes
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
                ordering_key: (!message.message.ordering_key.is_empty())
                    .then(|| message.message.ordering_key.clone()),
                problem: None,
            }
        }
        None => PubsubPreview {
            data_text: None,
            data_base64: None,
            attributes: std::collections::BTreeMap::new(),
            ordering_key: None,
            problem: Some(
                "None of these messages is kept any more, so there is nothing to publish again."
                    .to_owned(),
            ),
        },
    }
}

fn publish_again(
    api: &PubsubApi,
    console: PubsubConsole,
    body: &PubsubPublishJobBody,
    target: &BulkTarget,
) -> Result<Response, ApiError> {
    let ids = again_ids(&console, &body.topic, target)?;
    if body.dry_run {
        return Ok(Json(again_preview(&console, &body.topic, &ids)).into_response());
    }
    let total = u64_of(ids.len());
    let title = format!(
        "Publishing {} to {} again{}",
        counted(total, "message", "messages"),
        topic_id(&body.topic),
        interval_text(body.interval_ms)
    );
    let topic = body.topic.clone();
    let interval = Duration::from_millis(u64::from(body.interval_ms));
    let job = api.jobs.start(
        "pubsub",
        "pubsub.publish",
        title,
        Some(total),
        move |handle| {
            async move {
                let broker = console.runtime.broker().clone();
                let mut done = 0_u64;
                let mut batch = Vec::new();
                for (position, id) in ids.iter().enumerate() {
                    if handle.cancelled() {
                        return Ok(());
                    }
                    let id = match id {
                        Ok(id) => *id,
                        Err(key) => {
                            handle.failed_item(key, "This is not a message id.");
                            continue;
                        }
                    };
                    let Some(message) = broker.history_message(&topic, id) else {
                        handle.skipped(1);
                        continue;
                    };
                    batch.push(OutgoingMessage {
                        data: message.message.data.clone(),
                        attributes: message
                            .message
                            .attributes
                            .iter()
                            .map(|(key, value)| (key.clone(), value.clone()))
                            .collect(),
                        ordering_key: message.message.ordering_key.clone(),
                    });
                    if interval.is_zero() && batch.len() < BATCH {
                        continue;
                    }
                    done += send(&console, &topic, std::mem::take(&mut batch))?;
                    handle.progress(done);
                    if !interval.is_zero()
                        && position + 1 < ids.len()
                        && wait(&handle, interval).await
                    {
                        return Ok(());
                    }
                }
                if !batch.is_empty() {
                    done += send(&console, &topic, batch)?;
                    handle.progress(done);
                }
                Ok(())
            }
            .boxed()
        },
    )?;
    Ok(accepted(job))
}

// ------------------------------------------------------------ ack and release

/// Where a backlog query reads: the list route's own params.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BacklogScope {
    #[serde(default)]
    subscription: Option<String>,
    #[serde(default)]
    state: Option<super::types::PubsubBacklogState>,
}

#[derive(Clone, Copy)]
enum Verb {
    Ack,
    Release,
}

/// `POST /pubsub/backlog:ack`.
pub(crate) async fn backlog_ack(
    State(api): State<PubsubApi>,
    crate::json::ConsoleJson(body): crate::json::ConsoleJson<PubsubBacklogJobBody>,
) -> Result<Response, ApiError> {
    backlog_job(&api, &body, Verb::Ack)
}

/// `POST /pubsub/backlog:release`.
pub(crate) async fn backlog_release(
    State(api): State<PubsubApi>,
    crate::json::ConsoleJson(body): crate::json::ConsoleJson<PubsubBacklogJobBody>,
) -> Result<Response, ApiError> {
    backlog_job(&api, &body, Verb::Release)
}

/// The message ids a backlog target names: row keys or ids.
fn backlog_ids(
    console: &PubsubConsole,
    subscription: &str,
    target: &BulkTarget,
) -> Result<Vec<Result<u64, String>>, ApiError> {
    match target {
        BulkTarget::Keys { keys } => Ok(keys
            .iter()
            .map(|key| {
                backlog_key(key)
                    .map(|key| key.id)
                    .or_else(|_| key.trim().parse::<u64>())
                    .map_err(|_| key.clone())
            })
            .collect()),
        BulkTarget::Query { q, scope } => {
            if !q.trim().is_empty() {
                return Err(ApiError::invalid(
                    "A backlog has no filter; select rows, or every row in a state.",
                ));
            }
            let scope: BacklogScope = if scope.is_null() {
                BacklogScope::default()
            } else {
                serde_json::from_value(scope.clone()).map_err(|error| {
                    ApiError::invalid(format!("This query's scope is not valid: {error}."))
                })?
            };
            if scope
                .subscription
                .as_deref()
                .is_some_and(|scoped| scoped != subscription)
            {
                return Err(ApiError::invalid(
                    "The query's scope names another subscription than the action.",
                ));
            }
            let state = scope.state.map(super::convert::backlog_filter);
            let broker = console.runtime.broker();
            let mut ids = Vec::new();
            let mut cursor = None;
            while let Some(page) = broker.backlog_page(subscription, state, cursor, None, PAGE) {
                ids.extend(page.rows.iter().map(|row| Ok(row.message.id)));
                match page.next_cursor {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
            Ok(ids)
        }
    }
}

fn backlog_job(
    api: &PubsubApi,
    body: &PubsubBacklogJobBody,
    verb: Verb,
) -> Result<Response, ApiError> {
    let console = api.console()?;
    body.target.check()?;
    console
        .runtime
        .broker()
        .subscription_check(&body.subscription)
        .or_else(|error| {
            if error.status_name() == "NOT_FOUND" {
                Err(error)
            } else {
                Ok(())
            }
        })
        .map_err(pubsub_error)?;
    let ids = backlog_ids(&console, &body.subscription, &body.target)?;
    let total = u64_of(ids.len());
    let subscription = body.subscription.clone();
    let (kind, title) = match verb {
        Verb::Ack => (
            "pubsub.ack",
            format!(
                "Acknowledge {} in {}",
                counted(total, "message", "messages"),
                topic_id(&subscription)
            ),
        ),
        Verb::Release => (
            "pubsub.release",
            format!(
                "Release {} in {}",
                counted(total, "message", "messages"),
                topic_id(&subscription)
            ),
        ),
    };
    let job = api
        .jobs
        .start("pubsub", kind, title, Some(total), move |handle| {
            async move {
                let broker = console.runtime.broker().clone();
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
                            handle.failed_item(key, "This is not a backlog row or a message id.");
                            continue;
                        }
                    };
                    let result = match verb {
                        Verb::Ack => broker.force_ack(&subscription, id),
                        Verb::Release => broker.release(&subscription, id),
                    };
                    if let Err(error) = result {
                        handle.failed_item(&id.to_string(), error.message);
                    }
                }
                handle.progress(u64_of(ids.len()));
                Ok(())
            }
            .boxed()
        })?;
    Ok(accepted(job))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_and_intervals_read_as_sentences() {
        assert_eq!(size_text(512), "512 B");
        assert_eq!(size_text(210 * 1024 * 1024), "210 MB");
        assert_eq!(interval_text(1_000), ", one a second");
        assert_eq!(interval_text(0), "");
        let message = PubsubOutgoingMessage {
            data: PubsubData::Base64("AAAA".to_owned()),
            attributes: [("k".to_owned(), "vv".to_owned())].into(),
            ordering_key: Some("key".to_owned()),
        };
        assert_eq!(draft_size(&message), 3 + 3 + 3);
    }
}
