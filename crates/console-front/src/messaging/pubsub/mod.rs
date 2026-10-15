//! Pub/Sub's console routes, under `/api/v1/pubsub`: the topics index and
//! details, a topic's history, publishing (at once and as jobs), message
//! actions, subscriptions with pull, ack and seek, backlogs, deliveries to
//! functions, snapshots, schemas and their checks, filter checks, schedules,
//! the setup export and import.
//!
//! Resource names travel whole (`projects/p/topics/t`) in query strings and
//! JSON bodies, never as path segments. Every handler first resolves the
//! late runtime (`503 starting` until Pub/Sub is up). Lists answer a
//! `Page`; the bounded ones (topics, snapshots, schemas, schedules,
//! refusals) are one page holding every item. Bodies are read with
//! [`ConsoleJson`]: 64 MiB on the publish, schema and import routes (the
//! Pub/Sub port's own limit), 1 MiB everywhere else.

pub(crate) mod convert;
pub(crate) mod errors;
pub(crate) mod filters;
pub(crate) mod jobs;
pub(crate) mod search;
pub(crate) mod setup;
pub(crate) mod topics;
pub(crate) mod types;

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use firenook_pubsub_front::broker::inspect::{BacklogCursor, MessageQuery};
use firenook_pubsub_front::broker::{BacklogKey, StoredMessage};
use firenook_pubsub_front::functions::topic_resource;
use firenook_pubsub_front::google::pubsub::v1::{
    DeadLetterPolicy, Encoding, ExpirationPolicy, PushConfig, RetryPolicy, SchemaSettings,
    Subscription, Topic,
};
use firenook_pubsub_front::pbjson_types;
use firenook_pubsub_front::templates::{self, Draft, DraftData};
use firenook_pubsub_front::{PubsubError, ScheduleControl as _, avro, names};
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use self::convert::{Join, Targets};
use self::errors::{functions_absent, pubsub_error, redeliver_error, schedule_error};
use self::filters::message_query;
use self::types::{
    PubsubBacklogRow, PubsubBacklogState, PubsubCommitSchemaBody, PubsubCreateSchemaBody,
    PubsubCreateSnapshotBody, PubsubCreateSubscriptionBody, PubsubCreateTopicBody, PubsubData,
    PubsubDeleteRevisionBody, PubsubDeleteSubscriptions, PubsubDeleteTopicBody,
    PubsubDeliveryCounts, PubsubDeliveryPage, PubsubDeliveryRow, PubsubDispatchBody,
    PubsubFilterCheck, PubsubFilterCheckBody, PubsubFunctionMark, PubsubMessageActionBody,
    PubsubMessageCheck, PubsubMessageCheckBody, PubsubMessageDetail, PubsubMessageRow,
    PubsubNameBody, PubsubOutgoingMessage, PubsubPreview, PubsubPublishBody, PubsubPublishResult,
    PubsubPushConfigBody, PubsubRedeliverBody, PubsubRedelivery, PubsubRejectedList,
    PubsubRollbackSchemaBody, PubsubSchedule, PubsubScheduleBody, PubsubScheduleRun,
    PubsubSchemaBinding, PubsubSchemaCheck, PubsubSchemaCheckBody, PubsubSchemaDetail,
    PubsubSchemaExample, PubsubSchemaExampleBody, PubsubSchemaProblem, PubsubSchemaSummary,
    PubsubSeekBody, PubsubSeekResult, PubsubSnapshot, PubsubSubscriptionDetail,
    PubsubSubscriptionSummary, PubsubTopicDetail, PubsubTopicIndex, PubsubTopicSummary,
    PubsubUpdateSubscriptionBody, PubsubUpdateTopicBody,
};
use super::PubsubConsole;
use super::shared::{time, u32_of, u64_of};
use crate::api_error::ApiError;
use crate::blocking::blocking;
use crate::http::attachment;
use crate::jobs::JobRegistry;
use crate::json::{BodyLimit, ConsoleJson};
use crate::late::Late;
use crate::paging::{
    BatchGetItem, BatchGetRequest, BatchGetResponse, DEFAULT_LIMIT, MAX_LIMIT, Page, PageBuilder,
    Total, decode_cursor, encode_cursor, page_of,
};
use crate::sse::Shutdown;

/// The largest body the publish, schema and import routes take.
pub(crate) const LARGE_BODY: usize = 64 * 1024 * 1024;
/// The largest body every other route takes.
pub(crate) const BODY: usize = 1024 * 1024;
/// Messages one `/topic/publish` request sends at most.
const PUBLISH_MAX: usize = 1_000;
/// Messages a filter check matches against.
const FILTER_CHECK: usize = 5_000;
/// Matching ids a filter check returns.
const FILTER_SAMPLES: usize = 10;
/// A dispatch body shown at most.
const DISPATCH_BYTES: usize = 256 * 1024;
/// Push streaks a message detail lists.
const MESSAGE_STREAKS: usize = 20;

/// What every Pub/Sub route reaches.
#[derive(Clone)]
pub(crate) struct PubsubApi {
    pub(crate) late: Late<PubsubConsole>,
    pub(crate) jobs: JobRegistry,
    /// The configured project, the default of every `?project=`.
    pub(crate) project: Arc<str>,
    pub(crate) shutdown: Shutdown,
}

impl PubsubApi {
    fn console(&self) -> Result<PubsubConsole, ApiError> {
        self.late.get()
    }

    fn project(&self, asked: Option<&str>) -> String {
        asked
            .filter(|project| !project.is_empty())
            .unwrap_or(&self.project)
            .to_owned()
    }
}

/// `/api/v1/pubsub/...`.
pub(crate) fn router(api: PubsubApi) -> Router {
    let large = Router::new()
        .route("/pubsub/topic/publish", post(publish))
        .route("/pubsub/messages:publish", post(jobs::publish_job))
        .route("/pubsub/schemas", get(list_schemas).post(create_schema))
        .route("/pubsub/schema/commit", post(commit_schema))
        .route("/pubsub/schema/check", post(check_schema))
        .route("/pubsub/schema/validate-message", post(validate_message))
        .route("/pubsub/schema/example", post(example_schema))
        .route("/pubsub/setup/import", post(setup::import))
        .layer(Extension(BodyLimit(LARGE_BODY)));
    let small = Router::new()
        .route("/pubsub/topics", get(topics_index).post(create_topic))
        .route(
            "/pubsub/topic",
            get(topic_detail).patch(update_topic).delete(delete_topic),
        )
        .route("/pubsub/messages", get(messages))
        .route("/pubsub/messages:batchGet", post(messages_batch))
        .route("/pubsub/messages:export", get(export_messages))
        .route("/pubsub/message", get(message_detail))
        .route("/pubsub/message/ack", post(message_ack))
        .route("/pubsub/message/release", post(message_release))
        .route("/pubsub/message/redeliver", post(redeliver))
        .route("/pubsub/dispatch", get(dispatch))
        .route("/pubsub/rejected", get(rejected))
        .route("/pubsub/subscriptions", post(create_subscription))
        .route(
            "/pubsub/subscription",
            get(subscription_detail)
                .patch(update_subscription)
                .delete(delete_subscription),
        )
        .route("/pubsub/subscription/push-config", post(push_config))
        .route("/pubsub/subscription/seek", post(seek))
        .route("/pubsub/backlog", get(backlog))
        .route("/pubsub/backlog:batchGet", post(backlog_batch))
        .route("/pubsub/backlog:ack", post(jobs::backlog_ack))
        .route("/pubsub/backlog:release", post(jobs::backlog_release))
        .route("/pubsub/deliveries", get(deliveries))
        .route("/pubsub/deliveries:batchGet", post(deliveries_batch))
        .route("/pubsub/snapshots", get(snapshots).post(create_snapshot))
        .route("/pubsub/snapshot", axum::routing::delete(delete_snapshot))
        .route("/pubsub/schema", get(schema_detail).delete(delete_schema))
        .route("/pubsub/schema/rollback", post(rollback_schema))
        .route(
            "/pubsub/schema/revision",
            axum::routing::delete(delete_revision),
        )
        .route("/pubsub/filter/check", post(check_filter))
        .route("/pubsub/schedules", get(schedules))
        .route("/pubsub/schedule/run", post(run_schedule))
        .route("/pubsub/schedule/pause", post(pause_schedule))
        .route("/pubsub/schedule/resume", post(resume_schedule))
        .route("/pubsub/setup", get(setup::export))
        .layer(Extension(BodyLimit(BODY)));
    large.merge(small).with_state(api)
}

type Answer<T> = Result<Json<T>, ApiError>;

// ------------------------------------------------------------ queries

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectQuery {
    #[serde(default)]
    project: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NameQuery {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessagesQuery {
    topic: String,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    expr: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TopicScopeQuery {
    topic: String,
    #[serde(default)]
    expr: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportQuery {
    topic: String,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    expr: Option<String>,
    #[serde(default)]
    format: Option<String>,
    /// Comma-separated message ids: only these.
    #[serde(default)]
    ids: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageQueryParams {
    topic: String,
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchQuery {
    topic: String,
    id: String,
    function: String,
    /// One delivery of the function (its event id): a run again has its
    /// own request. Absent: the newest delivery whose request is kept.
    #[serde(default)]
    event: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BacklogQuery {
    subscription: String,
    #[serde(default)]
    state: Option<PubsubBacklogState>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BacklogScope {
    subscription: String,
    #[serde(default)]
    state: Option<PubsubBacklogState>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeliveriesQuery {
    topic: String,
    #[serde(default)]
    function: Option<String>,
    #[serde(default)]
    outcome: Option<PubsubFunctionMark>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TopicQuery {
    topic: String,
}

fn limit_of(limit: Option<u32>) -> usize {
    usize::try_from(limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)).unwrap_or(100)
}

/// A page cursor's key, refusing a request that carries both.
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

/// A message id as the URL carries it.
fn message_id(text: &str) -> Result<u64, ApiError> {
    text.trim()
        .parse()
        .map_err(|_| ApiError::invalid(format!("`{text}` is not a message id; ids are numbers.")))
}

fn whole<T: ts_rs::TS>(items: Vec<T>) -> Page<T> {
    let count = u64_of(items.len());
    Page {
        items,
        next_cursor: None,
        prev_cursor: None,
        total: Some(Total { count, exact: true }),
        scanned: None,
    }
}

fn topic_missing() -> ApiError {
    pubsub_error(PubsubError::not_found("Topic not found"))
}

fn subscription_missing() -> ApiError {
    pubsub_error(PubsubError::not_found("Subscription does not exist"))
}

/// Who listens on each topic, and the schedules' topics.
pub(crate) fn targets(console: &PubsubConsole) -> Targets {
    let mut schedules: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for schedule in console.runtime.schedules() {
        schedules
            .entry(topic_resource(&schedule.project, &schedule.topic))
            .or_default()
            .push(schedule.function_id);
    }
    Targets {
        by_topic: console.runtime.all_function_targets(),
        schedules,
    }
}

fn managed_by(console: &PubsubConsole) -> impl Fn(&str) -> firenook_pubsub_front::Managed + '_ {
    |name| console.runtime.managed(name)
}

// ------------------------------------------------------------ topics

async fn topics_index(
    State(api): State<PubsubApi>,
    Query(query): Query<ProjectQuery>,
) -> Answer<PubsubTopicIndex> {
    let console = api.console()?;
    let project = api.project(query.project.as_deref());
    blocking("the topics index", move || {
        let index = console.runtime.broker().topics_index(&project);
        let targets = targets(&console);
        let managed = managed_by(&console);
        Ok(Json(PubsubTopicIndex {
            page: whole(
                index
                    .topics
                    .iter()
                    .map(|topic| convert::topic_summary(topic, &targets, &managed))
                    .collect(),
            ),
            project: index.project,
            other_projects: index
                .other_projects
                .iter()
                .map(|other| types::PubsubProjectCount {
                    project: other.project.clone(),
                    topics: other.topics,
                    subscriptions: other.subscriptions,
                })
                .collect(),
            detached: index
                .detached
                .iter()
                .map(|subscription| convert::subscription_summary(subscription, &managed))
                .collect(),
            revision: index.revision,
        }))
    })
    .await
}

fn topic_summary_of(console: &PubsubConsole, name: &str) -> Result<PubsubTopicSummary, ApiError> {
    let view = console
        .runtime
        .broker()
        .topic_view(name)
        .ok_or_else(topic_missing)?;
    Ok(convert::topic_summary(
        &view.summary,
        &targets(console),
        &managed_by(console),
    ))
}

async fn topic_detail(
    State(api): State<PubsubApi>,
    Query(query): Query<NameQuery>,
) -> Answer<PubsubTopicDetail> {
    let console = api.console()?;
    let view = console
        .runtime
        .broker()
        .topic_view(&query.name)
        .ok_or_else(topic_missing)?;
    Ok(Json(convert::topic_detail(
        &view,
        &targets(&console),
        &managed_by(&console),
    )))
}

fn encoding(text: &str) -> Result<Encoding, ApiError> {
    match text.to_ascii_uppercase().as_str() {
        "JSON" => Ok(Encoding::Json),
        "BINARY" => Ok(Encoding::Binary),
        _ => Err(ApiError::invalid(format!(
            "`{text}` is not an encoding; it is JSON or BINARY."
        ))),
    }
}

fn schema_settings(binding: &PubsubSchemaBinding) -> Result<SchemaSettings, ApiError> {
    Ok(SchemaSettings {
        schema: binding.schema.clone(),
        encoding: encoding(&binding.encoding)? as i32,
        first_revision_id: binding.first_revision_id.clone().unwrap_or_default(),
        last_revision_id: binding.last_revision_id.clone().unwrap_or_default(),
    })
}

fn seconds(seconds: i64) -> pbjson_types::Duration {
    pbjson_types::Duration { seconds, nanos: 0 }
}

/// The proto topic a create sends.
pub(crate) fn topic_request(body: &PubsubCreateTopicBody) -> Result<Topic, ApiError> {
    Ok(Topic {
        name: body.name.clone(),
        labels: body.labels.clone(),
        message_retention_duration: body.retention_seconds.map(seconds),
        schema_settings: body.schema.as_ref().map(schema_settings).transpose()?,
        ..Topic::default()
    })
}

async fn create_topic(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubCreateTopicBody>,
) -> Result<Response, ApiError> {
    let console = api.console()?;
    let broker = console.runtime.broker();
    broker
        .create_topic(topic_request(&body)?)
        .map_err(pubsub_error)?;
    if body.default_subscription {
        let parsed = names::parse("topics", &body.name).map_err(pubsub_error)?;
        broker
            .create_subscription(Subscription {
                name: format!(
                    "projects/{}/subscriptions/{}-sub",
                    parsed.project, parsed.id
                ),
                topic: body.name.clone(),
                ..Subscription::default()
            })
            .map_err(pubsub_error)?;
    }
    let summary = topic_summary_of(&console, &body.name)?;
    Ok((StatusCode::CREATED, Json(summary)).into_response())
}

async fn update_topic(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubUpdateTopicBody>,
) -> Answer<PubsubTopicSummary> {
    let console = api.console()?;
    let mut paths = Vec::new();
    for field in &body.mask {
        paths.push(
            match field.as_str() {
                "retention" => "message_retention_duration",
                "schema" => "schema_settings",
                other => {
                    return Err(ApiError::invalid(format!(
                        "A topic's `{other}` cannot be changed; the mask names retention or schema."
                    )));
                }
            }
            .to_owned(),
        );
    }
    let topic = Topic {
        name: body.name.clone(),
        message_retention_duration: body.retention_seconds.map(seconds),
        schema_settings: body.schema.as_ref().map(schema_settings).transpose()?,
        ..Topic::default()
    };
    console
        .runtime
        .broker()
        .update_topic(Some(topic), &paths)
        .map_err(pubsub_error)?;
    Ok(Json(topic_summary_of(&console, &body.name)?))
}

async fn delete_topic(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubDeleteTopicBody>,
) -> Result<StatusCode, ApiError> {
    let console = api.console()?;
    let broker = console.runtime.broker();
    broker.get_topic(&body.name).map_err(pubsub_error)?;
    if body.subscriptions == PubsubDeleteSubscriptions::Delete {
        for subscription in broker.topic_subscriptions(&body.name) {
            broker
                .delete_subscription(&subscription)
                .map_err(pubsub_error)?;
        }
    }
    broker.delete_topic(&body.name).map_err(pubsub_error)?;
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------ publishing

/// A console draft as the engine's.
pub(crate) fn draft(message: &PubsubOutgoingMessage) -> Draft {
    Draft {
        data: match &message.data {
            PubsubData::Text(text) => DraftData::Text(text.clone()),
            PubsubData::Json(text) => DraftData::Json(text.clone()),
            PubsubData::Base64(text) => DraftData::Base64(text.clone()),
            PubsubData::AvroJson(text) => DraftData::AvroJson(text.clone()),
        },
        attributes: message.attributes.clone(),
        ordering_key: message.ordering_key.clone().unwrap_or_default(),
    }
}

/// Message 1 as the publish would send it, or why it would not.
fn preview(
    console: &PubsubConsole,
    topic: &str,
    message: &PubsubOutgoingMessage,
    template: bool,
) -> PubsubPreview {
    let schema = console.runtime.broker().topic_schema(topic);
    match templates::prepare(
        &draft(message),
        1,
        SystemTime::now(),
        template,
        schema.as_ref().map(|(schema, _)| schema.as_ref()),
    ) {
        Ok(prepared) => {
            let text = String::from_utf8(prepared.data.clone()).ok();
            PubsubPreview {
                data_base64: text.is_none().then(|| BASE64.encode(&prepared.data)),
                data_text: text,
                attributes: prepared.attributes,
                ordering_key: (!prepared.ordering_key.is_empty()).then_some(prepared.ordering_key),
                problem: None,
            }
        }
        Err(error) => PubsubPreview {
            data_text: None,
            data_base64: None,
            attributes: BTreeMap::new(),
            ordering_key: None,
            problem: Some(error.to_string()),
        },
    }
}

async fn publish(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubPublishBody>,
) -> Result<Response, ApiError> {
    let console = api.console()?;
    if body.messages.is_empty() || body.messages.len() > PUBLISH_MAX {
        return Err(ApiError::invalid(format!(
            "A publish sends 1 to 1,000 messages; this one has {}.",
            body.messages.len()
        ))
        .with_fix("Publish more as a job (POST /pubsub/messages:publish), which batches them."));
    }
    console
        .runtime
        .broker()
        .get_topic(&body.topic)
        .map_err(pubsub_error)?;
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
    let prepared = templates::prepare_all(
        &drafts,
        SystemTime::now(),
        body.template,
        schema.as_ref().map(|(schema, _)| schema.as_ref()),
    )
    .map_err(|error| ApiError::invalid(error.to_string()))?;
    let outcome = console
        .publish_from_console(&body.topic, prepared)
        .map_err(pubsub_error)?;
    Ok(Json(PubsubPublishResult {
        message_ids: outcome.ids,
        subscriptions: outcome.subscriptions,
        functions: outcome.functions,
        functions_skipped: outcome.functions_skipped,
    })
    .into_response())
}

// ------------------------------------------------------------ messages

/// The join's inputs for a set of fanouts.
fn join<'t, 'e>(
    console: &PubsubConsole,
    targets: &'t Targets,
    event_ids: impl IntoIterator<Item = &'e str>,
) -> Join<'t> {
    Join::read(
        console.monitor.as_ref(),
        console.runtime.delivery_queue_depth(),
        targets,
        event_ids,
    )
}

async fn messages(
    State(api): State<PubsubApi>,
    Query(query): Query<MessagesQuery>,
) -> Answer<Page<PubsubMessageRow>> {
    let console = api.console()?;
    let filter = message_query(query.q.as_deref(), query.expr.as_deref())?;
    let (after, before) = cursors::<u64>(query.cursor.as_deref(), query.before.as_deref())?;
    let limit = limit_of(query.limit);
    blocking("the message page", move || {
        let page = console
            .runtime
            .broker()
            .history_page(&query.topic, &filter, after, before, limit)
            .ok_or_else(topic_missing)?;
        let targets = targets(&console);
        let join = join(
            &console,
            &targets,
            page.rows
                .iter()
                .flat_map(|row| convert::event_ids(row.fanout.as_ref())),
        );
        let total = Some(Total {
            count: page.total,
            exact: page.exact,
        });
        if page.rows.is_empty() {
            return Ok(Json(Page {
                items: Vec::new(),
                next_cursor: page.next_cursor.map(|id| encode_cursor(&id)),
                prev_cursor: page.prev_cursor.map(|id| encode_cursor(&id)),
                total,
                scanned: page.scanned,
            }));
        }
        let mut builder = PageBuilder::new(limit);
        for row in &page.rows {
            if !builder.push(
                convert::message_row(&query.topic, row, &join),
                row.message.id,
            ) {
                break;
            }
        }
        Ok(Json(builder.finish(
            page.next_cursor.is_some(),
            page.prev_cursor.is_some(),
            total,
            page.scanned,
        )))
    })
    .await
}

/// The loaded page a row falls in, for a list in descending order: page `i`
/// holds the keys from its start downwards.
fn page_of_descending(item: u64, starts: &[Option<u64>], end: Option<u64>) -> Option<usize> {
    let page = starts
        .iter()
        .rposition(|start| start.is_none_or(|start| start >= item))?;
    if page + 1 == starts.len() && end.is_some_and(|end| item < end) {
        return None;
    }
    Some(page)
}

async fn messages_batch(
    State(api): State<PubsubApi>,
    Query(scope): Query<TopicScopeQuery>,
    ConsoleJson(request): ConsoleJson<BatchGetRequest>,
) -> Answer<BatchGetResponse<PubsubMessageRow>> {
    request.check()?;
    let console = api.console()?;
    let filter = message_query(request.q.as_deref(), scope.expr.as_deref())?;
    let (starts, end) = request.window::<u64>()?;
    let ids: Vec<Option<u64>> = request
        .keys
        .iter()
        .map(|key| key.parse::<u64>().ok())
        .collect();
    let known: Vec<u64> = ids.iter().flatten().copied().collect();
    let rows = console
        .runtime
        .broker()
        .history_rows(&scope.topic, &known, &filter);
    let targets = targets(&console);
    let join = join(
        &console,
        &targets,
        rows.iter()
            .flatten()
            .flat_map(|row| convert::event_ids(row.fanout.as_ref())),
    );
    let mut found: HashMap<u64, PubsubMessageRow> = known
        .iter()
        .zip(&rows)
        .filter_map(|(id, row)| {
            row.as_ref()
                .map(|row| (*id, convert::message_row(&scope.topic, row, &join)))
        })
        .collect();
    let items = request
        .keys
        .iter()
        .zip(ids)
        .map(|(key, id)| {
            let row = id.and_then(|id| found.remove(&id));
            BatchGetItem {
                key: key.clone(),
                page: row
                    .as_ref()
                    .and(id)
                    .and_then(|id| page_of_descending(id, &starts, end))
                    .map(u32_of),
                row,
            }
        })
        .collect();
    Ok(Json(BatchGetResponse { items }))
}

/// One message as an export writes it: the Pub/Sub REST shape, so a file
/// of them publishes again as it is.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportedMessage {
    message_id: String,
    publish_time: String,
    data: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    attributes: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    ordering_key: String,
}

impl ExportedMessage {
    fn of(message: &StoredMessage) -> Self {
        Self {
            message_id: message.id.to_string(),
            publish_time: time(message.published_at),
            data: BASE64.encode(&message.message.data),
            attributes: message
                .message
                .attributes
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
            ordering_key: message.message.ordering_key.clone(),
        }
    }
}

/// Messages an export reads per page, each page one short lock.
const EXPORT_PAGE: usize = 500;

async fn export_messages(
    State(api): State<PubsubApi>,
    Query(query): Query<ExportQuery>,
) -> Result<Response, ApiError> {
    let console = api.console()?;
    let filter = message_query(query.q.as_deref(), query.expr.as_deref())?;
    console
        .runtime
        .broker()
        .get_topic(&query.topic)
        .map_err(pubsub_error)?;
    let json = match query.format.as_deref() {
        None | Some("ndjson") => false,
        Some("json") => true,
        Some(other) => {
            return Err(ApiError::invalid(format!(
                "`{other}` is not an export format; it is ndjson or json."
            )));
        }
    };
    let only: Option<Vec<u64>> = query
        .ids
        .as_deref()
        .filter(|ids| !ids.trim().is_empty())
        .map(|ids| ids.split(',').map(message_id).collect())
        .transpose()?;
    let id = query
        .topic
        .rsplit('/')
        .next()
        .unwrap_or("messages")
        .to_owned();
    let broker = console.runtime.broker().clone();
    let topic = query.topic.clone();
    // Pages of the history, newest first, each read under one short lock
    // and written outside it, until the ring is done or the suite stops.
    let messages = futures_util::stream::unfold(
        (Some(None::<u64>), only.map(IntoIterator::into_iter)),
        move |(cursor, mut only)| {
            let broker = broker.clone();
            let topic = topic.clone();
            let filter = filter.clone();
            async move {
                if let Some(ids) = only.as_mut() {
                    let chunk: Vec<u64> = ids.by_ref().take(EXPORT_PAGE).collect();
                    if chunk.is_empty() {
                        return None;
                    }
                    let rows = broker.history_rows(&topic, &chunk, &filter);
                    let messages: Vec<ExportedMessage> = rows
                        .iter()
                        .flatten()
                        .map(|row| ExportedMessage::of(&row.message))
                        .collect();
                    return Some((messages, (cursor, only)));
                }
                let after = cursor?;
                let page = broker.history_page(&topic, &filter, after, None, EXPORT_PAGE)?;
                let messages: Vec<ExportedMessage> = page
                    .rows
                    .iter()
                    .map(|row| ExportedMessage::of(&row.message))
                    .collect();
                let next = page.next_cursor.map(Some);
                Some((messages, (next, None)))
            }
        },
    )
    .flat_map(futures_util::stream::iter);
    let extension = if json { "json" } else { "ndjson" };
    let filename = format!("{id}-messages.{extension}");
    let response = if json {
        json_array_response(messages, api.shutdown.clone())
    } else {
        crate::http::ndjson_response(messages, api.shutdown.clone())
    };
    Ok((attachment(&filename), response).into_response())
}

/// A JSON array written as its items arrive, ending with the suite.
fn json_array_response<S, T>(items: S, shutdown: Shutdown) -> Response
where
    S: futures_util::Stream<Item = T> + Send + 'static,
    T: Serialize,
{
    use futures_util::StreamExt as _;
    let mut first = true;
    let body = futures_util::stream::once(async { b"[".to_vec() })
        .chain(items.map(move |item| {
            let mut line = if first { Vec::new() } else { b",\n".to_vec() };
            first = false;
            line.extend(serde_json::to_vec(&item).unwrap_or_else(|_| b"null".to_vec()));
            line
        }))
        .chain(futures_util::stream::once(async { b"]\n".to_vec() }))
        .take_until(shutdown.stopped())
        .map(|bytes| Ok::<_, std::convert::Infallible>(axum::body::Bytes::from(bytes)));
    (
        [
            (
                axum::http::header::CONTENT_TYPE,
                axum::http::HeaderValue::from_static("application/json"),
            ),
            (
                axum::http::header::CACHE_CONTROL,
                axum::http::HeaderValue::from_static("no-store"),
            ),
        ],
        axum::body::Body::from_stream(body),
    )
        .into_response()
}

/// The push streaks of one message, newest first, from the console's ring.
fn message_streaks(console: &PubsubConsole, id: u64) -> Vec<types::PubsubPushStreak> {
    console.feed.streaks_of(id, MESSAGE_STREAKS)
}

async fn message_detail(
    State(api): State<PubsubApi>,
    Query(query): Query<MessageQueryParams>,
) -> Answer<PubsubMessageDetail> {
    let console = api.console()?;
    let id = message_id(&query.id)?;
    let view = console
        .runtime
        .broker()
        .message_view(&query.topic, id)
        .ok_or_else(|| {
            ApiError::not_found("The engine no longer keeps this message.").with_fix(
                "Its topic keeps the newest messages (5,000 and 16 MiB without retention).",
            )
        })?;
    let targets = targets(&console);
    let join = join(&console, &targets, convert::event_ids(view.fanout.as_ref()));
    let functions = convert::delivery_rows(&view, &join);
    Ok(Json(convert::message_detail(
        &view.topic,
        &view.message,
        view.in_history,
        &view.subscriptions,
        functions,
        message_streaks(&console, id),
    )))
}

async fn message_ack(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubMessageActionBody>,
) -> Result<StatusCode, ApiError> {
    let console = api.console()?;
    console
        .runtime
        .broker()
        .force_ack(&body.subscription, message_id(&body.message_id)?)
        .map_err(pubsub_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn message_release(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubMessageActionBody>,
) -> Result<StatusCode, ApiError> {
    let console = api.console()?;
    console
        .runtime
        .broker()
        .release(&body.subscription, message_id(&body.message_id)?)
        .map_err(pubsub_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn redeliver(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubRedeliverBody>,
) -> Answer<PubsubRedelivery> {
    let console = api.console()?;
    let event_id = console
        .runtime
        .redeliver(
            &body.topic,
            message_id(&body.message_id)?,
            &body.function_id,
        )
        .map_err(|error| redeliver_error(&error))?;
    Ok(Json(PubsubRedelivery { event_id }))
}

async fn dispatch(
    State(api): State<PubsubApi>,
    Query(query): Query<DispatchQuery>,
) -> Answer<PubsubDispatchBody> {
    let console = api.console()?;
    let id = message_id(&query.id)?;
    // Compute's recorded request, while it keeps the invocation.
    if let Some(monitor) = &console.monitor
        && let Some(view) = console.runtime.broker().message_view(&query.topic, id)
        && let Some(fanout) = view.fanout
    {
        let recorded = fanout
            .targets
            .iter()
            .rev()
            .filter(|target| target.function_id == query.function)
            .filter(|target| {
                query
                    .event
                    .as_ref()
                    .is_none_or(|event| &target.event_id == event)
            })
            .find_map(|target| {
                let invocation = monitor.by_event_id(&target.event_id)?;
                monitor.request_body(&invocation.id)
            });
        if let Some(body) = recorded {
            let truncated = body.truncated || body.bytes.len() > DISPATCH_BYTES;
            let bytes = &body.bytes[..body.bytes.len().min(DISPATCH_BYTES)];
            return Ok(Json(PubsubDispatchBody {
                content_type: body.content_type.unwrap_or_default(),
                body: String::from_utf8_lossy(bytes).into_owned(),
                truncated,
                rebuilt: false,
            }));
        }
    }
    let preview = console
        .runtime
        .dispatch_preview(&query.topic, id, &query.function)
        .map_err(|error| redeliver_error(&error))?;
    let truncated = preview.body.len() > DISPATCH_BYTES;
    let bytes = &preview.body[..preview.body.len().min(DISPATCH_BYTES)];
    Ok(Json(PubsubDispatchBody {
        content_type: preview.content_type,
        body: String::from_utf8_lossy(bytes).into_owned(),
        truncated,
        rebuilt: true,
    }))
}

async fn rejected(
    State(api): State<PubsubApi>,
    Query(query): Query<ProjectQuery>,
) -> Answer<PubsubRejectedList> {
    let console = api.console()?;
    let project = api.project(query.project.as_deref());
    let list = console.runtime.rejected();
    let prefix = format!("projects/{project}/");
    Ok(Json(PubsubRejectedList {
        page: whole(
            list.entries
                .iter()
                .filter(|entry| entry.resource.starts_with(&prefix))
                .map(convert::rejected)
                .collect(),
        ),
        dropped: list.dropped,
        revision: list.revision,
    }))
}

// ------------------------------------------------------------ subscriptions

async fn subscription_detail(
    State(api): State<PubsubApi>,
    Query(query): Query<NameQuery>,
) -> Answer<PubsubSubscriptionDetail> {
    let console = api.console()?;
    let view = console
        .runtime
        .broker()
        .subscription_view(&query.name)
        .ok_or_else(subscription_missing)?;
    Ok(Json(PubsubSubscriptionDetail {
        dead_lettered_in_history: view.dead_lettered_in_history,
        subscription: convert::subscription(&view, &managed_by(&console)),
    }))
}

fn push_settings(
    endpoint: Option<&str>,
    attributes: &BTreeMap<String, String>,
) -> Option<PushConfig> {
    endpoint
        .filter(|endpoint| !endpoint.trim().is_empty())
        .map(|endpoint| PushConfig {
            push_endpoint: endpoint.trim().to_owned(),
            attributes: attributes.clone(),
            ..PushConfig::default()
        })
}

fn dead_letter_policy(dead_letter: Option<&types::PubsubDeadLetter>) -> Option<DeadLetterPolicy> {
    dead_letter.map(|policy| DeadLetterPolicy {
        dead_letter_topic: policy.topic.clone(),
        max_delivery_attempts: policy.max_delivery_attempts,
    })
}

fn retry_policy(retry: Option<&types::PubsubRetry>) -> Result<Option<RetryPolicy>, ApiError> {
    let duration = |value: f64| -> Result<pbjson_types::Duration, ApiError> {
        if !(0.0..=600.0).contains(&value) {
            return Err(ApiError::invalid(
                "A retry backoff is between 0 and 600 seconds.",
            ));
        }
        let whole = value.trunc();
        #[allow(
            clippy::cast_possible_truncation,
            reason = "a value checked to lie in 0..=600 seconds, and its fraction in nanoseconds"
        )]
        Ok(pbjson_types::Duration {
            seconds: whole as i64,
            nanos: ((value - whole) * 1e9).round() as i32,
        })
    };
    retry
        .map(|retry| {
            Ok(RetryPolicy {
                minimum_backoff: Some(duration(retry.minimum_backoff_seconds)?),
                maximum_backoff: Some(duration(retry.maximum_backoff_seconds)?),
            })
        })
        .transpose()
}

/// The proto subscription a create sends.
pub(crate) fn subscription_request(
    body: &PubsubCreateSubscriptionBody,
) -> Result<Subscription, ApiError> {
    Ok(Subscription {
        name: body.name.clone(),
        topic: body.topic.clone(),
        push_config: push_settings(body.push_endpoint.as_deref(), &body.push_attributes),
        ack_deadline_seconds: body.ack_deadline_seconds.unwrap_or(0),
        retain_acked_messages: body.retain_acked,
        message_retention_duration: body.retention_seconds.map(seconds),
        labels: body.labels.clone(),
        enable_message_ordering: body.ordering,
        expiration_policy: body.expiration_ttl_seconds.map(|ttl| ExpirationPolicy {
            ttl: Some(seconds(ttl)),
        }),
        filter: body.filter.clone().unwrap_or_default(),
        dead_letter_policy: dead_letter_policy(body.dead_letter.as_ref()),
        retry_policy: retry_policy(body.retry.as_ref())?,
        enable_exactly_once_delivery: body.exactly_once,
        ..Subscription::default()
    })
}

fn subscription_summary_of(
    console: &PubsubConsole,
    name: &str,
) -> Result<PubsubSubscriptionSummary, ApiError> {
    let view = console
        .runtime
        .broker()
        .subscription_view(name)
        .ok_or_else(subscription_missing)?;
    Ok(convert::subscription_summary(
        &view.summary,
        &managed_by(console),
    ))
}

async fn create_subscription(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubCreateSubscriptionBody>,
) -> Result<Response, ApiError> {
    let console = api.console()?;
    console
        .runtime
        .broker()
        .create_subscription(subscription_request(&body)?)
        .map_err(pubsub_error)?;
    let summary = subscription_summary_of(&console, &body.name)?;
    Ok((StatusCode::CREATED, Json(summary)).into_response())
}

async fn update_subscription(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubUpdateSubscriptionBody>,
) -> Answer<PubsubSubscriptionSummary> {
    let console = api.console()?;
    let mut paths = Vec::new();
    for field in &body.mask {
        paths.push(
            match field.as_str() {
                "ackDeadline" => "ack_deadline_seconds",
                "push" => "push_config",
                "retainAcked" => "retain_acked_messages",
                "retention" => "message_retention_duration",
                "deadLetter" => "dead_letter_policy",
                "retry" => "retry_policy",
                "exactlyOnce" => "enable_exactly_once_delivery",
                other => {
                    return Err(ApiError::invalid(format!(
                        "A subscription's `{other}` cannot be changed; the mask names ackDeadline, push, retainAcked, retention, deadLetter, retry or exactlyOnce."
                    )));
                }
            }
            .to_owned(),
        );
    }
    let subscription = Subscription {
        name: body.name.clone(),
        push_config: push_settings(body.push_endpoint.as_deref(), &body.push_attributes),
        ack_deadline_seconds: body.ack_deadline_seconds.unwrap_or(0),
        retain_acked_messages: body.retain_acked,
        message_retention_duration: body.retention_seconds.map(seconds),
        dead_letter_policy: dead_letter_policy(body.dead_letter.as_ref()),
        retry_policy: retry_policy(body.retry.as_ref())?,
        enable_exactly_once_delivery: body.exactly_once,
        ..Subscription::default()
    };
    console
        .runtime
        .broker()
        .update_subscription(Some(subscription), &paths)
        .map_err(pubsub_error)?;
    Ok(Json(subscription_summary_of(&console, &body.name)?))
}

async fn delete_subscription(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubNameBody>,
) -> Result<StatusCode, ApiError> {
    let console = api.console()?;
    console
        .runtime
        .broker()
        .delete_subscription(&body.name)
        .map_err(pubsub_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn push_config(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubPushConfigBody>,
) -> Result<StatusCode, ApiError> {
    let console = api.console()?;
    let config =
        Some(push_settings(body.endpoint.as_deref(), &BTreeMap::new()).unwrap_or_default());
    console
        .runtime
        .broker()
        .modify_push_config(&body.subscription, config)
        .map_err(pubsub_error)?;
    Ok(StatusCode::NO_CONTENT)
}

/// A received message's detail, from the proto message a pull answers.
fn timestamp(at: SystemTime) -> pbjson_types::Timestamp {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    pbjson_types::Timestamp {
        seconds: i64::try_from(since.as_secs()).unwrap_or(i64::MAX),
        nanos: i32::try_from(since.subsec_nanos()).unwrap_or(0),
    }
}

async fn seek(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubSeekBody>,
) -> Answer<PubsubSeekResult> {
    let console = api.console()?;
    let broker = console.runtime.broker();
    let targets = [body.time.is_some(), body.snapshot.is_some(), body.now]
        .iter()
        .filter(|set| **set)
        .count();
    if targets != 1 {
        return Err(ApiError::invalid(
            "A seek names exactly one of time, snapshot or now.",
        ));
    }
    if let Some(snapshot) = &body.snapshot {
        broker
            .seek_to_snapshot(&body.subscription, snapshot)
            .map_err(pubsub_error)?;
    } else {
        let at = match &body.time {
            Some(text) => OffsetDateTime::parse(text, &Rfc3339)
                .map(SystemTime::from)
                .map_err(|_| {
                    ApiError::invalid(format!(
                        "`{text}` is not a time; write it in RFC 3339, like 2026-10-01T09:00:00Z."
                    ))
                })?,
            None => SystemTime::now(),
        };
        broker
            .seek_to_time(&body.subscription, &timestamp(at))
            .map_err(pubsub_error)?;
    }
    let counts = broker
        .subscription_counts(&body.subscription)
        .ok_or_else(subscription_missing)?;
    Ok(Json(PubsubSeekResult {
        available: counts.available,
        acked: counts.retained_acked,
    }))
}

// ------------------------------------------------------------ backlog

/// A backlog page's cursor: the row key and its place in the delivery
/// order.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct BacklogCursorKey {
    key: String,
    place: u64,
}

impl BacklogCursorKey {
    fn of(cursor: &BacklogCursor) -> Self {
        Self {
            key: cursor.key.to_string(),
            place: cursor.place,
        }
    }

    fn cursor(&self) -> Result<BacklogCursor, ApiError> {
        Ok(BacklogCursor {
            key: backlog_key(&self.key)?,
            place: self.place,
        })
    }
}

pub(crate) fn backlog_key(text: &str) -> Result<BacklogKey, ApiError> {
    text.parse()
        .map_err(|()| ApiError::invalid(format!("`{text}` is not a backlog row key.")))
}

async fn backlog(
    State(api): State<PubsubApi>,
    Query(query): Query<BacklogQuery>,
) -> Answer<Page<PubsubBacklogRow>> {
    let console = api.console()?;
    let (after, before) =
        cursors::<BacklogCursorKey>(query.cursor.as_deref(), query.before.as_deref())?;
    let after = after.map(|key| key.cursor()).transpose()?;
    let before = before.map(|key| key.cursor()).transpose()?;
    let page = console
        .runtime
        .broker()
        .backlog_page(
            &query.subscription,
            query.state.map(convert::backlog_filter),
            after,
            before,
            limit_of(query.limit),
        )
        .ok_or_else(subscription_missing)?;
    Ok(Json(Page {
        items: page.rows.iter().map(convert::backlog_row).collect(),
        next_cursor: page
            .next_cursor
            .as_ref()
            .map(|cursor| encode_cursor(&BacklogCursorKey::of(cursor))),
        prev_cursor: page
            .prev_cursor
            .as_ref()
            .map(|cursor| encode_cursor(&BacklogCursorKey::of(cursor))),
        total: Some(Total {
            count: page.total,
            exact: true,
        }),
        scanned: None,
    }))
}

async fn backlog_batch(
    State(api): State<PubsubApi>,
    Query(scope): Query<BacklogScope>,
    ConsoleJson(request): ConsoleJson<BatchGetRequest>,
) -> Answer<BatchGetResponse<PubsubBacklogRow>> {
    request.check()?;
    let console = api.console()?;
    let (starts, end) = request.window::<BacklogCursorKey>()?;
    let starts: Vec<Option<BacklogKey>> = starts
        .iter()
        .map(|start| {
            start
                .as_ref()
                .map(|start| backlog_key(&start.key))
                .transpose()
        })
        .collect::<Result<_, _>>()?;
    let end = end.map(|end| backlog_key(&end.key)).transpose()?;
    let keys: Vec<Option<BacklogKey>> = request
        .keys
        .iter()
        .map(|key| key.parse::<BacklogKey>().ok())
        .collect();
    let known: Vec<BacklogKey> = keys.iter().flatten().copied().collect();
    let mut rows = console
        .runtime
        .broker()
        .backlog_rows(&scope.subscription, &known)
        .into_iter();
    let wanted = scope.state.map(convert::backlog_filter);
    let items = request
        .keys
        .iter()
        .zip(keys)
        .map(|(text, key)| {
            let row = key
                .and_then(|_| rows.next().flatten())
                .filter(|row| wanted.is_none_or(|state| row.state == state));
            let page = row
                .as_ref()
                .and_then(|row| page_of(&row.key, &starts, end.as_ref()))
                .map(u32_of);
            BatchGetItem {
                key: text.clone(),
                row: row.as_ref().map(convert::backlog_row),
                page,
            }
        })
        .collect();
    Ok(Json(BatchGetResponse { items }))
}

// ------------------------------------------------------------ deliveries

/// A deliveries page's cursor: the record's place (newest first).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct DeliveryCursor {
    message: u64,
    target: usize,
}

/// Every delivery record of a topic, newest first, joined.
fn delivery_records(
    console: &PubsubConsole,
    topic: &str,
) -> Result<Vec<(DeliveryCursor, PubsubDeliveryRow)>, ApiError> {
    let records = console
        .runtime
        .broker()
        .fanouts(topic)
        .ok_or_else(topic_missing)?;
    let targets = targets(console);
    let join = join(
        console,
        &targets,
        records
            .iter()
            .flat_map(|(_, fanout)| fanout.targets.iter().map(|target| target.event_id.as_str())),
    );
    let mut rows = Vec::new();
    for (message, fanout) in &records {
        for (index, target) in fanout.targets.iter().enumerate().rev() {
            rows.push((
                DeliveryCursor {
                    message: message.id,
                    target: index,
                },
                join.row(topic, message, fanout, target),
            ));
        }
    }
    Ok(rows)
}

fn count_marks(rows: &[(DeliveryCursor, PubsubDeliveryRow)]) -> PubsubDeliveryCounts {
    let mut counts = PubsubDeliveryCounts::default();
    for (_, row) in rows {
        counts.all += 1;
        match row.mark {
            PubsubFunctionMark::Queued => counts.queued += 1,
            PubsubFunctionMark::Running => counts.running += 1,
            PubsubFunctionMark::Delivered => counts.delivered += 1,
            PubsubFunctionMark::Failed => counts.failed += 1,
            PubsubFunctionMark::Skipped => counts.skipped += 1,
            // Its outcome is unknown, not a failure: only `all` counts it.
            PubsubFunctionMark::NotKept => {}
        }
    }
    counts
}

/// Whether a record sorts after (older than) a cursor.
fn older(cursor: DeliveryCursor, than: DeliveryCursor) -> bool {
    (cursor.message, cursor.target) < (than.message, than.target)
}

async fn deliveries(
    State(api): State<PubsubApi>,
    Query(query): Query<DeliveriesQuery>,
) -> Answer<PubsubDeliveryPage> {
    let console = api.console()?;
    if console.monitor.is_none() {
        return Err(functions_absent());
    }
    let (after, before) =
        cursors::<DeliveryCursor>(query.cursor.as_deref(), query.before.as_deref())?;
    let limit = limit_of(query.limit);
    blocking("the deliveries page", move || {
        let mut rows = delivery_records(&console, &query.topic)?;
        if let Some(function) = &query.function {
            rows.retain(|(_, row)| &row.function_id == function);
        }
        let counts = count_marks(&rows);
        if let Some(outcome) = query.outcome {
            rows.retain(|(_, row)| row.mark == outcome);
        }
        let total = u64_of(rows.len());
        let (start, end) = match (after, before) {
            (_, Some(before)) => {
                // Rows newer than the page below's first.
                let end = rows.partition_point(|(cursor, _)| older(before, *cursor));
                (end.saturating_sub(limit), end)
            }
            (Some(after), None) => {
                // Rows older than the page above's last.
                let start = rows.partition_point(|(cursor, _)| !older(*cursor, after));
                (start, (start + limit).min(rows.len()))
            }
            (None, None) => (0, limit.min(rows.len())),
        };
        let length = rows.len();
        let mut builder = PageBuilder::new(limit);
        let mut taken = start;
        for (cursor, row) in rows.drain(start..end) {
            if !builder.push(row, cursor) {
                break;
            }
            taken += 1;
        }
        Ok(Json(PubsubDeliveryPage {
            page: builder.finish(
                taken < length,
                start > 0,
                Some(Total {
                    count: total,
                    exact: true,
                }),
                None,
            ),
            counts,
        }))
    })
    .await
}

async fn deliveries_batch(
    State(api): State<PubsubApi>,
    Query(scope): Query<TopicQuery>,
    ConsoleJson(request): ConsoleJson<BatchGetRequest>,
) -> Answer<BatchGetResponse<PubsubDeliveryRow>> {
    request.check()?;
    let console = api.console()?;
    if console.monitor.is_none() {
        return Err(functions_absent());
    }
    let (starts, end) = request.window::<DeliveryCursor>()?;
    let rows = delivery_records(&console, &scope.topic)?;
    let by_event: HashMap<&str, (DeliveryCursor, &PubsubDeliveryRow)> = rows
        .iter()
        .map(|(cursor, row)| (row.event_id.as_str(), (*cursor, row)))
        .collect();
    let items = request
        .keys
        .iter()
        .map(|key| {
            let found = by_event.get(key.as_str());
            let page = found.and_then(|(cursor, _)| {
                let position = starts
                    .iter()
                    .rposition(|start| start.is_none_or(|start| !older(start, *cursor)))?;
                if position + 1 == starts.len() && end.is_some_and(|end| older(*cursor, end)) {
                    return None;
                }
                Some(u32_of(position))
            });
            BatchGetItem {
                key: key.clone(),
                row: found.map(|(_, row)| (*row).clone()),
                page,
            }
        })
        .collect();
    Ok(Json(BatchGetResponse { items }))
}

// ------------------------------------------------------------ snapshots

async fn snapshots(
    State(api): State<PubsubApi>,
    Query(query): Query<ProjectQuery>,
) -> Answer<Page<PubsubSnapshot>> {
    let console = api.console()?;
    let project = api.project(query.project.as_deref());
    Ok(Json(whole(
        console
            .runtime
            .broker()
            .snapshots_view(&project)
            .iter()
            .map(convert::snapshot)
            .collect(),
    )))
}

async fn create_snapshot(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubCreateSnapshotBody>,
) -> Result<Response, ApiError> {
    let console = api.console()?;
    let broker = console.runtime.broker();
    broker
        .create_snapshot(&body.name, &body.subscription, BTreeMap::new())
        .map_err(pubsub_error)?;
    let parsed = names::parse("snapshots", &body.name).map_err(pubsub_error)?;
    let snapshot = broker
        .snapshots_view(&parsed.project)
        .iter()
        .find(|snapshot| snapshot.name == body.name)
        .map(convert::snapshot)
        .ok_or_else(|| ApiError::internal("The snapshot was created but cannot be read."))?;
    Ok((StatusCode::CREATED, Json(snapshot)).into_response())
}

async fn delete_snapshot(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubNameBody>,
) -> Result<StatusCode, ApiError> {
    let console = api.console()?;
    console
        .runtime
        .broker()
        .delete_snapshot(&body.name)
        .map_err(pubsub_error)?;
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------ schemas

async fn list_schemas(
    State(api): State<PubsubApi>,
    Query(query): Query<ProjectQuery>,
) -> Answer<Page<PubsubSchemaSummary>> {
    let console = api.console()?;
    let project = api.project(query.project.as_deref());
    Ok(Json(whole(
        console
            .runtime
            .broker()
            .schemas_view(&project)
            .iter()
            .map(convert::schema_summary)
            .collect(),
    )))
}

fn schema_detail_of(console: &PubsubConsole, name: &str) -> Result<PubsubSchemaDetail, ApiError> {
    console
        .runtime
        .broker()
        .schema_detail(name)
        .map(|detail| convert::schema_detail(&detail))
        .ok_or_else(|| pubsub_error(PubsubError::not_found("Schema not found")))
}

async fn schema_detail(
    State(api): State<PubsubApi>,
    Query(query): Query<NameQuery>,
) -> Answer<PubsubSchemaDetail> {
    let console = api.console()?;
    Ok(Json(schema_detail_of(&console, &query.name)?))
}

fn avro_kind(kind: &str) -> Result<i32, ApiError> {
    if kind.eq_ignore_ascii_case("AVRO") {
        Ok(firenook_pubsub_front::google::pubsub::v1::schema::Type::Avro as i32)
    } else {
        Err(ApiError::invalid(format!(
            "`{kind}` schemas are not run by the emulator; it runs AVRO."
        ))
        .with_fix("Write the schema in Avro."))
    }
}

/// Creates schema `name` (`projects/p/schemas/s`) with a first revision.
pub(crate) fn create_schema_named(
    console: &PubsubConsole,
    name: &str,
    kind: &str,
    definition: &str,
) -> Result<firenook_pubsub_front::google::pubsub::v1::Schema, ApiError> {
    let parsed = names::parse("schemas", name).map_err(pubsub_error)?;
    console
        .runtime
        .broker()
        .create_schema(
            &format!("projects/{}", parsed.project),
            &parsed.id,
            Some(firenook_pubsub_front::google::pubsub::v1::Schema {
                name: name.to_owned(),
                r#type: avro_kind(kind)?,
                definition: definition.to_owned(),
                ..Default::default()
            }),
        )
        .map_err(pubsub_error)
}

/// Commits a new revision of schema `name`.
pub(crate) fn commit_schema_named(
    console: &PubsubConsole,
    name: &str,
    definition: &str,
) -> Result<firenook_pubsub_front::google::pubsub::v1::Schema, ApiError> {
    console
        .runtime
        .broker()
        .commit_schema(
            name,
            Some(firenook_pubsub_front::google::pubsub::v1::Schema {
                name: name.to_owned(),
                r#type: firenook_pubsub_front::google::pubsub::v1::schema::Type::Avro as i32,
                definition: definition.to_owned(),
                ..Default::default()
            }),
        )
        .map_err(pubsub_error)
}

async fn create_schema(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubCreateSchemaBody>,
) -> Result<Response, ApiError> {
    let console = api.console()?;
    create_schema_named(&console, &body.name, &body.kind, &body.definition)?;
    Ok((
        StatusCode::CREATED,
        Json(schema_detail_of(&console, &body.name)?),
    )
        .into_response())
}

async fn commit_schema(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubCommitSchemaBody>,
) -> Answer<PubsubSchemaDetail> {
    let console = api.console()?;
    commit_schema_named(&console, &body.name, &body.definition)?;
    Ok(Json(schema_detail_of(&console, &body.name)?))
}

async fn rollback_schema(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubRollbackSchemaBody>,
) -> Answer<PubsubSchemaDetail> {
    let console = api.console()?;
    console
        .runtime
        .broker()
        .rollback_schema(&body.name, &body.revision_id)
        .map_err(pubsub_error)?;
    Ok(Json(schema_detail_of(&console, &body.name)?))
}

async fn delete_revision(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubDeleteRevisionBody>,
) -> Answer<PubsubSchemaDetail> {
    let console = api.console()?;
    console
        .runtime
        .broker()
        .delete_schema_revision(&format!("{}@{}", body.name, body.revision))
        .map_err(pubsub_error)?;
    Ok(Json(schema_detail_of(&console, &body.name)?))
}

async fn delete_schema(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubNameBody>,
) -> Result<StatusCode, ApiError> {
    let console = api.console()?;
    console
        .runtime
        .broker()
        .delete_schema(&body.name)
        .map_err(pubsub_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn check_schema(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubSchemaCheckBody>,
) -> Answer<PubsubSchemaCheck> {
    api.console()?;
    avro_kind(&body.kind)?;
    Ok(Json(avro::definition_problem(&body.definition).map_or(
        PubsubSchemaCheck {
            ok: true,
            engine_message: None,
            reason: None,
            line: None,
            column: None,
        },
        |problem| PubsubSchemaCheck {
            ok: false,
            engine_message: Some("Could not parse schema definition".to_owned()),
            reason: Some(problem.reason),
            line: problem.line,
            column: problem.column,
        },
    )))
}

fn problem(problem: avro::JsonProblem) -> PubsubSchemaProblem {
    PubsubSchemaProblem {
        path: problem.path,
        expected: problem.expected,
        found: problem.found,
    }
}

/// A message's data as bytes, for a check.
fn data_bytes(data: &PubsubData) -> Result<Vec<u8>, ApiError> {
    match data {
        PubsubData::Text(text) | PubsubData::Json(text) | PubsubData::AvroJson(text) => {
            Ok(text.as_bytes().to_vec())
        }
        PubsubData::Base64(text) => BASE64
            .decode(text.trim())
            .map_err(|_| ApiError::invalid("The data is not valid base64.")),
    }
}

async fn validate_message(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubMessageCheckBody>,
) -> Answer<PubsubMessageCheck> {
    let console = api.console()?;
    let encoding = encoding(&body.encoding)?;
    let bytes = data_bytes(&body.data)?;
    let broker = console.runtime.broker();
    let (name, schema) = match (&body.schema, &body.definition) {
        (Some(name), _) if !name.is_empty() => (Some(name.as_str()), None),
        (_, Some(definition)) => (
            None,
            Some(firenook_pubsub_front::google::pubsub::v1::Schema {
                r#type: firenook_pubsub_front::google::pubsub::v1::schema::Type::Avro as i32,
                definition: definition.clone(),
                ..Default::default()
            }),
        ),
        _ => {
            return Err(ApiError::invalid(
                "Name a schema (optionally name@revision) or send a definition.",
            ));
        }
    };
    let engine = broker.validate_message(name, schema, &bytes, encoding);
    let explained = if encoding == Encoding::Json && engine.is_err() {
        let parsed = match (&body.schema, &body.definition) {
            (Some(name), _) if !name.is_empty() => broker.schema_revision(name),
            (_, Some(definition)) => avro::parse_definition(definition).ok().map(Arc::new),
            _ => None,
        };
        parsed.and_then(|schema| avro::explain_json(&schema, &bytes).err().map(problem))
    } else {
        None
    };
    match engine {
        Ok(()) => Ok(Json(PubsubMessageCheck {
            ok: true,
            engine_message: None,
            problem: None,
        })),
        Err(error) if error.status_name() == "NOT_FOUND" => Err(pubsub_error(error)),
        Err(error) => Ok(Json(PubsubMessageCheck {
            ok: false,
            engine_message: Some(error.message),
            problem: explained,
        })),
    }
}

async fn example_schema(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubSchemaExampleBody>,
) -> Answer<PubsubSchemaExample> {
    let console = api.console()?;
    let broker = console.runtime.broker();
    let schema = if let Some(name) = body.schema.as_deref().filter(|name| !name.is_empty()) {
        broker
            .schema_revision(name)
            .ok_or_else(|| pubsub_error(PubsubError::not_found("Schema not found")))?
    } else if let Some(topic) = body.topic.as_deref().filter(|topic| !topic.is_empty()) {
        broker
            .topic_schema(topic)
            .map(|(schema, _)| schema)
            .ok_or_else(|| {
                ApiError::precondition("The topic has no schema bound.")
                    .with_fix("Bind a schema in the topic's settings first.")
            })?
    } else if let Some(definition) = &body.definition {
        match avro::parse_definition(definition) {
            Ok(schema) => Arc::new(schema),
            Err(error) => {
                return Ok(Json(PubsubSchemaExample {
                    json: None,
                    problem: Some(
                        avro::definition_problem(definition)
                            .map_or(error.message, |problem| problem.reason),
                    ),
                }));
            }
        }
    } else {
        return Err(ApiError::invalid(
            "Name a schema, a topic, or send a definition.",
        ));
    };
    Ok(Json(match avro::example_json(&schema) {
        Ok(json) => PubsubSchemaExample {
            json: Some(json),
            problem: None,
        },
        Err(problem) => PubsubSchemaExample {
            json: None,
            problem: Some(problem),
        },
    }))
}

async fn check_filter(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubFilterCheckBody>,
) -> Answer<PubsubFilterCheck> {
    let console = api.console()?;
    let filter = match firenook_pubsub_front::filter::Filter::check(&body.filter) {
        Ok(filter) => filter,
        Err(syntax) => {
            return Ok(Json(PubsubFilterCheck {
                ok: false,
                message: Some(syntax.message),
                position: Some(u32_of(syntax.position)),
                engine_message: Some(PubsubError::application_error().message),
                checked: 0,
                matched: 0,
                sample_ids: Vec::new(),
            }));
        }
    };
    let messages = body
        .topic
        .as_deref()
        .map(|topic| {
            console
                .runtime
                .broker()
                .newest_messages(topic, FILTER_CHECK)
        })
        .unwrap_or_default();
    let (checked, matched, sample_ids) = blocking("the filter check", move || {
        let mut matched = 0_u32;
        let mut samples = Vec::new();
        for message in &messages {
            if filter.matches(&message.message.attributes) {
                matched += 1;
                if samples.len() < FILTER_SAMPLES {
                    samples.push(message.id.to_string());
                }
            }
        }
        Ok((u32_of(messages.len()), matched, samples))
    })
    .await?;
    Ok(Json(PubsubFilterCheck {
        ok: true,
        message: None,
        position: None,
        engine_message: None,
        checked,
        matched,
        sample_ids,
    }))
}

// ------------------------------------------------------------ schedules

/// Every schedule's detail with its runs' deliveries, joined.
pub(crate) fn schedule_list(console: &PubsubConsole) -> Vec<PubsubSchedule> {
    let details = console.runtime.schedule_details();
    let targets = targets(console);
    let broker = console.runtime.broker();
    // The fanouts of the runs' messages, by topic.
    let mut fanouts = Vec::new();
    for detail in &details {
        let ids: Vec<u64> = detail
            .first_run
            .iter()
            .chain(&detail.last_runs)
            .filter_map(|run| run.message_id.as_deref()?.parse().ok())
            .collect();
        if ids.is_empty() {
            continue;
        }
        let rows = broker.history_rows(&detail.view.topic, &ids, &MessageQuery::default());
        fanouts.push((detail.view.topic.clone(), rows));
    }
    let join = join(
        console,
        &targets,
        fanouts
            .iter()
            .flat_map(|(_, rows)| rows.iter().flatten())
            .flat_map(|row| convert::event_ids(row.fanout.as_ref())),
    );
    details
        .iter()
        .map(|detail| {
            let mut deliveries = HashMap::new();
            if console.monitor.is_some() {
                for (topic, rows) in &fanouts {
                    if *topic != detail.view.topic {
                        continue;
                    }
                    for row in rows.iter().flatten() {
                        let Some(fanout) = &row.fanout else {
                            continue;
                        };
                        if let Some(target) = fanout
                            .targets
                            .iter()
                            .rev()
                            .find(|target| target.function_id == detail.view.function_id)
                        {
                            deliveries.insert(
                                row.message.id.to_string(),
                                join.row(topic, &row.message, fanout, target),
                            );
                        }
                    }
                }
            }
            convert::schedule(detail, &deliveries)
        })
        .collect()
}

async fn schedules(
    State(api): State<PubsubApi>,
    Query(query): Query<ProjectQuery>,
) -> Answer<Page<PubsubSchedule>> {
    let console = api.console()?;
    let project = api.project(query.project.as_deref());
    blocking("the schedules", move || {
        let prefix = format!("projects/{project}/topics/");
        Ok(Json(whole(
            schedule_list(&console)
                .into_iter()
                .filter(|schedule| schedule.topic.starts_with(&prefix))
                .collect(),
        )))
    })
    .await
}

fn schedule_of(console: &PubsubConsole, function_id: &str) -> Result<PubsubSchedule, ApiError> {
    schedule_list(console)
        .into_iter()
        .find(|schedule| schedule.function_id == function_id)
        .ok_or_else(|| schedule_error(&firenook_pubsub_front::RunScheduleError::NotScheduled))
}

async fn run_schedule(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubScheduleBody>,
) -> Answer<PubsubScheduleRun> {
    let console = api.console()?;
    let outcome = console
        .runtime
        .run(&body.function_id)
        .map_err(|error| schedule_error(&error))?;
    let schedule = schedule_of(&console, &body.function_id)?;
    let run = schedule
        .last_runs
        .first()
        .or(schedule.first_run.as_ref())
        .filter(|run| run.message_id.as_deref() == Some(outcome.message_id.as_str()))
        .cloned()
        .unwrap_or(PubsubScheduleRun {
            at: time(SystemTime::now()),
            trigger: "console".to_owned(),
            message_id: Some(outcome.message_id),
            skipped: None,
            delivery: None,
        });
    Ok(Json(run))
}

async fn pause_schedule(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubScheduleBody>,
) -> Answer<PubsubSchedule> {
    let console = api.console()?;
    console
        .runtime
        .set_paused(&body.function_id, true)
        .map_err(|error| schedule_error(&error))?;
    Ok(Json(schedule_of(&console, &body.function_id)?))
}

async fn resume_schedule(
    State(api): State<PubsubApi>,
    ConsoleJson(body): ConsoleJson<PubsubScheduleBody>,
) -> Answer<PubsubSchedule> {
    let console = api.console()?;
    console
        .runtime
        .set_paused(&body.function_id, false)
        .map_err(|error| schedule_error(&error))?;
    Ok(Json(schedule_of(&console, &body.function_id)?))
}

/// Pub/Sub's TypeScript bindings.
#[cfg(test)]
pub(crate) fn export_bindings(config: &ts_rs::Config) {
    use ts_rs::TS as _;
    macro_rules! export {
        ($($name:ty),* $(,)?) => {
            $( <$name>::export_all(config).expect("TypeScript bindings written"); )*
        };
    }
    export!(
        crate::messaging::shared::MessagingSecondWindow,
        crate::messaging::shared::MessagingTenSecondWindow,
        types::PubsubTopicIndex,
        types::PubsubTopicDetail,
        types::PubsubSubscriptionDetail,
        types::PubsubMessageRow,
        types::PubsubMessageDetail,
        types::PubsubDeliveryPage,
        types::PubsubDispatchBody,
        types::PubsubRedelivery,
        types::PubsubRedeliverBody,
        types::PubsubBacklogRow,
        types::PubsubPublishBody,
        types::PubsubPublishResult,
        types::PubsubPreview,
        types::PubsubPublishJobBody,
        types::PubsubRejectedList,
        types::PubsubCreateTopicBody,
        types::PubsubUpdateTopicBody,
        types::PubsubDeleteTopicBody,
        types::PubsubCreateSubscriptionBody,
        types::PubsubUpdateSubscriptionBody,
        types::PubsubNameBody,
        types::PubsubPushConfigBody,
        types::PubsubMessageActionBody,
        types::PubsubSeekBody,
        types::PubsubSeekResult,
        types::PubsubBacklogJobBody,
        types::PubsubSnapshot,
        types::PubsubCreateSnapshotBody,
        types::PubsubSchemaSummary,
        types::PubsubSchemaDetail,
        types::PubsubCreateSchemaBody,
        types::PubsubCommitSchemaBody,
        types::PubsubRollbackSchemaBody,
        types::PubsubDeleteRevisionBody,
        types::PubsubSchemaCheckBody,
        types::PubsubSchemaCheck,
        types::PubsubMessageCheckBody,
        types::PubsubMessageCheck,
        types::PubsubSchemaExampleBody,
        types::PubsubSchemaExample,
        types::PubsubFilterCheckBody,
        types::PubsubFilterCheck,
        types::PubsubSchedule,
        types::PubsubScheduleRun,
        types::PubsubScheduleBody,
        types::PubsubSetup,
        types::PubsubSetupResult,
        types::PubsubCountersFrame,
        types::PubsubResourcesChanged,
        types::PubsubRejectedChanged,
        types::PubsubPublished,
        types::PubsubStale,
        types::PubsubDeliveriesChanged,
        types::PubsubSchedulesFrame,
        types::PubsubScheduleState,
        types::PubsubPushAttempts,
        types::PubsubPushStreak,
    );
}

#[cfg(test)]
mod tests;
