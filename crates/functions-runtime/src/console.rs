//! What the console may ask of the running runtime: its functions with their
//! trigger keys and runtime status, a codebase's environment and secrets,
//! env edits that reload and put files back when the load fails, calls and
//! replays recorded like any other, reloads and worker restarts, the one
//! matcher behind "which functions fire here", Eventarc's channels and
//! publishing, and swapping an Extension instance's backend.
//!
//! Plain Rust: the console maps these views to its own types. Everything
//! is read on request from the runtime's state; nothing here is cached.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{HeaderName, HeaderValue, Method};
use firenook_functions_bridge::{ChangeShape, MatchReason, explain_match};
use futures_util::StreamExt as _;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::env_files::KeyChange;
use crate::manifest::{DeclaredParam, Definition};
use crate::monitor::{
    EventarcOrigin, FunctionHeader, FunctionKind, InvocationOrigin, InvocationSummary,
    InvocationTarget, InvocationToken, Monitor, SENSITIVE_HEADERS,
};
use crate::registry::Record;
use crate::server::{self, DispatchContext, PublishError};
use crate::{ExtensionBackend, FunctionsRuntime, RuntimeState};

/// What the console may ask of the running runtime. Cheap to clone.
#[derive(Clone)]
pub struct ConsoleHandle {
    state: Arc<RuntimeState>,
}

impl FunctionsRuntime {
    /// The console's handle; installed into the console once `start` returns.
    #[must_use]
    pub fn console(&self) -> ConsoleHandle {
        ConsoleHandle {
            state: Arc::clone(&self.state),
        }
    }
}

impl std::fmt::Debug for ConsoleHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ConsoleHandle")
    }
}

/// Why the runtime refused a console request; the console maps each to its
/// error codes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConsoleError {
    NotFound(String),
    Invalid(String),
    Conflict {
        message: String,
        detail: Option<String>,
    },
    Unavailable(String),
}

impl std::fmt::Display for ConsoleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(message) | Self::Invalid(message) | Self::Unavailable(message) => {
                formatter.write_str(message)
            }
            Self::Conflict { message, detail } => match detail {
                Some(detail) => write!(formatter, "{message} {detail}"),
                None => formatter.write_str(message),
            },
        }
    }
}

impl std::error::Error for ConsoleError {}

/// Whether a function receives its events, and if not, why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeStatus {
    Receiving,
    /// The emulator does not deliver this function's events.
    Ignored(String),
    /// Background triggers are paused.
    Paused,
    /// A reload removed it; its record is kept like the official emulator's.
    Removed,
}

/// One registration of a function.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriggerKeyView {
    pub key: String,
    /// The generation an event trigger's key carries.
    pub generation: Option<u32>,
    pub enabled: bool,
    pub stale: bool,
}

/// A secret a function declares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretView {
    pub key: String,
    pub secret: String,
    /// The key has a value in `.secret.local` (or the instance's secrets).
    pub provided: bool,
}

/// A param the codebase's manifest declares, with what resolves it.
#[derive(Debug, Clone, PartialEq)]
pub struct ParamView {
    pub name: String,
    pub param_type: String,
    pub default: Option<Value>,
    pub label: Option<String>,
    pub description: Option<String>,
    /// The value the codebase loaded with: an env file's, or the param's
    /// default when no file sets it. `None` for a secret param (reveal it
    /// through [`ConsoleHandle::secret`]).
    pub value: Option<String>,
    pub secret: bool,
    /// The file the value comes from.
    pub file: Option<String>,
    /// No env file sets it: the official emulator would prompt (with the
    /// default, if any, filled in) and write `.env.local`.
    pub unresolved: bool,
}

/// How an Auth blocking function is wired.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockingView {
    /// `beforeCreate` or `beforeSignIn`.
    pub event: String,
    /// This function is the one the Auth emulator calls for the event.
    pub wired: bool,
    pub forward: ForwardedTokens,
}

/// The sign-in tokens the Auth emulator forwards to a blocking function.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ForwardedTokens {
    pub id_token: bool,
    pub access_token: bool,
    pub refresh_token: bool,
}

/// One function, all its registrations grouped (the current one first).
#[derive(Debug, Clone, PartialEq)]
pub struct FunctionView {
    pub id: String,
    pub name: String,
    pub entry_point: String,
    pub region: String,
    pub platform: String,
    pub codebase: String,
    pub extension_instance: Option<String>,
    pub kind: FunctionKind,
    /// The service its events come from (`firestore.googleapis.com`), or
    /// `https`, `cloudtasks.googleapis.com`, a blocking event type.
    pub service: String,
    /// The definition exactly as `/backends` serves it.
    pub definition: Value,
    pub keys: Vec<TriggerKeyView>,
    pub status: RuntimeStatus,
    /// `/{project}/{region}/{name}`: only functions the URL route reaches
    /// (HTTP, callable, task queue and blocking definitions).
    pub path: Option<String>,
    pub timeout_seconds: u64,
    pub secrets: Vec<SecretView>,
    /// The codebase's declared params (shared by its functions).
    pub params: Vec<ParamView>,
    /// Options the definition declares that the emulator does not apply.
    pub declared: Vec<(String, Value)>,
    pub blocking: Option<BlockingView>,
}

/// Where an environment variable comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvSource {
    DotEnv,
    SecretLocal,
    /// A param no env file sets: its default, as the worker gets it.
    ParamDefault,
    /// Set by the emulator for every worker.
    Emulator,
    /// An Extension instance's parameter.
    ExtensionParam,
}

/// A file a codebase's variable can be written to. Never a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum EnvFile {
    /// `.env`
    Env,
    /// `.env.<projectId>`
    EnvProject,
    /// `.env.<alias>`
    EnvAlias,
    /// `.env.local`
    EnvLocal,
    /// `.secret.local` in the source directory.
    SecretLocal,
}

/// One variable a codebase's worker sees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvVariableView {
    pub key: String,
    /// `None` for a secret.
    pub value: Option<String>,
    pub secret: bool,
    pub source: EnvSource,
    pub file: Option<EnvFile>,
    pub file_name: Option<String>,
}

/// A codebase's environment as its worker sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvironmentView {
    pub codebase: String,
    /// The dotenv files read, in precedence order.
    pub files: Vec<String>,
    pub variables: Vec<EnvVariableView>,
    /// Variables the worker inherits from the engine's own environment;
    /// only counted, their values never leave the engine.
    pub inherited: u32,
    /// A user codebase (an Extension instance edits in Extensions).
    pub editable: bool,
}

/// One env file change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvChange {
    pub file: EnvFile,
    pub key: String,
    /// `None` removes the key from the file.
    pub value: Option<String>,
}

/// Where a console call goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchTarget {
    /// The function's own address, with this method and path after it.
    Url {
        method: String,
        path_and_query: String,
    },
    /// The runtime's trigger route.
    Trigger,
}

/// A call the console makes (or replays).
#[derive(Debug, Clone)]
pub struct DispatchInput {
    pub target: DispatchTarget,
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
    pub origin: InvocationOrigin,
    pub replay_of: Option<String>,
}

/// The invocation at once, then its answer as it streams.
#[derive(Debug)]
pub struct DispatchStream {
    pub invocation: InvocationSummary,
    /// The head, the body chunks and the final summary.
    pub frames: mpsc::Receiver<DispatchFrame>,
}

/// One step of a console call's answer.
#[derive(Debug, Clone, PartialEq)]
pub enum DispatchFrame {
    Head {
        status: u16,
        headers: Vec<FunctionHeader>,
    },
    Chunk(Bytes),
    Finished(Box<InvocationSummary>),
}

/// The services "which functions fire here" knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerService {
    Firestore,
    Auth,
    Storage,
    Pubsub,
    Eventarc,
    Tasks,
}

/// A Firestore change, without its documents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirestoreChange {
    Created,
    Updated,
    Deleted,
}

/// A Cloud Storage object event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageEvent {
    Finalized,
    Deleted,
    MetadataUpdated,
    Archived,
}

/// An Auth event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthEvent {
    Create,
    Delete,
    BeforeCreate,
    BeforeSignIn,
}

/// "Which functions fire here?": a resource in its service's format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TriggersQuery {
    /// `<db>|<path>`, optionally one change.
    Firestore {
        database: String,
        path: String,
        change: Option<FirestoreChange>,
    },
    /// `<bucket>|<name>`, optionally one event.
    Storage {
        bucket: String,
        name: String,
        event: Option<StorageEvent>,
    },
    /// `<tenant>` (empty for the project), optionally one event.
    Auth {
        tenant: Option<String>,
        event: Option<AuthEvent>,
    },
    /// A topic's full resource name.
    Pubsub { topic: String },
    /// `<channel>|<type>`.
    Eventarc { channel: String, event_type: String },
    /// A Cloud Tasks queue key.
    Tasks { queue: String },
}

impl TriggersQuery {
    /// Reads a query in the console's resource formats; the error names the
    /// part that is wrong.
    pub fn parse(service: &str, resource: &str, event: Option<&str>) -> Result<Self, String> {
        let event = event.filter(|event| !event.is_empty());
        let split = |what: &str| {
            resource
                .split_once('|')
                .filter(|(left, right)| !left.is_empty() && !right.is_empty())
                .map(|(left, right)| (left.to_owned(), right.to_owned()))
                .ok_or_else(|| format!("The resource must be {what}."))
        };
        let refuse_event = |event: Option<&str>| match event {
            Some(event) => Err(format!("{service} has no event \"{event}\".")),
            None => Ok(()),
        };
        match service {
            "firestore" => {
                let (database, path) = split("<database>|<document path>")?;
                let change = event
                    .map(|event| match event {
                        "created" | "create" => Ok(FirestoreChange::Created),
                        "updated" | "update" => Ok(FirestoreChange::Updated),
                        "deleted" | "delete" => Ok(FirestoreChange::Deleted),
                        other => Err(format!(
                            "The change must be created, updated or deleted, not \"{other}\"."
                        )),
                    })
                    .transpose()?;
                Ok(Self::Firestore {
                    database,
                    path: path.trim_matches('/').to_owned(),
                    change,
                })
            }
            "storage" => {
                let (bucket, name) = split("<bucket>|<object name>")?;
                let event = event.map(parse_storage_event).transpose()?;
                Ok(Self::Storage {
                    bucket,
                    name,
                    event,
                })
            }
            "auth" => {
                let event = event.map(parse_auth_event).transpose()?;
                Ok(Self::Auth {
                    tenant: (!resource.is_empty()).then(|| resource.to_owned()),
                    event,
                })
            }
            "pubsub" => {
                refuse_event(event)?;
                if !resource.starts_with("projects/") || !resource.contains("/topics/") {
                    return Err("The resource must be a topic's full name, projects/<project>/topics/<topic>.".to_owned());
                }
                Ok(Self::Pubsub {
                    topic: resource.to_owned(),
                })
            }
            "eventarc" => {
                refuse_event(event)?;
                let (channel, event_type) = split("<channel>|<event type>")?;
                Ok(Self::Eventarc {
                    channel,
                    event_type,
                })
            }
            "tasks" => {
                refuse_event(event)?;
                if !resource.starts_with("queue:") {
                    return Err(
                        "The resource must be a queue key, queue:<project>-<location>-<queue>."
                            .to_owned(),
                    );
                }
                Ok(Self::Tasks {
                    queue: resource.to_owned(),
                })
            }
            other => Err(format!(
                "Unknown service \"{other}\": use firestore, auth, storage, pubsub, eventarc or tasks."
            )),
        }
    }

    fn service(&self) -> TriggerService {
        match self {
            Self::Firestore { .. } => TriggerService::Firestore,
            Self::Storage { .. } => TriggerService::Storage,
            Self::Auth { .. } => TriggerService::Auth,
            Self::Pubsub { .. } => TriggerService::Pubsub,
            Self::Eventarc { .. } => TriggerService::Eventarc,
            Self::Tasks { .. } => TriggerService::Tasks,
        }
    }
}

fn parse_storage_event(event: &str) -> Result<StorageEvent, String> {
    match event {
        "finalized" | "finalize" => Ok(StorageEvent::Finalized),
        "deleted" | "delete" => Ok(StorageEvent::Deleted),
        "metadataUpdated" | "metadataUpdate" => Ok(StorageEvent::MetadataUpdated),
        "archived" | "archive" => Ok(StorageEvent::Archived),
        other => Err(format!(
            "The event must be finalized, deleted, metadataUpdated or archived, not \"{other}\"."
        )),
    }
}

fn parse_auth_event(event: &str) -> Result<AuthEvent, String> {
    // `user.create` and `user.delete` are the official event types' own
    // names (`providers/firebase.auth/eventTypes/user.create`), which the
    // Authentication pages ask by.
    match event {
        "create" | "created" | "user.create" => Ok(AuthEvent::Create),
        "delete" | "deleted" | "user.delete" => Ok(AuthEvent::Delete),
        "beforeCreate" => Ok(AuthEvent::BeforeCreate),
        "beforeSignIn" => Ok(AuthEvent::BeforeSignIn),
        other => Err(format!(
            "The event must be create (user.create), delete (user.delete), beforeCreate or beforeSignIn, not \"{other}\"."
        )),
    }
}

/// A function that fires for a resource.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListenerView {
    pub function_id: String,
    pub codebase: String,
    pub event_type: String,
    pub kind: FunctionKind,
}

/// "Which functions fire here, and why not?"
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MatchInput {
    Firestore {
        database: String,
        path: String,
        changes: Vec<FirestoreChange>,
    },
    Storage {
        bucket: String,
        events: Vec<StorageEvent>,
    },
    Auth {
        tenant: Option<String>,
        events: Vec<AuthEvent>,
    },
    Pubsub {
        topic: String,
    },
    Eventarc {
        channel: String,
        event_type: String,
        attributes: BTreeMap<String, String>,
    },
    Tasks {
        queue: String,
    },
}

/// Whether one function fires, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchView {
    pub function_id: String,
    /// The change or event this row is about, for a request with several.
    pub change: Option<String>,
    pub fires: bool,
    /// In words: "matches orders/{orderId}", "listens on (default), not other".
    pub reason: String,
}

/// An Eventarc subscription.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscriptionView {
    pub trigger_key: String,
    pub function_id: Option<String>,
    pub event_type: String,
    pub filters: BTreeMap<String, String>,
    /// Registered through the Eventarc emulator route rather than by a
    /// function definition.
    pub registered: bool,
    pub status: Option<RuntimeStatus>,
}

/// An Extension instance that publishes on a channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublisherView {
    pub instance_id: String,
    /// The `CloudEvent` source it publishes with.
    pub source: String,
    /// The event types it may publish (`ALLOWED_EVENT_TYPES`).
    pub allowed: Vec<String>,
}

/// A channel: who publishes on it and who listens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelView {
    /// The full channel name, or `google` for the native channel.
    pub name: String,
    pub publishers: Vec<PublisherView>,
    pub subscriptions: Vec<SubscriptionView>,
}

/// Every channel the runtime knows of, the native channel included.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventarcView {
    pub channels: Vec<ChannelView>,
}

const RESTART_REASON: &str = "the worker was restarted";

impl ConsoleHandle {
    #[must_use]
    pub fn project(&self) -> &str {
        &self.state.config.project_id
    }

    /// The suite runs with `--inspect-functions` (timeouts are off).
    #[must_use]
    pub fn debugging(&self) -> bool {
        self.state.debug_mode
    }

    /// The record this runtime feeds.
    #[must_use]
    pub fn monitor(&self) -> &Monitor {
        &self.state.monitor
    }

    /// Whether background triggers deliver.
    #[must_use]
    pub fn background_enabled(&self) -> bool {
        self.state.triggers.background_enabled()
    }

    /// One view per function id, grouping its trigger keys (current first).
    pub async fn functions(&self) -> Vec<FunctionView> {
        let groups = self.groups().await;
        let mut views = Vec::with_capacity(groups.len());
        for records in groups {
            views.push(self.view(&records).await);
        }
        views
    }

    /// One function.
    pub async fn function(&self, id: &str) -> Option<FunctionView> {
        let records: Vec<Record> = {
            let registry = self.state.registry.read().await;
            registry
                .records()
                .iter()
                .filter(|record| record.definition.id() == id)
                .cloned()
                .collect()
        };
        if records.is_empty() {
            return None;
        }
        Some(self.view(&order_records(records)).await)
    }

    /// Every function's records, grouped by id in registration order, each
    /// group current first.
    async fn groups(&self) -> Vec<Vec<Record>> {
        let registry = self.state.registry.read().await;
        let mut order: Vec<String> = Vec::new();
        let mut grouped: BTreeMap<String, Vec<Record>> = BTreeMap::new();
        for record in registry.records() {
            let id = record.definition.id();
            if !grouped.contains_key(&id) {
                order.push(id.clone());
            }
            grouped.entry(id).or_default().push(record.clone());
        }
        drop(registry);
        order
            .into_iter()
            .filter_map(|id| grouped.remove(&id))
            .map(order_records)
            .collect()
    }

    async fn view(&self, records: &[Record]) -> FunctionView {
        let current = &records[0];
        let definition = &current.definition;
        let id = definition.id();
        let backend = self
            .state
            .backends
            .iter()
            .find(|backend| backend.id == current.codebase);
        let (secrets_provided, params, declared) = match backend {
            Some(backend) => {
                let loaded = backend.loaded.read().await;
                let extension_secrets = backend
                    .read_source()
                    .extension
                    .as_ref()
                    .map(|extension| extension.secret_values.keys().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                let provided: Vec<String> = loaded
                    .secrets
                    .keys()
                    .cloned()
                    .chain(extension_secrets)
                    .collect();
                let params = loaded
                    .params
                    .iter()
                    .map(|param| {
                        param_view(
                            param,
                            &loaded.user_env,
                            &loaded.param_defaults,
                            &loaded.env_sources,
                            &loaded.secrets,
                        )
                    })
                    .collect();
                let declared = loaded
                    .declared
                    .get(&id)
                    .map(|options| {
                        options
                            .iter()
                            .map(|(name, value)| (name.clone(), value.clone()))
                            .collect()
                    })
                    .unwrap_or_default();
                (provided, params, declared)
            }
            None => (Vec::new(), Vec::new(), Vec::new()),
        };
        let blocking = definition.blocking_trigger().map(|trigger| {
            let event_type = trigger
                .get("eventType")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let options = trigger.get("options");
            let flag = |name: &str| {
                options
                    .and_then(|options| options.get(name))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            };
            (
                event_type.to_owned(),
                flag("idToken"),
                flag("accessToken"),
                flag("refreshToken"),
            )
        });
        let blocking = match blocking {
            Some((event_type, id_token, access_token, refresh_token)) => {
                let registry = self.state.registry.read().await;
                let config = registry.blocking();
                let event = event_type.rsplit('.').next().unwrap_or_default().to_owned();
                let wired = match event.as_str() {
                    "beforeCreate" => {
                        config.before_create.is_some() && config.before_create == current.url
                    }
                    "beforeSignIn" => {
                        config.before_sign_in.is_some() && config.before_sign_in == current.url
                    }
                    _ => false,
                };
                Some(BlockingView {
                    event,
                    wired,
                    forward: ForwardedTokens {
                        id_token,
                        access_token,
                        refresh_token,
                    },
                })
            }
            None => None,
        };
        let reachable =
            definition.https_trigger().is_some() || definition.blocking_trigger().is_some();
        FunctionView {
            id: id.clone(),
            name: definition.name().to_owned(),
            entry_point: definition.entry_point().to_owned(),
            region: definition.region().to_owned(),
            platform: definition.platform().to_owned(),
            codebase: current.codebase.clone(),
            extension_instance: current.extension_instance.clone(),
            kind: FunctionKind::of(definition),
            service: definition.service(),
            definition: Value::Object(definition.json().clone()),
            keys: records
                .iter()
                .map(|record| TriggerKeyView {
                    key: record.key.clone(),
                    generation: generation_of(&record.key, &id),
                    enabled: record.enabled,
                    stale: record.stale,
                })
                .collect(),
            status: status_of(current),
            path: reachable.then(|| {
                format!(
                    "/{}/{}/{}",
                    self.state.config.project_id,
                    definition.region(),
                    definition.name()
                )
            }),
            timeout_seconds: definition.timeout_seconds(),
            secrets: definition
                .secret_environment_variables()
                .into_iter()
                .map(|(key, secret)| SecretView {
                    provided: secrets_provided.contains(&key),
                    key,
                    secret,
                })
                .collect(),
            params,
            declared,
            blocking,
        }
    }

    /// A codebase's environment; `None` for an unknown codebase.
    pub async fn environment(&self, codebase: &str) -> Option<EnvironmentView> {
        let backend = self.state.backend(codebase)?;
        let loaded = backend.loaded.read().await;
        let mut variables = Vec::new();
        for (key, value) in &loaded.user_env {
            let file_name = loaded.env_sources.get(key).cloned();
            variables.push(EnvVariableView {
                key: key.clone(),
                value: Some(value.clone()),
                secret: false,
                source: EnvSource::DotEnv,
                file: file_name.as_deref().map(|name| self.env_file_of(name)),
                file_name,
            });
        }
        for (key, value) in &loaded.param_env {
            if loaded.user_env.contains_key(key) {
                continue;
            }
            variables.push(EnvVariableView {
                key: key.clone(),
                value: Some(value.clone()),
                secret: false,
                source: EnvSource::ParamDefault,
                file: None,
                file_name: None,
            });
        }
        for key in loaded.secrets.keys() {
            variables.push(EnvVariableView {
                key: key.clone(),
                value: None,
                secret: true,
                source: EnvSource::SecretLocal,
                file: Some(EnvFile::SecretLocal),
                file_name: Some(".secret.local".to_owned()),
            });
        }
        let mut emulator = self.state.system_envs();
        emulator.extend(self.state.emulator_envs());
        emulator.insert("FIREBASE_CONFIG".to_owned(), self.state.firebase_config());
        for (key, value) in emulator {
            variables.push(EnvVariableView {
                key,
                value: Some(value),
                secret: false,
                source: EnvSource::Emulator,
                file: None,
                file_name: None,
            });
        }
        if let Some(extension) = &backend.read_source().extension {
            for (key, value) in &extension.env {
                variables.push(EnvVariableView {
                    key: key.clone(),
                    value: Some(value.clone()),
                    secret: false,
                    source: EnvSource::ExtensionParam,
                    file: None,
                    file_name: None,
                });
            }
            for key in extension.secret_values.keys() {
                variables.push(EnvVariableView {
                    key: key.clone(),
                    value: None,
                    secret: true,
                    source: EnvSource::ExtensionParam,
                    file: None,
                    file_name: None,
                });
            }
        }
        Some(EnvironmentView {
            codebase: codebase.to_owned(),
            files: loaded.env_files.clone(),
            variables,
            inherited: u32::try_from(inherited_variables().count()).unwrap_or(u32::MAX),
            editable: !backend.is_extension(),
        })
    }

    fn env_file_of(&self, name: &str) -> EnvFile {
        let config = &self.state.config;
        if name == ".env" {
            EnvFile::Env
        } else if name == ".env.local" {
            EnvFile::EnvLocal
        } else if name == ".secret.local" {
            EnvFile::SecretLocal
        } else if name == format!(".env.{}", config.project_id) {
            EnvFile::EnvProject
        } else {
            EnvFile::EnvAlias
        }
    }

    /// A secret's value, read from the file now: a user codebase's
    /// `.secret.local`, or an Extension instance's secrets.
    pub async fn secret(&self, codebase: &str, key: &str) -> Option<String> {
        let backend = self.state.backend(codebase)?;
        if let Some(extension) = &backend.read_source().extension {
            return extension.secret_values.get(key).cloned();
        }
        let path = backend.directory().join(".secret.local");
        let text = tokio::fs::read_to_string(path).await.ok()?;
        crate::dotenv::parse(&text).envs.get(key).cloned()
    }

    /// Writes dotenv and `.secret.local` changes for a user codebase,
    /// reloads it, and puts every file it wrote back when the reload fails.
    /// Returns the files written.
    pub async fn edit_env(
        &self,
        codebase: &str,
        changes: Vec<EnvChange>,
    ) -> Result<Vec<String>, ConsoleError> {
        let backend = self
            .state
            .backend(codebase)
            .ok_or_else(|| ConsoleError::NotFound(format!("There is no codebase {codebase}.")))?;
        if backend.is_extension() {
            return Err(ConsoleError::Invalid(
                "Change an extension's parameters in Extensions.".to_owned(),
            ));
        }
        if changes.is_empty() {
            return Err(ConsoleError::Invalid(
                "There is nothing to change.".to_owned(),
            ));
        }
        for change in &changes {
            crate::dotenv::validate_key(&change.key)
                .map_err(|error| ConsoleError::Invalid(error.0))?;
        }
        let _edit = backend.edit.lock().await;
        let config_dir = backend.config_dir();
        let directory = backend.directory();
        let mut by_file: BTreeMap<EnvFile, Vec<KeyChange>> = BTreeMap::new();
        for change in changes {
            by_file.entry(change.file).or_default().push(KeyChange {
                key: change.key,
                value: change.value,
            });
        }
        let mut writes = Vec::with_capacity(by_file.len());
        let mut names = Vec::with_capacity(by_file.len());
        for (file, changes) in by_file {
            let name = self.env_file_name(file)?;
            let path = if file == EnvFile::SecretLocal {
                directory.join(&name)
            } else {
                config_dir.join(&name)
            };
            let text = match tokio::fs::read_to_string(&path).await {
                Ok(text) => text,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(error) => {
                    return Err(ConsoleError::Conflict {
                        message: format!("{name} could not be read."),
                        detail: Some(error.to_string()),
                    });
                }
            };
            writes.push((path, crate::env_files::edit_env_file(&text, &changes)));
            names.push(name);
        }
        let written =
            tokio::task::spawn_blocking(move || crate::env_files::write_files_atomically(writes))
                .await
                .map_err(|error| ConsoleError::Unavailable(error.to_string()))?
                .map_err(|error| ConsoleError::Conflict {
                    message: "The env files could not be written.".to_owned(),
                    detail: Some(error.to_string()),
                })?;
        backend.note_self_writes(
            written
                .hashes()
                .into_iter()
                .map(|(path, hash)| (path, Some(hash))),
        );
        if let Err(error) = self.state.load_backend(&backend, false).await {
            let restored = written.restore();
            if let Ok(restored) = &restored {
                backend.note_self_writes(restored.iter().cloned());
            }
            // The previous files serve again: reload them so the codebase
            // reads as it did before the change.
            let _ = self.state.load_backend(&backend, false).await;
            self.state.updates.send_modify(|counter| *counter += 1);
            return Err(ConsoleError::Conflict {
                message: format!(
                    "{codebase} did not load with this change, so your files were put back."
                ),
                detail: Some(match restored {
                    Ok(_) => error,
                    Err(restore) => format!("{error} (putting the files back failed: {restore})"),
                }),
            });
        }
        self.state.updates.send_modify(|counter| *counter += 1);
        Ok(names)
    }

    fn env_file_name(&self, file: EnvFile) -> Result<String, ConsoleError> {
        let config = &self.state.config;
        Ok(match file {
            EnvFile::Env => ".env".to_owned(),
            EnvFile::EnvProject => format!(".env.{}", config.project_id),
            EnvFile::EnvAlias => match &config.project_alias {
                Some(alias) => format!(".env.{alias}"),
                None => {
                    return Err(ConsoleError::Invalid(
                        "This project has no alias in .firebaserc, so there is no .env.<alias> file.".to_owned(),
                    ));
                }
            },
            EnvFile::EnvLocal => ".env.local".to_owned(),
            EnvFile::SecretLocal => ".secret.local".to_owned(),
        })
    }

    /// Runs a call on its own task and streams what came back. The task
    /// reads the answer to its end, so the invocation is recorded and
    /// finishes even when the stream is dropped.
    pub async fn dispatch(
        &self,
        function_id: &str,
        input: DispatchInput,
    ) -> Result<DispatchStream, ConsoleError> {
        let (key, definition) = {
            let registry = self.state.registry.read().await;
            let records: Vec<Record> = registry
                .records()
                .iter()
                .filter(|record| record.definition.id() == function_id)
                .cloned()
                .collect();
            let current = order_records(records).into_iter().next().ok_or_else(|| {
                ConsoleError::NotFound(format!("There is no function {function_id}."))
            })?;
            (current.key, current.definition)
        };
        let (uri, path, method, target) = match &input.target {
            DispatchTarget::Url {
                method,
                path_and_query,
            } => {
                if definition.https_trigger().is_none() && definition.blocking_trigger().is_none() {
                    return Err(ConsoleError::Invalid(format!(
                        "{function_id} has no address; send it an event instead."
                    )));
                }
                let rest = if path_and_query.is_empty() || path_and_query.starts_with(['/', '?']) {
                    path_and_query.clone()
                } else {
                    format!("/{path_and_query}")
                };
                let uri = format!(
                    "/{}/{}/{}{rest}",
                    self.state.config.project_id,
                    definition.region(),
                    definition.name()
                );
                let parsed: axum::http::Uri = uri.parse().map_err(|_| {
                    ConsoleError::Invalid(format!("\"{path_and_query}\" is not a path."))
                })?;
                let path =
                    server::rewrite_path(&parsed, &self.state.config.project_id, definition.name());
                let method = Method::from_bytes(method.as_bytes()).map_err(|_| {
                    ConsoleError::Invalid(format!("\"{method}\" is not an HTTP method."))
                })?;
                (uri, path, method, InvocationTarget::Url)
            }
            DispatchTarget::Trigger => (
                format!(
                    "/functions/projects/{}/triggers/{key}",
                    self.state.config.project_id
                ),
                "/".to_owned(),
                Method::POST,
                InvocationTarget::Trigger,
            ),
        };
        let mut builder = Request::builder().method(method).uri(&uri);
        for (name, value) in &input.headers {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| ConsoleError::Invalid(format!("\"{name}\" is not a header name.")))?;
            let value = HeaderValue::from_str(value).map_err(|_| {
                ConsoleError::Invalid(format!("The value of {name} is not a header value."))
            })?;
            builder = builder.header(name, value);
        }
        let request = builder
            .body(Body::from(input.body))
            .map_err(|error| ConsoleError::Invalid(error.to_string()))?;
        let (started, begun) = oneshot::channel();
        let (frames, receiver) = mpsc::channel(64);
        let state = Arc::clone(&self.state);
        let monitor = self.state.monitor.clone();
        let context = DispatchContext {
            origin: input.origin,
            target,
            replay_of: input.replay_of,
            delivery: None,
            started: Some(started),
        };
        tokio::spawn(async move {
            let response = server::dispatch(state, &key, request, path, context).await;
            let token = response.extensions().get::<InvocationToken>().cloned();
            let head = DispatchFrame::Head {
                status: response.status().as_u16(),
                headers: response
                    .headers()
                    .iter()
                    .filter(|(name, _)| !name.as_str().starts_with("x-firenook-"))
                    .map(|(name, value)| {
                        let sensitive = SENSITIVE_HEADERS.contains(&name.as_str());
                        FunctionHeader {
                            name: name.as_str().to_owned(),
                            value: (!sensitive)
                                .then(|| String::from_utf8_lossy(value.as_bytes()).into_owned()),
                            sensitive,
                        }
                    })
                    .collect(),
            };
            let mut listening = frames.send(head).await.is_ok();
            let mut body = response.into_body().into_data_stream();
            while let Some(chunk) = body.next().await {
                let Ok(bytes) = chunk else {
                    break;
                };
                if listening {
                    listening = frames.send(DispatchFrame::Chunk(bytes)).await.is_ok();
                }
            }
            if listening && let Some(summary) = token.and_then(|token| monitor.summary(token.seq)) {
                let _ = frames
                    .send(DispatchFrame::Finished(Box::new(summary)))
                    .await;
            }
        });
        let invocation = begun
            .await
            .map_err(|_| ConsoleError::NotFound(format!("There is no function {function_id}.")))?;
        Ok(DispatchStream {
            invocation,
            frames: receiver,
        })
    }

    /// Calls a recorded invocation's function again with the request it
    /// received, every header included (read here, never sent to the
    /// browser).
    pub async fn replay(&self, invocation_id: &str) -> Result<DispatchStream, ConsoleError> {
        let monitor = &self.state.monitor;
        let summary = monitor
            .seq_of(invocation_id)
            .and_then(|seq| monitor.summary(seq))
            .ok_or_else(|| {
                ConsoleError::NotFound(format!(
                    "The engine no longer keeps invocation {invocation_id}; it keeps the newest {}.",
                    monitor.limits().invocations
                ))
            })?;
        let detail = monitor.invocation(invocation_id);
        if let Some(reason) = detail
            .as_ref()
            .and_then(|detail| detail.not_replayable.clone())
        {
            return Err(ConsoleError::Conflict {
                message: reason,
                detail: None,
            });
        }
        let recorded =
            monitor
                .recorded_request(invocation_id)
                .ok_or_else(|| ConsoleError::Conflict {
                    message: "Only the invocation's summary was kept, so it cannot be replayed."
                        .to_owned(),
                    detail: None,
                })?;
        if self
            .function(&summary.function_id)
            .await
            .is_none_or(|view| view.status == RuntimeStatus::Removed)
        {
            return Err(ConsoleError::Conflict {
                message: format!(
                    "{} is no longer loaded, so it cannot be replayed.",
                    summary.function_id
                ),
                detail: None,
            });
        }
        let headers = recorded
            .headers
            .iter()
            .filter(|(name, _)| {
                !matches!(
                    name.as_str(),
                    "host"
                        | "content-length"
                        | "connection"
                        | "transfer-encoding"
                        | "x-firenook-console"
                )
            })
            .map(|(name, value)| {
                (
                    name.as_str().to_owned(),
                    String::from_utf8_lossy(value.as_bytes()).into_owned(),
                )
            })
            .collect();
        let target = match recorded.target {
            InvocationTarget::Url => DispatchTarget::Url {
                method: recorded.method,
                path_and_query: recorded.path,
            },
            InvocationTarget::Trigger => DispatchTarget::Trigger,
        };
        self.dispatch(
            &recorded.function_id,
            DispatchInput {
                target,
                headers,
                body: recorded.body,
                origin: InvocationOrigin::Replay,
                replay_of: Some(invocation_id.to_owned()),
            },
        )
        .await
    }

    /// Reloads a user codebase, as a save would.
    pub async fn reload(&self, codebase: &str) -> Result<(), ConsoleError> {
        let backend = self
            .state
            .backend(codebase)
            .ok_or_else(|| ConsoleError::NotFound(format!("There is no codebase {codebase}.")))?;
        if backend.is_extension() {
            return Err(ConsoleError::Conflict {
                message: "Reload an extension instance in Extensions.".to_owned(),
                detail: None,
            });
        }
        let _edit = backend.edit.lock().await;
        self.state.reload_backend(codebase).await;
        Ok(())
    }

    /// Stops a codebase's worker and starts it again. Calls in flight finish
    /// `crashed` with "the worker was restarted"; returns how many there were.
    pub async fn restart_worker(&self, codebase: &str) -> Result<u32, ConsoleError> {
        let backend = self
            .state
            .backend(codebase)
            .ok_or_else(|| ConsoleError::NotFound(format!("There is no codebase {codebase}.")))?;
        let interrupted = self.state.monitor.interrupt(codebase, RESTART_REASON);
        backend.slot.stop().await;
        backend
            .slot
            .warm(crate::WORKER_READY_TIMEOUT)
            .await
            .map_err(|error| ConsoleError::Conflict {
                message: format!("The worker of {codebase} did not start again."),
                detail: Some(error.0),
            })?;
        Ok(interrupted)
    }

    /// The functions that fire for a resource (one matcher with
    /// [`ConsoleHandle::match_triggers`]).
    pub async fn triggers(&self, query: &TriggersQuery) -> Vec<ListenerView> {
        let firestore = self.firestore_triggers(query.service());
        let registry = self.state.registry.read().await;
        let blocking = registry.blocking().clone();
        let mut listeners = Vec::new();
        for record in registry.records() {
            if record.stale {
                continue;
            }
            let verdicts = match query {
                TriggersQuery::Firestore {
                    database,
                    path,
                    change,
                } => {
                    let changes = change.map_or_else(
                        || {
                            vec![
                                FirestoreChange::Created,
                                FirestoreChange::Updated,
                                FirestoreChange::Deleted,
                            ]
                        },
                        |change| vec![change],
                    );
                    changes
                        .into_iter()
                        .filter_map(|change| {
                            firestore_verdict(record, &firestore, database, path, change)
                        })
                        .collect::<Vec<_>>()
                }
                TriggersQuery::Storage { bucket, event, .. } => {
                    let events = event.map_or_else(
                        || {
                            vec![
                                StorageEvent::Finalized,
                                StorageEvent::Deleted,
                                StorageEvent::MetadataUpdated,
                                StorageEvent::Archived,
                            ]
                        },
                        |event| vec![event],
                    );
                    events
                        .into_iter()
                        .filter_map(|event| {
                            storage_verdict(record, &self.state.config.project_id, bucket, event)
                        })
                        .collect()
                }
                TriggersQuery::Auth { event, .. } => {
                    let events = event.map_or_else(
                        || {
                            vec![
                                AuthEvent::Create,
                                AuthEvent::Delete,
                                AuthEvent::BeforeCreate,
                                AuthEvent::BeforeSignIn,
                            ]
                        },
                        |event| vec![event],
                    );
                    events
                        .into_iter()
                        .filter_map(|event| auth_verdict(record, &blocking, event))
                        .collect()
                }
                TriggersQuery::Pubsub { topic } => {
                    pubsub_verdict(record, &self.state.config.project_id, topic)
                        .into_iter()
                        .collect()
                }
                TriggersQuery::Eventarc {
                    channel,
                    event_type,
                } => eventarc_verdict(&registry, record, channel, event_type, None)
                    .into_iter()
                    .collect(),
                TriggersQuery::Tasks { queue } => {
                    tasks_verdict(record, &self.state.config.project_id, queue)
                        .into_iter()
                        .collect()
                }
            };
            if listeners
                .iter()
                .any(|listener: &ListenerView| listener.function_id == record.definition.id())
            {
                continue;
            }
            if let Some(verdict) = verdicts.into_iter().find(|verdict| verdict.fires) {
                listeners.push(ListenerView {
                    function_id: record.definition.id(),
                    codebase: record.codebase.clone(),
                    event_type: verdict.event_type,
                    kind: FunctionKind::of(&record.definition),
                });
            }
        }
        listeners
    }

    /// Per relevant function and change, whether it fires and why not.
    pub async fn match_triggers(&self, request: &MatchInput) -> Vec<MatchView> {
        let service = match request {
            MatchInput::Firestore { .. } => TriggerService::Firestore,
            MatchInput::Storage { .. } => TriggerService::Storage,
            MatchInput::Auth { .. } => TriggerService::Auth,
            MatchInput::Pubsub { .. } => TriggerService::Pubsub,
            MatchInput::Eventarc { .. } => TriggerService::Eventarc,
            MatchInput::Tasks { .. } => TriggerService::Tasks,
        };
        let firestore = self.firestore_triggers(service);
        let background = self.background_enabled();
        let registry = self.state.registry.read().await;
        let blocking = registry.blocking().clone();
        let project = self.state.config.project_id.clone();
        let mut views = Vec::new();
        let mut seen: Vec<(String, Option<String>)> = Vec::new();
        for record in registry.records() {
            if record.stale {
                continue;
            }
            let verdicts: Vec<(Option<String>, Verdict)> = match request {
                MatchInput::Firestore {
                    database,
                    path,
                    changes,
                } => changes
                    .iter()
                    .filter_map(|change| {
                        firestore_verdict(
                            record,
                            &firestore,
                            database,
                            path.trim_matches('/'),
                            *change,
                        )
                        .map(|verdict| (Some(firestore_word(*change).to_owned()), verdict))
                    })
                    .collect(),
                MatchInput::Storage { bucket, events } => events
                    .iter()
                    .filter_map(|event| {
                        storage_verdict(record, &project, bucket, *event)
                            .map(|verdict| (Some(storage_word(*event).to_owned()), verdict))
                    })
                    .collect(),
                MatchInput::Auth { events, .. } => events
                    .iter()
                    .filter_map(|event| {
                        auth_verdict(record, &blocking, *event)
                            .map(|verdict| (Some(auth_word(*event).to_owned()), verdict))
                    })
                    .collect(),
                MatchInput::Pubsub { topic } => pubsub_verdict(record, &project, topic)
                    .map(|verdict| (None, verdict))
                    .into_iter()
                    .collect(),
                MatchInput::Eventarc {
                    channel,
                    event_type,
                    attributes,
                } => eventarc_verdict(&registry, record, channel, event_type, Some(attributes))
                    .map(|verdict| (None, verdict))
                    .into_iter()
                    .collect(),
                MatchInput::Tasks { queue } => tasks_verdict(record, &project, queue)
                    .map(|verdict| (None, verdict))
                    .into_iter()
                    .collect(),
            };
            let function_id = record.definition.id();
            for (change, verdict) in verdicts {
                if seen.contains(&(function_id.clone(), change.clone())) {
                    continue;
                }
                seen.push((function_id.clone(), change.clone()));
                let (fires, reason) = if let Some(reason) = &record.ignored {
                    (false, format!("ignored: {reason}"))
                } else if verdict.fires && verdict.background && (!background || !record.enabled) {
                    (false, "background triggers are paused".to_owned())
                } else {
                    (verdict.fires, verdict.reason)
                };
                views.push(MatchView {
                    function_id: function_id.clone(),
                    change,
                    fires,
                    reason,
                });
            }
        }
        views
    }

    fn firestore_triggers(
        &self,
        service: TriggerService,
    ) -> BTreeMap<String, firenook_functions_bridge::Trigger> {
        if service != TriggerService::Firestore {
            return BTreeMap::new();
        }
        self.state
            .triggers
            .all()
            .into_iter()
            .map(|trigger| (trigger.key.clone(), trigger))
            .collect()
    }

    /// Every channel: the ones definitions and registrations listen on, the
    /// ones Extension instances publish on, and the native channel.
    pub async fn eventarc(&self) -> EventarcView {
        let registry = self.state.registry.read().await;
        let mut channels: BTreeMap<String, ChannelView> = BTreeMap::new();
        channel_entry(&mut channels, "google");
        for (subscription, registered) in registry.all_eventarc_subscriptions() {
            let record = registry.get(&subscription.trigger_key);
            channel_entry(&mut channels, &subscription.channel)
                .subscriptions
                .push(SubscriptionView {
                    function_id: record.map(|record| record.definition.id()),
                    status: record.map(status_of),
                    trigger_key: subscription.trigger_key,
                    event_type: subscription.event_type,
                    filters: subscription.filters,
                    registered,
                });
        }
        drop(registry);
        for backend in &self.state.backends {
            let source = backend.read_source();
            let Some(extension) = &source.extension else {
                continue;
            };
            let Some(name) = extension
                .env
                .get("EVENTARC_CHANNEL")
                .filter(|name| !name.is_empty())
            else {
                continue;
            };
            channel_entry(&mut channels, name)
                .publishers
                .push(PublisherView {
                    instance_id: extension.instance_id.clone(),
                    source: extension
                        .env
                        .get("EVENTARC_CLOUD_EVENT_SOURCE")
                        .cloned()
                        .unwrap_or_default(),
                    allowed: extension
                        .env
                        .get("ALLOWED_EVENT_TYPES")
                        .map(|types| {
                            types
                                .split(',')
                                .filter(|entry| !entry.is_empty())
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default(),
                });
        }
        EventarcView {
            channels: channels.into_values().collect(),
        }
    }

    /// Publishes events on a channel exactly as an app's are (each recorded
    /// with its deliveries); returns their ids.
    pub async fn publish(
        &self,
        channel: &str,
        events: Vec<Value>,
        origin: EventarcOrigin,
    ) -> Result<Vec<String>, ConsoleError> {
        server::publish_events(Arc::clone(&self.state), channel, &events, origin, None)
            .await
            .map(|recorded| recorded.into_iter().map(|event| event.id).collect())
            .map_err(|PublishError::MissingType| {
                ConsoleError::Invalid("Every event needs a type.".to_owned())
            })
    }

    /// Publishes a kept event again on its channel, with a fresh id unless
    /// `keep_id`; returns the new event's id.
    pub async fn replay_event(
        &self,
        event_id: &str,
        keep_id: bool,
    ) -> Result<String, ConsoleError> {
        let monitor = &self.state.monitor;
        let event = monitor.event(event_id).ok_or_else(|| {
            ConsoleError::NotFound(format!(
                "The engine no longer keeps this event; it keeps the newest {}.",
                monitor.limits().events
            ))
        })?;
        let Value::Object(mut raw) = event.raw else {
            return Err(ConsoleError::Conflict {
                message: "Only the start of this event was kept, so it cannot be published again."
                    .to_owned(),
                detail: None,
            });
        };
        if !keep_id {
            raw.insert("id".to_owned(), Value::String(fresh_id()));
        }
        let recorded = server::publish_events(
            Arc::clone(&self.state),
            &event.summary.channel,
            &[Value::Object(raw)],
            EventarcOrigin::Replay,
            Some(event_id.to_owned()),
        )
        .await
        .map_err(|PublishError::MissingType| {
            ConsoleError::Invalid("The event has no type.".to_owned())
        })?;
        recorded
            .into_iter()
            .next()
            .map(|event| event.id)
            .ok_or_else(|| ConsoleError::Unavailable("The event was not recorded.".to_owned()))
    }

    /// Swaps an Extension instance's backend (definitions, env, source
    /// directory) and reloads it in place.
    pub async fn replace_extension(&self, backend: ExtensionBackend) -> Result<(), ConsoleError> {
        let target = self
            .state
            .backends
            .iter()
            .find(|candidate| candidate.instance.as_deref() == Some(backend.instance_id.as_str()))
            .cloned()
            .ok_or_else(|| {
                ConsoleError::NotFound(format!(
                    "There is no extension instance {}.",
                    backend.instance_id
                ))
            })?;
        let _edit = target.edit.lock().await;
        let previous = target.read_source().clone();
        target.replace_source(crate::BackendSource {
            directory: backend.functions_dir.clone(),
            config_dir: backend.functions_dir.clone(),
            extension: Some(backend),
        });
        let loaded = self.state.load_backend(&target, false).await;
        self.state.updates.send_modify(|counter| *counter += 1);
        loaded.map_err(|error| {
            target.replace_source(previous);
            ConsoleError::Conflict {
                message: "The instance did not load.".to_owned(),
                detail: Some(error),
            }
        })
    }
}

fn channel_entry<'a>(
    channels: &'a mut BTreeMap<String, ChannelView>,
    name: &str,
) -> &'a mut ChannelView {
    channels
        .entry(name.to_owned())
        .or_insert_with(|| ChannelView {
            name: name.to_owned(),
            publishers: Vec::new(),
            subscriptions: Vec::new(),
        })
}

/// A random id in the `CloudEvent` style.
fn fresh_id() -> String {
    use std::hash::{BuildHasher as _, Hasher as _};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos()),
    );
    let high = hasher.finish();
    hasher.write_u64(high);
    let low = hasher.finish();
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        high >> 32,
        (high >> 16) & 0xffff,
        high & 0x0fff,
        (low >> 48) & 0x3fff | 0x8000,
        low & 0xffff_ffff_ffff
    )
}

/// Variables the worker inherits from the engine (credentials excluded).
pub(crate) fn inherited_variables() -> impl Iterator<Item = (String, String)> {
    std::env::vars().filter(|(key, _)| {
        !matches!(
            key.as_str(),
            "GOOGLE_APPLICATION_CREDENTIALS"
                | "FIREBASE_TOKEN"
                | "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"
        )
    })
}

/// Records of one function, the current registration first: enabled and
/// live before disabled or removed, then the newest generation.
fn order_records(mut records: Vec<Record>) -> Vec<Record> {
    records.sort_by_key(|record| {
        let id = record.definition.id();
        (
            record.stale,
            !record.enabled,
            std::cmp::Reverse(generation_of(&record.key, &id).unwrap_or(0)),
        )
    });
    records
}

/// The generation an event trigger's key (`<id>-<generation>[-<channel>]`)
/// carries.
fn generation_of(key: &str, id: &str) -> Option<u32> {
    let rest = key.strip_prefix(id)?.strip_prefix('-')?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

fn status_of(record: &Record) -> RuntimeStatus {
    if let Some(reason) = &record.ignored {
        RuntimeStatus::Ignored(reason.clone())
    } else if record.stale {
        RuntimeStatus::Removed
    } else if !record.enabled {
        RuntimeStatus::Paused
    } else {
        RuntimeStatus::Receiving
    }
}

fn param_view(
    param: &DeclaredParam,
    values: &BTreeMap<String, String>,
    defaults: &BTreeMap<String, String>,
    sources: &BTreeMap<String, String>,
    secrets: &BTreeMap<String, String>,
) -> ParamView {
    let secret = param.param_type.eq_ignore_ascii_case("secret");
    let (value, file) = if secret {
        (
            None,
            secrets
                .contains_key(&param.name)
                .then(|| ".secret.local".to_owned()),
        )
    } else {
        (
            values
                .get(&param.name)
                .or_else(|| defaults.get(&param.name))
                .cloned(),
            sources.get(&param.name).cloned(),
        )
    };
    ParamView {
        name: param.name.clone(),
        param_type: param.param_type.clone(),
        default: param.default.clone(),
        label: param.label.clone(),
        description: param.description.clone(),
        unresolved: file.is_none(),
        value,
        secret,
        file,
    }
}

/// One function's answer for one change or event.
struct Verdict {
    fires: bool,
    reason: String,
    event_type: String,
    /// A background trigger (paused with background triggers).
    background: bool,
}

fn event_type_of(definition: &Definition) -> String {
    definition
        .event_trigger()
        .and_then(|event| event.get("eventType"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn firestore_word(change: FirestoreChange) -> &'static str {
    match change {
        FirestoreChange::Created => "created",
        FirestoreChange::Updated => "updated",
        FirestoreChange::Deleted => "deleted",
    }
}

/// The change words a Firestore event type listens for.
fn firestore_listens(event_type: &str) -> &'static str {
    let base = event_type
        .strip_suffix(".withAuthContext")
        .unwrap_or(event_type);
    if base.ends_with("write") || base.ends_with("written") {
        "every change"
    } else if base.ends_with("create") || base.ends_with("created") {
        "created documents"
    } else if base.ends_with("update") || base.ends_with("updated") {
        "updated documents"
    } else {
        "deleted documents"
    }
}

fn firestore_verdict(
    record: &Record,
    triggers: &BTreeMap<String, firenook_functions_bridge::Trigger>,
    database: &str,
    path: &str,
    change: FirestoreChange,
) -> Option<Verdict> {
    let trigger = triggers.get(&record.key)?;
    let event_type = trigger.event_type.clone();
    let shape = match change {
        FirestoreChange::Created => ChangeShape::Created,
        FirestoreChange::Updated => ChangeShape::Updated,
        FirestoreChange::Deleted => ChangeShape::Deleted,
    };
    // The bridge's own matcher: what the console says is what it delivers.
    let explanation = explain_match(trigger, database, path, shape);
    let reason = match explanation.reason {
        MatchReason::Fires => format!("matches {}", trigger.document_pattern),
        MatchReason::OtherDatabase(listens) => format!("listens on {listens}, not {database}"),
        MatchReason::OtherEvent(listens) => format!(
            "listens for {}, not {} ones",
            firestore_listens(&listens),
            firestore_word(change)
        ),
        MatchReason::PathDoesNotMatch(pattern) => format!("{pattern} does not match {path}"),
    };
    let fires = explanation.fires;
    Some(Verdict {
        fires,
        reason,
        event_type,
        background: true,
    })
}

fn storage_word(event: StorageEvent) -> &'static str {
    match event {
        StorageEvent::Finalized => "finalized",
        StorageEvent::Deleted => "deleted",
        StorageEvent::MetadataUpdated => "metadataUpdated",
        StorageEvent::Archived => "archived",
    }
}

/// The Storage event types of one event, first and second generation.
fn storage_types(event: StorageEvent) -> [&'static str; 2] {
    match event {
        StorageEvent::Finalized => [
            "google.storage.object.finalize",
            "google.cloud.storage.object.v1.finalized",
        ],
        StorageEvent::Deleted => [
            "google.storage.object.delete",
            "google.cloud.storage.object.v1.deleted",
        ],
        StorageEvent::MetadataUpdated => [
            "google.storage.object.metadataUpdate",
            "google.cloud.storage.object.v1.metadataUpdated",
        ],
        StorageEvent::Archived => [
            "google.storage.object.archive",
            "google.cloud.storage.object.v1.archived",
        ],
    }
}

fn storage_verdict(
    record: &Record,
    project: &str,
    bucket: &str,
    event: StorageEvent,
) -> Option<Verdict> {
    if record.definition.service() != "storage.googleapis.com" {
        return None;
    }
    let event_type = event_type_of(&record.definition);
    let keys = crate::registry::multicast_keys(&record.definition, project);
    let listens_on = keys
        .first()
        .and_then(|key| key.rsplit(':').next())
        .unwrap_or_default()
        .to_owned();
    let (fires, reason) = if !storage_types(event).contains(&event_type.as_str()) {
        (
            false,
            format!(
                "listens for {event_type}, not {} objects",
                storage_word(event)
            ),
        )
    } else if listens_on != bucket {
        (
            false,
            format!("listens on bucket {listens_on}, not {bucket}"),
        )
    } else {
        (true, format!("listens on bucket {bucket}"))
    };
    Some(Verdict {
        fires,
        reason,
        event_type,
        background: true,
    })
}

fn auth_word(event: AuthEvent) -> &'static str {
    match event {
        AuthEvent::Create => "create",
        AuthEvent::Delete => "delete",
        AuthEvent::BeforeCreate => "beforeCreate",
        AuthEvent::BeforeSignIn => "beforeSignIn",
    }
}

fn auth_verdict(
    record: &Record,
    blocking: &crate::BlockingConfig,
    event: AuthEvent,
) -> Option<Verdict> {
    let definition = &record.definition;
    match event {
        AuthEvent::Create | AuthEvent::Delete => {
            if definition.service() != "firebaseauth.googleapis.com" {
                return None;
            }
            let event_type = event_type_of(definition);
            let wanted = if event == AuthEvent::Create {
                "user.create"
            } else {
                "user.delete"
            };
            let fires = event_type.ends_with(wanted);
            Some(Verdict {
                fires,
                reason: if fires {
                    "fires for every user of the project and its tenants".to_owned()
                } else {
                    format!("listens for {event_type}")
                },
                event_type,
                background: true,
            })
        }
        AuthEvent::BeforeCreate | AuthEvent::BeforeSignIn => {
            let trigger = definition.blocking_trigger()?;
            let event_type = trigger
                .get("eventType")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let wanted = auth_word(event);
            if !event_type.ends_with(wanted) {
                return Some(Verdict {
                    fires: false,
                    reason: format!(
                        "is a {} function",
                        event_type.rsplit('.').next().unwrap_or_default()
                    ),
                    event_type,
                    background: false,
                });
            }
            let wired = match event {
                AuthEvent::BeforeCreate => {
                    blocking.before_create.is_some() && blocking.before_create == record.url
                }
                _ => blocking.before_sign_in.is_some() && blocking.before_sign_in == record.url,
            };
            Some(Verdict {
                fires: wired,
                reason: if wired {
                    format!("the Auth emulator calls it for {wanted}")
                } else {
                    format!("another function is the one the Auth emulator calls for {wanted}")
                },
                event_type,
                background: false,
            })
        }
    }
}

fn pubsub_verdict(record: &Record, project: &str, topic: &str) -> Option<Verdict> {
    let definition = &record.definition;
    let kind = FunctionKind::of(definition);
    let listens_on = match kind {
        FunctionKind::Schedule => format!(
            "projects/{project}/topics/firebase-schedule-{}",
            definition.name()
        ),
        FunctionKind::Pubsub => {
            let event = definition.event_trigger()?;
            let resource = event
                .get("resource")
                .and_then(Value::as_str)
                .filter(|resource| !resource.is_empty())
                .or_else(|| {
                    event
                        .get("eventFilters")
                        .and_then(|filters| filters.get("topic"))
                        .and_then(Value::as_str)
                })
                .unwrap_or_default();
            if resource.starts_with("projects/") {
                resource.to_owned()
            } else {
                format!("projects/{project}/topics/{resource}")
            }
        }
        _ => return None,
    };
    let fires = listens_on == topic;
    Some(Verdict {
        fires,
        reason: if fires {
            format!("listens on {}", short_name(topic))
        } else {
            format!(
                "listens on {}, not {}",
                short_name(&listens_on),
                short_name(topic)
            )
        },
        event_type: event_type_of(definition),
        background: true,
    })
}

fn short_name(resource: &str) -> &str {
    resource.rsplit('/').next().unwrap_or(resource)
}

fn eventarc_verdict(
    registry: &crate::registry::Registry,
    record: &Record,
    channel: &str,
    event_type: &str,
    attributes: Option<&BTreeMap<String, String>>,
) -> Option<Verdict> {
    let subscription = registry
        .eventarc_subscriptions(event_type, channel)
        .into_iter()
        .find(|subscription| subscription.trigger_key == record.key)?;
    let mismatches: Vec<String> = match attributes {
        Some(attributes) => subscription
            .filters
            .iter()
            .filter(|(name, expected)| attributes.get(*name) != Some(*expected))
            .map(|(name, expected)| match attributes.get(name) {
                Some(actual) => format!("{name} is {actual}, it wants {expected}"),
                None => format!("it wants {name} {expected}, and the event has no {name}"),
            })
            .collect(),
        None => Vec::new(),
    };
    let fires = mismatches.is_empty();
    Some(Verdict {
        fires,
        reason: if fires {
            if subscription.filters.is_empty() || attributes.is_some() {
                format!("listens for {event_type}")
            } else {
                format!(
                    "listens for {event_type} when {}",
                    subscription
                        .filters
                        .iter()
                        .map(|(name, value)| format!("{name} is {value}"))
                        .collect::<Vec<_>>()
                        .join(" and ")
                )
            }
        } else {
            mismatches.join("; ")
        },
        event_type: event_type.to_owned(),
        background: false,
    })
}

fn tasks_verdict(record: &Record, project: &str, queue: &str) -> Option<Verdict> {
    let definition = &record.definition;
    definition.task_queue_trigger()?;
    let key = format!(
        "queue:{project}-{}-{}",
        definition.region(),
        definition.name()
    );
    let fires = key == queue;
    Some(Verdict {
        fires,
        reason: if fires {
            "runs the queue's tasks".to_owned()
        } else {
            format!("runs the tasks of {key}")
        },
        event_type: "cloudtasks".to_owned(),
        background: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generations_come_from_trigger_keys() {
        assert_eq!(
            generation_of("us-central1-onOrder-0", "us-central1-onOrder"),
            Some(0)
        );
        assert_eq!(
            generation_of(
                "us-central1-on-3-projects/p/locations/l/channels/c",
                "us-central1-on"
            ),
            Some(3)
        );
        assert_eq!(generation_of("us-central1-api", "us-central1-api"), None);
    }

    fn firestore_record(key: &str) -> Record {
        let definition = Definition::from_json(
            serde_json::json!({"name": "onOrder", "region": "us-central1", "platform": "gcfv2",
                "eventTrigger": {"eventType": "google.cloud.firestore.document.v1.created"}})
            .as_object()
            .cloned()
            .unwrap_or_default(),
        );
        Record {
            key: key.to_owned(),
            definition,
            codebase: "default".to_owned(),
            extension_instance: None,
            enabled: true,
            stale: false,
            ignored: None,
            url: None,
        }
    }

    #[test]
    fn firestore_verdicts_are_the_bridges_matches_in_words() {
        let key = "us-central1-onOrder-0";
        let trigger = firenook_functions_bridge::Trigger {
            project: "demo".to_owned(),
            key: key.to_owned(),
            generation: firenook_functions_bridge::TriggerGeneration::V2,
            event_type: "google.cloud.firestore.document.v1.created".to_owned(),
            database: "(default)".to_owned(),
            document_pattern: "orders/{orderId}".to_owned(),
        };
        let triggers = BTreeMap::from([(key.to_owned(), trigger)]);
        let record = firestore_record(key);
        let verdict = |database: &str, path: &str, change| {
            firestore_verdict(&record, &triggers, database, path, change).expect("a trigger")
        };
        let fires = verdict("(default)", "orders/o_1", FirestoreChange::Created);
        assert!(fires.fires);
        assert_eq!(fires.reason, "matches orders/{orderId}");
        let other = verdict("other", "orders/o_1", FirestoreChange::Created);
        assert!(!other.fires);
        assert_eq!(other.reason, "listens on (default), not other");
        let event = verdict("(default)", "orders/o_1", FirestoreChange::Updated);
        assert_eq!(
            event.reason,
            "listens for created documents, not updated ones"
        );
        let path = verdict("(default)", "orders/o_1/items/i", FirestoreChange::Created);
        assert_eq!(
            path.reason,
            "orders/{orderId} does not match orders/o_1/items/i"
        );
        assert!(
            firestore_verdict(
                &record,
                &BTreeMap::new(),
                "(default)",
                "orders/o_1",
                FirestoreChange::Created
            )
            .is_none()
        );
    }

    #[test]
    fn queries_read_the_console_resource_formats() {
        assert_eq!(
            TriggersQuery::parse("firestore", "(default)|orders/o_1", Some("created")),
            Ok(TriggersQuery::Firestore {
                database: "(default)".to_owned(),
                path: "orders/o_1".to_owned(),
                change: Some(FirestoreChange::Created),
            })
        );
        assert_eq!(
            TriggersQuery::parse("auth", "", None),
            Ok(TriggersQuery::Auth {
                tenant: None,
                event: None
            })
        );
        // Auth's pages ask by the official event types' own names.
        for (asked, event) in [
            ("user.create", AuthEvent::Create),
            ("create", AuthEvent::Create),
            ("user.delete", AuthEvent::Delete),
            ("beforeSignIn", AuthEvent::BeforeSignIn),
        ] {
            assert_eq!(
                TriggersQuery::parse("auth", "acme", Some(asked)),
                Ok(TriggersQuery::Auth {
                    tenant: Some("acme".to_owned()),
                    event: Some(event)
                }),
                "{asked}"
            );
        }
        assert!(TriggersQuery::parse("auth", "", Some("user.signIn")).is_err());
        assert!(TriggersQuery::parse("firestore", "orders/o_1", None).is_err());
        assert!(TriggersQuery::parse("pubsub", "emails", None).is_err());
        assert!(TriggersQuery::parse("tasks", "resize", None).is_err());
        assert!(TriggersQuery::parse("storage", "b|a.png", Some("exploded")).is_err());
        assert!(TriggersQuery::parse("database", "x", None).is_err());
        assert!(
            TriggersQuery::parse("eventarc", "projects/p/locations/l/channels/c|a.b", None).is_ok()
        );
    }

    #[test]
    fn fresh_ids_look_like_uuids() {
        let id = fresh_id();
        assert_eq!(id.len(), 36, "{id}");
        assert_eq!(id.matches('-').count(), 4, "{id}");
        assert_ne!(fresh_id(), id);
    }
}
