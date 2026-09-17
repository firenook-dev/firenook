//! The Functions port: `/backends`, the trigger and multicast routes, the
//! `/{project}/{region}/{name}` HTTP routes, and the Eventarc emulator
//! routes. Responses reproduce the official hub's statuses, bodies and headers.
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use base64::Engine as _;
use futures_util::TryStreamExt as _;
use serde_json::{Map, Value, json};

use crate::log::LogEvent;
use crate::manifest::Signature;
use crate::{RuntimeState, WORKER_READY_TIMEOUT};

type Shared = Arc<RuntimeState>;

const EXPRESS: &str = "Express";
const CONTROL_TARGET: &str = "x-fireside-target";
const CONTROL_SIGNATURE: &str = "x-fireside-signature";
const CONTROL_SERVICE: &str = "x-fireside-service";
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
    dispatch(state, &trigger_id, request, rewritten).await
}

/// `path.replace(new RegExp("/{project}/[^/]*/{name}/?"), "/")`, keeping the query.
fn rewrite_path(uri: &Uri, project: &str, name: &str) -> String {
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
    dispatch(state, &key, request, path).await
}

/// `handleHttpsTrigger`: looks the record up and proxies to the codebase's worker.
async fn dispatch(state: Shared, trigger_id: &str, request: Request, path: String) -> Response {
    let (backend_id, definition, enabled) = {
        let registry = state.registry.read().await;
        let Some(record) = registry.get(trigger_id) else {
            let keys = registry.keys();
            return unknown_function(&state, &keys, trigger_id);
        };
        (
            record.codebase.clone(),
            record.definition.clone(),
            record.enabled,
        )
    };
    if !enabled {
        // Express drops the body and content type of a 204.
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NO_CONTENT;
        response
            .headers_mut()
            .insert("x-powered-by", HeaderValue::from_static(EXPRESS));
        return response;
    }
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
    let origin = match backend.slot.origin(WORKER_READY_TIMEOUT).await {
        Ok(origin) => origin,
        Err(error) => {
            state.log.record(LogEvent::new(
                "ERROR",
                &backend.label(),
                format!("Failed to handle request for function {}", definition.id()),
            ));
            state.log.record(LogEvent::new(
                "ERROR",
                &backend.label(),
                format!(
                    "Failed to start functions in {}: {error}",
                    backend.directory.display()
                ),
            ));
            return express_text(
                StatusCode::INTERNAL_SERVER_ERROR,
                "text/plain; charset=utf-8",
                format!(
                    "Failed to start functions in {}: {error}",
                    backend.directory.display()
                ),
            );
        }
    };
    let label = format!("functions[{}]", definition.id());
    state.log.record(LogEvent::new(
        "INFO",
        "functions",
        format!("Beginning execution of \"{}\"", definition.id()),
    ));
    let started = std::time::Instant::now();
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
        if HOP_BY_HOP.contains(&lowered.as_str())
            || lowered == CONTROL_TARGET
            || lowered == CONTROL_SIGNATURE
            || lowered == CONTROL_SERVICE
        {
            continue;
        }
        builder = builder.header(name, value);
    }
    builder = builder
        .header(CONTROL_TARGET, definition.entry_point())
        .header(CONTROL_SIGNATURE, signature.as_str())
        .header(CONTROL_SERVICE, definition.name())
        .body(body_bytes);
    let sent = match timeout {
        Some(limit) => {
            if let Ok(result) = tokio::time::timeout(limit, builder.send()).await {
                result
            } else {
                state.log.record(LogEvent::new(
                "ERROR",
                &label,
                format!(
                    "Your function timed out after ~{}s. To configure this timeout, see\n      https://firebase.google.com/docs/functions/manage-functions#set_timeout_and_memory_allocation.",
                    definition.timeout_seconds()
                ),
            ));
                return proxy_failure();
            }
        }
        None => builder.send().await,
    };
    let upstream = match sent {
        Ok(upstream) => upstream,
        Err(error) => {
            state.log.record(LogEvent::new(
                "ERROR",
                &label,
                format!("Request to function failed: {error}"),
            ));
            return proxy_failure();
        }
    };
    let status = upstream.status();
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
            fireside_functions_bridge::DELIVERY_HEADER,
            HeaderValue::from_static(fireside_functions_bridge::DELIVERY_HANDLED),
        );
    }
    let log = state.log.clone();
    let id = definition.id();
    let stream = upstream
        .bytes_stream()
        .map_err(std::io::Error::other)
        .inspect_ok(|_| {})
        .into_stream();
    let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let finished_for_stream = Arc::clone(&finished);
    let logged = futures_util::stream::unfold((stream, false), move |(mut stream, done)| {
        let log = log.clone();
        let id = id.clone();
        let finished = Arc::clone(&finished_for_stream);
        async move {
            if done {
                return None;
            }
            if let Some(item) = futures_util::StreamExt::next(&mut stream).await {
                Some((item, (stream, false)))
            } else {
                if !finished.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    let elapsed = started.elapsed();
                    log.record(LogEvent::new(
                        "INFO",
                        "functions",
                        format!("Finished \"{id}\" in {}ms", elapsed.as_secs_f64() * 1000.0),
                    ));
                }
                None
            }
        }
    });
    match response.body(Body::from_stream(logged)) {
        Ok(response) => response,
        Err(error) => express_text(
            StatusCode::INTERNAL_SERVER_ERROR,
            "text/plain; charset=utf-8",
            error.to_string(),
        ),
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
                let _ = dispatch(state, &target, request, "/".to_owned()).await;
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
    for event in events {
        let Some(event_type) = event.get("type").and_then(Value::as_str) else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        state.log.record(LogEvent::new(
            "INFO",
            "eventarc",
            format!(
                "Received event at channel {channel}: {}",
                serde_json::to_string_pretty(event).unwrap_or_default()
            ),
        ));
        let payload = if channel == "google" {
            event.clone()
        } else {
            match cloud_event_from_proto(event) {
                Ok(payload) => payload,
                Err(error) => {
                    state.log.record(LogEvent::new("ERROR", "eventarc", error));
                    continue;
                }
            }
        };
        let subscriptions = state
            .registry
            .read()
            .await
            .eventarc_subscriptions(event_type, &channel);
        for subscription in subscriptions {
            if !subscription.filters.iter().all(|(name, expected)| {
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
                actual == Some(expected.as_str())
            }) {
                continue;
            }
            let state = Arc::clone(&state);
            let payload = payload.clone();
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
                    )
                    .await;
                    if response.status().as_u16() >= 400 {
                        state.log.record(LogEvent::new("ERROR", "eventarc", format!("Failed to trigger Functions emulator for {}: Received non-200 status code: {}", subscription.trigger_key, response.status().as_u16())));
                    }
                }
            });
        }
    }
    StatusCode::OK.into_response()
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
