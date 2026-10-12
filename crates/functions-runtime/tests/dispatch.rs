//! Dispatch end to end: the runtime's router, a real Node worker from
//! `support/functions-worker.mjs`, and the monitor's record of each
//! invocation.

mod support;

use std::time::Duration;

use axum::body::Body;
use axum::http::Request;
use firenook_functions_runtime::monitor::{
    FunctionWorkerState, InvocationCause, InvocationOrigin, InvocationOutcome,
};
use firenook_functions_runtime::{LogDelivery, LogEvent};
use http_body_util::BodyExt as _;
use serde_json::{Value, json};
use support::{Harness, PROJECT, eventually};

const INDEX: &str = r#"
exports.hello = (req, res) => {
  console.log("hello from", req.path);
  console.debug("d");
  console.error("e");
  console.log("two\nlines");
  res.json({ headers: req.headers, raw: req.rawHeaders });
};
exports.stream = (req, res) => {
  res.write("a");
  setTimeout(() => { res.write("b"); setTimeout(() => res.end("c"), 100); }, 100);
};
exports.slow = (req, res) => { setTimeout(() => res.send("late"), 3000); };
exports.exit = (req, res) => { res.send("bye"); setTimeout(() => process.exit(1), 50); };
exports.onEvent = (data, context) => { console.log("event", context.eventId); };
exports.failing = async () => { throw new Error("boom"); };
"#;

const MANIFEST: &str = "specVersion: v1alpha1
endpoints:
  hello:
    entryPoint: hello
    platform: gcfv2
    httpsTrigger: {}
  stream:
    entryPoint: stream
    platform: gcfv2
    httpsTrigger: {}
  slow:
    entryPoint: slow
    platform: gcfv2
    timeoutSeconds: 1
    httpsTrigger: {}
  exit:
    entryPoint: exit
    platform: gcfv2
    httpsTrigger: {}
  onEvent:
    entryPoint: onEvent
    platform: gcfv1
    eventTrigger:
      eventType: google.pubsub.topic.publish
      eventFilters:
        resource: projects/demo-dispatch/topics/t
  failing:
    entryPoint: failing
    platform: gcfv1
    eventTrigger:
      eventType: google.pubsub.topic.publish
      eventFilters:
        resource: projects/demo-dispatch/topics/f
";

async fn harness(delivery: LogDelivery) -> Option<Harness> {
    match Harness::start(INDEX, MANIFEST, delivery).await {
        Ok(harness) => Some(harness),
        Err(reason) => {
            eprintln!("skipped: {reason}");
            None
        }
    }
}

fn url(function: &str, rest: &str) -> String {
    format!("/{PROJECT}/us-central1/{function}{rest}")
}

fn pubsub_event(event_id: &str, topic: &str) -> Body {
    Body::from(
        json!({
            "context": {"eventId": event_id, "eventType": "google.pubsub.topic.publish",
                "resource": {"name": format!("projects/{PROJECT}/topics/{topic}"), "service": "pubsub.googleapis.com"}},
            "data": {"data": "aGk="}
        })
        .to_string(),
    )
}

fn trigger(key: &str, body: Body) -> Request<Body> {
    Request::post(format!("/functions/projects/{PROJECT}/triggers/{key}"))
        .header("content-type", "application/json")
        .body(body)
        .expect("a request")
}

fn console_only(event: &LogEvent) -> bool {
    event.is_console_only()
}

#[tokio::test]
async fn http_calls_are_recorded_with_their_own_lines() {
    let Some(harness) = harness(LogDelivery::Compatible).await else {
        return;
    };
    let (response, body) = harness
        .call_text(
            Request::get(url("hello", "/path?x=1"))
                .header("x-firenook-console", "functions")
                .body(Body::empty())
                .expect("a request"),
        )
        .await;
    assert_eq!(response.status(), 200);
    let id = response
        .headers()
        .get("x-firenook-execution")
        .expect("the console asked for the id")
        .to_str()
        .expect("text")
        .to_owned();
    let seen: Value = serde_json::from_str(&body).expect("json");
    let headers = seen["headers"].as_object().expect("headers");
    assert!(
        headers.keys().all(|name| !name.starts_with("x-firenook-")),
        "{headers:?}"
    );
    assert!(
        seen["raw"]
            .as_array()
            .expect("raw headers")
            .iter()
            .filter_map(Value::as_str)
            .all(|name| !name.to_ascii_lowercase().starts_with("x-firenook-")),
        "{seen}"
    );
    eventually("the lines", || {
        harness
            .monitor
            .invocation(&id)
            .is_some_and(|detail| detail.logs.len() >= 4)
    })
    .await;
    let detail = harness.monitor.invocation(&id).expect("kept");
    assert_eq!(detail.summary.origin, InvocationOrigin::Console);
    assert_eq!(detail.summary.outcome, Some(InvocationOutcome::Succeeded));
    assert_eq!(detail.summary.function_id, "us-central1-hello");
    assert!(
        matches!(&detail.summary.cause, InvocationCause::Http { path, .. } if path == "/path?x=1")
    );
    let messages: Vec<&str> = detail
        .logs
        .iter()
        .map(|line| line.message.as_str())
        .collect();
    assert_eq!(messages, ["hello from /path", "d", "e", "two\nlines"]);
    assert!(detail.logs.iter().all(|line| !line.after_finish));
    // The terminal sees what it always saw: debug at INFO, error at WARN,
    // a multi-line message one line at a time, no console-only line.
    let events = harness.events();
    let printed = |message: &str| {
        events
            .iter()
            .find(|event| event.message == message)
            .map(|event| event.level.clone())
    };
    assert_eq!(printed("d").as_deref(), Some("INFO"));
    assert_eq!(printed("e").as_deref(), Some("WARN"));
    assert_eq!(printed("two").as_deref(), Some("INFO"));
    assert_eq!(printed("lines").as_deref(), Some("INFO"));
    assert!(!events.iter().any(console_only));
    let ends = harness.end_lines(&id);
    assert_eq!(ends.len(), 1, "{ends:?}");
    assert!(
        ends[0]
            .message
            .starts_with("Finished \"us-central1-hello\" in ")
    );
    // Without the console header the answer carries no id.
    let (plain, _) = harness
        .call_text(
            Request::get(url("hello", ""))
                .body(Body::empty())
                .expect("a request"),
        )
        .await;
    assert!(plain.headers().get("x-firenook-execution").is_none());
    let worker = harness
        .monitor
        .codebase("default")
        .expect("registered")
        .worker;
    assert!(worker.pid.is_some());
    assert!(worker.node.is_some());
    harness.stop().await;
}

#[tokio::test]
async fn background_deliveries_finish_at_the_head() {
    let Some(harness) = harness(LogDelivery::Attributed).await else {
        return;
    };
    let (response, _) = harness
        .call_text(trigger("us-central1-onEvent-0", pubsub_event("e-1", "t")))
        .await;
    assert_eq!(response.status(), 200);
    let summary = harness.monitor.by_event_id("e-1").expect("indexed");
    assert_eq!(summary.outcome, Some(InvocationOutcome::Succeeded));
    assert_eq!(summary.origin, InvocationOrigin::Emulator);
    assert!(matches!(&summary.cause,
        InvocationCause::Pubsub { topic, event_id: Some(event), .. }
            if topic == "projects/demo-dispatch/topics/t" && event == "e-1"));
    assert_eq!(summary.summary, "message e-1 on t");
    let read = harness.end_lines(&summary.id);
    assert_eq!(read.len(), 1);
    assert!(!console_only(&read[0]));
    // A delivery whose acknowledgement nobody reads still ends, once,
    // without a terminal line.
    let unread = harness
        .call(trigger("us-central1-onEvent-0", pubsub_event("e-2", "t")))
        .await;
    drop(unread);
    let summary = harness.monitor.by_event_id("e-2").expect("indexed");
    assert_eq!(summary.outcome, Some(InvocationOutcome::Succeeded));
    assert!(summary.duration_ms.is_some());
    eventually("the end line", || harness.end_lines(&summary.id).len() == 1).await;
    assert!(console_only(&harness.end_lines(&summary.id)[0]));
    let detail = harness.monitor.invocation(&summary.id).expect("kept");
    assert!(!detail.response.expect("a response").client_gone);
    harness.stop().await;
}

#[tokio::test]
async fn a_handled_failure_keeps_the_handlers_error() {
    let Some(harness) = harness(LogDelivery::Attributed).await else {
        return;
    };
    let (response, _) = harness
        .call_text(trigger("us-central1-failing-0", pubsub_event("f-1", "f")))
        .await;
    assert_eq!(response.status(), 500);
    let summary = harness.monitor.by_event_id("f-1").expect("indexed");
    assert_eq!(summary.outcome, Some(InvocationOutcome::Failed));
    eventually("the handler's error", || {
        harness
            .monitor
            .summary(summary.seq)
            .and_then(|summary| summary.error)
            .is_some()
    })
    .await;
    let summary = harness.monitor.summary(summary.seq).expect("kept");
    assert_eq!(summary.error.as_deref(), Some("Error: boom"));
    let ends = harness.end_lines(&summary.id);
    assert_eq!(ends.len(), 1, "{ends:?}");
    assert_eq!(ends[0].kind, Some("function.failed"));
    assert!(console_only(&ends[0]));
    assert_eq!(harness.monitor.stats("us-central1-failing").failures, 1);
    harness.stop().await;
}

#[tokio::test]
async fn streams_are_recorded_and_outlive_a_caller_that_leaves() {
    let Some(harness) = harness(LogDelivery::Attributed).await else {
        return;
    };
    // The caller reads the first chunk and goes away.
    let response = harness
        .call(
            Request::get(url("stream", ""))
                .body(Body::empty())
                .expect("a request"),
        )
        .await;
    let id = harness
        .monitor
        .invocations(
            &firenook_functions_runtime::monitor::InvocationQuery {
                filter: None,
                limit: 1,
            },
            None,
        )
        .items[0]
        .id
        .clone();
    let mut body = response.into_body();
    let first = body.frame().await.expect("a frame").expect("bytes");
    assert_eq!(first.into_data().expect("data"), "a");
    drop(body);
    eventually("the drained end", || {
        harness
            .monitor
            .invocation(&id)
            .is_some_and(|detail| detail.summary.outcome.is_some())
    })
    .await;
    let detail = harness.monitor.invocation(&id).expect("kept");
    let recorded = detail.response.expect("a response");
    assert!(recorded.client_gone);
    assert_eq!(recorded.body.text, "abc");
    assert!(
        detail
            .summary
            .duration_ms
            .is_some_and(|duration| duration >= 150.0)
    );
    eventually("the end line", || harness.end_lines(&id).len() == 1).await;
    let end = &harness.end_lines(&id)[0];
    assert!(!console_only(end));
    assert_eq!(
        end.detail
            .as_ref()
            .and_then(|detail| detail.get("clientGone")),
        Some(&json!(true))
    );
    // A body dropped before anyone read it is drained without client_gone.
    let unread = harness
        .call(
            Request::get(url("stream", ""))
                .body(Body::empty())
                .expect("a request"),
        )
        .await;
    drop(unread);
    let id = harness
        .monitor
        .invocations(
            &firenook_functions_runtime::monitor::InvocationQuery {
                filter: None,
                limit: 1,
            },
            None,
        )
        .items[0]
        .id
        .clone();
    eventually("the drained end", || {
        harness
            .monitor
            .invocation(&id)
            .is_some_and(|detail| detail.summary.outcome.is_some())
    })
    .await;
    let detail = harness.monitor.invocation(&id).expect("kept");
    assert!(!detail.response.expect("a response").client_gone);
    eventually("the end line", || harness.end_lines(&id).len() == 1).await;
    assert!(console_only(&harness.end_lines(&id)[0]));
    harness.stop().await;
}

#[tokio::test]
async fn a_timeout_is_recorded_with_one_end_line() {
    let Some(harness) = harness(LogDelivery::Attributed).await else {
        return;
    };
    let (response, _) = harness
        .call_text(
            Request::get(url("slow", ""))
                .body(Body::empty())
                .expect("a request"),
        )
        .await;
    assert_eq!(response.status(), 500);
    let page = harness.monitor.invocations(
        &firenook_functions_runtime::monitor::InvocationQuery {
            filter: None,
            limit: 1,
        },
        None,
    );
    let summary = &page.items[0];
    assert_eq!(summary.outcome, Some(InvocationOutcome::TimedOut));
    assert_eq!(summary.error.as_deref(), Some("Timed out after 1s"));
    let ends = harness.end_lines(&summary.id);
    assert_eq!(ends.len(), 1, "{ends:?}");
    assert_eq!(ends[0].kind, Some("function.timeout"));
    harness.stop().await;
}

#[tokio::test]
async fn paused_calls_and_worker_exits_are_recorded() {
    let Some(harness) = harness(LogDelivery::Attributed).await else {
        return;
    };
    harness.runtime.set_background_enabled(false).await;
    let (response, _) = harness
        .call_text(trigger("us-central1-onEvent-0", pubsub_event("p-1", "t")))
        .await;
    assert_eq!(response.status(), 204);
    let paused = harness.monitor.by_event_id("p-1").expect("recorded");
    assert_eq!(paused.outcome, Some(InvocationOutcome::Paused));
    // Resumed, the definition is registered again under a new key and the
    // disabled record stays (as the official emulator keeps it). A service
    // delivering to both gets 204 from the old one, which records nothing:
    // the event has one invocation, the new record's.
    harness.runtime.set_background_enabled(true).await;
    let (response, _) = harness
        .call_text(trigger("us-central1-onEvent-0", pubsub_event("p-2", "t")))
        .await;
    assert_eq!(response.status(), 204);
    assert!(harness.monitor.by_event_id("p-2").is_none());
    let (response, _) = harness
        .call_text(trigger("us-central1-onEvent-1", pubsub_event("p-2", "t")))
        .await;
    assert_eq!(response.status(), 200);
    let delivered = harness.monitor.by_event_id("p-2").expect("recorded");
    assert_eq!(delivered.outcome, Some(InvocationOutcome::Succeeded));
    // A worker that exits while idle is reported without another call.
    let (response, _) = harness
        .call_text(
            Request::get(url("exit", ""))
                .body(Body::empty())
                .expect("a request"),
        )
        .await;
    assert_eq!(response.status(), 200);
    eventually("the exit", || {
        harness
            .monitor
            .codebase("default")
            .is_some_and(|codebase| codebase.worker.state == FunctionWorkerState::Exited)
    })
    .await;
    let worker = harness
        .monitor
        .codebase("default")
        .expect("registered")
        .worker;
    assert_eq!(worker.last_exit.as_deref(), Some("exited with code 1"));
    assert!(worker.exited_at.is_some());
    harness.stop().await;
}

#[tokio::test]
async fn a_reload_stops_the_worker_and_removes_what_it_dropped() {
    let Some(harness) = harness(LogDelivery::Attributed).await else {
        return;
    };
    let mut updates = harness.runtime.updates();
    let manifest = MANIFEST.replace(
        "  hello:\n    entryPoint: hello\n    platform: gcfv2\n    httpsTrigger: {}\n",
        "",
    );
    std::fs::write(
        harness.directory.path().join("functions/functions.yaml"),
        manifest,
    )
    .expect("written");
    tokio::time::timeout(Duration::from_secs(15), updates.changed())
        .await
        .expect("a reload")
        .expect("the runtime runs");
    let codebase = harness.monitor.codebase("default").expect("registered");
    assert_eq!(codebase.loads, 2);
    assert_eq!(codebase.worker.state, FunctionWorkerState::Stopped);
    assert_eq!(
        codebase.last_change.expect("a diff").removed,
        ["us-central1-hello"]
    );
    let (response, _) = harness
        .call_text(
            Request::get(url("hello", ""))
                .body(Body::empty())
                .expect("a request"),
        )
        .await;
    assert_eq!(response.status(), 500);
    let page = harness.monitor.invocations(
        &firenook_functions_runtime::monitor::InvocationQuery {
            filter: None,
            limit: 1,
        },
        None,
    );
    assert_eq!(page.items[0].outcome, Some(InvocationOutcome::Removed));
    harness.stop().await;
}
