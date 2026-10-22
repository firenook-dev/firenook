//! What the suite tells the console's Overview about itself: how the engine
//! was started, what an app needs to reach each running service, and the
//! configuration notices worth a banner.
//!
//! The suite builds these from its configuration when it builds the
//! console; they live here, beside [`console_input`](crate::console_input),
//! because the suite reaches this crate and the console's own crate keeps
//! its types to itself. They are fixed for an engine run.

use serde::Serialize;
use ts_rs::TS;

/// `GET /overview/engine`: how this engine was started; fixed for its run.
/// Never repeats a data fact (state dir, resume, import seed, export on
/// exit, durability): the Overview reads those from the console status.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "observe/")]
pub struct OverviewEngineDetails {
    /// Absent for a console built without a suite (tests).
    pub config: Option<OverviewEngineConfig>,
    /// What an app needs to reach each running service.
    pub connection: OverviewConnection,
}

/// The engine's configuration, as the Overview's engine section shows it.
#[allow(
    clippy::struct_excessive_bools,
    reason = "independent facts about how the engine was started, each shown on its own"
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "observe/")]
pub struct OverviewEngineConfig {
    /// The address every listener is bound to (`--host`).
    pub host: String,
    /// The address clients connect to (a wildcard bind's loopback).
    pub connect_host: String,
    pub project_dir: String,
    pub firebase_json: String,
    /// Bounded Requests and coverage are kept (`--no-diagnostics` turns
    /// them off).
    pub diagnostics: bool,
    /// The `--debug-log` file, when one is written.
    pub debug_log: Option<String>,
    /// Requests that name another project are warned about.
    pub single_project_mode: bool,
    /// The Extensions registry is never contacted (`--offline`).
    pub offline: bool,
    /// The project id starts with `demo-`.
    pub demo_project: bool,
    /// The Node binary Functions run on.
    pub node: String,
    /// The bucket the SDKs use when none is named (the snippets'
    /// `storageBucket`).
    pub default_bucket: String,
    /// Started with `--only`: the services that were asked for, in the
    /// official order; empty when every service was started.
    pub selected: Vec<String>,
}

/// What an app needs to reach the running services.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[ts(export_to = "observe/")]
pub struct OverviewConnection {
    /// The environment variables the SDKs read, for running services only.
    pub env: Vec<OverviewEnvVariable>,
}

/// One environment variable an SDK reads to find an emulator.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "observe/")]
pub struct OverviewEnvVariable {
    pub name: String,
    pub value: String,
    /// The service it points at (`firestore`, `auth`, `storage`, `pubsub`,
    /// `hub`, `tasks`, `eventarc`), or `project` for the project id, the
    /// Firebase configuration and the credentials.
    pub service: String,
    /// Who sets it for you.
    pub set_by: OverviewEnvSource,
    /// One line shown beside it (the demo credentials file's content, for
    /// example).
    pub note: Option<String>,
}

/// Who sets an environment variable without the developer doing it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "observe/")]
pub enum OverviewEnvSource {
    /// `firenook emulators:exec` sets it for the command it runs (and
    /// Functions workers get it too).
    Exec,
    /// Only Functions workers get it. No variable is listed so at present:
    /// `emulators:exec` sets the Tasks and Eventarc hosts too, as the
    /// official one does.
    Functions,
}

/// A configuration the terminal prints once at startup and the Overview
/// keeps showing: a non-demo project, a public listen address, emulators
/// missing while Functions run, diagnostics off.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export_to = "observe/")]
pub struct OverviewNotice {
    pub level: OverviewNoticeLevel,
    /// `nonDemoProject`, `missingEmulators`, `publicHost`,
    /// `diagnosticsOff`: the console remembers a dismissal by it.
    pub code: String,
    pub message: String,
}

/// How a notice is drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "observe/")]
pub enum OverviewNoticeLevel {
    Info,
    Warn,
}

/// Picks a fresh staging folder for a snapshot (not created yet), or says
/// why none can be used.
pub type SnapshotStaging =
    std::sync::Arc<dyn Fn() -> Result<std::path::PathBuf, String> + Send + Sync>;
/// Bytes free on the volume holding a path, when the platform can tell.
pub type SnapshotFreeSpace = std::sync::Arc<dyn Fn(&std::path::Path) -> Option<u64> + Send + Sync>;
/// About how many bytes an export of these services writes.
pub type SnapshotSize =
    std::sync::Arc<dyn Fn(&std::collections::BTreeSet<String>) -> u64 + Send + Sync>;

/// What the console's snapshot download needs from the suite: the suite
/// exporter (the hub's export channel, one export at a time), where to
/// stage an export, how much room one needs and how much there is.
#[derive(Clone)]
pub struct SnapshotPort {
    /// The suite exporter's channel.
    pub exporter: tokio::sync::mpsc::Sender<crate::ExportCommand>,
    /// A fresh staging folder beside the state directory, checked against
    /// the state directory and the import seed.
    pub staging: SnapshotStaging,
    /// Bytes free next to a staging folder (Unix); `None` elsewhere.
    pub free_space: SnapshotFreeSpace,
    /// About how many bytes an export of the named services writes.
    pub size: SnapshotSize,
    /// The services an export can cover in this engine: `firestore`,
    /// `auth`, `storage`, those that run.
    pub targets: Vec<String>,
    /// The project id, which names the archive.
    pub project: String,
}

impl std::fmt::Debug for SnapshotPort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SnapshotPort")
            .field("targets", &self.targets)
            .field("project", &self.project)
            .finish_non_exhaustive()
    }
}
