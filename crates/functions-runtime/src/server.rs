//! The Functions port: `/backends`, the trigger and multicast routes, the
//! `/{project}/{region}/{name}` HTTP routes, and the Eventarc emulator
//! routes. Responses reproduce the official hub's statuses, bodies and headers.
use std::collections::BTreeMap;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use base64::Engine as _;
use futures_util::{Stream, StreamExt as _, TryStreamExt as _};
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use crate::log::{LogEvent, LogSink};
use crate::manifest::Signature;
use crate::monitor::cause::{self, CauseInput};
use crate::monitor::{
    DeliveryPlan, EventReceived, EventarcFilterMismatch, EventarcOrigin, FunctionKind,
    InvocationEnd, InvocationOrigin, InvocationOutcome, InvocationStart, InvocationSummary,
    InvocationTarget, InvocationToken, Monitor, RecordedEvent,
};
use crate::registry::EventarcSubscription;
use crate::{RuntimeState, WORKER_READY_TIMEOUT};

type Shared = Arc<RuntimeState>;

const EXPRESS: &str = "Express";
const CONTROL_TARGET: &str = "x-firenook-target";
const CONTROL_SIGNATURE: &str = "x-firenook-signature";
const CONTROL_SERVICE: &str = "x-firenook-service";
/// The invocation id, to the worker and (when asked) in the answer.
pub(crate) const EXECUTION_HEADER: &str = "x-firenook-execution";
/// The function id, to the worker.
const FUNCTION_HEADER: &str = "x-firenook-function";
/// Every request the console makes carries it.
pub(crate) const CONSOLE_HEADER: &str = "x-firenook-console";
/// Every header with this prefix is the engine's: stripped before user code.
const CONTROL_PREFIX: &str = "x-firenook-";
/// Set by the worker on a background invocation whose handler threw.
const HANDLER_ERROR_HEADER: &str = "x-firenook-handler-error";
const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

pub(crate) fn router(state: Shared) -> Router {
    Router::new()
        // Express answers other methods on these routes with its plain 404
        // and no `Allow` header, so the method check lives in the handlers.
        .route("/backends", any(backends_any))
        .route(
            "/functions/projects/{project}/triggers/{*key}",
            any(trigger_any),
        )
        .route(
            "/functions/projects/{project}/trigger_multicast",
            any(multicast_any),
        )
        .route("/{project}/{region}/{name}", any(https_route))
        .route("/{project}/{region}/{name}/", any(https_route))
        .route("/{project}/{region}/{name}/{*rest}", any(https_route))
        .fallback(not_found)
        .with_state(state)
}

pub(crate) fn eventarc_router(state: Shared) -> Router {
    Router::new()
        .route(
            "/emulator/v1/projects/{project}/triggers/{*key}",
            post(eventarc_register),
        )
        .route(
            "/emulator/v1/remove/projects/{project}/triggers/{*key}",
            post(eventarc_remove),
        )
        .route("/google/getTriggers", get(eventarc_list))
        .route("/google/publishEvents", post(eventarc_publish_native))
        .route(
            "/projects/{project}/locations/{location}/channels/{channel}",
            post(eventarc_publish_channel),
        )
        .fallback(eventarc_not_found)
        .with_state(state)
}

fn express_text(status: StatusCode, content_type: &'static str, body: impl Into<Body>) -> Response {
    let mut response = Response::new(body.into());
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
        .headers_mut()
        .insert("x-powered-by", HeaderValue::from_static(EXPRESS));
    response
}

/// `res.sendStatus(404)`.
async fn not_found() -> Response {
    express_text(
        StatusCode::NOT_FOUND,
        "text/plain; charset=utf-8",
        "Not Found",
    )
}

async fn backends_any(state: State<Shared>, headers: HeaderMap, request: Request) -> Response {
    match *request.method() {
        Method::GET | Method::HEAD => list_backends(state, headers).await,
        _ => not_found().await,
    }
}

async fn trigger_any(
    state: State<Shared>,
    path: Path<(String, String)>,
    request: Request,
) -> Response {
    if request.method() == Method::POST {
        trigger_route(state, path, request).await
    } else {
        not_found().await
    }
}

async fn multicast_any(state: State<Shared>, path: Path<String>, request: Request) -> Response {
    if request.method() == Method::POST {
        multicast_route(state, path, request).await
    } else {
        not_found().await
    }
}

/// `GET /backends` with `cors({ origin: true })`.
async fn list_backends(State(state): State<Shared>, headers: HeaderMap) -> Response {
    let body = state.backends_json().await;
    let mut response = express_text(
        StatusCode::OK,
        "application/json; charset=utf-8",
        body.to_string(),
    );
    if let Some(origin) = headers.get(header::ORIGIN).cloned() {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Origin"));
    response
}

fn unknown_function(state: &RuntimeState, keys: &[&str], trigger_id: &str) -> Response {
    let _ = state;
    express_text(
        StatusCode::NOT_FOUND,
        "text/html; charset=utf-8",
        format!(
            "Function {trigger_id} does not exist, valid functions are: {}",
            keys.join(", ")
        ),
    )
}

async fn https_route(
    State(state): State<Shared>,
    Path(params): Path<Vec<(String, String)>>,
    request: Request,
) -> Response {
    let mut project = String::new();
    let mut region = String::new();
    let mut name = String::new();
    for (key, value) in params {
        match key.as_str() {
            "project" => project = value,
            "region" => region = value,
            "name" => name = value,
            _ => {}
        }
    }
    if project != state.config.project_id {
        return not_found().await;
    }
    let trigger_id = format!("{region}-{name}");
    let original = request.uri().clone();
    let rewritten = rewrite_path(&original, &state.config.project_id, &name);
    let origin = if request.headers().contains_key(CONSOLE_HEADER) {
        InvocationOrigin::Console
    } else {
        InvocationOrigin::Client
    };
    let context = DispatchContext {
        origin,
        target: InvocationTarget::Url,
        ..DispatchContext::default()
    };
    dispatch(state, &trigger_id, request, rewritten, context).await
}

/// `path.replace(new RegExp("/{project}/[^/]*/{name}/?"), "/")`, keeping the query.
pub(crate) fn rewrite_path(uri: &Uri, project: &str, name: &str) -> String {
    let path = uri.path();
    let mut rewritten = path.to_owned();
    if let Some(after_project) = path.strip_prefix(&format!("/{project}/"))
        && let Some(slash) = after_project.find('/')
        && let Some(rest) = after_project[slash + 1..].strip_prefix(name)
    {
        let rest = rest.strip_prefix('/').unwrap_or(rest);
        rewritten = format!("/{rest}");
    }
    match uri.query() {
        Some(query) => format!("{rewritten}?{query}"),
        None => rewritten,
    }
}

async fn trigger_route(
    State(state): State<Shared>,
    Path((_project, key)): Path<(String, String)>,
    request: Request,
) -> Response {
    let path = match request.uri().query() {
        Some(query) => format!("/?{query}"),
        None => "/".to_owned(),
    };
    dispatch(state, &key, request, path, DispatchContext::default()).await
}

/// Who caused a dispatch, for the monitor's record of it.
pub(crate) struct DispatchContext {
    pub(crate) origin: InvocationOrigin,
    pub(crate) target: InvocationTarget,
    /// The invocation this dispatch replays.
    pub(crate) replay_of: Option<String>,
    /// The Eventarc event and the delivery slot this dispatch fulfils.
    pub(crate) delivery: Option<(u64, usize)>,
    /// Told the invocation's summary as soon as it is recorded.
    pub(crate) started: Option<oneshot::Sender<InvocationSummary>>,
}

impl Default for DispatchContext {
    fn default() -> Self {
        Self {
            origin: InvocationOrigin::Emulator,
            target: InvocationTarget::Trigger,
            replay_of: None,
            delivery: None,
            started: None,
        }
    }
}

/// What a disabled record answers: an empty 204 (Express drops the body and
/// content type of a 204).
fn disabled_answer() -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    response
        .headers_mut()
        .insert("x-powered-by", HeaderValue::from_static(EXPRESS));
    response
}

/// `handleHttpsTrigger`: looks the record up and proxies to the codebase's
/// worker, recording the invocation from its request to its end.
#[allow(clippy::too_many_lines)]
pub(crate) async fn dispatch(
    state: Shared,
    trigger_id: &str,
    request: Request,
    path: String,
    context: DispatchContext,
) -> Response {
    let (backend_id, definition, enabled, removed_by_reload) = {
        let registry = state.registry.read().await;
        let Some(record) = registry.get(trigger_id) else {
            let keys = registry.keys();
            return unknown_function(&state, &keys, trigger_id);
        };
        if registry.superseded(trigger_id) {
            // The same delivery reaches the record that replaced this one,
            // which records it; this one answers as a disabled record does.
            return disabled_answer();
        }
        (
            record.codebase.clone(),
            record.definition.clone(),
            record.enabled,
            record.stale,
        )
    };
    let Some(backend) = state
        .backends
        .iter()
        .find(|backend| backend.id == backend_id)
        .cloned()
    else {
        return express_text(
            StatusCode::INTERNAL_SERVER_ERROR,
            "text/plain; charset=utf-8",
            "Internal Error: backend not found",
        );
    };
    let (parts, body) = request.into_parts();
    let mut body_bytes = match axum::body::to_bytes(body, usize::MAX).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return express_text(
                StatusCode::BAD_REQUEST,
                "text/plain; charset=utf-8",
                format!("invalid request body: {error}"),
            );
        }
    };
    let monitor = &state.monitor;
    let kind = FunctionKind::of(&definition);
    let function_id = definition.id();
    let answer_id = parts.headers.contains_key(CONSOLE_HEADER)
        || parts
            .headers
            .keys()
            .any(|name| name.as_str().starts_with(cause::headers::CAUSE_PREFIX));
    let mut origin = context.origin;
    if matches!(origin, InvocationOrigin::Client | InvocationOrigin::Console)
        && (parts.headers.contains_key(cause::headers::TASK_QUEUE)
            || parts.headers.contains_key(cause::headers::AUTH_CALL))
    {
        // An emulator service made the call: Cloud Tasks, or Auth's
        // blocking call.
        origin = InvocationOrigin::Emulator;
    }
    let (invocation_cause, summary_line) = cause::classify(&CauseInput {
        definition: &definition,
        kind,
        project: &state.config.project_id,
        method: parts.method.as_str(),
        path: &path,
        headers: &parts.headers,
        body: &body_bytes,
    });
    let token = monitor.begin(InvocationStart {
        function_id: function_id.clone(),
        codebase: backend_id.clone(),
        kind,
        origin,
        cause: invocation_cause,
        summary: summary_line,
        target: context.target,
        method: parts.method.to_string(),
        path: path.clone(),
        headers: parts.headers.clone(),
        body: body_bytes.clone(),
        replay_of: context.replay_of,
        delivery: context.delivery,
    });
    if let Some(started) = context.started
        && let Some(summary) = monitor.summary(token.seq)
    {
        let _ = started.send(summary);
    }
    let respond = |mut response: Response| {
        if answer_id && let Ok(value) = HeaderValue::from_str(&token.id) {
            response.headers_mut().insert(EXECUTION_HEADER, value);
        }
        // In-process callers (the console's dispatch) read the invocation
        // from the response.
        response.extensions_mut().insert(token.clone());
        response
    };
    let attributed = |event: LogEvent| {
        event
            .with_function(function_id.clone())
            .with_execution(token.id.to_string())
            .with_codebase(backend_id.clone())
    };
    if removed_by_reload {
        // The official worker no longer exports the function and dies on the
        // call; the proxy reports the dropped connection.
        state.log.record(
            attributed(LogEvent::new(
                "ERROR",
                &format!("functions[{trigger_id}]"),
                "the source no longer exports this function (record kept from an earlier load)"
                    .to_owned(),
            ))
            .with_kind("function.unknown"),
        );
        monitor.finish(
            &token,
            InvocationEnd {
                outcome: Some(InvocationOutcome::Removed),
                error: Some(
                    "The loaded code no longer exports this function; a reload removed it."
                        .to_owned(),
                ),
                client_gone: false,
            },
        );
        return respond(proxy_failure());
    }
    if !enabled {
        monitor.finish(
            &token,
            InvocationEnd {
                outcome: Some(InvocationOutcome::Paused),
                ..InvocationEnd::default()
            },
        );
        return respond(disabled_answer());
    }
    let signature = definition.signature();
    let mut headers = parts.headers.clone();
    if signature == Signature::CloudEvent
        && headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("application/protobuf"))
    {
        // The Firestore emulator base64-encodes binary CloudEvent payloads;
        // the worker receives the decoded bytes like the official hub sends.
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(body_bytes.as_ref())
            .unwrap_or_else(|_| body_bytes.to_vec());
        body_bytes = Bytes::from(decoded);
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from(body_bytes.len()));
    }
    let origin = match backend.slot.origin_timed(WORKER_READY_TIMEOUT).await {
        Ok((origin, spawned)) => {
            if let Some(took) = spawned {
                monitor.started_worker(&token, took);
            }
            origin
        }
        Err(error) => {
            let failure = format!(
                "Failed to start functions in {}: {error}",
                backend.directory().display()
            );
            state.log.record(attributed(LogEvent::new(
                "ERROR",
                &backend.label(),
                format!("Failed to handle request for function {function_id}"),
            )));
            state.log.record(
                attributed(LogEvent::new("ERROR", &backend.label(), failure.clone()))
                    .with_kind("worker.failed")
                    .with_detail(json!({ "error": error.0 })),
            );
            monitor.finish(
                &token,
                InvocationEnd {
                    outcome: Some(InvocationOutcome::NotStarted),
                    error: Some(failure.clone()),
                    client_gone: false,
                },
            );
            return respond(express_text(
                StatusCode::INTERNAL_SERVER_ERROR,
                "text/plain; charset=utf-8",
                failure,
            ));
        }
    };
    let label = format!("functions[{function_id}]");
    let start_detail = if matches!(kind, FunctionKind::Http | FunctionKind::Callable) {
        json!({ "method": parts.method.as_str(), "path": path })
    } else {
        let cause = monitor
            .summary(token.seq)
            .and_then(|summary| serde_json::to_value(summary.cause).ok())
            .unwrap_or(Value::Null);
        json!({ "cause": cause })
    };
    state.log.record(
        attributed(LogEvent::new(
            "INFO",
            "functions",
            format!("Beginning execution of \"{function_id}\""),
        ))
        .with_kind("function.start")
        .with_detail(start_detail),
    );
    let started = Instant::now();
    let mut end = EndLine {
        log: state.log.clone(),
        monitor: monitor.clone(),
        token: token.clone(),
        function_id: function_id.clone(),
        codebase: backend_id.clone(),
        started,
        written: false,
    };
    let timeout = if state.debug_mode {
        None
    } else {
        Some(Duration::from_secs(definition.timeout_seconds()))
    };
    let mut builder = state
        .client
        .request(parts.method.clone(), format!("{origin}{path}"));
    for (name, value) in &headers {
        let lowered = name.as_str().to_ascii_lowercase();
        if HOP_BY_HOP.contains(&lowered.as_str()) || lowered.starts_with(CONTROL_PREFIX) {
            continue;
        }
        builder = builder.header(name, value);
    }
    builder = builder
        .header(CONTROL_TARGET, definition.entry_point())
        .header(CONTROL_SIGNATURE, signature.as_str())
        .header(CONTROL_SERVICE, definition.name())
        .header(EXECUTION_HEADER, &*token.id)
        .header(FUNCTION_HEADER, &function_id)
        .body(body_bytes);
    let sent = match timeout {
        Some(limit) => {
            if let Ok(result) = tokio::time::timeout(limit, builder.send()).await {
                result
            } else {
                state.log.record(
                    attributed(LogEvent::new(
                        "ERROR",
                        &label,
                        format!(
                            "Your function timed out after ~{}s. To configure this timeout, see\n      https://firebase.google.com/docs/functions/manage-functions#set_timeout_and_memory_allocation.",
                            definition.timeout_seconds()
                        ),
                    ))
                    .with_kind("function.timeout")
                    .with_detail(json!({
                        "timeoutSeconds": definition.timeout_seconds(),
                        "durationMs": started.elapsed().as_secs_f64() * 1000.0,
                        "outcome": "timedOut",
                    })),
                );
                end.written = true;
                monitor.finish(
                    &token,
                    InvocationEnd {
                        outcome: Some(InvocationOutcome::TimedOut),
                        error: Some(format!("Timed out after {}s", definition.timeout_seconds())),
                        client_gone: false,
                    },
                );
                return respond(proxy_failure());
            }
        }
        None => builder.send().await,
    };
    let upstream = match sent {
        Ok(upstream) => upstream,
        Err(error) => {
            state.log.record(
                attributed(LogEvent::new(
                    "ERROR",
                    &label,
                    format!("Request to function failed: {error}"),
                ))
                .with_kind("function.crashed")
                .with_detail(json!({ "error": error.to_string(), "outcome": "crashed" })),
            );
            end.written = true;
            monitor.finish(
                &token,
                InvocationEnd {
                    outcome: Some(InvocationOutcome::Crashed),
                    error: Some(format!("Request to function failed: {error}")),
                    client_gone: false,
                },
            );
            return respond(proxy_failure());
        }
    };
    let status = upstream.status();
    monitor.response_head(&token, status.as_u16(), upstream.headers());
    if upstream.headers().contains_key(HANDLER_ERROR_HEADER) {
        // A background handler that threw kills the official worker, and the
        // proxy reports the dropped connection; Firenook keeps its worker but
        // answers the same way (a handled failure, not retried).
        monitor.finish(
            &token,
            InvocationEnd {
                outcome: Some(InvocationOutcome::Failed),
                ..InvocationEnd::default()
            },
        );
        end.handled_failure();
        let mut response = proxy_failure();
        response.headers_mut().insert(
            firenook_functions_bridge::DELIVERY_HEADER,
            HeaderValue::from_static(firenook_functions_bridge::DELIVERY_HANDLED),
        );
        return respond(response);
    }
    let background = matches!(signature, Signature::Event | Signature::CloudEvent);
    if background {
        // The worker answers a background invocation only after its handler
        // settled: the head is the end, whether or not anyone reads the
        // acknowledgement.
        monitor.finish(&token, InvocationEnd::default());
    }
    let mut response = Response::builder().status(status);
    if let Some(response_headers) = response.headers_mut() {
        for (name, value) in upstream.headers() {
            let lowered = name.as_str().to_ascii_lowercase();
            if HOP_BY_HOP.contains(&lowered.as_str()) {
                continue;
            }
            response_headers.append(name.clone(), value.clone());
        }
        // Tells the bridge the handler ran, so a failure is not retried.
        response_headers.insert(
            firenook_functions_bridge::DELIVERY_HEADER,
            HeaderValue::from_static(firenook_functions_bridge::DELIVERY_HANDLED),
        );
    }
    let stream: ByteStream = Box::pin(
        upstream
            .bytes_stream()
            .map_err(std::io::Error::other)
            .into_stream(),
    );
    let body = RecordedBody {
        upstream: Some(stream),
        background,
        polled: false,
        done: false,
        monitor: monitor.clone(),
        token: token.clone(),
        end: Some(end),
        limit: timeout.map(|limit| limit.saturating_sub(started.elapsed())),
    };
    match response.body(Body::from_stream(body)) {
        Ok(response) => respond(response),
        Err(error) => express_text(
            StatusCode::INTERNAL_SERVER_ERROR,
            "text/plain; charset=utf-8",
            error.to_string(),
        ),
    }
}

type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>;

/// Writes exactly one end line per invocation, on every path. A path with
/// a counterpart in today's output writes today's text; one without (a
/// handled background failure, a body nobody read) is console-only, so
/// the terminal and the official records do not change. Dropped unwritten,
/// it writes a console-only line.
struct EndLine {
    log: LogSink,
    monitor: Monitor,
    token: InvocationToken,
    function_id: String,
    codebase: String,
    started: Instant,
    written: bool,
}

impl EndLine {
    fn attributed(&self, event: LogEvent) -> LogEvent {
        event
            .with_function(self.function_id.clone())
            .with_execution(self.token.id.to_string())
            .with_codebase(self.codebase.clone())
    }

    /// The `Finished "<id>" in Nms` line.
    fn finished(&mut self, console_only: bool, client_gone: bool) {
        if self.written {
            return;
        }
        self.written = true;
        let elapsed = self.started.elapsed().as_secs_f64() * 1000.0;
        let summary = self.monitor.summary(self.token.seq);
        let status = summary.as_ref().and_then(|summary| summary.status);
        let mut detail = Map::new();
        detail.insert(
            "durationMs".to_owned(),
            json!(
                summary
                    .as_ref()
                    .and_then(|summary| summary.duration_ms)
                    .unwrap_or(elapsed)
            ),
        );
        detail.insert("status".to_owned(), json!(status));
        detail.insert(
            "outcome".to_owned(),
            json!(summary.as_ref().and_then(|summary| summary.outcome)),
        );
        if client_gone {
            detail.insert("clientGone".to_owned(), Value::Bool(true));
        }
        if let Some(error) = summary.and_then(|summary| summary.error) {
            detail.insert("error".to_owned(), Value::String(error));
        }
        if console_only {
            detail.insert("consoleOnly".to_owned(), Value::Bool(true));
        }
        let kind = if status.is_some_and(|status| status >= 500) {
            "function.failed"
        } else {
            "function.finish"
        };
        let line = self.attributed(LogEvent::new(
            "INFO",
            "functions",
            format!("Finished \"{}\" in {elapsed}ms", self.function_id),
        ));
        self.log
            .record(line.with_kind(kind).with_detail(Value::Object(detail)));
    }

    /// A background handler threw: a console-only error line.
    fn handled_failure(&mut self) {
        if self.written {
            return;
        }
        self.written = true;
        let elapsed = self.started.elapsed().as_secs_f64() * 1000.0;
        let error = self
            .monitor
            .summary(self.token.seq)
            .and_then(|summary| summary.error);
        let mut detail = json!({ "outcome": "failed", "durationMs": elapsed, "consoleOnly": true });
        if let Some(error) = error {
            detail["error"] = Value::String(error);
        }
        let line = self.attributed(LogEvent::new(
            "ERROR",
            "functions",
            format!(
                "Finished \"{}\" in {elapsed}ms with an error",
                self.function_id
            ),
        ));
        self.log
            .record(line.with_kind("function.failed").with_detail(detail));
    }
}

impl Drop for EndLine {
    fn drop(&mut self) {
        self.finished(true, false);
    }
}

/// The response body as it passes through: an HTTP function's chunks are
/// recorded and its invocation finishes at the body's end; a body the
/// caller dropped is drained by a spawned task so the record still ends
/// with its true duration (`client_gone` only when the caller had started
/// reading). A background acknowledgement only carries the end line.
struct RecordedBody {
    upstream: Option<ByteStream>,
    background: bool,
    polled: bool,
    done: bool,
    monitor: Monitor,
    token: InvocationToken,
    end: Option<EndLine>,
    /// What is left of the function's timeout, for a drain.
    limit: Option<Duration>,
}

impl Stream for RecordedBody {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        let Some(upstream) = this.upstream.as_mut() else {
            return Poll::Ready(None);
        };
        this.polled = true;
        match upstream.as_mut().poll_next(context) {
            Poll::Ready(Some(Ok(bytes))) => {
                if !this.background {
                    this.monitor.response_chunk(&this.token, &bytes);
                }
                Poll::Ready(Some(Ok(bytes)))
            }
            Poll::Ready(Some(Err(error))) => {
                this.done = true;
                this.upstream = None;
                if !this.background {
                    this.monitor.finish(
                        &this.token,
                        InvocationEnd {
                            outcome: Some(InvocationOutcome::Crashed),
                            error: Some(format!(
                                "The worker closed the response before its end: {error}"
                            )),
                            client_gone: false,
                        },
                    );
                }
                if let Some(mut end) = this.end.take() {
                    end.finished(true, false);
                }
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                this.done = true;
                this.upstream = None;
                if !this.background {
                    this.monitor.finish(&this.token, InvocationEnd::default());
                }
                if let Some(mut end) = this.end.take() {
                    end.finished(false, false);
                }
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for RecordedBody {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        let client_gone = self.polled;
        let end = self.end.take();
        if self.background {
            if let Some(mut end) = end {
                end.finished(!client_gone, client_gone);
            }
            return;
        }
        let upstream = self.upstream.take();
        let handle = tokio::runtime::Handle::try_current();
        if let (Some(upstream), Ok(handle)) = (upstream, handle) {
            handle.spawn(drain(
                upstream,
                self.monitor.clone(),
                self.token.clone(),
                end,
                client_gone,
                self.limit,
            ));
        } else {
            let _ = self.monitor.finish(
                &self.token,
                InvocationEnd {
                    client_gone,
                    ..InvocationEnd::default()
                },
            );
            if let Some(mut end) = end {
                end.finished(!client_gone, client_gone);
            }
        }
    }
}

/// Reads the rest of a dropped HTTP body (bounded by the function's
/// timeout), recording its chunks, then finishes the invocation.
async fn drain(
    mut upstream: ByteStream,
    monitor: Monitor,
    token: InvocationToken,
    end: Option<EndLine>,
    client_gone: bool,
    limit: Option<Duration>,
) {
    let reading = async {
        while let Some(item) = upstream.next().await {
            match item {
                Ok(bytes) => monitor.response_chunk(&token, &bytes),
                Err(error) => {
                    return Some((
                        InvocationOutcome::Crashed,
                        format!("The worker closed the response before its end: {error}"),
                    ));
                }
            }
        }
        None
    };
    let failure = match limit {
        Some(limit) => tokio::time::timeout(limit, reading)
            .await
            .unwrap_or_else(|_| {
                Some((
                    InvocationOutcome::TimedOut,
                    "The response did not end within the function's timeout.".to_owned(),
                ))
            }),
        None => reading.await,
    };
    let (outcome, error) = failure.map_or((None, None), |(outcome, error)| {
        (Some(outcome), Some(error))
    });
    monitor.finish(
        &token,
        InvocationEnd {
            outcome,
            error,
            client_gone,
        },
    );
    if let Some(mut end) = end {
        end.finished(!client_gone, client_gone);
    }
}

/// The official proxy's error path: `resp.writeHead(500); resp.write(JSON.stringify(err))`.
fn proxy_failure() -> Response {
    // Streamed so the transfer is chunked like the official proxy's write.
    let chunk: Result<Bytes, std::io::Error> = Ok(Bytes::from_static(b"{\"code\":\"ECONNRESET\"}"));
    let mut response = Response::new(Body::from_stream(futures_util::stream::once(async move {
        chunk
    })));
    *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
    response
        .headers_mut()
        .insert("x-powered-by", HeaderValue::from_static(EXPRESS));
    response
}

/// `POST /functions/projects/{project}/trigger_multicast`.
async fn multicast_route(
    State(state): State<Shared>,
    Path(project): Path<String>,
    request: Request,
) -> Response {
    let (parts, body) = request.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, usize::MAX).await else {
        return express_text(
            StatusCode::BAD_REQUEST,
            "text/plain; charset=utf-8",
            "invalid multicast body",
        );
    };
    let Ok(event) = serde_json::from_slice::<Value>(&bytes) else {
        return express_text(
            StatusCode::BAD_REQUEST,
            "text/plain; charset=utf-8",
            "invalid multicast body",
        );
    };
    let is_cloud_event = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("cloudevent"));
    let event_type = if is_cloud_event {
        event.get("type")
    } else {
        event.get("eventType")
    }
    .and_then(Value::as_str)
    .unwrap_or("");
    let mut key = format!("{}:{event_type}", state.config.project_id);
    if let Some(bucket) = event.pointer("/data/bucket").and_then(Value::as_str) {
        key.push(':');
        key.push_str(bucket);
    }
    let targets = state.registry.read().await.multicast_targets(&key);
    for target in targets {
        let state = Arc::clone(&state);
        let headers = parts.headers.clone();
        let method = parts.method.clone();
        let bytes = bytes.clone();
        let project = project.clone();
        tokio::spawn(async move {
            let mut builder = Request::builder()
                .method(method)
                .uri(format!("/functions/projects/{project}/triggers/{target}"));
            if let Some(request_headers) = builder.headers_mut() {
                *request_headers = headers;
            }
            if let Ok(request) = builder.body(Body::from(bytes)) {
                let _ = dispatch(
                    state,
                    &target,
                    request,
                    "/".to_owned(),
                    DispatchContext::default(),
                )
                .await;
            }
        });
    }
    express_text(
        StatusCode::OK,
        "application/json; charset=utf-8",
        "{\"status\":\"multicast_acknowledged\"}",
    )
}

// --- Eventarc emulator ----------------------------------------------------------

async fn eventarc_not_found() -> Response {
    express_text(
        StatusCode::NOT_FOUND,
        "text/plain; charset=utf-8",
        "Not Found",
    )
}

fn eventarc_key(body: &Value) -> Result<(String, String, Map<String, Value>), String> {
    let trigger = body
        .get("eventTrigger")
        .and_then(Value::as_object)
        .ok_or_else(|| "Missing event trigger.".to_owned())?;
    let event_type = trigger
        .get("eventType")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let channel = trigger
        .get("channel")
        .and_then(Value::as_str)
        .unwrap_or("google")
        .to_owned();
    Ok((event_type, channel, trigger.clone()))
}

async fn eventarc_register(
    State(state): State<Shared>,
    Path((project, key)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let text = String::from_utf8_lossy(&body).replace("${PROJECT_ID}", &project);
    let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": "invalid JSON"})),
        )
            .into_response();
    };
    match eventarc_key(&parsed) {
        Ok((event_type, channel, trigger)) => {
            let filters: BTreeMap<String, String> = trigger
                .get("eventFilters")
                .and_then(Value::as_object)
                .map(|map| {
                    map.iter()
                        .filter_map(|(name, value)| {
                            value.as_str().map(|text| (name.clone(), text.to_owned()))
                        })
                        .collect()
                })
                .unwrap_or_default();
            state.registry.write().await.add_external_eventarc(
                project,
                key.clone(),
                event_type.clone(),
                channel.clone(),
                filters,
            );
            state.log.record(LogEvent::new("INFO", "eventarc", format!("Registering Eventarc event trigger for {event_type}-{channel} with trigger name {key}.")));
            (StatusCode::OK, axum::Json(json!({"res": "OK"}))).into_response()
        }
        Err(error) => {
            (StatusCode::BAD_REQUEST, axum::Json(json!({"error": error}))).into_response()
        }
    }
}

async fn eventarc_remove(
    State(state): State<Shared>,
    Path((project, key)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let text = String::from_utf8_lossy(&body).replace("${PROJECT_ID}", &project);
    let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": "invalid JSON"})),
        )
            .into_response();
    };
    match eventarc_key(&parsed) {
        Ok((event_type, channel, _)) => {
            if state
                .registry
                .write()
                .await
                .remove_external_eventarc(&key, &event_type, &channel)
            {
                (StatusCode::OK, axum::Json(json!({"res": "OK"}))).into_response()
            } else {
                (StatusCode::BAD_REQUEST, axum::Json(json!({"error": {}}))).into_response()
            }
        }
        Err(error) => {
            (StatusCode::BAD_REQUEST, axum::Json(json!({"error": error}))).into_response()
        }
    }
}

async fn eventarc_list(State(state): State<Shared>) -> Response {
    let registry = state.registry.read().await;
    (StatusCode::OK, axum::Json(registry.eventarc_json())).into_response()
}

async fn eventarc_publish_native(State(state): State<Shared>, body: Bytes) -> Response {
    eventarc_publish(state, "google".to_owned(), body).await
}

async fn eventarc_publish_channel(
    State(state): State<Shared>,
    Path((project, location, channel)): Path<(String, String, String)>,
    method: Method,
    uri: Uri,
    body: Bytes,
) -> Response {
    // The route is `/projects/{p}/locations/{l}/channels/{c}:publishEvents`;
    // axum matches the whole last segment, so strip the verb here.
    let _ = method;
    let channel = channel
        .strip_suffix(":publishEvents")
        .unwrap_or(&channel)
        .to_owned();
    if !uri.path().ends_with(":publishEvents") {
        return eventarc_not_found().await;
    }
    eventarc_publish(
        state,
        format!("projects/{project}/locations/{location}/channels/{channel}"),
        body,
    )
    .await
}

async fn eventarc_publish(state: Shared, channel: String, body: Bytes) -> Response {
    let Ok(parsed) = serde_json::from_slice::<Value>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Some(events) = parsed.get("events").and_then(Value::as_array) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match publish_events(state, &channel, events, EventarcOrigin::App, None).await {
        Ok(_) => StatusCode::OK.into_response(),
        Err(PublishError::MissingType) => StatusCode::BAD_REQUEST.into_response(),
    }
}

/// Why a batch of Eventarc events was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PublishError {
    /// An event has no `type`; the events before it were published (the
    /// official route's answer is `400`).
    MissingType,
}

/// Publishes events on a channel (`google` for the native channel): each
/// one is recorded with every subscription of its type on the channel and
/// whether that subscription's filters let it through, and delivered to the
/// ones they do. An event that cannot be converted is recorded with its
/// error and delivered to none. Returns the recorded events, in order.
pub(crate) async fn publish_events(
    state: Shared,
    channel: &str,
    events: &[Value],
    origin: EventarcOrigin,
    replay_of: Option<String>,
) -> Result<Vec<RecordedEvent>, PublishError> {
    let mut recorded = Vec::with_capacity(events.len());
    for event in events {
        let Some(event_type) = event.get("type").and_then(Value::as_str) else {
            state.monitor.event_received(EventReceived {
                channel: channel.to_owned(),
                raw: event.clone(),
                converted: Err("CloudEvent 'type' is required.".to_owned()),
                origin,
                replay_of: replay_of.clone(),
                deliveries: Vec::new(),
            });
            return Err(PublishError::MissingType);
        };
        // The official emulator's unlabeled INFO line reaches only its debug
        // log, never the terminal.
        state.log.record(LogEvent::new(
            "DEBUG",
            "eventarc",
            format!(
                "Received event at channel {channel}: {}",
                serde_json::to_string_pretty(event).unwrap_or_default()
            ),
        ));
        let converted = if channel == "google" {
            Ok(event.clone())
        } else {
            cloud_event_from_proto(event)
        };
        let payload = match &converted {
            Ok(payload) => payload.clone(),
            Err(error) => {
                state.log.record(
                    LogEvent::new("ERROR", "eventarc", error.clone())
                        .with_kind("eventarc.failed")
                        .with_detail(json!({ "error": error })),
                );
                recorded.push(state.monitor.event_received(EventReceived {
                    channel: channel.to_owned(),
                    raw: event.clone(),
                    converted,
                    origin,
                    replay_of: replay_of.clone(),
                    deliveries: Vec::new(),
                }));
                continue;
            }
        };
        let plans: Vec<(EventarcSubscription, DeliveryPlan)> = {
            let registry = state.registry.read().await;
            registry
                .eventarc_subscriptions(event_type, channel)
                .into_iter()
                .map(|subscription| {
                    let plan = DeliveryPlan {
                        trigger_key: subscription.trigger_key.clone(),
                        function_id: registry
                            .get(&subscription.trigger_key)
                            .map(|record| record.definition.id()),
                        mismatches: filter_mismatches(event, &subscription.filters),
                    };
                    (subscription, plan)
                })
                .collect()
        };
        let event_record = state.monitor.event_received(EventReceived {
            channel: channel.to_owned(),
            raw: event.clone(),
            converted,
            origin,
            replay_of: replay_of.clone(),
            deliveries: plans.iter().map(|(_, plan)| plan.clone()).collect(),
        });
        for (slot, (subscription, plan)) in plans.into_iter().enumerate() {
            if !plan.mismatches.is_empty() {
                continue;
            }
            let state = Arc::clone(&state);
            let payload = payload.clone();
            let event_seq = event_record.seq;
            tokio::spawn(async move {
                let request = Request::builder()
                    .method(Method::POST)
                    .uri(format!(
                        "/functions/projects/{}/triggers/{}",
                        subscription.project, subscription.trigger_key
                    ))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(payload.to_string()));
                if let Ok(request) = request {
                    let response = dispatch(
                        state.clone(),
                        &subscription.trigger_key,
                        request,
                        "/".to_owned(),
                        DispatchContext {
                            delivery: Some((event_seq, slot)),
                            ..DispatchContext::default()
                        },
                    )
                    .await;
                    let status = response.status().as_u16();
                    if status >= 400 {
                        state.log.record(
                            LogEvent::new(
                                "ERROR",
                                "eventarc",
                                format!(
                                    "Failed to trigger Functions emulator for {}: Received non-200 status code: {status}",
                                    subscription.trigger_key
                                ),
                            )
                            .with_kind("eventarc.failed")
                            .with_detail(json!({ "status": status })),
                        );
                    }
                }
            });
        }
        recorded.push(event_record);
    }
    Ok(recorded)
}

/// The filters of a subscription an event does not satisfy. An attribute is
/// read from the event's top level first, then from a channel event's
/// `attributes` (its `ceString` or `ceTimestamp`).
fn filter_mismatches(
    event: &Value,
    filters: &BTreeMap<String, String>,
) -> Vec<EventarcFilterMismatch> {
    filters
        .iter()
        .filter_map(|(name, expected)| {
            let attribute = event.get(name).or_else(|| {
                event
                    .get("attributes")
                    .and_then(|attributes| attributes.get(name))
            });
            let actual = match attribute {
                Some(Value::Object(map)) => map
                    .get("ceTimestamp")
                    .or_else(|| map.get("ceString"))
                    .and_then(Value::as_str),
                Some(value) => value.as_str(),
                None => None,
            };
            (actual != Some(expected.as_str())).then(|| EventarcFilterMismatch {
                attribute: name.clone(),
                expected: expected.clone(),
                actual: actual.map(str::to_owned),
            })
        })
        .collect()
}

/// `cloudEventFromProtoToJson`.
fn cloud_event_from_proto(event: &Value) -> Result<Value, String> {
    let required = |name: &str| {
        event
            .get(name)
            .cloned()
            .ok_or_else(|| format!("CloudEvent '{name}' is required."))
    };
    let attribute = |name: &str, kind: &str| {
        event
            .pointer(&format!("/attributes/{name}/{kind}"))
            .cloned()
    };
    let required_attribute = |name: &str, kind: &str| {
        attribute(name, kind).ok_or_else(|| format!("CloudEvent must contain {name} attribute"))
    };
    let mut out = Map::new();
    out.insert("id".to_owned(), required("id")?);
    out.insert("type".to_owned(), required("type")?);
    out.insert("specversion".to_owned(), required("specVersion")?);
    out.insert("source".to_owned(), required("source")?);
    out.insert(
        "subject".to_owned(),
        attribute("subject", "ceString").unwrap_or(Value::Null),
    );
    out.insert(
        "time".to_owned(),
        required_attribute("time", "ceTimestamp")?,
    );
    let content_type = required_attribute("datacontenttype", "ceString")?;
    let data = match content_type.as_str() {
        Some("application/json") => {
            let text = event
                .get("textData")
                .and_then(Value::as_str)
                .unwrap_or("null");
            serde_json::from_str::<Value>(text)
                .map_err(|error| format!("invalid JSON textData: {error}"))?
        }
        Some("text/plain") => event.get("textData").cloned().unwrap_or(Value::Null),
        Some(other) => return Err(format!("Unsupported content type: {other}")),
        None => Value::Null,
    };
    out.insert("data".to_owned(), data);
    out.insert("datacontenttype".to_owned(), content_type);
    if let Some(attributes) = event.get("attributes").and_then(Value::as_object) {
        for (name, value) in attributes {
            if ["time", "datacontenttype", "subject"].contains(&name.as_str()) {
                continue;
            }
            out.insert(
                name.clone(),
                value
                    .get("ceString")
                    .cloned()
                    .ok_or_else(|| format!("CloudEvent must contain {name} attribute"))?,
            );
        }
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mismatches_name_the_attribute_the_expected_and_the_actual_value() {
        let filters = BTreeMap::from([
            ("tier".to_owned(), "vip".to_owned()),
            ("subject".to_owned(), "ada".to_owned()),
            ("region".to_owned(), "eu".to_owned()),
        ]);
        let channel_event = json!({
            "type": "test.greeted",
            "attributes": {"tier": {"ceString": "gold"}, "subject": {"ceString": "ada"}}
        });
        assert_eq!(
            filter_mismatches(&channel_event, &filters),
            [
                EventarcFilterMismatch {
                    attribute: "region".to_owned(),
                    expected: "eu".to_owned(),
                    actual: None,
                },
                EventarcFilterMismatch {
                    attribute: "tier".to_owned(),
                    expected: "vip".to_owned(),
                    actual: Some("gold".to_owned()),
                },
            ]
        );
        let native = json!({"type": "a", "tier": "vip", "subject": "ada", "region": "eu"});
        assert_eq!(filter_mismatches(&native, &filters), []);
        let timestamped = json!({"attributes": {"time": {"ceTimestamp": "2026-10-12T00:00:00Z"}}});
        let at = BTreeMap::from([("time".to_owned(), "2026-10-12T00:00:00Z".to_owned())]);
        assert_eq!(filter_mismatches(&timestamped, &at), []);
    }
}
