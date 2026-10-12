//! What caused an invocation, and its one-line summary, classified once per
//! record from the definition and the request.
//!
//! Senders state the cause in `x-firenook-cause-*` headers (and the event id
//! in `x-firenook-event-id`), Cloud Tasks and binary `CloudEvents` in their own
//! headers, so no event body is parsed on the dispatch path. Only when those
//! leave the cause unknown — a blocking function's JWT, or a sender that
//! sent no cause headers (a direct `functions:invoke` call, a test event) —
//! is a kept body of at most [`BODY_PARSE_LIMIT`] bytes read.

use axum::http::HeaderMap;
use base64::Engine as _;
use serde_json::Value;

use super::types::{FunctionKind, InvocationCause};
use crate::manifest::Definition;

/// The largest body the classifier parses when the headers say nothing.
pub const BODY_PARSE_LIMIT: usize = 64 * 1024;

/// The sender's cause headers (every `x-firenook-*` header is a control
/// header, stripped before user code sees the request). The names are the
/// bridge's, which every sender writes through; values are percent-encoded
/// with `firenook_functions_bridge::cause::encode` and read back with
/// [`cause_header`].
pub mod headers {
    pub use firenook_functions_bridge::cause::{
        AUTH_CALL, BUCKET, CHANGE, DATABASE, DOCUMENT, EMAIL, EVENT_ID, MESSAGE, OBJECT, TENANT,
        TOPIC, UID,
    };
    /// The prefix every cause header starts with.
    pub const CAUSE_PREFIX: &str = firenook_functions_bridge::cause::PREFIX;
    pub const TASK_QUEUE: &str = "x-cloudtasks-queuename";
    pub const TASK_NAME: &str = "x-cloudtasks-taskname";
    pub const TASK_RETRY: &str = "x-cloudtasks-taskretrycount";
    pub const TASK_EXECUTION: &str = "x-cloudtasks-taskexecutioncount";
}

impl InvocationCause {
    /// The event id the cause names (a `CloudEvent` id or a legacy
    /// `context.eventId`), when it names one.
    #[must_use]
    pub fn event_id(&self) -> Option<&str> {
        match self {
            Self::Firestore { event_id, .. }
            | Self::Storage { event_id, .. }
            | Self::Auth { event_id, .. }
            | Self::Pubsub { event_id, .. }
            | Self::Schedule { event_id, .. }
            | Self::Eventarc { event_id, .. } => event_id.as_deref(),
            _ => None,
        }
    }
}

impl FunctionKind {
    /// How a definition is triggered, by the official functions shell's
    /// rules (`triggerKind`), plus `Alerts` for Firebase Alerts functions.
    #[must_use]
    pub fn of(definition: &Definition) -> Self {
        if definition.task_queue_trigger().is_some() {
            return Self::Tasks;
        }
        if definition.blocking_trigger().is_some() {
            return Self::Blocking;
        }
        if definition.https_trigger().is_some() {
            let callable = definition
                .json()
                .get("labels")
                .and_then(|labels| labels.get("deployment-callable"))
                .and_then(Value::as_str)
                == Some("true");
            return if callable { Self::Callable } else { Self::Http };
        }
        if definition.schedule().is_some() || definition.json().contains_key("scheduleTrigger") {
            return Self::Schedule;
        }
        let Some(event) = definition.event_trigger() else {
            return Self::Other;
        };
        if event.get("channel").and_then(Value::as_str).is_some() {
            return Self::Eventarc;
        }
        let event_type = event.get("eventType").and_then(Value::as_str).unwrap_or("");
        if definition.service() == "firebasealerts.googleapis.com"
            || event_type.contains("firebasealerts")
        {
            Self::Alerts
        } else if event_type.contains("firestore") {
            Self::Firestore
        } else if event_type.contains("database") {
            Self::Database
        } else if event_type.contains("pubsub") {
            Self::Pubsub
        } else if event_type.contains("storage") {
            Self::Storage
        } else if event_type.contains("auth") {
            Self::Auth
        } else {
            Self::Other
        }
    }
}

/// Everything [`classify`] reads.
#[derive(Clone, Copy)]
pub struct CauseInput<'a> {
    pub definition: &'a Definition,
    pub kind: FunctionKind,
    pub project: &'a str,
    pub method: &'a str,
    /// After the function's address, with the query.
    pub path: &'a str,
    pub headers: &'a HeaderMap,
    /// The body as it arrived (read only when the headers leave the cause
    /// unknown, and only up to [`BODY_PARSE_LIMIT`]).
    pub body: &'a [u8],
}

/// The event id a request carries: `x-firenook-event-id`, else a binary
/// `CloudEvent`'s `ce-id`. One header lookup each.
#[must_use]
pub fn event_id(headers: &HeaderMap) -> Option<String> {
    cause_header(headers, headers::EVENT_ID).or_else(|| header(headers, "ce-id").map(str::to_owned))
}

/// A Cloud Tasks attempt's `(queue, task, retry count, execution count)`.
#[must_use]
pub fn task_attempt(headers: &HeaderMap) -> Option<(String, String, u32, u32)> {
    let queue = header(headers, headers::TASK_QUEUE)?;
    let task = header(headers, headers::TASK_NAME)?;
    let number = |name| {
        header(headers, name)
            .and_then(|value| value.trim().parse::<u32>().ok())
            .unwrap_or(0)
    };
    Some((
        queue.to_owned(),
        task.to_owned(),
        number(headers::TASK_RETRY),
        number(headers::TASK_EXECUTION),
    ))
}

/// Classifies an invocation's cause and writes its summary line.
#[must_use]
pub fn classify(input: &CauseInput<'_>) -> (InvocationCause, String) {
    let event_id = event_id(input.headers);
    if let Some((queue, task, retry_count, execution_count)) = task_attempt(input.headers) {
        let summary = format!("task {} · attempt {}", short_task(&task), retry_count + 1);
        return (
            InvocationCause::Task {
                queue,
                task,
                retry_count,
                execution_count,
            },
            summary,
        );
    }
    let body = || {
        (input.body.len() <= BODY_PARSE_LIMIT)
            .then(|| serde_json::from_slice::<Value>(input.body).ok())
            .flatten()
    };
    match input.kind {
        FunctionKind::Http | FunctionKind::Tasks => http(input),
        FunctionKind::Callable => callable(input),
        FunctionKind::Firestore => firestore(input, event_id, body),
        FunctionKind::Storage => storage(input, event_id, body),
        FunctionKind::Auth => auth(input, event_id, body),
        FunctionKind::Pubsub => pubsub(input, event_id, body),
        FunctionKind::Schedule => schedule(input, event_id, body),
        FunctionKind::Eventarc => eventarc(input, event_id, None, body),
        FunctionKind::Blocking => blocking(input, body),
        FunctionKind::Alerts => alert(input, body),
        FunctionKind::Database | FunctionKind::Other => {
            if input.definition.https_trigger().is_some() {
                http(input)
            } else {
                let event_type = definition_event_type(input.definition).unwrap_or_default();
                let summary = if event_type.is_empty() {
                    format!("{} {}", input.method, input.path)
                } else {
                    event_type
                };
                (InvocationCause::Unknown, summary)
            }
        }
    }
}

/// The Eventarc cause of a delivery the runtime made itself: the event's
/// attributes come from the monitor's record of it, not from the body.
#[must_use]
pub fn eventarc_delivery(
    channel: &str,
    event_type: &str,
    source: Option<&str>,
    subject: Option<&str>,
    event_id: Option<&str>,
    event: &str,
    publisher: Option<&str>,
) -> (InvocationCause, String) {
    let summary = eventarc_summary(event_type, publisher, source);
    (
        InvocationCause::Eventarc {
            channel: channel.to_owned(),
            event_type: event_type.to_owned(),
            source: source.map(str::to_owned),
            subject: subject.map(str::to_owned),
            event_id: event_id.map(str::to_owned),
            event: Some(event.to_owned()),
        },
        summary,
    )
}

/// The extension instance behind a `projects/<p>/instances/<id>` source.
#[must_use]
pub fn publisher_of(source: &str) -> Option<String> {
    let rest = source.strip_prefix("//").unwrap_or(source);
    let mut parts = rest.split('/');
    while let Some(part) = parts.next() {
        if part == "instances" {
            return parts.next().filter(|id| !id.is_empty()).map(str::to_owned);
        }
    }
    None
}

/// A sender's cause header, decoded (`%XX` back to the bytes the sender
/// wrote: a document path, an object name or an email with spaces or
/// non-ASCII characters arrive encoded).
#[must_use]
pub fn cause_header(headers: &HeaderMap, name: &str) -> Option<String> {
    header(headers, name).map(firenook_functions_bridge::cause::decode)
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn definition_event_type(definition: &Definition) -> Option<String> {
    definition
        .event_trigger()
        .and_then(|event| event.get("eventType"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn definition_resource(definition: &Definition) -> Option<String> {
    let event = definition.event_trigger()?;
    event
        .get("resource")
        .and_then(Value::as_str)
        .filter(|resource| !resource.is_empty())
        .or_else(|| {
            event
                .get("eventFilters")
                .and_then(|filters| filters.get("topic"))
                .and_then(Value::as_str)
        })
        .map(str::to_owned)
}

fn text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// The legacy envelope's context: `context` when present, else the body.
fn legacy_context(body: &Value) -> &Value {
    body.get("context").unwrap_or(body)
}

fn legacy_resource(body: &Value) -> Option<String> {
    let resource = legacy_context(body).get("resource")?;
    text(resource.get("name")).or_else(|| text(Some(resource)))
}

fn http(input: &CauseInput<'_>) -> (InvocationCause, String) {
    (
        InvocationCause::Http {
            method: input.method.to_owned(),
            path: input.path.to_owned(),
        },
        format!("{} {}", input.method, input.path),
    )
}

/// The unverified payload of a JWT (the emulators sign nothing).
fn jwt_payload(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn callable(input: &CauseInput<'_>) -> (InvocationCause, String) {
    let claims = header(input.headers, "authorization")
        .and_then(|value| {
            value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
        })
        .and_then(jwt_payload);
    let uid = claims
        .as_ref()
        .and_then(|claims| text(claims.get("user_id")).or_else(|| text(claims.get("sub"))));
    let tenant = claims
        .as_ref()
        .and_then(|claims| text(claims.pointer("/firebase/tenant")));
    let app_check = header(input.headers, "x-firebase-appcheck").is_some();
    let streaming =
        header(input.headers, "accept").is_some_and(|accept| accept.contains("text/event-stream"));
    let mut summary = uid.as_ref().map_or_else(
        || "call, no auth".to_owned(),
        |uid| format!("call as {uid}"),
    );
    if app_check {
        summary.push_str(" · App Check");
    }
    (
        InvocationCause::Callable {
            uid,
            tenant,
            app_check,
            streaming,
        },
        summary,
    )
}

/// `created`, `updated`, `deleted` or `written` from a Firestore event type.
fn firestore_change(event_type: &str) -> &'static str {
    let base = event_type
        .strip_suffix(".withAuthContext")
        .unwrap_or(event_type);
    if base.ends_with("create") || base.ends_with("created") {
        "created"
    } else if base.ends_with("update") || base.ends_with("updated") {
        "updated"
    } else if base.ends_with("delete") || base.ends_with("deleted") {
        "deleted"
    } else {
        "written"
    }
}

/// `(database, document)` from `projects/<p>/databases/<db>/documents/<path>`.
fn split_document_name(name: &str) -> Option<(String, String)> {
    let after = name.split_once("/databases/")?.1;
    let (database, rest) = after.split_once('/')?;
    let document = rest.strip_prefix("documents/").unwrap_or(rest);
    Some((database.to_owned(), document.to_owned()))
}

fn firestore(
    input: &CauseInput<'_>,
    event_id: Option<String>,
    body: impl Fn() -> Option<Value>,
) -> (InvocationCause, String) {
    let mut event_type = header(input.headers, "ce-type")
        .map(str::to_owned)
        .or_else(|| definition_event_type(input.definition))
        .unwrap_or_default();
    let mut database = cause_header(input.headers, headers::DATABASE)
        .or_else(|| header(input.headers, "ce-database").map(str::to_owned));
    let mut document = cause_header(input.headers, headers::DOCUMENT)
        .or_else(|| header(input.headers, "ce-document").map(str::to_owned));
    let mut event_id = event_id;
    let mut change = cause_header(input.headers, headers::CHANGE);
    if document.is_none()
        && let Some(body) = body()
    {
        // A legacy envelope from a sender without cause headers.
        let context = legacy_context(&body);
        if let Some((found_database, found_document)) = legacy_resource(&body)
            .as_deref()
            .and_then(split_document_name)
        {
            database.get_or_insert(found_database);
            document = Some(found_document);
        }
        if let Some(found) = text(context.get("eventType")) {
            event_type = found;
        }
        if event_id.is_none() {
            event_id = text(context.get("eventId"));
        }
        if change.is_none() && firestore_change(&event_type) == "written" {
            let data = body.get("data");
            let before = data
                .and_then(|data| data.get("oldValue"))
                .is_some_and(|value| !value.is_null());
            let after = data
                .and_then(|data| data.get("value"))
                .is_some_and(|value| !value.is_null());
            change = match (before, after) {
                (false, true) => Some("created".to_owned()),
                (true, true) => Some("updated".to_owned()),
                (true, false) => Some("deleted".to_owned()),
                (false, false) => None,
            };
        }
    }
    let document = document.unwrap_or_default();
    let word = change.unwrap_or_else(|| firestore_change(&event_type).to_owned());
    let summary = if document.is_empty() {
        format!("document {word}")
    } else {
        format!("{document} {word}")
    };
    (
        InvocationCause::Firestore {
            event_type,
            database: database.unwrap_or_else(|| "(default)".to_owned()),
            document,
            event_id,
        },
        summary,
    )
}

fn storage_word(event_type: &str) -> &'static str {
    if event_type.ends_with("finalize") || event_type.ends_with("finalized") {
        "finalized"
    } else if event_type.ends_with("delete") || event_type.ends_with("deleted") {
        "deleted"
    } else if event_type.ends_with("archive") || event_type.ends_with("archived") {
        "archived"
    } else if event_type.ends_with("metadataUpdate") || event_type.ends_with("metadataUpdated") {
        "metadata updated"
    } else {
        "changed"
    }
}

fn storage(
    input: &CauseInput<'_>,
    event_id: Option<String>,
    body: impl Fn() -> Option<Value>,
) -> (InvocationCause, String) {
    let mut event_type = definition_event_type(input.definition).unwrap_or_default();
    let mut bucket = cause_header(input.headers, headers::BUCKET);
    let mut object = cause_header(input.headers, headers::OBJECT);
    let mut event_id = event_id;
    if (bucket.is_none() || object.is_none())
        && let Some(body) = body()
    {
        let data = body.get("data");
        bucket = bucket.or_else(|| text(data.and_then(|data| data.get("bucket"))));
        object = object.or_else(|| text(data.and_then(|data| data.get("name"))));
        let context = legacy_context(&body);
        if let Some(found) = text(body.get("type")).or_else(|| text(context.get("eventType"))) {
            event_type = found;
        }
        if event_id.is_none() {
            event_id = text(body.get("id")).or_else(|| text(context.get("eventId")));
        }
    }
    let bucket = bucket.unwrap_or_default();
    let object = object.unwrap_or_default();
    let summary = format!("gs://{bucket}/{object} {}", storage_word(&event_type));
    (
        InvocationCause::Storage {
            event_type,
            bucket,
            object,
            event_id,
        },
        summary,
    )
}

fn auth(
    input: &CauseInput<'_>,
    event_id: Option<String>,
    body: impl Fn() -> Option<Value>,
) -> (InvocationCause, String) {
    let mut event_type = definition_event_type(input.definition).unwrap_or_default();
    let mut uid = cause_header(input.headers, headers::UID);
    let mut email = cause_header(input.headers, headers::EMAIL);
    let tenant = cause_header(input.headers, headers::TENANT);
    let mut event_id = event_id;
    if uid.is_none()
        && let Some(body) = body()
    {
        let data = body.get("data");
        uid = text(data.and_then(|data| data.get("uid")));
        email = email.or_else(|| text(data.and_then(|data| data.get("email"))));
        let context = legacy_context(&body);
        if let Some(found) = text(context.get("eventType")).or_else(|| text(body.get("type"))) {
            event_type = found;
        }
        if event_id.is_none() {
            event_id = text(context.get("eventId")).or_else(|| text(body.get("id")));
        }
    }
    let word = if event_type.ends_with("delete") || event_type.ends_with("deleted") {
        "deleted"
    } else {
        "created"
    };
    let mut summary = uid.as_ref().map_or_else(
        || format!("user {word}"),
        |uid| format!("user {uid} {word}"),
    );
    if let Some(email) = &email {
        summary = format!("{summary} ({email})");
    }
    (
        InvocationCause::Auth {
            event_type,
            uid,
            email,
            tenant,
            event_id,
        },
        summary,
    )
}

fn short_topic(topic: &str) -> &str {
    topic.rsplit('/').next().unwrap_or(topic)
}

/// A long task name (an auto-generated one) shortened for a summary.
fn short_task(task: &str) -> &str {
    let name = task.rsplit('/').next().unwrap_or(task);
    if name.chars().count() <= 24 {
        return name;
    }
    let start = name
        .char_indices()
        .rev()
        .nth(11)
        .map_or(0, |(index, _)| index);
    &name[start..]
}

fn topic_from_source(source: &str) -> Option<String> {
    let index = source.find("projects/")?;
    Some(source[index..].to_owned())
}

fn pubsub(
    input: &CauseInput<'_>,
    event_id: Option<String>,
    body: impl Fn() -> Option<Value>,
) -> (InvocationCause, String) {
    let mut topic = cause_header(input.headers, headers::TOPIC);
    let mut message_id = cause_header(input.headers, headers::MESSAGE);
    let mut event_id = event_id;
    if (topic.is_none() || message_id.is_none())
        && let Some(body) = body()
    {
        if body.get("specversion").is_some() || body.get("type").is_some() {
            topic = topic
                .or_else(|| text(body.get("source")).and_then(|source| topic_from_source(&source)));
            message_id = message_id.or_else(|| text(body.pointer("/data/message/messageId")));
            if event_id.is_none() {
                event_id = text(body.get("id"));
            }
        } else {
            let context = legacy_context(&body);
            topic = topic.or_else(|| legacy_resource(&body));
            if event_id.is_none() {
                event_id = text(context.get("eventId"));
            }
            message_id = message_id.or_else(|| event_id.clone());
        }
    }
    let topic = topic
        .or_else(|| definition_resource(input.definition))
        .map(|topic| {
            if topic.starts_with("projects/") {
                topic
            } else {
                format!("projects/{}/topics/{topic}", input.project)
            }
        })
        .unwrap_or_default();
    let summary = match &message_id {
        Some(id) => format!("message {id} on {}", short_topic(&topic)),
        None => format!("message on {}", short_topic(&topic)),
    };
    (
        InvocationCause::Pubsub {
            topic,
            message_id,
            event_id,
        },
        summary,
    )
}

fn schedule(
    input: &CauseInput<'_>,
    event_id: Option<String>,
    body: impl Fn() -> Option<Value>,
) -> (InvocationCause, String) {
    let mut topic = cause_header(input.headers, headers::TOPIC);
    let mut event_id = event_id;
    if (topic.is_none() || event_id.is_none())
        && let Some(body) = body()
    {
        let context = legacy_context(&body);
        topic = topic.or_else(|| legacy_resource(&body).filter(|topic| topic.contains("/topics/")));
        if event_id.is_none() {
            event_id = text(context.get("eventId")).or_else(|| text(body.get("id")));
        }
    }
    let topic = topic.unwrap_or_else(|| {
        format!(
            "projects/{}/topics/firebase-schedule-{}",
            input.project,
            input.definition.name()
        )
    });
    (
        InvocationCause::Schedule { topic, event_id },
        "scheduled tick".to_owned(),
    )
}

fn eventarc_summary(event_type: &str, publisher: Option<&str>, source: Option<&str>) -> String {
    match (publisher, source) {
        (Some(publisher), _) => format!("{event_type} from {publisher}"),
        (None, Some(source)) if !source.is_empty() => format!("{event_type} from {source}"),
        _ => event_type.to_owned(),
    }
}

fn eventarc(
    input: &CauseInput<'_>,
    event_id: Option<String>,
    event: Option<String>,
    body: impl Fn() -> Option<Value>,
) -> (InvocationCause, String) {
    let channel = input
        .definition
        .event_trigger()
        .and_then(|trigger| trigger.get("channel"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let mut event_type = header(input.headers, "ce-type")
        .map(str::to_owned)
        .or_else(|| definition_event_type(input.definition))
        .unwrap_or_default();
    let mut source = header(input.headers, "ce-source").map(str::to_owned);
    let mut subject = header(input.headers, "ce-subject").map(str::to_owned);
    let mut event_id = event_id;
    if source.is_none()
        && let Some(body) = body()
    {
        if let Some(found) = text(body.get("type")) {
            event_type = found;
        }
        source = text(body.get("source"));
        subject = subject.or_else(|| text(body.get("subject")));
        if event_id.is_none() {
            event_id = text(body.get("id"));
        }
    }
    let publisher = source.as_deref().and_then(publisher_of);
    let summary = eventarc_summary(&event_type, publisher.as_deref(), source.as_deref());
    (
        InvocationCause::Eventarc {
            channel,
            event_type,
            source,
            subject,
            event_id,
            event,
        },
        summary,
    )
}

fn blocking(input: &CauseInput<'_>, body: impl Fn() -> Option<Value>) -> (InvocationCause, String) {
    let auth_call = cause_header(input.headers, headers::AUTH_CALL);
    let mut event_type = input
        .definition
        .blocking_trigger()
        .and_then(|trigger| trigger.get("eventType"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let mut uid = cause_header(input.headers, headers::UID);
    let mut email = cause_header(input.headers, headers::EMAIL);
    let mut tenant = cause_header(input.headers, headers::TENANT);
    if uid.is_none()
        && let Some(claims) = body()
            .as_ref()
            .and_then(|body| body.pointer("/data/jwt"))
            .and_then(Value::as_str)
            .and_then(jwt_payload)
    {
        if let Some(found) = text(claims.get("event_type")) {
            event_type = found;
        }
        uid = text(claims.pointer("/user_record/uid"));
        email = email.or_else(|| text(claims.pointer("/user_record/email")));
        tenant = tenant.or_else(|| text(claims.get("tenant_id")));
    }
    let short = event_type
        .rsplit(['/', '.'])
        .next()
        .filter(|word| !word.is_empty())
        .unwrap_or("blocking call")
        .to_owned();
    let summary = match (&email, &uid) {
        (Some(email), _) => format!("{short} for {email}"),
        (None, Some(uid)) => format!("{short} for {uid}"),
        (None, None) => short,
    };
    (
        InvocationCause::Blocking {
            event_type,
            uid,
            email,
            tenant,
            auth_call,
        },
        summary,
    )
}

fn alert(input: &CauseInput<'_>, body: impl Fn() -> Option<Value>) -> (InvocationCause, String) {
    let mut alert_type = header(input.headers, "ce-alerttype").map(str::to_owned);
    let mut app_id = header(input.headers, "ce-appid").map(str::to_owned);
    if alert_type.is_none()
        && let Some(body) = body()
    {
        alert_type = text(body.get("alerttype"));
        app_id = app_id.or_else(|| text(body.get("appid")));
    }
    let alert_type = alert_type
        .or_else(|| {
            input
                .definition
                .event_trigger()
                .and_then(|event| event.get("eventFilters"))
                .and_then(|filters| filters.get("alerttype"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default();
    let summary = match &app_id {
        Some(app) => format!("{alert_type} for {app}"),
        None => alert_type.clone(),
    };
    (InvocationCause::Alert { alert_type, app_id }, summary)
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderName, HeaderValue};
    use serde_json::json;

    use super::*;

    fn definition(value: &Value) -> Definition {
        Definition::from_json(value.as_object().expect("an object").clone())
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                HeaderName::from_bytes(name.as_bytes()).expect("a header name"),
                HeaderValue::from_str(value).expect("a header value"),
            );
        }
        map
    }

    fn run(
        definition: &Definition,
        method: &str,
        path: &str,
        headers: &HeaderMap,
        body: &[u8],
    ) -> (InvocationCause, String) {
        classify(&CauseInput {
            definition,
            kind: FunctionKind::of(definition),
            project: "demo-p",
            method,
            path,
            headers,
            body,
        })
    }

    fn jwt(claims: &Value) -> String {
        let encode = |value: &Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
        };
        format!("{}.{}.", encode(&json!({"alg": "none"})), encode(claims))
    }

    fn v1_firestore() -> Definition {
        definition(
            &json!({"name": "onOrder", "platform": "gcfv1", "region": "us-central1",
            "eventTrigger": {"eventType": "providers/cloud.firestore/eventTypes/document.write",
                "resource": "projects/demo-p/databases/(default)/documents/orders/{id}"}}),
        )
    }

    #[test]
    fn kinds_follow_the_functions_shell() {
        let cases = [
            (json!({"httpsTrigger": {}}), FunctionKind::Http),
            (
                json!({"httpsTrigger": {}, "labels": {"deployment-callable": "true"}}),
                FunctionKind::Callable,
            ),
            (
                json!({"httpsTrigger": {}, "taskQueueTrigger": {}}),
                FunctionKind::Tasks,
            ),
            (
                json!({"blockingTrigger": {"eventType": "providers/cloud.auth/eventTypes/user.beforeCreate"}}),
                FunctionKind::Blocking,
            ),
            (
                json!({"eventTrigger": {"eventType": "pubsub"}, "schedule": {"schedule": "every 5 minutes"}}),
                FunctionKind::Schedule,
            ),
            (
                json!({"eventTrigger": {"eventType": "a.b", "channel": "projects/p/locations/l/channels/c"}}),
                FunctionKind::Eventarc,
            ),
            (
                json!({"eventTrigger": {"eventType": "google.cloud.firestore.document.v1.created"}}),
                FunctionKind::Firestore,
            ),
            (
                json!({"eventTrigger": {"eventType": "providers/google.firebase.database/eventTypes/ref.write"}}),
                FunctionKind::Database,
            ),
            (
                json!({"eventTrigger": {"eventType": "google.pubsub.topic.publish"}}),
                FunctionKind::Pubsub,
            ),
            (
                json!({"eventTrigger": {"eventType": "google.storage.object.finalize"}}),
                FunctionKind::Storage,
            ),
            (
                json!({"eventTrigger": {"eventType": "providers/firebase.auth/eventTypes/user.create"}}),
                FunctionKind::Auth,
            ),
            (
                json!({"eventTrigger": {"eventType": "google.firebase.firebasealerts.alerts.v1.published"}}),
                FunctionKind::Alerts,
            ),
            (
                json!({"eventTrigger": {"eventType": "google.firebase.remoteconfig.v1.updated"}}),
                FunctionKind::Other,
            ),
            (json!({}), FunctionKind::Other),
        ];
        for (value, kind) in cases {
            assert_eq!(FunctionKind::of(&definition(&value)), kind, "{value}");
        }
    }

    #[test]
    fn firestore_from_the_bridges_cause_headers() {
        let definition = v1_firestore();
        let headers = headers(&[
            (headers::DOCUMENT, "orders/o_123"),
            (headers::DATABASE, "(default)"),
            (headers::CHANGE, "created"),
            (headers::EVENT_ID, "e-1"),
        ]);
        // A large body is never read when the headers say it all.
        let body = format!("{{\"data\":\"{}\"}}", "x".repeat(200 * 1024));
        let (cause, summary) = run(&definition, "POST", "/", &headers, body.as_bytes());
        assert_eq!(
            cause,
            InvocationCause::Firestore {
                event_type: "providers/cloud.firestore/eventTypes/document.write".to_owned(),
                database: "(default)".to_owned(),
                document: "orders/o_123".to_owned(),
                event_id: Some("e-1".to_owned()),
            }
        );
        assert_eq!(summary, "orders/o_123 created");
    }

    #[test]
    fn firestore_v1_envelope_without_cause_headers() {
        let definition = v1_firestore();
        let body = json!({"data": {"value": {"name": "x"}, "updateMask": {}},
            "context": {"eventId": "e-9", "eventType": "providers/cloud.firestore/eventTypes/document.write",
                "resource": {"name": "projects/demo-p/databases/(default)/documents/orders/o_9", "service": "firestore.googleapis.com"}}});
        let (cause, summary) = run(
            &definition,
            "POST",
            "/",
            &HeaderMap::new(),
            body.to_string().as_bytes(),
        );
        assert_eq!(summary, "orders/o_9 created");
        let InvocationCause::Firestore {
            document,
            event_id,
            database,
            ..
        } = cause
        else {
            panic!("a firestore cause");
        };
        assert_eq!(document, "orders/o_9");
        assert_eq!(database, "(default)");
        assert_eq!(event_id.as_deref(), Some("e-9"));
    }

    #[test]
    fn firestore_v2_from_binary_cloudevent_headers() {
        let definition = definition(&json!({"name": "onOrder", "platform": "gcfv2",
            "eventTrigger": {"eventType": "google.cloud.firestore.document.v1.updated"}}));
        let headers = headers(&[
            ("ce-type", "google.cloud.firestore.document.v1.updated"),
            ("ce-id", "ce-77"),
            ("ce-document", "orders/o_7"),
            ("ce-database", "other"),
        ]);
        let (cause, summary) = run(&definition, "POST", "/", &headers, b"AAAA");
        assert_eq!(summary, "orders/o_7 updated");
        assert_eq!(
            cause,
            InvocationCause::Firestore {
                event_type: "google.cloud.firestore.document.v1.updated".to_owned(),
                database: "other".to_owned(),
                document: "orders/o_7".to_owned(),
                event_id: Some("ce-77".to_owned()),
            }
        );
    }

    #[test]
    fn storage_from_headers_and_from_structured_cloudevents() {
        let v2 = definition(&json!({"name": "onUpload", "platform": "gcfv2",
            "eventTrigger": {"eventType": "google.cloud.storage.object.v1.finalized", "resource": "b"}}));
        let headers_only = headers(&[
            (headers::BUCKET, "b"),
            (headers::OBJECT, "uploads/a.png"),
            (headers::EVENT_ID, "s-1"),
        ]);
        let (_, summary) = run(&v2, "POST", "/", &headers_only, b"");
        assert_eq!(summary, "gs://b/uploads/a.png finalized");
        // Senders percent-encode what is not visible ASCII.
        let encoded = firenook_functions_bridge::cause::encode("photos/été 1.png");
        assert_eq!(encoded, "photos/%C3%A9t%C3%A9%201.png");
        let (cause, summary) = run(
            &v2,
            "POST",
            "/",
            &headers(&[(headers::BUCKET, "b"), (headers::OBJECT, &encoded)]),
            b"",
        );
        assert_eq!(summary, "gs://b/photos/été 1.png finalized");
        assert!(
            matches!(&cause, InvocationCause::Storage { object, .. } if object == "photos/été 1.png"),
            "{cause:?}"
        );
        let body = json!({"specversion": "1.0", "id": "s-2", "type": "google.cloud.storage.object.v1.deleted",
            "source": "//storage.googleapis.com/projects/_/buckets/b", "data": {"bucket": "b", "name": "x.txt"}});
        let (cause, summary) = run(
            &v2,
            "POST",
            "/",
            &HeaderMap::new(),
            body.to_string().as_bytes(),
        );
        assert_eq!(summary, "gs://b/x.txt deleted");
        assert_eq!(
            cause,
            InvocationCause::Storage {
                event_type: "google.cloud.storage.object.v1.deleted".to_owned(),
                bucket: "b".to_owned(),
                object: "x.txt".to_owned(),
                event_id: Some("s-2".to_owned()),
            }
        );
    }

    #[test]
    fn auth_from_headers_and_from_the_legacy_envelope() {
        let definition = definition(&json!({"name": "onUser", "platform": "gcfv1",
            "eventTrigger": {"eventType": "providers/firebase.auth/eventTypes/user.create"}}));
        let with_headers = headers(&[
            (headers::UID, "u_1"),
            (headers::EMAIL, "ada@example.com"),
            (headers::TENANT, "t-1"),
        ]);
        let (cause, summary) = run(&definition, "POST", "/", &with_headers, b"");
        assert_eq!(summary, "user u_1 created (ada@example.com)");
        assert!(
            matches!(cause, InvocationCause::Auth { tenant: Some(ref tenant), .. } if tenant == "t-1")
        );
        let body = json!({"eventId": "a-1", "eventType": "providers/firebase.auth/eventTypes/user.delete",
            "data": {"uid": "u_2", "email": "grace@example.com"}});
        let (cause, summary) = run(
            &definition,
            "POST",
            "/",
            &HeaderMap::new(),
            body.to_string().as_bytes(),
        );
        assert_eq!(summary, "user u_2 deleted (grace@example.com)");
        assert_eq!(
            cause,
            InvocationCause::Auth {
                event_type: "providers/firebase.auth/eventTypes/user.delete".to_owned(),
                uid: Some("u_2".to_owned()),
                email: Some("grace@example.com".to_owned()),
                tenant: None,
                event_id: Some("a-1".to_owned()),
            }
        );
    }

    #[test]
    fn pubsub_from_headers_and_from_both_envelopes() {
        let v1 = definition(&json!({"name": "onEmail", "platform": "gcfv1",
            "eventTrigger": {"eventType": "google.pubsub.topic.publish", "resource": "projects/demo-p/topics/emails"}}));
        let with_headers = headers(&[
            (headers::TOPIC, "projects/demo-p/topics/emails"),
            (headers::MESSAGE, "18"),
            (headers::EVENT_ID, "18"),
        ]);
        let (cause, summary) = run(&v1, "POST", "/", &with_headers, b"");
        assert_eq!(summary, "message 18 on emails");
        assert_eq!(
            cause,
            InvocationCause::Pubsub {
                topic: "projects/demo-p/topics/emails".to_owned(),
                message_id: Some("18".to_owned()),
                event_id: Some("18".to_owned()),
            }
        );
        let legacy = json!({"context": {"eventId": "21", "eventType": "google.pubsub.topic.publish",
            "resource": {"name": "projects/demo-p/topics/emails"}}, "data": {"data": "e30="}});
        let (_, summary) = run(
            &v1,
            "POST",
            "/",
            &HeaderMap::new(),
            legacy.to_string().as_bytes(),
        );
        assert_eq!(summary, "message 21 on emails");
        let v2 = definition(&json!({"name": "onEmail", "platform": "gcfv2",
            "eventTrigger": {"eventType": "google.cloud.pubsub.topic.v1.messagePublished", "eventFilters": {"topic": "projects/demo-p/topics/emails"}}}));
        let structured = json!({"specversion": "1.0", "id": "c-3", "type": "google.cloud.pubsub.topic.v1.messagePublished",
            "source": "//pubsub.googleapis.com/projects/demo-p/topics/emails", "data": {"message": {"messageId": "33"}}});
        let (cause, summary) = run(
            &v2,
            "POST",
            "/",
            &HeaderMap::new(),
            structured.to_string().as_bytes(),
        );
        assert_eq!(summary, "message 33 on emails");
        assert!(
            matches!(cause, InvocationCause::Pubsub { event_id: Some(ref id), .. } if id == "c-3")
        );
    }

    #[test]
    fn schedule_ticks_carry_their_event_id() {
        let definition = definition(&json!({"name": "nightly", "platform": "gcfv1",
            "eventTrigger": {"eventType": "google.pubsub.topic.publish", "resource": ""}, "schedule": {"schedule": "every day 00:00"}}));
        let with_headers = headers(&[
            (
                headers::TOPIC,
                "projects/demo-p/topics/firebase-schedule-nightly",
            ),
            (headers::EVENT_ID, "t-5"),
        ]);
        let (cause, summary) = run(&definition, "POST", "/", &with_headers, b"");
        assert_eq!(summary, "scheduled tick");
        assert_eq!(
            cause,
            InvocationCause::Schedule {
                topic: "projects/demo-p/topics/firebase-schedule-nightly".to_owned(),
                event_id: Some("t-5".to_owned()),
            }
        );
        let body = json!({"context": {"eventId": "t-6", "resource": {"name": "projects/demo-p/topics/firebase-schedule-nightly"}}});
        let (cause, _) = run(
            &definition,
            "POST",
            "/",
            &HeaderMap::new(),
            body.to_string().as_bytes(),
        );
        assert!(
            matches!(cause, InvocationCause::Schedule { event_id: Some(ref id), .. } if id == "t-6")
        );
    }

    #[test]
    fn eventarc_from_a_structured_event_and_from_the_runtime() {
        let definition = definition(&json!({"name": "onGreeted", "platform": "gcfv2",
            "eventTrigger": {"eventType": "test.greeter.v1.greeted", "channel": "projects/demo-p/locations/us-central1/channels/firebase"}}));
        let body = json!({"specversion": "1.0", "id": "g-1", "type": "test.greeter.v1.greeted",
            "source": "projects/demo-p/instances/greeter", "subject": "ada", "data": {}});
        let (cause, summary) = run(
            &definition,
            "POST",
            "/",
            &HeaderMap::new(),
            body.to_string().as_bytes(),
        );
        assert_eq!(summary, "test.greeter.v1.greeted from greeter");
        assert_eq!(
            cause,
            InvocationCause::Eventarc {
                channel: "projects/demo-p/locations/us-central1/channels/firebase".to_owned(),
                event_type: "test.greeter.v1.greeted".to_owned(),
                source: Some("projects/demo-p/instances/greeter".to_owned()),
                subject: Some("ada".to_owned()),
                event_id: Some("g-1".to_owned()),
                event: None,
            }
        );
        let (cause, summary) = eventarc_delivery(
            "google",
            "a.b",
            Some("//x/y"),
            None,
            Some("i"),
            "abc123-4",
            None,
        );
        assert_eq!(summary, "a.b from //x/y");
        assert!(
            matches!(cause, InvocationCause::Eventarc { event: Some(ref event), .. } if event == "abc123-4")
        );
        assert_eq!(
            publisher_of("projects/p/instances/greeter").as_deref(),
            Some("greeter")
        );
        assert_eq!(
            publisher_of("//pubsub.googleapis.com/projects/p/topics/t"),
            None
        );
    }

    #[test]
    fn task_headers_name_the_attempt() {
        let definition =
            definition(&json!({"name": "resize", "httpsTrigger": {}, "taskQueueTrigger": {}}));
        let headers = headers(&[
            ("X-CloudTasks-QueueName", "queue:demo-p-us-central1-resize"),
            ("X-CloudTasks-TaskName", "7891"),
            ("X-CloudTasks-TaskRetryCount", "1"),
            ("X-CloudTasks-TaskExecutionCount", "2"),
        ]);
        let (cause, summary) = run(&definition, "POST", "/", &headers, b"{}");
        assert_eq!(summary, "task 7891 · attempt 2");
        assert_eq!(
            cause,
            InvocationCause::Task {
                queue: "queue:demo-p-us-central1-resize".to_owned(),
                task: "7891".to_owned(),
                retry_count: 1,
                execution_count: 2,
            }
        );
        assert_eq!(
            task_attempt(&headers),
            Some((
                "queue:demo-p-us-central1-resize".to_owned(),
                "7891".to_owned(),
                1,
                2
            ))
        );
    }

    #[test]
    fn callables_read_the_bearer_and_app_check() {
        let definition = definition(
            &json!({"name": "addMessage", "httpsTrigger": {}, "labels": {"deployment-callable": "true"}}),
        );
        let token = jwt(&json!({"sub": "u_1", "user_id": "u_1", "firebase": {"tenant": "t-1"}}));
        let signed_in = headers(&[
            ("authorization", &format!("Bearer {token}")),
            ("x-firebase-appcheck", "token"),
            ("accept", "text/event-stream"),
        ]);
        let (cause, summary) = run(&definition, "POST", "/", &signed_in, b"{\"data\":{}}");
        assert_eq!(summary, "call as u_1 · App Check");
        assert_eq!(
            cause,
            InvocationCause::Callable {
                uid: Some("u_1".to_owned()),
                tenant: Some("t-1".to_owned()),
                app_check: true,
                streaming: true,
            }
        );
        let (cause, summary) = run(
            &definition,
            "POST",
            "/",
            &HeaderMap::new(),
            b"{\"data\":{}}",
        );
        assert_eq!(summary, "call, no auth");
        assert!(matches!(
            cause,
            InvocationCause::Callable {
                uid: None,
                app_check: false,
                ..
            }
        ));
    }

    #[test]
    fn blocking_calls_read_the_jwt_and_the_auth_call() {
        let definition = definition(&json!({"name": "beforeCreate",
            "blockingTrigger": {"eventType": "providers/cloud.auth/eventTypes/user.beforeCreate"}}));
        let token = jwt(
            &json!({"event_type": "providers/cloud.auth/eventTypes/user.beforeCreate",
            "user_record": {"uid": "u_9", "email": "ada@blocked.test"}, "tenant_id": "t-2"}),
        );
        let body = json!({"data": {"jwt": token}});
        let headers = headers(&[(headers::AUTH_CALL, "c_42")]);
        let (cause, summary) = run(
            &definition,
            "POST",
            "/",
            &headers,
            body.to_string().as_bytes(),
        );
        assert_eq!(summary, "beforeCreate for ada@blocked.test");
        assert_eq!(
            cause,
            InvocationCause::Blocking {
                event_type: "providers/cloud.auth/eventTypes/user.beforeCreate".to_owned(),
                uid: Some("u_9".to_owned()),
                email: Some("ada@blocked.test".to_owned()),
                tenant: Some("t-2".to_owned()),
                auth_call: Some("c_42".to_owned()),
            }
        );
    }

    #[test]
    fn plain_http_keeps_its_method_and_query() {
        let definition = definition(&json!({"name": "api", "httpsTrigger": {}}));
        let (cause, summary) = run(&definition, "GET", "/hello?x=1", &HeaderMap::new(), b"");
        assert_eq!(summary, "GET /hello?x=1");
        assert_eq!(
            cause,
            InvocationCause::Http {
                method: "GET".to_owned(),
                path: "/hello?x=1".to_owned(),
            }
        );
    }

    #[test]
    fn alerts_read_their_attributes() {
        let definition = definition(&json!({"name": "onFatal", "platform": "gcfv2",
            "eventTrigger": {"eventType": "google.firebase.firebasealerts.alerts.v1.published", "eventFilters": {"alerttype": "crashlytics.newFatalIssue"}}}));
        let body = json!({"type": "google.firebase.firebasealerts.alerts.v1.published", "alerttype": "crashlytics.newFatalIssue", "appid": "1:123:web:abc"});
        let (cause, summary) = run(
            &definition,
            "POST",
            "/",
            &HeaderMap::new(),
            body.to_string().as_bytes(),
        );
        assert_eq!(summary, "crashlytics.newFatalIssue for 1:123:web:abc");
        assert_eq!(
            cause,
            InvocationCause::Alert {
                alert_type: "crashlytics.newFatalIssue".to_owned(),
                app_id: Some("1:123:web:abc".to_owned()),
            }
        );
    }

    #[test]
    fn a_large_body_of_a_header_less_sender_is_not_parsed() {
        let definition = v1_firestore();
        let filler = "x".repeat(BODY_PARSE_LIMIT);
        let body = json!({"data": {"value": {"name": filler}}, "context": {"eventId": "e",
            "resource": {"name": "projects/demo-p/databases/(default)/documents/orders/o_1"}}});
        let (cause, summary) = run(
            &definition,
            "POST",
            "/",
            &HeaderMap::new(),
            body.to_string().as_bytes(),
        );
        assert_eq!(summary, "document written");
        assert!(
            matches!(cause, InvocationCause::Firestore { ref document, .. } if document.is_empty())
        );
        assert_eq!(event_id(&HeaderMap::new()), None);
    }
}
