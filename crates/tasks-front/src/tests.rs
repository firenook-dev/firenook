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
use firenook_functions_bridge::FunctionsInventory;
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
    // The `(level, text)` printer the suite hands over converts into a sink.
    let log = LogSink::from(Arc::new(move |level: &str, text: &str| {
        sink.lock()
            .unwrap()
            .push((level.to_owned(), text.to_owned()));
    }));
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
    /// The body every response carries.
    body: Mutex<String>,
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
            body: Mutex::new(String::new()),
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

    /// Every response carries `body` from now on.
    fn respond_with(&self, body: &str) {
        body.clone_into(&mut self.state.body.lock().unwrap());
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
    let body = state.body.lock().unwrap().clone();
    let mut response = Response::new(Body::from(body));
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
                    id: 0,
                    name: task_name("full", &index.to_string()),
                    url: Some("http://127.0.0.1:1/never".to_owned()),
                    headers: Vec::new(),
                    body: "{}".to_owned(),
                    schedule_time: None,
                    deadline: Duration::from_secs(60),
                    enqueued_at: std::time::SystemTime::now(),
                    origin: crate::queue::TaskOrigin::Wire,
                    scheduled: None,
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
    assert_eq!(runtime.queue_keys(), [] as [std::string::String; 0]);
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

// ---------------------------------------------------------------------------
// The console's state beside each queue: task ids, attempts, history,
// controls, the console enqueue, registrations.

mod console {
    use std::time::SystemTime;

    use super::*;
    use crate::queue::{
        AttemptRecord, Controls, Finished, Outcome, RunNow, Stopped, TaskOrigin, TaskOutcome,
        TaskQueue, TaskRecord,
    };
    use crate::runtime::{
        ConsoleTask, ControlError, EnqueueError, FinishedTask, QueueOrigin, QueueParts,
    };

    /// Registers a client queue over HTTP and returns its key.
    async fn client_queue(runtime: &TasksRuntime, queue: &str, body: &serde_json::Value) -> String {
        let reply = call(
            &runtime.application(),
            Method::POST,
            &queue_path(queue),
            Some(&OrderedJson::from_value(body)),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        queue_key(PROJECT, "us-central1", queue)
    }

    /// A task as the wire's enqueue records it, to `url`.
    fn record(name: &str, url: &str, body: &str) -> TaskRecord {
        TaskRecord {
            id: 0,
            name: name.to_owned(),
            url: Some(url.to_owned()),
            headers: Vec::new(),
            body: body.to_owned(),
            schedule_time: None,
            deadline: Duration::from_secs(60),
            enqueued_at: SystemTime::now(),
            origin: TaskOrigin::Wire,
            scheduled: None,
        }
    }

    fn history(runtime: &TasksRuntime, key: &str) -> Vec<FinishedTask> {
        runtime.with_state(|state| {
            state
                .console
                .get(key)
                .map(|console| console.history.iter().cloned().collect())
                .unwrap_or_default()
        })
    }

    /// The history's counts by outcome, as kept, after checking them
    /// against a count of the history itself.
    fn outcomes(runtime: &TasksRuntime, key: &str) -> crate::inspect::OutcomeCounts {
        let mut scanned = crate::inspect::OutcomeCounts::default();
        for entry in history(runtime, key) {
            scanned.add(entry.finished.outcome);
        }
        let kept = runtime.queue_view(key).unwrap().counters.outcomes;
        assert_eq!(kept, scanned, "the outcome counts follow the history");
        assert_eq!(
            usize::try_from(kept.total()).unwrap(),
            history(runtime, key).len()
        );
        kept
    }

    async fn wait_until(what: &str, timeout: Duration, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + timeout;
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn attempt(queue: &str, task_id: u64, attempt: u32) -> AttemptRecord {
        AttemptRecord {
            queue_key: queue.to_owned(),
            task_id,
            task_name: format!("t{task_id}"),
            attempt,
            started_at: SystemTime::now(),
            duration: Duration::from_millis(1),
            status: Some(500),
            error: None,
            response: None,
            counted_execution: false,
            retry_count: attempt - 1,
        }
    }

    #[test]
    fn windows_are_trimmed_without_queue_stats() {
        let config = QueueConfig::from_body(
            &OrderedJson::parse(
                r#"{"retryConfig":{"maxAttempts":0},"defaultUri":"http://127.0.0.1:1/x"}"#,
            )
            .unwrap(),
        )
        .unwrap();
        let start = Instant::now();
        let mut queue = TaskQueue::new("queue:p-l-q".to_owned(), config, start);
        let controls = Controls::default();
        for index in 0..1_000_u64 {
            let mut task = record(&format!("t{index}"), "http://127.0.0.1:1/x", "{}");
            task.id = index + 1;
            queue.enqueue(task, start, controls).unwrap();
        }
        // Ten of them run: five succeed and five fail (no retries).
        queue.set_tokens(10.0);
        let mut next = 0;
        queue.dispatch_tasks(start, &mut next, controls);
        let mut finished = Vec::new();
        let runs = queue.process(start, 0, &mut finished);
        assert_eq!(runs.len(), 10);
        for (index, run) in runs.iter().enumerate() {
            let outcome = if index < 5 {
                Outcome::Status(200)
            } else {
                Outcome::Status(500)
            };
            assert!(queue.complete(
                run.dispatch_id,
                outcome,
                attempt(&run.queue_key, run.task_id, 1),
                start
            ));
        }
        queue.process(start, 0, &mut finished);
        queue.process(start, 0, &mut finished);
        assert_eq!(finished.len(), 10);
        assert_eq!(queue.window_lengths(), (1_000, 10, 5));
        // Not before a second has passed since the last trim.
        queue.trim_windows(start + Duration::from_millis(500));
        assert_eq!(queue.window_lengths(), (1_000, 10, 5));
        // Six minutes on, with nobody asking `/queueStats`.
        queue.trim_windows(start + Duration::from_mins(6));
        assert_eq!(queue.window_lengths(), (0, 0, 0));
    }

    #[tokio::test]
    async fn attempts_keep_the_first_and_the_latest_nine() {
        let server = TestServer::start(|_, _| (500, Duration::ZERO)).await;
        server.respond_with("card declined");
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = client_queue(
            &runtime,
            "declines",
            &json!({
                "retryConfig": {"maxAttempts": 13, "minBackoffSeconds": 0.001, "maxBackoffSeconds": 0.01},
                "defaultUri": format!("{}/declines", server.url)
            }),
        )
        .await;
        let id = runtime
            .enqueue(
                &key,
                record("t1", &format!("{}/declines", server.url), "{}"),
            )
            .unwrap();
        wait_until(
            "the task to run out of retries",
            Duration::from_secs(20),
            || !history(&runtime, &key).is_empty(),
        )
        .await;
        let entry = history(&runtime, &key).remove(0);
        assert_eq!(entry.finished.outcome, TaskOutcome::Failed);
        assert_eq!(entry.finished.task.id, id);
        let log = &entry.finished.attempts;
        assert_eq!(log.count(), 14, "maxAttempts 13 runs 14 times");
        assert_eq!(log.omitted, 4);
        let kept: Vec<u32> = log.records().map(|record| record.attempt).collect();
        assert_eq!(kept, [1, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
        assert!(log.records().all(|record| record.status == Some(500)
            && !record.counted_execution
            && record.retry_count == record.attempt - 1));
        // Snippets are attached to the kept attempts.
        wait_until(
            "the last snippet in the history",
            Duration::from_secs(2),
            || {
                history(&runtime, &key)[0]
                    .finished
                    .attempts
                    .records()
                    .all(|record| record.response.as_deref() == Some("card declined"))
            },
        )
        .await;

        // A refused connection keeps node-fetch's error text.
        let refused = client_queue(
            &runtime,
            "refused",
            &json!({"retryConfig": {"maxAttempts": 0}, "defaultUri": "http://127.0.0.1:1/x"}),
        )
        .await;
        runtime
            .enqueue(&refused, record("r1", "http://127.0.0.1:1/x", "{}"))
            .unwrap();
        wait_until("the refused task to fail", Duration::from_secs(10), || {
            !history(&runtime, &refused).is_empty()
        })
        .await;
        let entry = history(&runtime, &refused).remove(0);
        let first = entry.finished.attempts.first.clone().expect("attempt 1");
        assert_eq!(first.status, None);
        assert_eq!(
            first.error.as_deref(),
            Some(
                "FetchError: request to http://127.0.0.1:1/x failed, reason: connect ECONNREFUSED 127.0.0.1:1"
            )
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn history_ring_is_bounded() {
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = client_queue(
            &runtime,
            "bounded",
            &json!({"rateLimits": {"maxDispatchesPerSecond": 0}, "defaultUri": "http://127.0.0.1:1/x"}),
        )
        .await;
        for index in 0..1_001 {
            runtime
                .enqueue(
                    &key,
                    record(&format!("t{index}"), "http://127.0.0.1:1/x", "{}"),
                )
                .unwrap();
        }
        assert_eq!(runtime.purge(&key, false), Ok((1_001, 0)));
        let kept = history(&runtime, &key);
        assert_eq!(kept.len(), 1_000);
        assert!(
            kept.iter()
                .all(|entry| entry.finished.outcome == TaskOutcome::Purged)
        );
        assert_eq!(kept[0].finished.task.name, "t1", "the oldest went first");
        let dropped = runtime.with_state(|state| state.console[&key].dropped);
        assert_eq!(dropped, 1);
        assert_eq!(
            outcomes(&runtime, &key).purged,
            1_000,
            "the evicted one left the count"
        );

        // Five bodies of 1 MiB: a queue's history keeps at most 4 MiB.
        let body = format!("\"{}\"", "x".repeat(1024 * 1024));
        let heavy = |name: String| {
            let runtime = &runtime;
            let body = &body;
            async move {
                let key = client_queue(
                    runtime,
                    &name,
                    &json!({"rateLimits": {"maxDispatchesPerSecond": 0}, "defaultUri": "http://127.0.0.1:1/x"}),
                )
                .await;
                for index in 0..5 {
                    runtime
                        .enqueue(
                            &key,
                            record(&format!("{name}-{index}"), "http://127.0.0.1:1/x", body),
                        )
                        .unwrap();
                }
                runtime.purge(&key, false).unwrap();
                key
            }
        };
        let first = heavy("heavy0".to_owned()).await;
        let (bytes, kept) = runtime.with_state(|state| {
            let console = &state.console[&first];
            (console.history_bytes, console.history.len())
        });
        assert!(bytes <= crate::runtime::HISTORY_BYTES);
        assert_eq!(kept, 3, "5 MiB of bodies trimmed under 4 MiB");
        assert_eq!(outcomes(&runtime, &first).purged, 3);
        assert_eq!(history(&runtime, &first)[0].finished.task.name, "heavy0-2");

        // Eleven such queues hold about 33 MiB: every history together keeps
        // at most 32 MiB, the oldest of the largest going first.
        let mut keys = vec![first];
        for index in 1..11 {
            keys.push(heavy(format!("heavy{index}")).await);
        }
        let (total, each) = runtime.with_state(|state| {
            let each: Vec<usize> = keys
                .iter()
                .map(|key| state.console[key].history_bytes)
                .collect();
            (state.history_bytes, each)
        });
        assert!(total <= crate::runtime::ALL_HISTORY_BYTES, "{total}");
        assert!(
            each.iter()
                .all(|bytes| *bytes <= crate::runtime::HISTORY_BYTES)
        );
        assert!(
            each.iter().any(|bytes| *bytes < 3 * 1024 * 1024),
            "a queue gave up part of its history: {each:?}"
        );
        for key in &keys {
            outcomes(&runtime, key);
        }
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn every_outcome_reaches_the_history() {
        let ok = TestServer::ok().await;
        let failing = TestServer::start(|_, _| (500, Duration::ZERO)).await;
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = client_queue(
            &runtime,
            "outcomes",
            &json!({
                "retryConfig": {"maxAttempts": 0, "minBackoffSeconds": 60},
                "defaultUri": format!("{}/ok", ok.url)
            }),
        )
        .await;
        let succeeded = runtime
            .enqueue(&key, record("ok", &format!("{}/ok", ok.url), "{}"))
            .unwrap();
        let failed = runtime
            .enqueue(&key, record("bad", &format!("{}/bad", failing.url), "{}"))
            .unwrap();
        wait_until("two finished tasks", Duration::from_secs(10), || {
            history(&runtime, &key).len() == 2
        })
        .await;
        runtime.set_paused(&key, true).unwrap();
        let deleted = runtime
            .enqueue(
                &key,
                record(&task_name("outcomes", "gone"), "http://127.0.0.1:1/x", "{}"),
            )
            .unwrap();
        let reply = call(
            &runtime.application(),
            Method::DELETE,
            &format!("{}/gone", tasks_path("outcomes")),
            None,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        let purged = runtime
            .enqueue(&key, record("purged", "http://127.0.0.1:1/x", "{}"))
            .unwrap();
        runtime.purge(&key, false).unwrap();
        let outcomes: Vec<(u64, TaskOutcome)> = history(&runtime, &key)
            .iter()
            .map(|entry| (entry.finished.task.id, entry.finished.outcome))
            .collect();
        assert!(outcomes.contains(&(succeeded, TaskOutcome::Succeeded)));
        assert!(outcomes.contains(&(failed, TaskOutcome::Failed)));
        assert!(outcomes.contains(&(deleted, TaskOutcome::Deleted)));
        assert!(outcomes.contains(&(purged, TaskOutcome::Purged)));
        let counts = self::outcomes(&runtime, &key);
        assert_eq!(
            (
                counts.succeeded,
                counts.failed,
                counts.deleted,
                counts.purged
            ),
            (1, 1, 1, 1)
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn pause_holds_pending_and_takes_no_tokens() {
        let server = TestServer::ok().await;
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = client_queue(&runtime, "paused", &json!({"defaultUri": server.url})).await;
        runtime.set_paused(&key, true).unwrap();
        for index in 0..3 {
            runtime
                .enqueue(&key, record(&format!("p{index}"), &server.url, "{}"))
                .unwrap();
        }
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        assert_eq!(server.hits().len(), 0, "a paused queue dispatches nothing");
        let (pending, tokens) = runtime.with_state(|state| {
            let queue = &state.queues[&key];
            (queue.pending().len(), queue.bucket().0)
        });
        assert_eq!(pending, 3);
        assert!(tokens >= 1.0, "tokens accrue while paused");
        runtime.set_paused(&key, false).unwrap();
        server.wait_for(3, Duration::from_secs(3)).await;
        assert_eq!(
            runtime.set_paused("queue:none", true),
            Err(ControlError::UnknownQueue)
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn run_now_bypasses_tokens_and_pause_but_not_slots() {
        let slow = TestServer::start(|path, _| {
            if path == "/fail" {
                (500, Duration::ZERO)
            } else {
                (204, Duration::from_millis(600))
            }
        })
        .await;
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = client_queue(
            &runtime,
            "single",
            &json!({
                "retryConfig": {"minBackoffSeconds": 60},
                "rateLimits": {"maxConcurrentDispatches": 1, "maxDispatchesPerSecond": 0},
                "defaultUri": slow.url
            }),
        )
        .await;
        runtime.set_paused(&key, true).unwrap();
        let first = runtime
            .enqueue(&key, record("first", &format!("{}/slow", slow.url), "{}"))
            .unwrap();
        let second = runtime
            .enqueue(&key, record("second", &format!("{}/slow", slow.url), "{}"))
            .unwrap();
        // No token and paused: Run now still takes the free slot.
        assert_eq!(runtime.run_now(&key, first), Ok(RunNow::Started));
        slow.wait_for(1, Duration::from_secs(3)).await;
        assert_eq!(runtime.run_now(&key, first), Err(ControlError::Running));
        assert_eq!(runtime.run_now(&key, second), Err(ControlError::Busy));
        assert_eq!(runtime.run_now(&key, 999), Err(ControlError::UnknownTask));
        wait_until("the first to finish", Duration::from_secs(5), || {
            history(&runtime, &key).len() == 1
        })
        .await;

        // A task in a 60-second backoff runs on the next tick.
        let failing = runtime
            .enqueue(&key, record("failing", &format!("{}/fail", slow.url), "{}"))
            .unwrap();
        assert_eq!(runtime.run_now(&key, failing), Ok(RunNow::Started));
        wait_until("the first failure", Duration::from_secs(3), || {
            slow.hits().iter().any(|hit| hit.path == "/fail")
        })
        .await;
        wait_until("the backoff", Duration::from_secs(3), || {
            runtime.with_state(|state| {
                state.queues[&key]
                    .dispatches()
                    .iter()
                    .any(|dispatch| dispatch.task.id == failing && dispatch.in_backoff())
            })
        })
        .await;
        assert_eq!(runtime.run_now(&key, failing), Ok(RunNow::BackoffSkipped));
        wait_until("the second attempt", Duration::from_secs(3), || {
            slow.hits().iter().filter(|hit| hit.path == "/fail").count() == 2
        })
        .await;
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn console_enqueue_matches_the_admin_sdk_dispatch() {
        let server = TestServer::ok().await;
        let (runtime, _) = runtime(&server.url);
        let key = queue_key(PROJECT, "us-central1", "taskDefault");
        fill_tokens(&runtime, &key);
        let enqueued = runtime
            .enqueue_console(
                &key,
                ConsoleTask {
                    data: Some(r#"{"via":"admin-options"}"#.to_owned()),
                    id: Some("admin-opt-1".to_owned()),
                    dispatch_deadline_seconds: Some(15),
                    headers: vec![("x-synthetic-header".to_owned(), "admin".to_owned())],
                    ..ConsoleTask::default()
                },
            )
            .unwrap();
        assert_eq!(enqueued.name, task_name("taskDefault", "admin-opt-1"));
        let hit = server.wait_for(1, Duration::from_secs(5)).await.remove(0);
        // The headers the Admin SDK's own enqueue produced in the corpus.
        let corpus = corpus();
        let step = step(&corpus, "tasks-admin-sdk", "admin-enqueue-options");
        let observed = step
            .get("observations")
            .and_then(OrderedJson::as_array)
            .and_then(|observations| {
                observations.iter().find(|observation| {
                    observation.get("handler").and_then(OrderedJson::as_str) == Some("taskDefault")
                })
            })
            .and_then(|observation| observation.get("task"))
            .cloned()
            .expect("the handler's observation");
        let headers = observed
            .get("headers")
            .and_then(OrderedJson::as_object)
            .unwrap();
        for (name, value) in headers {
            match value {
                OrderedJson::String(text) if text == "{{time}}" => {
                    assert!(header(&hit, name).is_some(), "{name}");
                }
                OrderedJson::String(text) => {
                    assert_eq!(header(&hit, name), Some(text.as_str()), "{name}");
                }
                _ => {}
            }
        }
        let body: serde_json::Value = serde_json::from_str(&hit.body).unwrap();
        assert_eq!(body["data"], observed.get("data").unwrap().to_value());
        assert_eq!(hit.path, format!("/{PROJECT}/us-central1/taskDefault"));
        // The task remembers it came from the console.
        wait_until("the task to finish", Duration::from_secs(5), || {
            history(&runtime, &key)
                .iter()
                .any(|entry| entry.finished.task.id == enqueued.id)
        })
        .await;
        let entry = history(&runtime, &key)
            .into_iter()
            .find(|entry| entry.finished.task.id == enqueued.id)
            .unwrap();
        assert_eq!(entry.finished.task.origin, TaskOrigin::Console);
        assert_eq!(entry.finished.task.deadline, Duration::from_secs(15));

        // A reused name, an unknown queue and an id no SDK accepts.
        assert_eq!(
            runtime.enqueue_console(
                &key,
                ConsoleTask {
                    id: Some("admin-opt-1".to_owned()),
                    ..ConsoleTask::default()
                }
            ),
            Err(EnqueueError::NameReserved)
        );
        assert_eq!(
            runtime.enqueue_console("queue:nope", ConsoleTask::default()),
            Err(EnqueueError::UnknownQueue)
        );
        assert!(matches!(
            runtime.enqueue_console(
                &key,
                ConsoleTask {
                    id: Some("has space".to_owned()),
                    ..ConsoleTask::default()
                }
            ),
            Err(EnqueueError::Invalid(_))
        ));
        assert!(matches!(
            runtime.enqueue_console(
                &key,
                ConsoleTask {
                    data: Some("{oops".to_owned()),
                    ..ConsoleTask::default()
                }
            ),
            Err(EnqueueError::Invalid(_))
        ));
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn a_delayed_console_task_carries_its_schedule_time_and_can_be_held() {
        let server = TestServer::ok().await;
        let (runtime, _) = runtime(&server.url);
        let key = queue_key(PROJECT, "us-central1", "taskDefault");
        runtime.set_hold_scheduled(&key, true).unwrap();
        let later = runtime
            .enqueue_console(
                &key,
                ConsoleTask {
                    data: Some("1".to_owned()),
                    schedule_delay_seconds: Some(60.0),
                    ..ConsoleTask::default()
                },
            )
            .unwrap();
        assert!(later.name.starts_with(&format!(
            "/projects/{PROJECT}/locations/us-central1/queues/taskDefault/tasks/"
        )));
        let (held, scheduled) = runtime.with_state(|state| {
            let queue = &state.queues[&key];
            let task = queue.held().next().cloned();
            (queue.held().len(), task.and_then(|task| task.scheduled))
        });
        assert_eq!(held, 1);
        let scheduled = scheduled.expect("a parsed schedule time");
        let ahead = scheduled.duration_since(SystemTime::now()).unwrap();
        assert!(ahead > Duration::from_secs(55) && ahead <= Duration::from_secs(60));
        // Off, the emulator's own behaviour: it runs at once.
        fill_tokens(&runtime, &key);
        runtime.set_hold_scheduled(&key, false).unwrap();
        let hit = server.wait_for(1, Duration::from_secs(3)).await.remove(0);
        let eta = header(&hit, "x-cloudtasks-tasketa").unwrap();
        assert!(eta.ends_with('Z') && eta.contains('T'), "{eta}");
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn stop_retrying_cancels_backoff_and_after_running() {
        let server = TestServer::start(|path, _| {
            if path == "/slow" {
                (500, Duration::from_millis(600))
            } else {
                (500, Duration::ZERO)
            }
        })
        .await;
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = client_queue(
            &runtime,
            "stopping",
            &json!({"retryConfig": {"minBackoffSeconds": 60}, "defaultUri": server.url}),
        )
        .await;
        fill_tokens(&runtime, &key);
        let backoff = runtime
            .enqueue(
                &key,
                record("backoff", &format!("{}/fast", server.url), "{}"),
            )
            .unwrap();
        wait_until("the backoff", Duration::from_secs(5), || {
            runtime.with_state(|state| {
                state.queues[&key]
                    .dispatches()
                    .iter()
                    .any(|dispatch| dispatch.task.id == backoff && dispatch.in_backoff())
            })
        })
        .await;
        assert_eq!(runtime.stop_retrying(&key, backoff), Ok(Stopped::Cancelled));
        let entry = history(&runtime, &key).remove(0);
        assert_eq!(entry.finished.outcome, TaskOutcome::Cancelled);
        assert_eq!(entry.finished.attempts.count(), 1);
        let (slots, busy) = runtime.with_state(|state| state.queues[&key].slot_usage());
        assert_eq!(busy, 0, "the slot is free ({slots})");

        // In flight: the failure cancels instead of retrying.
        let running = runtime
            .enqueue(
                &key,
                record("running", &format!("{}/slow", server.url), "{}"),
            )
            .unwrap();
        wait_until("the slow request", Duration::from_secs(5), || {
            server.hits().iter().any(|hit| hit.path == "/slow")
        })
        .await;
        assert_eq!(
            runtime.stop_retrying(&key, running),
            Ok(Stopped::AfterRunning)
        );
        wait_until("the cancellation", Duration::from_secs(5), || {
            history(&runtime, &key).len() == 2
        })
        .await;
        let entry = history(&runtime, &key).remove(1);
        assert_eq!(entry.finished.task.id, running);
        assert_eq!(entry.finished.outcome, TaskOutcome::Cancelled);
        assert_eq!(entry.finished.attempts.count(), 1);
        assert_eq!(
            server
                .hits()
                .iter()
                .filter(|hit| hit.path == "/slow")
                .count(),
            1
        );

        // A pending task has no retries to stop.
        runtime.set_paused(&key, true).unwrap();
        let pending = runtime
            .enqueue(&key, record("pending", "http://127.0.0.1:1/x", "{}"))
            .unwrap();
        assert_eq!(
            runtime.stop_retrying(&key, pending),
            Err(ControlError::NotInSlot)
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn purge_keeps_the_official_count() {
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = client_queue(
            &runtime,
            "purged",
            &json!({"rateLimits": {"maxDispatchesPerSecond": 0}, "defaultUri": "http://127.0.0.1:1/x"}),
        )
        .await;
        for index in 0..5 {
            runtime
                .enqueue(
                    &key,
                    record(
                        &task_name("purged", &format!("t{index}")),
                        "http://127.0.0.1:1/x",
                        "{}",
                    ),
                )
                .unwrap();
        }
        assert_eq!(runtime.purge(&key, true), Ok((5, 0)));
        let reply = call(&runtime.application(), Method::GET, "/queueStats", None).await;
        assert_eq!(stats_of(&reply, &key)["numberOfTasks"], json!(0));
        // The names stay reserved, as officially.
        let reply = call(
            &runtime.application(),
            Method::POST,
            &tasks_path("purged"),
            Some(&task(&json!({}), Some(&task_name("purged", "t0")), &[])),
        )
        .await;
        assert_eq!(reply.status, StatusCode::CONFLICT);
        let kept = history(&runtime, &key);
        assert_eq!(kept.len(), 5);
        assert!(
            kept.iter()
                .all(|entry| entry.finished.outcome == TaskOutcome::Purged)
        );
        runtime.shutdown().await;
    }

    #[test]
    fn held_tasks_rejoin_the_pending_queue_in_id_order() {
        let config =
            QueueConfig::from_body(&OrderedJson::parse(r#"{"defaultUri":"http://x"}"#).unwrap())
                .unwrap();
        let start = Instant::now();
        let mut queue = TaskQueue::new("queue:p-l-q".to_owned(), config, start);
        let hold = Controls {
            paused: false,
            hold_scheduled: true,
        };
        let now = SystemTime::now();
        let enqueue = |queue: &mut TaskQueue, id: u64, due: Option<Duration>| {
            let mut task = record(&format!("t{id}"), "http://x", "{}");
            task.id = id;
            task.scheduled = due.map(|due| now + due);
            queue.enqueue(task, start, hold).unwrap();
        };
        enqueue(&mut queue, 1, Some(Duration::from_secs(60)));
        enqueue(&mut queue, 2, None);
        enqueue(&mut queue, 3, Some(Duration::from_millis(100)));
        enqueue(&mut queue, 4, Some(Duration::ZERO));
        let ids = |queue: &TaskQueue| queue.pending().map(|task| task.id).collect::<Vec<_>>();
        assert_eq!(ids(&queue), [2, 4], "a past schedule time is not held");
        assert_eq!(queue.held().len(), 2);
        assert_eq!(
            queue.next_held_due(),
            Some(now + Duration::from_millis(100))
        );
        assert_eq!(queue.count(), 4, "held tasks count as pending");
        queue.release_due(now + Duration::from_millis(150));
        assert_eq!(ids(&queue), [2, 3, 4]);
        // Holding off: the rest joins at its place.
        queue.set_hold(false, now);
        assert_eq!(ids(&queue), [1, 2, 3, 4]);
        // Holding on again: tasks scheduled for later wait again.
        queue.set_hold(true, now);
        assert_eq!(ids(&queue), [2, 4]);
        // A held queue is idle, a paused one too.
        let mut idle = TaskQueue::new("queue:p-l-r".to_owned(), queue.config.clone(), start);
        let mut task = record("later", "http://x", "{}");
        task.id = 9;
        task.scheduled = Some(now + Duration::from_secs(30));
        idle.enqueue(task, start, hold).unwrap();
        assert!(!idle.is_active(hold));
        assert!(!queue.is_active(Controls {
            paused: true,
            hold_scheduled: true
        }));
        assert!(queue.is_active(hold));
    }

    #[tokio::test]
    async fn hold_scheduled_waits_for_due_tasks_only() {
        let server = TestServer::ok().await;
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = client_queue(&runtime, "held", &json!({"defaultUri": server.url})).await;
        runtime.set_hold_scheduled(&key, true).unwrap();
        let mut later = record("later", &format!("{}/later", server.url), "{}");
        later.schedule_time = Some("2999-01-01T00:00:00.000Z".to_owned());
        later.scheduled = crate::queue::parse_schedule_time("2999-01-01T00:00:00.000Z");
        runtime.enqueue(&key, later).unwrap();
        runtime
            .enqueue(&key, record("now", &format!("{}/now", server.url), "{}"))
            .unwrap();
        let hits = server.wait_for(1, Duration::from_secs(3)).await;
        assert_eq!(
            hits[0].path, "/now",
            "the later-enqueued due task goes first"
        );
        tokio::time::sleep(Duration::from_millis(1_200)).await;
        assert_eq!(server.hits().len(), 1, "the held task waits");
        runtime.set_hold_scheduled(&key, false).unwrap();
        let hits = server.wait_for(2, Duration::from_secs(3)).await;
        assert_eq!(hits[1].path, "/later");
        assert_eq!(
            header(&hits[1], "x-cloudtasks-tasketa"),
            Some("2999-01-01T00:00:00.000Z")
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn rejected_registrations_are_kept_until_registered() {
        let inventory = |concurrency: u32| {
            FunctionsInventory::from_backends_json(
                &json!({"backends": [{"functionTriggers": [
                    {"entryPoint": "badQueue_1", "platform": "gcfv2", "region": "us-central1",
                     "name": "badQueue_1", "id": "us-central1-badQueue_1", "httpsTrigger": {},
                     "taskQueueTrigger": {}},
                    {"entryPoint": "bigQueue", "platform": "gcfv2", "region": "us-central1",
                     "name": "bigQueue", "id": "us-central1-bigQueue", "httpsTrigger": {},
                     "taskQueueTrigger": {"rateLimits": {"maxConcurrentDispatches": concurrency}}}
                ]}]}),
                0,
            )
            .unwrap()
        };
        let (log, _) = recording_log();
        let runtime = TasksRuntime::new(PROJECT, &inventory(6_000), "http://127.0.0.1:5001", log);
        let rejected = runtime.with_state(|state| state.rejected.clone());
        assert_eq!(rejected.len(), 2);
        let bad = &rejected[&queue_key(PROJECT, "us-central1", "badQueue_1")];
        assert_eq!(bad.reason, crate::config::INVALID_QUEUE_ID);
        assert_eq!(bad.function_id, "us-central1-badQueue_1");
        assert_eq!(bad.region, "us-central1");
        let big = &rejected[&queue_key(PROJECT, "us-central1", "bigQueue")];
        assert_eq!(big.reason, crate::config::OVER_CONCURRENCY_LIMIT);
        let first_at = bad.at;
        // A later valid inventory clears the one it registers.
        runtime.refresh_inventory(&inventory(10), "http://127.0.0.1:5001");
        let rejected = runtime.with_state(|state| state.rejected.clone());
        assert_eq!(rejected.len(), 1);
        assert_eq!(rejected[0].name, "badQueue_1");
        assert_eq!(rejected[0].at, first_at, "the same refusal keeps its time");
        assert!(runtime.has_queue(&queue_key(PROJECT, "us-central1", "bigQueue")));
        // A function no longer exported leaves no refusal behind.
        runtime.refresh_inventory(
            &FunctionsInventory::from_backends_json(&json!({"backends": []}), 0).unwrap(),
            "http://127.0.0.1:5001",
        );
        assert_eq!(runtime.with_state(|state| state.rejected.len()), 0);
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn a_re_registration_is_recorded_not_silent() {
        let server = TestServer::start(|_, _| (204, Duration::from_millis(600))).await;
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let body = |attempts: u32| json!({"retryConfig": {"maxAttempts": attempts}, "defaultUri": server.url});
        let key = client_queue(&runtime, "reloaded", &body(3)).await;
        fill_tokens(&runtime, &key);
        let in_flight = runtime
            .enqueue(
                &key,
                record("flight", &format!("{}/flight", server.url), "{}"),
            )
            .unwrap();
        server.wait_for(1, Duration::from_secs(3)).await;
        runtime.set_paused(&key, true).unwrap();
        for index in 0..3 {
            runtime
                .enqueue(&key, record(&format!("p{index}"), &server.url, "{}"))
                .unwrap();
        }
        // The wire answers as it always did.
        let reply = call(
            &runtime.application(),
            Method::POST,
            &queue_path("reloaded"),
            Some(&OrderedJson::from_value(&body(5))),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(
            reply.json()["taskQueueConfig"]["retryConfig"]["maxAttempts"],
            json!(5)
        );
        let (registrations, replaced, paused) = runtime.with_state(|state| {
            let console = &state.console[&key];
            (
                console.registrations,
                console.last_replaced,
                console.controls.paused,
            )
        });
        assert_eq!(registrations, 2);
        assert_eq!(replaced.map(|replaced| replaced.dropped), Some(4));
        assert!(paused, "the pause stays with the key");
        let kept = history(&runtime, &key);
        assert_eq!(kept.len(), 4);
        assert!(
            kept.iter()
                .all(|entry| entry.finished.outcome == TaskOutcome::Replaced)
        );
        // The request in flight finishes into its history entry, never into
        // the new queue.
        wait_until("the in-flight attempt", Duration::from_secs(5), || {
            history(&runtime, &key).iter().any(|entry| {
                entry.finished.task.id == in_flight && entry.finished.attempts.count() == 1
            })
        })
        .await;
        let entry = history(&runtime, &key)
            .into_iter()
            .find(|entry| entry.finished.task.id == in_flight)
            .unwrap();
        assert_eq!(
            entry.finished.attempts.first.as_ref().unwrap().status,
            Some(204)
        );
        assert_eq!(entry.finished.outcome, TaskOutcome::Replaced);
        let slots = runtime.with_state(|state| state.queues[&key].dispatches().len());
        assert_eq!(slots, 0);
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn queue_parts_are_stored_at_registration() {
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let function = queue_key(PROJECT, "europe-west1", "taskAlt");
        let source = runtime.with_state(|state| state.console[&function].source.clone());
        assert_eq!(
            source.parts,
            QueueParts {
                project: PROJECT.to_owned(),
                location: "europe-west1".to_owned(),
                queue: "taskAlt".to_owned()
            }
        );
        assert_eq!(source.origin, QueueOrigin::Function);
        assert_eq!(source.function.unwrap().function_id, "europe-west1-taskAlt");
        // Two triples, one key: the parts are the latest registration's.
        let app = runtime.application();
        for path in [
            "/projects/a-b/locations/c/queues/d",
            "/projects/a/locations/b-c/queues/d",
        ] {
            let reply = call(&app, Method::POST, path, Some(&OrderedJson::object())).await;
            assert_eq!(reply.status, StatusCode::OK);
        }
        let key = queue_key("a", "b-c", "d");
        assert_eq!(key, queue_key("a-b", "c", "d"));
        let source = runtime.with_state(|state| state.console[&key].source.clone());
        assert_eq!(source.parts.project, "a");
        assert_eq!(source.parts.location, "b-c");
        assert_eq!(source.origin, QueueOrigin::Client);
        assert!(source.function.is_none());
        assert_eq!(
            runtime.with_state(|state| state.console[&key].registrations),
            2
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn a_paused_or_held_queue_lets_the_ticker_idle() {
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = client_queue(
            &runtime,
            "idle",
            &json!({"defaultUri": "http://127.0.0.1:1/x"}),
        )
        .await;
        runtime.set_paused(&key, true).unwrap();
        for index in 0..1_000 {
            runtime
                .enqueue(
                    &key,
                    record(&format!("t{index}"), "http://127.0.0.1:1/x", "{}"),
                )
                .unwrap();
        }
        assert_eq!(
            runtime.tick(),
            Duration::from_secs(1),
            "paused with no busy slot is idle"
        );
        runtime.purge(&key, false).unwrap();
        runtime.set_paused(&key, false).unwrap();
        runtime.set_hold_scheduled(&key, true).unwrap();
        let mut later = record("later", "http://127.0.0.1:1/x", "{}");
        later.scheduled = Some(SystemTime::now() + Duration::from_secs(30));
        runtime.enqueue(&key, later).unwrap();
        assert_eq!(runtime.tick(), Duration::from_secs(1), "held only: idle");
        let mut soon = record("soon", "http://127.0.0.1:1/x", "{}");
        soon.scheduled = Some(SystemTime::now() + Duration::from_millis(300));
        runtime.enqueue(&key, soon).unwrap();
        let delay = runtime.tick();
        assert!(
            delay <= Duration::from_millis(300) && delay > Duration::from_millis(100),
            "wakes when the held task is due: {delay:?}"
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn console_enqueue_is_held_to_the_wire_limit() {
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = queue_key(PROJECT, "us-central1", "taskDefault");
        runtime.set_paused(&key, true).unwrap();
        let parts = runtime.queue_parts(&key).unwrap();
        let sized = |length: usize| ConsoleTask {
            data: Some(format!("\"{}\"", "x".repeat(length))),
            ..ConsoleTask::default()
        };
        let size = |length: usize| {
            crate::http::request_size(&crate::http::console_task(&parts, sized(length)).unwrap())
        };
        // The shortest string whose request is over a size (sizes grow with
        // the length).
        let length_for = |target: usize| {
            let (mut low, mut high) = (0_usize, 200_000_usize);
            while low < high {
                let middle = usize::midpoint(low, high);
                if size(middle) > target {
                    high = middle;
                } else {
                    low = middle + 1;
                }
            }
            low
        };
        let over = length_for(101 * 1024);
        assert!(matches!(
            runtime.enqueue_console(&key, sized(over)),
            Err(EnqueueError::TooLarge { limit: 102_400, .. })
        ));
        let under = length_for(99 * 1024) - 1;
        runtime
            .enqueue_console(&key, sized(under))
            .expect("99 KiB is accepted");
        assert_eq!(
            EnqueueError::TooLarge {
                size: 131 * 1024,
                limit: 102_400
            }
            .to_string(),
            "The Tasks port accepts requests up to 100 KiB, as express.json does; this one would be 131 KiB."
        );
        // The Tasks port's own answer to an oversized request is unchanged.
        let big = task(&json!("x".repeat(over)), None, &[]);
        let reply = call(
            &runtime.application(),
            Method::POST,
            &tasks_path("taskDefault"),
            Some(&big),
        )
        .await;
        assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(
            reply
                .body
                .contains("PayloadTooLargeError: request entity too large")
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn delete_by_id_and_enqueue_again() {
        let server = TestServer::ok().await;
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = client_queue(&runtime, "again", &json!({"defaultUri": server.url})).await;
        runtime.set_paused(&key, true).unwrap();
        // An auto-named task, which the wire can never delete.
        let reply = call(
            &runtime.application(),
            Method::POST,
            &tasks_path("again"),
            Some(&task(&json!({"order": 1}), None, &[])),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        let generated = runtime.with_state(|state| {
            let task = state.queues[&key].pending().next().cloned().unwrap();
            assert!(task.generated());
            task.id
        });
        runtime.remove_by_id(&key, generated).unwrap();
        let entry = history(&runtime, &key).remove(0);
        assert_eq!(entry.finished.outcome, TaskOutcome::Deleted);
        assert_eq!(
            runtime.remove_by_id(&key, generated),
            Err(ControlError::UnknownTask)
        );
        // Enqueue it again from the history: same body, a new generated name.
        let again = runtime.enqueue_again(&key, generated).unwrap();
        assert_ne!(again.id, generated);
        assert!(again.name.starts_with("/projects/"));
        runtime.set_paused(&key, false).unwrap();
        let hit = server.wait_for(1, Duration::from_secs(3)).await.remove(0);
        assert_eq!(hit.body, r#"{"data":{"order":1}}"#);
        assert_eq!(
            runtime.enqueue_again(&key, 999),
            Err(EnqueueError::UnknownTask)
        );
        runtime.shutdown().await;
    }

    #[test]
    fn finished_tasks_count_their_bytes() {
        let task = Arc::new(record("t", "http://x", &"y".repeat(1_000)));
        let finished = Finished {
            task,
            outcome: TaskOutcome::Succeeded,
            at: SystemTime::now(),
            attempts: crate::queue::AttemptLog::default(),
            execution_count: 0,
            previous_response: None,
            dispatch_id: None,
        };
        assert!(finished.bytes() > 1_000);
    }
}

// ---------------------------------------------------------------------------
// Read models, the console delta, refusals, the clear and log refs.

mod inspect {
    use std::time::SystemTime;

    use super::*;
    use crate::inspect::{
        TaskClause, TaskQuery, TaskState, TaskTerm, TasksCursor, TasksScope, TasksTotals,
    };
    use crate::queue::{
        Controls, Outcome, RowKey, TaskChange, TaskOrigin, TaskOutcome, TaskQueue, TaskRecord,
    };
    use crate::runtime::{LOG_FAILED, TasksLogLine};

    async fn client_queue(runtime: &TasksRuntime, queue: &str, body: &serde_json::Value) -> String {
        let reply = call(
            &runtime.application(),
            Method::POST,
            &queue_path(queue),
            Some(&OrderedJson::from_value(body)),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        queue_key(PROJECT, "us-central1", queue)
    }

    fn record(name: &str, url: &str, body: &str) -> TaskRecord {
        TaskRecord {
            id: 0,
            name: name.to_owned(),
            url: Some(url.to_owned()),
            headers: vec![("x-caller".to_owned(), "yes".to_owned())],
            body: body.to_owned(),
            schedule_time: None,
            deadline: Duration::from_secs(60),
            enqueued_at: SystemTime::now(),
            origin: TaskOrigin::Wire,
            scheduled: None,
        }
    }

    async fn wait_until(what: &str, timeout: Duration, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + timeout;
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn lines_runtime(origin: &str) -> (TasksRuntime, Arc<Mutex<Vec<TasksLogLine>>>) {
        let lines: Arc<Mutex<Vec<TasksLogLine>>> = Arc::default();
        let sink = Arc::clone(&lines);
        let runtime = TasksRuntime::new(
            PROJECT,
            &inventory(),
            origin,
            LogSink::new(move |line| sink.lock().unwrap().push(line)),
        );
        (runtime, lines)
    }

    #[tokio::test]
    async fn queues_read_as_the_console_shows_them() {
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = queue_key(PROJECT, "us-central1", "taskRetry");
        let list = runtime.queues_view(Some(PROJECT));
        assert_eq!(list.queues.len(), 6);
        assert_eq!(list.projects, [PROJECT]);
        let view = runtime.queue_view(&key).expect("taskRetry");
        assert_eq!(view.parts.location, "us-central1");
        assert_eq!(view.registrations, 1);
        assert_eq!(view.config.max_attempts, 3.0);
        assert_eq!(view.config.max_concurrent_dispatches, 1000);
        let value = |name: &str| {
            view.config
                .values
                .iter()
                .find(|value| value.key == name)
                .cloned()
                .unwrap_or_else(|| panic!("{name}"))
        };
        assert!(value("retryConfig.maxAttempts").provided);
        assert_eq!(value("retryConfig.maxAttempts").value, "3");
        assert!(!value("retryConfig.maxRetrySeconds").provided);
        assert_eq!(value("retryConfig.maxRetrySeconds").value, "null");
        assert!(value("timeoutSeconds").unused && !value("timeoutSeconds").provided);
        assert!(value("retry").unused);
        assert!(value("defaultUri").provided);
        assert_eq!(view.history_capacity, 1000);

        runtime.shutdown().await;
    }

    /// Three tasks of taskRetry while it is paused and holding: two
    /// pending around one held, in that id order.
    fn three_tasks(runtime: &TasksRuntime, key: &str) -> (u64, u64, u64) {
        // Three tasks waiting while paused, one held.
        runtime.set_paused(key, true).unwrap();
        runtime.set_hold_scheduled(key, true).unwrap();
        let first = runtime
            .enqueue(
                key,
                record(
                    &task_name("taskRetry", "a"),
                    "http://127.0.0.1:1/x",
                    r#"{"data":{"order":1}}"#,
                ),
            )
            .unwrap();
        let mut later = record(
            "/generated/tasks/77",
            "http://127.0.0.1:1/x",
            r#"{"data":2}"#,
        );
        later.schedule_time = Some("2999-01-01T00:00:00.000Z".to_owned());
        later.scheduled = crate::queue::parse_schedule_time("2999-01-01T00:00:00.000Z");
        let held = runtime.enqueue(key, later).unwrap();
        let third = runtime
            .enqueue(
                key,
                record(
                    &task_name("taskRetry", "c"),
                    "http://127.0.0.1:1/x",
                    "[1,2]",
                ),
            )
            .unwrap();
        (first, held, third)
    }

    #[tokio::test]
    async fn task_pages_follow_one_order_and_filter() {
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = queue_key(PROJECT, "us-central1", "taskRetry");
        let (first, held, third) = three_tasks(&runtime, &key);
        let page = runtime
            .tasks_page(&key, None, &TaskQuery::default(), None, None, 100)
            .unwrap();
        assert_eq!(page.total, 3);
        let ids: Vec<u64> = page.rows.iter().map(|row| row.id).collect();
        assert_eq!(ids, [first, held, third], "task-id order");
        assert_eq!(page.rows[0].state, TaskState::Pending);
        assert_eq!(page.rows[0].position, Some(1));
        assert_eq!(page.rows[0].max_runs, Some(4), "maxAttempts 3 runs 4 times");
        assert_eq!(page.rows[0].body.text, r#"{"order":1}"#);
        assert!(page.rows[0].body.data_member);
        assert_eq!(page.rows[1].state, TaskState::Held);
        assert!(page.rows[1].generated);
        assert_eq!(page.rows[1].next_attempt_at, page.rows[1].due_at);
        assert_eq!(page.rows[2].position, Some(2));
        assert!(!page.rows[2].body.data_member);
        // Pages by cursor, both ways.
        let one = runtime
            .tasks_page(&key, None, &TaskQuery::default(), None, None, 1)
            .unwrap();
        assert_eq!(one.next, Some(RowKey::waiting(first)));
        let two = runtime
            .tasks_page(&key, None, &TaskQuery::default(), one.next, None, 1)
            .unwrap();
        assert_eq!(two.rows[0].id, held);
        let back = runtime
            .tasks_page(&key, None, &TaskQuery::default(), None, two.previous, 1)
            .unwrap();
        assert_eq!(back.rows[0].id, first);
        // Filters: state, name, flags, words.
        let held_only = runtime
            .tasks_page(
                &key,
                Some(TaskState::Held),
                &TaskQuery::default(),
                None,
                None,
                10,
            )
            .unwrap();
        assert_eq!(held_only.total, 1);
        let query = |terms: Vec<TaskTerm>, negated: bool| TaskQuery {
            clauses: vec![TaskClause {
                any: terms,
                negated,
            }],
        };
        let filtered = |query: &TaskQuery| {
            runtime
                .tasks_page(&key, None, query, None, None, 10)
                .unwrap()
                .rows
                .iter()
                .map(|row| row.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(filtered(&query(vec![TaskTerm::Generated], false)), [held]);
        assert_eq!(
            filtered(&query(vec![TaskTerm::Generated], true)),
            [first, third]
        );
        assert_eq!(
            filtered(&query(
                vec![TaskTerm::Name {
                    value: "c".to_owned(),
                    prefix: false
                }],
                false
            )),
            [third]
        );
        assert_eq!(
            filtered(&query(
                vec![TaskTerm::Name {
                    value: "/generated".to_owned(),
                    prefix: true
                }],
                false
            )),
            [held]
        );
        assert_eq!(
            filtered(&query(vec![TaskTerm::Word("ORDER".to_owned())], false)),
            [first]
        );
        assert_eq!(
            filtered(&query(vec![TaskTerm::Console], false)),
            Vec::<u64>::new()
        );
        // A row read again is held to the same query (a batch read drops
        // one that no longer matches).
        let generated = query(vec![TaskTerm::Generated], false);
        assert!(generated.matches_row(&page.rows[1]));
        assert!(!generated.matches_row(&page.rows[0]));
        assert!(query(vec![TaskTerm::Word("order".to_owned())], false).matches_row(&page.rows[0]));

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn task_details_and_batches() {
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = queue_key(PROJECT, "us-central1", "taskRetry");
        let (first, _, _) = three_tasks(&runtime, &key);
        // The detail: headers the first attempt sends, and the retry plan.
        let detail = runtime.task_view(&key, first).expect("detail");
        assert_eq!(detail.data.as_deref(), Some(r#"{"order":1}"#));
        let header = |name: &str| {
            detail
                .dispatch_headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        };
        assert_eq!(header("X-CloudTasks-TaskName").as_deref(), Some("a"));
        assert_eq!(header("X-CloudTasks-TaskRetryCount").as_deref(), Some("0"));
        assert_eq!(header("x-caller").as_deref(), Some("yes"));
        let plan: Vec<(u32, f64, bool)> = detail
            .retry_plan
            .iter()
            .map(|planned| (planned.attempt, planned.backoff_seconds, planned.last))
            .collect();
        assert_eq!(
            plan,
            [
                (1, 0.0, false),
                (2, 0.2, false),
                (3, 0.4, false),
                (4, 0.8, true)
            ]
        );
        assert_eq!(
            detail.stops,
            "Gives up after attempt 4 (maxAttempts 3 + 1, as the official emulator runs it)."
        );
        // Batch reads: a row while it stays in its phase.
        let batch = runtime.task_rows(&key, &[RowKey::waiting(first), RowKey::slotted(first)]);
        assert!(batch[0].1.is_some() && batch[1].1.is_none());
        assert_eq!(
            runtime.run_now(&key, first),
            Ok(crate::queue::RunNow::Started)
        );
        let batch = runtime.task_rows(&key, &[RowKey::waiting(first), RowKey::slotted(first)]);
        assert!(batch[0].1.is_none());
        assert_eq!(batch[1].1.as_ref().unwrap().state, TaskState::Dispatching);
        let counters = runtime.queue_view(&key).unwrap().counters;
        assert_eq!(
            (counters.pending, counters.held, counters.slots_in_use),
            (1, 1, 1)
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn history_pages_are_newest_first() {
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = client_queue(
            &runtime,
            "paged",
            &json!({"rateLimits": {"maxDispatchesPerSecond": 0}, "defaultUri": "http://127.0.0.1:1/x"}),
        )
        .await;
        for index in 0..5 {
            runtime
                .enqueue(
                    &key,
                    record(&format!("t{index}"), "http://127.0.0.1:1/x", "{}"),
                )
                .unwrap();
        }
        runtime.purge(&key, false).unwrap();
        let page = runtime
            .history_page(&key, None, &TaskQuery::default(), None, None, 2)
            .unwrap();
        assert_eq!(page.total, 5);
        let names: Vec<&str> = page.rows.iter().map(|row| row.name.as_str()).collect();
        assert_eq!(names, ["t4", "t3"]);
        assert_eq!(page.rows[0].outcome, TaskOutcome::Purged);
        let next = runtime
            .history_page(&key, None, &TaskQuery::default(), page.next, None, 2)
            .unwrap();
        assert_eq!(next.rows[0].name, "t2");
        assert_eq!(
            runtime
                .history_page(
                    &key,
                    Some(TaskOutcome::Succeeded),
                    &TaskQuery::default(),
                    None,
                    None,
                    10
                )
                .unwrap()
                .total,
            0
        );
        let sequence = page.rows[0].sequence;
        let rows = runtime.history_rows(&key, &[sequence, 999]);
        let row = rows[0].1.as_ref().unwrap();
        assert_eq!(row.name, "t4");
        assert_eq!(row.origin, TaskOrigin::Wire);
        let name = |value: &str| TaskQuery {
            clauses: vec![TaskClause {
                any: vec![TaskTerm::Name {
                    value: value.to_owned(),
                    prefix: false,
                }],
                negated: false,
            }],
        };
        assert!(name("t4").matches_history(row));
        assert!(!name("t3").matches_history(row));
        assert!(rows[1].1.is_none());
        let detail = runtime
            .task_view(&key, page.rows[0].id)
            .expect("finished detail");
        assert_eq!(detail.row.state, TaskState::Finished);
        assert_eq!(detail.finished.unwrap().outcome, TaskOutcome::Purged);
        assert_eq!(detail.retry_plan.len(), 0);
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn console_delta_reports_changed_queues() {
        let server = TestServer::ok().await;
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = client_queue(&runtime, "watched", &json!({"defaultUri": server.url})).await;
        let mut watch = runtime.watch();
        watch.borrow_and_update();

        let counters = TasksScope {
            project: Some(PROJECT.to_owned()),
            counters: true,
            queue: None,
            max_changed: 200,
        };
        let mut cursor = TasksCursor::default();
        let first = runtime.console_delta(&mut cursor, &counters);
        assert_eq!(first.queues.len(), 7, "every queue, from revision 0");
        assert!(first.queues_changed);
        let nothing = runtime.console_delta(&mut cursor, &counters);
        assert!(nothing.is_empty(), "{nothing:?}");

        // Pausing a queue changes the list and its figures.
        runtime.set_paused(&key, true).unwrap();
        assert!(watch.has_changed().unwrap());
        let paused = runtime.console_delta(&mut cursor, &counters);
        assert!(paused.queues_changed);
        assert_eq!(paused.queues.len(), 1);
        assert_eq!(paused.queues[0].key, key);

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn console_delta_follows_a_queue_and_its_finished_tasks() {
        let server = TestServer::ok().await;
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = client_queue(&runtime, "watched", &json!({"defaultUri": server.url})).await;
        let other = client_queue(&runtime, "other", &json!({"defaultUri": server.url})).await;
        runtime.set_paused(&key, true).unwrap();
        let counters = TasksScope {
            project: Some(PROJECT.to_owned()),
            counters: true,
            queue: None,
            max_changed: 200,
        };
        let mut cursor = TasksCursor::at(runtime.queues_view(None).revision);
        // The scoped queue's rows: the first call starts the cursor.
        let scoped = TasksScope {
            project: Some(PROJECT.to_owned()),
            counters: false,
            queue: Some(key.clone()),
            max_changed: 200,
        };
        let mut rows = TasksCursor::default();
        assert!(runtime.console_delta(&mut rows, &scoped).is_empty());
        let a = runtime
            .enqueue(&key, record("a", &server.url, "{}"))
            .unwrap();
        let b = runtime
            .enqueue(&key, record("b", &server.url, "{}"))
            .unwrap();
        runtime
            .enqueue(&other, record("o", &server.url, "{}"))
            .unwrap();
        let delta = runtime.console_delta(&mut rows, &scoped);
        assert_eq!(
            delta.changes,
            [
                TaskChange::Row(RowKey::waiting(a)),
                TaskChange::Row(RowKey::waiting(b))
            ],
            "the other queue's task is not here"
        );
        let counted = runtime.console_delta(&mut cursor, &counters);
        assert_eq!(counted.queues.len(), 2);
        let watched = counted
            .queues
            .iter()
            .find(|queue| queue.key == key)
            .unwrap();
        assert_eq!(watched.pending, 2);
        // A task that takes a slot: its old and new keys.
        runtime.run_now(&key, a).unwrap();
        let delta = runtime.console_delta(&mut rows, &scoped);
        assert!(delta.changes.contains(&TaskChange::Row(RowKey::waiting(a))));
        assert!(delta.changes.contains(&TaskChange::Row(RowKey::slotted(a))));
        wait_until("a to finish", Duration::from_secs(5), || {
            runtime
                .history_page(&key, None, &TaskQuery::default(), None, None, 10)
                .unwrap()
                .total
                == 1
        })
        .await;
        let delta = runtime.console_delta(&mut rows, &scoped);
        let finished = delta.finished.expect("a finished");
        assert_eq!(finished.added, 1);
        assert_eq!(finished.ids.len(), 1);
        assert!(delta.changes.contains(&TaskChange::Row(RowKey::slotted(a))));
        // The finished task keeps its one attempt: the 204 it answered.
        let detail = runtime.task_view(&key, a).expect("a's detail");
        let attempt = detail.attempts.last().cloned().expect("an attempt");
        assert_eq!(
            (attempt.task_id, attempt.attempt, attempt.status),
            (a, 1, Some(204))
        );
        // Past the ring of 1,000 changed rows: start over.
        for index in 0..600 {
            runtime
                .enqueue(&key, record(&format!("bulk{index}"), &server.url, "{}"))
                .unwrap();
        }
        runtime.purge(&key, false).unwrap();
        let delta = runtime.console_delta(&mut rows, &scoped);
        assert!(delta.changes_reset);
        assert_eq!(delta.changes.len(), 0);
        let _ = b;
        runtime.shutdown().await;
    }

    #[test]
    fn retry_plan_matches_the_dispatcher() {
        let configs = [
            json!({}),
            json!({"retryConfig": {"maxAttempts": 3, "maxBackoffSeconds": 1, "maxDoublings": 2, "minBackoffSeconds": 0.2}}),
            json!({"retryConfig": {"maxAttempts": 0}}),
            json!({"retryConfig": {"maxAttempts": 4, "maxDoublings": 0, "minBackoffSeconds": 1}}),
            json!({"retryConfig": {"maxAttempts": 1, "maxRetrySeconds": 2, "minBackoffSeconds": 0.5, "maxBackoffSeconds": 1}}),
            json!({"retryConfig": {"maxAttempts": 5, "maxBackoffSeconds": 1, "minBackoffSeconds": 0.3}}),
        ];
        for body in configs {
            let mut body = body;
            body["defaultUri"] = json!("http://x");
            let config = QueueConfig::from_body(&OrderedJson::from_value(&body)).unwrap();
            let plan = crate::queue::retry_plan(&config, 1, Duration::ZERO, Duration::ZERO);
            // The dispatcher itself, failing every attempt, with requests
            // that take no time.
            let start = Instant::now();
            let mut queue = TaskQueue::new("queue:p-l-q".to_owned(), config.clone(), start);
            let mut task = record("t", "http://x", "{}");
            task.id = 1;
            queue.enqueue(task, start, Controls::default()).unwrap();
            queue.set_tokens(1.0);
            let mut next = 0;
            queue.dispatch_tasks(start, &mut next, Controls::default());
            let mut at = start;
            let mut observed = Vec::new();
            let mut finished = Vec::new();
            let mut backoff = 0.0;
            loop {
                let runs = queue.process(at, 0, &mut finished);
                if !finished.is_empty() {
                    break;
                }
                let Some(run) = runs.first() else {
                    // Waiting out a backoff: jump to when it ends.
                    let dispatch = queue.dispatches().remove(0);
                    backoff = dispatch.backoff_seconds;
                    at = dispatch.last_run.unwrap() + Duration::from_secs_f64(backoff);
                    continue;
                };
                observed.push((run.attempt, backoff));
                let attempt = crate::queue::AttemptRecord {
                    queue_key: run.queue_key.clone(),
                    task_id: 1,
                    task_name: "t".to_owned(),
                    attempt: run.attempt,
                    started_at: SystemTime::now(),
                    duration: Duration::ZERO,
                    status: Some(500),
                    error: None,
                    response: None,
                    counted_execution: false,
                    retry_count: run.attempt - 1,
                };
                assert!(queue.complete(run.dispatch_id, Outcome::Status(500), attempt, at));
                queue.process(at, 0, &mut finished);
            }
            let planned: Vec<(u32, f64)> = plan
                .iter()
                .map(|planned| (planned.attempt, planned.backoff_seconds))
                .collect();
            assert_eq!(planned, observed, "{body}");
            assert!(plan.last().unwrap().last, "{body}");
            assert_eq!(plan.iter().filter(|planned| planned.last).count(), 1);
            assert_eq!(finished[0].outcome, TaskOutcome::Failed);
        }
    }

    #[tokio::test]
    async fn the_retry_ladder_is_the_dispatchers() {
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        // processOrder's options in the messaging fixture.
        let key = client_queue(
            &runtime,
            "ladder",
            &json!({
                "retryConfig": {"maxAttempts": 3, "minBackoffSeconds": 1, "maxBackoffSeconds": 4},
                "rateLimits": {"maxConcurrentDispatches": 2, "maxDispatchesPerSecond": 10},
                "defaultUri": "http://127.0.0.1:1/x"
            }),
        )
        .await;
        let ladder = runtime.queue_view(&key).unwrap().config.ladder;
        let steps: Vec<(u32, f64, f64, bool)> = ladder
            .iter()
            .map(|step| {
                (
                    step.attempt,
                    step.backoff_seconds,
                    step.after_seconds,
                    step.last,
                )
            })
            .collect();
        assert_eq!(
            steps,
            [
                (1, 0.0, 0.0, false),
                (2, 1.0, 1.0, false),
                (3, 2.0, 3.0, false),
                (4, 4.0, 7.0, true),
            ],
            "maxAttempts 3 runs four times, the backoff doubling up to 4 s"
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn clear_removes_tasks_history_and_names() {
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = client_queue(
            &runtime,
            "cleared",
            &json!({"rateLimits": {"maxDispatchesPerSecond": 0}, "retryConfig": {"maxAttempts": 7}, "defaultUri": "http://127.0.0.1:1/x"}),
        )
        .await;
        runtime.set_paused(&key, true).unwrap();
        runtime.set_hold_scheduled(&key, true).unwrap();
        let name = task_name("cleared", "order-1");
        runtime
            .enqueue(&key, record(&name, "http://127.0.0.1:1/x", "{}"))
            .unwrap();
        runtime
            .enqueue(&key, record("t2", "http://127.0.0.1:1/x", "{}"))
            .unwrap();
        runtime.purge(&key, false).unwrap();
        runtime
            .enqueue(&key, record("t3", "http://127.0.0.1:1/x", "{}"))
            .unwrap();
        let mut held = record("t4", "http://127.0.0.1:1/x", "{}");
        held.scheduled = Some(SystemTime::now() + Duration::from_secs(60));
        runtime.enqueue(&key, held).unwrap();
        let removed = runtime.reset();
        assert_eq!(removed.tasks, 2);
        assert_eq!(removed.history, 2);
        assert_eq!(removed.names, 4);
        let view = runtime.queue_view(&key).unwrap();
        assert_eq!((view.counters.pending, view.counters.held), (0, 0));
        assert_eq!(view.counters.history, 0);
        assert_eq!(
            view.counters.outcomes,
            crate::inspect::OutcomeCounts::default()
        );
        assert!(view.paused && view.hold_scheduled, "controls stay");
        assert_eq!(view.config.max_attempts, 7.0, "configuration stays");
        // The name can be used again.
        runtime
            .enqueue(&key, record(&name, "http://127.0.0.1:1/x", "{}"))
            .unwrap();
        let reply = call(&runtime.application(), Method::GET, "/queueStats", None).await;
        assert_eq!(stats_of(&reply, &key)["numberOfTasks"], json!(1));
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn refused_requests_name_where_the_queue_is() {
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let app = runtime.application();
        let elsewhere = format!("/projects/{PROJECT}/locations/us-east1/queues/taskDefault/tasks");
        for _ in 0..2 {
            let reply = call(
                &app,
                Method::POST,
                &elsewhere,
                Some(&task(&json!({}), None, &[])),
            )
            .await;
            assert_eq!(reply.status, StatusCode::NOT_FOUND);
        }
        let other_project = "/projects/demo-other/locations/us-central1/queues/taskDefault/tasks";
        let reply = call(
            &app,
            Method::POST,
            other_project,
            Some(&task(&json!({}), None, &[])),
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        let key = queue_key(PROJECT, "us-central1", "taskDefault");
        runtime.set_paused(&key, true).unwrap();
        let named = task(&json!({}), Some(&task_name("taskDefault", "dup")), &[]);
        let reply = call(&app, Method::POST, &tasks_path("taskDefault"), Some(&named)).await;
        assert_eq!(reply.status, StatusCode::OK);
        for _ in 0..2 {
            let reply = call(&app, Method::POST, &tasks_path("taskDefault"), Some(&named)).await;
            assert_eq!(reply.status, StatusCode::CONFLICT);
            assert_eq!(
                reply.body, "A task with the same name already exists",
                "the wire is unchanged"
            );
        }
        let reply = call(
            &app,
            Method::DELETE,
            &format!("{}/nothing", tasks_path("taskDefault")),
            None,
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);

        let all = runtime.queues_view(None).refused;
        let east = all
            .iter()
            .find(|entry| entry.refused.queue.location == "us-east1")
            .expect("the us-east1 enqueue");
        assert_eq!(east.refused.count, 2);
        assert_eq!(east.refused.status, 404);
        assert_eq!(east.refused.operation, "enqueue");
        assert_eq!(
            east.suggestion.as_deref(),
            Some("taskDefault is registered in us-central1")
        );
        let project = all
            .iter()
            .find(|entry| entry.refused.queue.project == "demo-other")
            .expect("the other project's enqueue");
        assert_eq!(
            project.suggestion.as_deref(),
            Some(format!("taskDefault is registered in project {PROJECT}, us-central1").as_str())
        );
        let duplicate = all
            .iter()
            .find(|entry| entry.refused.status == 409)
            .expect("the reused name");
        assert_eq!(duplicate.refused.count, 2);
        assert_eq!(
            duplicate.refused.error,
            "A task with this name was enqueued before in this run."
        );
        assert!(all.iter().any(|entry| entry.refused.operation == "delete"));
        // A project's list keeps its own refusals.
        assert!(
            runtime
                .queues_view(Some("demo-other"))
                .refused
                .iter()
                .all(|entry| entry.refused.queue.project == "demo-other")
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn log_lines_carry_queue_and_task_refs() {
        let (runtime, lines) = lines_runtime("http://127.0.0.1:5001");
        let key = client_queue(
            &runtime,
            "logged",
            &json!({"retryConfig": {"maxAttempts": 0}, "defaultUri": "http://127.0.0.1:1/x"}),
        )
        .await;
        let id = runtime
            .enqueue(
                &key,
                record(&task_name("logged", "card-1"), "http://127.0.0.1:1/x", "{}"),
            )
            .unwrap();
        wait_until("the failure line", Duration::from_secs(10), || {
            lines
                .lock()
                .unwrap()
                .iter()
                .any(|line| line.kind == LOG_FAILED)
        })
        .await;
        let lines = lines.lock().unwrap().clone();
        assert!(lines.iter().all(|line| line.queue.is_some()), "{lines:?}");
        let failed = lines.iter().find(|line| line.kind == LOG_FAILED).unwrap();
        assert_eq!(failed.task, Some((id, task_name("logged", "card-1"))));
        assert_eq!(failed.queue.as_ref().unwrap().queue, "logged");
        assert_eq!(
            failed.text,
            "Task card-1 in logged ran out of retries after 1 attempt; its last attempt failed: FetchError: request to http://127.0.0.1:1/x failed, reason: connect ECONNREFUSED 127.0.0.1:1"
        );
        let fetch = lines
            .iter()
            .find(|line| line.text.starts_with("FetchError"))
            .expect("the fetch error line");
        assert_eq!(fetch.task.as_ref().map(|task| task.0), Some(id));
        // A name as Cloud Tasks sends it resolves to the console's id.
        assert_eq!(runtime.task_id(&key, "card-1"), Some(id.to_string()));
        assert_eq!(
            runtime.task_id(&key, &task_name("logged", "card-1")),
            Some(id.to_string())
        );
        assert_eq!(runtime.task_id(&key, "nope"), None);
        assert_eq!(
            runtime.find_tasks("card-1", 5),
            [(key.clone(), id, task_name("logged", "card-1"))]
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn a_replaced_log_sink_takes_every_later_line_and_failures_are_totalled() {
        let (runtime, first) = lines_runtime("http://127.0.0.1:5001");
        let before = first.lock().unwrap().len();
        let second: Arc<Mutex<Vec<TasksLogLine>>> = Arc::default();
        let sink = Arc::clone(&second);
        runtime.set_log_sink(LogSink::new(move |line| sink.lock().unwrap().push(line)));
        let queues = runtime.totals().queues;
        let key = client_queue(
            &runtime,
            "totalled",
            &json!({"retryConfig": {"maxAttempts": 0}, "defaultUri": "http://127.0.0.1:1/x"}),
        )
        .await;
        runtime
            .enqueue(
                &key,
                record(&task_name("totalled", "t-1"), "http://127.0.0.1:1/x", "{}"),
            )
            .unwrap();
        wait_until("the failure line", Duration::from_secs(10), || {
            second
                .lock()
                .unwrap()
                .iter()
                .any(|line| line.kind == LOG_FAILED)
        })
        .await;
        assert_eq!(
            first.lock().unwrap().len(),
            before,
            "the old sink hears nothing"
        );
        assert_eq!(runtime.failed_total(), 1);
        assert_eq!(
            runtime.totals(),
            TasksTotals {
                queues: queues + 1,
                pending: 0,
                failed_recently: 1,
                failed_total: 1,
            }
        );
        // A clear empties the queues and keeps the running total.
        let _ = runtime.reset();
        assert_eq!(runtime.failed_total(), 1);
        runtime.shutdown().await;
    }

    #[tokio::test]
    #[ignore = "timing; run with --ignored perf_ in release on the acceptance host"]
    async fn perf_task_page_at_ten_thousand() {
        let (runtime, _) = runtime("http://127.0.0.1:5001");
        let key = client_queue(
            &runtime,
            "big",
            &json!({"rateLimits": {"maxDispatchesPerSecond": 0}, "defaultUri": "http://127.0.0.1:1/x"}),
        )
        .await;
        for index in 0..10_000 {
            runtime
                .enqueue(
                    &key,
                    record(
                        &format!("t{index}"),
                        "http://127.0.0.1:1/x",
                        r#"{"data":{"n":1}}"#,
                    ),
                )
                .unwrap();
        }
        let started = Instant::now();
        let page = runtime
            .tasks_page(
                &key,
                None,
                &TaskQuery::default(),
                Some(RowKey::waiting(5_000)),
                None,
                100,
            )
            .unwrap();
        let took = started.elapsed();
        assert_eq!(page.total, 10_000);
        assert_eq!(page.rows.len(), 100);
        assert!(took < Duration::from_millis(30), "{took:?}");
        runtime.shutdown().await;
    }
}
