//! Unit tests against the recorded `tasks-v1` corpus: registration,
//! enqueue/delete/stats bodies and headers byte for byte where the oracle
//! is deterministic, and the dispatch engine against a local server that
//! records every request it receives.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use fireside_functions_bridge::FunctionsInventory;
use serde_json::json;
use tower::ServiceExt as _;

use crate::config::{QueueConfig, queue_key, valid_queue_id};
use crate::json::{OrderedJson, decode_base64_forgiving, js_number_text, parse_int};
use crate::queue::dispatch_deadline;
use crate::runtime::{LogSink, TasksRuntime};

const CORPUS: &str = include_str!("../../../conformance/fixtures/tasks-v1/emulator-programs.json");
const PROJECT: &str = "demo-fireside-functions-oracle";
const SCHEDULE_TIME: &str = "2030-01-01T00:00:00.000Z";
const REGISTRATION: &str = "tasks-discovery-and-registration";
const DISPATCH: &str = "tasks-enqueue-and-dispatch";
const DELETE: &str = "tasks-delete";

type Log = Arc<Mutex<Vec<(String, String)>>>;

fn corpus() -> OrderedJson {
    OrderedJson::parse(CORPUS).expect("tasks-v1 corpus")
}

/// The recorded step of a program.
fn step(corpus: &OrderedJson, program: &str, step: &str) -> OrderedJson {
    let programs = corpus
        .get("profiles")
        .and_then(|profiles| profiles.as_array())
        .and_then(|profiles| profiles.first())
        .and_then(|profile| profile.get("programs"))
        .and_then(OrderedJson::as_array)
        .expect("programs");
    let steps = programs
        .iter()
        .find(|candidate| candidate.get("id").and_then(OrderedJson::as_str) == Some(program))
        .and_then(|program| program.get("steps"))
        .and_then(OrderedJson::as_array)
        .unwrap_or_else(|| panic!("program {program}"));
    steps
        .iter()
        .find(|candidate| candidate.get("id").and_then(OrderedJson::as_str) == Some(step))
        .cloned()
        .unwrap_or_else(|| panic!("step {program}/{step}"))
}

/// A recorded value with the corpus placeholders filled in.
fn substituted(value: &OrderedJson, origin: &str) -> OrderedJson {
    let text = value
        .stringify()
        .replace("{{project}}", PROJECT)
        .replace("{{origin:functions}}", origin)
        .replace("{{time}}", SCHEDULE_TIME);
    OrderedJson::parse(&text).expect("substituted step")
}

/// The inventory the oracle discovered (the `/backends` step).
fn inventory() -> FunctionsInventory {
    let body = step(&corpus(), REGISTRATION, "backends")
        .get("response")
        .and_then(|response| response.get("body"))
        .expect("backends body")
        .to_value();
    FunctionsInventory::from_backends_json(&body, 0).expect("inventory")
}

fn recording_log() -> (LogSink, Log) {
    let lines: Log = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    let log: LogSink = Arc::new(move |level: &str, text: &str| {
        sink.lock()
            .unwrap()
            .push((level.to_owned(), text.to_owned()));
    });
    (log, lines)
}

fn runtime(origin: &str) -> (TasksRuntime, Log) {
    let (log, lines) = recording_log();
    (TasksRuntime::new(PROJECT, &inventory(), origin, log), lines)
}

fn fill_tokens(runtime: &TasksRuntime, key: &str) {
    runtime.with_state(|state| {
        if let Some(queue) = state.queues.get_mut(key) {
            queue.set_tokens(1000.0);
        }
    });
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: String,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("JSON body: {}", self.body))
    }
}

async fn call(app: &Router, method: Method, path: &str, body: Option<&OrderedJson>) -> Reply {
    call_with(app, method, path, body, &[]).await
}

async fn call_with(
    app: &Router,
    method: Method,
    path: &str,
    body: Option<&OrderedJson>,
    headers: &[(&str, &str)],
) -> Reply {
    let mut request = Request::builder().method(method).uri(path);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let request = match body {
        Some(body) => request
            .header("content-type", "application/json")
            .body(Body::from(body.stringify()))
            .unwrap(),
        None => request.body(Body::empty()).unwrap(),
    };
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    Reply {
        status,
        headers,
        body: String::from_utf8(bytes.to_vec()).unwrap(),
    }
}

/// Plays a recorded HTTP step against `app` and returns the reply with the
/// recorded response (placeholders filled in).
async fn play(
    app: &Router,
    corpus: &OrderedJson,
    program: &str,
    id: &str,
    origin: &str,
) -> (Reply, OrderedJson) {
    let step = substituted(&step(corpus, program, id), origin);
    let action = step.get("action").expect("action");
    let method = action
        .get("method")
        .and_then(OrderedJson::as_str)
        .expect("method")
        .parse::<Method>()
        .unwrap();
    let path = action
        .get("path")
        .and_then(OrderedJson::as_str)
        .expect("path");
    let body = action.get("body").and_then(|body| body.get("json"));
    let reply = call(app, method, path, body).await;
    (reply, step.get("response").cloned().expect("response"))
}

fn expected_status(response: &OrderedJson) -> u16 {
    u16::try_from(
        response
            .get("status")
            .and_then(|status| match status {
                OrderedJson::Number(number) => number.as_u64(),
                _ => None,
            })
            .expect("status"),
    )
    .unwrap()
}

fn expected_header<'a>(response: &'a OrderedJson, name: &str) -> Option<&'a str> {
    response
        .get("headers")
        .and_then(|headers| headers.get(name))
        .and_then(OrderedJson::as_str)
}

fn expected_body(response: &OrderedJson) -> OrderedJson {
    response.get("body").cloned().expect("body")
}

/// Asserts status, content type and the exact body of a recorded step.
fn assert_recorded(reply: &Reply, response: &OrderedJson) {
    assert_eq!(
        reply.status.as_u16(),
        expected_status(response),
        "{}",
        reply.body
    );
    assert_eq!(
        reply.header("content-type"),
        expected_header(response, "content-type")
    );
    assert_eq!(reply.header("x-powered-by"), Some("Express"));
    let body = expected_body(response);
    match body {
        OrderedJson::String(text) => assert_eq!(reply.body, text),
        other => assert_eq!(reply.body, other.stringify()),
    }
}

fn task_body(data: &serde_json::Value) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(json!({ "data": data }).to_string())
}

/// A task as the Admin SDK shapes it.
fn task(
    data: &serde_json::Value,
    name: Option<&str>,
    extra: &[(&str, OrderedJson)],
) -> OrderedJson {
    let mut object = indexmap::IndexMap::new();
    let mut http_request = indexmap::IndexMap::new();
    http_request.insert("url".to_owned(), OrderedJson::String(String::new()));
    http_request.insert(
        "oidcToken".to_owned(),
        OrderedJson::from_value(
            &json!({ "serviceAccountEmail": "emulated-service-acct@email.com" }),
        ),
    );
    http_request.insert("body".to_owned(), OrderedJson::String(task_body(data)));
    http_request.insert(
        "headers".to_owned(),
        OrderedJson::from_value(&json!({ "Content-Type": "application/json" })),
    );
    object.insert("httpRequest".to_owned(), OrderedJson::Object(http_request));
    if let Some(name) = name {
        object.insert("name".to_owned(), OrderedJson::String(name.to_owned()));
    }
    for (key, value) in extra {
        object.insert((*key).to_owned(), value.clone());
    }
    let mut envelope = indexmap::IndexMap::new();
    envelope.insert("task".to_owned(), OrderedJson::Object(object));
    OrderedJson::Object(envelope)
}

fn task_name(queue: &str, id: &str) -> String {
    format!("projects/{PROJECT}/locations/us-central1/queues/{queue}/tasks/{id}")
}

fn tasks_path(queue: &str) -> String {
    format!("/projects/{PROJECT}/locations/us-central1/queues/{queue}/tasks")
}

fn queue_path(queue: &str) -> String {
    format!("/projects/{PROJECT}/locations/us-central1/queues/{queue}")
}

fn stats_of(reply: &Reply, key: &str) -> serde_json::Value {
    reply.json()[key].clone()
}

// ---------------------------------------------------------------------------
// A dispatch target that records what it receives.

#[derive(Debug, Clone)]
struct Hit {
    path: String,
    headers: Vec<(String, String)>,
    body: String,
    concurrent: usize,
    at: Instant,
}

type Policy = Arc<dyn Fn(&str, usize) -> (u16, Duration) + Send + Sync>;

struct ServerState {
    hits: Mutex<Vec<Hit>>,
    active: AtomicUsize,
    policy: Policy,
}

#[derive(Clone)]
struct TestServer {
    url: String,
    state: Arc<ServerState>,
}

impl TestServer {
    async fn start(
        policy: impl Fn(&str, usize) -> (u16, Duration) + Send + Sync + 'static,
    ) -> Self {
        let state = Arc::new(ServerState {
            hits: Mutex::new(Vec::new()),
            active: AtomicUsize::new(0),
            policy: Arc::new(policy),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().fallback(record).with_state(state.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self { url, state }
    }

    async fn ok() -> Self {
        Self::start(|_, _| (204, Duration::ZERO)).await
    }

    fn hits(&self) -> Vec<Hit> {
        self.state.hits.lock().unwrap().clone()
    }

    async fn wait_for(&self, count: usize, timeout: Duration) -> Vec<Hit> {
        let deadline = Instant::now() + timeout;
        loop {
            let hits = self.hits();
            if hits.len() >= count {
                return hits;
            }
            assert!(
                Instant::now() < deadline,
                "expected {count} requests, saw {}: {hits:?}",
                hits.len()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

async fn record(State(state): State<Arc<ServerState>>, request: Request) -> Response {
    let path = request.uri().path().to_owned();
    let headers = request
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_owned(),
                value.to_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    let body = to_bytes(request.into_body(), 1024 * 1024).await.unwrap();
    let concurrent = state.active.fetch_add(1, Ordering::SeqCst) + 1;
    let (status, delay) = {
        let mut hits = state.hits.lock().unwrap();
        let seen = hits.iter().filter(|hit| hit.path == path).count();
        hits.push(Hit {
            path: path.clone(),
            headers,
            body: String::from_utf8_lossy(&body).into_owned(),
            concurrent,
            at: Instant::now(),
        });
        (state.policy)(&path, seen)
    };
    tokio::time::sleep(delay).await;
    state.active.fetch_sub(1, Ordering::SeqCst);
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::from_u16(status).unwrap();
    response
}

fn header<'a>(hit: &'a Hit, name: &str) -> Option<&'a str> {
    hit.headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

/// The task headers in wire order (the transport's own headers left out).
fn task_headers(hit: &Hit) -> Vec<&str> {
    hit.headers
        .iter()
        .map(|(name, _)| name.as_str())
        .filter(|name| {
            *name == "content-type"
                || name.starts_with("x-cloudtasks-")
                || name.starts_with("x-synthetic-")
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Registration.

#[tokio::test]
async fn discovery_registers_every_task_function_and_stats_match_the_corpus() {
    let corpus = corpus();
    let origin = "http://127.0.0.1:5001";
    let (runtime, lines) = runtime(origin);
    assert_eq!(
        runtime.queue_keys(),
        [
            "taskDefault",
            "taskRetry",
            "taskSlow",
            "taskSerial",
            "taskRate"
        ]
        .iter()
        .map(|name| queue_key(PROJECT, "us-central1", name))
        .chain([queue_key(PROJECT, "europe-west1", "taskAlt")])
        .collect::<Vec<_>>()
    );
    assert_eq!(
        runtime.default_uri(&queue_key(PROJECT, "europe-west1", "taskAlt")),
        Some(Some(OrderedJson::String(format!(
            "{origin}/{PROJECT}/europe-west1/taskAlt"
        ))))
    );
    assert!(lines.lock().unwrap().iter().any(|(level, text)| {
        level == "INFO"
            && text == "Created queue with key: queue:demo-fireside-functions-oracle-us-central1-taskRetry"
    }));
    let app = runtime.application();
    let (reply, response) = play(&app, &corpus, REGISTRATION, "stats-initial", origin).await;
    assert_recorded(&reply, &response);
    assert_eq!(reply.header("vary"), Some("Origin"));
    assert_eq!(reply.header("access-control-allow-origin"), None);
}

#[tokio::test]
async fn registration_steps_match_the_corpus_byte_for_byte() {
    let corpus = corpus();
    let origin = "http://127.0.0.1:5001";
    let (runtime, _) = runtime(origin);
    let app = runtime.application();
    for id in [
        "register-defaults",
        "register-explicit",
        "register-null-fields",
        "register-empty-body",
        "register-over-limit",
        "register-invalid-id-underscore",
        "register-invalid-id-long",
        "register-invalid-id-dot",
        "register-foreign-project",
        "register-replaces",
        "stats-after-register",
        "unknown-route-get",
        "unknown-route-post",
        "queue-get-not-a-route",
    ] {
        let (reply, response) = play(&app, &corpus, REGISTRATION, id, origin).await;
        assert_recorded(&reply, &response);
        if reply.status == StatusCode::NOT_FOUND {
            assert_eq!(
                reply.header("content-security-policy"),
                Some("default-src 'none'")
            );
            assert_eq!(reply.header("x-content-type-options"), Some("nosniff"));
        }
    }
    // The replacement kept `manual-explicit`'s position and replaced its
    // configuration.
    assert_eq!(
        runtime
            .queue_config(&queue_key(PROJECT, "us-central1", "manual-explicit"))
            .map(|config| config.stringify()),
        Some(
            r#"{"retryConfig":{"maxAttempts":3,"maxRetrySeconds":null,"maxBackoffSeconds":3600,"maxDoublings":16,"minBackoffSeconds":0.1},"rateLimits":{"maxConcurrentDispatches":7,"maxDispatchesPerSecond":500},"timeoutSeconds":10,"retry":false}"#
                .to_owned()
        )
    );
}

#[tokio::test]
async fn registration_keeps_numbers_and_key_order_as_sent() {
    let (runtime, _) = runtime("http://127.0.0.1:5001");
    let app = runtime.application();
    let body = OrderedJson::parse(
        r#"{"defaultUri":"http://127.0.0.1:1/x","retry":true,"rateLimits":{"maxDispatchesPerSecond":2.5},"retryConfig":{"minBackoffSeconds":30,"maxRetrySeconds":0}}"#,
    )
    .unwrap();
    let reply = call(&app, Method::POST, &queue_path("ordered"), Some(&body)).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.body,
        r#"{"taskQueueConfig":{"retryConfig":{"maxAttempts":3,"maxRetrySeconds":0,"maxBackoffSeconds":3600,"maxDoublings":16,"minBackoffSeconds":30},"rateLimits":{"maxConcurrentDispatches":1000,"maxDispatchesPerSecond":2.5},"timeoutSeconds":10,"retry":true,"defaultUri":"http://127.0.0.1:1/x"}}"#
    );
}

#[tokio::test]
async fn registration_body_edge_cases_follow_express() {
    let (runtime, lines) = runtime("http://127.0.0.1:5001");
    let app = runtime.application();
    // No body and a non-JSON body both register the defaults.
    let reply = call(&app, Method::POST, &queue_path("nobody"), None).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert!(reply.body.contains(r#""maxAttempts":3"#));
    let request = Request::post(queue_path("textbody"))
        .header("content-type", "text/plain")
        .body(Body::from("not json"))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    // A gzip body is inflated; an unknown encoding is a 415 page.
    let mut gzipped = Vec::new();
    {
        use std::io::Write as _;
        let mut encoder =
            flate2::write::GzEncoder::new(&mut gzipped, flate2::Compression::default());
        encoder
            .write_all(br#"{"rateLimits":{"maxConcurrentDispatches":4}}"#)
            .unwrap();
        encoder.finish().unwrap();
    }
    let request = Request::post(queue_path("gzipped"))
        .header("content-type", "application/json")
        .header("content-encoding", "gzip")
        .body(Body::from(gzipped))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    assert!(
        String::from_utf8_lossy(&body).contains(r#""maxConcurrentDispatches":4"#),
        "{body:?}"
    );
    let request = Request::post(queue_path("brotli"))
        .header("content-type", "application/json")
        .header("content-encoding", "br")
        .body(Body::from("{}"))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    // Over the 100 KB limit is body-parser's 413 page.
    let request = Request::post(queue_path("huge"))
        .header("content-type", "application/json")
        .body(Body::from(format!(
            "{{\"retryConfig\":{{\"maxAttempts\":\"{}\"}}}}",
            "x".repeat(101 * 1024)
        )))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(!runtime.has_queue(&queue_key(PROJECT, "us-central1", "huge")));
    // Invalid JSON is body-parser's 400 page.
    let request = Request::post(queue_path("broken"))
        .header("content-type", "application/json")
        .body(Body::from("{\"retryConfig\":"))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response.headers()["content-type"],
        "text/html; charset=utf-8"
    );
    let request = Request::post(queue_path("scalar"))
        .header("content-type", "application/json")
        .body(Body::from("42"))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(!runtime.has_queue(&queue_key(PROJECT, "us-central1", "broken")));
    // A fractional concurrency throws `new Array` (an Express 500 page),
    // after the "Created queue" line the official handler logs first.
    let body = OrderedJson::parse(r#"{"rateLimits":{"maxConcurrentDispatches":2.5}}"#).unwrap();
    let reply = call(&app, Method::POST, &queue_path("fraction"), Some(&body)).await;
    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(
        reply
            .body
            .contains("<pre>RangeError: Invalid array length</pre>")
    );
    assert!(!runtime.has_queue(&queue_key(PROJECT, "us-central1", "fraction")));
    assert!(lines.lock().unwrap().iter().any(|(_, text)| {
        text == "Created queue with key: queue:demo-fireside-functions-oracle-us-central1-fraction"
    }));
    // Zero concurrency is a queue without slots.
    let body = OrderedJson::parse(r#"{"rateLimits":{"maxConcurrentDispatches":0}}"#).unwrap();
    let reply = call(&app, Method::POST, &queue_path("zero"), Some(&body)).await;
    assert_eq!(reply.status, StatusCode::OK);
    let reply = call(&app, Method::GET, "/queueStats", None).await;
    assert_eq!(
        stats_of(
            &reply,
            "queue:demo-fireside-functions-oracle-us-central1-zero"
        )["runningTasks"],
        json!(0)
    );
}

#[test]
fn queue_id_rule_is_the_code_not_the_prose() {
    assert!(valid_queue_id("taskDefault"));
    assert!(valid_queue_id("manual-defaults"));
    assert!(valid_queue_id("9-starts-with-a-digit"));
    assert!(valid_queue_id("ends-with-a-hyphen-"));
    assert!(valid_queue_id(&"a".repeat(100)));
    assert!(!valid_queue_id(&"a".repeat(101)));
    assert!(!valid_queue_id("bad_name"));
    assert!(!valid_queue_id("bad.name"));
    assert!(!valid_queue_id(""));
    assert_eq!(queue_key("p", "us-central1", "q"), "queue:p-us-central1-q");
}

#[test]
#[allow(clippy::float_cmp)]
fn config_defaults_and_numeric_views() {
    let config = QueueConfig::from_body(&OrderedJson::object()).unwrap();
    assert_eq!(config.max_attempts, 3.0);
    assert_eq!(config.max_retry_seconds, None);
    assert_eq!(config.max_backoff_seconds, 3600.0);
    assert_eq!(config.max_doublings, 16.0);
    assert_eq!(config.min_backoff_seconds, 0.1);
    assert_eq!(config.slots, 1000);
    assert_eq!(config.max_dispatches_per_second, 500.0);
    assert_eq!(config.default_uri, None);
    let config = QueueConfig::from_body(
        &OrderedJson::parse(r#"{"retryConfig":{"maxRetrySeconds":30},"rateLimits":{"maxConcurrentDispatches":"7"},"defaultUri":null}"#).unwrap(),
    )
    .unwrap();
    assert_eq!(config.max_retry_seconds, Some(30.0));
    // `new Array("7")` is a one-element array.
    assert_eq!(config.slots, 1);
    assert_eq!(config.default_uri, Some(OrderedJson::Null));
}

// ---------------------------------------------------------------------------
// Routing.

#[tokio::test]
async fn routing_follows_express_four() {
    let (runtime, _) = runtime("http://127.0.0.1:5001");
    let app = runtime.application();
    // Case-insensitive literals and one optional trailing slash.
    let reply = call(&app, Method::GET, "/QUEUESTATS/", None).await;
    assert_eq!(reply.status, StatusCode::OK);
    let reply = call(&app, Method::GET, "/queueStats//", None).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert!(reply.body.contains("<pre>Cannot GET /queueStats//</pre>"));
    // A method the route does not handle is the default 404, not a 405.
    let reply = call(&app, Method::DELETE, "/queueStats", None).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert!(reply.body.contains("<pre>Cannot DELETE /queueStats</pre>"));
    // The automatic OPTIONS answer lists the route's methods.
    let reply = call(&app, Method::OPTIONS, "/queueStats", None).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.header("allow"), Some("GET,HEAD"));
    assert_eq!(reply.body, "GET,HEAD");
    let reply = call(&app, Method::OPTIONS, &tasks_path("taskDefault"), None).await;
    assert_eq!(reply.header("allow"), Some("POST"));
    let reply = call(&app, Method::OPTIONS, "/nothing", None).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    // The origin is reflected on the stats route.
    let reply = call_with(
        &app,
        Method::GET,
        "/queueStats",
        None,
        &[("origin", "http://localhost:4000")],
    )
    .await;
    assert_eq!(
        reply.header("access-control-allow-origin"),
        Some("http://localhost:4000")
    );
    assert_eq!(reply.header("vary"), Some("Origin"));
    // Params are decoded; a malformed escape is a 400.
    let reply = call(
        &app,
        Method::POST,
        "/projects/p/locations/l/queues/ok%2Dname",
        None,
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert!(runtime.has_queue("queue:p-l-ok-name"));
    let reply = call(
        &app,
        Method::POST,
        "/projects/p/locations/l/queues/bad%E0%A4%A",
        None,
    )
    .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert!(reply.body.contains("Failed to decode param"));
    // The 404 page escapes the path.
    let reply = call(&app, Method::GET, "/x%3Cb%3E", None).await;
    assert!(reply.body.contains("<pre>Cannot GET /x%3Cb%3E</pre>"));
}

// ---------------------------------------------------------------------------
// Enqueue, delete and stats.

#[tokio::test(flavor = "multi_thread")]
async fn enqueue_steps_echo_the_corpus_bodies() {
    let corpus = corpus();
    let server = TestServer::ok().await;
    let (runtime, lines) = runtime(&server.url);
    let app = runtime.application();
    for id in [
        "enqueue-named",
        "enqueue-duplicate-name",
        "enqueue-unknown-queue",
        "enqueue-with-schedule-time",
        "enqueue-caller-headers",
        "enqueue-explicit-url",
        "enqueue-alt-region",
        "enqueue-wrong-region",
    ] {
        let (reply, response) = play(&app, &corpus, DISPATCH, id, &server.url).await;
        assert_recorded(&reply, &response);
    }
    assert_eq!(
        lines
            .lock()
            .unwrap()
            .iter()
            .filter(|(level, text)| level == "WARN"
                && text == "Tried to queue a task into a non-existent queue")
            .count(),
        2
    );
    // The manual queue's unreachable default URI is echoed as registered.
    let (_, response) = play(
        &app,
        &corpus,
        REGISTRATION,
        "register-defaults",
        &server.url,
    )
    .await;
    assert_eq!(expected_status(&response), 200);
    let (reply, response) = play(
        &app,
        &corpus,
        DISPATCH,
        "enqueue-manual-queue-unreachable",
        &server.url,
    )
    .await;
    assert_recorded(&reply, &response);
}

#[tokio::test(flavor = "multi_thread")]
async fn auto_named_tasks_start_with_a_slash_and_can_never_be_deleted() {
    let corpus = corpus();
    let server = TestServer::ok().await;
    let (runtime, _) = runtime(&server.url);
    let app = runtime.application();
    let (reply, response) = play(&app, &corpus, DISPATCH, "enqueue-auto-named", &server.url).await;
    assert_eq!(reply.status, StatusCode::OK);
    let body = reply.json();
    let name = body["task"]["name"].as_str().unwrap().to_owned();
    let prefix = format!("/projects/{PROJECT}/locations/us-central1/queues/taskDefault/tasks/");
    let id = name
        .strip_prefix(&prefix)
        .expect("leading slash and the queue path");
    assert!(!id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()));
    assert!(id.parse::<u64>().unwrap() <= 9_007_199_254_740_991);
    // The generated name is appended after the keys the caller sent.
    let expected = expected_body(&response).stringify();
    let expected_prefix = expected.split("\"name\":").next().unwrap();
    assert!(reply.body.starts_with(expected_prefix), "{}", reply.body);
    assert!(reply.body.ends_with(&format!("\"name\":\"{name}\"}}}}")));
    // `DELETE` builds the name without the slash, so it never matches.
    let reply = call(
        &app,
        Method::DELETE,
        &format!("{}/{id}", tasks_path("taskDefault")),
        None,
    )
    .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.body, "Tried to remove a task that doesn't exist");
    let hits = server.wait_for(1, Duration::from_secs(3)).await;
    assert_eq!(header(&hits[0], "x-cloudtasks-taskname"), Some(id));
}

#[tokio::test]
async fn delete_steps_match_the_corpus() {
    let corpus = corpus();
    let origin = "http://127.0.0.1:5001";
    let (runtime, lines) = runtime(origin);
    let app = runtime.application();
    // The manual queue with an unreachable default URI; a fresh queue has
    // no tokens for its first second, so the two tasks stay pending.
    let (_, response) = play(&app, &corpus, REGISTRATION, "register-defaults", origin).await;
    assert_eq!(expected_status(&response), 200);
    for id in ["enqueue-pending-a", "enqueue-pending-b"] {
        let (reply, response) = play(&app, &corpus, DELETE, id, origin).await;
        assert_recorded(&reply, &response);
    }
    let reply = call(&app, Method::GET, "/queueStats", None).await;
    let manual = "queue:demo-fireside-functions-oracle-us-central1-manual-defaults";
    assert_eq!(stats_of(&reply, manual)["numberOfTasks"], json!(2));
    assert_eq!(stats_of(&reply, manual)["tasksAdded"], json!(0.4));
    for id in ["delete-unknown-queue", "delete-unknown-task"] {
        let (reply, response) = play(&app, &corpus, DELETE, id, origin).await;
        assert_recorded(&reply, &response);
    }
    // Deleting a pending task removes it.
    let reply = call(
        &app,
        Method::DELETE,
        &format!("{}/pending-a", tasks_path("manual-defaults")),
        None,
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body, r#"{"res":"OK"}"#);
    assert_eq!(
        reply.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    let reply = call(&app, Method::GET, "/queueStats", None).await;
    assert_eq!(stats_of(&reply, manual)["numberOfTasks"], json!(1));
    assert_eq!(
        runtime.with_state(|state| state.queues[manual].pending_names()),
        vec![task_name("manual-defaults", "pending-b")]
    );
    let reply = call(
        &app,
        Method::DELETE,
        &format!("{}/pending-a", tasks_path("manual-defaults")),
        None,
    )
    .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    let warnings = lines
        .lock()
        .unwrap()
        .iter()
        .filter(|(level, text)| level == "WARN" && text.starts_with("Tried to"))
        .map(|(_, text)| text.clone())
        .collect::<Vec<_>>();
    assert_eq!(
        warnings,
        vec![
            "Tried to remove a task from a non-existent queue",
            "Tried to remove a task that doesn't exist",
            "Tried to remove a task that doesn't exist",
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_dispatched_task_succeeds_once_and_takes_the_count_negative() {
    let corpus = corpus();
    let server = TestServer::ok().await;
    let (runtime, _) = runtime(&server.url);
    let app = runtime.application();
    let default = "queue:demo-fireside-functions-oracle-us-central1-taskDefault";
    fill_tokens(&runtime, default);
    let (reply, _) = play(&app, &corpus, DISPATCH, "enqueue-named", &server.url).await;
    assert_eq!(reply.status, StatusCode::OK);
    server.wait_for(1, Duration::from_secs(3)).await;
    // Wait for the slot to free.
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let reply = call(&app, Method::GET, "/queueStats", None).await;
        if stats_of(&reply, default)["completedLastMin"] == json!(1) {
            assert_eq!(stats_of(&reply, default)["numberOfTasks"], json!(0));
            assert_eq!(stats_of(&reply, default)["tasksAdded"], json!(0.2));
            break;
        }
        assert!(Instant::now() < deadline, "task never completed");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    for id in ["delete-dispatched", "delete-again", "reuse-deleted-name"] {
        let (reply, response) = play(&app, &corpus, DELETE, id, &server.url).await;
        assert_recorded(&reply, &response);
    }
    let reply = call(&app, Method::GET, "/queueStats", None).await;
    assert_eq!(stats_of(&reply, default)["numberOfTasks"], json!(-1));
    assert_eq!(stats_of(&reply, default)["runningTasks"], json!(1000));
    assert_eq!(stats_of(&reply, default)["maxConcurrent"], json!(1000));
    assert_eq!(stats_of(&reply, default)["maxRate"], json!(500));
}

#[tokio::test]
async fn a_full_queue_answers_409() {
    let (runtime, _) = runtime("http://127.0.0.1:5001");
    let app = runtime.application();
    // A rate of zero never earns a token, so nothing leaves the queue.
    let body = OrderedJson::parse(
        r#"{"rateLimits":{"maxDispatchesPerSecond":0},"defaultUri":"http://127.0.0.1:1/never"}"#,
    )
    .unwrap();
    let reply = call(&app, Method::POST, &queue_path("full"), Some(&body)).await;
    assert_eq!(reply.status, StatusCode::OK);
    let key = queue_key(PROJECT, "us-central1", "full");
    for index in 0..10_000 {
        runtime
            .enqueue(
                &key,
                crate::queue::TaskRecord {
                    name: task_name("full", &index.to_string()),
                    url: Some("http://127.0.0.1:1/never".to_owned()),
                    headers: Vec::new(),
                    body: "{}".to_owned(),
                    schedule_time: None,
                    deadline: Duration::from_secs(60),
                },
            )
            .unwrap();
    }
    let reply = call(
        &app,
        Method::POST,
        &tasks_path("full"),
        Some(&task(&json!({}), Some(&task_name("full", "one-more")), &[])),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(reply.body, "A task with the same name already exists");
    assert_eq!(
        reply.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    let reply = call(&app, Method::GET, "/queueStats", None).await;
    assert_eq!(stats_of(&reply, &key)["numberOfTasks"], json!(10_000));
    assert_eq!(stats_of(&reply, &key)["tasksAdded"], json!(2000));
}

#[tokio::test]
async fn enqueue_error_paths_are_express_500_pages() {
    let (runtime, _) = runtime("http://127.0.0.1:5001");
    let app = runtime.application();
    let path = tasks_path("taskDefault");
    let reply = call(&app, Method::POST, &path, Some(&OrderedJson::object())).await;
    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        reply.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    assert!(reply.body.starts_with("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>TypeError"));
    let reply = call(
        &app,
        Method::POST,
        &path,
        Some(&OrderedJson::parse(r#"{"task":{"name":"x"}}"#).unwrap()),
    )
    .await;
    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    let reply = call(
        &app,
        Method::POST,
        &path,
        Some(
            &OrderedJson::parse(r#"{"task":{"httpRequest":{"url":"","body":"bm90IGpzb24="}}}"#)
                .unwrap(),
        ),
    )
    .await;
    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(reply.body.contains("<pre>SyntaxError"));
    let reply = call(
        &app,
        Method::POST,
        &path,
        Some(&OrderedJson::parse(r#"{"task":{"httpRequest":{"url":""}}}"#).unwrap()),
    )
    .await;
    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    // A queue registered without `defaultUri` turns an empty URL into
    // `undefined`, which the echo drops.
    let reply = call(
        &app,
        Method::POST,
        &queue_path("manual-empty"),
        Some(&OrderedJson::object()),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    let reply = call(
        &app,
        Method::POST,
        &tasks_path("manual-empty"),
        Some(&task(
            &json!({"job":1}),
            Some(&task_name("manual-empty", "no-url")),
            &[],
        )),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.body,
        format!(
            r#"{{"task":{{"httpRequest":{{"oidcToken":{{"serviceAccountEmail":"emulated-service-acct@email.com"}},"body":{{"data":{{"job":1}}}},"headers":{{"Content-Type":"application/json"}}}},"name":"{}"}}}}"#,
            task_name("manual-empty", "no-url")
        )
    );
}

// ---------------------------------------------------------------------------
// Dispatch.

#[tokio::test(flavor = "multi_thread")]
async fn dispatch_carries_the_cloud_tasks_headers_and_the_decoded_body() {
    let server = TestServer::ok().await;
    let (runtime, _) = runtime(&server.url);
    let app = runtime.application();
    let default = "queue:demo-fireside-functions-oracle-us-central1-taskDefault";
    fill_tokens(&runtime, default);
    let before = crate::queue::now_millis();
    let reply = call(
        &app,
        Method::POST,
        &tasks_path("taskDefault"),
        Some(&task(
            &json!({"job":"named"}),
            Some(&task_name("taskDefault", "job-named-1")),
            &[],
        )),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    let hits = server.wait_for(1, Duration::from_secs(3)).await;
    let hit = &hits[0];
    assert_eq!(hit.path, format!("/{PROJECT}/us-central1/taskDefault"));
    assert_eq!(hit.body, r#"{"data":{"job":"named"}}"#);
    assert_eq!(
        task_headers(hit),
        [
            "content-type",
            "x-cloudtasks-queuename",
            "x-cloudtasks-taskname",
            "x-cloudtasks-taskretrycount",
            "x-cloudtasks-taskexecutioncount",
            "x-cloudtasks-tasketa",
        ]
    );
    assert_eq!(header(hit, "content-type"), Some("application/json"));
    assert_eq!(header(hit, "x-cloudtasks-queuename"), Some(default));
    assert_eq!(header(hit, "x-cloudtasks-taskname"), Some("job-named-1"));
    assert_eq!(header(hit, "x-cloudtasks-taskretrycount"), Some("0"));
    assert_eq!(header(hit, "x-cloudtasks-taskexecutioncount"), Some("0"));
    assert_eq!(header(hit, "x-cloudtasks-taskpreviousresponse"), None);
    let eta = header(hit, "x-cloudtasks-tasketa")
        .unwrap()
        .parse::<u64>()
        .unwrap();
    assert!(eta >= before && eta <= crate::queue::now_millis());
    assert_eq!(
        header(hit, "user-agent"),
        Some("node-fetch/1.0 (+https://github.com/bitinn/node-fetch)")
    );
    assert_eq!(header(hit, "accept"), Some("*/*"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_500_retries_without_counting_an_execution() {
    let server =
        TestServer::start(|_, seen| (if seen == 0 { 500 } else { 204 }, Duration::ZERO)).await;
    let (runtime, _) = runtime(&server.url);
    let app = runtime.application();
    let body = OrderedJson::parse(&format!(
        r#"{{"retryConfig":{{"minBackoffSeconds":0.05}},"defaultUri":"{}/retry"}}"#,
        server.url
    ))
    .unwrap();
    call(&app, Method::POST, &queue_path("retry"), Some(&body)).await;
    let key = queue_key(PROJECT, "us-central1", "retry");
    fill_tokens(&runtime, &key);
    let reply = call(
        &app,
        Method::POST,
        &tasks_path("retry"),
        Some(&task(
            &json!({"failUntil":1}),
            Some(&task_name("retry", "retry-500")),
            &[],
        )),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    let hits = server.wait_for(2, Duration::from_secs(3)).await;
    assert_eq!(header(&hits[0], "x-cloudtasks-taskretrycount"), Some("0"));
    assert_eq!(header(&hits[0], "x-cloudtasks-taskpreviousresponse"), None);
    assert_eq!(header(&hits[1], "x-cloudtasks-taskretrycount"), Some("1"));
    assert_eq!(
        header(&hits[1], "x-cloudtasks-taskexecutioncount"),
        Some("0")
    );
    assert_eq!(
        header(&hits[1], "x-cloudtasks-taskpreviousresponse"),
        Some("500")
    );
    assert_eq!(
        *task_headers(&hits[1]).last().unwrap(),
        "x-cloudtasks-taskpreviousresponse"
    );
    assert!(hits[1].at.duration_since(hits[0].at) >= Duration::from_millis(50));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(server.hits().len(), 2);
    let reply = call(&app, Method::GET, "/queueStats", None).await;
    assert_eq!(stats_of(&reply, &key)["completedLastMin"], json!(1));
    assert_eq!(stats_of(&reply, &key)["failedTasks"], json!(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_400_counts_an_execution() {
    let server =
        TestServer::start(|_, seen| (if seen == 0 { 400 } else { 204 }, Duration::ZERO)).await;
    let (runtime, _) = runtime(&server.url);
    let app = runtime.application();
    let body = OrderedJson::parse(&format!(
        r#"{{"retryConfig":{{"minBackoffSeconds":0.05}},"defaultUri":"{}/retry"}}"#,
        server.url
    ))
    .unwrap();
    call(&app, Method::POST, &queue_path("retry"), Some(&body)).await;
    fill_tokens(&runtime, &queue_key(PROJECT, "us-central1", "retry"));
    call(
        &app,
        Method::POST,
        &tasks_path("retry"),
        Some(&task(
            &json!({"failUntil":1}),
            Some(&task_name("retry", "retry-400")),
            &[],
        )),
    )
    .await;
    let hits = server.wait_for(2, Duration::from_secs(3)).await;
    assert_eq!(header(&hits[1], "x-cloudtasks-taskretrycount"), Some("1"));
    assert_eq!(
        header(&hits[1], "x-cloudtasks-taskexecutioncount"),
        Some("1")
    );
    assert_eq!(
        header(&hits[1], "x-cloudtasks-taskpreviousresponse"),
        Some("400")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn max_attempts_runs_one_more_time_than_it_says() {
    let server = TestServer::start(|_, _| (500, Duration::ZERO)).await;
    let (runtime, _) = runtime(&server.url);
    let app = runtime.application();
    let body = OrderedJson::parse(&format!(r#"{{"retryConfig":{{"maxAttempts":3,"minBackoffSeconds":0.05,"maxBackoffSeconds":0.1,"maxDoublings":2}},"defaultUri":"{}/exhaust"}}"#, server.url)).unwrap();
    call(&app, Method::POST, &queue_path("exhaust"), Some(&body)).await;
    let key = queue_key(PROJECT, "us-central1", "exhaust");
    fill_tokens(&runtime, &key);
    call(
        &app,
        Method::POST,
        &tasks_path("exhaust"),
        Some(&task(
            &json!({"failUntil":99}),
            Some(&task_name("exhaust", "retry-exhausted")),
            &[],
        )),
    )
    .await;
    let hits = server.wait_for(4, Duration::from_secs(4)).await;
    assert_eq!(
        hits.iter()
            .map(|hit| header(hit, "x-cloudtasks-taskretrycount").unwrap())
            .collect::<Vec<_>>(),
        ["0", "1", "2", "3"]
    );
    assert!(
        hits.iter()
            .all(|hit| header(hit, "x-cloudtasks-taskexecutioncount") == Some("0"))
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let reply = call(&app, Method::GET, "/queueStats", None).await;
        if stats_of(&reply, &key)["failedTasks"] == json!(0.2) {
            assert_eq!(stats_of(&reply, &key)["completedLastMin"], json!(1));
            assert!(runtime.with_state(|state| state.queues[&key].dispatches().is_empty()));
            break;
        }
        assert!(
            Instant::now() < deadline,
            "slot never freed: {}",
            reply.body
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(server.hits().len(), 4);
}

#[tokio::test(flavor = "multi_thread")]
async fn max_retry_seconds_keeps_retrying_past_max_attempts() {
    let server =
        TestServer::start(|_, seen| (if seen < 3 { 503 } else { 204 }, Duration::ZERO)).await;
    let (runtime, _) = runtime(&server.url);
    let app = runtime.application();
    let body = OrderedJson::parse(&format!(r#"{{"retryConfig":{{"maxAttempts":1,"maxRetrySeconds":30,"minBackoffSeconds":0.05,"maxBackoffSeconds":0.05}},"defaultUri":"{}/clock"}}"#, server.url)).unwrap();
    call(&app, Method::POST, &queue_path("clock"), Some(&body)).await;
    let key = queue_key(PROJECT, "us-central1", "clock");
    fill_tokens(&runtime, &key);
    call(
        &app,
        Method::POST,
        &tasks_path("clock"),
        Some(&task(&json!({}), Some(&task_name("clock", "t")), &[])),
    )
    .await;
    let hits = server.wait_for(4, Duration::from_secs(4)).await;
    assert_eq!(header(&hits[3], "x-cloudtasks-taskretrycount"), Some("3"));
    assert_eq!(
        header(&hits[3], "x-cloudtasks-taskpreviousresponse"),
        Some("503")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn one_concurrent_dispatch_serialises_the_queue() {
    let server = TestServer::start(|_, _| (204, Duration::from_millis(150))).await;
    let (runtime, _) = runtime(&server.url);
    let app = runtime.application();
    let serial = "queue:demo-fireside-functions-oracle-us-central1-taskSerial";
    fill_tokens(&runtime, serial);
    for id in ["serial-a", "serial-b", "serial-c"] {
        let reply = call(
            &app,
            Method::POST,
            &tasks_path("taskSerial"),
            Some(&task(
                &json!({"order":id}),
                Some(&task_name("taskSerial", id)),
                &[],
            )),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
    }
    let hits = server.wait_for(3, Duration::from_secs(4)).await;
    assert_eq!(
        hits.iter()
            .map(|hit| header(hit, "x-cloudtasks-taskname").unwrap())
            .collect::<Vec<_>>(),
        ["serial-a", "serial-b", "serial-c"]
    );
    assert!(hits.iter().all(|hit| hit.concurrent == 1), "{hits:?}");
    assert!(hits[2].at.duration_since(hits[0].at) >= Duration::from_millis(300));
    let reply = call(&app, Method::GET, "/queueStats", None).await;
    assert_eq!(stats_of(&reply, serial)["runningTasks"], json!(1));
    assert_eq!(stats_of(&reply, serial)["tasksAdded"], json!(0.6));
}

#[tokio::test(flavor = "multi_thread")]
async fn one_dispatch_per_second_paces_the_queue() {
    let server = TestServer::ok().await;
    let (runtime, _) = runtime(&server.url);
    let app = runtime.application();
    // No token pre-fill: the bucket starts empty and earns one token a
    // second, capped at 1.1.
    for id in ["rate-a", "rate-b", "rate-c"] {
        call(
            &app,
            Method::POST,
            &tasks_path("taskRate"),
            Some(&task(
                &json!({"order":id}),
                Some(&task_name("taskRate", id)),
                &[],
            )),
        )
        .await;
    }
    let hits = server.wait_for(3, Duration::from_secs(6)).await;
    assert_eq!(
        hits.iter()
            .map(|hit| header(hit, "x-cloudtasks-taskname").unwrap())
            .collect::<Vec<_>>(),
        ["rate-a", "rate-b", "rate-c"]
    );
    assert!(
        hits[1].at.duration_since(hits[0].at) >= Duration::from_millis(900),
        "{hits:?}"
    );
    assert!(
        hits[2].at.duration_since(hits[1].at) >= Duration::from_millis(900),
        "{hits:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn explicit_url_caller_headers_and_schedule_time_reach_the_handler() {
    let server = TestServer::ok().await;
    let (runtime, _) = runtime(&server.url);
    let app = runtime.application();
    let default = "queue:demo-fireside-functions-oracle-us-central1-taskDefault";
    fill_tokens(&runtime, default);
    let mut explicit = task(
        &json!({"job":"routed-elsewhere"}),
        Some(&task_name("taskDefault", "job-explicit-url")),
        &[],
    );
    if let Some(http_request) = explicit
        .as_object_mut()
        .and_then(|task| task.get_mut("task"))
        .and_then(OrderedJson::as_object_mut)
        .and_then(|task| task.get_mut("httpRequest"))
        .and_then(OrderedJson::as_object_mut)
    {
        http_request.insert(
            "url".to_owned(),
            OrderedJson::String(format!("{}/{PROJECT}/us-central1/taskRetry", server.url)),
        );
        http_request.shift_remove("oidcToken");
    }
    call(
        &app,
        Method::POST,
        &tasks_path("taskDefault"),
        Some(&explicit),
    )
    .await;
    let hits = server.wait_for(1, Duration::from_secs(3)).await;
    assert_eq!(hits[0].path, format!("/{PROJECT}/us-central1/taskRetry"));
    assert_eq!(header(&hits[0], "x-cloudtasks-queuename"), Some(default));

    let mut with_headers = task(
        &json!({"job":"headers"}),
        Some(&task_name("taskDefault", "job-headers")),
        &[],
    );
    if let Some(http_request) = with_headers
        .as_object_mut()
        .and_then(|task| task.get_mut("task"))
        .and_then(OrderedJson::as_object_mut)
        .and_then(|task| task.get_mut("httpRequest"))
        .and_then(OrderedJson::as_object_mut)
    {
        http_request.insert(
            "headers".to_owned(),
            OrderedJson::parse(r#"{"Content-Type":"application/json","X-Synthetic-Header":"from-caller","X-CloudTasks-QueueName":"caller-override"}"#).unwrap(),
        );
    }
    call(
        &app,
        Method::POST,
        &tasks_path("taskDefault"),
        Some(&with_headers),
    )
    .await;
    let hits = server.wait_for(2, Duration::from_secs(3)).await;
    let hit = hits
        .iter()
        .find(|hit| header(hit, "x-cloudtasks-taskname") == Some("job-headers"))
        .unwrap();
    assert_eq!(
        header(hit, "x-cloudtasks-queuename"),
        Some("caller-override")
    );
    assert_eq!(header(hit, "x-synthetic-header"), Some("from-caller"));
    // The override keeps the emulator header's position; the new header
    // follows the emulator's.
    assert_eq!(
        task_headers(hit),
        [
            "content-type",
            "x-cloudtasks-queuename",
            "x-cloudtasks-taskname",
            "x-cloudtasks-taskretrycount",
            "x-cloudtasks-taskexecutioncount",
            "x-cloudtasks-tasketa",
            "x-synthetic-header",
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_schedule_time_is_sent_as_the_eta_and_never_delays() {
    let server = TestServer::ok().await;
    let (runtime, _) = runtime(&server.url);
    let app = runtime.application();
    let default = "queue:demo-fireside-functions-oracle-us-central1-taskDefault";
    fill_tokens(&runtime, default);
    let scheduled = task(
        &json!({"job":"scheduled"}),
        Some(&task_name("taskDefault", "job-scheduled")),
        &[(
            "scheduleTime",
            OrderedJson::String(SCHEDULE_TIME.to_owned()),
        )],
    );
    let reply = call(
        &app,
        Method::POST,
        &tasks_path("taskDefault"),
        Some(&scheduled),
    )
    .await;
    assert!(
        reply
            .body
            .ends_with(&format!(r#""scheduleTime":"{SCHEDULE_TIME}"}}}}"#))
    );
    let hits = server.wait_for(1, Duration::from_secs(3)).await;
    let hit = hits
        .iter()
        .find(|hit| header(hit, "x-cloudtasks-taskname") == Some("job-scheduled"))
        .unwrap();
    assert_eq!(header(hit, "x-cloudtasks-tasketa"), Some(SCHEDULE_TIME));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dispatch_deadline_aborts_the_request_and_retries() {
    let server = TestServer::start(|_, _| (204, Duration::from_millis(1500))).await;
    let (runtime, lines) = runtime(&server.url);
    let app = runtime.application();
    let body = OrderedJson::parse(&format!(
        r#"{{"retryConfig":{{"maxAttempts":1,"minBackoffSeconds":0.05}},"defaultUri":"{}/slow"}}"#,
        server.url
    ))
    .unwrap();
    call(&app, Method::POST, &queue_path("slow"), Some(&body)).await;
    let key = queue_key(PROJECT, "us-central1", "slow");
    fill_tokens(&runtime, &key);
    let reply = call(
        &app,
        Method::POST,
        &tasks_path("slow"),
        Some(&task(
            &json!({"sleepMs":2500}),
            Some(&task_name("slow", "slow-1")),
            &[("dispatchDeadline", OrderedJson::String("1s".to_owned()))],
        )),
    )
    .await;
    assert!(reply.body.ends_with(r#""dispatchDeadline":"1s"}}"#));
    let hits = server.wait_for(2, Duration::from_secs(5)).await;
    assert_eq!(header(&hits[0], "x-cloudtasks-taskretrycount"), Some("0"));
    assert_eq!(header(&hits[1], "x-cloudtasks-taskretrycount"), Some("1"));
    assert_eq!(header(&hits[1], "x-cloudtasks-taskpreviousresponse"), None);
    assert!(hits[1].at.duration_since(hits[0].at) >= Duration::from_millis(1000));
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let reply = call(&app, Method::GET, "/queueStats", None).await;
        if stats_of(&reply, &key)["failedTasks"] == json!(0.2) {
            break;
        }
        assert!(Instant::now() < deadline, "never failed: {}", reply.body);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        lines
            .lock()
            .unwrap()
            .iter()
            .filter(|(level, text)| level == "WARN"
                && text == "AbortError: The user aborted a request.")
            .count(),
        2
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreachable_target_logs_fetch_errors_and_fails_the_task() {
    let (runtime, lines) = runtime("http://127.0.0.1:1");
    let app = runtime.application();
    let body = OrderedJson::parse(r#"{"retryConfig":{"maxAttempts":1,"minBackoffSeconds":0.05},"defaultUri":"http://127.0.0.1:1/never"}"#).unwrap();
    call(
        &app,
        Method::POST,
        &queue_path("manual-defaults"),
        Some(&body),
    )
    .await;
    let key = queue_key(PROJECT, "us-central1", "manual-defaults");
    fill_tokens(&runtime, &key);
    call(
        &app,
        Method::POST,
        &tasks_path("manual-defaults"),
        Some(&task(
            &json!({"job":"unreachable"}),
            Some(&task_name("manual-defaults", "unreachable-1")),
            &[],
        )),
    )
    .await;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let reply = call(&app, Method::GET, "/queueStats", None).await;
        if stats_of(&reply, &key)["failedTasks"] == json!(0.2) {
            assert_eq!(stats_of(&reply, &key)["completedLastMin"], json!(1));
            break;
        }
        assert!(Instant::now() < deadline, "never failed: {}", reply.body);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let fetch_errors = lines
        .lock()
        .unwrap()
        .iter()
        .filter(|(level, text)| level == "WARN" && text.starts_with("FetchError"))
        .map(|(_, text)| text.clone())
        .collect::<Vec<_>>();
    assert_eq!(
        fetch_errors,
        vec![
            "FetchError: request to http://127.0.0.1:1/never failed, reason: connect ECONNREFUSED 127.0.0.1:1";
            2
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn replacing_a_queue_drops_its_pending_tasks_and_frees_its_names() {
    let (runtime, _) = runtime("http://127.0.0.1:5001");
    let app = runtime.application();
    let body = OrderedJson::parse(
        r#"{"rateLimits":{"maxDispatchesPerSecond":0},"defaultUri":"http://127.0.0.1:1/never"}"#,
    )
    .unwrap();
    call(&app, Method::POST, &queue_path("replace"), Some(&body)).await;
    let key = queue_key(PROJECT, "us-central1", "replace");
    let envelope = task(&json!({}), Some(&task_name("replace", "t")), &[]);
    let reply = call(&app, Method::POST, &tasks_path("replace"), Some(&envelope)).await;
    assert_eq!(reply.status, StatusCode::OK);
    let reply = call(&app, Method::POST, &tasks_path("replace"), Some(&envelope)).await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    call(&app, Method::POST, &queue_path("replace"), Some(&body)).await;
    let reply = call(&app, Method::GET, "/queueStats", None).await;
    assert_eq!(stats_of(&reply, &key)["numberOfTasks"], json!(0));
    assert_eq!(stats_of(&reply, &key)["tasksAdded"], json!(0));
    let reply = call(&app, Method::POST, &tasks_path("replace"), Some(&envelope)).await;
    assert_eq!(reply.status, StatusCode::OK);
}

// ---------------------------------------------------------------------------
// Discovery.

fn two_queue_inventory(retry_attempts: &serde_json::Value) -> FunctionsInventory {
    FunctionsInventory::from_backends_json(
        &json!({
            "backends": [{
                "functionTriggers": [
                    {
                        "entryPoint": "taskOne",
                        "platform": "gcfv2",
                        "region": "us-central1",
                        "name": "taskOne",
                        "id": "us-central1-taskOne",
                        "httpsTrigger": {},
                        "taskQueueTrigger": {
                            "retryConfig": {
                                "maxAttempts": retry_attempts,
                                "maxRetrySeconds": null,
                                "maxBackoffSeconds": null,
                                "maxDoublings": null,
                                "minBackoffSeconds": null
                            },
                            "rateLimits": {
                                "maxConcurrentDispatches": null,
                                "maxDispatchesPerSecond": 0
                            }
                        }
                    },
                    {
                        "entryPoint": "plainHttp",
                        "platform": "gcfv2",
                        "region": "us-central1",
                        "name": "plainHttp",
                        "httpsTrigger": {}
                    },
                    {
                        "entryPoint": "taskTwo",
                        "platform": "gcfv2",
                        "region": "europe-west1",
                        "name": "taskTwo",
                        "httpsTrigger": {},
                        "taskQueueTrigger": {
                            "retryConfig": {
                                "maxAttempts": 5,
                                "maxRetrySeconds": 30,
                                "maxBackoffSeconds": 10,
                                "maxDoublings": 3,
                                "minBackoffSeconds": 0.5
                            },
                            "rateLimits": {
                                "maxConcurrentDispatches": 2,
                                "maxDispatchesPerSecond": 3
                            }
                        }
                    }
                ]
            }]
        }),
        0,
    )
    .unwrap()
}

#[tokio::test]
async fn discovery_registers_task_functions_and_refresh_replaces_only_changes() {
    let (log, _) = recording_log();
    let runtime = TasksRuntime::new(
        "demo-two",
        &two_queue_inventory(&json!(null)),
        "http://127.0.0.1:5001/",
        log,
    );
    assert_eq!(
        runtime.queue_keys(),
        [
            "queue:demo-two-us-central1-taskOne",
            "queue:demo-two-europe-west1-taskTwo"
        ]
    );
    assert_eq!(
        runtime.queue_config("queue:demo-two-us-central1-taskOne").map(|config| config.stringify()),
        Some(r#"{"retryConfig":{"maxAttempts":3,"maxRetrySeconds":null,"maxBackoffSeconds":3600,"maxDoublings":16,"minBackoffSeconds":0.1},"rateLimits":{"maxConcurrentDispatches":1000,"maxDispatchesPerSecond":0},"timeoutSeconds":10,"retry":false,"defaultUri":"http://127.0.0.1:5001/demo-two/us-central1/taskOne"}"#.to_owned())
    );
    assert_eq!(
        runtime.queue_config("queue:demo-two-europe-west1-taskTwo").map(|config| config.stringify()),
        Some(r#"{"retryConfig":{"maxAttempts":5,"maxRetrySeconds":30,"maxBackoffSeconds":10,"maxDoublings":3,"minBackoffSeconds":0.5},"rateLimits":{"maxConcurrentDispatches":2,"maxDispatchesPerSecond":3},"timeoutSeconds":10,"retry":false,"defaultUri":"http://127.0.0.1:5001/demo-two/europe-west1/taskTwo"}"#.to_owned())
    );
    // A pending task survives a reload that changes nothing about its queue.
    let app = runtime.application();
    let reply = call(
        &app,
        Method::POST,
        "/projects/demo-two/locations/us-central1/queues/taskOne/tasks",
        Some(&task(
            &json!({}),
            Some("projects/demo-two/locations/us-central1/queues/taskOne/tasks/t"),
            &[],
        )),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    call(
        &app,
        Method::POST,
        "/projects/demo-two/locations/us-central1/queues/manual",
        Some(&OrderedJson::object()),
    )
    .await;
    runtime.refresh_inventory(&two_queue_inventory(&json!(null)), "http://127.0.0.1:5001");
    let reply = call(&app, Method::GET, "/queueStats", None).await;
    assert_eq!(
        stats_of(&reply, "queue:demo-two-us-central1-taskOne")["numberOfTasks"],
        json!(1)
    );
    // A changed configuration re-registers the queue in place.
    runtime.refresh_inventory(&two_queue_inventory(&json!(7)), "http://127.0.0.1:5001");
    assert_eq!(
        runtime.queue_keys(),
        [
            "queue:demo-two-us-central1-taskOne",
            "queue:demo-two-europe-west1-taskTwo",
            "queue:demo-two-us-central1-manual",
        ]
    );
    let reply = call(&app, Method::GET, "/queueStats", None).await;
    assert_eq!(
        stats_of(&reply, "queue:demo-two-us-central1-taskOne")["numberOfTasks"],
        json!(0)
    );
    assert!(
        runtime
            .queue_config("queue:demo-two-us-central1-taskOne")
            .unwrap()
            .stringify()
            .contains(r#""maxAttempts":7"#)
    );
    // A function whose name the validator rejects is skipped with the
    // official warning.
    let (log, lines) = recording_log();
    let inventory = FunctionsInventory::from_backends_json(
        &json!({"backends":[{"functionTriggers":[{"entryPoint":"bad_name","platform":"gcfv1","regions":["us-central1"],"name":"bad_name","httpsTrigger":{},"taskQueueTrigger":{}}]}]}),
        0,
    )
    .unwrap();
    let runtime = TasksRuntime::new("demo-two", &inventory, "http://127.0.0.1:5001", log);
    assert!(runtime.queue_keys().is_empty());
    assert!(
        lines
            .lock()
            .unwrap()
            .iter()
            .any(|(level, text)| level == "WARN"
                && text.starts_with("Error adding Task Queue function: "))
    );
    runtime.shutdown().await;
    runtime.shutdown().await;
}

// ---------------------------------------------------------------------------
// Coercions.

#[test]
fn deadline_parsing_follows_parse_int_and_set_timeout() {
    let text = |value: &str| OrderedJson::String(value.to_owned());
    assert_eq!(dispatch_deadline(None), Duration::from_secs(60));
    assert_eq!(dispatch_deadline(Some(&text(""))), Duration::from_secs(60));
    assert_eq!(
        dispatch_deadline(Some(&OrderedJson::Null)),
        Duration::from_secs(60)
    );
    assert_eq!(dispatch_deadline(Some(&text("1s"))), Duration::from_secs(1));
    assert_eq!(
        dispatch_deadline(Some(&text("15s"))),
        Duration::from_secs(15)
    );
    assert_eq!(
        dispatch_deadline(Some(&text("1.9s"))),
        Duration::from_secs(1)
    );
    assert_eq!(
        dispatch_deadline(Some(&text("abc"))),
        Duration::from_millis(1)
    );
    assert_eq!(
        dispatch_deadline(Some(&text("0s"))),
        Duration::from_millis(1)
    );
    assert_eq!(
        dispatch_deadline(Some(&text("-5s"))),
        Duration::from_millis(1)
    );
    assert_eq!(
        dispatch_deadline(Some(&text("9999999999s"))),
        Duration::from_millis(1)
    );
    assert_eq!(
        dispatch_deadline(Some(&OrderedJson::Number(15.into()))),
        Duration::from_millis(1)
    );
    assert_eq!(parse_int(" 42abc"), Some(42));
    assert_eq!(parse_int("-7"), Some(-7));
    assert_eq!(parse_int("x"), None);
}

#[test]
#[allow(clippy::float_cmp)]
fn javascript_number_and_base64_coercions() {
    assert_eq!(js_number_text(1.0), "1");
    assert_eq!(js_number_text(0.2), "0.2");
    assert_eq!(js_number_text(1.6), "1.6");
    assert_eq!(js_number_text(5_116_797_719_252_446.0), "5116797719252446");
    assert_eq!(js_number_text(-0.0), "0");
    assert_eq!(OrderedJson::Bool(true).js_string(), "true");
    assert_eq!(
        OrderedJson::parse("[1,null,\"a\"]").unwrap().js_string(),
        "1,,a"
    );
    assert_eq!(OrderedJson::object().js_string(), "[object Object]");
    assert_eq!(OrderedJson::String("0x10".to_owned()).js_number(), 16.0);
    assert!(OrderedJson::String("abc".to_owned()).js_number().is_nan());
    assert_eq!(
        decode_base64_forgiving("eyJkYXRhIjp7ImpvYiI6Im5hbWVkIn19"),
        br#"{"data":{"job":"named"}}"#
    );
    assert_eq!(
        decode_base64_forgiving("eyJk YXRh\nIjp7ImpvYiI6Im5hbWVkIn19"),
        br#"{"data":{"job":"named"}}"#
    );
    assert_eq!(decode_base64_forgiving("aGk"), b"hi");
    assert_eq!(decode_base64_forgiving("aGk=trailing"), b"hi");
    assert_eq!(
        OrderedJson::parse(r#"{"z":1,"a":{"y":0.1,"b":null}}"#)
            .unwrap()
            .stringify(),
        r#"{"z":1,"a":{"y":0.1,"b":null}}"#
    );
}
