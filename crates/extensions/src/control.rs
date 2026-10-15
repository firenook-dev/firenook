//! The running Extension instances and what the console (and the suite's
//! env-file watcher) may do to them: reload one in place, reconfigure it
//! (writing the file that actually set each value, and putting every file
//! back when the new values do not load), read a secret. Vendoring a source
//! is the CLI's (`firenook ext:vendor`); a reload then loads the copy.
//!
//! One operation at a time per instance: reload, reconfigure and a
//! watcher's `files_changed` take the instance's lock first, and the
//! console's own writes are recognised by their content, so one Save
//! reloads once.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use firenook_functions_runtime::console::ConsoleHandle;
use firenook_functions_runtime::dotenv::content_hash;
use firenook_functions_runtime::env_files::{self, KeyChange};
use firenook_functions_runtime::{LogEvent, LogSink, Monitor};
use serde_json::Value;
use tokio::sync::{Mutex, RwLock};

use crate::params::{ENV_DIRECTORY, validate};
use crate::refs::is_local_path;
use crate::{
    DroppedExtension, ExtensionsConfig, ExtensionsError, InstanceStatus, LoadOutcome,
    LoadedExtension,
};

/// Where an instance stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtensionState {
    Running,
    Loading,
    Failed,
}

/// What the console shows of one instance: the loaded extension and its
/// state.
#[derive(Debug, Clone)]
pub struct InstanceState {
    /// The extension as last loaded; the previous one keeps serving after a
    /// failed reload.
    pub loaded: Option<LoadedExtension>,
    pub state: ExtensionState,
    pub error: Option<String>,
    /// Its source state (`extensions status`).
    pub status: InstanceStatus,
}

/// One unacceptable value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParamProblem {
    pub param: String,
    pub message: String,
}

/// Why a reconfigure did not happen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconfigureError {
    NotFound(String),
    /// Every unacceptable value at once; nothing was written.
    Invalid(Vec<ParamProblem>),
    /// The new values did not load; every file was put back.
    LoadFailed {
        message: String,
        detail: String,
    },
    /// A file could not be written.
    Write(String),
}

/// What a reconfigure wrote and the state it left.
#[derive(Debug, Clone)]
pub struct Reconfigured {
    /// The files written, relative to the project (`extensions/greeter.env`).
    pub written: Vec<String>,
    pub state: InstanceState,
}

/// The running instances, their state, and the operations on them.
#[derive(Clone)]
pub struct ExtensionsControl {
    inner: Arc<Inner>,
}

struct Inner {
    config: ExtensionsConfig,
    instances: RwLock<BTreeMap<String, InstanceState>>,
    /// One per configured instance, created up front.
    locks: BTreeMap<String, Arc<Mutex<()>>>,
    /// Files the console wrote, with the hash each holds now (`None`:
    /// removed).
    self_writes: std::sync::Mutex<BTreeMap<PathBuf, Option<[u8; 32]>>>,
    dropped: Vec<DroppedExtension>,
    runtime: ConsoleHandle,
    monitor: Monitor,
    log: LogSink,
}

impl std::fmt::Debug for ExtensionsControl {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExtensionsControl")
            .field("instances", &self.inner.locks.keys().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

impl ExtensionsControl {
    /// The control over what a start loaded.
    #[must_use]
    pub fn new(
        config: ExtensionsConfig,
        outcome: &LoadOutcome,
        runtime: ConsoleHandle,
        monitor: Monitor,
        log: LogSink,
    ) -> Self {
        let statuses = crate::status(&config);
        let instances = outcome
            .loaded
            .iter()
            .map(|loaded| {
                let id = loaded.backend.instance_id.clone();
                let status = status_of(&statuses, &id, &loaded.written);
                (
                    id,
                    InstanceState {
                        loaded: Some(loaded.clone()),
                        state: ExtensionState::Running,
                        error: None,
                        status,
                    },
                )
            })
            .collect();
        let locks = config
            .extensions
            .iter()
            .map(|(id, _)| (id.clone(), Arc::new(Mutex::new(()))))
            .collect();
        Self {
            inner: Arc::new(Inner {
                config,
                instances: RwLock::new(instances),
                locks,
                self_writes: std::sync::Mutex::new(BTreeMap::new()),
                dropped: outcome.dropped.clone(),
                runtime,
                monitor,
                log,
            }),
        }
    }

    /// The loader configuration the instances come from.
    #[must_use]
    pub fn config(&self) -> &ExtensionsConfig {
        &self.inner.config
    }

    /// Every running instance, in `firebase.json` order.
    pub async fn instances(&self) -> Vec<(String, InstanceState)> {
        let instances = self.inner.instances.read().await;
        self.inner
            .config
            .extensions
            .iter()
            .filter_map(|(id, _)| instances.get(id).map(|state| (id.clone(), state.clone())))
            .collect()
    }

    /// One instance.
    pub async fn instance(&self, instance_id: &str) -> Option<InstanceState> {
        self.inner.instances.read().await.get(instance_id).cloned()
    }

    /// Instances left out at start for triggers the suite does not emulate.
    #[must_use]
    pub fn dropped(&self) -> &[DroppedExtension] {
        &self.inner.dropped
    }

    fn lock_of(&self, instance_id: &str) -> Option<Arc<Mutex<()>>> {
        self.inner.locks.get(instance_id).cloned()
    }

    /// Loads an instance again from its files and swaps it into the runtime.
    pub async fn reload(&self, instance_id: &str) -> Result<InstanceState, ExtensionsError> {
        let lock = self.known(instance_id).await?;
        let _held = lock.lock().await;
        self.reload_held(instance_id).await
    }

    async fn known(&self, instance_id: &str) -> Result<Arc<Mutex<()>>, ExtensionsError> {
        if !self.inner.instances.read().await.contains_key(instance_id) {
            return Err(ExtensionsError(format!(
                "There is no running extension instance {instance_id}."
            )));
        }
        self.lock_of(instance_id).ok_or_else(|| {
            ExtensionsError(format!("There is no extension instance {instance_id}."))
        })
    }

    /// `load_instance` → `replace_extension` → the new state, with the
    /// instance's lock held by the caller.
    async fn reload_held(&self, instance_id: &str) -> Result<InstanceState, ExtensionsError> {
        self.set_state(instance_id, ExtensionState::Loading, None)
            .await;
        let loaded =
            match crate::load_instance(&self.inner.config, instance_id, &self.inner.log).await {
                Ok(loaded) => loaded,
                Err(error) => {
                    self.set_state(instance_id, ExtensionState::Failed, Some(error.0.clone()))
                        .await;
                    return Err(error);
                }
            };
        if let Err(error) = self
            .inner
            .runtime
            .replace_extension(loaded.backend.clone())
            .await
        {
            let message = error.to_string();
            self.set_state(instance_id, ExtensionState::Failed, Some(message.clone()))
                .await;
            return Err(ExtensionsError(message));
        }
        let statuses = crate::status(&self.inner.config);
        let state = InstanceState {
            status: status_of(&statuses, instance_id, &loaded.written),
            loaded: Some(loaded),
            state: ExtensionState::Running,
            error: None,
        };
        self.inner
            .instances
            .write()
            .await
            .insert(instance_id.to_owned(), state.clone());
        self.inner.monitor.extension_changed(instance_id);
        Ok(state)
    }

    async fn set_state(&self, instance_id: &str, state: ExtensionState, error: Option<String>) {
        let mut instances = self.inner.instances.write().await;
        if let Some(entry) = instances.get_mut(instance_id) {
            entry.state = state;
            entry.error = error;
        }
        drop(instances);
        self.inner.monitor.extension_changed(instance_id);
    }

    /// Validates every changed param (all problems at once), writes each
    /// value to the file that set it (or `extensions/<id>.env`) and secrets
    /// to `extensions/<id>.secret.local`, reloads once, and puts every file
    /// back when the new values do not load.
    pub async fn reconfigure(
        &self,
        instance_id: &str,
        values: BTreeMap<String, String>,
        secrets: BTreeMap<String, String>,
    ) -> Result<Reconfigured, ReconfigureError> {
        let lock = self
            .known(instance_id)
            .await
            .map_err(|error| ReconfigureError::NotFound(error.0))?;
        let _held = lock.lock().await;
        let current = self
            .instance(instance_id)
            .await
            .and_then(|state| state.loaded)
            .ok_or_else(|| {
                ReconfigureError::NotFound(format!("{instance_id} has not loaded yet."))
            })?;
        let spec_params: Vec<Value> = current
            .spec
            .get("params")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let problems = problems(&spec_params, &values, &secrets);
        if !problems.is_empty() {
            return Err(ReconfigureError::Invalid(problems));
        }
        if values.is_empty() && secrets.is_empty() {
            return Err(ReconfigureError::Invalid(vec![ParamProblem {
                param: String::new(),
                message: "There is nothing to change.".to_owned(),
            }]));
        }
        let (files, writes) = self
            .planned_writes(instance_id, &current, values, secrets)
            .await?;
        let written =
            tokio::task::spawn_blocking(move || env_files::write_files_atomically(writes))
                .await
                .map_err(|error| ReconfigureError::Write(error.to_string()))?
                .map_err(|error| ReconfigureError::Write(error.to_string()))?;
        self.note_writes(
            written
                .hashes()
                .into_iter()
                .map(|(path, hash)| (path, Some(hash))),
        );
        match self.reload_held(instance_id).await {
            Ok(state) => Ok(Reconfigured {
                written: files,
                state,
            }),
            Err(error) => {
                let restored = written.restore();
                if let Ok(restored) = &restored {
                    self.note_writes(restored.iter().cloned());
                }
                // The previous values never stopped serving.
                {
                    let mut instances = self.inner.instances.write().await;
                    if let Some(entry) = instances.get_mut(instance_id) {
                        entry.state = ExtensionState::Running;
                        entry.error = None;
                    }
                }
                self.inner.monitor.extension_changed(instance_id);
                Err(ReconfigureError::LoadFailed {
                    message: format!(
                        "{instance_id} did not load with these values, so your files were put back."
                    ),
                    detail: match restored {
                        Ok(_) => error.0,
                        Err(restore) => {
                            format!("{} (putting the files back failed: {restore})", error.0)
                        }
                    },
                })
            }
        }
    }

    /// Each changed key's file (the instance's own file that set it, else
    /// `extensions/<id>.env`; secrets in `extensions/<id>.secret.local`)
    /// and that file's new text. Returns the files, relative to the
    /// project, and the writes.
    async fn planned_writes(
        &self,
        instance_id: &str,
        current: &LoadedExtension,
        values: BTreeMap<String, String>,
        secrets: BTreeMap<String, String>,
    ) -> Result<(Vec<String>, Vec<(PathBuf, String)>), ReconfigureError> {
        let project = &self.inner.config.project_dir;
        let own_prefix = format!("{ENV_DIRECTORY}/{instance_id}.env");
        let default_file = format!("{ENV_DIRECTORY}/{instance_id}.env");
        let mut by_file: BTreeMap<String, Vec<KeyChange>> = BTreeMap::new();
        for (key, value) in values {
            let file = current
                .param_sources
                .get(&key)
                .filter(|file| file.starts_with(&own_prefix))
                .cloned()
                .unwrap_or_else(|| default_file.clone());
            by_file.entry(file).or_default().push(KeyChange {
                key,
                value: Some(value),
            });
        }
        let secret_file = format!("{ENV_DIRECTORY}/{instance_id}.secret.local");
        for (key, value) in secrets {
            by_file
                .entry(secret_file.clone())
                .or_default()
                .push(KeyChange {
                    key,
                    value: Some(value),
                });
        }
        let mut writes = Vec::with_capacity(by_file.len());
        for (file, changes) in &by_file {
            let path = project.join(file);
            let text = match tokio::fs::read_to_string(&path).await {
                Ok(text) => text,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(error) => return Err(ReconfigureError::Write(format!("{file}: {error}"))),
            };
            writes.push((path, env_files::edit_env_file(&text, changes)));
        }
        Ok((by_file.into_keys().collect(), writes))
    }

    fn note_writes(&self, files: impl IntoIterator<Item = (PathBuf, Option<[u8; 32]>)>) {
        let mut writes = self
            .inner
            .self_writes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for (path, hash) in files {
            writes.insert(written_key(&path), hash);
        }
    }

    /// A secret param's value, read from `extensions/<id>.secret.local` now.
    pub async fn secret(&self, instance_id: &str, param: &str) -> Option<String> {
        let path = self
            .inner
            .config
            .project_dir
            .join(ENV_DIRECTORY)
            .join(format!("{instance_id}.secret.local"));
        let text = tokio::fs::read_to_string(path).await.ok()?;
        firenook_functions_runtime::dotenv::parse(&text)
            .envs
            .get(param)
            .cloned()
    }

    /// The suite's env-file watcher reports changed files: each instance
    /// whose `extensions/<id>.env*` or `.secret.local` changed to content
    /// the console did not write reloads, under its lock.
    pub async fn files_changed(&self, paths: Vec<PathBuf>) {
        let mut by_instance: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
        for path in paths {
            let Some(name) = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
            else {
                continue;
            };
            if let Some(id) = self.inner.locks.keys().find(|id| instance_file(id, &name)) {
                by_instance.entry(id.clone()).or_default().push(path);
            }
        }
        for (instance_id, paths) in by_instance {
            let Some(lock) = self.lock_of(&instance_id) else {
                continue;
            };
            let _held = lock.lock().await;
            if !self.inner.instances.read().await.contains_key(&instance_id) {
                continue;
            }
            let mut changed = false;
            for path in &paths {
                let current = tokio::fs::read(path)
                    .await
                    .ok()
                    .map(|bytes| content_hash(&bytes));
                let key = written_key(path);
                let mut writes = self
                    .inner
                    .self_writes
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if writes.get(&key).copied() != Some(current) {
                    // The file moved on from what the console wrote: an
                    // edit. Forget the write, so the same bytes written
                    // again later by someone else are an edit too.
                    writes.remove(&key);
                    changed = true;
                }
            }
            if !changed {
                continue;
            }
            self.inner.log.record(
                LogEvent::new(
                    "INFO",
                    &format!("extensions[{instance_id}]"),
                    "parameters changed on disk, reloading".to_owned(),
                )
                .with_codebase(instance_id.clone()),
            );
            if let Err(error) = self.reload_held(&instance_id).await {
                self.inner.log.record(
                    LogEvent::new(
                        "ERROR",
                        &format!("extensions[{instance_id}]"),
                        format!("the changed parameters did not load: {error}"),
                    )
                    .with_codebase(instance_id.clone()),
                );
            }
        }
    }
}

/// The key a written file is remembered under: its directory's canonical
/// spelling and its name. The console writes through the project path it was
/// given, and the watcher reports the path the operating system resolved
/// (macOS's `/var` is `/private/var`), so the two must meet on one spelling
/// or the console's own write reads as an edit and reloads twice. The
/// directory, not the file, is resolved, so a file that was just removed
/// keys the same way.
fn written_key(path: &std::path::Path) -> PathBuf {
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => parent
            .canonicalize()
            .map_or_else(|_| path.to_path_buf(), |parent| parent.join(name)),
        _ => path.to_path_buf(),
    }
}

/// Whether a file name is one of an instance's parameter files:
/// `<id>.env`, `<id>.env.<suffix>` or `<id>.secret.local`.
#[must_use]
pub fn instance_file(instance_id: &str, name: &str) -> bool {
    let Some(rest) = name
        .strip_prefix(instance_id)
        .and_then(|rest| rest.strip_prefix('.'))
    else {
        return false;
    };
    rest == "env"
        || rest
            .strip_prefix("env.")
            .is_some_and(|suffix| !suffix.is_empty())
        || rest == "secret.local"
}

fn problems(
    spec_params: &[Value],
    values: &BTreeMap<String, String>,
    secrets: &BTreeMap<String, String>,
) -> Vec<ParamProblem> {
    let find = |name: &str| {
        spec_params
            .iter()
            .find(|param| param.get("param").and_then(Value::as_str) == Some(name))
    };
    let is_secret = |param: &Value| {
        param
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind.eq_ignore_ascii_case("secret"))
    };
    let mut problems = Vec::new();
    for (name, value) in values {
        let problem = match find(name) {
            None => Some("The extension declares no such parameter.".to_owned()),
            Some(param) if is_secret(param) => {
                Some("This is a secret: set it as a secret.".to_owned())
            }
            // `immutable` binds an installed instance in production. Nothing
            // is installed here: the emulator reads the parameter files on
            // every load, so changing one (a function's location, say) is
            // what editing the file by hand would do, and is allowed.
            Some(param) => validate(param, Some(value)),
        };
        if let Some(message) = problem {
            problems.push(ParamProblem {
                param: name.clone(),
                message,
            });
        }
    }
    for (name, value) in secrets {
        let problem = match find(name) {
            None => Some("The extension declares no such parameter.".to_owned()),
            Some(param) if !is_secret(param) => Some("This is not a secret parameter.".to_owned()),
            Some(param) => validate(param, Some(value)),
        };
        if let Some(message) = problem {
            problems.push(ParamProblem {
                param: name.clone(),
                message,
            });
        }
    }
    problems
}

fn status_of(statuses: &[InstanceStatus], instance_id: &str, written: &str) -> InstanceStatus {
    statuses
        .iter()
        .find(|status| status.instance_id == instance_id)
        .cloned()
        .unwrap_or_else(|| InstanceStatus {
            instance_id: instance_id.to_owned(),
            written: written.to_owned(),
            kind: if is_local_path(written) {
                "local"
            } else {
                "registry"
            },
            version: None,
            source: None,
            source_dir: None,
            sidecar: false,
            offline_ready: false,
            params_found: false,
            note: None,
        })
}

#[cfg(test)]
mod tests;
