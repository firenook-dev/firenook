//! The Extensions console API, mounted at `/console/api/v1/extensions`:
//! the instances (`GET /extensions/instances`), one instance with its
//! configuration, functions, APIs and events, reconfigure (writing the file
//! that actually set each value and reloading the instance in place),
//! reload, and the one route that reveals a secret param. Vendoring a
//! registry source is the CLI's (`firenook ext:vendor`); Reload then loads
//! the copy.
//!
//! Every instance-changing route goes through the Extensions control,
//! which runs one operation at a time per instance and announces the
//! result on `extensions.changes`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path as FilePath;

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use firenook_extensions::control::{
    ExtensionState as ControlState, InstanceState, ReconfigureError,
};
use firenook_extensions::params::{is_system_param, unchecked_pattern, validate};
use firenook_extensions::{EMULATED_APIS, SourceOrigin};
use firenook_functions_runtime::console::FunctionView;
use firenook_functions_runtime::manifest::Definition;
use firenook_functions_runtime::monitor::{FunctionKind, FunctionStats, FunctionsPhase};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::functions::{BODY_LIMIT, FunctionStatus, NoBody, summary_of};
use super::{ComputeControl, ComputeState, conflict_with_detail};
use crate::api_error::ApiError;
use crate::entity::EntityRef;
use crate::json::{BodyLimit, ConsoleJson};

/// The longest README the console reads from an extension's source.
const README_BYTES: u64 = 256 * 1024;
/// Why an extension's task-queue function receives nothing here.
pub(crate) const TASK_QUEUE_NOTE: &str = "Task queue functions of an extension are not delivered by the emulator, as in the official emulator, so lifecycle tasks such as onInstall do not run here.";

/// The variables the emulator sets for every instance.
const AUTO_PARAMS: [&str; 8] = [
    "PROJECT_ID",
    "EXT_INSTANCE_ID",
    "DATABASE_INSTANCE",
    "DATABASE_URL",
    "STORAGE_BUCKET",
    "ALLOWED_EVENT_TYPES",
    "EVENTARC_CHANNEL",
    "EVENTARC_CLOUD_EVENT_SOURCE",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) enum ExtensionKind {
    Local,
    Registry,
}

/// Where an instance's source came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) enum ExtensionOrigin {
    Local,
    Vendored,
    Cache,
    Downloaded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) enum ExtensionState {
    Running,
    Loading,
    Failed,
}

/// Every instance, and the ones the suite left out.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionsSnapshot {
    pub(crate) phase: FunctionsPhase,
    pub(crate) instances: Vec<ExtensionInstanceSummary>,
    pub(crate) dropped: Vec<ExtensionDropped>,
    /// The suite runs with --offline.
    pub(crate) offline: bool,
    /// The Google APIs the emulator emulates.
    pub(crate) emulated_apis: Vec<String>,
}

/// An instance left out for triggers on services the suite does not
/// emulate.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionDropped {
    pub(crate) instance_id: String,
    pub(crate) written: String,
    pub(crate) services: Vec<String>,
}

/// One instance in the list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionInstanceSummary {
    pub(crate) instance_id: String,
    /// The value in firebase.json.
    pub(crate) written: String,
    pub(crate) kind: ExtensionKind,
    /// `publisher/name@version` for a registry ref.
    pub(crate) reference: Option<String>,
    pub(crate) version: Option<String>,
    pub(crate) display_name: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) publisher: Option<String>,
    pub(crate) origin: Option<ExtensionOrigin>,
    /// Relative to the project when inside it.
    pub(crate) source_dir: Option<String>,
    pub(crate) sidecar: bool,
    pub(crate) offline_ready: bool,
    pub(crate) readiness_note: Option<String>,
    pub(crate) state: ExtensionState,
    pub(crate) error: Option<String>,
    pub(crate) function_count: u32,
    pub(crate) ignored_function_count: u32,
    /// Short sentences: an API the emulator does not have, a missing secret,
    /// an invalid param.
    pub(crate) warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) enum ExtensionParamType {
    String,
    Select,
    MultiSelect,
    Secret,
    Other,
}

/// Where a param's value comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) enum ExtensionParamSource {
    File,
    Default,
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionParamOption {
    pub(crate) value: String,
    pub(crate) label: Option<String>,
}

/// One param of the instance's configuration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionParam {
    pub(crate) param: String,
    pub(crate) label: Option<String>,
    /// Markdown.
    pub(crate) description: Option<String>,
    #[serde(rename = "type")]
    pub(crate) param_type: ExtensionParamType,
    pub(crate) required: bool,
    pub(crate) immutable: bool,
    pub(crate) default: Option<String>,
    pub(crate) example: Option<String>,
    pub(crate) options: Vec<ExtensionParamOption>,
    pub(crate) validation_regex: Option<String>,
    pub(crate) validation_error_message: Option<String>,
    /// Null for a secret: reveal it through the secrets route.
    pub(crate) value: Option<String>,
    pub(crate) provided: bool,
    pub(crate) source: ExtensionParamSource,
    /// The file that set it, for a `file` source.
    pub(crate) file: Option<String>,
    /// Why the value is not acceptable, when it is not.
    pub(crate) problem: Option<String>,
    /// Why the value was not checked, when the engine cannot check it.
    pub(crate) unchecked: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionNamedValue {
    pub(crate) name: String,
    pub(crate) value: String,
}

/// A function the instance adds.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionFunction {
    pub(crate) resource: String,
    pub(crate) description: Option<String>,
    pub(crate) function_id: Option<String>,
    /// The function in Functions.
    pub(crate) function: Option<EntityRef>,
    pub(crate) kind: FunctionKind,
    pub(crate) status: FunctionStatus,
    pub(crate) ignored_reason: Option<String>,
    pub(crate) stats: Option<FunctionStats>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionApi {
    pub(crate) api_name: String,
    pub(crate) reason: Option<String>,
    /// The emulator emulates it.
    pub(crate) emulated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionRole {
    pub(crate) role: String,
    pub(crate) reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionExternalService {
    pub(crate) name: String,
    pub(crate) pricing_uri: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionDeclaredEvent {
    #[serde(rename = "type")]
    pub(crate) event_type: String,
    pub(crate) description: Option<String>,
    /// In the instance's `ALLOWED_EVENT_TYPES`.
    pub(crate) allowed: bool,
}

/// What the instance publishes on Eventarc.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionEvents {
    pub(crate) channel: Option<String>,
    /// The channel in Eventarc.
    pub(crate) channel_ref: Option<EntityRef>,
    pub(crate) allowed: Vec<String>,
    pub(crate) declared: Vec<ExtensionDeclaredEvent>,
    /// The `CloudEvent` source it publishes with.
    pub(crate) source: String,
}

/// A lifecycle hook the spec declares (the emulator does not run them).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionLifecycleHook {
    pub(crate) stage: String,
    pub(crate) function: Option<String>,
    pub(crate) processing_message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionAuthor {
    pub(crate) name: String,
    pub(crate) url: Option<String>,
}

/// Everything about one instance.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionInstanceDetail {
    pub(crate) summary: ExtensionInstanceSummary,
    pub(crate) author: Option<ExtensionAuthor>,
    pub(crate) source_url: Option<String>,
    pub(crate) license: Option<String>,
    pub(crate) billing_required: bool,
    pub(crate) spec_version: Option<String>,
    pub(crate) params: Vec<ExtensionParam>,
    pub(crate) system_params: Vec<ExtensionNamedValue>,
    /// What the emulator sets for every instance (`PROJECT_ID`,
    /// `EXT_INSTANCE_ID` …).
    pub(crate) auto_params: Vec<ExtensionNamedValue>,
    pub(crate) functions: Vec<ExtensionFunction>,
    pub(crate) apis: Vec<ExtensionApi>,
    pub(crate) roles: Vec<ExtensionRole>,
    pub(crate) external_services: Vec<ExtensionExternalService>,
    pub(crate) events: ExtensionEvents,
    pub(crate) lifecycle: Vec<ExtensionLifecycleHook>,
    /// POSTINSTALL markdown with Firebase console links pointing at console
    /// routes.
    pub(crate) postinstall: Option<String>,
    /// The source's README, when it has one.
    pub(crate) readme: Option<String>,
    /// The instance's parameter files, relative to the project.
    pub(crate) env_files: Vec<String>,
}

/// New values for an instance's params; secrets go to its
/// `.secret.local`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionReconfigureRequest {
    #[serde(default)]
    pub(crate) values: BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) secrets: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionReconfigureResult {
    /// The files written, relative to the project.
    pub(crate) written: Vec<String>,
    pub(crate) instance: ExtensionInstanceDetail,
}

/// One unacceptable value; a 400 lists them all in the error's `problems`
/// extra.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionParamProblem {
    pub(crate) param: String,
    pub(crate) message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionRevealedValue {
    pub(crate) value: String,
}

/// `extensions.changes`: the instances whose state changed (keys only).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct ExtensionsChanged {
    pub(crate) instance_ids: Vec<String>,
}

/// Every `/extensions` route.
pub(crate) fn router(state: ComputeState) -> Router {
    let limit = Extension(BodyLimit(BODY_LIMIT));
    Router::new()
        .route("/extensions/instances", get(snapshot))
        .route("/extensions/instances/{instance}", get(detail))
        .route(
            "/extensions/instances/{instance}/secrets/{param}",
            get(reveal_secret),
        )
        .route(
            "/extensions/instances/{instance}/reconfigure",
            post(reconfigure).layer(limit),
        )
        .route(
            "/extensions/instances/{instance}/reload",
            post(reload).layer(limit),
        )
        .with_state(state)
}

async fn snapshot(State(state): State<ComputeState>) -> Json<ExtensionsSnapshot> {
    let phase = state.monitor().phase();
    let emulated_apis = EMULATED_APIS.iter().map(|api| (*api).to_owned()).collect();
    let Ok(control) = state.control() else {
        return Json(ExtensionsSnapshot {
            phase,
            instances: Vec::new(),
            dropped: Vec::new(),
            offline: false,
            emulated_apis,
        });
    };
    let Some(extensions) = &control.extensions else {
        return Json(ExtensionsSnapshot {
            phase,
            instances: Vec::new(),
            dropped: Vec::new(),
            offline: false,
            emulated_apis,
        });
    };
    let views = control.runtime.functions().await;
    let mut instances = Vec::new();
    for (id, instance) in extensions.instances().await {
        instances.push(summary(&state, &control, &id, &instance, &views));
    }
    Json(ExtensionsSnapshot {
        phase,
        instances,
        dropped: extensions
            .dropped()
            .iter()
            .map(|dropped| ExtensionDropped {
                instance_id: dropped.instance_id.clone(),
                written: dropped.written.clone(),
                services: dropped.services.clone(),
            })
            .collect(),
        offline: extensions.config().offline,
        emulated_apis,
    })
}

async fn detail(
    State(state): State<ComputeState>,
    Path(instance): Path<String>,
) -> Result<Json<ExtensionInstanceDetail>, ApiError> {
    let control = state.control()?;
    let found = instance_state(&control, &instance).await?;
    Ok(Json(
        instance_detail(&state, &control, &instance, &found).await,
    ))
}

async fn reveal_secret(
    State(state): State<ComputeState>,
    Path((instance, param)): Path<(String, String)>,
) -> Result<Json<ExtensionRevealedValue>, ApiError> {
    let control = state.control()?;
    instance_state(&control, &instance).await?;
    let extensions = control
        .extensions
        .as_ref()
        .ok_or_else(|| no_instance(&instance))?;
    extensions
        .secret(&instance, &param)
        .await
        .map(|value| Json(ExtensionRevealedValue { value }))
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "{param} has no value in extensions/{instance}.secret.local."
            ))
        })
}

async fn reconfigure(
    State(state): State<ComputeState>,
    Path(instance): Path<String>,
    ConsoleJson(request): ConsoleJson<ExtensionReconfigureRequest>,
) -> Result<Json<ExtensionReconfigureResult>, ApiError> {
    let control = state.control()?;
    let extensions = control
        .extensions
        .clone()
        .ok_or_else(|| no_instance(&instance))?;
    let done = extensions
        .reconfigure(&instance, request.values, request.secrets)
        .await
        .map_err(|error| match error {
            ReconfigureError::NotFound(message) => ApiError::not_found(message),
            ReconfigureError::Invalid(problems) => {
                let problems: Vec<ExtensionParamProblem> = problems
                    .into_iter()
                    .map(|problem| ExtensionParamProblem {
                        param: problem.param,
                        message: problem.message,
                    })
                    .collect();
                let sentence = if problems.len() == 1 {
                    "One value is not acceptable; nothing was written.".to_owned()
                } else {
                    format!(
                        "{} values are not acceptable; nothing was written.",
                        problems.len()
                    )
                };
                ApiError::invalid(sentence).with_extra(
                    "problems",
                    serde_json::to_value(&problems).unwrap_or(Value::Null),
                )
            }
            ReconfigureError::LoadFailed { message, detail } => {
                conflict_with_detail(message, Some(detail))
            }
            ReconfigureError::Write(message) => conflict_with_detail(
                format!("The parameter files of {instance} could not be written."),
                Some(message),
            ),
        })?;
    Ok(Json(ExtensionReconfigureResult {
        written: done.written,
        instance: instance_detail(&state, &control, &instance, &done.state).await,
    }))
}

async fn reload(
    State(state): State<ComputeState>,
    Path(instance): Path<String>,
    ConsoleJson(NoBody {}): ConsoleJson<NoBody>,
) -> Result<Json<ExtensionInstanceDetail>, ApiError> {
    let control = state.control()?;
    instance_state(&control, &instance).await?;
    let extensions = control
        .extensions
        .clone()
        .ok_or_else(|| no_instance(&instance))?;
    let reloaded = extensions.reload(&instance).await.map_err(|error| {
        conflict_with_detail(format!("{instance} did not load."), Some(error.0))
    })?;
    Ok(Json(
        instance_detail(&state, &control, &instance, &reloaded).await,
    ))
}

// ── Mapping ──────────────────────────────────────────────────────────────

fn no_instance(instance: &str) -> ApiError {
    ApiError::not_found(format!("There is no extension instance {instance}."))
}

async fn instance_state(
    control: &ComputeControl,
    instance: &str,
) -> Result<InstanceState, ApiError> {
    let extensions = control
        .extensions
        .as_ref()
        .ok_or_else(|| no_instance(instance))?;
    extensions
        .instance(instance)
        .await
        .ok_or_else(|| no_instance(instance))
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn list<'a>(value: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// `path` relative to `root` when inside it. Either may be spelt through a
/// symbolic link the other is not (macOS's `/var` is `/private/var`), so
/// the canonical spellings are compared when the written ones differ.
fn relative(root: &FilePath, path: &FilePath) -> String {
    if let Ok(rest) = path.strip_prefix(root) {
        return rest.display().to_string();
    }
    match (root.canonicalize(), path.canonicalize()) {
        (Ok(root), Ok(path)) => path.strip_prefix(&root).map_or_else(
            |_| path.display().to_string(),
            |rest| rest.display().to_string(),
        ),
        _ => path.display().to_string(),
    }
}

fn summary(
    state: &ComputeState,
    control: &ComputeControl,
    id: &str,
    instance: &InstanceState,
    views: &[FunctionView],
) -> ExtensionInstanceSummary {
    let project_dir = control
        .extensions
        .as_ref()
        .map(|extensions| extensions.config().project_dir.clone())
        .unwrap_or_default();
    let loaded = instance.loaded.as_ref();
    let spec = loaded.map_or(&Value::Null, |loaded| &loaded.spec);
    let registry = instance.status.kind != "local";
    let version = instance
        .status
        .version
        .clone()
        .or_else(|| text(spec, "version"));
    let publisher = registry
        .then(|| instance.status.written.split('/').next().map(str::to_owned))
        .flatten()
        .filter(|publisher| !publisher.contains('@'));
    let reference = registry.then(|| {
        let base = instance
            .status
            .written
            .split('@')
            .next()
            .unwrap_or(&instance.status.written)
            .to_owned();
        match &version {
            Some(version) => format!("{base}@{version}"),
            None => instance.status.written.clone(),
        }
    });
    let own: Vec<&FunctionView> = views
        .iter()
        .filter(|view| view.extension_instance.as_deref() == Some(id))
        .collect();
    let not_loaded = state
        .monitor()
        .codebase(id)
        .map_or(0, |codebase| codebase.not_loaded.len());
    let ignored = own
        .iter()
        .filter(|view| {
            !matches!(
                view.status,
                firenook_functions_runtime::console::RuntimeStatus::Receiving
            )
        })
        .count()
        + not_loaded;
    ExtensionInstanceSummary {
        instance_id: id.to_owned(),
        written: instance.status.written.clone(),
        kind: if registry {
            ExtensionKind::Registry
        } else {
            ExtensionKind::Local
        },
        reference,
        version,
        display_name: text(spec, "displayName"),
        name: text(spec, "name"),
        description: text(spec, "description"),
        publisher,
        origin: loaded.map(|loaded| match loaded.origin {
            SourceOrigin::Local => ExtensionOrigin::Local,
            SourceOrigin::Vendored => ExtensionOrigin::Vendored,
            SourceOrigin::Cache => ExtensionOrigin::Cache,
            SourceOrigin::Downloaded => ExtensionOrigin::Downloaded,
        }),
        source_dir: loaded
            .map(|loaded| relative(&project_dir, &loaded.source_dir))
            .or_else(|| {
                instance
                    .status
                    .source_dir
                    .as_ref()
                    .map(|directory| relative(&project_dir, directory))
            }),
        sidecar: instance.status.sidecar,
        offline_ready: instance.status.offline_ready,
        readiness_note: instance.status.note.clone(),
        state: match instance.state {
            ControlState::Running => ExtensionState::Running,
            ControlState::Loading => ExtensionState::Loading,
            ControlState::Failed => ExtensionState::Failed,
        },
        error: instance.error.clone(),
        function_count: u32::try_from(own.len()).unwrap_or(u32::MAX),
        ignored_function_count: u32::try_from(ignored).unwrap_or(u32::MAX),
        warnings: warnings(id, instance),
    }
}

/// An API the emulator does not have, a missing secret, an invalid param.
fn warnings(id: &str, instance: &InstanceState) -> Vec<String> {
    let Some(loaded) = &instance.loaded else {
        return Vec::new();
    };
    let mut warnings = Vec::new();
    for api in list(&loaded.spec, "apis") {
        if let Some(name) = text(api, "apiName")
            && !EMULATED_APIS.contains(&name.as_str())
        {
            warnings.push(format!(
                "Calls {name}, which the emulator does not have; those calls reach production or fail."
            ));
        }
    }
    for param in params_of(id, loaded) {
        if param.param_type == ExtensionParamType::Secret && param.required && !param.provided {
            warnings.push(format!(
                "{} has no value in extensions/{id}.secret.local.",
                param.param
            ));
        } else if let Some(problem) = &param.problem {
            warnings.push(format!("{}: {problem}", param.param));
        }
    }
    warnings
}

fn param_type(value: &Value) -> ExtensionParamType {
    match value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("string")
        .to_ascii_lowercase()
        .as_str()
    {
        "string" => ExtensionParamType::String,
        "select" => ExtensionParamType::Select,
        "multiselect" => ExtensionParamType::MultiSelect,
        "secret" => ExtensionParamType::Secret,
        _ => ExtensionParamType::Other,
    }
}

/// The spec's user params with their values, sources and problems.
fn params_of(id: &str, loaded: &firenook_extensions::LoadedExtension) -> Vec<ExtensionParam> {
    let backend = &loaded.backend;
    let secret_keys: BTreeSet<String> = backend
        .secret_env
        .iter()
        .filter_map(|entry| entry.get("key").and_then(Value::as_str).map(str::to_owned))
        .chain(backend.secret_values.keys().cloned())
        .collect();
    list(&loaded.spec, "params")
        .filter_map(|param| {
            let name = text(param, "param")?;
            if is_system_param(&name) {
                return None;
            }
            let kind = param_type(param);
            let secret = kind == ExtensionParamType::Secret;
            let value = (!secret).then(|| backend.env.get(&name).cloned()).flatten();
            let provided = if secret {
                secret_keys.contains(&name)
            } else {
                value.as_deref().is_some_and(|value| !value.is_empty())
            };
            // A secret the instance's `.secret.local` holds names that file,
            // as an env value names the env file that set it.
            let file = loaded.param_sources.get(&name).cloned().or_else(|| {
                (secret && backend.secret_values.contains_key(&name))
                    .then(|| format!("extensions/{id}.secret.local"))
            });
            let source = if file.is_some() {
                ExtensionParamSource::File
            } else if loaded.defaults_applied.contains(&name) {
                ExtensionParamSource::Default
            } else if provided {
                // Set by the emulator itself (an auto param named in the spec).
                ExtensionParamSource::Default
            } else {
                ExtensionParamSource::Missing
            };
            let checked = if secret {
                provided.then_some("(set)")
            } else {
                value.as_deref()
            };
            Some(ExtensionParam {
                label: text(param, "label"),
                description: text(param, "description"),
                param_type: kind,
                required: param
                    .get("required")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                immutable: param
                    .get("immutable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                default: param.get("default").map(|value| match value {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                }),
                example: text(param, "example"),
                options: list(param, "options")
                    .filter_map(|option| {
                        Some(ExtensionParamOption {
                            value: option.get("value").map(|value| match value {
                                Value::String(text) => text.clone(),
                                other => other.to_string(),
                            })?,
                            label: text(option, "label"),
                        })
                    })
                    .collect(),
                validation_regex: text(param, "validationRegex"),
                validation_error_message: text(param, "validationErrorMessage"),
                problem: if secret && !provided {
                    param
                        .get("required")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                        .then(|| format!("Set it in extensions/{id}.secret.local."))
                } else {
                    validate(param, checked)
                },
                unchecked: unchecked_pattern(param).map(str::to_owned),
                value,
                provided,
                source,
                file,
                param: name,
            })
        })
        .collect()
}

/// POSTINSTALL links the loader pointed at the Emulator UI's origin, made
/// relative to the console so they work wherever the page loads.
fn console_links(content: &str, ui_origin: Option<&str>) -> String {
    let Some(origin) = ui_origin else {
        return content.to_owned();
    };
    let mut text = content.to_owned();
    for target in ["storage", "firestore", "auth", "logs", "extensions"] {
        text = text.replace(&format!("{origin}{target}"), &format!("/console/{target}"));
    }
    text
}

async fn instance_detail(
    state: &ComputeState,
    control: &ComputeControl,
    id: &str,
    instance: &InstanceState,
) -> ExtensionInstanceDetail {
    let views = control.runtime.functions().await;
    let summary = summary(state, control, id, instance, &views);
    let config = control
        .extensions
        .as_ref()
        .map(|extensions| extensions.config().clone());
    let Some(loaded) = &instance.loaded else {
        return ExtensionInstanceDetail {
            summary,
            author: None,
            source_url: None,
            license: None,
            billing_required: false,
            spec_version: None,
            params: Vec::new(),
            system_params: Vec::new(),
            auto_params: Vec::new(),
            functions: Vec::new(),
            apis: Vec::new(),
            roles: Vec::new(),
            external_services: Vec::new(),
            events: ExtensionEvents::default(),
            lifecycle: Vec::new(),
            postinstall: None,
            readme: None,
            env_files: Vec::new(),
        };
    };
    let spec = &loaded.spec;
    let project_dir = config
        .as_ref()
        .map(|config| config.project_dir.clone())
        .unwrap_or_default();
    ExtensionInstanceDetail {
        author: spec.get("author").and_then(|author| {
            Some(ExtensionAuthor {
                name: text(author, "authorName")?,
                url: text(author, "url"),
            })
        }),
        source_url: text(spec, "sourceUrl"),
        license: text(spec, "license"),
        billing_required: spec
            .get("billingRequired")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        spec_version: text(spec, "specVersion"),
        params: params_of(id, loaded),
        system_params: system_params_of(loaded),
        auto_params: AUTO_PARAMS
            .iter()
            .filter_map(|name| {
                loaded
                    .backend
                    .env
                    .get(*name)
                    .map(|value| ExtensionNamedValue {
                        name: (*name).to_owned(),
                        value: value.clone(),
                    })
            })
            .collect(),
        functions: functions_of(state, id, spec, &views),
        apis: apis_of(spec),
        roles: list(spec, "roles")
            .filter_map(|role| {
                Some(ExtensionRole {
                    role: text(role, "role")?,
                    reason: text(role, "reason"),
                })
            })
            .collect(),
        external_services: list(spec, "externalServices")
            .filter_map(|service| {
                Some(ExtensionExternalService {
                    name: text(service, "name")?,
                    pricing_uri: text(service, "pricingUri"),
                })
            })
            .collect(),
        events: events_of(loaded),
        lifecycle: lifecycle_of(spec),
        postinstall: text(spec, "postinstallContent").map(|content| {
            console_links(
                &content,
                config
                    .as_ref()
                    .and_then(|config| config.ui_origin.as_deref()),
            )
        }),
        readme: read_readme(&loaded.source_dir).await,
        env_files: env_files_of(&project_dir, id, loaded).await,
        summary,
    }
}

/// The spec's system params (`firebaseextensions.v1beta.function/location`
/// …) with the values the instance runs with.
fn system_params_of(loaded: &firenook_extensions::LoadedExtension) -> Vec<ExtensionNamedValue> {
    let spec = &loaded.spec;
    list(spec, "params")
        .filter_map(|param| text(param, "param"))
        .filter(|name| is_system_param(name))
        .chain(list(spec, "systemParams").filter_map(|param| text(param, "param")))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|name| ExtensionNamedValue {
            value: loaded.backend.env.get(&name).cloned().unwrap_or_default(),
            name,
        })
        .collect()
}

fn apis_of(spec: &Value) -> Vec<ExtensionApi> {
    list(spec, "apis")
        .filter_map(|api| {
            let name = text(api, "apiName")?;
            Some(ExtensionApi {
                emulated: EMULATED_APIS.contains(&name.as_str()),
                reason: text(api, "reason"),
                api_name: name,
            })
        })
        .collect()
}

/// The channel, the allowed and declared event types, and the source the
/// instance publishes with.
fn events_of(loaded: &firenook_extensions::LoadedExtension) -> ExtensionEvents {
    let env = &loaded.backend.env;
    let allowed: Vec<String> = env
        .get("ALLOWED_EVENT_TYPES")
        .map(|types| {
            types
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let channel = env
        .get("EVENTARC_CHANNEL")
        .filter(|channel| !channel.is_empty())
        .cloned();
    ExtensionEvents {
        channel_ref: channel.as_deref().map(EntityRef::eventarc_channel),
        channel,
        declared: list(&loaded.spec, "events")
            .filter_map(|event| {
                let event_type = text(event, "type")?;
                Some(ExtensionDeclaredEvent {
                    allowed: allowed.contains(&event_type),
                    description: text(event, "description"),
                    event_type,
                })
            })
            .collect(),
        allowed,
        source: env
            .get("EVENTARC_CLOUD_EVENT_SOURCE")
            .cloned()
            .unwrap_or_default(),
    }
}

fn lifecycle_of(spec: &Value) -> Vec<ExtensionLifecycleHook> {
    spec.get("lifecycleEvents")
        .and_then(Value::as_object)
        .map(|hooks| {
            hooks
                .iter()
                .map(|(stage, hook)| ExtensionLifecycleHook {
                    stage: stage.clone(),
                    function: text(hook, "taskQueueTriggerFunction")
                        .or_else(|| text(hook, "function")),
                    processing_message: text(hook, "processingMessage"),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The instance's parameter files that exist, relative to the project.
async fn env_files_of(
    project_dir: &FilePath,
    id: &str,
    loaded: &firenook_extensions::LoadedExtension,
) -> Vec<String> {
    let mut files: BTreeSet<String> = loaded.param_sources.values().cloned().collect();
    let secret_file = format!("extensions/{id}.secret.local");
    if tokio::fs::try_exists(project_dir.join(&secret_file))
        .await
        .unwrap_or(false)
    {
        files.insert(secret_file);
    }
    files.into_iter().collect()
}

/// The functions the spec declares, each with the function the runtime
/// loaded for it (one per region), or why there is none.
fn functions_of(
    state: &ComputeState,
    id: &str,
    spec: &Value,
    views: &[FunctionView],
) -> Vec<ExtensionFunction> {
    let not_loaded = state
        .monitor()
        .codebase(id)
        .map(|codebase| codebase.not_loaded)
        .unwrap_or_default();
    let mut functions = Vec::new();
    for resource in list(spec, "resources") {
        let Some(name) = text(resource, "name") else {
            continue;
        };
        let kind_word = text(resource, "type").unwrap_or_default();
        if !kind_word.contains("function") {
            continue;
        }
        let description = text(resource, "description");
        // The emulator names an extension's function `ext-<instance>-<name>`
        // and keeps the resource's name as its entry point.
        let loaded: Vec<&FunctionView> = views
            .iter()
            .filter(|view| {
                view.extension_instance.as_deref() == Some(id) && view.entry_point == name
            })
            .collect();
        if loaded.is_empty() {
            let properties = resource
                .get("properties")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let kind = FunctionKind::of(&Definition::from_json(properties));
            let reason = not_loaded
                .iter()
                .find(|entry| entry.id.ends_with(&format!("-ext-{id}-{name}")))
                .map_or_else(
                    || "The emulator does not run this function (the official emulator leaves it out too).".to_owned(),
                    |entry| entry.reason.clone(),
                );
            functions.push(ExtensionFunction {
                resource: name,
                description,
                function_id: None,
                function: None,
                kind,
                status: FunctionStatus::Ignored,
                ignored_reason: Some(reason),
                stats: None,
            });
            continue;
        }
        // The emulator copies no trigger for a task-queue resource (the
        // recorded official behaviour), so the runtime sees a function with
        // no trigger at all; the spec still says what it is.
        let task_queue = resource
            .get("properties")
            .and_then(|properties| properties.get("taskQueueTrigger"))
            .is_some();
        for view in loaded {
            let counters = state.monitor().stats(&view.id);
            let row = summary_of(view, counters.clone(), state.parts.suite(), &state.project);
            let undelivered = task_queue && row.status != FunctionStatus::Receiving;
            functions.push(ExtensionFunction {
                resource: name.clone(),
                description: description.clone(),
                function_id: Some(view.id.clone()),
                function: Some(EntityRef::function(&view.id)),
                kind: if task_queue {
                    FunctionKind::Tasks
                } else {
                    view.kind
                },
                status: row.status,
                ignored_reason: if undelivered {
                    Some(TASK_QUEUE_NOTE.to_owned())
                } else {
                    row.status_reason
                },
                stats: Some(counters),
            });
        }
    }
    functions
}

/// `README.md` in the extension's source, when it has a small one.
async fn read_readme(source_dir: &FilePath) -> Option<String> {
    let path = source_dir.join("README.md");
    let metadata = tokio::fs::metadata(&path).await.ok()?;
    if !metadata.is_file() || metadata.len() > README_BYTES {
        return None;
    }
    tokio::fs::read_to_string(path).await.ok()
}

#[cfg(test)]
#[path = "extensions_tests.rs"]
mod tests;
