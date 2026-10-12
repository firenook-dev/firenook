//! Cloud Tasks' console routes against a real runtime: queues, enqueue,
//! task pages and details, the controls, history, batch reads, jobs,
//! search, limits and lists.

#![allow(
    clippy::too_many_lines,
    reason = "each test walks one scenario end to end against a real runtime"
)]

use std::fmt::Write as _;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode};
use firenook_functions_runtime::monitor::{FunctionKind, InvocationCause};
use firenook_functions_runtime::{Monitor, MonitorLimits};
use serde_json::{Value, json};
use tower::ServiceExt as _;

use super::*;
use crate::messaging::tests::{
    PROCESS_ORDER, PROJECT, Suite, begin_invocation, finish_invocation, inventory, suite,
};
use crate::search::SearchSource as _;

/// Registers a client queue over the Tasks port, as an app would; answers
/// its key.
async fn client_queue(suite: &Suite, queue: &str, config: &Value) -> String {
    let response = suite
        .tasks
        .native
        .clone()
        .oneshot(
            Request::post(format!(
                "/projects/{PROJECT}/locations/us-central1/queues/{queue}"
            ))
            .header("content-type", "application/json")
            .body(Body::from(config.to_string()))
            .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    format!("queue:{PROJECT}-us-central1-{queue}")
}

async fn wait_for(suite: &Suite, what: &str, check: impl Fn(&Value) -> bool, uri: &str) -> Value {
    for _ in 0..500 {
        let (status, body) = suite.call(Method::GET, uri, None).await;
        if status == StatusCode::OK && check(&body) {
            return body;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("{what} within ten seconds");
}

fn encoded(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

// ------------------------------------------------------------ R-CF-06

#[tokio::test]
async fn tasks_through_the_console() {
    let suite = suite(None);
    // The function's queue, by key, with its parts.
    let (status, list) = suite.call(Method::GET, "/api/v1/tasks/queues", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["project"], PROJECT);
    assert_eq!(list["projects"], json!([PROJECT]));
    let queue = &list["items"][0];
    assert_eq!(queue["key"], PROCESS_ORDER);
    assert_eq!(queue["id"], "processOrder");
    assert_eq!(queue["location"], "us-central1");
    assert_eq!(queue["origin"], "function");
    assert_eq!(
        queue["function"]["functionRef"]["key"],
        "us-central1-processOrder"
    );
    let (_, other) = suite
        .call(Method::GET, "/api/v1/tasks/queues?project=demo-other", None)
        .await;
    assert_eq!(other["total"]["count"], 0);
    // Paused, so what is enqueued stays pending.
    let (status, paused) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/queue/pause",
            Some(json!({ "queue": PROCESS_ORDER })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{paused}");
    assert_eq!(paused["paused"], true);
    // Enqueue as data and as a raw body.
    let (status, data_task) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/tasks",
            Some(json!({
                "queue": PROCESS_ORDER,
                "data": "{\"order\":1}",
                "name": "order-1",
                "headers": [{ "name": "x-synthetic", "value": "yes" }],
                "dispatchDeadlineSeconds": 15,
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{data_task}");
    assert_eq!(data_task["shortName"], "order-1");
    assert_eq!(data_task["state"], "pending");
    assert_eq!(data_task["origin"], "console");
    assert_eq!(data_task["body"]["dataMember"], true);
    assert_eq!(data_task["deadlineSeconds"], 15.0);
    let (status, raw_task) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/tasks",
            Some(json!({ "queue": PROCESS_ORDER, "rawBody": "{\"plain\":true}" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{raw_task}");
    assert_eq!(raw_task["generated"], true);
    assert_eq!(raw_task["body"]["dataMember"], false);
    // A reused name is a conflict with the fix.
    let (status, reused) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/tasks",
            Some(json!({ "queue": PROCESS_ORDER, "data": "{}", "name": "order-1" })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{reused}");
    assert_eq!(
        reused["error"]["message"],
        "A task named order-1 was enqueued before in this run."
    );
    assert!(
        reused["error"]["fix"]
            .as_str()
            .is_some_and(|fix| fix.contains("Leave the id empty"))
    );
    // Pages and the detail with its retry plan.
    let (_, page) = suite
        .call(
            Method::GET,
            &format!("/api/v1/tasks/tasks?queue={}", encoded(PROCESS_ORDER)),
            None,
        )
        .await;
    assert_eq!(page["total"]["count"], 2);
    assert_eq!(page["items"][0]["position"], 1);
    let id = data_task["id"].as_str().expect("id").to_owned();
    let (status, detail) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/tasks/task?queue={}&id={id}",
                encoded(PROCESS_ORDER)
            ),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["data"], "{\"order\":1}");
    assert!(
        detail["headers"]
            .as_array()
            .expect("headers")
            .iter()
            .any(|header| header["name"] == "x-synthetic")
    );
    assert!(
        detail["dispatchHeaders"]
            .as_array()
            .expect("headers")
            .iter()
            .any(|header| header["name"] == "X-CloudTasks-QueueName")
    );
    assert_eq!(
        detail["retryPlan"].as_array().map(Vec::len),
        Some(1),
        "{detail}"
    );
    assert!(detail["stops"].is_string());
    // Run now bypasses the pause; the attempt fails (the URI refuses), and
    // with no retries the task finishes as failed.
    let (status, run) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/task/run",
            Some(json!({ "queue": PROCESS_ORDER, "id": id })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{run}");
    assert_eq!(run["started"], true);
    let history = wait_for(
        &suite,
        "the failed task in the history",
        |history| history["total"]["count"] == 1,
        &format!("/api/v1/tasks/history?queue={}", encoded(PROCESS_ORDER)),
    )
    .await;
    assert_eq!(history["items"][0]["outcome"], "failed");
    assert_eq!(history["items"][0]["taskId"], id);
    let (_, finished) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/tasks/task?queue={}&id={id}",
                encoded(PROCESS_ORDER)
            ),
            None,
        )
        .await;
    assert_eq!(finished["task"]["state"], "finished");
    assert_eq!(finished["finished"]["outcome"], "failed");
    assert_eq!(finished["attempts"].as_array().map(Vec::len), Some(1));
    // Enqueue it again: same body, a new generated name.
    let (status, again) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/task/enqueue-again",
            Some(json!({ "queue": PROCESS_ORDER, "id": id })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{again}");
    assert_eq!(again["generated"], true);
    assert_eq!(again["body"]["text"], "{\"order\":1}");
    // Hold, delete, purge, resume.
    let (_, held) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/queue/hold",
            Some(json!({ "queue": PROCESS_ORDER, "enabled": true })),
        )
        .await;
    assert_eq!(held["holdScheduled"], true);
    let raw_id = raw_task["id"].as_str().expect("id");
    let (status, _) = suite
        .call(
            Method::DELETE,
            "/api/v1/tasks/task",
            Some(json!({ "queue": PROCESS_ORDER, "id": raw_id })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, purged) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/queue/purge",
            Some(json!({ "queue": PROCESS_ORDER })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{purged}");
    assert_eq!(purged["removed"], 1);
    let (_, outcomes) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/tasks/history?queue={}&outcome=purged",
                encoded(PROCESS_ORDER)
            ),
            None,
        )
        .await;
    assert_eq!(outcomes["total"]["count"], 1);
    // The History switch's counts ride the queue's counters.
    let (_, queue) = suite
        .call(
            Method::GET,
            &format!("/api/v1/tasks/queue?queue={}", encoded(PROCESS_ORDER)),
            None,
        )
        .await;
    let counts = &queue["counters"]["outcomes"];
    assert_eq!(counts["purged"], 1, "{queue}");
    assert_eq!(counts["deleted"], 1, "{queue}");
    let counted: u64 = [
        "succeeded",
        "failed",
        "cancelled",
        "deleted",
        "purged",
        "replaced",
    ]
    .iter()
    .map(|outcome| counts[outcome].as_u64().expect("a count"))
    .sum();
    assert_eq!(Some(counted), queue["counters"]["history"].as_u64());
    // The ladder is the dispatcher's: the last rung is where it gives up.
    let ladder = queue["config"]["ladder"].as_array().expect("a ladder");
    assert_eq!(ladder[0]["attempt"], 1);
    assert_eq!(ladder[0]["afterSeconds"], 0.0);
    assert_eq!(ladder.last().expect("a rung")["last"], true);
    let (_, resumed) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/queue/resume",
            Some(json!({ "queue": PROCESS_ORDER })),
        )
        .await;
    assert_eq!(resumed["paused"], false);
    // Stop retrying a task waiting out its backoff.
    let retrying = client_queue(
        &suite,
        "retrying",
        &json!({
            "retryConfig": { "maxAttempts": 5, "minBackoffSeconds": 30, "maxBackoffSeconds": 30 },
            "defaultUri": "http://127.0.0.1:1/retry",
        }),
    )
    .await;
    let (_, task) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/tasks",
            Some(json!({ "queue": retrying, "data": "{}" })),
        )
        .await;
    let task_id = task["id"].as_str().expect("id").to_owned();
    wait_for(
        &suite,
        "the task in its backoff",
        |row| row["task"]["state"] == "backoff",
        &format!(
            "/api/v1/tasks/task?queue={}&id={task_id}",
            encoded(&retrying)
        ),
    )
    .await;
    let (status, stopped) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/task/stop",
            Some(json!({ "queue": retrying, "id": task_id })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{stopped}");
    assert_eq!(stopped["state"], "finished");
    let (_, queue) = suite
        .call(
            Method::GET,
            &format!("/api/v1/tasks/queue?queue={}", encoded(&retrying)),
            None,
        )
        .await;
    assert_eq!(queue["origin"], "client");
    assert_eq!(queue["config"]["maxAttempts"], 5.0);
    suite.stop.send(true).expect("stop");
}

// ------------------------------------------------------------ R-CF-06, attempts

#[tokio::test]
async fn an_attempt_links_the_invocation_it_caused() {
    let monitor = Monitor::new(MonitorLimits::default());
    let suite = suite(Some(monitor.clone()));
    // The function's port: compute records each request as it arrives,
    // with the headers Cloud Tasks sent, and the handler answers 200.
    let recording = monitor.clone();
    let function = Router::new().fallback(move |headers: HeaderMap, body: Bytes| {
        let monitor = recording.clone();
        async move {
            let token = begin_invocation(
                &monitor,
                "us-central1-processOrder",
                FunctionKind::Tasks,
                InvocationCause::Unknown,
                headers
                    .iter()
                    .map(|(name, value)| (name.as_str(), value.to_str().unwrap_or_default())),
                &body,
            );
            finish_invocation(&monitor, &token, 200, None);
            StatusCode::OK
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a port");
    let origin = format!("http://{}", listener.local_addr().expect("address"));
    let server = tokio::spawn(async move { axum::serve(listener, function).await });
    suite.tasks.runtime.refresh_inventory(&inventory(), &origin);
    // A named task runs at once and succeeds.
    let (status, task) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/tasks",
            Some(json!({ "queue": PROCESS_ORDER, "data": "{\"order\":7}", "name": "order-7" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{task}");
    let id = task["id"].as_str().expect("id").to_owned();
    let history = wait_for(
        &suite,
        "the task in the history",
        |history| history["total"]["count"] == 1,
        &format!("/api/v1/tasks/history?queue={}", encoded(PROCESS_ORDER)),
    )
    .await;
    assert_eq!(history["items"][0]["outcome"], "succeeded", "{history}");
    let recorded = monitor
        .by_task(PROCESS_ORDER, "order-7", 0)
        .expect("compute recorded the attempt");
    let (status, detail) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/tasks/task?queue={}&id={id}",
                encoded(PROCESS_ORDER)
            ),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    let attempt = &detail["attempts"][0];
    assert_eq!(attempt["status"], 200, "{detail}");
    assert_eq!(attempt["retryCount"], 0);
    assert_eq!(
        attempt["invocation"],
        json!({ "kind": "functions.invocation", "key": recorded.id }),
        "the full task name joins by its last segment, as the header sends it"
    );
    // Once compute lets the invocation go, the link goes with it.
    monitor.clear_invocations();
    let (_, detail) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/tasks/task?queue={}&id={id}",
                encoded(PROCESS_ORDER)
            ),
            None,
        )
        .await;
    assert_eq!(detail["attempts"][0]["invocation"], Value::Null);
    server.abort();
    suite.stop.send(true).expect("stop");
}

// ------------------------------------------------------------ R-CF-07

#[tokio::test]
async fn an_enqueue_is_held_to_the_wire_limit() {
    let suite = suite(None);
    let big = "x".repeat(101 * 1024);
    let (status, body) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/tasks",
            Some(json!({ "queue": PROCESS_ORDER, "data": format!("\"{big}\"") })),
        )
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
    assert_eq!(body["error"]["code"], "payload-too-large");
    let (status, body) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/tasks",
            Some(json!({ "queue": "queue:nothing" , "data": "{}" })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(
        body["error"]["message"],
        "No queue is registered under this key."
    );
    suite.stop.send(true).expect("stop");
}

// ------------------------------------------------------------ R-CF-10

#[tokio::test]
async fn search_finds_queues_and_tasks() {
    let suite = suite(None);
    suite
        .call(
            Method::POST,
            "/api/v1/tasks/queue/pause",
            Some(json!({ "queue": PROCESS_ORDER })),
        )
        .await;
    let (_, task) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/tasks",
            Some(json!({ "queue": PROCESS_ORDER, "data": "{}", "name": "invoice-42" })),
        )
        .await;
    let search = search::TasksSearch::new({
        let late = Late::pending("Cloud Tasks");
        late.set(suite.tasks.clone());
        late
    });
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let started = std::time::Instant::now();
    let found = search.search("invoice-42", 5, &cancel);
    assert!(started.elapsed() < Duration::from_millis(50));
    assert_eq!(found.hits[0].kind, "tasks.task");
    assert_eq!(
        found.hits[0].key,
        format!(
            "{PROJECT}|us-central1|processOrder|{}",
            task["id"].as_str().expect("id")
        )
    );
    let found = search.search("process", 5, &cancel);
    assert_eq!(found.hits[0].kind, "tasks.queue");
    assert_eq!(
        found.hits[0].key,
        format!("{PROJECT}|us-central1|processOrder")
    );
    suite.stop.send(true).expect("stop");
}

// ------------------------------------------------------------ R-CF-12

#[tokio::test]
async fn task_jobs_run_and_delete_by_query() {
    let suite = suite(None);
    suite
        .call(
            Method::POST,
            "/api/v1/tasks/queue/pause",
            Some(json!({ "queue": PROCESS_ORDER })),
        )
        .await;
    for index in 0..4 {
        let (status, _) = suite
            .call(
                Method::POST,
                "/api/v1/tasks/tasks",
                Some(json!({ "queue": PROCESS_ORDER, "data": "{}", "name": format!("bulk-{index}") })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED);
    }
    let (status, job) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/tasks:delete",
            Some(json!({
                "queue": PROCESS_ORDER,
                "target": { "by": "query", "q": "name:bulk-1 name:bulk-2", "scope": { "queue": PROCESS_ORDER, "state": "pending" } },
            })),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    assert_eq!(job["kind"], "tasks.delete");
    assert_eq!(job["title"], "Delete 2 tasks of processOrder");
    let done = suite.finished(job["id"].as_str().expect("id")).await;
    assert_eq!(done["done"], 2, "{done}");
    let (_, page) = suite
        .call(
            Method::GET,
            &format!("/api/v1/tasks/tasks?queue={}", encoded(PROCESS_ORDER)),
            None,
        )
        .await;
    assert_eq!(page["total"]["count"], 2);
    let keys: Vec<Value> = page["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|row| row["key"].clone())
        .collect();
    let (status, job) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/tasks:run",
            Some(json!({ "queue": PROCESS_ORDER, "target": { "by": "keys", "keys": keys } })),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    let done = suite.finished(job["id"].as_str().expect("id")).await;
    assert_eq!(done["state"], "done", "{done}");
    // Each task ran, or (every slot busy) says why it did not.
    assert_eq!(done["done"], 2, "{done}");
    suite.stop.send(true).expect("stop");
}

// ------------------------------------------------------------ R-CF-14

#[tokio::test]
async fn a_task_taking_a_slot_is_a_new_key() {
    let suite = suite(None);
    suite
        .call(
            Method::POST,
            "/api/v1/tasks/queue/pause",
            Some(json!({ "queue": PROCESS_ORDER })),
        )
        .await;
    let (_, task) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/tasks",
            Some(json!({ "queue": PROCESS_ORDER, "data": "{}", "name": "slotted" })),
        )
        .await;
    let pending_key = task["key"].as_str().expect("key").to_owned();
    assert!(pending_key.starts_with("1."), "{pending_key}");
    let id = task["id"].as_str().expect("id").to_owned();
    let slotted_key = format!("0.{id}");
    let (_, run) = suite
        .call(
            Method::POST,
            "/api/v1/tasks/task/run",
            Some(json!({ "queue": PROCESS_ORDER, "id": id })),
        )
        .await;
    assert_eq!(run["started"], true, "{run}");
    let (status, batch) = suite
        .call(
            Method::POST,
            &format!(
                "/api/v1/tasks/tasks:batchGet?queue={}",
                encoded(PROCESS_ORDER)
            ),
            Some(json!({ "keys": [pending_key, slotted_key, "not-a-key"], "pageStarts": [null] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{batch}");
    assert_eq!(
        batch["items"][0]["row"],
        Value::Null,
        "it left the pending phase"
    );
    let slotted = &batch["items"][1];
    if slotted["row"].is_null() {
        // It finished already (the URI refuses at once): the history has it.
        let (_, history) = suite
            .call(
                Method::GET,
                &format!("/api/v1/tasks/history?queue={}", encoded(PROCESS_ORDER)),
                None,
            )
            .await;
        assert_eq!(history["items"][0]["taskId"], id);
        let sequence = history["items"][0]["id"].clone();
        let (_, rows) = suite
            .call(
                Method::POST,
                &format!(
                    "/api/v1/tasks/history:batchGet?queue={}",
                    encoded(PROCESS_ORDER)
                ),
                Some(json!({ "keys": [sequence], "pageStarts": [null] })),
            )
            .await;
        assert_eq!(rows["items"][0]["row"]["outcome"], "failed");
        assert_eq!(rows["items"][0]["page"], 0);
    } else {
        assert_eq!(slotted["page"], 0);
        assert_ne!(slotted["row"]["state"], "pending");
    }
    assert_eq!(batch["items"][2]["row"], Value::Null);
    suite.stop.send(true).expect("stop");
}

// ------------------------------------------------------------ R-CF-16

#[tokio::test]
async fn task_lists_are_pages_with_meta() {
    let suite = suite(None);
    for uri in ["/api/v1/tasks/tasks/meta", "/api/v1/tasks/history/meta"] {
        let (status, meta) = suite.call(Method::GET, uri, None).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        let fields: Vec<&str> = meta["fields"]
            .as_array()
            .expect("fields")
            .iter()
            .filter_map(|field| field["key"].as_str())
            .collect();
        assert_eq!(fields, ["name", "is"], "{uri}");
    }
    let cases: Value = serde_json::from_str(TASK_CASES).expect("cases");
    for (field, info) in cases["fields"]
        .as_array()
        .expect("fields")
        .iter()
        .zip(TASK_FIELDS.infos())
    {
        assert_eq!(field["key"], info.key);
        assert_eq!(field["kind"], info.kind);
        assert_eq!(field["help"], info.help);
    }
    assert!(crate::filter::golden::run(TASK_CASES) >= 15);
    // A filtered page.
    suite
        .call(
            Method::POST,
            "/api/v1/tasks/queue/pause",
            Some(json!({ "queue": PROCESS_ORDER })),
        )
        .await;
    for name in ["alpha", "beta", "alpine"] {
        suite
            .call(
                Method::POST,
                "/api/v1/tasks/tasks",
                Some(json!({ "queue": PROCESS_ORDER, "data": format!("{{\"who\":\"{name}\"}}"), "name": name })),
            )
            .await;
    }
    let (_, page) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/tasks/tasks?queue={}&q={}&limit=1",
                encoded(PROCESS_ORDER),
                encoded("name:alp*")
            ),
            None,
        )
        .await;
    assert_eq!(page["total"]["count"], 2);
    assert_eq!(page["items"][0]["shortName"], "alpha");
    let cursor = page["nextCursor"].as_str().expect("next").to_owned();
    let (_, next) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/tasks/tasks?queue={}&q={}&limit=1&cursor={cursor}",
                encoded(PROCESS_ORDER),
                encoded("name:alp*")
            ),
            None,
        )
        .await;
    assert_eq!(next["items"][0]["shortName"], "alpine");
    let (status, refused) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/tasks/tasks?queue={}&q={}",
                encoded(PROCESS_ORDER),
                encoded("state:pending")
            ),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    assert_eq!(refused["span"], json!({ "from": 0, "to": 13 }));
    suite.stop.send(true).expect("stop");
}

const TASK_CASES: &str = include_str!("../../../../../console/src/tasks/task-filter-cases.json");
