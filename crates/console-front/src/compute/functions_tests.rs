#![allow(clippy::too_many_lines)] // Scenarios read best whole.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::Request;
use axum::http::{Method, StatusCode, header};
use base64::engine::general_purpose::STANDARD as BASE64;
use firenook_functions_runtime::MonitorLimits;
use firenook_functions_runtime::console::{DispatchFrame, DispatchStream};
use firenook_functions_runtime::monitor::{
    FunctionKind, InvocationCause, InvocationEnd, InvocationStart,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::super::tests::{CHANNEL, PROJECT, Setup, Suite, begin, finish};
use super::*;
use crate::late::Late;
use crate::messaging::{PubsubConsole, TasksConsole};
use crate::paging::encode_cursor;

fn find<'a>(list: &'a Value, id: &str) -> &'a Value {
    list.as_array()
        .and_then(|items| items.iter().find(|item| item["id"] == id))
        .unwrap_or_else(|| panic!("{id} in {list}"))
}

/// A service application that records every request and answers `reply`.
/// The path and JSON body of every request a stub received.
type Seen = Arc<Mutex<Vec<(String, Value)>>>;

fn stub(status: StatusCode, reply: Value) -> (Router, Seen) {
    let seen: Seen = Arc::default();
    let recorded = Arc::clone(&seen);
    let router = Router::new().fallback(move |request: Request| {
        let recorded = Arc::clone(&recorded);
        let reply = reply.clone();
        async move {
            let path = request.uri().path().to_owned();
            let body = axum::body::to_bytes(request.into_body(), usize::MAX)
                .await
                .unwrap_or_default();
            recorded
                .lock()
                .expect("recorded")
                .push((path, serde_json::from_slice(&body).unwrap_or(Value::Null)));
            (
                status,
                [(header::CONTENT_TYPE, "application/json")],
                reply.to_string(),
            )
        }
    });
    (router, seen)
}

fn pubsub(router: Router) -> Late<PubsubConsole> {
    let late = Late::pending("Pub/Sub");
    late.set(crate::messaging::test_pubsub_console(router));
    late
}

#[tokio::test]
async fn while_functions_start_the_snapshot_answers_from_the_monitor() {
    let suite = Suite::starting();
    suite.monitor().codebase_registered(
        firenook_functions_runtime::monitor::CodebaseRegistration {
            id: "default".to_owned(),
            kind: firenook_functions_runtime::monitor::FunctionCodebaseKind::User,
            directory: "functions".to_owned(),
            runtime: Some("nodejs22".to_owned()),
            inspect_port: None,
        },
    );
    let (status, snapshot) = suite.get("/functions").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["phase"], "starting");
    assert_eq!(snapshot["projectId"], PROJECT);
    assert_eq!(snapshot["codebases"][0]["codebase"]["id"], "default");
    assert_eq!(snapshot["codebases"][0]["codebase"]["state"], "loading");
    assert_eq!(snapshot["codebases"][0]["instance"], Value::Null);
    assert_eq!(snapshot["functions"], json!([]));
    let cursor = snapshot["liveCursor"].as_str().expect("a cursor");
    assert!(
        cursor.parse::<firenook_suite_front::Cursor>().is_ok(),
        "{cursor}"
    );
    for uri in [
        "/functions/us-central1-api",
        "/functions/triggers?service=firestore&resource=(default)%7Corders/o_1",
    ] {
        let (status, body) = suite.get(uri).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{uri}");
        assert_eq!(body["error"]["code"], "starting", "{uri}");
    }
    let (status, body) = suite
        .post(
            "/functions/match",
            json!({"service": "pubsub", "topic": "projects/p/topics/t"}),
        )
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
}

#[tokio::test]
async fn functions_say_their_kind_trigger_status_and_address() {
    let suite = Suite::running(Setup {
        services: Some(&["firestore", "auth"]),
        ..Setup::default()
    })
    .await;
    let (status, snapshot) = suite.get("/functions").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["address"], "http://127.0.0.1:5001");
    assert_eq!(snapshot["debugging"], false);
    let functions = &snapshot["functions"];
    assert_eq!(functions.as_array().map(Vec::len), Some(9), "{functions}");
    let api = find(functions, "us-central1-api");
    assert_eq!(api["kind"], "http");
    assert_eq!(api["platform"], "gcfv2");
    assert_eq!(
        api["url"],
        "http://127.0.0.1:5001/demo-compute/us-central1/api"
    );
    assert_eq!(api["status"], "receiving");
    assert_eq!(api["statusReason"], Value::Null);
    assert_eq!(api["service"], Value::Null);
    assert_eq!(
        api["secrets"],
        json!([
            {"key": "API_KEY", "secret": "API_KEY", "provided": true},
            {"key": "MISSING_KEY", "secret": "MISSING_KEY", "provided": false},
        ])
    );
    assert_eq!(api["stats"]["runs"], 0);
    assert_eq!(
        find(functions, "us-central1-addMessage")["kind"],
        "callable"
    );
    let order = find(functions, "us-central1-onOrder");
    assert_eq!(order["status"], "receiving");
    assert_eq!(order["service"], "firestore");
    assert_eq!(order["url"], Value::Null);
    assert_eq!(order["trigger"]["document"], "orders/{orderId}");
    assert_eq!(order["trigger"]["database"], "(default)");
    assert_eq!(order["trigger"]["matchType"], "pattern");
    let upload = find(functions, "us-central1-onUpload");
    assert_eq!(upload["status"], "noService");
    assert_eq!(
        upload["statusReason"],
        "Storage is not running in this suite."
    );
    assert_eq!(upload["trigger"]["bucket"], "uploads");
    let nightly = find(functions, "us-central1-nightly");
    assert_eq!(nightly["kind"], "schedule");
    assert_eq!(nightly["status"], "noService");
    assert!(
        nightly["statusReason"]
            .as_str()
            .is_some_and(|reason| reason.contains("Run now still calls it")),
        "{nightly}"
    );
    assert_eq!(nightly["trigger"]["schedule"], "every 5 minutes");
    assert_eq!(nightly["trigger"]["timeZone"], "Asia/Kuala_Lumpur");
    let email = find(functions, "us-central1-onEmail");
    assert_eq!(
        email["trigger"]["topic"],
        "projects/demo-compute/topics/emails"
    );
    assert_eq!(email["platform"], "gcfv1");
    let before = find(functions, "us-central1-beforeCreate");
    assert_eq!(before["kind"], "blocking");
    assert_eq!(before["trigger"]["blockingEvent"], "beforeCreate");
    assert_eq!(before["status"], "receiving");
    assert_eq!(
        before["url"],
        "http://127.0.0.1:5001/demo-compute/us-central1/beforeCreate"
    );
    let greeted = find(functions, "us-central1-onGreeted");
    assert_eq!(greeted["kind"], "eventarc");
    assert_eq!(greeted["trigger"]["channel"], CHANNEL);
    assert_eq!(greeted["trigger"]["filters"]["tier"], "vip");
    assert_eq!(snapshot["codebases"][0]["codebase"]["state"], "ready");
    suite.stop().await;
}

#[tokio::test]
async fn a_function_detail_holds_its_environment_params_and_kind_facts() {
    let suite = Suite::running(Setup::default()).await;
    let (status, api) = suite.get("/functions/us-central1-api").await;
    assert_eq!(status, StatusCode::OK, "{api}");
    assert_eq!(api["summary"]["id"], "us-central1-api");
    assert!(api["keys"][0]["key"].as_str().is_some(), "{api}");
    let environment = &api["environment"];
    assert_eq!(environment["editable"], true);
    let variables = environment["variables"].as_array().expect("variables");
    let greeting = variables
        .iter()
        .find(|variable| variable["key"] == "GREETING")
        .expect("GREETING");
    assert_eq!(greeting["value"], "hello");
    assert_eq!(greeting["source"], "dotEnv");
    assert_eq!(greeting["file"], "env");
    assert_eq!(greeting["fileName"], ".env");
    let secret = variables
        .iter()
        .find(|variable| variable["key"] == "API_KEY")
        .expect("API_KEY");
    assert_eq!(secret["value"], Value::Null);
    assert_eq!(secret["secret"], true);
    assert!(
        variables
            .iter()
            .any(|variable| variable["source"] == "emulator"),
        "{environment}"
    );
    assert!(environment["inherited"].as_u64().is_some());
    let params = api["params"].as_array().expect("params");
    let greeting = params
        .iter()
        .find(|param| param["name"] == "GREETING")
        .expect("GREETING");
    assert_eq!(greeting["value"], "hello");
    assert_eq!(greeting["default"], "hi");
    assert_eq!(greeting["unresolved"], false);
    let declared = api["declared"].as_array().expect("declared");
    let min = declared
        .iter()
        .find(|option| option["name"] == "minInstances")
        .expect("minInstances");
    assert_eq!(min["value"], 2);
    assert!(
        min["note"]
            .as_str()
            .is_some_and(|note| note.contains("one Node worker"))
    );
    assert_eq!(api["schedule"], Value::Null);
    assert_eq!(api["definition"]["entryPoint"], "api");

    let (_, nightly) = suite.get("/functions/us-central1-nightly").await;
    let schedule = &nightly["schedule"];
    assert_eq!(schedule["expression"], "every 5 minutes");
    assert_eq!(schedule["timeZone"], "Asia/Kuala_Lumpur");
    assert_eq!(
        schedule["topic"],
        "projects/demo-compute/topics/firebase-schedule-nightly"
    );
    assert_eq!(schedule["pubsub"], false);
    assert_eq!(schedule["automatic"], false);
    assert_eq!(
        schedule["manualReason"],
        "Pub/Sub is not running in this suite."
    );
    assert_eq!(schedule["scheduleRef"], Value::Null);

    let (_, resize) = suite.get("/functions/us-central1-resize").await;
    let queue = &resize["taskQueue"];
    assert_eq!(queue["queue"], "queue:demo-compute-us-central1-resize");
    assert_eq!(queue["retryConfig"]["maxAttempts"], 3);
    assert_eq!(queue["queueRef"], Value::Null);
    assert_eq!(queue["holdScheduled"], false);

    let (_, before) = suite.get("/functions/us-central1-beforeCreate").await;
    assert_eq!(before["blocking"]["event"], "beforeCreate");
    assert_eq!(before["blocking"]["forwards"]["idToken"], true);
    assert_eq!(before["blocking"]["forwards"]["accessToken"], false);

    let (status, missing) = suite.get("/functions/us-central1-nothing").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        missing["error"]["message"],
        "There is no function us-central1-nothing."
    );
    suite.stop().await;
}

#[tokio::test]
async fn which_functions_fire_answers_in_every_service_format() {
    let suite = Suite::running(Setup::default()).await;
    let fired = |body: &Value| -> Vec<String> {
        body["functions"]
            .as_array()
            .expect("functions")
            .iter()
            .map(|listener| {
                listener["functionId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned()
            })
            .collect()
    };
    let cases = [
        (
            "service=firestore&resource=(default)%7Corders/o_1",
            vec!["us-central1-onOrder"],
        ),
        (
            "service=firestore&resource=(default)%7Corders/o_1&event=deleted",
            vec![],
        ),
        ("service=firestore&resource=other%7Corders/o_1", vec![]),
        (
            "service=storage&resource=uploads%7Ca.png",
            vec!["us-central1-onUpload"],
        ),
        (
            "service=pubsub&resource=projects/demo-compute/topics/emails",
            vec!["us-central1-onEmail"],
        ),
        (
            "service=tasks&resource=queue:demo-compute-us-central1-resize",
            vec!["us-central1-resize"],
        ),
    ];
    for (query, expected) in cases {
        let (status, body) = suite.get(&format!("/functions/triggers?{query}")).await;
        assert_eq!(status, StatusCode::OK, "{query}: {body}");
        assert_eq!(fired(&body), expected, "{query}");
        assert_eq!(body["backgroundEnabled"], true);
    }
    let (_, body) = suite
        .get(&format!(
            "/functions/triggers?service=eventarc&resource={CHANNEL}%7Ctest.greeter.v1.greeted"
        ))
        .await;
    assert_eq!(fired(&body), ["us-central1-onGreeted"]);
    let listener = &body["functions"][0];
    assert_eq!(listener["codebase"], "default");
    assert_eq!(listener["kind"], "eventarc");
    assert_eq!(
        listener["function"],
        json!({"kind": "functions.function", "key": "us-central1-onGreeted"})
    );
    for (query, words) in [
        ("service=database&resource=x", "Unknown service"),
        (
            "service=firestore&resource=orders/o_1",
            "<database>|<document path>",
        ),
        ("service=pubsub&resource=emails", "full name"),
    ] {
        let (status, body) = suite.get(&format!("/functions/triggers?{query}")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}");
        assert!(
            body["error"]["message"]
                .as_str()
                .is_some_and(|message| message.contains(words)),
            "{query}: {body}"
        );
    }
    suite.stop().await;
}

#[tokio::test]
async fn match_says_why_a_function_fires_or_not() {
    let suite = Suite::running(Setup::default()).await;
    let (status, body) = suite
        .post(
            "/functions/match",
            json!({"service": "firestore", "database": "(default)", "path": "orders/o_1/items/i", "changes": ["created"]}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let order = body["matches"]
        .as_array()
        .and_then(|matches| {
            matches
                .iter()
                .find(|row| row["functionId"] == "us-central1-onOrder")
        })
        .expect("onOrder");
    assert_eq!(order["fires"], false);
    assert_eq!(order["change"], "created");
    assert_eq!(
        order["reason"],
        "orders/{orderId} does not match orders/o_1/items/i"
    );
    assert_eq!(order["function"]["kind"], "functions.function");
    let (_, body) = suite
        .post(
            "/functions/match",
            json!({"service": "eventarc", "channel": CHANNEL, "eventType": "test.greeter.v1.greeted", "attributes": {"tier": "vip"}}),
        )
        .await;
    assert_eq!(body["matches"][0]["fires"], true, "{body}");
    let (status, body) = suite
        .post(
            "/functions/match",
            json!({"service": "pubsub", "topic": "emails"}),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, _) = suite
        .post(
            "/functions/match",
            json!({"service": "database", "path": "x"}),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    suite.stop().await;
}

#[tokio::test]
async fn calls_and_test_events_stream_their_frames_and_are_recorded() {
    let suite = Suite::running(Setup::default()).await;
    let (status, body) = suite
        .post("/functions/us-central1-api/send-event", json!({"body": {}}))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("Invoke")),
        "{body}"
    );
    // No worker can start here: the call is recorded and ends in words.
    let (status, frames) = suite
        .post_lines(
            "/functions/us-central1-onOrder/send-event",
            json!({"body": {"specversion": "1.0", "type": "google.cloud.firestore.document.v1.created", "data": {}}}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        frames.first().map(|frame| &frame["frame"]),
        Some(&json!("started"))
    );
    let last = frames.last().expect("frames");
    assert_eq!(last["frame"], "finished", "{frames:?}");
    assert_eq!(last["invocation"]["outcome"], "notStarted");
    assert_eq!(last["invocation"]["origin"], "console");
    let id = last["invocation"]["id"].as_str().expect("an id").to_owned();
    assert!(suite.monitor().invocation(&id).is_some());
    let (status, frames) = suite
        .post_lines(
            "/functions/us-central1-api/invoke",
            json!({"target": "url", "method": "GET", "path": "/hello?x=1", "headers": [{"name": "x-test", "value": "1"}]}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(frames[0]["frame"], "started");
    assert_eq!(frames[0]["invocation"]["functionId"], "us-central1-api");
    let (status, body) = suite
        .post(
            "/functions/us-central1-api/invoke",
            json!({"target": "url", "body": "%%%", "encoding": "base64"}),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["message"], "The body is not valid Base64.");
    let (status, _) = suite
        .post(
            "/functions/us-central1-nothing/invoke",
            json!({"target": "trigger"}),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    suite.stop().await;
}

/// One request to `router`, JSON in and out (no console guard: a test
/// router).
async fn call(router: &Router, method: Method, uri: &str, body: Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(body.to_string()))
        .expect("request");
    let response = router.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// "Publish to emails" on a Pub/Sub function's Run tab is Pub/Sub's own
/// console publish (`POST /pubsub/topic/publish`, `publish_from_console`),
/// not the wire path an app takes: a refused publish is answered to the
/// console and never counted among the app's refused publishes (audit A2,
/// when Functions had its own `/functions/{id}/publish` over the wire).
#[tokio::test]
async fn the_run_tabs_publish_is_the_consoles_not_an_apps() {
    let inventory = firenook_functions_bridge::FunctionsInventory::from_backends_json(
        &json!({"backends": [{"codebase": "default", "functionTriggers": [{
            "id": "us-central1-onEmail",
            "name": "onEmail",
            "region": "us-central1",
            "entryPoint": "onEmail",
            "platform": "gcfv1",
            "eventTrigger": {
                "eventType": "google.pubsub.topic.publish",
                "resource": "projects/demo-compute/topics/emails",
            },
        }]}]}),
        0,
    )
    .expect("an inventory");
    let background = firenook_functions_bridge::TriggerRegistry::default();
    let (observer, _deliveries) =
        firenook_functions_bridge::TriggerObserver::channel(background.clone());
    let runtime =
        firenook_pubsub_front::router(PROJECT, &inventory, observer.queue(), background.clone());
    let pubsub = PubsubConsole::new(runtime.application(), runtime, None);
    let late = Late::pending("Pub/Sub");
    late.set(pubsub.clone());
    let router = crate::console_router(crate::ConsoleServices {
        pubsub: Some(late),
        ..crate::ConsoleServices::new(
            firenook_suite_front::SuiteDirectory::new(
                PROJECT,
                [firenook_suite_front::ServiceInfo::listening(
                    "hub",
                    "127.0.0.1",
                    34_400,
                )],
            )
            .expect("a directory"),
            crate::tests::running(),
        )
    });
    let publish = |topic: &str| {
        json!({
            "topic": topic,
            "messages": [{"data": {"text": "{\"to\":\"ada\"}"}, "attributes": {"kind": "welcome"}}],
        })
    };
    let emails = "projects/demo-compute/topics/emails";

    // Delivered to the function, as an app's publish would be.
    let (status, published) = call(
        &router,
        Method::POST,
        "/api/v1/pubsub/topic/publish",
        publish(emails),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{published}");
    assert_eq!(published["messageIds"].as_array().map(Vec::len), Some(1));
    assert_eq!(published["functions"], 1);
    assert_eq!(published["functionsSkipped"], 0);
    // Paused: Pub/Sub keeps the message and says no function got it.
    background.set_background_enabled(false);
    let (status, published) = call(
        &router,
        Method::POST,
        "/api/v1/pubsub/topic/publish",
        publish(emails),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{published}");
    assert_eq!(published["functionsSkipped"], 1);
    background.set_background_enabled(true);

    // A topic the app deleted: refused to the console, not recorded.
    let gone = "projects/demo-compute/topics/gone";
    let (status, refused) = call(
        &router,
        Method::POST,
        "/api/v1/pubsub/topic/publish",
        publish(gone),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{refused}");
    assert_eq!(pubsub.runtime.refusals_total(), 0);
    let (_, rejected) = call(&router, Method::GET, "/api/v1/pubsub/rejected", Value::Null).await;
    assert_eq!(rejected["items"], json!([]), "{rejected}");
    // The wire path, which the Run tab used to take, is an app's refusal.
    let (status, _) = call(
        &pubsub.native,
        Method::POST,
        &format!("/v1/{gone}:publish"),
        json!({"messages": [{"data": BASE64.encode("{}")}]}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(pubsub.runtime.refusals_total(), 1);

    // Functions has no publish or enqueue route of its own any more.
    let suite = Suite::running(Setup::default()).await;
    for uri in [
        "/functions/us-central1-onEmail/publish",
        "/functions/us-central1-resize/enqueue",
    ] {
        let (status, _) = suite.post(uri, json!({})).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
    }
    suite.stop().await;
}

/// Cloud Tasks with the fixture's `resize` queue registered, as the
/// Functions inventory registers it. Its tasks dispatch to a closed port:
/// nothing is called.
fn tasks_with_resize() -> Late<TasksConsole> {
    let inventory = firenook_functions_bridge::FunctionsInventory::from_backends_json(
        &json!({"backends": [{"codebase": "default", "functionTriggers": [{
            "name": "resize",
            "region": "us-central1",
            "platform": "gcfv2",
            "taskQueueTrigger": {"retryConfig": {"maxAttempts": 3}},
        }]}]}),
        0,
    )
    .expect("an inventory");
    let runtime = firenook_tasks_front::TasksRuntime::new(
        PROJECT,
        &inventory,
        "http://127.0.0.1:1",
        firenook_tasks_front::LogSink::new(|_| {}),
    );
    let late = Late::pending("Cloud Tasks");
    late.set(TasksConsole::new(Router::new(), runtime, None));
    late
}

/// A task queue function's detail says how its queue holds tasks, and an
/// attempt of a task (enqueued through Cloud Tasks' console path, as the
/// Run tab's Enqueue does with `POST /tasks/tasks`) links to the task, by
/// the console's id, and to its queue.
#[tokio::test]
async fn a_task_attempt_links_to_its_task_and_queue() {
    let tasks = tasks_with_resize();
    let suite = Suite::running(Setup {
        tasks: Some(tasks.clone()),
        ..Setup::default()
    })
    .await;
    let queue = "queue:demo-compute-us-central1-resize";
    let console = tasks.get().expect("Cloud Tasks");
    let enqueued = console
        .enqueue_console(
            queue,
            firenook_tasks_front::ConsoleTask {
                data: Some("{\"image\":\"a.png\"}".to_owned()),
                ..firenook_tasks_front::ConsoleTask::default()
            },
        )
        .expect("enqueued");
    let name = enqueued.name;
    let id = console.task_id(queue, &name).expect("the console's id");

    let (_, detail) = suite.get("/functions/us-central1-resize").await;
    assert_eq!(detail["taskQueue"]["queue"], queue, "{detail}");
    assert_eq!(detail["taskQueue"]["holdScheduled"], false, "{detail}");
    assert_eq!(detail["taskQueue"]["refused"], Value::Null, "{detail}");
    console
        .runtime
        .set_hold_scheduled(queue, true)
        .expect("a queue");
    let (_, detail) = suite.get("/functions/us-central1-resize").await;
    assert_eq!(detail["taskQueue"]["holdScheduled"], true, "{detail}");

    // An attempt of the task links to the task, by the console's id, and its queue.
    let monitor = suite.monitor();
    let token = monitor.begin(InvocationStart {
        function_id: "us-central1-resize".to_owned(),
        codebase: "default".to_owned(),
        kind: FunctionKind::Tasks,
        origin: firenook_functions_runtime::monitor::InvocationOrigin::Emulator,
        cause: InvocationCause::Task {
            queue: queue.to_owned(),
            task: name.rsplit('/').next().expect("a short name").to_owned(),
            retry_count: 0,
            execution_count: 0,
        },
        summary: String::new(),
        target: firenook_functions_runtime::monitor::InvocationTarget::Url,
        method: "POST".to_owned(),
        path: "/".to_owned(),
        headers: axum::http::HeaderMap::new(),
        body: Bytes::new(),
        replay_of: None,
        delivery: None,
    });
    monitor.finish(&token, InvocationEnd::default());
    let (_, view) = suite
        .get(&format!("/functions/invocations/{}", token.id))
        .await;
    let refs: Vec<(String, String)> = view["refs"]
        .as_array()
        .expect("refs")
        .iter()
        .map(|reference| {
            (
                reference["kind"].as_str().unwrap_or_default().to_owned(),
                reference["key"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        refs,
        [
            (
                "functions.function".to_owned(),
                "us-central1-resize".to_owned()
            ),
            (
                "tasks.task".to_owned(),
                format!("demo-compute|us-central1|resize|{id}")
            ),
            (
                "tasks.queue".to_owned(),
                "demo-compute|us-central1|resize".to_owned()
            ),
        ]
    );

    suite.stop().await;
}

#[tokio::test]
async fn run_publishes_the_clocks_tick_or_calls_the_function_directly() {
    let (native, seen) = stub(StatusCode::OK, json!({"messageIds": ["7"]}));
    let suite = Suite::running(Setup {
        pubsub: Some(pubsub(native)),
        ..Setup::default()
    })
    .await;
    let (status, body) = suite
        .post("/functions/us-central1-nightly/run", json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["transport"], "pubsub");
    assert_eq!(
        body["topic"],
        "projects/demo-compute/topics/firebase-schedule-nightly"
    );
    let (path, request) = seen.lock().expect("seen")[0].clone();
    assert_eq!(
        path,
        "/v1/projects/demo-compute/topics/firebase-schedule-nightly:publish"
    );
    assert_eq!(request["messages"][0]["data"], BASE64.encode("{}"));
    let (status, _) = suite
        .post("/functions/us-central1-api/run", json!({}))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    suite.triggers.set_background_enabled(false);
    let (status, body) = suite
        .post("/functions/us-central1-nightly/run", json!({}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["fix"], "Resume background triggers.");
    suite.stop().await;

    let suite = Suite::running(Setup::default()).await;
    let (status, body) = suite
        .post("/functions/us-central1-nightly/run", json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["transport"], "direct");
    assert_eq!(body["invocation"]["functionId"], "us-central1-nightly");
    assert_eq!(body["invocation"]["origin"], "console");
    suite.stop().await;
}

/// A Pub/Sub console whose scheduler holds the fixture's `nightly`.
fn pubsub_with_nightly(native: Router) -> Late<PubsubConsole> {
    let inventory = firenook_functions_bridge::FunctionsInventory::from_backends_json(
        &json!({ "backends": [{ "codebase": "default", "functionTriggers": [{
            "id": "us-central1-nightly",
            "name": "nightly",
            "region": "us-central1",
            "entryPoint": "nightly",
            "platform": "gcfv2",
            "schedule": { "schedule": "every 5 minutes", "timeZone": "Asia/Kuala_Lumpur" },
            "eventTrigger": { "eventType": "pubsub", "resource": "" }
        }] }] }),
        0,
    )
    .expect("inventory");
    let background = firenook_functions_bridge::TriggerRegistry::default();
    let (observer, _deliveries) =
        firenook_functions_bridge::TriggerObserver::channel(background.clone());
    let runtime =
        firenook_pubsub_front::router("demo-compute", &inventory, observer.queue(), background);
    let late = Late::pending("Pub/Sub");
    late.set(PubsubConsole::new(native, runtime, None));
    late
}

#[tokio::test]
async fn a_schedule_is_the_schedulers_view_and_run_now_goes_through_it() {
    let (native, seen) = stub(StatusCode::OK, json!({"messageIds": ["7"]}));
    let suite = Suite::running(Setup {
        pubsub: Some(pubsub_with_nightly(native)),
        ..Setup::default()
    })
    .await;
    let (status, detail) = suite.get("/functions/us-central1-nightly").await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    let schedule = &detail["schedule"];
    assert_eq!(schedule["expression"], "every 5 minutes");
    assert_eq!(schedule["evaluatedIn"], "Asia/Kuala_Lumpur");
    assert_eq!(schedule["automatic"], true);
    assert_eq!(schedule["manualReason"], Value::Null);
    assert_eq!(schedule["paused"], false);
    assert_eq!(schedule["pubsub"], true);
    assert_eq!(
        schedule["topic"],
        "projects/demo-compute/topics/firebase-schedule-nightly"
    );
    assert_eq!(schedule["scheduleRef"]["kind"], "pubsub.schedule");

    // Run now is the scheduler's own run: published in memory, not
    // through the REST publish, and recorded as the schedule's last run.
    let (status, body) = suite
        .post("/functions/us-central1-nightly/run", json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["transport"], "pubsub");
    assert!(body["messageId"].as_str().is_some_and(|id| !id.is_empty()));
    assert_eq!(body["target"]["kind"], "pubsub.message");
    assert_eq!(seen.lock().expect("seen").len(), 0);
    let (_, detail) = suite.get("/functions/us-central1-nightly").await;
    assert!(detail["schedule"]["lastRun"].as_str().is_some());

    suite.triggers.set_background_enabled(false);
    let (status, body) = suite
        .post("/functions/us-central1-nightly/run", json!({}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["fix"], "Resume background triggers.");
    suite.stop().await;
}

#[tokio::test]
async fn invocations_page_newest_first_with_cursors_filters_and_totals() {
    let suite = Suite::starting();
    let monitor = suite.monitor();
    for index in 0..5 {
        let function = if index % 2 == 0 {
            "us-central1-api"
        } else {
            "us-central1-onOrder"
        };
        let token = begin(
            monitor,
            function,
            FunctionKind::Http,
            InvocationCause::Unknown,
            &[],
        );
        finish(monitor, &token, if index == 4 { 500 } else { 200 });
    }
    let (status, first) = suite.get("/functions/invocations?limit=2").await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let page = &first["page"];
    assert_eq!(page["items"].as_array().map(Vec::len), Some(2));
    assert_eq!(page["items"][0]["seq"], 5);
    assert_eq!(page["items"][1]["seq"], 4);
    assert_eq!(page["total"], json!({"count": 5, "exact": true}));
    assert!(first["liveCursor"].is_string());
    let next = page["nextCursor"].as_str().expect("more");
    let (_, second) = suite
        .get(&format!("/functions/invocations?limit=2&cursor={next}"))
        .await;
    assert_eq!(second["page"]["items"][0]["seq"], 3);
    assert_eq!(
        second["liveCursor"],
        Value::Null,
        "only the first page resumes"
    );
    let (_, filtered) = suite
        .get("/functions/invocations?q=fn:us-central1-onOrder")
        .await;
    assert_eq!(filtered["page"]["total"]["count"], 2);
    let (_, failed) = suite.get("/functions/invocations?q=outcome:failed").await;
    assert_eq!(failed["page"]["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(failed["page"]["items"][0]["status"], 500);
    let (status, bad) = suite.get("/functions/invocations?q=nope:1").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(bad["span"], json!({"from": 0, "to": 6}));
    let foreign = encode_cursor(&json!({"nonce": "zzzzzz", "before": 3}));
    let (status, refused) = suite
        .get(&format!("/functions/invocations?cursor={foreign}"))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        refused["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("earlier start")),
        "{refused}"
    );
    let (status, _) = suite
        .send(Method::DELETE, "/functions/invocations", Some(json!({})))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, cleared) = suite.get("/functions/invocations").await;
    assert_eq!(cleared["page"]["total"]["count"], 0);
}

#[tokio::test]
async fn an_invocation_shows_its_refs_and_reveals_secrets_only_on_request() {
    let suite = Suite::starting();
    let monitor = suite.monitor();
    let token = begin(
        monitor,
        "us-central1-onOrder",
        FunctionKind::Firestore,
        InvocationCause::Firestore {
            event_type: "google.cloud.firestore.document.v1.created".to_owned(),
            database: "(default)".to_owned(),
            document: "orders/o_1".to_owned(),
            event_id: Some("e-1".to_owned()),
        },
        &[("authorization", "Bearer abc"), ("x-trace", "t-1")],
    );
    finish(monitor, &token, 204);
    let (status, view) = suite
        .get(&format!("/functions/invocations/{}", token.id))
        .await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(
        view["refs"],
        json!([
            {"kind": "functions.function", "key": "us-central1-onOrder"},
            {"kind": "firestore.document", "key": "(default)|orders/o_1"},
        ])
    );
    let headers = view["detail"]["request"]["headers"]
        .as_array()
        .expect("headers");
    let authorization = headers
        .iter()
        .find(|header| header["name"] == "authorization")
        .expect("authorization");
    assert_eq!(authorization["value"], Value::Null);
    assert_eq!(authorization["sensitive"], true);
    assert!(!view.to_string().contains("Bearer abc"), "{view}");
    let (status, revealed) = suite
        .get(&format!(
            "/functions/invocations/{}/headers/Authorization",
            token.id
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(revealed["value"], "Bearer abc");
    let (status, _) = suite
        .get(&format!(
            "/functions/invocations/{}/headers/x-none",
            token.id
        ))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = suite
        .send(
            Method::GET,
            &format!("/functions/invocations/{}/body/request", token.id),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"{\"hello\":\"world\"}");
    let (status, _) = suite
        .get(&format!("/functions/invocations/{}/body/other", token.id))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let gone = format!("{}-9", monitor.nonce());
    let (status, missing) = suite.get(&format!("/functions/invocations/{gone}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        missing["error"]["message"],
        "The engine no longer keeps invocation #9; it keeps the newest 2,000."
    );
    let (status, _) = suite.get("/functions/invocations/zzzzzz-1").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn every_cause_points_at_its_thing_in_its_own_section() {
    let suite = Suite::running(Setup::default()).await;
    let monitor = suite.monitor();
    let refs =
        |kind: FunctionKind, function: &str, cause: InvocationCause, replay_of: Option<&str>| {
            let token = monitor.begin(InvocationStart {
                function_id: function.to_owned(),
                codebase: "default".to_owned(),
                kind,
                origin: firenook_functions_runtime::monitor::InvocationOrigin::Emulator,
                cause,
                summary: String::new(),
                target: firenook_functions_runtime::monitor::InvocationTarget::Trigger,
                method: "POST".to_owned(),
                path: "/".to_owned(),
                headers: axum::http::HeaderMap::new(),
                body: Bytes::new(),
                replay_of: replay_of.map(str::to_owned),
                delivery: None,
            });
            monitor.finish(&token, InvocationEnd::default());
            monitor.invocation(&token.id).expect("kept")
        };
    let keys = |view: InvocationView| -> Vec<(String, String)> {
        view.refs
            .into_iter()
            .map(|reference| (reference.kind, reference.key))
            .collect()
    };
    let state = suite.section.state(&suite.context);
    let pair = |kind: &str, key: &str| (kind.to_owned(), key.to_owned());
    let cases = [
        (
            refs(
                FunctionKind::Storage,
                "us-central1-onUpload",
                InvocationCause::Storage {
                    event_type: "google.cloud.storage.object.v1.finalized".to_owned(),
                    bucket: "uploads".to_owned(),
                    object: "a.png".to_owned(),
                    event_id: None,
                },
                None,
            ),
            vec![pair("storage.object", "uploads|a.png")],
        ),
        (
            refs(
                FunctionKind::Auth,
                "us-central1-onUser",
                InvocationCause::Auth {
                    event_type: "providers/firebase.auth/eventTypes/user.create".to_owned(),
                    uid: Some("u_1".to_owned()),
                    email: None,
                    tenant: Some("t-1".to_owned()),
                    event_id: None,
                },
                None,
            ),
            vec![pair("auth.user", "t-1|u_1")],
        ),
        (
            refs(
                FunctionKind::Pubsub,
                "us-central1-onEmail",
                InvocationCause::Pubsub {
                    topic: "projects/demo-compute/topics/emails".to_owned(),
                    message_id: Some("18".to_owned()),
                    event_id: None,
                },
                None,
            ),
            vec![
                pair("pubsub.message", "projects/demo-compute/topics/emails|18"),
                pair("pubsub.topic", "projects/demo-compute/topics/emails"),
            ],
        ),
        (
            refs(
                FunctionKind::Schedule,
                "us-central1-nightly",
                InvocationCause::Schedule {
                    topic: "projects/demo-compute/topics/firebase-schedule-nightly".to_owned(),
                    event_id: None,
                },
                None,
            ),
            vec![pair("pubsub.schedule", "us-central1-nightly")],
        ),
        (
            refs(
                FunctionKind::Eventarc,
                "us-central1-onGreeted",
                InvocationCause::Eventarc {
                    channel: CHANNEL.to_owned(),
                    event_type: "test.greeter.v1.greeted".to_owned(),
                    source: None,
                    subject: None,
                    event_id: None,
                    event: Some("abc123-4".to_owned()),
                },
                None,
            ),
            vec![
                pair("eventarc.event", "abc123-4"),
                pair("eventarc.channel", CHANNEL),
            ],
        ),
        (
            refs(
                FunctionKind::Tasks,
                "us-central1-resize",
                InvocationCause::Task {
                    queue: "queue:demo-compute-us-central1-resize".to_owned(),
                    task: "77".to_owned(),
                    retry_count: 0,
                    execution_count: 0,
                },
                None,
            ),
            vec![pair("tasks.queue", "demo-compute|us-central1|resize")],
        ),
        (
            refs(
                FunctionKind::Blocking,
                "us-central1-beforeCreate",
                InvocationCause::Blocking {
                    event_type: "providers/cloud.auth/eventTypes/user.beforeCreate".to_owned(),
                    uid: Some("u_2".to_owned()),
                    email: None,
                    tenant: None,
                    auth_call: Some("c_9".to_owned()),
                },
                None,
            ),
            vec![pair("auth.call", "c_9"), pair("auth.user", "|u_2")],
        ),
        (
            refs(
                FunctionKind::Callable,
                "us-central1-addMessage",
                InvocationCause::Callable {
                    uid: Some("u_3".to_owned()),
                    tenant: None,
                    app_check: false,
                    streaming: false,
                },
                Some("abc123-1"),
            ),
            vec![
                pair("auth.user", "|u_3"),
                pair("functions.invocation", "abc123-1"),
            ],
        ),
    ];
    for (detail, expected) in cases {
        let function = detail.summary.function_id.clone();
        let view = invocation_view(&state, detail).await;
        let mut found = keys(view);
        assert_eq!(found.remove(0), pair("functions.function", &function));
        assert_eq!(found, expected, "{function}");
    }
    suite.stop().await;
}

#[tokio::test]
async fn a_replay_sends_the_recorded_request_again_secrets_included() {
    let suite = Suite::running(Setup::default()).await;
    let monitor = suite.monitor();
    let original = begin(
        monitor,
        "us-central1-api",
        FunctionKind::Http,
        InvocationCause::Unknown,
        &[("authorization", "Bearer original"), ("x-trace", "t-9")],
    );
    finish(monitor, &original, 200);
    let (status, frames) = suite
        .post_lines(
            &format!("/functions/invocations/{}/replay", original.id),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let started = &frames[0];
    assert_eq!(started["frame"], "started", "{frames:?}");
    assert_eq!(started["invocation"]["origin"], "replay");
    assert_eq!(started["invocation"]["replayOf"], original.id.as_ref());
    let replay = started["invocation"]["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    // The engine read the sensitive header itself; the browser never had it.
    assert!(
        !frames
            .iter()
            .any(|frame| frame.to_string().contains("Bearer original"))
    );
    let (_, revealed) = suite
        .get(&format!(
            "/functions/invocations/{replay}/headers/authorization"
        ))
        .await;
    assert_eq!(revealed["value"], "Bearer original");
    let (_, view) = suite.get(&format!("/functions/invocations/{replay}")).await;
    assert!(
        view["refs"].as_array().is_some_and(|refs| refs
            .contains(&json!({"kind": "functions.invocation", "key": original.id.as_ref()}))),
        "{view}"
    );
    let (status, _) = suite
        .post("/functions/invocations/zzzzzz-1/replay", json!({}))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    suite.stop().await;
}

#[tokio::test]
async fn codebases_have_their_load_log_secrets_env_edits_reloads_and_restarts() {
    let suite = Suite::running(Setup::default()).await;
    let (status, log) = suite.get("/functions/codebases/default/log").await;
    assert_eq!(status, StatusCode::OK, "{log}");
    assert!(log["lines"].is_array());
    assert!(log["liveCursor"].is_string());
    let (status, _) = suite.get("/functions/codebases/nothing/log").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, secret) = suite
        .get("/functions/codebases/default/secrets/API_KEY")
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(secret["value"], "s3cret");
    // Read from the file at request time.
    suite
        .directory
        .write("functions/.secret.local", "API_KEY=rotated\n");
    let (_, secret) = suite
        .get("/functions/codebases/default/secrets/API_KEY")
        .await;
    assert_eq!(secret["value"], "rotated");
    let (status, _) = suite.get("/functions/codebases/default/secrets/NOPE").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, refused) = suite
        .post(
            "/functions/codebases/default/edit-env",
            json!({"changes": [{"file": "env", "key": "1BAD", "value": "x"}]}),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    let (status, edited) = suite
        .post(
            "/functions/codebases/default/edit-env",
            json!({"changes": [{"file": "env", "key": "GREETING", "value": "hey"}]}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(edited["written"], json!([".env"]));
    assert_eq!(edited["codebase"]["id"], "default");
    let env = suite.directory.path().join("functions/.env");
    let text = std::fs::read_to_string(&env).expect("read");
    assert_eq!(text, "# settings\nGREETING=hey\nTIMEOUT=30\n");
    // A change the codebase does not load with is put back.
    let (status, failed) = suite
        .post(
            "/functions/codebases/default/edit-env",
            json!({"changes": [{"file": "env", "key": "TIMEOUT", "value": null}]}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{failed}");
    assert_eq!(
        failed["error"]["message"],
        "default did not load with this change, so your files were put back."
    );
    assert!(
        failed["detail"]
            .as_str()
            .is_some_and(|detail| detail.contains("TIMEOUT")),
        "{failed}"
    );
    assert_eq!(std::fs::read_to_string(&env).expect("read"), text);
    let (status, accepted) = suite
        .post("/functions/codebases/default/reload", json!({}))
        .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(accepted, json!({}));
    for verb in ["reload", "restart"] {
        let (status, _) = suite
            .post(&format!("/functions/codebases/nothing/{verb}"), json!({}))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{verb}");
    }
    suite.stop().await;
}

fn summary_for(id: &str) -> InvocationSummary {
    super::super::tests::summary(1, id, FunctionKind::Http)
}

#[tokio::test]
async fn an_answer_past_four_mebibytes_is_forwarded_up_to_them_then_truncated() {
    let monitor = Monitor::new(MonitorLimits::default());
    let (sender, frames) = mpsc::channel(64);
    let invocation = summary_for("us-central1-api");
    let stream = DispatchStream {
        invocation: invocation.clone(),
        frames,
    };
    tokio::spawn(async move {
        let _ = sender
            .send(DispatchFrame::Head {
                status: 200,
                headers: Vec::new(),
            })
            .await;
        for _ in 0..5 {
            let _ = sender
                .send(DispatchFrame::Chunk(Bytes::from(vec![b'a'; 1024 * 1024])))
                .await;
        }
        let _ = sender
            .send(DispatchFrame::Finished(Box::new(invocation)))
            .await;
    });
    let frames: Vec<InvocationFrame> = invocation_frames(stream, monitor).collect().await;
    let names: Vec<&str> = frames
        .iter()
        .map(|frame| match frame {
            InvocationFrame::Started { .. } => "started",
            InvocationFrame::Head { .. } => "head",
            InvocationFrame::Chunk { .. } => "chunk",
            InvocationFrame::Truncated { .. } => "truncated",
            InvocationFrame::Finished { .. } => "finished",
            InvocationFrame::Failed { .. } => "failed",
        })
        .collect();
    assert_eq!(
        names,
        [
            "started",
            "head",
            "chunk",
            "chunk",
            "chunk",
            "chunk",
            "truncated",
            "finished"
        ]
    );
    let forwarded: usize = frames
        .iter()
        .map(|frame| match frame {
            InvocationFrame::Chunk { text, .. } => text.len(),
            _ => 0,
        })
        .sum();
    assert_eq!(forwarded, 4 * 1024 * 1024);
    assert!(matches!(
        frames[6],
        InvocationFrame::Truncated { total } if total == 5 * 1024 * 1024
    ));
    let json = serde_json::to_value(&frames[6]).expect("json");
    assert_eq!(json, json!({"frame": "truncated", "total": 5_242_880}));
}

#[tokio::test]
async fn a_stream_cut_before_its_summary_reads_the_record_or_says_it_failed() {
    let monitor = Monitor::new(MonitorLimits::default());
    let token = begin(
        &monitor,
        "us-central1-api",
        FunctionKind::Http,
        InvocationCause::Unknown,
        &[],
    );
    finish(&monitor, &token, 200);
    let mut invocation = summary_for("us-central1-api");
    invocation.id = token.id.to_string();
    let (sender, frames) = mpsc::channel::<DispatchFrame>(4);
    drop(sender);
    let frames: Vec<InvocationFrame> =
        invocation_frames(DispatchStream { invocation, frames }, monitor.clone())
            .collect()
            .await;
    assert!(matches!(
        frames.last(),
        Some(InvocationFrame::Finished { invocation }) if invocation.status == Some(200)
    ));
    let (sender, frames) = mpsc::channel::<DispatchFrame>(4);
    drop(sender);
    let frames: Vec<InvocationFrame> = invocation_frames(
        DispatchStream {
            invocation: summary_for("us-central1-api"),
            frames,
        },
        monitor,
    )
    .collect()
    .await;
    assert!(matches!(
        frames.last(),
        Some(InvocationFrame::Failed { message }) if message == "The call ended before the function answered."
    ));
}

#[test]
fn text_chunks_keep_a_cut_character_for_the_next_one() {
    let mut carry = Vec::new();
    let word = "café".as_bytes();
    let (first, second) = word.split_at(word.len() - 1);
    assert_eq!(
        text_of(&mut carry, first),
        Some(("caf".to_owned(), FunctionBodyEncoding::Text))
    );
    assert_eq!(carry.len(), 1);
    assert_eq!(
        text_of(&mut carry, second),
        Some(("é".to_owned(), FunctionBodyEncoding::Text))
    );
    assert_eq!(carry, Vec::<u8>::new());
    let (text, encoding) = text_of(&mut carry, &[0xff, 0xfe, b'a']).expect("bytes");
    assert_eq!(encoding, FunctionBodyEncoding::Base64);
    assert_eq!(BASE64.decode(text).expect("base64"), [0xff, 0xfe, b'a']);
}

#[test]
fn first_generation_triggers_read_their_resources() {
    let firestore = trigger_of(
        &json!({"eventTrigger": {"eventType": "providers/cloud.firestore/eventTypes/document.write",
            "resource": "projects/p/databases/(default)/documents/orders/{id}"}}),
        "p",
    );
    assert_eq!(firestore.database.as_deref(), Some("(default)"));
    assert_eq!(firestore.document.as_deref(), Some("orders/{id}"));
    assert_eq!(firestore.match_type.as_deref(), Some("pattern"));
    let exact = trigger_of(
        &json!({"eventTrigger": {"eventType": "google.cloud.firestore.document.v1.created",
            "eventFilters": {"database": "other", "document": "config/main"}}}),
        "p",
    );
    assert_eq!(exact.database.as_deref(), Some("other"));
    assert_eq!(exact.document.as_deref(), Some("config/main"));
    assert_eq!(exact.match_type.as_deref(), Some("exact"));
    let storage = trigger_of(
        &json!({"eventTrigger": {"eventType": "google.storage.object.finalize", "resource": "projects/_/buckets/b"}}),
        "p",
    );
    assert_eq!(storage.bucket.as_deref(), Some("b"));
    let topic = trigger_of(
        &json!({"eventTrigger": {"eventType": "google.cloud.pubsub.topic.v1.messagePublished",
            "eventFilters": {"topic": "emails"}}}),
        "p",
    );
    assert_eq!(topic.topic.as_deref(), Some("projects/p/topics/emails"));
    let https = trigger_of(&json!({"httpsTrigger": {"invoker": ["public"]}}), "p");
    assert_eq!(https.invoker, ["public"]);
}
