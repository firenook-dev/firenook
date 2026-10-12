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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::Instant;

use axum::Router;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use firenook_functions_bridge::{
    DispatchQueue, DispatchRequest, DroppedService, TriggerRegistry, cause,
};
use serde_json::{Map as JsonMap, Value as JsonValue, json};

pub mod blocking;
pub mod console;
pub mod error;
pub mod legacy;
pub mod observe;
pub mod ops;
pub mod pages;
mod persist;
pub mod spec;
pub mod state;
pub mod token;
pub mod util;

use blocking::{BlockingContext, BlockingOutcome, BlockingTarget, OauthTokens};
use error::ApiError;
use observe::{
    ACTIVITY_HEADER, AuthObserver, Body as RecordedBody, CallError, CallRecord, ConsoleOrigin,
    Description, Notice, Step, Trace, TriggerOutcome,
};
use ops::Ctx;
pub use persist::PersistStats;
use persist::Persister;
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

/// The blocking functions a project would call now (`Runtime::blocking_targets`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BlockingTargets {
    pub before_create: Option<HookTarget>,
    pub before_sign_in: Option<HookTarget>,
    pub forward_id_token: bool,
    pub forward_access_token: bool,
    pub forward_refresh_token: bool,
}

/// One blocking function and where its registration comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookTarget {
    pub uri: String,
    pub source: HookSource,
}

/// Where a blocking function's registration comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookSource {
    /// Set with `updateConfig` (`blockingFunctions.triggers`).
    Config,
    /// Discovered by the Functions emulator.
    Functions,
}

/// Resolves the current blocking-function configuration at sign-in time.
pub trait BlockingResolver: Send + Sync {
    fn resolve(&self) -> Pin<Box<dyn Future<Output = BlockingFunctions> + Send + '_>>;
}

/// Receives the emulator's log lines (`BULLET`, `WARN`, ...) as text.
pub type LogSink = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// Receives the emulator's log lines with what they are about: a code or a
/// link carries the message it printed, so the console can link the line to
/// its inbox entry and its user.
pub type LineSink = Arc<dyn Fn(&AuthLogLine<'_>) + Send + Sync>;

/// One line the emulator prints.
#[derive(Clone, Copy, Debug)]
pub struct AuthLogLine<'a> {
    /// `BULLET`, `SUCCESS`, `WARN` or `ERROR`.
    pub kind: &'a str,
    /// The text exactly as the official emulator prints it.
    pub text: &'a str,
    /// The code or link the line prints, when it prints one.
    pub message: Option<&'a AuthMessageRef>,
}

/// The message a log line prints: its inbox id and whom it is for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthMessageRef {
    pub id: u64,
    pub project: String,
    pub tenant: Option<String>,
    pub uid: Option<String>,
}

/// Where log lines go: text only, or with what they are about.
#[derive(Clone)]
enum Sink {
    Text(LogSink),
    Lines(LineSink),
}

/// The console's observer and whether it keeps bodies.
type Observer = (Arc<dyn AuthObserver>, bool);

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
    /// The state, shared with the state file's writer thread.
    data: Arc<Mutex<AuthData>>,
    /// Writes the state file off the request path; absent without one.
    persister: Option<Persister>,
    queue: DispatchQueue,
    background: TriggerRegistry,
    blocking: RwLock<Option<Arc<dyn BlockingResolver>>>,
    log: RwLock<Option<Sink>>,
    origin: RwLock<Option<String>>,
    client: reqwest::Client,
    /// The console's record of every call, when it listens.
    observer: RwLock<Option<Observer>>,
    /// Call ids, drawn when a request arrives.
    next_call: AtomicU64,
    /// Message ids, drawn when a code is created (or found in saved state).
    next_message: AtomicU64,
    /// Moves when the blocking functions may have changed: a resolver was
    /// installed, the Functions emulator reloaded, the project's
    /// configuration changed.
    blocking_changes: tokio::sync::watch::Sender<u64>,
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
        data.version = STATE_VERSION;
        data.rebuild_indexes();
        let data = Arc::new(Mutex::new(data));
        let persister = state_file
            .map(|file| Persister::start(file, data.clone()))
            .transpose()?;
        let runtime = Runtime {
            inner: Arc::new(Inner {
                default_project: project.to_owned(),
                data,
                persister,
                queue,
                background,
                blocking: RwLock::new(None),
                log: RwLock::new(None),
                origin: RwLock::new(None),
                observer: RwLock::new(None),
                next_call: AtomicU64::new(1),
                next_message: AtomicU64::new(1),
                blocking_changes: tokio::sync::watch::Sender::new(0),
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
        self.blocking_changed();
    }

    /// Ticks when the blocking functions may have changed (see
    /// [`Runtime::blocking_changes`]).
    #[must_use]
    pub fn blocking_changes(&self) -> tokio::sync::watch::Receiver<u64> {
        self.runtime.blocking_changes()
    }

    /// The blocking functions may have changed: the Functions emulator
    /// reloaded its inventory.
    pub fn blocking_changed(&self) {
        self.runtime.blocking_changed();
    }

    /// Receives log lines the official emulator prints (action links, codes)
    /// as text. The last sink set, of either kind, receives every line.
    pub fn set_log_sink(&self, sink: LogSink) {
        if let Ok(mut slot) = self.runtime.inner.log.write() {
            *slot = Some(Sink::Text(sink));
        }
    }

    /// Receives log lines with the message each one prints, when any. The
    /// last sink set, of either kind, receives every line.
    pub fn set_line_sink(&self, sink: LineSink) {
        if let Ok(mut slot) = self.runtime.inner.log.write() {
            *slot = Some(Sink::Lines(sink));
        }
    }

    /// The console's record of every call: `observer` receives one
    /// [`CallRecord`] per finished call; `keep_bodies` keeps request and
    /// response bodies up to 16 KiB each (diagnostics on).
    pub fn set_observer(&self, observer: Arc<dyn AuthObserver>, keep_bodies: bool) {
        if let Ok(mut slot) = self.runtime.inner.observer.write() {
            *slot = Some((observer, keep_bodies));
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
        self.runtime.write_state(true)
    }

    /// Writes the state file now if anything changed since the last write.
    /// Changes otherwise reach the file within 250 ms, written off the
    /// request path; a test that reads the file flushes first.
    pub fn flush(&self) -> Result<(), AuthError> {
        self.runtime.flush()
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
        drop(data);
        self.runtime.mark_dirty();
        self.runtime.flush()?;
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
            drop(data);
            self.runtime.mark_dirty();
            self.runtime.flush()?;
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
        self.log_line(&AuthLogLine {
            kind,
            text,
            message: None,
        });
    }

    /// Emits the line that prints a code or a link, with its message.
    pub fn log_message(&self, kind: &str, text: &str, message: &AuthMessageRef) {
        self.log_line(&AuthLogLine {
            kind,
            text,
            message: Some(message),
        });
    }

    fn log_line(&self, line: &AuthLogLine<'_>) {
        let sink = self.inner.log.read().ok().and_then(|slot| slot.clone());
        match sink {
            Some(Sink::Text(sink)) => sink(line.kind, line.text),
            Some(Sink::Lines(sink)) => sink(line),
            None => {}
        }
    }

    /// A fresh message id: what the inbox, the log line and the
    /// `auth.message` key name a code by.
    #[must_use]
    pub fn next_message_id(&self) -> u64 {
        self.inner.next_message.fetch_add(1, Ordering::Relaxed)
    }

    /// Ticks when the blocking functions may have changed: a resolver was
    /// installed, the Functions emulator reloaded, or a project's
    /// configuration changed. The value counts the changes.
    #[must_use]
    pub fn blocking_changes(&self) -> tokio::sync::watch::Receiver<u64> {
        self.inner.blocking_changes.subscribe()
    }

    /// Moves [`Runtime::blocking_changes`].
    pub fn blocking_changed(&self) {
        self.inner
            .blocking_changes
            .send_modify(|changes| *changes = changes.wrapping_add(1));
    }

    /// A fresh call id.
    #[must_use]
    pub fn next_call_id(&self) -> u64 {
        self.inner.next_call.fetch_add(1, Ordering::Relaxed)
    }

    /// The console's observer, when one listens.
    fn observer(&self) -> Option<Observer> {
        self.inner
            .observer
            .read()
            .ok()
            .and_then(|slot| slot.clone())
    }

    /// Hands a finished call to the observer, when one listens.
    pub fn record(&self, record: CallRecord) {
        if let Some((observer, _)) = self.observer() {
            observer.call(record);
        }
    }

    /// Whether an observer listens, and whether it keeps bodies.
    #[must_use]
    pub fn observed(&self) -> Option<bool> {
        self.observer().map(|(_, keep)| keep)
    }

    /// Every code the state holds, as found when the engine started
    /// (`Restored`, no time), each with a fresh message id: the inbox's
    /// first entries.
    #[must_use]
    pub fn saved_messages(&self) -> Vec<observe::MessageRecord> {
        let data = lock(&self.inner.data);
        let mut next = || self.next_message_id();
        let mut messages = Vec::new();
        for (project_id, agent) in &data.projects {
            let scopes = std::iter::once((None, &agent.project)).chain(
                agent
                    .tenants
                    .iter()
                    .map(|(id, tenant)| (Some(id.as_str()), &tenant.project)),
            );
            for (tenant, project) in scopes {
                for mut message in project.saved_messages(&mut next) {
                    message.project.clone_from(project_id);
                    message.tenant = tenant.map(str::to_owned);
                    messages.push(message);
                }
            }
        }
        messages
    }

    /// Runs `body` against the request's project or tenant under the state
    /// lock, persists the result and dispatches the lifecycle events it queued.
    pub fn scope<T>(
        &self,
        ctx: &Ctx,
        body: impl FnOnce(&mut Scope<'_>) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        self.update_traced(&ctx.trace, |data| {
            let mut scope = Scope::new(data, &ctx.project_id, ctx.tenant_id.as_deref());
            body(&mut scope)
        })
        .map_err(|error| ApiError::unknown(error.0, "persist"))?
    }

    /// Reads the state under its lock: no project or tenant is created and
    /// nothing is written. For reads beside the emulator's own operations
    /// (the console's identity search).
    pub fn read<T>(&self, body: impl FnOnce(&AuthData) -> T) -> T {
        body(&lock(&self.inner.data))
    }

    /// Changes the state under its lock, marks it for writing when it
    /// changed and dispatches the lifecycle events it queued, as an
    /// operation's scope does, without resolving (or creating) a project or
    /// tenant first. For writes beside the emulator's own operations (the
    /// console minting a token for an existing account).
    pub fn update<T>(&self, body: impl FnOnce(&mut AuthData) -> T) -> Result<T, AuthError> {
        self.update_traced(&Trace::default(), body)
    }

    /// [`Runtime::update`] for the call `trace` follows: what the change
    /// caused (accounts, codes, configuration, lifecycle events) becomes its
    /// steps when it records.
    pub fn update_traced<T>(
        &self,
        trace: &Trace,
        body: impl FnOnce(&mut AuthData) -> T,
    ) -> Result<T, AuthError> {
        // Nothing is encoded here: a change only marks the state dirty, and
        // the writer snapshots it in O(1) and encodes it off the request
        // path, so a lookup never rewrites the state and a write never waits
        // for an encode, whatever the number of users.
        let (result, events, notices, changed) = {
            let mut data = lock(&self.inner.data);
            let before = data.generation();
            let result = body(&mut data);
            let events = data.take_events();
            // Always drained, so the lists never grow without an observer.
            let notices = data.take_notices();
            (result, events, notices, data.generation() != before)
        };
        if changed {
            self.mark_dirty();
        }
        // A project's configuration holds its blocking functions.
        if notices.iter().any(|(_, _, notice)| {
            matches!(
                notice,
                Notice::Config {
                    tenant: None,
                    what: observe::ConfigChange::Project
                }
            )
        }) {
            self.blocking_changed();
        }
        if trace.recording() {
            for (_, tenant, notice) in notices {
                trace.push(match notice {
                    Notice::User {
                        uid,
                        change,
                        fields,
                    } => Step::User {
                        tenant,
                        uid,
                        change,
                        fields,
                    },
                    Notice::Cleared => Step::UsersCleared { tenant },
                    Notice::Message(mut message) => {
                        message.origin = trace.origin();
                        Step::MessageSent(*message)
                    }
                    Notice::Used { key } => Step::MessageUsed { key },
                    Notice::Config { tenant, what } => Step::Config { tenant, what },
                });
            }
        }
        for (project_id, kind, user) in events {
            let outcome = self.dispatch_lifecycle(&project_id, kind, &user);
            if trace.recording() {
                trace.push(Step::Trigger {
                    event: match kind {
                        Lifecycle::Create => "user.create",
                        Lifecycle::Delete => "user.delete",
                    },
                    uid: observe::uid_of(&user).unwrap_or_default(),
                    outcome,
                });
            }
        }
        Ok(result)
    }

    /// Writes the state file now if anything changed since the last write.
    pub fn flush(&self) -> Result<(), AuthError> {
        self.write_state(false)
    }

    /// How the state file's writer has done, when the runtime persists.
    #[must_use]
    pub fn persist_stats(&self) -> Option<PersistStats> {
        self.inner.persister.as_ref().map(Persister::stats)
    }

    fn mark_dirty(&self) {
        if let Some(persister) = &self.inner.persister {
            persister.mark_dirty();
        }
    }

    /// Writes the state when it changed (or always, with `force`).
    fn write_state(&self, force: bool) -> Result<(), AuthError> {
        match &self.inner.persister {
            Some(persister) => persister.flush(&self.inner.data, force),
            None => Ok(()),
        }
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
        self.blocking_reported(ctx, event, user, context, oauth)
            .await
            .0
    }

    /// [`Runtime::blocking`], and how the call went when a function was
    /// called (its step is already on the trace).
    pub(crate) async fn blocking_reported(
        &self,
        ctx: &Ctx,
        event: BlockingEvent,
        user: &UserRecord,
        context: &BlockingContext,
        oauth: &OauthTokens,
    ) -> (
        Result<BlockingOutcome, ApiError>,
        Option<blocking::BlockingReport>,
    ) {
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
        let (result, report) = blocking::fetch_blocking_function(
            &self.inner.client,
            target,
            event,
            user,
            context,
            oauth,
            ctx.trace.id(),
        )
        .await;
        if let Some(report) = report.clone().filter(|_| ctx.trace.recording()) {
            let outcome = result.as_ref().ok();
            let updates = outcome.map(|outcome| &outcome.updates);
            ctx.trace.push(Step::Blocking {
                event: event.name(),
                function: observe::function_of(&report.uri),
                uri: report.uri,
                duration: report.duration,
                invocation: report.invocation,
                changed: updates
                    .map(|updates| {
                        updates
                            .keys()
                            .filter(|key| key.as_str() != "customAttributes")
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default(),
                custom_claims: observe::object_keys_of_text(
                    updates.and_then(|updates| str_field(updates, "customAttributes")),
                ),
                session_claims: outcome
                    .and_then(|outcome| outcome.extra_claims.as_ref())
                    .map(|claims| claims.keys().cloned().collect())
                    .unwrap_or_default(),
                failure: report.failure,
            });
        }
        (result, report)
    }

    /// The blocking functions a sign-up and a sign-in of `project` would
    /// call now, resolved as [`Runtime::blocking`] resolves them (the
    /// project's configuration first, then the Functions emulator's
    /// registration), without calling anything or creating the project.
    pub async fn blocking_targets(&self, project: &str) -> BlockingTargets {
        let configured = {
            let data = lock(&self.inner.data);
            data.projects.get(project).map(|agent| {
                (
                    agent.blocking_uri(BlockingEvent::BeforeCreate),
                    agent.blocking_uri(BlockingEvent::BeforeSignIn),
                    [
                        agent.forward_credential("idToken"),
                        agent.forward_credential("accessToken"),
                        agent.forward_credential("refreshToken"),
                    ],
                )
            })
        };
        let (create, sign_in, forward) = configured.unwrap_or((None, None, [false; 3]));
        let resolver = self
            .inner
            .blocking
            .read()
            .ok()
            .and_then(|slot| slot.clone());
        let registered = match (&create, &sign_in, resolver) {
            (Some(_), Some(_), _) | (_, _, None) => None,
            (_, _, Some(resolver)) => Some(resolver.resolve().await),
        };
        let hook = |configured: Option<String>, registered: Option<String>| {
            configured
                .map(|uri| HookTarget {
                    uri,
                    source: HookSource::Config,
                })
                .or_else(|| {
                    registered.map(|uri| HookTarget {
                        uri,
                        source: HookSource::Functions,
                    })
                })
        };
        let any_configured = create.is_some() || sign_in.is_some();
        let forward = match (&registered, any_configured) {
            (Some(functions), false) => [
                functions.forward_id_token,
                functions.forward_access_token,
                functions.forward_refresh_token,
            ],
            _ => forward,
        };
        BlockingTargets {
            before_create: hook(
                create,
                registered
                    .as_ref()
                    .and_then(|functions| functions.before_create.clone()),
            ),
            before_sign_in: hook(
                sign_in,
                registered
                    .as_ref()
                    .and_then(|functions| functions.before_sign_in.clone()),
            ),
            forward_id_token: forward[0],
            forward_access_token: forward[1],
            forward_refresh_token: forward[2],
        }
    }

    fn dispatch_lifecycle(
        &self,
        project_id: &str,
        kind: Lifecycle,
        user: &UserRecord,
    ) -> TriggerOutcome {
        if !self.inner.background.background_enabled() {
            self.inner.background.note_dropped(DroppedService::Auth);
            return TriggerOutcome::DeliveryOff;
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
        // What caused it, for the Functions runtime's record of each
        // invocation the multicast starts.
        let mut headers = BTreeMap::from([
            ("content-type".to_owned(), "application/json".to_owned()),
            (cause::EVENT_ID.to_owned(), cause::encode(&event_id)),
        ]);
        for (header, field) in [
            (cause::UID, "localId"),
            (cause::EMAIL, "email"),
            (cause::TENANT, "tenantId"),
        ] {
            if let Some(value) = str_field(user, field).filter(|value| !value.is_empty()) {
                headers.insert(header.to_owned(), cause::encode(value));
            }
        }
        match self.inner.queue.enqueue(DispatchRequest {
            path: format!("/functions/projects/{project_id}/trigger_multicast"),
            headers,
            body: serde_json::to_vec(&body).expect("JSON serialization cannot fail"),
            event_id,
        }) {
            Ok(()) => TriggerOutcome::Queued,
            Err(error) => TriggerOutcome::Failed(error.to_string()),
        }
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

/// What `route` learned of a call, for its record.
#[derive(Default)]
struct RouteFacts {
    /// The operation id, once the route matched one.
    operation: Option<String>,
    project: Option<String>,
    tenant: Option<String>,
    /// The request body as read.
    request: Bytes,
    query: Vec<(String, String)>,
    description: Description,
}

/// Paths that are not calls: readiness, the API document, the static
/// popup frame.
fn recorded(method: &Method, path: &str) -> bool {
    !(*method == Method::GET
        && matches!(
            path,
            "/" | "/emulator/openapi.json" | "/emulator/auth/iframe"
        ))
}

async fn handle(State(runtime): State<Runtime>, request: Request) -> Response {
    let origin = request.headers().get(header::ORIGIN).cloned();
    let private_network = request
        .headers()
        .contains_key("access-control-request-private-network");
    if request.method() == Method::OPTIONS {
        return preflight(&request, origin.as_ref(), private_network);
    }
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let asked = request.headers().contains_key(observe::CONSOLE_HEADER);
    let console = ConsoleOrigin::of(request.headers());
    let id = runtime.next_call_id();
    let observer = runtime.observer().filter(|_| recorded(&method, &path));
    let trace = Trace::new(id, console, observer.is_some());
    // What the record keeps of the request, read before it is consumed.
    let kept = observer.as_ref().map(|_| {
        let headers = request.headers();
        let query_key = request.uri().query().is_some_and(|query| {
            url::form_urlencoded::parse(query.as_bytes())
                .any(|(name, value)| name == "key" && !value.is_empty())
        });
        (
            observe::caller_of(&path, headers, query_key),
            observe::client_of(headers),
            observe::kept_headers(headers),
        )
    });
    let at_millis = util::now_millis();
    let started = Instant::now();
    let mut facts = RouteFacts::default();
    let mut response = route(&runtime, request, &trace, &mut facts).await;
    let duration = started.elapsed();
    if let (Some((observer, keep)), Some(((caller, credential), client, headers))) =
        (observer, kept)
    {
        // The body was built in memory: collecting it hands back the same
        // buffer, which the record keeps as a handle.
        let (parts, body) = response.into_parts();
        let bytes = to_bytes(body, usize::MAX).await.unwrap_or_default();
        let status = parts.status.as_u16();
        let operation = facts.operation.unwrap_or_default();
        observer.call(CallRecord {
            id,
            at_millis,
            duration,
            project: facts
                .project
                .unwrap_or_else(|| runtime.default_project().to_owned()),
            tenant: facts.tenant,
            caller,
            origin: console,
            credential,
            client,
            method: method.as_str().to_owned(),
            path,
            kind: observe::kind_of(&operation),
            operation,
            identifier: facts.description.identifier,
            provider: facts.description.provider,
            uid: facts.description.uid,
            new_user: facts.description.new_user,
            status,
            error: CallError::of_response(status, &bytes),
            request: RecordedBody::of(&facts.request, keep),
            response: RecordedBody::of(&bytes, keep),
            query: facts.query,
            headers,
            steps: trace.take(),
        });
        response = Response::from_parts(parts, Body::from(bytes));
    }
    if asked && let Ok(value) = HeaderValue::from_str(&id.to_string()) {
        response.headers_mut().insert(ACTIVITY_HEADER, value);
    }
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

async fn route(
    runtime: &Runtime,
    request: Request,
    trace: &Trace,
    facts: &mut RouteFacts,
) -> Response {
    let method = request.method().clone();
    let uri = request.uri().clone();
    let path = uri.path().to_owned();
    let query = uri.query().map(str::to_owned);
    let pairs = query_pairs(query.as_deref());
    let query_map: BTreeMap<String, String> = pairs.iter().cloned().collect();
    if trace.recording() {
        facts.query.clone_from(&pairs);
    }
    let headers = request.headers().clone();
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);

    // Routes registered before the API: readiness, the document, the pages.
    match (method.clone(), path.as_str()) {
        (Method::GET, "/") => return pages::readiness(),
        (Method::GET, "/emulator/openapi.json") => return pages::openapi("http", host.as_deref()),
        (Method::GET, "/emulator/action") => {
            facts.operation = Some(format!(
                "emulator.action.{}",
                query_map.get("mode").map_or("unknown", String::as_str)
            ));
            facts.tenant = query_map
                .get("tenantId")
                .filter(|tenant| !tenant.is_empty())
                .cloned();
            return pages::action(runtime, &pairs, trace);
        }
        (Method::GET, "/emulator/auth/handler") => {
            facts.operation = Some("emulator.accountPicker".to_owned());
            facts.tenant = query_map
                .get("tenantId")
                .or_else(|| query_map.get("tid"))
                .filter(|tenant| !tenant.is_empty())
                .cloned();
            facts.description.provider = query_map.get("providerId").cloned();
            return pages::handler(runtime, &query_map, trace);
        }
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
    if trace.recording() {
        facts.request = body_bytes.clone();
    }

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
    if let Some(operation) = &matched.operation {
        facts.operation = Some(operation.operation_id.clone());
    }
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
        trace: trace.clone(),
    };
    let result = dispatch(runtime, &operation.operation_id, &ctx).await;
    if trace.recording() {
        facts.project = Some(ctx.project_id.clone());
        facts.tenant.clone_from(&ctx.tenant_id);
        facts.description = observe::describe(
            &operation.operation_id,
            &ctx.body,
            &pairs,
            result.as_ref().ok(),
        );
    }
    match result {
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

/// The layout of the state file this engine writes: per project its users,
/// codes, proofs, configuration and tenants.
const STATE_VERSION: u32 = 2;

/// What `load_state` reads first to tell the layouts apart, skipping
/// everything else.
#[derive(serde::Deserialize)]
struct LayoutProbe {
    #[serde(default)]
    version: Option<u64>,
    #[serde(default)]
    projects: BTreeMap<String, AgentProbe>,
}

#[derive(serde::Deserialize)]
struct AgentProbe {
    #[serde(default)]
    tenants: Option<serde::de::IgnoredAny>,
}

fn load_state(path: &FilePath) -> Result<AuthData, AuthError> {
    if !path.is_file() {
        return Ok(AuthData::default());
    }
    let bytes = std::fs::read(path)
        .map_err(|error| AuthError(format!("failed to read Auth state: {error}")))?;
    let probe: LayoutProbe = serde_json::from_slice(&bytes)
        .map_err(|error| AuthError(format!("invalid Auth state JSON: {error}")))?;
    // Engines before this one wrote the current layout with `version: 0`
    // when they started without a state file; every project they wrote
    // carries `tenants`, which the older layout never had.
    let current = probe.version == Some(u64::from(STATE_VERSION))
        || (probe.version.is_none_or(|version| version == 0)
            && !probe.projects.is_empty()
            && probe.projects.values().all(|agent| agent.tenants.is_some()));
    if current {
        return serde_json::from_slice(&bytes)
            .map_err(|error| AuthError(format!("invalid Auth state: {error}")));
    }
    let value: JsonValue = serde_json::from_slice(&bytes)
        .map_err(|error| AuthError(format!("invalid Auth state JSON: {error}")))?;
    // The next.7 layout: `projects.<id>.{users, config}` with a flat config.
    let mut data = AuthData::default();
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
                agent
                    .project
                    .users
                    .insert(local_id.clone(), Arc::new(record.clone()));
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
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| AuthError(format!("failed to serialize Auth state: {error}")))?;
    write_atomic_bytes(path, &bytes)
}

fn write_atomic_bytes(path: &FilePath, bytes: &[u8]) -> Result<(), AuthError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            AuthError(format!("failed to create Auth state directory: {error}"))
        })?;
    }
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, bytes)
        .map_err(|error| AuthError(format!("failed to write Auth state: {error}")))?;
    std::fs::rename(&temporary, path)
        .map_err(|error| AuthError(format!("failed to publish Auth state: {error}")))?;
    Ok(())
}

impl Drop for Inner {
    /// The last handle is gone: stop the writer and write what is left.
    fn drop(&mut self) {
        if let Some(persister) = &self.persister {
            persister.stop(&self.data);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests;
