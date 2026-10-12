//! Pub/Sub and Cloud Tasks as the suite hands them to the console: their
//! statuses, a live channel across a stop, the Pub/Sub timer stopped in
//! `before_finish`, one clear over both sections, and log lines with refs.

#![allow(
    clippy::too_many_lines,
    reason = "each test walks one scenario end to end against real runtimes"
)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode};
use firenook_console_front::{ConsoleServices, ForeignProjects, Shutdown, console_router};
use firenook_functions_bridge::{
    DispatchRequest, FunctionsInventory, TriggerObserver, TriggerRegistry,
};
use firenook_pubsub_front::google::pubsub::v1::{PubsubMessage, PushConfig, Subscription, Topic};
use firenook_suite_front::{ConsoleSink, ServiceInfo, SuiteDirectory};
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tower::ServiceExt as _;

use super::super::{absent_reasons, before_finish, recorded};
use super::*;
use crate::diagnostics_tests::test_config;

/// The test project (the suite config's).
const PROJECT: &str = "demo-diagnostics";

/// An onTaskDispatched queue that gives up after one attempt, a
/// subscriber function and a schedule in a zone the engine cannot read.
fn inventory() -> FunctionsInventory {
    FunctionsInventory::from_backends_json(
        &json!({
            "backends": [{
                "functionTriggers": [
                    {
                        "name": "processOrder",
                        "region": "us-central1",
                        "platform": "gcfv2",
                        "taskQueueTrigger": { "retryConfig": { "maxAttempts": 0 } },
                    },
                    {
                        "name": "martianCleanup",
                        "region": "us-central1",
                        "platform": "gcfv2",
                        "schedule": { "schedule": "every day 03:00", "timeZone": "Mars/Olympus_Mons" },
                    },
                ],
            }],
        }),
        1,
    )
    .expect("inventory")
}

/// Every line the console's log was handed.
#[derive(Default)]
struct Captured(Mutex<Vec<LogInput>>);

impl ConsoleSink for Captured {
    fn accept(&self, input: LogInput) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(input);
    }
}

impl Captured {
    fn lines(&self) -> Vec<LogInput> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

/// The two runtimes as `run()` builds them, handed to a console through
/// this stream's hooks.
struct Messaging {
    router: axum::Router,
    pubsub: PubsubRuntime,
    tasks: TasksRuntime,
    logged: Arc<Captured>,
    stop: watch::Sender<bool>,
    _deliveries: mpsc::UnboundedReceiver<DispatchRequest>,
}

fn messaging() -> Messaging {
    let config = test_config();
    let logging = LoggingRuntime::new();
    let logged = Arc::new(Captured::default());
    logging.set_console_sink(logged.clone());
    let inventory = inventory();
    let background = TriggerRegistry::default();
    let (observer, deliveries) = TriggerObserver::channel(background.clone());
    let pubsub = firenook_pubsub_front::router(PROJECT, &inventory, observer.queue(), background);
    // The engine's Functions port is never reached: nothing listens on 1.
    let tasks = TasksRuntime::new(
        PROJECT,
        &inventory,
        "http://127.0.0.1:1",
        Arc::new(|_: &str, _: &str| {}),
    );
    let pubsub_late = Late::pending("Pub/Sub");
    let tasks_late = Late::pending("Cloud Tasks");
    let (stop, receiver) = watch::channel(false);
    let router = console_router(ConsoleServices {
        pubsub: Some(pubsub_late.clone()),
        tasks: Some(tasks_late.clone()),
        ..ConsoleServices::new(directory(), Shutdown::new(receiver))
    });
    pubsub_ready(&pubsub_late, &pubsub, None, &config, &logging);
    tasks_ready(&tasks_late, &tasks, None, &config, &logging);
    Messaging {
        router,
        pubsub,
        tasks,
        logged,
        stop,
        _deliveries: deliveries,
    }
}

fn directory() -> SuiteDirectory {
    SuiteDirectory::new(PROJECT, [ServiceInfo::listening("hub", "127.0.0.1", 6)])
        .expect("directory")
}

async fn call(
    router: &axum::Router,
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

fn section<'a>(status: &'a Value, id: &str) -> &'a Value {
    status["sections"]
        .as_array()
        .expect("sections")
        .iter()
        .find(|section| section["id"] == id)
        .unwrap_or_else(|| panic!("{id} in {status}"))
}

// ------------------------------------------------------------ R-SR-01

#[tokio::test]
async fn a_pubsub_suite_without_functions_reports_tasks_absent_with_the_codebase_fix() {
    // Functions were asked for and turned off: firebase.json configures no
    // codebase, so Cloud Tasks (which runs with Functions) is absent.
    let mut config = test_config();
    config.services.functions = false;
    let logging = LoggingRuntime::new();
    let background = TriggerRegistry::default();
    let (observer, _deliveries) = TriggerObserver::channel(background.clone());
    let empty = FunctionsInventory {
        generation: 0,
        backends: Vec::new(),
    };
    let pubsub = firenook_pubsub_front::router(PROJECT, &empty, observer.queue(), background);
    let late = Late::pending("Pub/Sub");
    let (_stop, receiver) = watch::channel(false);
    let router = console_router(ConsoleServices {
        pubsub: Some(late.clone()),
        absent: absent_reasons(&config, None, true),
        ..ConsoleServices::new(directory(), Shutdown::new(receiver))
    });
    let (_, status) = call(&router, Method::GET, "/api/v1/status", None).await;
    assert_eq!(section(&status, "pubsub")["state"], "starting");
    pubsub_ready(&late, &pubsub, None, &config, &logging);
    let (_, status) = call(&router, Method::GET, "/api/v1/status", None).await;
    let pubsub_section = section(&status, "pubsub");
    assert_eq!(pubsub_section["state"], "ready");
    assert_eq!(
        pubsub_section["summary"]["headline"], "0 topics · 0 subscriptions · largest backlog 0",
        "{pubsub_section}"
    );
    let tasks = section(&status, "tasks");
    assert_eq!(tasks["state"], "absent");
    assert_eq!(tasks["reason"], "requires");
    assert_eq!(
        tasks["detail"],
        "Cloud Tasks runs with Functions, which this engine does not run."
    );
    assert_eq!(
        tasks["fixes"][0]["text"], "\"functions\": [{ \"source\": \"functions\" }]",
        "{tasks}"
    );
    let (status, topics) = call(&router, Method::GET, "/api/v1/pubsub/topics", None).await;
    assert_eq!(status, StatusCode::OK, "{topics}");
    let (status, queues) = call(&router, Method::GET, "/api/v1/tasks/queues", None).await;
    assert_ne!(status, StatusCode::OK, "{queues}");
}

// ------------------------------------------------------------ R-SR-02

/// Reads the live stream until `pattern` arrives.
async fn read_until(response: &mut reqwest::Response, seen: &mut String, pattern: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !seen.contains(pattern) {
            let chunk = response
                .chunk()
                .await
                .expect("a chunk")
                .expect("the stream is open");
            seen.push_str(&String::from_utf8_lossy(&chunk));
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{pattern:?} never arrived: {seen}"));
}

#[tokio::test]
async fn a_live_channel_on_both_counters_lets_the_suite_exit_within_the_drain_grace() {
    let suite = messaging();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let address = listener.local_addr().expect("address");
    let server = tokio::spawn(crate::serve_until_shutdown(
        "ui",
        listener,
        suite.router.clone(),
        suite.stop.subscribe(),
    ));
    let client = reqwest::Client::new();
    let mut live = client
        .get(format!("http://{address}/api/v1/live"))
        .send()
        .await
        .expect("live");
    assert_eq!(live.status(), reqwest::StatusCode::OK);
    let mut seen = String::new();
    read_until(&mut live, &mut seen, "event: hello").await;
    read_until(&mut live, &mut seen, "\n\n").await;
    let hello: Value = serde_json::from_str(
        seen.lines()
            .find_map(|line| line.strip_prefix("data: "))
            .expect("hello data"),
    )
    .expect("json");
    let connection = hello["connection"].as_str().expect("connection");
    let answer: Value = client
        .post(format!(
            "http://{address}/api/v1/live/{connection}/subscriptions"
        ))
        .json(&json!({ "add": [
            { "id": "m.1", "topic": "pubsub.counters", "params": {} },
            { "id": "m.2", "topic": "tasks.counters", "params": {} },
        ] }))
        .send()
        .await
        .expect("subscribe")
        .json()
        .await
        .expect("answer");
    assert_eq!(answer["accepted"], json!(["m.1", "m.2"]), "{answer}");
    // Both topics send changes only: make one in each section.
    suite
        .pubsub
        .broker()
        .create_topic(Topic {
            name: format!("projects/{PROJECT}/topics/orders"),
            ..Topic::default()
        })
        .expect("topic");
    let (status, _) = call(
        &suite.router,
        Method::POST,
        "/api/v1/tasks/tasks",
        Some(json!({ "queue": format!("queue:{PROJECT}-us-central1-processOrder"), "data": "{}" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    read_until(&mut live, &mut seen, r#""sub":"m.1""#).await;
    read_until(&mut live, &mut seen, r#""sub":"m.2""#).await;
    let started = Instant::now();
    suite.stop.send(true).expect("stop");
    tokio::time::timeout(crate::DRAIN_GRACE, server)
        .await
        .expect("the listener drains before its grace runs out")
        .expect("server task")
        .expect("served");
    assert!(
        started.elapsed() < crate::DRAIN_GRACE,
        "{:?}",
        started.elapsed()
    );
    // The channel said it was stopping and ended, rather than being cut.
    let ended = tokio::time::timeout(Duration::from_secs(1), async {
        while let Ok(Some(chunk)) = live.chunk().await {
            seen.push_str(&String::from_utf8_lossy(&chunk));
        }
    })
    .await;
    assert!(ended.is_ok(), "the stream stayed open: {seen}");
    assert!(seen.contains("event: stopping"), "{seen}");
}

// ------------------------------------------------------------ R-SR-03

#[tokio::test]
async fn the_pubsub_timer_is_gone_after_before_finish_in_the_hooks_order() {
    let suite = messaging();
    // A push endpoint that counts what reaches it.
    let pushes = Arc::new(AtomicUsize::new(0));
    let endpoint = {
        let pushes = pushes.clone();
        axum::Router::new().route(
            "/push",
            axum::routing::post(move || {
                pushes.fetch_add(1, Ordering::SeqCst);
                async { StatusCode::OK }
            }),
        )
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let address = listener.local_addr().expect("address");
    let endpoint_server = tokio::spawn(async move {
        let _ = axum::serve(listener, endpoint).await;
    });
    let topic = format!("projects/{PROJECT}/topics/orders");
    let broker = suite.pubsub.broker();
    broker
        .create_topic(Topic {
            name: topic.clone(),
            ..Topic::default()
        })
        .expect("topic");
    broker
        .create_subscription(Subscription {
            name: format!("projects/{PROJECT}/subscriptions/orders-push"),
            topic: topic.clone(),
            push_config: Some(PushConfig {
                push_endpoint: format!("http://{address}/push"),
                ..PushConfig::default()
            }),
            ..Subscription::default()
        })
        .expect("subscription");
    let publish = || {
        broker
            .publish(
                &topic,
                vec![PubsubMessage {
                    data: b"{}".to_vec(),
                    ..PubsubMessage::default()
                }],
            )
            .expect("publish");
    };
    publish();
    let waited = Instant::now();
    while pushes.load(Ordering::SeqCst) == 0 {
        assert!(waited.elapsed() < Duration::from_secs(5), "no push arrived");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // The suite's stop, through every stream's hook in the fixed order.
    let config = test_config();
    let logging = LoggingRuntime::new();
    let triggers = TriggerRegistry::default();
    let foreign = ForeignProjects::default();
    let _ = recorded();
    before_finish(&HookContext {
        pubsub: Some(&suite.pubsub),
        tasks: Some(&suite.tasks),
        ..HookContext::new(&config, &logging, &foreign, &triggers)
    })
    .await;
    let order = recorded();
    let at = |hook: &str| {
        order
            .iter()
            .position(|called| *called == hook)
            .unwrap_or_else(|| panic!("{hook} in {order:?}"))
    };
    assert!(at("console.jobs") < at("messaging.before_finish"));
    assert!(at("storage.before_finish") < at("messaging.before_finish"));
    assert!(at("messaging.before_finish") < at("auth.before_finish"));
    // Nothing pushes any more: the timer that sends pushes has stopped.
    let before = pushes.load(Ordering::SeqCst);
    publish();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(pushes.load(Ordering::SeqCst), before);
    // The broker still answers.
    assert_eq!(broker.totals().topics, 2, "orders and the schedule's topic");
    endpoint_server.abort();
}

// ------------------------------------------------------------ R-SR-04

#[tokio::test]
async fn one_clear_job_empties_both_sections_and_tasks_lines_carry_their_refs() {
    let suite = messaging();
    let queue = format!("queue:{PROJECT}-us-central1-processOrder");
    // A task that runs once, fails (nothing listens on the Functions
    // port) and logs `tasks.failed` with its queue and task.
    let (status, task) = call(
        &suite.router,
        Method::POST,
        "/api/v1/tasks/tasks",
        Some(json!({ "queue": queue, "data": "{}" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{task}");
    let id = task["id"].as_str().expect("id").to_owned();
    let waited = Instant::now();
    let failed = loop {
        if let Some(line) = suite
            .logged
            .lines()
            .into_iter()
            .find(|line| line.kind == Some(kinds::TASKS_FAILED))
        {
            break line;
        }
        assert!(
            waited.elapsed() < Duration::from_secs(10),
            "no tasks.failed line"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(failed.service, "tasks");
    assert_eq!(
        failed.refs,
        [
            EntityRef::tasks_queue(PROJECT, "us-central1", "processOrder"),
            EntityRef::tasks_task(PROJECT, "us-central1", "processOrder", &id),
        ]
    );
    // The schedule the engine cannot run on a clock logged once the sink
    // was set, with its topic and function.
    let schedule = suite
        .logged
        .lines()
        .into_iter()
        .find(|line| line.kind == Some(kinds::PUBSUB_SCHEDULE))
        .expect("the schedule's line");
    assert_eq!(schedule.service, "pubsub");
    assert_eq!(schedule.audience, Audience::Console);
    assert_eq!(
        schedule.refs,
        [
            EntityRef::pubsub_topic(&format!(
                "projects/{PROJECT}/topics/firebase-schedule-martianCleanup"
            )),
            EntityRef::pubsub_schedule("us-central1-martianCleanup"),
        ]
    );
    // Something in each section to clear.
    suite
        .pubsub
        .broker()
        .create_topic(Topic {
            name: format!("projects/{PROJECT}/topics/audit"),
            ..Topic::default()
        })
        .expect("topic");
    let (status, paused) = call(
        &suite.router,
        Method::POST,
        "/api/v1/tasks/queue/pause",
        Some(json!({ "queue": queue })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{paused}");
    let (status, _) = call(
        &suite.router,
        Method::POST,
        "/api/v1/tasks/tasks",
        Some(json!({ "queue": queue, "data": "{}" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, job) = call(
        &suite.router,
        Method::POST,
        "/api/v1/suite/clear",
        Some(json!({ "sections": ["tasks", "pubsub"], "confirm": PROJECT })),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    assert_eq!(job["kind"], "suite.clear");
    assert_eq!(job["title"], "Clear Pub/Sub and Cloud Tasks");
    let id = job["id"].as_str().expect("job id").to_owned();
    let mut done = Value::Null;
    for _ in 0..500 {
        let (_, state) = call(
            &suite.router,
            Method::GET,
            &format!("/api/v1/jobs/{id}"),
            None,
        )
        .await;
        if state["state"] != "running" {
            done = state;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(done["state"], "done", "{done}");
    let reports = done["result"].as_array().expect("reports");
    assert_eq!(reports.len(), 2, "{done}");
    // Sidebar order: Pub/Sub before Cloud Tasks.
    assert_eq!(reports[0]["section"], "pubsub", "{done}");
    assert_eq!(reports[1]["section"], "tasks", "{done}");
    let totals = suite.pubsub.broker().totals();
    assert_eq!(totals.topics, 1, "only the schedule's topic comes back");
    assert_eq!(suite.tasks.totals().pending, 0);
    assert_eq!(suite.tasks.totals().queues, 1, "queues stay");
    suite.stop.send(true).expect("stop");
}
