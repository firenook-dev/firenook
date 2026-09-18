//! Firebase Extensions for the fireside suite: `firebase.json` instances
//! become extra Functions backends with the official emulator's parameter,
//! spec and trigger semantics (`ExtensionsEmulator`, `planner.want`,
//! `toEmulatableBackend`), from local directories, the shared firebase-tools
//! source cache, a project's vendored copies, or the registry.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use fireside_functions_runtime::{Definition, ExtensionBackend, LogEvent, LogSink, dotenv};
use serde_json::{Map, Value};

pub mod params;
pub mod refs;
pub mod registry;
pub mod source;
pub mod spec;

use params::Params;
use refs::{ExtensionRef, is_local_path};
use registry::{Credential, Endpoints, RegistryClient};
use source::RegistrySidecar;

/// An error with the official wording where the fixture recorded one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionsError(pub String);

impl std::fmt::Display for ExtensionsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ExtensionsError {}

/// APIs the suite emulates (`EMULATED_APIS` in the official validation).
const EMULATED_APIS: [&str; 4] = [
    "storage-component.googleapis.com",
    "firestore.googleapis.com",
    "pubsub.googleapis.com",
    "identitytoolkit.googleapis.com",
];

/// Everything the loader needs.
#[derive(Debug, Clone)]
pub struct ExtensionsConfig {
    pub project_id: String,
    pub project_dir: PathBuf,
    /// `firebase.json` `extensions` entries in file order: instance id → ref or local path.
    pub extensions: Vec<(String, String)>,
    /// `.firebaserc` aliases of the project (parameter file suffixes).
    pub aliases: Vec<String>,
    pub database_url: String,
    pub storage_bucket: String,
    /// The `npm` used to install and build downloaded sources.
    pub npm: PathBuf,
    pub cache_dir: PathBuf,
    pub endpoints: Endpoints,
    pub credential: Option<Credential>,
    /// Never contact the registry; every ref must be vendored or cached with
    /// its sidecar.
    pub offline: bool,
    /// The Emulator UI origin (with a trailing slash) when it is served;
    /// console links in POSTINSTALL content are rewritten to it, or to
    /// `unknown` like the official emulator without a UI.
    pub ui_origin: Option<String>,
}

/// One resolved instance before it becomes a backend.
#[derive(Debug, Clone)]
pub struct Instance {
    pub instance_id: String,
    /// The value written in `firebase.json`.
    pub written: String,
    pub local_path: Option<PathBuf>,
    pub reference: Option<ExtensionRef>,
    pub params: Params,
    pub system_params: Params,
    pub allowed_event_types: Option<Vec<String>>,
    pub eventarc_channel: Option<String>,
}

/// Where an instance's source came from (reported by `doctor`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceOrigin {
    Local,
    Vendored,
    Cache,
    Downloaded,
}

/// A loaded instance: the backend the runtime starts plus its provenance.
#[derive(Debug, Clone)]
pub struct LoadedExtension {
    pub backend: ExtensionBackend,
    pub source_dir: PathBuf,
    pub origin: SourceOrigin,
}

/// Reads and resolves every instance of `firebase.json`, in order, into
/// backends. Errors reading the manifest are aggregated like
/// `planner.want`.
pub async fn load(
    config: &ExtensionsConfig,
    log: &LogSink,
) -> Result<Vec<LoadedExtension>, ExtensionsError> {
    let instances = want(config, log).await?;
    let mut loaded = Vec::with_capacity(instances.len());
    let client = RegistryClient::new(config.endpoints.clone(), config.credential.clone());
    for instance in &instances {
        loaded.push(to_backend(config, &client, instance, log).await?);
    }
    warn_unemulated_apis(config, &loaded, log);
    Ok(filter_unemulated_triggers(loaded, log))
}

/// `filterUnemulatedTriggers`: an instance with a trigger on a service the
/// suite does not emulate (Realtime Database, or anything outside the
/// emulated set) is dropped whole, with the official warnings.
fn filter_unemulated_triggers(loaded: Vec<LoadedExtension>, log: &LogSink) -> Vec<LoadedExtension> {
    let mut found = false;
    let kept: Vec<LoadedExtension> = loaded
        .into_iter()
        .filter(|extension| {
            let mut services: Vec<String> = Vec::new();
            for definition in &extension.backend.definitions {
                if definition.https_trigger().is_some() || definition.event_trigger().is_none() {
                    continue;
                }
                let service = definition.service();
                // `Constants.getServiceName` for the services the suite lacks.
                let name = match service.as_str() {
                    "firestore.googleapis.com" | "pubsub.googleapis.com" | "firebaseauth.googleapis.com"
                    | "storage.googleapis.com" | "eventarc.googleapis.com" => continue,
                    "firebaseio.com" => "database".to_owned(),
                    "app-measurement.com" => "analytics".to_owned(),
                    "crashlytics.googleapis.com" => "crashlytics".to_owned(),
                    "firebaseremoteconfig.googleapis.com" => "remote config".to_owned(),
                    "testlab.googleapis.com" => "test lab".to_owned(),
                    "cloudtasks.googleapis.com" => "tasks".to_owned(),
                    other => other.to_owned(),
                };
                if !services.contains(&name) {
                    services.push(name);
                }
            }
            if services.is_empty() {
                return true;
            }
            found = true;
            let list = services.join(", ");
            log.record(LogEvent::new(
                "WARN",
                &format!("extensions[{}]", extension.backend.instance_id),
                format!(
                    " ignored becuase it includes {list} triggered functions, and the {list} emulator does not exist or is not running."
                ),
            ));
            false
        })
        .collect();
    if found {
        log.record(LogEvent::new(
            "WARN",
            "extensions",
            "No Cloud Functions for these instances will be emulated, because partially emulating an Extension can lead to unexpected behavior. ".to_owned(),
        ));
    }
    kept
}

/// `planner.want` for the emulator: parameters read and substituted,
/// system parameters split off, event settings extracted, refs versioned.
pub async fn want(
    config: &ExtensionsConfig,
    log: &LogSink,
) -> Result<Vec<Instance>, ExtensionsError> {
    let mut instances = Vec::new();
    let mut errors = Vec::new();
    let client = RegistryClient::new(config.endpoints.clone(), config.credential.clone());
    let project_params = params::project_params(
        &config.project_id,
        &config.database_url,
        &config.storage_bucket,
    );
    for (instance_id, written) in &config.extensions {
        match want_one(config, &client, &project_params, instance_id, written, log).await {
            Ok(instance) => instances.push(instance),
            Err(error) => errors.push(error.0),
        }
    }
    if !errors.is_empty() {
        return Err(ExtensionsError(format!(
            "Errors while reading 'extensions' in 'firebase.json'\n{}",
            errors
                .iter()
                .map(|message| format!("- {message}"))
                .collect::<Vec<_>>()
                .join("\n")
        )));
    }
    Ok(instances)
}

async fn want_one(
    config: &ExtensionsConfig,
    client: &RegistryClient,
    project_params: &Params,
    instance_id: &str,
    written: &str,
    log: &LogSink,
) -> Result<Instance, ExtensionsError> {
    let raw = params::read_instance_params(
        &config.project_dir,
        instance_id,
        &config.project_id,
        None,
        &config.aliases,
        true,
    )?;
    let substituted = params::substitute_param_values(&raw, project_params)?;
    let (system_params, mut params) = params::partition_system_params(&substituted);
    let allowed_event_types = params.get("ALLOWED_EVENT_TYPES").map(|value| {
        value
            .split(',')
            .filter(|entry| !entry.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>()
    });
    let eventarc_channel = params.get("EVENTARC_CHANNEL").map(str::to_owned);
    params.remove("EVENTARC_CHANNEL");
    params.remove("ALLOWED_EVENT_TYPES");
    if is_local_path(written) {
        return Ok(Instance {
            instance_id: instance_id.to_owned(),
            written: written.to_owned(),
            local_path: Some(resolve_local(&config.project_dir, written)),
            reference: None,
            params,
            system_params,
            allowed_event_types,
            eventarc_channel,
        });
    }
    let mut reference = ExtensionRef::parse(written)?;
    reference.version = Some(resolve_version(config, client, &reference, written, log).await?);
    Ok(Instance {
        instance_id: instance_id.to_owned(),
        written: written.to_owned(),
        local_path: None,
        reference: Some(reference),
        params,
        system_params,
        allowed_event_types,
        eventarc_channel,
    })
}

/// `path.resolve(localPath)` from a process whose working directory is the
/// project's real path: absolute, normalized, symlinks resolved when the
/// directory exists.
fn resolve_local(project_dir: &Path, written: &str) -> PathBuf {
    let trimmed = written.trim();
    let joined = if let Some(rest) = trimmed.strip_prefix("~/")
        && let Some(home) = std::env::var_os("HOME")
    {
        PathBuf::from(home).join(rest)
    } else {
        let path = Path::new(trimmed);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            project_dir.join(path)
        }
    };
    std::fs::canonicalize(&joined).unwrap_or_else(|_| normalize_path(&joined))
}

/// Lexical normalization (`.` and `..` segments) without touching the filesystem.
fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// An exact version stays; `latest`, ranges and bare refs resolve through
/// the vendored manifest first, then the registry.
async fn resolve_version(
    config: &ExtensionsConfig,
    client: &RegistryClient,
    reference: &ExtensionRef,
    written: &str,
    log: &LogSink,
) -> Result<String, ExtensionsError> {
    if let Some(version) = reference.version.as_deref()
        && semver::Version::parse(version).is_ok()
    {
        return Ok(version.to_owned());
    }
    if let Some(version) = source::vendored_version(&config.project_dir, written) {
        log.record(LogEvent::new(
            "DEBUG",
            "extensions",
            format!("{written} resolves to the vendored version {version}"),
        ));
        return Ok(version);
    }
    if config.offline {
        return Err(ExtensionsError(format!(
            "{written} is not pinned to a version and no vendored resolution exists; run `fireside ext:vendor` with network access or pin the version in firebase.json"
        )));
    }
    client.resolve_version(reference).await
}

/// `ensureSourceCode` + `toEmulatableBackend`.
async fn to_backend(
    config: &ExtensionsConfig,
    client: &RegistryClient,
    instance: &Instance,
    log: &LogSink,
) -> Result<LoadedExtension, ExtensionsError> {
    let (source_dir, origin, sidecar, mut spec) = if let Some(local) = &instance.local_path {
        if !source::has_valid_source(local) {
            log_invalid_source(local, &local.display().to_string(), log);
            return Err(ExtensionsError(format!(
                "Tried to emulate local extension at {}, but it was missing required files.",
                local.display()
            )));
        }
        let spec = spec::read_local_spec(local)?;
        (local.clone(), SourceOrigin::Local, None, spec)
    } else {
        let reference = instance
            .reference
            .as_ref()
            .ok_or_else(|| ExtensionsError("Tried to emulate an extension instance without a ref or localPath. This should never happen.".to_owned()))?;
        let (directory, origin, mut sidecar) =
            ensure_registry_source(config, client, reference, log).await?;
        // `getExtensionVersion` populates the spec on the object it returns.
        if let Some(spec) = sidecar.extension_version.get_mut("spec") {
            spec::populate_registry_spec(spec)?;
        }
        let spec = sidecar
            .extension_version
            .get("spec")
            .cloned()
            .ok_or_else(|| {
                ExtensionsError(format!(
                    "Internal error getting extension {}",
                    reference.extension_ref()
                ))
            })?;
        (directory, origin, Some(sidecar), spec)
    };
    spec::populate_registry_spec(&mut spec)?;
    let spec_params: Vec<Value> = spec
        .get("params")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let params = params::populate_default_params(&instance.params, &spec_params);
    let mut env = auto_populated_params(config, instance);
    env.extend(&params);
    let resources = spec::function_resources(&spec, &env)?;
    let mut definitions = Vec::with_capacity(resources.len());
    for resource in &resources {
        let definition = spec::trigger_definition(
            resource,
            &instance.system_params,
            &instance.instance_id,
            log,
        )?;
        definitions.push(Definition::from_json(definition));
    }
    let runtime = spec::runtime(&resources)?;
    let (non_secret_env, secret_env) = split_secret_params(&env, &spec_params);
    let secret_values = local_secrets(config, &instance.instance_id, &secret_env, log);
    // `toBackendInfo` shows the spec and version with the instance's
    // parameters substituted and console links pointed at the UI.
    let display = |value: &Value| -> Result<Value, ExtensionsError> {
        let mut substituted = params::substitute_params(value, &non_secret_env)?;
        let rewrite = |spec: &mut Value| {
            if let Some(content) = spec.get("postinstallContent").and_then(Value::as_str) {
                let replaced = replace_console_links(content, config.ui_origin.as_deref());
                spec["postinstallContent"] = Value::String(replaced);
            }
        };
        rewrite(&mut substituted);
        if let Some(spec) = substituted.get_mut("spec") {
            rewrite(spec);
        }
        Ok(substituted)
    };
    let extension_spec = if instance.local_path.is_some() {
        Some(display(&spec)?)
    } else {
        None
    };
    let extension_version = match &sidecar {
        Some(sidecar) => Some(display(&sidecar.extension_version)?),
        None => None,
    };
    let backend = ExtensionBackend {
        instance_id: instance.instance_id.clone(),
        functions_dir: source_dir.join("functions"),
        env: non_secret_env.into_map(),
        secret_env,
        secret_values,
        definitions,
        extension_spec,
        extension: sidecar.as_ref().map(|sidecar| sidecar.extension.clone()),
        extension_version,
        runtime,
    };
    Ok(LoadedExtension {
        backend,
        source_dir,
        origin,
    })
}

/// `replaceConsoleLinks`: Firebase console links in POSTINSTALL content
/// become Emulator UI links (or `unknown...` without a UI).
fn replace_console_links(content: &str, ui_origin: Option<&str>) -> String {
    let ui = ui_origin.unwrap_or("unknown");
    let mut text = content.to_owned();
    for (section, target) in [
        ("storage", "storage"),
        ("firestore", "firestore"),
        ("database", "database"),
        ("authentication", "auth"),
        ("functions", "logs"),
        ("extensions", "extensions"),
    ] {
        // The official lookahead `(?=[\)\]\s])` written with a captured
        // terminator; a non-global JavaScript replace touches the first match.
        let pattern = format!(
            r"(http[s]?://)?console\.firebase\.google\.com/(u/[0-9]/)?project/[A-Za-z0-9-]+/{section}[A-Za-z0-9/-]*([\)\]\s])"
        );
        if let Ok(regex) = regex::Regex::new(&pattern)
            && let Some(captures) = regex.captures(&text)
        {
            let whole = captures.get(0).map(|m| m.range());
            let terminator = captures
                .get(3)
                .map(|m| m.as_str().to_owned())
                .unwrap_or_default();
            if let Some(range) = whole {
                text.replace_range(range, &format!("{ui}{target}{terminator}"));
            }
        }
    }
    text
}

/// `getNonSecretEnv` + `getSecretEnvVars`: secret-typed parameters leave the
/// environment; the ones with a Secret Manager version name become
/// `{key, secret, projectId, version}` entries.
fn split_secret_params(env: &Params, spec_params: &[Value]) -> (Params, Vec<Value>) {
    let is_secret = |param: &Value| {
        param
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind == "secret" || kind == "SECRET")
    };
    let secret_names: Vec<&str> = spec_params
        .iter()
        .filter(|param| is_secret(param))
        .filter_map(|param| param.get("param").and_then(Value::as_str))
        .collect();
    let mut non_secret_env = Params::new();
    for (key, value) in env.iter() {
        if !secret_names.contains(&key) {
            non_secret_env.set(key, value);
        }
    }
    let mut secret_env = Vec::new();
    for name in &secret_names {
        let Some(value) = env.get(name).filter(|value| !value.is_empty()) else {
            continue;
        };
        let parts: Vec<&str> = value.split('/').collect();
        secret_env.push(serde_json::json!({
            "key": name,
            "secret": parts.get(3).copied().unwrap_or_default(),
            "projectId": parts.get(1).copied().unwrap_or_default(),
            "version": parts.get(5).copied(),
        }));
    }
    (non_secret_env, secret_env)
}

/// `autoPopulatedParams`: the emulator's own instance environment.
fn auto_populated_params(config: &ExtensionsConfig, instance: &Instance) -> Params {
    let project = &config.project_id;
    let mut params = Params::new();
    params.set("PROJECT_ID", project.as_str());
    params.set("EXT_INSTANCE_ID", instance.instance_id.as_str());
    params.set("DATABASE_INSTANCE", project.as_str());
    params.set("DATABASE_URL", format!("https://{project}.firebaseio.com"));
    params.set("STORAGE_BUCKET", format!("{project}.appspot.com"));
    params.set(
        "ALLOWED_EVENT_TYPES",
        instance
            .allowed_event_types
            .as_ref()
            .map(|types| types.join(","))
            .unwrap_or_default(),
    );
    params.set(
        "EVENTARC_CHANNEL",
        instance.eventarc_channel.clone().unwrap_or_default(),
    );
    params.set(
        "EVENTARC_CLOUD_EVENT_SOURCE",
        format!("projects/{project}/instances/{}", instance.instance_id),
    );
    params
}

/// The values of `extensions/<instance>.secret.local`, plus the official
/// error lines for secrets that would need Secret Manager.
fn local_secrets(
    config: &ExtensionsConfig,
    instance_id: &str,
    secret_env: &[Value],
    log: &LogSink,
) -> BTreeMap<String, String> {
    let path = config
        .project_dir
        .join(params::ENV_DIRECTORY)
        .join(format!("{instance_id}.secret.local"));
    let secrets = match dotenv::load_local_secrets(&path) {
        Ok(secrets) => secrets,
        Err(error) => {
            log.record(LogEvent::new("ERROR", "functions", error.0));
            BTreeMap::new()
        }
    };
    let missing: Vec<String> = secret_env
        .iter()
        .filter_map(|entry| {
            let key = entry.get("key")?.as_str()?;
            let secret = entry.get("secret")?.as_str()?;
            (!secrets.contains_key(key)).then(|| format!("{secret}@latest"))
        })
        .collect();
    if !missing.is_empty() {
        log.record(LogEvent::new(
            "ERROR",
            "functions",
            format!(
                "Unable to access secret environment variables from Google Cloud Secret Manager. Make sure the credential used for the Functions Emulator have access or provide override values in {}:\n\t{}",
                path.display(),
                missing
                    .iter()
                    .map(|secret| format!("Fireside does not contact Secret Manager; {secret} must be provided locally"))
                    .collect::<Vec<_>>()
                    .join("\n\t")
            ),
        ));
    }
    secrets
}

/// The source directory for a registry ref: vendored, then the shared
/// cache, then a download; with the registry sidecar from the same place
/// or fetched once.
async fn ensure_registry_source(
    config: &ExtensionsConfig,
    client: &RegistryClient,
    reference: &ExtensionRef,
    log: &LogSink,
) -> Result<(PathBuf, SourceOrigin, RegistrySidecar), ExtensionsError> {
    let vendored = source::source_path(&source::vendor_directory(&config.project_dir), reference)?;
    let cached = source::source_path(&config.cache_dir, reference)?;
    let version_ref = reference.version_ref()?;
    let (directory, origin) = if source::has_valid_source(&vendored) {
        (vendored, SourceOrigin::Vendored)
    } else if source::has_valid_source(&cached) {
        (cached, SourceOrigin::Cache)
    } else {
        if config.offline {
            return Err(ExtensionsError(format!(
                "{version_ref} is not vendored under {} and not in the cache at {}; run `fireside ext:vendor` with network access",
                vendored.display(),
                cached.display()
            )));
        }
        if cached.exists() {
            log_invalid_source(&cached, &version_ref, log);
        }
        let sidecar = fetch_sidecar(client, reference).await?;
        let uri = sidecar
            .extension_version
            .get("sourceDownloadUri")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ExtensionsError(format!(
                    "{version_ref} has no sourceDownloadUri in the registry"
                ))
            })?;
        source::download_source(uri, reference, &cached, &config.npm, log).await?;
        source::write_sidecar(&cached, &sidecar)?;
        return Ok((cached, SourceOrigin::Downloaded, sidecar));
    };
    let sidecar = match source::read_sidecar(&directory) {
        Some(sidecar) => sidecar,
        None if config.offline => {
            return Err(ExtensionsError(format!(
                "{version_ref} at {} has no {} sidecar; run `fireside ext:vendor` once with network access",
                directory.display(),
                source::REGISTRY_SIDECAR
            )));
        }
        None => {
            let sidecar = fetch_sidecar(client, reference).await?;
            if let Err(error) = source::write_sidecar(&directory, &sidecar) {
                log.record(LogEvent::new("WARN", "extensions", error.0));
            }
            sidecar
        }
    };
    Ok((directory, origin, sidecar))
}

/// `getExtension` + `getExtensionVersion` for the sidecar.
pub async fn fetch_sidecar(
    client: &RegistryClient,
    reference: &ExtensionRef,
) -> Result<RegistrySidecar, ExtensionsError> {
    let extension_version = client.get_extension_version(reference).await?;
    let extension = client.get_extension(reference).await?;
    Ok(RegistrySidecar {
        extension,
        extension_version,
    })
}

fn log_invalid_source(directory: &Path, target: &str, log: &LogSink) {
    for file in ["./extension.yaml", "./functions/package.json"] {
        let path = directory.join(file.trim_start_matches("./"));
        if !path.is_file() {
            log.record(LogEvent::new(
                "INFO",
                "extensions",
                format!(
                    "Detected invalid source code for {target}, expected to find {}",
                    directory.join(file).display()
                ),
            ));
            return;
        }
    }
}

/// `checkAndWarnAPIs` for a demo project: one warning listing the APIs the
/// suite does not emulate.
fn warn_unemulated_apis(config: &ExtensionsConfig, loaded: &[LoadedExtension], log: &LogSink) {
    let mut apis: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for extension in loaded {
        let spec = extension
            .backend
            .extension_spec
            .as_ref()
            .or_else(|| extension.backend.extension_version.as_ref()?.get("spec"));
        let Some(list) = spec
            .and_then(|spec| spec.get("apis"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for api in list {
            let Some(name) = api.get("apiName").and_then(Value::as_str) else {
                continue;
            };
            if !EMULATED_APIS.contains(&name) {
                apis.entry(name.to_owned())
                    .or_default()
                    .push(extension.backend.instance_id.clone());
            }
        }
    }
    if apis.is_empty() {
        return;
    }
    let rows: Vec<String> = apis
        .iter()
        .map(|(api, instances)| format!("  {api}: {}", instances.join(", ")))
        .collect();
    let message = if config.project_id.starts_with("demo-") {
        format!(
            "The following Extensions make calls to Google Cloud APIs that do not have Emulators. {} is a demo project, so these Extensions may not work as expected.\n{}",
            config.project_id,
            rows.join("\n")
        )
    } else {
        format!(
            "The following Extensions make calls to Google Cloud APIs that do not have Emulators. These calls will go to production Google Cloud APIs which may have real effects on {}.\n{}",
            config.project_id,
            rows.join("\n")
        )
    };
    log.record(LogEvent::new("WARN", "Extensions", message));
}

/// Vendors one ref into the project: copies the cached source (downloading
/// it first when absent), writes the sidecar and records the resolution.
pub async fn vendor(
    config: &ExtensionsConfig,
    instance_id: &str,
    written: &str,
    log: &LogSink,
) -> Result<PathBuf, ExtensionsError> {
    if is_local_path(written) {
        return Err(ExtensionsError(format!(
            "{instance_id} is a local extension ({written}); nothing to vendor"
        )));
    }
    let client = RegistryClient::new(config.endpoints.clone(), config.credential.clone());
    let mut reference = ExtensionRef::parse(written)?;
    let resolved = resolve_version(config, &client, &reference, written, log).await?;
    reference.version = Some(resolved.clone());
    let (directory, origin, sidecar) =
        ensure_registry_source(config, &client, &reference, log).await?;
    let target = source::source_path(&source::vendor_directory(&config.project_dir), &reference)?;
    if origin != SourceOrigin::Vendored {
        source::copy_tree(&directory, &target)?;
        source::write_sidecar(&target, &sidecar)?;
    }
    source::record_vendored_version(&config.project_dir, written, &resolved)?;
    Ok(target)
}

/// One instance's source state, as `fireside extensions status` and the
/// wrapper's `doctor` report it. Nothing is downloaded or contacted.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceStatus {
    pub instance_id: String,
    pub written: String,
    /// `local` or `registry`.
    pub kind: &'static str,
    /// The version an exact ref or the vendored manifest pins; `None` when
    /// resolving it needs the registry.
    pub version: Option<String>,
    /// Where a valid source was found (`local`, `vendored`, `cache`), if any.
    pub source: Option<&'static str>,
    pub source_dir: Option<PathBuf>,
    /// Whether the registry sidecar is present next to the source.
    pub sidecar: bool,
    /// Whether the instance starts with no network and no token.
    pub offline_ready: bool,
    /// Whether the parameter files exist.
    pub params_found: bool,
    pub note: Option<String>,
}

/// Reports every instance's source state without side effects.
#[must_use]
pub fn status(config: &ExtensionsConfig) -> Vec<InstanceStatus> {
    config
        .extensions
        .iter()
        .map(|(instance_id, written)| {
            let params_found = params::read_instance_params(
                &config.project_dir,
                instance_id,
                &config.project_id,
                None,
                &config.aliases,
                true,
            )
            .is_ok();
            if is_local_path(written) {
                let directory = resolve_local(&config.project_dir, written);
                let valid = source::has_valid_source(&directory);
                return InstanceStatus {
                    instance_id: instance_id.clone(),
                    written: written.clone(),
                    kind: "local",
                    version: None,
                    source: valid.then_some("local"),
                    source_dir: Some(directory.clone()),
                    sidecar: false,
                    offline_ready: valid && params_found,
                    params_found,
                    note: (!valid).then(|| format!("missing extension.yaml or functions/package.json under {}", directory.display())),
                };
            }
            let Ok(mut reference) = ExtensionRef::parse(written) else {
                return InstanceStatus {
                    instance_id: instance_id.clone(),
                    written: written.clone(),
                    kind: "registry",
                    version: None,
                    source: None,
                    source_dir: None,
                    sidecar: false,
                    offline_ready: false,
                    params_found,
                    note: Some("unparseable extension ref".to_owned()),
                };
            };
            let pinned = reference
                .version
                .clone()
                .filter(|version| semver::Version::parse(version).is_ok())
                .or_else(|| source::vendored_version(&config.project_dir, written));
            let Some(version) = pinned else {
                return InstanceStatus {
                    instance_id: instance_id.clone(),
                    written: written.clone(),
                    kind: "registry",
                    version: None,
                    source: None,
                    source_dir: None,
                    sidecar: false,
                    offline_ready: false,
                    params_found,
                    note: Some("the version resolves through the registry; vendor it with `fireside ext:vendor` or pin it".to_owned()),
                };
            };
            reference.version = Some(version.clone());
            let vendored = source::source_path(&source::vendor_directory(&config.project_dir), &reference).ok();
            let cached = source::source_path(&config.cache_dir, &reference).ok();
            let (source_kind, directory) = match (vendored, cached) {
                (Some(path), _) if source::has_valid_source(&path) => (Some("vendored"), Some(path)),
                (_, Some(path)) if source::has_valid_source(&path) => (Some("cache"), Some(path)),
                _ => (None, None),
            };
            let sidecar = directory
                .as_ref()
                .is_some_and(|path| source::read_sidecar(path).is_some());
            InstanceStatus {
                instance_id: instance_id.clone(),
                written: written.clone(),
                kind: "registry",
                version: Some(version),
                source: source_kind,
                source_dir: directory,
                sidecar,
                offline_ready: source_kind.is_some() && sidecar && params_found,
                params_found,
                note: match (source_kind, sidecar) {
                    (None, _) => Some("no vendored or cached source; the first start downloads it (network and a Firebase CLI login or FIREBASE_TOKEN)".to_owned()),
                    (Some(_), false) => Some("source present without its registry sidecar; the first start fetches it once".to_owned()),
                    _ => None,
                },
            }
        })
        .collect()
}

/// The `extensions` object of a parsed `firebase.json`, in file order when
/// the caller preserved it.
#[must_use]
pub fn extensions_from_config(config: &Map<String, Value>) -> Vec<(String, String)> {
    config
        .get("extensions")
        .and_then(Value::as_object)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|(id, value)| value.as_str().map(|text| (id.clone(), text.to_owned())))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(project_dir: &Path, extensions: Vec<(String, String)>) -> ExtensionsConfig {
        ExtensionsConfig {
            project_id: "demo-fireside-functions-oracle".to_owned(),
            project_dir: project_dir.to_path_buf(),
            extensions,
            aliases: Vec::new(),
            database_url: "https://demo-fireside-functions-oracle.firebaseio.com".to_owned(),
            storage_bucket: "demo-fireside-functions-oracle.appspot.com".to_owned(),
            npm: PathBuf::from("npm"),
            cache_dir: project_dir.join("cache"),
            endpoints: Endpoints {
                registry_origin: "http://127.0.0.1:1".to_owned(),
                token_origin: "http://127.0.0.1:1".to_owned(),
                client_id: String::new(),
                client_secret: String::new(),
            },
            credential: None,
            offline: true,
            ui_origin: None,
        }
    }

    fn write_synthetic(project_dir: &Path) {
        let extension = project_dir.join("extensions-local/synthetic");
        std::fs::create_dir_all(extension.join("functions")).unwrap();
        std::fs::write(
            extension.join("extension.yaml"),
            "name: synthetic\nversion: 0.1.0\nspecVersion: v1beta\nresources:\n  - name: httpFn\n    type: firebaseextensions.v1beta.function\n    properties:\n      location: ${param:LOCATION}\n      runtime: nodejs22\n      httpsTrigger: {}\n  - name: storageFn\n    type: firebaseextensions.v1beta.function\n    properties:\n      location: ${LOCATION}\n      eventTrigger:\n        eventType: google.storage.object.finalize\n        resource: projects/_/buckets/${param:BUCKET}\nparams:\n  - param: LOCATION\n    type: select\n    default: us-central1\n    required: true\n  - param: BUCKET\n    type: string\n    default: ${STORAGE_BUCKET}\n    required: true\n  - param: API_KEY\n    type: secret\n    required: true\n  - param: DERIVED\n    type: string\n    default: ${param:LOCATION}-derived\n",
        )
        .unwrap();
        std::fs::write(extension.join("POSTINSTALL.md"), "# Synthetic\n").unwrap();
        std::fs::write(
            extension.join("functions/package.json"),
            "{\"name\":\"synthetic\"}",
        )
        .unwrap();
        std::fs::create_dir_all(project_dir.join("extensions")).unwrap();
        std::fs::write(
            project_dir.join("extensions/synthetic.env"),
            "LOCATION=europe-west1\nEVENTARC_CHANNEL=projects/${PROJECT_ID}/locations/us-central1/channels/firebase\nALLOWED_EVENT_TYPES=a.b.c,\n",
        )
        .unwrap();
        std::fs::write(
            project_dir.join("extensions/synthetic.env.local"),
            "NOTE=local\n",
        )
        .unwrap();
        std::fs::write(
            project_dir.join("extensions/synthetic.secret.local"),
            "API_KEY=secret-value\n",
        )
        .unwrap();
    }

    #[tokio::test]
    async fn local_extension_becomes_a_backend_like_the_official_emulator() {
        let directory = tempfile::tempdir().unwrap();
        write_synthetic(directory.path());
        let config = config(
            directory.path(),
            vec![(
                "synthetic".to_owned(),
                "./extensions-local/synthetic".to_owned(),
            )],
        );
        let (log, events) = LogSink::recording();
        let loaded = load(&config, &log).await.unwrap();
        assert_eq!(loaded.len(), 1);
        let backend = &loaded[0].backend;
        assert_eq!(loaded[0].origin, SourceOrigin::Local);
        assert_eq!(
            backend.functions_dir,
            std::fs::canonicalize(directory.path())
                .unwrap()
                .join("extensions-local/synthetic/functions")
        );
        assert_eq!(backend.env["PROJECT_ID"], "demo-fireside-functions-oracle");
        assert_eq!(backend.env["EXT_INSTANCE_ID"], "synthetic");
        assert_eq!(backend.env["LOCATION"], "europe-west1");
        assert_eq!(backend.env["NOTE"], "local");
        assert_eq!(
            backend.env["EVENTARC_CHANNEL"],
            "projects/demo-fireside-functions-oracle/locations/us-central1/channels/firebase"
        );
        assert_eq!(backend.env["ALLOWED_EVENT_TYPES"], "a.b.c");
        assert_eq!(
            backend.env["EVENTARC_CLOUD_EVENT_SOURCE"],
            "projects/demo-fireside-functions-oracle/instances/synthetic"
        );
        // Defaults stay literal; secrets never reach the non-secret env.
        assert_eq!(backend.env["BUCKET"], "${STORAGE_BUCKET}");
        assert_eq!(backend.env["DERIVED"], "${param:LOCATION}-derived");
        assert!(!backend.env.contains_key("API_KEY"));
        assert_eq!(backend.secret_values["API_KEY"], "secret-value");
        assert!(backend.secret_env.is_empty());
        let names: Vec<&str> = backend.definitions.iter().map(Definition::name).collect();
        assert_eq!(names, ["ext-synthetic-httpFn", "ext-synthetic-storageFn"]);
        assert_eq!(
            backend.definitions[0].json()["regions"],
            serde_json::json!(["europe-west1"])
        );
        assert_eq!(
            backend.definitions[1].json()["eventTrigger"]["resource"],
            "projects/_/buckets/${STORAGE_BUCKET}"
        );
        assert_eq!(
            backend.extension_spec.as_ref().unwrap()["postinstallContent"],
            "# Synthetic\n"
        );
        assert!(backend.extension.is_none());
        assert!(events.lock().unwrap().iter().any(|event| {
            event
                .message
                .contains("Function 'httpFn' is missing a trigger")
        }));
    }

    #[tokio::test]
    async fn missing_parameter_files_fail_like_the_official_planner() {
        let directory = tempfile::tempdir().unwrap();
        write_synthetic(directory.path());
        std::fs::remove_file(directory.path().join("extensions/synthetic.env")).unwrap();
        std::fs::remove_file(directory.path().join("extensions/synthetic.env.local")).unwrap();
        let config = config(
            directory.path(),
            vec![(
                "synthetic".to_owned(),
                "./extensions-local/synthetic".to_owned(),
            )],
        );
        let (log, _events) = LogSink::recording();
        let error = load(&config, &log).await.unwrap_err();
        assert_eq!(
            error.0,
            "Errors while reading 'extensions' in 'firebase.json'\n- No params file found for synthetic"
        );
    }

    #[tokio::test]
    async fn offline_refs_need_a_vendored_or_cached_source() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("extensions")).unwrap();
        std::fs::write(
            directory.path().join("extensions/stripe.env"),
            "LOCATION=us-central1\n",
        )
        .unwrap();
        let config = config(
            directory.path(),
            vec![(
                "stripe".to_owned(),
                "invertase/firestore-stripe-payments@0.3.12".to_owned(),
            )],
        );
        let (log, _events) = LogSink::recording();
        let error = load(&config, &log).await.unwrap_err();
        assert!(error.0.contains("is not vendored under"), "{}", error.0);
        // A vendored copy with its sidecar loads without any network.
        let vendored = directory
            .path()
            .join("extensions/.sources/invertase/firestore-stripe-payments@0.3.12");
        std::fs::create_dir_all(vendored.join("functions")).unwrap();
        std::fs::write(
            vendored.join("extension.yaml"),
            "name: firestore-stripe-payments\n",
        )
        .unwrap();
        std::fs::write(vendored.join("functions/package.json"), "{}").unwrap();
        source::write_sidecar(
            &vendored,
            &RegistrySidecar {
                extension: serde_json::json!({ "name": "publishers/invertase/extensions/firestore-stripe-payments" }),
                extension_version: serde_json::json!({
                    "name": "publishers/invertase/extensions/firestore-stripe-payments/versions/0.3.12",
                    "spec": { "name": "firestore-stripe-payments", "version": "0.3.12", "resources": [
                        { "name": "createCustomer", "type": "firebaseextensions.v1beta.function", "propertiesYaml": "location: ${param:LOCATION}\neventTrigger:\n  eventType: providers/firebase.auth/eventTypes/user.create\n  resource: projects/${param:PROJECT_ID}\n" }
                    ], "params": [{ "param": "LOCATION", "type": "select" }, { "param": "STRIPE_API_KEY", "type": "secret" }] }
                }),
            },
        )
        .unwrap();
        let loaded = load(&config, &log).await.unwrap();
        assert_eq!(loaded[0].origin, SourceOrigin::Vendored);
        let backend = &loaded[0].backend;
        assert_eq!(backend.definitions[0].name(), "ext-stripe-createCustomer");
        assert_eq!(
            backend.definitions[0].json()["eventTrigger"]["resource"],
            "projects/demo-fireside-functions-oracle"
        );
        assert_eq!(
            backend.definitions[0].json()["eventTrigger"]["service"],
            "firebaseauth.googleapis.com"
        );
        assert!(backend.extension_spec.is_none());
        // The displayed version is parameter-substituted like `toBackendInfo`.
        assert_eq!(
            backend.extension_version.as_ref().unwrap()["spec"]["resources"][0]["properties"]["location"],
            "us-central1"
        );
    }
}
