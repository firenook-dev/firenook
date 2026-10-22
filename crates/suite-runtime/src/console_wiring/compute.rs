//! The compute stream's part of the console: Functions, Extensions and
//! Eventarc, built from the running suite.
//!
//! The Monitor exists before Functions start (`parts`), so the console
//! answers from it while discovery runs; the runtime records into it
//! (`functions_options`), and once Functions are up `ready` hands the
//! console the runtime's routers, its control handle and the Extensions
//! control, and starts the watcher that reloads an Extensions instance
//! when one of its parameter files changes on disk. `before_finish` stops
//! that watcher.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use firenook_console_front::{ComputeConsole, ComputeParts};
use firenook_extensions::control::{ExtensionsControl, instance_file};
use firenook_functions_bridge::FunctionsInventory;
use firenook_functions_runtime::watcher::{SourceWatcher, WatchMode};
use firenook_functions_runtime::{LogEvent, LogSink, Monitor, MonitorLimits};
use firenook_suite_front::LoggingRuntime;

use super::{FunctionsConsoleOptions, HookContext};
use crate::SuiteConfig;

/// The directory Extensions parameter files live in.
const EXTENSIONS_DIRECTORY: &str = "extensions";

/// What compute's console needs from before Functions start, created
/// before the console is built: the Monitor the runtime will record into,
/// the Functions address as apps reach it, and which services run (a
/// function whose events come from a service that is not running says so).
pub(crate) fn parts(config: &SuiteConfig) -> ComputeParts {
    let selected = config.services;
    let services: BTreeSet<String> = [
        ("firestore", selected.firestore),
        ("auth", selected.auth),
        ("storage", selected.storage),
        ("pubsub", selected.pubsub),
    ]
    .into_iter()
    .filter(|(_, running)| *running)
    .map(|(service, _)| service.to_owned())
    .collect();
    ComputeParts::for_suite(
        Monitor::new(MonitorLimits::default()),
        Some(config.origin(config.ports.functions)),
        Some(services),
    )
}

/// The suite's services are prepared; the console is not built yet.
pub(crate) fn prepared(_context: &HookContext<'_>) {}

/// The Functions runtime is about to start: it records into compute's
/// Monitor and hands its Extensions over through the parts.
pub(crate) fn functions_options(context: &HookContext<'_>, options: &mut FunctionsConsoleOptions) {
    options.compute = context.compute.cloned();
}

/// Functions have started (called right after the runtime is up, with the
/// inventory it discovered): hands the runtime to the console, whose
/// Functions, Extensions and Eventarc sections then turn ready, and starts
/// the Extensions parameter-file watcher.
pub(crate) fn ready(context: &HookContext<'_>) {
    let (Some(parts), Some(functions)) = (context.compute, context.functions) else {
        return;
    };
    let config = context.config;
    let extensions =
        parts
            .take_extensions()
            .and_then(|outcome| match crate::extensions_config(config) {
                Ok(loader) => Some(ExtensionsControl::new(
                    loader,
                    &outcome,
                    functions.console(),
                    parts.monitor().clone(),
                    functions_log(context.logging),
                )),
                Err(error) => {
                    context.logging.record(
                        "ERROR",
                        Some("extensions"),
                        format!("Extensions cannot be managed from the console: {error}"),
                    );
                    None
                }
            });
    parts.hand_over(functions.console(), extensions.clone());
    parts.late.set(ComputeConsole {
        functions: functions.router(),
        eventarc: functions.eventarc_router(),
    });
    if let Some(extensions) = extensions {
        match watch_parameter_files(&config.project_dir, extensions) {
            Ok(watcher) => parts.keep_watcher(watcher),
            Err(error) => context.logging.record(
                "WARN",
                Some("extensions"),
                format!(
                    "Extension parameter files are not watched, so an edit needs Reload in the console: {error}"
                ),
            ),
        }
    }
}

/// The suite is stopping (see `before_finish` in `mod.rs` for the order):
/// the parameter-file watchers stop.
#[allow(
    clippy::unused_async,
    reason = "the hook's call site awaits every stream's stop work"
)]
pub(crate) async fn before_finish(context: &HookContext<'_>) {
    if let Some(parts) = context.compute {
        parts.stop_watchers();
    }
}

/// Functions reloaded and routing was refreshed for the inventory.
pub(crate) fn inventory_refreshed(_context: &HookContext<'_>, _inventory: &FunctionsInventory) {}

/// The Functions runtime's log as the suite prints and records it. The
/// terminal shows every event as it would have before lines were attributed
/// (a worker's `console` line at its stream's level, one per line; nothing
/// for a console-only line); observe's `functions_input` turns the
/// attributed event into the console's entry and the official records,
/// which keep today's text and level.
pub(crate) fn functions_log(logging: &LoggingRuntime) -> LogSink {
    let logging = logging.clone();
    LogSink::new(move |event: LogEvent| {
        if crate::terminal::enabled() {
            crate::terminal::functions_line(&event);
        } else {
            for printed in event.compatible_events() {
                let line = format!("{}: {}", printed.label, printed.message);
                match printed.level.as_str() {
                    "ERROR" | "WARN" => eprintln!("firenook {line}"),
                    "DEBUG" => {}
                    _ => println!("firenook {line}"),
                }
            }
        }
        logging.emit(super::observe::functions_input(&event));
    })
}

/// Watches the project directory for `extensions/` appearing (or being
/// replaced) and `extensions/` itself for an instance's `<id>.env*` and
/// `<id>.secret.local`; each change reaches the Extensions control, which
/// ignores the console's own writes and reloads the instance under its
/// lock. The returned watcher owns the inner one: stopping it stops both.
fn watch_parameter_files(
    project_dir: &Path,
    extensions: ExtensionsControl,
) -> Result<SourceWatcher, String> {
    let directory = project_dir.join(EXTENSIONS_DIRECTORY);
    let inner: Arc<Mutex<Option<SourceWatcher>>> = Arc::new(Mutex::new(None));
    if directory.is_dir() {
        let watcher = watch_extensions_directory(&directory, extensions.clone())?;
        *inner.lock().unwrap_or_else(PoisonError::into_inner) = Some(watcher);
    }
    let held = Arc::clone(&inner);
    SourceWatcher::start(
        project_dir,
        WatchMode::NonRecursive,
        |path| {
            path.file_name()
                .is_some_and(|name| name == EXTENSIONS_DIRECTORY)
        },
        move |_| {
            // `extensions/` appeared or was replaced: watch the new one, and
            // read the parameter files written with it, which arrived before
            // its watcher did.
            if !directory.is_dir() {
                return;
            }
            match watch_extensions_directory(&directory, extensions.clone()) {
                Ok(watcher) => {
                    let replaced = held
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .replace(watcher);
                    if let Some(old) = replaced {
                        old.stop();
                    }
                }
                Err(error) => crate::terminal::print(
                    "ERROR",
                    "extensions",
                    &error,
                    &format!("firenook extensions: {error}"),
                ),
            }
            let present = parameter_files(&directory, &extensions);
            if !present.is_empty() {
                let extensions = extensions.clone();
                tokio::spawn(async move { extensions.files_changed(present).await });
            }
        },
    )
    .map_err(|error| error.0)
}

/// Watches `extensions/` itself for the instances' parameter files.
fn watch_extensions_directory(
    directory: &Path,
    extensions: ExtensionsControl,
) -> Result<SourceWatcher, String> {
    let instances: Vec<String> = extensions
        .config()
        .extensions
        .iter()
        .map(|(id, _)| id.clone())
        .collect();
    SourceWatcher::start(
        directory,
        WatchMode::NonRecursive,
        move |path| is_parameter_file(path, &instances),
        move |paths| {
            let extensions = extensions.clone();
            tokio::spawn(async move { extensions.files_changed(paths).await });
        },
    )
    .map_err(|error| error.0)
}

/// `<instance>.env`, `<instance>.env.<suffix>` or
/// `<instance>.secret.local` directly in an `extensions/` directory.
fn is_parameter_file(path: &Path, instances: &[String]) -> bool {
    let in_directory = path
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|name| name == EXTENSIONS_DIRECTORY);
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    in_directory && instances.iter().any(|id| instance_file(id, name))
}

/// Every parameter file in `directory` that belongs to an instance.
fn parameter_files(directory: &Path, extensions: &ExtensionsControl) -> Vec<PathBuf> {
    let instances: Vec<String> = extensions
        .config()
        .extensions
        .iter()
        .map(|(id, _)| id.clone())
        .collect();
    std::fs::read_dir(directory)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| is_parameter_file(path, &instances))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "compute_tests.rs"]
mod tests;
