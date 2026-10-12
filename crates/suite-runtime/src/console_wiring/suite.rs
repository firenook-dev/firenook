//! The console's suite controls, built from the suite: the trigger registry
//! the hub also flips, the hub's channels, where the data lives and where an
//! export may go.

use std::path::Path;

use firenook_console_front::{
    DataFacts, DataMode, ExportDestination, SuiteControls, SuiteSettings,
};
use firenook_core_store::DiskDurability;
use firenook_functions_bridge::TriggerRegistry;
use firenook_suite_front::{BackgroundRequest, ExportCommand};
use tokio::sync::mpsc;

use crate::{SuiteConfig, native_state};

/// The suite controls of this run. `resumed` says whether this start
/// reused the previous native state (`--resume-state` with state to resume).
pub(crate) fn suite_controls(
    config: &SuiteConfig,
    triggers: &TriggerRegistry,
    background: Option<mpsc::UnboundedSender<BackgroundRequest>>,
    exporter: mpsc::Sender<ExportCommand>,
    resumed: bool,
) -> SuiteControls {
    SuiteControls::new(SuiteSettings {
        triggers: triggers.clone(),
        background,
        exporter,
        data: data_facts(config, resumed),
        destinations: destinations(config),
    })
}

fn shown(path: &Path) -> String {
    path.display().to_string()
}

/// Where the data lives, fixed for the engine's life.
pub(crate) fn data_facts(config: &SuiteConfig, resumed: bool) -> DataFacts {
    let disk = !config.firestore_in_memory;
    DataFacts {
        mode: if disk {
            DataMode::Disk
        } else {
            DataMode::Memory
        },
        state_dir: disk.then(|| shown(&config.state_dir)),
        resumed,
        // A resumed start skips the seed import.
        imported_from: config.import.as_deref().filter(|_| !resumed).map(shown),
        export_on_exit: config.export_on_exit.as_deref().map(shown),
        durability: match config.durability {
            DiskDurability::PerCommit => "per-commit",
            DiskDurability::WriteBehind { .. } => "write-behind",
        }
        .to_owned(),
    }
}

/// Where an export may be saved: the `--export-on-exit` folder, the
/// `--import` seed (never while the engine resumes its state from it) and
/// the project's own export folder. While resuming, a folder that overlaps
/// the seed or the state directory is refused with the engine's reason.
pub(crate) fn destinations(config: &SuiteConfig) -> Vec<ExportDestination> {
    let mut listed = Vec::new();
    let mut add = |id: &str, label: &str, path: &Path, refused: Option<String>| {
        let refused = refused.or_else(|| {
            config
                .resume_state
                .then(|| native_state::validate_export_destination(config, path).err())
                .flatten()
                .map(|error| {
                    format!(
                        "The engine will not export there: {}.",
                        error.to_string().trim_end_matches('.')
                    )
                })
        });
        listed.push(ExportDestination {
            id: id.to_owned(),
            label: label.to_owned(),
            path: shown(path),
            refused,
        });
    };
    if let Some(path) = &config.export_on_exit {
        add("export-on-exit", "The export-on-exit folder", path, None);
    }
    if let Some(path) = &config.import {
        add(
            "seed",
            "The import seed",
            path,
            config
                .resume_state
                .then(|| "The engine resumed its state, so the seed must not change.".to_owned()),
        );
    }
    add(
        "project",
        "The project's export folder",
        &config.project_dir.join("firenook-export"),
        None,
    );
    listed
}
