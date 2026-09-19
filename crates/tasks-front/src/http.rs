//! The Tasks port: the official Express app's four routes with Express
//! 4's routing, `express.json()` body handling, default 404/error pages,
//! automatic `OPTIONS`/`HEAD` answers and `cors({ origin: true })` on
//! `/queueStats`.

use axum::Router;
use axum::body::{Body, Bytes, HttpBody as _, to_bytes};
use axum::extract::{Request, State};
use axum::http::header::{
    CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, ORIGIN, TRANSFER_ENCODING, VARY,
};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use indexmap::IndexMap;

use crate::config::{
    ConfigError, INVALID_QUEUE_ID, OVER_CONCURRENCY_LIMIT, QueueConfig, queue_key, valid_queue_id,
};
use crate::json::{OrderedJson, decode_base64_forgiving};
use crate::queue::{TaskRecord, dispatch_deadline};
use crate::runtime::{EnqueueError, RemoveError, TasksRuntime};

const EXPRESS: &str = "Express";
/// `express.json()`'s default `limit`.
const JSON_LIMIT: usize = 100 * 1024;
/// The most compressed bytes read before the inflated limit applies.
const COMPRESSED_LIMIT: usize = 16 * 1024 * 1024;
/// The two-to-the-fifty-three ceiling of `Math.random() * MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(crate) fn router(runtime: TasksRuntime) -> Router {
    Router::new().fallback(handle).with_state(runtime)
}

/// One of the app's routes, matched the way Express 4 matches its paths:
/// literal segments case-insensitively, one optional trailing slash, and
/// params as decoded non-empty segments.
enum Route {
    Stats,
    Queue {
        project: String,
        location: String,
        queue: String,
    },
    Tasks {
        project: String,
        location: String,
        queue: String,
    },
    Task {
        project: String,
        location: String,
        queue: String,
        task: String,
    },
}

impl Route {
    /// The methods the route handles, for the automatic `OPTIONS` answer.
    fn allow(&self) -> &'static str {
        match self {
            Self::Stats => "GET,HEAD",
            Self::Queue { .. } | Self::Tasks { .. } => "POST",
            Self::Task { .. } => "DELETE",
        }
    }
}

enum Matched {
    Route(Route),
    /// A param whose percent-decoding failed (`Failed to decode param`).
    BadParam(String),
    None,
}

fn match_route(path: &str) -> Matched {
    let Some(rest) = path.strip_prefix('/') else {
        return Matched::None;
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let segments = rest.split('/').collect::<Vec<_>>();
    let literal = |index: usize, expected: &str| {
        segments
            .get(index)
            .is_some_and(|segment| segment.eq_ignore_ascii_case(expected))
    };
    let param = |index: usize| -> Option<Result<String, String>> {
        let raw = *segments.get(index)?;
        if raw.is_empty() {
            return None;
        }
        Some(percent_decode(raw).ok_or_else(|| raw.to_owned()))
    };
    if segments.len() == 1 && literal(0, "queueStats") {
        return Matched::Route(Route::Stats);
    }
    if !(literal(0, "projects") && literal(2, "locations") && literal(4, "queues")) {
        return Matched::None;
    }
    let mut params = Vec::new();
    for index in [1, 3, 5] {
        match param(index) {
            Some(Ok(value)) => params.push(value),
            Some(Err(raw)) => return Matched::BadParam(raw),
            None => return Matched::None,
        }
    }
    let (project, location, queue) = (params.remove(0), params.remove(0), params.remove(0));
    match segments.len() {
        6 => Matched::Route(Route::Queue {
            project,
            location,
            queue,
        }),
        7 if literal(6, "tasks") => Matched::Route(Route::Tasks {
            project,
            location,
            queue,
        }),
        8 if literal(6, "tasks") => match param(7) {
            Some(Ok(task)) => Matched::Route(Route::Task {
                project,
                location,
                queue,
                task,
            }),
            Some(Err(raw)) => Matched::BadParam(raw),
            None => Matched::None,
        },
        _ => Matched::None,
    }
}

/// `decodeURIComponent`: `None` for a malformed sequence.
fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            let text = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(text, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

async fn handle(State(runtime): State<TasksRuntime>, request: Request) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let (parts, body) = request.into_parts();
    let route = match match_route(&path) {
        Matched::Route(route) => route,
        Matched::BadParam(raw) => {
            return error_page(
                StatusCode::BAD_REQUEST,
                &format!("URIError: Failed to decode param '{raw}'"),
            );
        }
        Matched::None => return not_found(&method, &path),
    };
    let method_matches = matches!(
        (&route, &method),
        (Route::Stats, &Method::GET | &Method::HEAD)
            | (Route::Queue { .. } | Route::Tasks { .. }, &Method::POST)
            | (Route::Task { .. }, &Method::DELETE)
    );
    if !method_matches {
        return if method == Method::OPTIONS {
            options(route.allow())
        } else {
            not_found(&method, &path)
        };
    }
    dispatch(&runtime, route, &parts.headers, body).await
}

/// Runs the matched route's middleware (`express.json()`) and handler.
async fn dispatch(
    runtime: &TasksRuntime,
    route: Route,
    headers: &HeaderMap,
    body: Body,
) -> Response {
    match route {
        Route::Stats => stats(runtime, headers),
        Route::Queue {
            project,
            location,
            queue,
        } => match express_json(headers, body).await {
            Ok(body) => register(runtime, &project, &location, &queue, &body),
            Err(error) => error.page(),
        },
        Route::Tasks {
            project,
            location,
            queue,
        } => match express_json(headers, body).await {
            Ok(body) => enqueue(runtime, &project, &location, &queue, &body),
            Err(error) => error.page(),
        },
        Route::Task {
            project,
            location,
            queue,
            task,
        } => match express_json(headers, body).await {
            Ok(_) => remove(runtime, &project, &location, &queue, &task),
            Err(error) => error.page(),
        },
    }
}

/// `GET /queueStats` behind `cors({ origin: true })`.
fn stats(runtime: &TasksRuntime, headers: &HeaderMap) -> Response {
    let mut response = json_response(StatusCode::OK, &runtime.statistics().stringify());
    if let Some(origin) = headers.get(ORIGIN) {
        response
            .headers_mut()
            .insert("access-control-allow-origin", origin.clone());
    }
    response
        .headers_mut()
        .insert(VARY, HeaderValue::from_static("Origin"));
    response
}

/// `POST /projects/:project_id/locations/:location_id/queues/:queue_name`.
fn register(
    runtime: &TasksRuntime,
    project: &str,
    location: &str,
    queue: &str,
    body: &OrderedJson,
) -> Response {
    if !valid_queue_id(queue) {
        return json_response(
            StatusCode::BAD_REQUEST,
            &error_object(INVALID_QUEUE_ID).stringify(),
        );
    }
    let key = queue_key(project, location, queue);
    match QueueConfig::from_body(body) {
        Ok(config) => {
            let document = config.document().clone();
            runtime.register_queue(&key, config);
            let mut envelope = IndexMap::new();
            envelope.insert("taskQueueConfig".to_owned(), document);
            json_response(StatusCode::OK, &OrderedJson::Object(envelope).stringify())
        }
        Err(ConfigError::OverConcurrencyLimit) => {
            runtime.log("INFO", &format!("Created queue with key: {key}"));
            json_response(
                StatusCode::BAD_REQUEST,
                &error_object(OVER_CONCURRENCY_LIMIT).stringify(),
            )
        }
        Err(ConfigError::InvalidArrayLength) => {
            runtime.log("INFO", &format!("Created queue with key: {key}"));
            error_page(
                StatusCode::INTERNAL_SERVER_ERROR,
                "RangeError: Invalid array length",
            )
        }
    }
}

/// `POST /projects/:project_id/locations/:location_id/queues/:queue_name/tasks`.
fn enqueue(
    runtime: &TasksRuntime,
    project: &str,
    location: &str,
    queue: &str,
    body: &OrderedJson,
) -> Response {
    let key = queue_key(project, location, queue);
    let Some(default_uri) = runtime.default_uri(&key) else {
        runtime.log("WARN", "Tried to queue a task into a non-existent queue");
        return text_response(
            StatusCode::NOT_FOUND,
            "Tried to queue a task from a non-existent queue",
        );
    };
    // `req.body.task.name = …`, `req.body.task.httpRequest.body = JSON.parse(…)`
    // and `url === "" ? defaultUri : url` mutate the request's task object,
    // which the 200 echoes.
    let mut task = match body.get("task") {
        Some(OrderedJson::Object(map)) => map.clone(),
        _ => {
            return error_page(
                StatusCode::INTERNAL_SERVER_ERROR,
                "TypeError: Cannot read properties of undefined (reading 'name')",
            );
        }
    };
    let generated = format!(
        "/projects/{project}/locations/{location}/queues/{queue}/tasks/{}",
        random_safe_integer()
    );
    let record = match prepare_task(&mut task, generated, default_uri.as_ref()) {
        Ok(record) => record,
        Err(response) => return *response,
    };
    let name = record.name.clone();
    match runtime.enqueue(&key, record) {
        Ok(()) => {
            runtime.log("DEBUG", &format!("Enqueueing task {name} onto {key}"));
            let mut envelope = IndexMap::new();
            envelope.insert("task".to_owned(), OrderedJson::Object(task));
            json_response(StatusCode::OK, &OrderedJson::Object(envelope).stringify())
        }
        Err(EnqueueError::UnknownQueue) => {
            // The queue was replaced or is gone between the two locks; the
            // official app answers as if it had never existed.
            runtime.log("WARN", "Tried to queue a task into a non-existent queue");
            text_response(
                StatusCode::NOT_FOUND,
                "Tried to queue a task from a non-existent queue",
            )
        }
        Err(EnqueueError::Conflict) => text_response(
            StatusCode::CONFLICT,
            "A task with the same name already exists",
        ),
    }
}

/// The handler's mutations of `req.body.task` (name default, decoded body,
/// default URL) and the record the engine dispatches; the errors are the
/// exceptions the official handler lets Express turn into a 500 page.
fn prepare_task(
    task: &mut IndexMap<String, OrderedJson>,
    generated_name: String,
    default_uri: Option<&OrderedJson>,
) -> Result<TaskRecord, Box<Response>> {
    let name = match task.get("name") {
        Some(value) if !value.is_null() => value.js_string(),
        _ => {
            task.insert(
                "name".to_owned(),
                OrderedJson::String(generated_name.clone()),
            );
            generated_name
        }
    };
    let schedule_time = task
        .get("scheduleTime")
        .filter(|value| value.truthy())
        .map(OrderedJson::js_string);
    let deadline = dispatch_deadline(task.get("dispatchDeadline"));
    let Some(OrderedJson::Object(http_request)) = task.get_mut("httpRequest") else {
        return Err(Box::new(error_page(
            StatusCode::INTERNAL_SERVER_ERROR,
            "TypeError: Cannot read properties of undefined (reading 'body')",
        )));
    };
    let Some(encoded) = http_request.get("body").and_then(OrderedJson::as_str) else {
        return Err(Box::new(error_page(
            StatusCode::INTERNAL_SERVER_ERROR,
            "TypeError: The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object.",
        )));
    };
    let decoded = String::from_utf8_lossy(&decode_base64_forgiving(encoded)).into_owned();
    let parsed = OrderedJson::parse(&decoded).map_err(|error| {
        Box::new(error_page(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("SyntaxError: {error}"),
        ))
    })?;
    let body_text = parsed.stringify();
    http_request.insert("body".to_owned(), parsed);
    if http_request.get("url").and_then(OrderedJson::as_str) == Some("") {
        match default_uri {
            Some(uri) => {
                http_request.insert("url".to_owned(), uri.clone());
            }
            None => {
                http_request.shift_remove("url");
            }
        }
    }
    let url = http_request
        .get("url")
        .and_then(OrderedJson::as_str)
        .map(str::to_owned);
    let headers = match http_request.get("headers") {
        Some(OrderedJson::Object(map)) => map
            .iter()
            .map(|(name, value)| (name.clone(), value.js_string()))
            .collect(),
        Some(OrderedJson::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value.js_string()))
            .collect(),
        _ => Vec::new(),
    };
    Ok(TaskRecord {
        name,
        url,
        headers,
        body: body_text,
        schedule_time,
        deadline,
    })
}
/// `DELETE /projects/:project_id/locations/:location_id/queues/:queue_name/tasks/:task_id`.
fn remove(
    runtime: &TasksRuntime,
    project: &str,
    location: &str,
    queue: &str,
    task: &str,
) -> Response {
    let key = queue_key(project, location, queue);
    let name = format!("projects/{project}/locations/{location}/queues/{queue}/tasks/{task}");
    if runtime.has_queue(&key) {
        runtime.log("DEBUG", &format!("removing: {name}"));
    }
    match runtime.remove(&key, &name) {
        Ok(()) => json_response(StatusCode::OK, "{\"res\":\"OK\"}"),
        Err(RemoveError::UnknownQueue) => {
            runtime.log("WARN", "Tried to remove a task from a non-existent queue");
            text_response(
                StatusCode::NOT_FOUND,
                "Tried to remove a task from a non-existent queue",
            )
        }
        Err(RemoveError::NotFound) => {
            runtime.log("WARN", "Tried to remove a task that doesn't exist");
            text_response(
                StatusCode::NOT_FOUND,
                "Tried to remove a task that doesn't exist",
            )
        }
    }
}

/// `Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)`.
fn random_safe_integer() -> u64 {
    use std::hash::{BuildHasher as _, Hasher as _};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default(),
    );
    hasher.finish() % (MAX_SAFE_INTEGER + 1)
}

fn error_object(message: &str) -> OrderedJson {
    let mut object = IndexMap::new();
    object.insert("error".to_owned(), OrderedJson::String(message.to_owned()));
    OrderedJson::Object(object)
}

/// `express.json()`: `{}` without a JSON body, the parsed document with
/// one, and body-parser's error pages otherwise.
async fn express_json(headers: &HeaderMap, body: Body) -> Result<OrderedJson, BodyError> {
    // `typeis.hasBody`; a stream that is not at its end covers transports
    // that carry a body without either header (HTTP/2, in-process calls).
    let has_body = headers.contains_key(TRANSFER_ENCODING)
        || headers
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.trim().parse::<u64>().is_ok())
        || !body.is_end_stream();
    if !has_body {
        return Ok(OrderedJson::object());
    }
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let (mime, parameters) = content_type.split_once(';').unwrap_or((content_type, ""));
    if !mime.trim().eq_ignore_ascii_case("application/json") {
        return Ok(OrderedJson::object());
    }
    let charset = parameters
        .split(';')
        .filter_map(|parameter| parameter.trim().split_once('='))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("charset"))
        .map(|(_, value)| value.trim().trim_matches('"').to_ascii_lowercase());
    if let Some(charset) = &charset
        && !charset.starts_with("utf-")
    {
        return Err(BodyError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            &format!(
                "UnsupportedMediaTypeError: unsupported charset \"{}\"",
                charset.to_ascii_uppercase()
            ),
        ));
    }
    let encoding = headers
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map_or_else(
            || "identity".to_owned(),
            |value| value.trim().to_ascii_lowercase(),
        );
    let compressed = match encoding.as_str() {
        "identity" => false,
        "gzip" | "deflate" => true,
        _ => {
            return Err(BodyError::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &format!("UnsupportedMediaTypeError: unsupported content encoding \"{encoding}\""),
            ));
        }
    };
    // body-parser checks the declared length of an identity body up front
    // and the inflated length of a compressed one as it streams.
    let declared = headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<usize>().ok());
    if !compressed && declared.is_some_and(|length| length > JSON_LIMIT) {
        return Err(BodyError::payload_too_large());
    }
    let raw_limit = if compressed {
        COMPRESSED_LIMIT
    } else {
        JSON_LIMIT
    };
    let raw: Bytes = match to_bytes(body, raw_limit).await {
        Ok(bytes) => bytes,
        Err(_) => return Err(BodyError::payload_too_large()),
    };
    let bytes = if compressed {
        inflate(&raw, encoding == "gzip")?
    } else {
        raw.to_vec()
    };
    if bytes.is_empty() {
        return Ok(OrderedJson::object());
    }
    let text = String::from_utf8_lossy(&bytes);
    let first = text
        .char_indices()
        .find(|(_, c)| !matches!(c, ' ' | '\t' | '\n' | '\r'));
    match first {
        Some((_, '{' | '[')) => {}
        Some((position, other)) => {
            return Err(BodyError::new(
                StatusCode::BAD_REQUEST,
                &format!("SyntaxError: Unexpected token {other} in JSON at position {position}"),
            ));
        }
        None => return Ok(OrderedJson::object()),
    }
    OrderedJson::parse(&text)
        .map_err(|error| BodyError::new(StatusCode::BAD_REQUEST, &format!("SyntaxError: {error}")))
}

/// `inflate: true`: a gzip or zlib body, at most `JSON_LIMIT` bytes once
/// inflated.
fn inflate(raw: &[u8], gzip: bool) -> Result<Vec<u8>, BodyError> {
    use std::io::Read as _;
    let limit = u64::try_from(JSON_LIMIT + 1).unwrap_or(u64::MAX);
    let mut out = Vec::new();
    let result = if gzip {
        flate2::read::GzDecoder::new(raw)
            .take(limit)
            .read_to_end(&mut out)
    } else {
        flate2::read::ZlibDecoder::new(raw)
            .take(limit)
            .read_to_end(&mut out)
    };
    if out.len() > JSON_LIMIT {
        return Err(BodyError::payload_too_large());
    }
    result.map_err(|error| BodyError::new(StatusCode::BAD_REQUEST, &format!("Error: {error}")))?;
    Ok(out)
}

/// A body-parser rejection, rendered as the default error page.
struct BodyError {
    status: StatusCode,
    message: String,
}

impl BodyError {
    fn new(status: StatusCode, message: &str) -> Self {
        Self {
            status,
            message: message.to_owned(),
        }
    }

    fn payload_too_large() -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "PayloadTooLargeError: request entity too large",
        )
    }

    fn page(self) -> Response {
        error_page(self.status, &self.message)
    }
}

/// `res.json(...)` / `res.send(object)`.
fn json_response(status: StatusCode, body: &str) -> Response {
    express_response(status, "application/json; charset=utf-8", body.to_owned())
}

/// `res.send(string)`.
fn text_response(status: StatusCode, body: &str) -> Response {
    express_response(status, "text/html; charset=utf-8", body.to_owned())
}

fn express_response(status: StatusCode, content_type: &'static str, body: String) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
        .headers_mut()
        .insert("x-powered-by", HeaderValue::from_static(EXPRESS));
    response
}

/// Express 4's automatic `OPTIONS` answer for a matched path.
fn options(allow: &'static str) -> Response {
    let mut response = Response::new(Body::from(allow));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert("x-powered-by", HeaderValue::from_static(EXPRESS));
    headers.insert("allow", HeaderValue::from_static(allow));
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/plain"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}

/// The default `finalhandler` 404 page: `Cannot {METHOD} {path}`.
fn not_found(method: &Method, path: &str) -> Response {
    error_page(
        StatusCode::NOT_FOUND,
        &format!("Cannot {method} {}", encode_url(path)),
    )
}

/// The default `finalhandler` error page.
pub(crate) fn error_page(status: StatusCode, message: &str) -> Response {
    let body = format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>{}</pre>\n</body>\n</html>\n",
        escape_html(message)
    );
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert("x-powered-by", HeaderValue::from_static(EXPRESS));
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static("default-src 'none'"),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    response
}

/// `escape-html`.
fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

/// `encodeurl`: percent-encodes what a URL may not carry, keeping existing
/// well-formed `%XX` sequences.
fn encode_url(path: &str) -> String {
    use std::fmt::Write as _;
    let bytes = path.as_bytes();
    let mut out = String::with_capacity(path.len());
    for (index, byte) in bytes.iter().copied().enumerate() {
        let allowed = matches!(
            byte,
            b'!' | b'#'..=b';' | b'=' | b'?'..=b'_' | b'a'..=b'z' | b'|' | b'~'
        );
        if byte == b'%' {
            let well_formed = bytes
                .get(index + 1..index + 3)
                .is_some_and(|hex| hex.iter().all(u8::is_ascii_hexdigit));
            out.push_str(if well_formed { "%" } else { "%25" });
        } else if allowed {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}
