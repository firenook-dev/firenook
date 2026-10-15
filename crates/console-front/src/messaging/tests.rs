//! The messaging sections as the console assembles them: bindings, the
//! late runtimes, absent sections, the live topics, badges, summaries and
//! clears. Route-by-route behaviour is in `pubsub/tests.rs` and
//! `tasks/tests.rs`; this file also holds the harness both use.

#![allow(
    clippy::too_many_lines,
    reason = "each test walks one scenario end to end against a real runtime"
)]

use std::collections::BTreeMap;
use std::time::Duration;

use axum::body::{Body, Bytes, to_bytes};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, Request, StatusCode};
use firenook_functions_bridge::{
    DispatchRequest, FunctionsInventory, TriggerObserver, TriggerRegistry,
};
use firenook_functions_runtime::monitor::{
    FunctionKind, InvocationCause, InvocationEnd, InvocationOrigin, InvocationStart,
    InvocationTarget, InvocationToken,
};
use firenook_pubsub_front::google::pubsub::v1::{
    DeadLetterPolicy, PubsubMessage, Subscription, Topic,
};
use firenook_suite_front::{RingBudget, ServiceInfo, SuiteDirectory};
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tower::ServiceExt as _;

use super::*;
use crate::foreign::ForeignProjects;
use crate::instance::Instance;
use crate::live::badges::BadgeBoard;
use crate::live::{ResetReason, TopicEvent};
use crate::section::AbsentReason;
use crate::{ConsoleServices, console_router};

/// The project every messaging test runs in.
pub(crate) const PROJECT: &str = "demo-console";
/// The synthetic topic of the test inventory's schedule.
pub(crate) const SCHEDULE_TOPIC: &str =
    "projects/demo-console/topics/firebase-schedule-nightlyCleanup";
/// The topic the test inventory's function listens on.
pub(crate) const ORDERS: &str = "projects/demo-console/topics/orders";
/// The queue the test inventory registers (its default URI refuses
/// connections: port 1).
pub(crate) const PROCESS_ORDER: &str = "queue:demo-console-us-central1-processOrder";

/// A Functions inventory with one function on `orders`, one schedule and
/// one task queue.
pub(crate) fn inventory() -> FunctionsInventory {
    FunctionsInventory::from_backends_json(
        &json!({
            "backends": [{
                "functionTriggers": [
                    {
                        "name": "onOrderPlaced",
                        "region": "us-central1",
                        "platform": "gcfv2",
                        "eventTrigger": {
                            "eventType": "google.cloud.pubsub.topic.v1.messagePublished",
                            "resource": ORDERS,
                        },
                    },
                    {
                        "name": "nightlyCleanup",
                        "region": "us-central1",
                        "platform": "gcfv2",
                        "schedule": { "schedule": "every 5 minutes" },
                    },
                    {
                        "name": "processOrder",
                        "region": "us-central1",
                        "platform": "gcfv2",
                        "taskQueueTrigger": { "retryConfig": { "maxAttempts": 0 } },
                    },
                ],
            }],
        }),
        1,
    )
    .expect("inventory")
}

/// A console over real Pub/Sub and Cloud Tasks runtimes.
pub(crate) struct Suite {
    pub(crate) router: Router,
    pub(crate) pubsub: PubsubConsole,
    pub(crate) tasks: TasksConsole,
    pub(crate) background: TriggerRegistry,
    pub(crate) deliveries: mpsc::UnboundedReceiver<DispatchRequest>,
    pub(crate) jobs: JobRegistry,
    pub(crate) stop: watch::Sender<bool>,
}

impl Suite {
    /// Sends one request to the console, JSON in and out.
    pub(crate) async fn call(
        &self,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        call(&self.router, method, uri, body).await
    }

    /// Waits for a job to finish, answering its final state.
    pub(crate) async fn finished(&self, id: &str) -> Value {
        for _ in 0..400 {
            let (status, job) = self
                .call(Method::GET, &format!("/api/v1/jobs/{id}"), None)
                .await;
            assert_eq!(status, StatusCode::OK, "{job}");
            if job["state"] != "running" {
                return job;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("job {id} did not finish");
    }
}

/// Sends one request to `router`, JSON in and out.
pub(crate) async fn call(
    router: &Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if body.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    let request = builder
        .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
        .expect("request");
    let response = router.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn directory() -> SuiteDirectory {
    SuiteDirectory::new(
        PROJECT,
        [ServiceInfo::listening("hub", "127.0.0.1", 34_400)],
    )
    .expect("directory")
}

/// Real runtimes for `inventory()`, handed to a console; `monitor` stands
/// for compute's record when the test needs one.
pub(crate) fn suite(monitor: Option<Monitor>) -> Suite {
    let background = TriggerRegistry::default();
    let (observer, deliveries) = TriggerObserver::channel(background.clone());
    let inventory = inventory();
    let runtime =
        firenook_pubsub_front::router(PROJECT, &inventory, observer.queue(), background.clone());
    let pubsub = PubsubConsole::new(runtime.application(), runtime, monitor.clone());
    let tasks_runtime = TasksRuntime::new(
        PROJECT,
        &inventory,
        "http://127.0.0.1:1",
        firenook_tasks_front::LogSink::new(|_| {}),
    );
    let tasks = TasksConsole::new(tasks_runtime.application(), tasks_runtime, monitor);
    let (stop, receiver) = watch::channel(false);
    let pubsub_late = Late::pending("Pub/Sub");
    pubsub_late.set(pubsub.clone());
    let tasks_late = Late::pending("Cloud Tasks");
    tasks_late.set(tasks.clone());
    let jobs = JobRegistry::new();
    let router = console_router(ConsoleServices {
        pubsub: Some(pubsub_late),
        tasks: Some(tasks_late),
        jobs: jobs.clone(),
        ..ConsoleServices::new(directory(), Shutdown::new(receiver))
    });
    Suite {
        router,
        pubsub,
        tasks,
        background,
        deliveries,
        jobs,
        stop,
    }
}

/// What a section is given, with a stop signal the test holds.
pub(crate) fn context(stop: &watch::Sender<bool>) -> SectionContext {
    SectionContext {
        project: Arc::from(PROJECT),
        shutdown: Shutdown::new(stop.subscribe()),
        badges: BadgeBoard::default(),
        instance: Instance::new(),
        jobs: JobRegistry::new(),
        rings: RingBudget::shared(),
        foreign: ForeignProjects::default(),
    }
}

/// The topic named `name` of `topics`.
pub(crate) fn topic(topics: &[Arc<dyn LiveTopic>], name: &str) -> Arc<dyn LiveTopic> {
    topics
        .iter()
        .find(|topic| topic.name() == name)
        .cloned()
        .unwrap_or_else(|| panic!("a topic named {name}"))
}

/// The next event of a topic stream, within five seconds.
pub(crate) async fn next(stream: &mut crate::live::TopicStream) -> TopicEvent {
    tokio::time::timeout(Duration::from_secs(5), stream.next())
        .await
        .expect("an event within five seconds")
        .expect("the stream goes on")
}

/// An event's name and data.
pub(crate) fn event(event: &TopicEvent) -> (&'static str, Value) {
    match event {
        TopicEvent::Event { name, data, .. } => {
            (name, serde_json::from_str(data).expect("event data"))
        }
        other => panic!("an event, not {other:?}"),
    }
}

pub(crate) fn create_topic(console: &PubsubConsole, name: &str) {
    console
        .runtime
        .broker()
        .create_topic(Topic {
            name: name.to_owned(),
            ..Topic::default()
        })
        .expect("topic");
}

pub(crate) fn create_subscription(console: &PubsubConsole, name: &str, topic: &str) {
    console
        .runtime
        .broker()
        .create_subscription(Subscription {
            name: name.to_owned(),
            topic: topic.to_owned(),
            ..Subscription::default()
        })
        .expect("subscription");
}

/// Compute's side of one invocation: begun with the headers its request
/// arrived with and the cause its classifier read from them, as the
/// Functions runtime records it.
pub(crate) fn begin_invocation<'h>(
    monitor: &Monitor,
    function_id: &str,
    kind: FunctionKind,
    cause: InvocationCause,
    headers: impl IntoIterator<Item = (&'h str, &'h str)>,
    body: &[u8],
) -> InvocationToken {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        map.append(
            HeaderName::from_bytes(name.as_bytes()).expect("header name"),
            HeaderValue::from_str(value).expect("header value"),
        );
    }
    monitor.begin(InvocationStart {
        function_id: function_id.to_owned(),
        codebase: "default".to_owned(),
        kind,
        origin: InvocationOrigin::Emulator,
        cause,
        summary: "POST /".to_owned(),
        target: InvocationTarget::Trigger,
        method: "POST".to_owned(),
        path: "/".to_owned(),
        headers: map,
        body: Bytes::copy_from_slice(body),
        replay_of: None,
        delivery: None,
    })
}

/// The handler answered `status`; `error` is what it threw.
pub(crate) fn finish_invocation(
    monitor: &Monitor,
    token: &InvocationToken,
    status: u16,
    error: Option<&str>,
) {
    monitor.response_head(token, status, &HeaderMap::new());
    monitor.finish(
        token,
        InvocationEnd {
            error: error.map(str::to_owned),
            ..InvocationEnd::default()
        },
    );
}

/// [`begin_invocation`] for a Pub/Sub dispatch to `function_id`, with the
/// headers the delivery queue sends it with and the cause they name.
pub(crate) fn begin_dispatch(
    monitor: &Monitor,
    function_id: &str,
    kind: FunctionKind,
    dispatch: &DispatchRequest,
) -> InvocationToken {
    let header = |name: &str| {
        dispatch
            .headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| firenook_functions_bridge::cause::decode(value))
    };
    let topic = header(firenook_functions_bridge::cause::TOPIC).expect("the topic header");
    let event_id = Some(dispatch.event_id.clone());
    let cause = if kind == FunctionKind::Schedule {
        InvocationCause::Schedule { topic, event_id }
    } else {
        InvocationCause::Pubsub {
            topic,
            message_id: header(firenook_functions_bridge::cause::MESSAGE),
            event_id,
        }
    };
    begin_invocation(
        monitor,
        function_id,
        kind,
        cause,
        dispatch
            .headers
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
        &dispatch.body,
    )
}

pub(crate) fn publish(console: &PubsubConsole, topic: &str, data: &str) -> u64 {
    let (ids, published) = console
        .runtime
        .broker()
        .publish(
            topic,
            vec![PubsubMessage {
                data: data.as_bytes().to_vec(),
                ..PubsubMessage::default()
            }],
        )
        .expect("publish");
    console.runtime.deliver_to_functions(&published);
    ids[0].parse().expect("id")
}

// ------------------------------------------------------------ R-CF-01

#[test]
fn messaging_bindings_are_exported() {
    let out = std::env::temp_dir().join(format!(
        "firenook-messaging-bindings-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&out);
    export_bindings(&ts_rs::Config::new().with_out_dir(&out));
    let directory = out.join("messaging");
    let names: Vec<String> = std::fs::read_dir(&directory)
        .expect("generated/messaging")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(names.len() > 100, "{} files", names.len());
    for name in &names {
        assert!(
            ["Pubsub", "Tasks", "Messaging"]
                .iter()
                .any(|prefix| name.starts_with(prefix)),
            "{name} carries its family's prefix"
        );
    }
    let read = |name: &str| std::fs::read_to_string(directory.join(name)).expect(name);
    assert!(
        read("PubsubTopicSummary.ts").contains("subscriptions: Array<PubsubSubscriptionSummary>")
    );
    assert!(read("TasksTaskRow.ts").contains("state: TasksTaskState"));
    // A flattened page keeps its root types, imported across directories.
    let page = read("PubsubRejectedList.ts");
    assert!(page.contains("from \"../Total\""), "{page}");
    assert!(page.contains("items: Array<PubsubRejected>"), "{page}");
    assert!(read("PubsubFunctionTarget.ts").contains("from \"../EntityRef\""));
    let _ = std::fs::remove_dir_all(&out);
}

// ------------------------------------------------------------ R-CF-02

#[tokio::test]
async fn routes_answer_starting_until_the_runtime_is_set() {
    let (stop, receiver) = watch::channel(false);
    let pubsub = Late::pending("Pub/Sub");
    let router = console_router(ConsoleServices {
        pubsub: Some(pubsub.clone()),
        ..ConsoleServices::new(directory(), Shutdown::new(receiver))
    });
    let (status, body) = call(&router, Method::GET, "/api/v1/pubsub/topics", None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "starting");
    assert_eq!(body["error"]["message"], "Pub/Sub is still starting.");
    assert!(body["error"]["fix"].is_string());
    let (_, status_body) = call(&router, Method::GET, "/api/v1/status", None).await;
    let section = status_body["sections"]
        .as_array()
        .expect("sections")
        .iter()
        .find(|section| section["id"] == "pubsub")
        .expect("pubsub")
        .clone();
    assert_eq!(section["state"], "starting");
    assert_eq!(section["detail"], PUBSUB_STARTING);

    // A topic subscribed before the runtime arrives delivers after it.
    let section = PubsubSection::new(pubsub.clone());
    let topics = section.topics(&context(&stop));
    let mut counters = topic(&topics, "pubsub.counters")
        .open(&json!({}), None)
        .expect("open");
    let (events, mut arrivals) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(event) = counters.next().await {
            if events.send(event).is_err() {
                break;
            }
        }
    });
    let console = test_pubsub_console(Router::new());
    pubsub.set(console.clone());
    let (status, _) = call(&router, Method::GET, "/api/v1/pubsub/topics", None).await;
    assert_eq!(status, StatusCode::OK);
    // The waiting stream opens with the state where the runtime arrived,
    // and goes on from there.
    let (name, opening) = event(&arrival(&mut arrivals).await);
    assert_eq!(name, "counters");
    assert!(opening["revision"].is_u64(), "{opening}");
    create_topic(&console, "projects/demo-console/topics/late");
    let (name, data) = event(&arrival(&mut arrivals).await);
    assert_eq!(name, "resources");
    assert_eq!(data["kinds"], json!(["topics"]));
    drop(stop);
}

/// The next event a spawned stream passed on, within five seconds.
async fn arrival(arrivals: &mut mpsc::UnboundedReceiver<TopicEvent>) -> TopicEvent {
    tokio::time::timeout(Duration::from_secs(5), arrivals.recv())
        .await
        .expect("an event")
        .expect("the stream goes on")
}

#[tokio::test]
async fn a_topic_ends_when_the_suite_stops_before_the_runtime_arrives() {
    let (stop, _receiver) = watch::channel(false);
    let section = PubsubSection::new(Late::pending("Pub/Sub"));
    let topics = section.topics(&context(&stop));
    let mut counters = topic(&topics, "pubsub.counters")
        .open(&json!({}), None)
        .expect("open");
    stop.send(true).expect("stop");
    match next(&mut counters).await {
        TopicEvent::End(Some(error)) => {
            assert_eq!(error.message, "The engine stopped before Pub/Sub started.");
        }
        other => panic!("an end, not {other:?}"),
    }
}

// ------------------------------------------------------------ R-CF-03

#[tokio::test]
async fn an_absent_section_says_why() {
    let reason = AbsentReason {
        kind: crate::section::AbsentKind::ExcludedByOnly,
        detail:
            "This engine was started with --only firestore,functions, which leaves Pub/Sub out."
                .to_owned(),
        fixes: vec![crate::section::SectionFix {
            label: "Start with Pub/Sub".to_owned(),
            kind: crate::section::SectionFixKind::Command,
            text: "firenook start --only firestore,functions,pubsub".to_owned(),
        }],
    };
    let (_stop, receiver) = watch::channel(false);
    let router = console_router(ConsoleServices {
        absent: BTreeMap::from([("pubsub".to_owned(), reason.clone())]),
        ..ConsoleServices::new(directory(), Shutdown::new(receiver))
    });
    let (_, status) = call(&router, Method::GET, "/api/v1/status", None).await;
    let pubsub = status["sections"]
        .as_array()
        .expect("sections")
        .iter()
        .find(|section| section["id"] == "pubsub")
        .expect("pubsub")
        .clone();
    assert_eq!(pubsub["state"], "absent");
    assert_eq!(pubsub["reason"], "excluded-by-only");
    assert_eq!(pubsub["detail"], reason.detail);
    assert_eq!(pubsub["fixes"][0]["text"], reason.fixes[0].text);
    // Its routes are not there, and neither are its topics.
    let (status, body) = call(&router, Method::GET, "/api/v1/pubsub/topics", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let refusal = live_refusal(&router, "pubsub.counters").await;
    assert_eq!(refusal["error"]["code"], "invalid-argument", "{refusal}");
    assert_eq!(
        refusal["error"]["fix"], "Start the engine with Pub/Sub.",
        "{refusal}"
    );
}

/// The refusal a live connection gets subscribing to `topic`.
async fn live_refusal(router: &Router, topic: &str) -> Value {
    let response = router
        .clone()
        .oneshot(
            Request::get("/api/v1/live")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body().into_data_stream();
    let mut buffer = String::new();
    let connection = loop {
        let chunk = tokio::time::timeout(Duration::from_secs(5), body.next())
            .await
            .expect("hello")
            .expect("bytes")
            .expect("chunk");
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        if let Some(start) = buffer.find("\"connection\":\"") {
            let rest = &buffer[start + 14..];
            if let Some(end) = rest.find('"') {
                break rest[..end].to_owned();
            }
        }
    };
    let (status, answer) = call(
        router,
        Method::POST,
        &format!("/api/v1/live/{connection}/subscriptions"),
        Some(json!({ "add": [{ "id": "s1", "topic": topic, "params": {} }] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    answer["refused"][0].clone()
}

// ------------------------------------------------------------ R-CF-08

#[tokio::test]
async fn messaging_topics_on_the_hub() {
    let suite = suite(None);
    let section = PubsubSection::new({
        let late = Late::pending("Pub/Sub");
        late.set(suite.pubsub.clone());
        late
    });
    let topics = section.topics(&context(&suite.stop));
    let counters = topic(&topics, "pubsub.counters");
    // Unknown parameters are refused.
    let error = counters
        .open(&json!({ "nope": 1 }), None)
        .err()
        .expect("refused");
    assert_eq!(
        error.detail().code,
        crate::api_error::ErrorCode::InvalidArgument
    );
    // An equal cursor resumes with nothing; an older one with a gap.
    let (_, index) = suite.call(Method::GET, "/api/v1/pubsub/topics", None).await;
    let revision = index["revision"].as_u64().expect("revision");
    let mut stale = counters
        .open(&json!({}), Some(&(revision.saturating_sub(1)).to_string()))
        .expect("open");
    assert!(matches!(
        next(&mut stale).await,
        TopicEvent::Reset {
            reason: ResetReason::Gap,
            ..
        }
    ));
    let mut fresh = counters
        .open(
            &json!({ "throughput": [ORDERS] }),
            Some(&revision.to_string()),
        )
        .expect("open");
    let workers = "projects/demo-console/subscriptions/workers";
    create_subscription(&suite.pubsub, workers, ORDERS);
    let (name, data) = event(&next(&mut fresh).await);
    assert_eq!(name, "resources");
    assert_eq!(data["kinds"], json!(["subscriptions"]));
    // Many publishes inside one pacing window are one frame.
    for index in 0..1_000 {
        publish(&suite.pubsub, ORDERS, &format!("m{index}"));
    }
    let mut frames = 0;
    let mut backlog = 0;
    while backlog < 1_000 {
        match next(&mut fresh).await {
            TopicEvent::Event {
                name: "counters",
                data,
                ..
            } => {
                frames += 1;
                let frame: Value = serde_json::from_str(&data).expect("frame");
                if let Some(counters) =
                    frame["subscriptions"].as_array().and_then(|subscriptions| {
                        subscriptions.iter().find(|entry| entry["name"] == workers)
                    })
                {
                    backlog = counters["backlog"].as_u64().unwrap_or(0);
                }
                if let Some(window) = frame["throughput"]
                    .as_array()
                    .and_then(|windows| windows.first())
                {
                    assert_eq!(window["topic"], ORDERS);
                }
            }
            TopicEvent::Event { .. } => {}
            other => panic!("{other:?}"),
        }
    }
    assert!(frames <= 3, "{frames} frames for one burst");

    // pubsub.topic: its own topic's ids only, keys coalesced.
    let mut watcher = topic(&topics, "pubsub.topic")
        .open(&json!({ "topic": ORDERS, "subscription": workers }), None)
        .expect("open");
    let other = "projects/demo-console/topics/other";
    create_topic(&suite.pubsub, other);
    publish(&suite.pubsub, other, "elsewhere");
    let id = publish(&suite.pubsub, ORDERS, "here");
    loop {
        let (name, data) = event(&next(&mut watcher).await);
        if name == "published" {
            assert_eq!(data["ids"], json!([id.to_string()]));
            assert_eq!(data["latestId"], id.to_string());
            break;
        }
    }
    // A pull moves backlog rows: their keys come back, old and new, with
    // the messages whose marks moved.
    let _ = suite
        .pubsub
        .runtime
        .broker()
        .pull(workers, 2)
        .expect("pull");
    let mut keys: Vec<String> = Vec::new();
    while keys
        .iter()
        .filter(|key| key.starts_with("backlog:0."))
        .count()
        < 2
    {
        let (name, data) = event(&next(&mut watcher).await);
        if name == "stale" {
            keys.extend(
                data["keys"]
                    .as_array()
                    .expect("keys")
                    .iter()
                    .filter_map(|key| key.as_str().map(str::to_owned)),
            );
        }
    }
    // Each leased row's old place (available) and new one (outstanding),
    // and the message whose mark moved.
    assert!(keys.iter().any(|key| key == "backlog:1.1.1"), "{keys:?}");
    assert!(keys.iter().any(|key| key == "message:1"), "{keys:?}");
    // More than 1,000 keys in one window is a reset.
    let _ = suite
        .pubsub
        .runtime
        .broker()
        .pull(workers, 900)
        .expect("pull");
    loop {
        match next(&mut watcher).await {
            TopicEvent::Reset { .. } => break,
            TopicEvent::Event { .. } => {}
            other @ TopicEvent::End(_) => panic!("{other:?}"),
        }
    }
    suite.stop.send(true).expect("stop");
}

/// A state topic's subscriber without a cursor (a page that just loaded, a
/// tab shown again, a browser's first subscriber the channel then shares)
/// opens with the state; with the current cursor it resumes with nothing.
#[tokio::test]
async fn the_counters_topics_open_with_their_state() {
    let suite = suite(None);
    let pubsub = PubsubSection::new({
        let late = Late::pending("Pub/Sub");
        late.set(suite.pubsub.clone());
        late
    });
    let tasks = TasksSection::new({
        let late = Late::pending("Cloud Tasks");
        late.set(suite.tasks.clone());
        late
    });
    let workers = "projects/demo-console/subscriptions/opening-workers";
    create_subscription(&suite.pubsub, workers, ORDERS);
    publish(&suite.pubsub, ORDERS, "one");
    publish(&suite.pubsub, ORDERS, "two");
    let topics = pubsub.topics(&context(&suite.stop));
    let counters = topic(&topics, "pubsub.counters");
    let mut opened = counters
        .open(&json!({ "throughput": [ORDERS] }), None)
        .expect("open");
    let first = next(&mut opened).await;
    let TopicEvent::Event {
        name: "counters",
        cursor: Some(cursor),
        ..
    } = &first
    else {
        panic!("the opening state, not {first:?}");
    };
    let (_, frame) = event(&first);
    // Its revision is the cursor it carries, and the index's.
    assert_eq!(cursor.parse::<u64>().ok(), frame["revision"].as_u64());
    let (_, index) = suite.call(Method::GET, "/api/v1/pubsub/topics", None).await;
    assert_eq!(frame["revision"], index["revision"]);
    let orders = frame["topics"]
        .as_array()
        .and_then(|topics| topics.iter().find(|entry| entry["name"] == ORDERS))
        .expect("the topic");
    assert_eq!(orders["published"], 2);
    let backlog = frame["subscriptions"]
        .as_array()
        .and_then(|subscriptions| subscriptions.iter().find(|entry| entry["name"] == workers))
        .expect("the subscription");
    assert_eq!(backlog["backlog"], 2);
    assert_eq!(frame["throughput"][0]["topic"], ORDERS);
    // A subscriber at the current revision gets nothing until a change.
    let mut current = counters
        .open(&json!({}), Some(&frame["revision"].to_string()))
        .expect("open");
    assert!(
        tokio::time::timeout(Duration::from_millis(400), current.next())
            .await
            .is_err(),
        "nothing to say at the current revision"
    );
    publish(&suite.pubsub, ORDERS, "three");
    let (name, frame) = event(&next(&mut current).await);
    assert_eq!(name, "counters");
    assert!(
        frame["topics"].as_array().is_some_and(|topics| topics
            .iter()
            .any(|entry| entry["name"] == ORDERS && entry["published"] == 3)),
        "{frame}"
    );

    // Cloud Tasks: every queue of the project, the official figures left out.
    let topics = tasks.topics(&context(&suite.stop));
    let mut opened = topic(&topics, "tasks.counters")
        .open(&json!({}), None)
        .expect("open");
    let (name, frame) = event(&next(&mut opened).await);
    assert_eq!(name, "counters");
    let queues = frame["queues"].as_array().expect("queues");
    assert!(
        queues.iter().any(|queue| queue["key"] == PROCESS_ORDER),
        "{frame}"
    );
    assert!(
        queues.iter().all(|queue| queue["official"].is_null()),
        "{frame}"
    );
    let (_, list) = suite.call(Method::GET, "/api/v1/tasks/queues", None).await;
    assert_eq!(frame["revision"], list["revision"]);
    suite.stop.send(true).expect("stop");
}

#[tokio::test]
async fn the_push_feed_replays_what_a_reconnect_missed() {
    let suite = suite(None);
    // An endpoint that refuses: every push fails into one streak.
    let endpoint = "http://127.0.0.1:1/push";
    let pushed = "projects/demo-console/subscriptions/pushed";
    create_topic(&suite.pubsub, "projects/demo-console/topics/pushes");
    suite
        .pubsub
        .runtime
        .broker()
        .create_subscription(Subscription {
            name: pushed.to_owned(),
            topic: "projects/demo-console/topics/pushes".to_owned(),
            push_config: Some(firenook_pubsub_front::google::pubsub::v1::PushConfig {
                push_endpoint: endpoint.to_owned(),
                ..Default::default()
            }),
            ..Subscription::default()
        })
        .expect("push subscription");
    let section = PubsubSection::new({
        let late = Late::pending("Pub/Sub");
        late.set(suite.pubsub.clone());
        late
    });
    let topics = section.topics(&context(&suite.stop));
    let push = topic(&topics, "pubsub.push");
    let mut first = push
        .open(&json!({ "subscription": pushed }), None)
        .expect("open");
    let id = publish(&suite.pubsub, "projects/demo-console/topics/pushes", "x");
    let cursor = loop {
        match next(&mut first).await {
            TopicEvent::Event {
                name: "attempts",
                cursor,
                data,
            } => {
                let data: Value = serde_json::from_str(&data).expect("data");
                assert_eq!(data["items"][0]["messageId"], id.to_string());
                assert_eq!(data["items"][0]["subscription"], pushed);
                break cursor.expect("a cursor").to_string();
            }
            TopicEvent::Event { .. } => {}
            other => panic!("{other:?}"),
        }
    };
    drop(first);
    // Another message's streak while disconnected, replayed on resume.
    let missed = publish(&suite.pubsub, "projects/demo-console/topics/pushes", "y");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut resumed = push
        .open(&json!({ "subscription": pushed }), Some(&cursor))
        .expect("open");
    loop {
        if let TopicEvent::Event {
            name: "attempts",
            data,
            ..
        } = next(&mut resumed).await
        {
            let data: Value = serde_json::from_str(&data).expect("data");
            let ids: Vec<&str> = data["items"]
                .as_array()
                .expect("items")
                .iter()
                .filter_map(|item| item["messageId"].as_str())
                .collect();
            if ids.contains(&missed.to_string().as_str()) {
                break;
            }
        }
    }
    // The message's detail lists its streaks.
    let (status, detail) = suite
        .call(
            Method::GET,
            &format!("/api/v1/pubsub/message?topic=projects/demo-console/topics/pushes&id={id}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert!(
        detail["push"]
            .as_array()
            .is_some_and(|push| !push.is_empty()),
        "{detail}"
    );
    suite.stop.send(true).expect("stop");
}

#[tokio::test]
async fn too_many_changes_in_one_frame_are_a_reset() {
    let suite = suite(None);
    let section = PubsubSection::new({
        let late = Late::pending("Pub/Sub");
        late.set(suite.pubsub.clone());
        late
    });
    for index in 0..201 {
        create_topic(
            &suite.pubsub,
            &format!("projects/demo-console/topics/many-{index}"),
        );
    }
    let topics = section.topics(&context(&suite.stop));
    let mut counters = topic(&topics, "pubsub.counters")
        .open(&json!({}), None)
        .expect("open");
    // It opens with the state, every topic in it.
    let (name, opening) = event(&next(&mut counters).await);
    assert_eq!(name, "counters");
    assert!(
        opening["topics"]
            .as_array()
            .is_some_and(|topics| topics.len() >= 201),
        "{opening}"
    );
    // A publish to each stamps 201 topics in one window.
    for index in 0..201 {
        publish(
            &suite.pubsub,
            &format!("projects/demo-console/topics/many-{index}"),
            "m",
        );
    }
    loop {
        match next(&mut counters).await {
            TopicEvent::Reset {
                reason: ResetReason::Lagged,
                ..
            } => break,
            TopicEvent::Event { name, .. } => assert_ne!(name, "counters"),
            other => panic!("{other:?}"),
        }
    }
    // The next frame waits a full second.
    let reset_at = tokio::time::Instant::now();
    publish(
        &suite.pubsub,
        "projects/demo-console/topics/many-0",
        "again",
    );
    loop {
        if let TopicEvent::Event {
            name: "counters", ..
        } = next(&mut counters).await
        {
            break;
        }
    }
    assert!(
        reset_at.elapsed() >= Duration::from_millis(900),
        "{:?}",
        reset_at.elapsed()
    );
    suite.stop.send(true).expect("stop");
}

#[tokio::test]
async fn the_attempts_feed_replays_what_a_reconnect_missed() {
    let suite = suite(None);
    let section = TasksSection::new({
        let late = Late::pending("Cloud Tasks");
        late.set(suite.tasks.clone());
        late
    });
    let topics = section.topics(&context(&suite.stop));
    let attempts = topic(&topics, "tasks.attempts");
    let mut first = attempts
        .open(&json!({ "queue": PROCESS_ORDER }), None)
        .expect("open");
    let enqueue = |name: &str| {
        suite
            .tasks
            .enqueue_console(
                PROCESS_ORDER,
                firenook_tasks_front::ConsoleTask {
                    data: Some("{}".to_owned()),
                    id: Some(name.to_owned()),
                    ..Default::default()
                },
            )
            .expect("enqueue")
    };
    let one = enqueue("first-attempt");
    let cursor = loop {
        if let TopicEvent::Event {
            name: "attempts",
            cursor,
            data,
        } = next(&mut first).await
        {
            let data: Value = serde_json::from_str(&data).expect("data");
            assert_eq!(data["items"][0]["taskId"], one.id.to_string());
            assert_eq!(data["items"][0]["queue"], PROCESS_ORDER);
            assert_eq!(data["items"][0]["attempt"]["attempt"], 1);
            assert!(data["items"][0]["attempt"]["error"].is_string());
            break cursor.expect("cursor").to_string();
        }
    };
    drop(first);
    let two = enqueue("missed-attempt");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut resumed = attempts
        .open(
            &json!({ "queue": PROCESS_ORDER, "task": two.id.to_string() }),
            Some(&cursor),
        )
        .expect("open");
    loop {
        if let TopicEvent::Event {
            name: "attempts",
            data,
            ..
        } = next(&mut resumed).await
        {
            let data: Value = serde_json::from_str(&data).expect("data");
            assert_eq!(data["items"][0]["taskId"], two.id.to_string());
            break;
        }
    }
    let error = attempts
        .open(&json!({ "queue": PROCESS_ORDER, "task": "x" }), None)
        .err()
        .expect("refused");
    assert_eq!(
        error.detail().code,
        crate::api_error::ErrorCode::InvalidArgument
    );
    suite.stop.send(true).expect("stop");
}

#[tokio::test]
async fn the_queue_topic_names_rows_and_finished_tasks() {
    let suite = suite(None);
    let section = TasksSection::new({
        let late = Late::pending("Cloud Tasks");
        late.set(suite.tasks.clone());
        late
    });
    let topics = section.topics(&context(&suite.stop));
    let mut queue = topic(&topics, "tasks.queue")
        .open(&json!({ "queue": PROCESS_ORDER }), None)
        .expect("open");
    let mut counters = topic(&topics, "tasks.counters")
        .open(&json!({}), None)
        .expect("open");
    let task = suite
        .tasks
        .enqueue_console(
            PROCESS_ORDER,
            firenook_tasks_front::ConsoleTask {
                data: Some("{}".to_owned()),
                ..Default::default()
            },
        )
        .expect("enqueue");
    let mut keys: Vec<String> = Vec::new();
    let mut finished = None;
    while finished.is_none() {
        let (name, data) = event(&next(&mut queue).await);
        match name {
            "stale" => keys.extend(
                data["keys"]
                    .as_array()
                    .expect("keys")
                    .iter()
                    .filter_map(|key| key.as_str().map(str::to_owned)),
            ),
            "finished" => finished = Some(data),
            other => panic!("{other}"),
        }
    }
    assert!(keys.contains(&format!("row:1.{}", task.id)), "{keys:?}");
    assert!(keys.contains(&format!("task:{}", task.id)), "{keys:?}");
    let finished = finished.expect("finished");
    assert_eq!(finished["added"], 1);
    assert_eq!(finished["ids"].as_array().map(Vec::len), Some(1));
    // The counters topic patched the queue's figures meanwhile.
    loop {
        let (name, data) = event(&next(&mut counters).await);
        if name == "counters" {
            assert_eq!(data["queues"][0]["key"], PROCESS_ORDER);
            break;
        }
    }
    suite.stop.send(true).expect("stop");
}

/// The next `schedules` frame naming the test inventory's schedule: the
/// frame's revision and that schedule's state.
async fn schedule_state(stream: &mut crate::live::TopicStream) -> (u64, Value) {
    loop {
        let (name, frame) = event(&next(stream).await);
        assert_eq!(name, "schedules", "{frame}");
        if let Some(state) = frame["schedules"].as_array().and_then(|states| {
            states
                .iter()
                .find(|state| state["functionId"] == "us-central1-nightlyCleanup")
        }) {
            return (frame["revision"].as_u64().expect("revision"), state.clone());
        }
    }
}

#[tokio::test]
async fn the_schedules_topic_follows_each_runs_outcome() {
    let monitor = Monitor::new(firenook_functions_runtime::MonitorLimits::default());
    let mut suite = suite(Some(monitor.clone()));
    let section = PubsubSection::new({
        let late = Late::pending("Pub/Sub");
        late.set(suite.pubsub.clone());
        late
    });
    let topics = section.topics(&context(&suite.stop));
    let schedules = topic(&topics, "pubsub.schedules");
    let mut stream = schedules.open(&json!({}), None).expect("open");
    // Without a cursor it opens with every schedule's state.
    let (_, opening) = schedule_state(&mut stream).await;
    assert_eq!(opening["runs"], 0);
    assert_eq!(opening["lastOutcome"], Value::Null);
    let run_now = json!({ "functionId": "us-central1-nightlyCleanup" });
    // Run now records the run: queued, nothing has begun.
    let (status, run) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/schedule/run",
            Some(run_now.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{run}");
    let (revision, state) = schedule_state(&mut stream).await;
    assert_eq!(state["runs"], 1);
    assert_eq!(state["lastOutcome"], "queued");
    // Compute runs the tick and it fails: the frames follow its outcome
    // with no change of the scheduler.
    let dispatch = suite.deliveries.recv().await.expect("the tick");
    let token = begin_dispatch(
        &monitor,
        "us-central1-nightlyCleanup",
        FunctionKind::Schedule,
        &dispatch,
    );
    finish_invocation(
        &monitor,
        &token,
        500,
        Some("Error: digest service unavailable"),
    );
    let (mut same, mut state) = schedule_state(&mut stream).await;
    if state["lastOutcome"] == "running" {
        (same, state) = schedule_state(&mut stream).await;
    }
    assert_eq!(state["lastOutcome"], "failed", "{state}");
    assert_eq!(state["runs"], 1, "the same run");
    assert_eq!(same, revision, "the scheduler did not change");
    // An invocation of another topic's function sends nothing: the next
    // frame is the next run's.
    let other = begin_invocation(
        &monitor,
        "us-central1-onOrderPlaced",
        FunctionKind::Pubsub,
        InvocationCause::Pubsub {
            topic: ORDERS.to_owned(),
            message_id: Some("1".to_owned()),
            event_id: Some("elsewhere".to_owned()),
        },
        [],
        b"{}",
    );
    finish_invocation(&monitor, &other, 200, None);
    tokio::time::sleep(Duration::from_millis(150)).await;
    let (status, _) = suite
        .call(Method::POST, "/api/v1/pubsub/schedule/run", Some(run_now))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (revision, state) = schedule_state(&mut stream).await;
    assert_eq!(state["runs"], 2, "{state}");
    assert_eq!(state["lastOutcome"], "queued");
    // The scheduler's revision does not cover outcomes, so resuming at it
    // while Functions run reloads.
    let mut resumed = schedules
        .open(&json!({}), Some(&revision.to_string()))
        .expect("open");
    assert!(matches!(
        next(&mut resumed).await,
        TopicEvent::Reset {
            reason: ResetReason::Gap,
            ..
        }
    ));
    suite.stop.send(true).expect("stop");
}

// ------------------------------------------------------------ R-CF-11

#[tokio::test]
async fn badges_count_dead_letters_refusals_and_failed_tasks() {
    let suite = suite(None);
    let stop = &suite.stop;
    let context = context(stop);
    let pubsub_late = Late::pending("Pub/Sub");
    pubsub_late.set(suite.pubsub.clone());
    let tasks_late = Late::pending("Cloud Tasks");
    tasks_late.set(suite.tasks.clone());
    let _pubsub = PubsubSection::new(pubsub_late).router(&context);
    let _tasks = TasksSection::new(tasks_late).router(&context);
    let badge = |id: &str| {
        context
            .badges
            .snapshot()
            .badges
            .into_iter()
            .find(|badge| badge.id == id)
            .unwrap_or_else(|| panic!("badge {id}"))
    };
    for id in ["pubsub.dead-lettered", "pubsub.rejected", "tasks.failed"] {
        assert_eq!(badge(id).count, 0, "{id}");
        assert_eq!(badge(id).kind, crate::live::badges::BadgeKind::Counter);
    }
    assert_eq!(badge("pubsub.rejected").noun.other, "refused publishes");
    assert_eq!(badge("tasks.failed").noun.one, "task ran out of retries");
    // A refused publish (to a topic that does not exist), over the wire.
    let response = suite
        .pubsub
        .native
        .clone()
        .oneshot(
            Request::post("/v1/projects/demo-console/topics/missing:publish")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"messages":[{"data":"e30="}]}"#))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    // A message dead-lettered after five deliveries.
    let broker = suite.pubsub.runtime.broker();
    create_topic(&suite.pubsub, "projects/demo-console/topics/dead");
    broker
        .create_subscription(Subscription {
            name: "projects/demo-console/subscriptions/worker".to_owned(),
            topic: ORDERS.to_owned(),
            dead_letter_policy: Some(DeadLetterPolicy {
                dead_letter_topic: "projects/demo-console/topics/dead".to_owned(),
                max_delivery_attempts: 5,
            }),
            ..Subscription::default()
        })
        .expect("subscription");
    publish(&suite.pubsub, ORDERS, "doomed");
    for _ in 0..5 {
        let received = broker
            .pull("projects/demo-console/subscriptions/worker", 1)
            .expect("pull");
        let ack_ids: Vec<String> = received.into_iter().map(|message| message.ack_id).collect();
        broker
            .modify_ack_deadline("projects/demo-console/subscriptions/worker", &ack_ids, 0)
            .expect("nack");
    }
    // A task that runs out of retries (its queue's URI refuses, maxAttempts 0).
    suite
        .tasks
        .enqueue_console(
            PROCESS_ORDER,
            firenook_tasks_front::ConsoleTask {
                data: Some("{}".to_owned()),
                ..Default::default()
            },
        )
        .expect("enqueue");
    for _ in 0..500 {
        if badge("pubsub.dead-lettered").count == 1
            && badge("pubsub.rejected").count == 1
            && badge("tasks.failed").count == 1
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(badge("pubsub.dead-lettered").count, 1);
    assert_eq!(
        badge("pubsub.dead-lettered").tone,
        crate::live::badges::BadgeTone::Attention
    );
    assert_eq!(badge("pubsub.rejected").count, 1);
    assert_eq!(badge("tasks.failed").count, 1);
    assert_eq!(
        badge("tasks.failed").tone,
        crate::live::badges::BadgeTone::Danger
    );
    stop.send(true).expect("stop");
}

// ------------------------------------------------------------ R-CF-15

#[tokio::test]
async fn summary_and_clear() {
    let suite = suite(None);
    create_subscription(
        &suite.pubsub,
        "projects/demo-console/subscriptions/audit",
        ORDERS,
    );
    for index in 0..3 {
        publish(&suite.pubsub, ORDERS, &format!("{index}"));
    }
    let (_, status) = suite.call(Method::GET, "/api/v1/status", None).await;
    let section = |id: &str| {
        status["sections"]
            .as_array()
            .expect("sections")
            .iter()
            .find(|section| section["id"] == id)
            .expect("section")
            .clone()
    };
    let pubsub = section("pubsub");
    // orders and the schedule's topic; their functions' emulator-subs and
    // `audit`.
    assert_eq!(
        pubsub["summary"]["headline"],
        "2 topics · 3 subscriptions · largest backlog 3"
    );
    assert_eq!(pubsub["summary"]["figures"][2]["label"], "Largest backlog");
    assert_eq!(pubsub["summary"]["figures"][2]["value"], 3);
    let tasks = section("tasks");
    assert_eq!(
        tasks["summary"]["headline"],
        "1 queue · 0 pending · 0 failed in 5 min"
    );
    // Clearing both: one job, each section's count.
    let (status, job) = suite
        .call(
            Method::POST,
            "/api/v1/suite/clear",
            Some(json!({ "sections": ["pubsub", "tasks"], "confirm": PROJECT })),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    let job = suite.finished(job["id"].as_str().expect("id")).await;
    assert_eq!(job["state"], "done", "{job}");
    let reports = job["result"].as_array().expect("reports");
    assert_eq!(reports[0]["section"], "pubsub");
    // Two topics, three subscriptions and three messages.
    assert_eq!(reports[0]["removed"], 8);
    assert_eq!(reports[1]["section"], "tasks");
    let (_, index) = suite.call(Method::GET, "/api/v1/pubsub/topics", None).await;
    // The function's topic and the schedule's are back, empty.
    let names: Vec<&str> = index["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter_map(|topic| topic["name"].as_str())
        .collect();
    assert_eq!(names, [SCHEDULE_TOPIC, ORDERS]);
    assert_eq!(index["items"][1]["counters"]["published"], 0);
    suite.stop.send(true).expect("stop");
}

#[tokio::test(start_paused = true)]
async fn status_ticks_at_most_twice_a_second_while_counts_change() {
    let console = test_pubsub_console(Router::new());
    let late = Late::pending("Pub/Sub");
    late.set(console.clone());
    let section = PubsubSection::new(late);
    let mut ticks = section.status_changes().expect("ticks");
    let topic = "projects/demo-console/topics/busy";
    create_topic(&console, topic);
    let publisher = {
        let console = console.clone();
        tokio::spawn(async move {
            for index in 0..1_000 {
                publish(&console, topic, &index.to_string());
                if index % 100 == 0 {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        })
    };
    let mut at = Vec::new();
    while let Ok(Some(())) = tokio::time::timeout(Duration::from_secs(2), ticks.next()).await {
        at.push(tokio::time::Instant::now());
    }
    publisher.await.expect("publisher");
    assert!(
        at.len() >= 2,
        "counts moved, so the status ticked: {}",
        at.len()
    );
    for pair in at.windows(2) {
        assert!(
            pair[1] - pair[0] >= Duration::from_millis(500),
            "{:?} between two ticks",
            pair[1] - pair[0]
        );
    }
}
