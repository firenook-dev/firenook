//! Firebase Auth-compatible local emulator surface.
//!
//! A port of the official Auth emulator (firebase-tools 15.22.0
//! `lib/emulator/auth`): the same OpenAPI-driven routing, security and body
//! validation, the same operations with the same validation order and error
//! strings, the same tokens, codes, tenants, second factors and lifecycle
//! events. Behaviour is measured by the frozen corpus in
//! `conformance/fixtures/auth-v1`.

#![forbid(unsafe_code)]
// The operations mirror the official emulator's functions one to one so that
// each can be read against its source; splitting them would hide that.
#![allow(clippy::too_many_lines)]

use std::collections::BTreeMap;
use std::fmt::{self, Display, Formatter};
use std::future::Future;
use std::path::{Path as FilePath, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use firenook_functions_bridge::{DispatchQueue, DispatchRequest, TriggerRegistry};
use serde_json::{Map as JsonMap, Value as JsonValue, json};

pub mod blocking;
pub mod error;
pub mod legacy;
pub mod ops;
pub mod pages;
pub mod spec;
pub mod state;
pub mod token;
pub mod util;

use blocking::{BlockingContext, BlockingOutcome, BlockingTarget, OauthTokens};
use error::ApiError;
use ops::Ctx;
use state::{AuthData, BlockingEvent, Lifecycle, Scope, UpdateOptions, UserRecord};
use util::{decode_jwt, now_iso, random_uuid, str_field};

const AUTH_SERVICE: &str = "firebaseauth.googleapis.com";
const AUTH_HEADER_PREFIX: &str = "bearer ";
const SERVICE_ACCOUNT_TOKEN_PREFIX: &str = "ya29.";
const MAX_BODY_BYTES: usize = 1024 * 1024 * 1024;

/// Blocking-function endpoints as the Functions runtime registered them
/// (`blockingFunctions.triggers` and `forwardInboundCredentials`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BlockingFunctions {
    pub before_create: Option<String>,
    pub before_sign_in: Option<String>,
    pub forward_access_token: bool,
    pub forward_id_token: bool,
    pub forward_refresh_token: bool,
}

/// Resolves the current blocking-function configuration at sign-in time.
pub trait BlockingResolver: Send + Sync {
    fn resolve(&self) -> Pin<Box<dyn Future<Output = BlockingFunctions> + Send + '_>>;
}

/// Receives the emulator's log lines (`BULLET`, `WARN`, ...).
pub type LogSink = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// Builds a Firebase Auth router backed by in-memory state.
///
/// # Panics
///
/// Panics when `project` is empty or contains whitespace.
#[must_use]
pub fn router(project: &str, queue: DispatchQueue, background: TriggerRegistry) -> AuthRuntime {
    AuthRuntime::new(project, queue, background, None)
        .expect("an in-memory Auth runtime cannot fail to initialize")
}

/// Shared Auth state and HTTP router.
pub struct AuthRuntime {
    application: Router,
    runtime: Runtime,
}

/// Runtime construction or persistence failure.
#[derive(Debug)]
pub struct AuthError(String);

impl Display for AuthError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for AuthError {}

struct Inner {
    default_project: String,
    data: Mutex<AuthData>,
    state_file: Option<PathBuf>,
    queue: DispatchQueue,
    background: TriggerRegistry,
    blocking: RwLock<Option<Arc<dyn BlockingResolver>>>,
    log: RwLock<Option<LogSink>>,
    origin: RwLock<Option<String>>,
    client: reqwest::Client,
}

/// Cloneable handle to the shared state, used by every operation.
#[derive(Clone)]
pub struct Runtime {
    inner: Arc<Inner>,
}

impl AuthRuntime {
    /// Builds a runtime with optional durable JSON state.
    pub fn new(
        project: &str,
        queue: DispatchQueue,
        background: TriggerRegistry,
        state_file: Option<PathBuf>,
    ) -> Result<Self, AuthError> {
        validate_project(project)?;
        let mut data = state_file
            .as_deref()
            .map_or_else(|| Ok(AuthData::default()), load_state)?;
        data.rebuild_indexes();
        let runtime = Runtime {
            inner: Arc::new(Inner {
                default_project: project.to_owned(),
                data: Mutex::new(data),
                state_file,
                queue,
                background,
                blocking: RwLock::new(None),
                log: RwLock::new(None),
                origin: RwLock::new(None),
                client: reqwest::Client::builder().build().map_err(|error| {
                    AuthError(format!(
                        "failed to build the blocking-function client: {error}"
                    ))
                })?,
            }),
        };
        let application = Router::new().fallback(handle).with_state(runtime.clone());
        Ok(Self {
            application,
            runtime,
        })
    }

    /// Installs the resolver consulted for blocking functions when the
    /// project configuration names none.
    pub fn set_blocking_functions(&self, resolver: Arc<dyn BlockingResolver>) {
        if let Ok(mut slot) = self.runtime.inner.blocking.write() {
            *slot = Some(resolver);
        }
    }

    /// Receives log lines the official emulator prints (action links, codes).
    pub fn set_log_sink(&self, sink: LogSink) {
        if let Ok(mut slot) = self.runtime.inner.log.write() {
            *slot = Some(sink);
        }
    }

    /// The origin this service is reachable at (`http://host:port`), used
    /// for the action links the way the registered official emulator does.
    pub fn set_origin(&self, origin: &str) {
        if let Ok(mut slot) = self.runtime.inner.origin.write() {
            *slot = Some(origin.trim_end_matches('/').to_owned());
        }
    }

    /// Cloneable Axum application.
    pub fn application(&self) -> Router {
        self.application.clone()
    }

    /// The shared runtime handle.
    #[must_use]
    pub fn runtime(&self) -> Runtime {
        self.runtime.clone()
    }

    /// Publishes native state, including an intentionally empty Auth database.
    pub fn checkpoint_native_state(&self) -> Result<(), AuthError> {
        self.runtime.persist(&lock(&self.runtime.inner.data))
    }

    /// Number of users in the configured project.
    #[must_use]
    pub fn user_count(&self) -> usize {
        let mut data = lock(&self.runtime.inner.data);
        data.agent(&self.runtime.inner.default_project)
            .project
            .user_count()
    }

    /// Writes the current project state to a Firebase-compatible export file.
    pub fn export_users(&self, path: &FilePath) -> Result<(), AuthError> {
        let users = {
            let mut data = lock(&self.runtime.inner.data);
            data.agent(&self.runtime.inner.default_project)
                .project
                .query_users(state::QueryOrder::Asc, None)
        };
        write_atomic(
            path,
            &json!({ "kind": "identitytoolkit#DownloadAccountResponse", "users": users }),
        )
    }

    /// Imports Firebase Auth JSON without emitting lifecycle triggers.
    pub fn import_users(&self, path: &FilePath) -> Result<usize, AuthError> {
        let bytes = std::fs::read(path)
            .map_err(|error| AuthError(format!("failed to read Auth import: {error}")))?;
        let value: JsonValue = serde_json::from_slice(&bytes)
            .map_err(|error| AuthError(format!("invalid Auth import JSON: {error}")))?;
        let users = value
            .get("users")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| AuthError("Auth import requires a users array".to_owned()))?;
        let mut data = lock(&self.runtime.inner.data);
        let project = &mut data.agent(&self.runtime.inner.default_project).project;
        let mut imported = 0;
        for user in users {
            let record = user
                .as_object()
                .ok_or_else(|| AuthError("Auth user must be an object".to_owned()))?;
            let local_id = str_field(record, "localId")
                .ok_or_else(|| AuthError("Auth user requires localId".to_owned()))?
                .to_owned();
            let mut props = record.clone();
            props
                .entry("emailVerified".to_owned())
                .or_insert(JsonValue::Bool(false));
            props
                .entry("disabled".to_owned())
                .or_insert(JsonValue::Bool(false));
            // `overwriteUserWithLocalId` keeps createdAt and refreshes lastLoginAt;
            // an export round trip must keep both as recorded.
            let last_login = props.get("lastLoginAt").cloned();
            project
                .overwrite_user_with_local_id(&local_id, &props)
                .map_err(|error| AuthError(error.message))?;
            if let Some(last_login) = last_login {
                let mut fields = UserRecord::new();
                fields.insert("lastLoginAt".to_owned(), last_login);
                project
                    .update_user_by_local_id(&local_id, &fields, UpdateOptions::default())
                    .map_err(|error| AuthError(error.message))?;
            }
            imported += 1;
        }
        project.events.clear();
        self.runtime.persist(&data)?;
        Ok(imported)
    }

    /// Writes `accounts.json` and `config.json` using the suite export layout.
    pub fn export_directory(&self, root: &FilePath) -> Result<(), AuthError> {
        std::fs::create_dir_all(root)
            .map_err(|error| AuthError(format!("failed to create Auth export: {error}")))?;
        self.export_users(&root.join("accounts.json"))?;
        let config = {
            let mut data = lock(&self.runtime.inner.data);
            let agent = data.agent(&self.runtime.inner.default_project);
            json!({
                "signIn": { "allowDuplicateEmails": !agent.one_account_per_email() },
                "emailPrivacyConfig": { "enableImprovedEmailPrivacy": agent.improved_email_privacy() },
            })
        };
        write_atomic(&root.join("config.json"), &config)
    }

    /// Imports a suite Auth directory without emitting lifecycle triggers.
    pub fn import_directory(&self, root: &FilePath) -> Result<usize, AuthError> {
        let imported = self.import_users(&root.join("accounts.json"))?;
        let config_path = root.join("config.json");
        if config_path.is_file() {
            let config = std::fs::read(&config_path)
                .map_err(|error| AuthError(format!("failed to read Auth config: {error}")))?;
            let config = serde_json::from_slice::<JsonValue>(&config)
                .map_err(|error| AuthError(format!("invalid Auth config JSON: {error}")))?;
            let mut data = lock(&self.runtime.inner.data);
            let agent = data.agent(&self.runtime.inner.default_project);
            if let Some(object) = config.as_object() {
                let mut mask = Vec::new();
                if object
                    .get("signIn")
                    .and_then(|sign_in| sign_in.get("allowDuplicateEmails"))
                    .is_some()
                {
                    mask.push("signIn.allowDuplicateEmails");
                }
                if object
                    .get("emailPrivacyConfig")
                    .and_then(|privacy| privacy.get("enableImprovedEmailPrivacy"))
                    .is_some()
                {
                    mask.push("emailPrivacyConfig.enableImprovedEmailPrivacy");
                }
                let joined = mask.join(",");
                agent.update_config(
                    object,
                    if joined.is_empty() {
                        None
                    } else {
                        Some(&joined)
                    },
                );
            }
            self.runtime.persist(&data)?;
        }
        Ok(imported)
    }
}

impl Runtime {
    /// The project requests without an explicit target project address.
    #[must_use]
    pub fn default_project(&self) -> &str {
        &self.inner.default_project
    }

    /// `authEmulatorUrl(req)`: the configured origin, else the request host.
    #[must_use]
    pub fn emulator_url(&self, host_header: Option<&str>) -> String {
        if let Ok(slot) = self.inner.origin.read()
            && let Some(origin) = slot.as_ref()
        {
            return origin.clone();
        }
        host_header.map_or_else(
            || "http://unknown".to_owned(),
            |host| format!("http://{host}"),
        )
    }

    /// Emits a log line the way the official emulator's logger would.
    pub fn log(&self, kind: &str, text: &str) {
        if let Ok(slot) = self.inner.log.read()
            && let Some(sink) = slot.as_ref()
        {
            sink(kind, text);
        }
    }

    /// Runs `body` against the request's project or tenant under the state
    /// lock, persists the result and dispatches the lifecycle events it queued.
    pub fn scope<T>(
        &self,
        ctx: &Ctx,
        body: impl FnOnce(&mut Scope<'_>) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        let (result, events) = {
            let mut data = lock(&self.inner.data);
            let mut scope = Scope::new(&mut data, &ctx.project_id, ctx.tenant_id.as_deref());
            let result = body(&mut scope);
            let events = data.take_events();
            if let Err(error) = self.persist(&data) {
                return Err(ApiError::unknown(error.0, "persist"));
            }
            (result, events)
        };
        for (project_id, kind, user) in events {
            self.dispatch_lifecycle(&project_id, kind, &user);
        }
        result
    }

    /// `fetchBlockingFunction` for `event`, resolved from the project
    /// configuration first and the installed resolver second.
    pub async fn blocking(
        &self,
        ctx: &Ctx,
        event: BlockingEvent,
        user: &UserRecord,
        context: &BlockingContext,
        oauth: &OauthTokens,
    ) -> Result<BlockingOutcome, ApiError> {
        let configured = {
            let mut data = lock(&self.inner.data);
            let scope = Scope::new(&mut data, &ctx.project_id, ctx.tenant_id.as_deref());
            scope.blocking_uri(event).map(|uri| BlockingTarget {
                uri,
                forward_access_token: scope.forward_credential("accessToken"),
                forward_id_token: scope.forward_credential("idToken"),
                forward_refresh_token: scope.forward_credential("refreshToken"),
                project_id: ctx.project_id.clone(),
                tenant_id: ctx.tenant_id.clone(),
            })
        };
        let target = if configured.is_some() {
            configured
        } else if let Some(resolver) = self
            .inner
            .blocking
            .read()
            .ok()
            .and_then(|slot| slot.clone())
        {
            let functions = resolver.resolve().await;
            let uri = match event {
                BlockingEvent::BeforeCreate => functions.before_create.clone(),
                BlockingEvent::BeforeSignIn => functions.before_sign_in.clone(),
            };
            uri.map(|uri| BlockingTarget {
                uri,
                forward_access_token: functions.forward_access_token,
                forward_id_token: functions.forward_id_token,
                forward_refresh_token: functions.forward_refresh_token,
                project_id: ctx.project_id.clone(),
                tenant_id: ctx.tenant_id.clone(),
            })
        } else {
            None
        };
        blocking::fetch_blocking_function(&self.inner.client, target, event, user, context, oauth)
            .await
    }

    fn persist(&self, data: &AuthData) -> Result<(), AuthError> {
        match &self.inner.state_file {
            Some(path) => write_atomic(path, data),
            None => Ok(()),
        }
    }

    fn dispatch_lifecycle(&self, project_id: &str, kind: Lifecycle, user: &UserRecord) {
        if !self.inner.background.background_enabled() {
            return;
        }
        let event_type = match kind {
            Lifecycle::Create => "providers/firebase.auth/eventTypes/user.create",
            Lifecycle::Delete => "providers/firebase.auth/eventTypes/user.delete",
        };
        let event_id = random_uuid();
        let body = json!({
            "eventId": event_id,
            "eventType": event_type,
            "resource": { "name": format!("projects/{project_id}"), "service": AUTH_SERVICE },
            "params": {},
            "timestamp": now_iso(),
            "data": user_info_payload(user),
        });
        let _ = self.inner.queue.enqueue(DispatchRequest {
            path: format!("/functions/projects/{project_id}/trigger_multicast"),
            headers: BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]),
            body: serde_json::to_vec(&body).expect("JSON serialization cannot fail"),
            event_id,
        });
    }
}

/// `createUserInfoPayload`: the multicast body's `data`.
fn user_info_payload(user: &UserRecord) -> JsonValue {
    let mut payload = JsonMap::new();
    let mut set = |key: &str, value: Option<JsonValue>| {
        if let Some(value) = value.filter(|value| !value.is_null()) {
            payload.insert(key.to_owned(), value);
        }
    };
    set("uid", user.get("localId").cloned());
    set("email", user.get("email").cloned());
    set("emailVerified", user.get("emailVerified").cloned());
    set("displayName", user.get("displayName").cloned());
    set("photoURL", user.get("photoUrl").cloned());
    set("phoneNumber", user.get("phoneNumber").cloned());
    set("disabled", user.get("disabled").cloned());
    let mut metadata = JsonMap::new();
    if let Some(created) = str_field(user, "createdAt").and_then(|value| value.parse::<i64>().ok())
    {
        metadata.insert(
            "creationTime".to_owned(),
            json!(util::iso_from_millis(created)),
        );
    }
    if let Some(last) = str_field(user, "lastLoginAt").and_then(|value| value.parse::<i64>().ok()) {
        metadata.insert(
            "lastSignInTime".to_owned(),
            json!(util::iso_from_millis(last)),
        );
    }
    set("metadata", Some(JsonValue::Object(metadata)));
    set(
        "customClaims",
        Some(
            str_field(user, "customAttributes")
                .and_then(|value| serde_json::from_str::<JsonValue>(value).ok())
                .unwrap_or_else(|| json!({})),
        ),
    );
    if user
        .get("providerUserInfo")
        .is_some_and(JsonValue::is_array)
    {
        let providers: Vec<JsonValue> = state::provider_infos(user)
            .iter()
            .map(|info| {
                let mut entry = JsonMap::new();
                for (source, target) in [
                    ("rawId", "rawId"),
                    ("providerId", "providerId"),
                    ("displayName", "displayName"),
                    ("email", "email"),
                    ("federatedId", "federatedId"),
                    ("phoneNumber", "phoneNumber"),
                    ("photoUrl", "photoURL"),
                    ("screenName", "screenName"),
                ] {
                    if let Some(value) = info.get(source).filter(|value| !value.is_null()) {
                        entry.insert(target.to_owned(), value.clone());
                    }
                }
                JsonValue::Object(entry)
            })
            .collect();
        set("providerData", Some(JsonValue::Array(providers)));
    }
    set("tenantId", user.get("tenantId").cloned());
    set("mfaInfo", user.get("mfaInfo").cloned());
    JsonValue::Object(payload)
}

// ---------------------------------------------------------------- HTTP pipeline

/// Express-style JSON (`json spaces: 2`, `application/json; charset=utf-8`).
pub(crate) fn pretty_json(status: StatusCode, value: &JsonValue) -> Response {
    let text = serde_json::to_string_pretty(value).unwrap_or_default();
    (
        status,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        text,
    )
        .into_response()
}

/// Exegesis-style JSON (`application/json`).
fn api_json(status: StatusCode, value: &JsonValue) -> Response {
    let text = serde_json::to_string(value).unwrap_or_default();
    (status, [(header::CONTENT_TYPE, "application/json")], text).into_response()
}

async fn handle(State(runtime): State<Runtime>, request: Request) -> Response {
    let origin = request.headers().get(header::ORIGIN).cloned();
    let private_network = request
        .headers()
        .contains_key("access-control-request-private-network");
    if request.method() == Method::OPTIONS {
        return preflight(&request, origin.as_ref(), private_network);
    }
    let mut response = route(&runtime, request).await;
    if let Some(origin) = origin {
        response
            .headers_mut()
            .insert("access-control-allow-origin", origin);
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static("Origin"));
    }
    if private_network {
        response.headers_mut().insert(
            "access-control-allow-private-network",
            HeaderValue::from_static("true"),
        );
    }
    response
}

fn preflight(request: &Request, origin: Option<&HeaderValue>, private_network: bool) -> Response {
    let mut response = Response::builder().status(StatusCode::NO_CONTENT);
    if let Some(origin) = origin {
        response = response
            .header("access-control-allow-origin", origin)
            .header(header::VARY, "Origin, Access-Control-Request-Headers");
    }
    response = response.header(
        "access-control-allow-methods",
        "GET,HEAD,PUT,PATCH,POST,DELETE",
    );
    if let Some(headers) = request.headers().get("access-control-request-headers") {
        response = response.header("access-control-allow-headers", headers);
    }
    if private_network {
        response = response.header("access-control-allow-private-network", "true");
    }
    response
        .header(header::CONTENT_LENGTH, "0")
        .body(Body::empty())
        .unwrap_or_else(|_| StatusCode::NO_CONTENT.into_response())
}

fn query_pairs(query: Option<&str>) -> Vec<(String, String)> {
    query
        .map(|query| {
            url::form_urlencoded::parse(query.as_bytes())
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect()
        })
        .unwrap_or_default()
}

async fn route(runtime: &Runtime, request: Request) -> Response {
    let method = request.method().clone();
    let uri = request.uri().clone();
    let path = uri.path().to_owned();
    let query = uri.query().map(str::to_owned);
    let pairs = query_pairs(query.as_deref());
    let query_map: BTreeMap<String, String> = pairs.iter().cloned().collect();
    let headers = request.headers().clone();
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);

    // Routes registered before the API: readiness, the document, the pages.
    match (method.clone(), path.as_str()) {
        (Method::GET, "/") => return pages::readiness(),
        (Method::GET, "/emulator/openapi.json") => return pages::openapi("http", host.as_deref()),
        (Method::GET, "/emulator/action") => return pages::action(runtime, &pairs),
        (Method::GET, "/emulator/auth/handler") => return pages::handler(runtime, &query_map),
        (Method::GET, "/emulator/auth/iframe") => return pages::iframe(),
        _ => {}
    }

    // Express strips the content type of DELETE requests before parsing.
    let mut content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_lowercase()
        })
        .filter(|value| !value.is_empty());
    if method == Method::DELETE {
        content_type = None;
    }
    let Ok(body_bytes) = to_bytes(request.into_body(), MAX_BODY_BYTES).await else {
        return ApiError::bad_request("request body too large").into_response();
    };

    // Legacy relyingparty rewrites.
    let mut method = method;
    let mut path = path;
    let mut query = query;
    let mut body_override: Option<JsonValue> = None;
    if path.starts_with(legacy::PREFIX) {
        let parsed_body =
            if content_type.as_deref() == Some("application/json") && !body_bytes.is_empty() {
                serde_json::from_slice::<JsonValue>(&body_bytes)
                    .ok()
                    .map(spec::camel_case_keys)
                    .and_then(|value| value.as_object().cloned())
            } else {
                None
            };
        match legacy::rewrite(
            method.as_str(),
            &path,
            query.as_deref().unwrap_or_default(),
            parsed_body.as_ref(),
        ) {
            Ok(legacy::Rewrite::Path(rewritten)) => path = rewritten,
            Ok(legacy::Rewrite::Download {
                path: rewritten,
                query: rewritten_query,
            }) => {
                method = Method::GET;
                path = rewritten;
                query = Some(rewritten_query);
                content_type = None;
                body_override = Some(JsonValue::Null);
            }
            Ok(legacy::Rewrite::Upload {
                path: rewritten,
                body,
            }) => {
                path = rewritten;
                body_override = Some(body);
            }
            Ok(legacy::Rewrite::NotImplemented) => {
                return ApiError::not_implemented(
                    "signOutUser is not implemented in the Auth Emulator.",
                )
                .into_response();
            }
            Ok(legacy::Rewrite::None) => {}
            Err(error) => return error.into_response(),
        }
    }
    let pairs = query_pairs(query.as_deref());

    let Some(matched) = spec::SPEC.match_route(method.as_str(), &path) else {
        return ApiError::not_found().into_response();
    };
    let Some(operation) = matched.operation else {
        let original = match &query {
            Some(query) => format!("{path}?{query}"),
            None => path.clone(),
        };
        return api_json(
            StatusCode::METHOD_NOT_ALLOWED,
            &json!({ "message": format!("Method {} not allowed for {original}", method.as_str()) }),
        );
    };

    // Security.
    let privileged = match authenticate(runtime, operation, &headers, &pairs) {
        Ok(privileged) => privileged,
        Err(error) => return error.into_response(),
    };

    // Query parameters.
    let mut query_values: BTreeMap<String, JsonValue> = BTreeMap::new();
    for parameter in &operation.query_parameters {
        if let Some((_, raw)) = pairs.iter().find(|(name, _)| *name == parameter.name) {
            match spec::validate_query_parameter(&parameter.schema, raw) {
                Ok(value) => {
                    query_values.insert(parameter.name.clone(), value);
                }
                Err(error) => return error.into_response(),
            }
        }
    }

    // Body.
    let body = match parse_body(
        operation,
        content_type.as_deref(),
        &body_bytes,
        body_override,
    ) {
        Ok(body) => body,
        Err(error) => return error.into_response(),
    };

    // Target project and tenant (`toExegesisOperation`).
    // Path parameters may be empty (`tenants//accounts:batchCreate` is how
    // the CLI imports project-level users); empty is falsy, so it falls through.
    let target_project = matched
        .path_parameters
        .get("targetProjectId")
        .filter(|value| !value.is_empty())
        .cloned()
        .or_else(|| {
            str_field(&body, "targetProjectId")
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        });
    let project_id = match target_project {
        Some(project) => {
            if operation.security.iter().any(|scheme| scheme == "Oauth2") && !privileged {
                return ApiError::bad_request("INSUFFICIENT_PERMISSION : Only authenticated requests can specify target_project_id.").into_response();
            }
            project
        }
        None => runtime.default_project().to_owned(),
    };
    let path_tenant = matched
        .path_parameters
        .get("tenantId")
        .filter(|value| !value.is_empty())
        .cloned();
    let body_tenant = str_field(&body, "tenantId")
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if let (Some(from_path), Some(from_body)) = (&path_tenant, &body_tenant)
        && from_path != from_body
    {
        return ApiError::bad_request("TENANT_ID_MISMATCH").into_response();
    }
    let mut tenant_id = path_tenant.or(body_tenant);
    if let Some(id_token) = str_field(&body, "idToken").filter(|value| !value.is_empty())
        && let Some((_, payload)) = decode_jwt(id_token)
    {
        let Some(firebase) = payload.get("firebase") else {
            let error = ApiError::unknown(
                "Cannot read properties of undefined (reading 'tenant')",
                "TypeError",
            );
            log_server_error(runtime, &error);
            return error.into_response();
        };
        let token_tenant = firebase
            .get("tenant")
            .and_then(JsonValue::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        if let (Some(from_token), Some(target)) = (&token_tenant, &tenant_id)
            && from_token != target
        {
            return ApiError::bad_request("TENANT_ID_MISMATCH").into_response();
        }
        tenant_id = tenant_id.or(token_tenant);
    }
    if let Some(refresh) = str_field(&body, "refreshToken").filter(|value| !value.is_empty()) {
        match token::decode_refresh_token(refresh) {
            Ok(record) => {
                if let (Some(from_record), Some(target)) = (&record.tenant_id, &tenant_id)
                    && from_record != target
                {
                    return ApiError::bad_request("TENANT_ID_MISMATCH: ((Refresh token tenant ID does not match target tenant ID.))").into_response();
                }
                tenant_id = tenant_id.or(record.tenant_id);
            }
            Err(error) => return error.into_response(),
        }
    }

    let ctx = Ctx {
        project_id,
        tenant_id,
        privileged,
        body,
        query: query_values,
        emulator_url: runtime.emulator_url(host.as_deref()),
    };
    match dispatch(runtime, &operation.operation_id, &ctx).await {
        Ok(value) => api_json(StatusCode::OK, &value),
        Err(error) => {
            log_server_error(runtime, &error);
            error.into_response()
        }
    }
}

/// `logError(err)`: the official server logs every 500 as a `WARN` line
/// starting `<ErrorName>: <message>` (followed by a Node stack trace).
fn log_server_error(runtime: &Runtime, error: &ApiError) {
    if error.code != 500 {
        return;
    }
    let name = match error.status {
        Some("INTERNAL") => "InternalError".to_owned(),
        _ => error.errors[0]["reason"]
            .as_str()
            .filter(|reason| reason.ends_with("Error"))
            .unwrap_or("UnknownError")
            .to_owned(),
    };
    runtime.log("WARN", &format!("{name}: {}", error.message));
}

/// The security schemes of the operation against the request's credentials.
fn authenticate(
    runtime: &Runtime,
    operation: &spec::Operation,
    headers: &HeaderMap,
    pairs: &[(String, String)],
) -> Result<bool, ApiError> {
    if operation.security.is_empty() {
        return Ok(false);
    }
    let accepts = |scheme: &str| operation.security.iter().any(|name| name == scheme);
    if accepts("Oauth2")
        && let Some(authorization) = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
        && authorization.to_lowercase().starts_with(AUTH_HEADER_PREFIX)
    {
        let token = &authorization[AUTH_HEADER_PREFIX.len()..];
        if token.eq_ignore_ascii_case("owner") {
            return Ok(true);
        }
        if token.starts_with(SERVICE_ACCOUNT_TOKEN_PREFIX) {
            runtime.log(
                "WARN",
                &format!(
                    "Received service account token {token}. Assuming that it owns project \"{}\".",
                    runtime.default_project()
                ),
            );
            return Ok(true);
        }
        return Err(ApiError::unauthenticated(
            "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.",
            "Invalid Credentials",
            "authError",
        ));
    }
    let key_query = pairs
        .iter()
        .find(|(name, _)| name == "key")
        .map(|(_, value)| value.as_str())
        .filter(|value| !value.is_empty());
    let key_header = headers
        .get("x-goog-api-key")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty());
    if (accepts("apiKeyQuery") && key_query.is_some())
        || (accepts("apiKeyHeader") && key_header.is_some())
    {
        return Ok(false);
    }
    if accepts("apiKeyQuery") || accepts("apiKeyHeader") {
        return Err(ApiError::permission_denied(
            "The request is missing a valid API key.",
        ));
    }
    Err(ApiError::unauthenticated(
        "Request is missing required authentication credential. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.",
        "Login Required.",
        "required",
    ))
}

/// Body parsing as express + exegesis do it: JSON (or form data for the
/// grant route), camel-cased keys, REST-mapping coercions, schema validation.
fn parse_body(
    operation: &spec::Operation,
    content_type: Option<&str>,
    bytes: &[u8],
    body_override: Option<JsonValue>,
) -> Result<JsonMap<String, JsonValue>, ApiError> {
    let Some(schema) = &operation.body_schema else {
        return Ok(JsonMap::new());
    };
    let mut value = match body_override {
        Some(JsonValue::Null) => JsonValue::Object(JsonMap::new()),
        Some(value) => value,
        None => match content_type {
            None => JsonValue::Object(JsonMap::new()),
            Some("application/json") => {
                if bytes.is_empty() {
                    JsonValue::Object(JsonMap::new())
                } else {
                    let text = String::from_utf8_lossy(bytes);
                    let trimmed = text.trim_start();
                    // body-parser strict mode: only objects and arrays.
                    if !(trimmed.starts_with('{') || trimmed.starts_with('[')) {
                        return Err(ApiError::parse_error(format!(
                            "Invalid JSON payload received. Unexpected token '{}', \"{}\" is not valid JSON",
                            trimmed.chars().next().unwrap_or(' '),
                            truncate_for_error(&text)
                        )));
                    }
                    serde_json::from_str::<JsonValue>(&text).map_err(|error| {
                        ApiError::parse_error(format!("Invalid JSON payload received. {error}"))
                    })?
                }
            }
            Some("application/x-www-form-urlencoded")
                if operation
                    .body_content_types
                    .iter()
                    .any(|kind| kind == "application/x-www-form-urlencoded") =>
            {
                let mut object = JsonMap::new();
                for (key, value) in url::form_urlencoded::parse(bytes) {
                    object.insert(key.into_owned(), JsonValue::String(value.into_owned()));
                }
                JsonValue::Object(object)
            }
            Some(other) => {
                return Err(ApiError::bad_request_reason(
                    format!("Invalid content-type: {other}"),
                    "unknown",
                ));
            }
        },
    };
    value = spec::camel_case_keys(value);
    spec::validate_body(schema, &mut value)?;
    Ok(value.as_object().cloned().unwrap_or_default())
}

fn truncate_for_error(text: &str) -> String {
    let compact: String = text.chars().take(10).collect();
    if text.chars().count() > 10 {
        format!("{compact}\"...")
    } else {
        compact
    }
}

async fn dispatch(runtime: &Runtime, operation_id: &str, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    use ops::{admin, config, mfa, oob, signin, signup, tenants, update};
    match operation_id {
        "identitytoolkit.getProjects" => admin::get_projects(runtime, ctx),
        "identitytoolkit.getRecaptchaParams" => admin::get_recaptcha_params(runtime, ctx),
        "identitytoolkit.accounts.createAuthUri" => signin::create_auth_uri(runtime, ctx),
        "identitytoolkit.accounts.delete"
        | "identitytoolkit.projects.accounts.delete"
        | "identitytoolkit.projects.tenants.accounts.delete" => admin::delete_account(runtime, ctx),
        "identitytoolkit.accounts.lookup"
        | "identitytoolkit.projects.accounts.lookup"
        | "identitytoolkit.projects.tenants.accounts.lookup" => admin::lookup(runtime, ctx),
        "identitytoolkit.accounts.resetPassword" => oob::reset_password_op(runtime, ctx),
        "identitytoolkit.accounts.sendOobCode"
        | "identitytoolkit.projects.accounts.sendOobCode"
        | "identitytoolkit.projects.tenants.accounts.sendOobCode" => {
            oob::send_oob_code(runtime, ctx)
        }
        "identitytoolkit.accounts.sendVerificationCode" => {
            signin::send_verification_code(runtime, ctx)
        }
        "identitytoolkit.accounts.signInWithCustomToken" => {
            signin::sign_in_with_custom_token(runtime, ctx)
        }
        "identitytoolkit.accounts.signInWithEmailLink" => {
            signin::sign_in_with_email_link(runtime, ctx).await
        }
        "identitytoolkit.accounts.signInWithIdp" => signin::sign_in_with_idp(runtime, ctx).await,
        "identitytoolkit.accounts.signInWithPassword" => {
            signin::sign_in_with_password(runtime, ctx).await
        }
        "identitytoolkit.accounts.signInWithPhoneNumber" => {
            signin::sign_in_with_phone_number(runtime, ctx).await
        }
        "identitytoolkit.accounts.signUp"
        | "identitytoolkit.projects.accounts"
        | "identitytoolkit.projects.tenants.accounts" => signup::sign_up(runtime, ctx).await,
        "identitytoolkit.accounts.update"
        | "identitytoolkit.projects.accounts.update"
        | "identitytoolkit.projects.tenants.accounts.update" => {
            update::set_account_info(runtime, ctx)
        }
        "identitytoolkit.accounts.mfaEnrollment.finalize" => {
            mfa::mfa_enrollment_finalize(runtime, ctx)
        }
        "identitytoolkit.accounts.mfaEnrollment.start" => mfa::mfa_enrollment_start(runtime, ctx),
        "identitytoolkit.accounts.mfaEnrollment.withdraw" => {
            mfa::mfa_enrollment_withdraw(runtime, ctx)
        }
        "identitytoolkit.accounts.mfaSignIn.start" => mfa::mfa_sign_in_start(runtime, ctx),
        "identitytoolkit.accounts.mfaSignIn.finalize" => {
            mfa::mfa_sign_in_finalize(runtime, ctx).await
        }
        "identitytoolkit.accounts.passkeyEnrollment.start" => {
            mfa::passkey_enrollment_start(runtime, ctx)
        }
        "identitytoolkit.accounts.passkeyEnrollment.finalize" => {
            mfa::passkey_enrollment_finalize(runtime, ctx)
        }
        "identitytoolkit.accounts.passkeySignIn.start" => mfa::passkey_sign_in_start(runtime, ctx),
        "identitytoolkit.accounts.passkeySignIn.finalize" => {
            mfa::passkey_sign_in_finalize(runtime, ctx)
        }
        "identitytoolkit.projects.createSessionCookie"
        | "identitytoolkit.projects.tenants.createSessionCookie" => {
            admin::create_session_cookie(runtime, ctx)
        }
        "identitytoolkit.projects.queryAccounts"
        | "identitytoolkit.projects.accounts.query"
        | "identitytoolkit.projects.tenants.accounts.query" => admin::query_accounts(runtime, ctx),
        "identitytoolkit.projects.getConfig" => config::get_config(runtime, ctx),
        "identitytoolkit.projects.updateConfig" => config::update_config(runtime, ctx),
        "identitytoolkit.projects.accounts.batchCreate"
        | "identitytoolkit.projects.tenants.accounts.batchCreate" => {
            admin::batch_create(runtime, ctx)
        }
        "identitytoolkit.projects.accounts.batchDelete"
        | "identitytoolkit.projects.tenants.accounts.batchDelete" => {
            admin::batch_delete(runtime, ctx)
        }
        "identitytoolkit.projects.accounts.batchGet"
        | "identitytoolkit.projects.tenants.accounts.batchGet" => admin::batch_get(runtime, ctx),
        "identitytoolkit.projects.tenants.create" => tenants::create_tenant(runtime, ctx),
        "identitytoolkit.projects.tenants.delete" => tenants::delete_tenant(runtime, ctx),
        "identitytoolkit.projects.tenants.get" => tenants::get_tenant(runtime, ctx),
        "identitytoolkit.projects.tenants.list" => tenants::list_tenants(runtime, ctx),
        "identitytoolkit.projects.tenants.patch" => tenants::update_tenant(runtime, ctx),
        "securetoken.token" => signin::grant_token(runtime, ctx),
        "emulator.projects.accounts.delete" => config::delete_all_accounts(runtime, ctx),
        "emulator.projects.config.get" => config::get_emulator_config(runtime, ctx),
        "emulator.projects.config.update" => config::update_emulator_config(runtime, ctx),
        "emulator.projects.oobCodes.list" => config::list_oob_codes(runtime, ctx),
        "emulator.projects.verificationCodes.list" => config::list_verification_codes(runtime, ctx),
        other => Err(ApiError::not_implemented(format!(
            "{other} is not implemented in the Auth Emulator."
        ))),
    }
}

// ---------------------------------------------------------------- persistence

fn validate_project(project: &str) -> Result<(), AuthError> {
    if project.is_empty() || project.chars().any(char::is_whitespace) {
        return Err(AuthError(
            "Auth project id must be a non-empty string without whitespace".to_owned(),
        ));
    }
    Ok(())
}

fn load_state(path: &FilePath) -> Result<AuthData, AuthError> {
    if !path.is_file() {
        return Ok(AuthData::default());
    }
    let bytes = std::fs::read(path)
        .map_err(|error| AuthError(format!("failed to read Auth state: {error}")))?;
    let value: JsonValue = serde_json::from_slice(&bytes)
        .map_err(|error| AuthError(format!("invalid Auth state JSON: {error}")))?;
    if value.get("version").and_then(JsonValue::as_u64) == Some(2) {
        return serde_json::from_value(value)
            .map_err(|error| AuthError(format!("invalid Auth state: {error}")));
    }
    // The next.7 layout: `projects.<id>.{users, config}` with a flat config.
    let mut data = AuthData {
        version: 2,
        projects: BTreeMap::new(),
    };
    for (project_id, project) in value
        .get("projects")
        .and_then(JsonValue::as_object)
        .into_iter()
        .flatten()
    {
        let agent = data.agent(project_id);
        for (local_id, user) in project
            .get("users")
            .and_then(JsonValue::as_object)
            .into_iter()
            .flatten()
        {
            if let Some(record) = user.as_object() {
                agent.project.users.insert(local_id.clone(), record.clone());
            }
        }
        if let Some(config) = project.get("config").and_then(JsonValue::as_object) {
            let mut mask = Vec::new();
            if config
                .get("signIn")
                .and_then(|sign_in| sign_in.get("allowDuplicateEmails"))
                .is_some()
            {
                mask.push("signIn.allowDuplicateEmails");
            }
            if config
                .get("emailPrivacyConfig")
                .and_then(|privacy| privacy.get("enableImprovedEmailPrivacy"))
                .is_some()
            {
                mask.push("emailPrivacyConfig.enableImprovedEmailPrivacy");
            }
            let joined = mask.join(",");
            agent.update_config(
                config,
                if joined.is_empty() {
                    None
                } else {
                    Some(&joined)
                },
            );
        }
    }
    Ok(data)
}

fn write_atomic(path: &FilePath, value: &impl serde::Serialize) -> Result<(), AuthError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            AuthError(format!("failed to create Auth state directory: {error}"))
        })?;
    }
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| AuthError(format!("failed to serialize Auth state: {error}")))?;
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, bytes)
        .map_err(|error| AuthError(format!("failed to write Auth state: {error}")))?;
    std::fs::rename(&temporary, path)
        .map_err(|error| AuthError(format!("failed to publish Auth state: {error}")))?;
    Ok(())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests;
