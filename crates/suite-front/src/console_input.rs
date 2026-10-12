//! What a producer hands the suite log, so a line reaches the console as a
//! structured entry.
//!
//! Every notable thing the engine does is a line with a level, the service
//! that wrote it, and, when it is an event rather than plain output, a
//! machine-readable `kind` and the things it is about (`refs`). Producers
//! build a [`LogInput`] and give it to
//! [`LoggingRuntime::emit`](crate::LoggingRuntime::emit), which writes the
//! official Logging record and the `--debug-log` line exactly as the suite
//! always has and hands the line to the console's [`ConsoleSink`] when a
//! console runs. The console log itself (the ring, cursors, filters) is the
//! console's; this crate only defines what crosses into it, because every
//! producer reaches this crate and none reaches the console's.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::entity::EntityRef;

/// How serious a line is.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS,
)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "observe/")]
pub enum LogLevel {
    /// Detail a developer asks for.
    Debug,
    /// Routine output and events.
    #[default]
    Info,
    /// Something that may need attention.
    Warn,
    /// Something failed.
    Error,
}

impl LogLevel {
    /// Every level, least serious first.
    pub const ALL: [Self; 4] = [Self::Debug, Self::Info, Self::Warn, Self::Error];

    /// Reads any level spelling the engine and the SDKs use: DEBUG; INFO,
    /// NOTICE, DEFAULT, BULLET, SUCCESS, USER; WARN, WARNING; ERROR,
    /// CRITICAL, ALERT, EMERGENCY. Case-insensitive; anything else is info.
    #[must_use]
    pub fn parse(text: &str) -> Self {
        let text = text.trim();
        let is = |word: &str| text.eq_ignore_ascii_case(word);
        if is("debug") {
            Self::Debug
        } else if is("warn") || is("warning") {
            Self::Warn
        } else if is("error") || is("critical") || is("alert") || is("emergency") {
            Self::Error
        } else {
            Self::Info
        }
    }

    /// The level as the console writes it: `debug`, `info`, `warn`, `error`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }

    /// The level as the suite's own lines have always carried it in the
    /// official Logging feed and the debug log: `DEBUG`, `INFO`, `WARN`,
    /// `ERROR`.
    #[must_use]
    pub const fn legacy(self) -> &'static str {
        match self {
            Self::Debug => "DEBUG",
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        }
    }
}

/// Who receives a line besides the console.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Audience {
    /// The console, the official Logging feed and the `--debug-log` file.
    #[default]
    Everyone,
    /// The console only: events the official feed never carried (rules
    /// denials, diagnostics the suite only ever printed).
    Console,
}

/// What a producer hands the log; the console log assigns the cursor and
/// the time.
#[derive(Clone, Debug, Default)]
pub struct LogInput {
    /// How serious the line is, for the console.
    pub level: LogLevel,
    /// The emulator that wrote it: `hub`, `firestore`, `auth`, `storage`,
    /// `functions`, `pubsub`, `eventarc` or `tasks`. Extension output is
    /// `functions` with `extension` set.
    pub service: String,
    /// The label the terminal prints, when narrower than the service, such
    /// as `functions[us-central1-hello]`.
    pub source: Option<String>,
    /// The Functions trigger id the line belongs to.
    pub function: Option<String>,
    /// The extension instance that wrote it.
    pub extension: Option<String>,
    /// The Functions codebase that wrote it.
    pub codebase: Option<String>,
    /// The invocation it was written during (the Functions monitor's id).
    pub execution: Option<String>,
    /// What happened, one of [`kinds`]; `None` for plain output.
    pub kind: Option<&'static str>,
    /// The line as the console shows it.
    pub message: String,
    /// Structured fields: a logger call's fields, or the details of an event
    /// the engine describes. An object also reaches the official record as
    /// `data.user`.
    pub payload: Option<serde_json::Value>,
    /// What the line is about, for links into other sections.
    pub refs: Vec<EntityRef>,
    /// Who receives it besides the console.
    pub audience: Audience,
    /// The exact text the official feed and the debug-log file have always
    /// carried for this line, when it differs from `message` (a label
    /// prefix). A multi-line text becomes one official record per line.
    pub legacy_text: Option<String>,
    /// The level the official feed has always carried for this line, when
    /// it differs from `level` (user output: `INFO` for stdout methods,
    /// `WARN` for stderr ones).
    pub legacy_level: Option<&'static str>,
    /// The emulator name the official feed has always carried, when it
    /// differs from `service` (Eventarc lines were filed under functions).
    pub legacy_emulator: Option<&'static str>,
}

/// Where [`LoggingRuntime::emit`](crate::LoggingRuntime::emit) hands every
/// line meant for the console.
pub trait ConsoleSink: Send + Sync + 'static {
    /// Takes one line. Never blocks: no I/O, no await, two short locks at
    /// most, because every producer calls it on its own path.
    fn accept(&self, input: LogInput);
}

/// Every kind of line the engine writes, with its English label and how the
/// console treats it.
///
/// Each kind is declared once, here, in the block of the stream whose lines
/// carry it; a stream that needs a new kind appends it to its own block.
/// `problem` kinds are kept longer and counted as problems, `marker` kinds
/// draw a divider in the feed, and `internal` kinds are engine bookkeeping
/// the feed hides unless asked for.
pub mod kinds {
    use serde::Serialize;
    use ts_rs::TS;

    /// One kind of line, as the console labels and treats it.
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
    #[ts(export_to = "observe/")]
    pub struct LogKindInfo {
        /// The kind, such as `function.failed`.
        pub kind: &'static str,
        /// What the console calls it, in sentence case.
        pub label: &'static str,
        /// A problem: kept longer than plain lines, counted and badged.
        pub problem: bool,
        /// A moment worth a divider in the feed.
        pub marker: bool,
        /// Engine bookkeeping, hidden unless the filter asks for it.
        pub internal: bool,
    }

    const fn plain(kind: &'static str, label: &'static str) -> LogKindInfo {
        LogKindInfo {
            kind,
            label,
            problem: false,
            marker: false,
            internal: false,
        }
    }

    const fn problem(kind: &'static str, label: &'static str) -> LogKindInfo {
        LogKindInfo {
            problem: true,
            ..plain(kind, label)
        }
    }

    const fn marker(kind: &'static str, label: &'static str) -> LogKindInfo {
        LogKindInfo {
            marker: true,
            ..plain(kind, label)
        }
    }

    const fn internal(kind: &'static str, label: &'static str) -> LogKindInfo {
        LogKindInfo {
            internal: true,
            ..plain(kind, label)
        }
    }

    // The engine, Firestore and the suite (observe and the foundation).

    /// Every service is ready; payload `{ functions }`.
    pub const ENGINE_READY: &str = "engine.ready";
    /// "X configured at …" at startup.
    pub const ENGINE_CONFIGURED: &str = "engine.configured";
    /// A startup banner warning.
    pub const ENGINE_NOTICE: &str = "engine.notice";
    /// The Functions host's readiness receipt.
    pub const FUNCTIONS_RECEIPT: &str = "functions.receipt";
    /// The Functions inventory reloaded; payload `{ count }`.
    pub const FUNCTIONS_RELOADED: &str = "functions.reloaded";
    /// Background triggers paused or resumed; payload `{ enabled, since }`.
    pub const HUB_BACKGROUND_TRIGGERS: &str = "hub.backgroundTriggers";
    /// A client request the Firestore rules refused.
    pub const RULES_DENIED: &str = "rules.denied";
    /// A console request the Firestore rules refused (viewing as someone).
    pub const RULES_DENIED_CONSOLE: &str = "rules.denied.console";
    /// A rules file reloaded after a change; payload `{ database }`.
    pub const RULES_RELOADED: &str = "rules.reloaded";
    /// A rules file that could not be read or did not compile.
    pub const RULES_FILE_ERROR: &str = "rules.fileError";
    /// New rules took effect, from the console, a file or the API.
    pub const RULES_APPLIED: &str = "rules.applied";
    /// The official clear route emptied a database; payload `{ database,
    /// documents }`.
    pub const FIRESTORE_CLEARED: &str = "firestore.cleared";
    /// A request named another project than the suite's.
    pub const PROJECT_MISMATCH: &str = "project.mismatch";
    /// An `--import` folder was loaded.
    pub const IMPORT_DONE: &str = "import.done";
    /// An export finished; payload `{ destination, targets, durationMs }`.
    pub const DATA_EXPORTED: &str = "data.exported";
    /// A section's data was reset; payload `{ section, removed, durationMs,
    /// cancelled }`.
    pub const DATA_RESET: &str = "data.reset";
    /// The Requests diagnostics dropped events or slow clients.
    pub const DIAGNOSTICS_OMITTED: &str = "diagnostics.omitted";

    const SUITE: &[LogKindInfo] = &[
        marker(ENGINE_READY, "Engine ready"),
        internal(ENGINE_CONFIGURED, "Engine configured"),
        plain(ENGINE_NOTICE, "Engine notice"),
        internal(FUNCTIONS_RECEIPT, "Functions host receipt"),
        marker(FUNCTIONS_RELOADED, "Functions reloaded"),
        marker(HUB_BACKGROUND_TRIGGERS, "Background triggers switched"),
        problem(RULES_DENIED, "Rules denied"),
        plain(RULES_DENIED_CONSOLE, "Rules denied a console request"),
        marker(RULES_RELOADED, "Rules reloaded"),
        problem(RULES_FILE_ERROR, "Rules file error"),
        marker(RULES_APPLIED, "Rules applied"),
        marker(FIRESTORE_CLEARED, "Firestore cleared"),
        problem(PROJECT_MISMATCH, "Another project id"),
        marker(IMPORT_DONE, "Data imported"),
        marker(DATA_EXPORTED, "Data exported"),
        marker(DATA_RESET, "Data reset"),
        plain(DIAGNOSTICS_OMITTED, "Diagnostics omitted"),
    ];

    // Functions, Extensions and Eventarc (the facts come from compute's
    // runtime; observe gives them their kinds).

    /// "Beginning execution of …".
    pub const FUNCTION_START: &str = "function.start";
    /// "Finished … in Nms" with a status below 500.
    pub const FUNCTION_FINISH: &str = "function.finish";
    /// An invocation that failed (status 500 or more, or a handler that
    /// threw).
    pub const FUNCTION_FAILED: &str = "function.failed";
    /// An invocation that ran past its timeout.
    pub const FUNCTION_TIMEOUT: &str = "function.timeout";
    /// The request to the worker failed.
    pub const FUNCTION_CRASHED: &str = "function.crashed";
    /// A call to a function a reload removed.
    pub const FUNCTION_UNKNOWN: &str = "function.unknown";
    /// A Functions worker that did not start.
    pub const WORKER_FAILED: &str = "worker.failed";
    /// An Eventarc event that could not be converted or delivered.
    pub const EVENTARC_FAILED: &str = "eventarc.failed";

    const FUNCTIONS: &[LogKindInfo] = &[
        plain(FUNCTION_START, "Function started"),
        plain(FUNCTION_FINISH, "Function finished"),
        problem(FUNCTION_FAILED, "Function failed"),
        problem(FUNCTION_TIMEOUT, "Function timed out"),
        problem(FUNCTION_CRASHED, "Function crashed"),
        problem(FUNCTION_UNKNOWN, "Function not loaded"),
        problem(WORKER_FAILED, "Worker did not start"),
        problem(EVENTARC_FAILED, "Eventarc event failed"),
    ];

    // Authentication.

    /// A message the Auth emulator would have sent (codes and links).
    pub const AUTH_MESSAGE: &str = "auth.message";
    /// An Auth configuration change; payload `{ tenant, what }`.
    pub const AUTH_CONFIG: &str = "auth.config";

    const AUTH: &[LogKindInfo] = &[
        plain(AUTH_MESSAGE, "Auth message"),
        plain(AUTH_CONFIG, "Auth configuration changed"),
    ];

    // Storage.

    /// A client request the Storage rules refused.
    pub const STORAGE_DENIED: &str = "storage.denied";
    /// A console request the Storage rules refused.
    pub const STORAGE_DENIED_CONSOLE: &str = "storage.denied.console";
    /// A Storage rules file that could not be loaded.
    pub const STORAGE_RULES: &str = "storage.rules";
    /// Storage state that could not be written to disk.
    pub const STORAGE_FLUSH: &str = "storage.flush";

    const STORAGE: &[LogKindInfo] = &[
        problem(STORAGE_DENIED, "Storage rules denied"),
        plain(
            STORAGE_DENIED_CONSOLE,
            "Storage rules denied a console request",
        ),
        problem(STORAGE_RULES, "Storage rules error"),
        problem(STORAGE_FLUSH, "Storage could not save"),
    ];

    // Pub/Sub and Cloud Tasks.

    /// A schedule that could not run.
    pub const PUBSUB_SCHEDULE: &str = "pubsub.schedule";
    /// A push subscription's endpoint refused or failed deliveries (once per
    /// streak).
    pub const PUBSUB_PUSH: &str = "pubsub.push";
    /// A task that ran out of retries.
    pub const TASKS_FAILED: &str = "tasks.failed";

    const MESSAGING: &[LogKindInfo] = &[
        problem(PUBSUB_SCHEDULE, "Schedule failed"),
        plain(PUBSUB_PUSH, "Push delivery failed"),
        problem(TASKS_FAILED, "Task failed"),
    ];

    const BLOCKS: [&[LogKindInfo]; 5] = [SUITE, FUNCTIONS, AUTH, STORAGE, MESSAGING];

    /// Every kind, block by block.
    pub fn all() -> impl Iterator<Item = &'static LogKindInfo> {
        BLOCKS.into_iter().flatten()
    }

    /// What the console knows about `kind`, when it is declared.
    #[must_use]
    pub fn info(kind: &str) -> Option<&'static LogKindInfo> {
        all().find(|info| info.kind == kind)
    }

    /// Whether a line of `kind` is a problem.
    #[must_use]
    pub fn is_problem(kind: &str) -> bool {
        info(kind).is_some_and(|info| info.problem)
    }

    /// Whether a line of `kind` marks a moment in the feed.
    #[must_use]
    pub fn is_marker(kind: &str) -> bool {
        info(kind).is_some_and(|info| info.marker)
    }

    /// Whether a line of `kind` is engine bookkeeping.
    #[must_use]
    pub fn is_internal(kind: &str) -> bool {
        info(kind).is_some_and(|info| info.internal)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn every_level_spelling_reads_as_its_level() {
        for (text, level) in [
            ("DEBUG", LogLevel::Debug),
            ("debug", LogLevel::Debug),
            ("INFO", LogLevel::Info),
            ("NOTICE", LogLevel::Info),
            ("DEFAULT", LogLevel::Info),
            ("BULLET", LogLevel::Info),
            ("SUCCESS", LogLevel::Info),
            ("user", LogLevel::Info),
            ("WARN", LogLevel::Warn),
            ("Warning", LogLevel::Warn),
            ("ERROR", LogLevel::Error),
            ("critical", LogLevel::Error),
            ("ALERT", LogLevel::Error),
            ("EMERGENCY", LogLevel::Error),
            (" error ", LogLevel::Error),
            ("", LogLevel::Info),
            ("verbose", LogLevel::Info),
        ] {
            assert_eq!(LogLevel::parse(text), level, "{text:?}");
        }
        assert_eq!(
            LogLevel::ALL.map(LogLevel::as_str),
            ["debug", "info", "warn", "error"]
        );
        assert_eq!(
            LogLevel::ALL.map(LogLevel::legacy),
            ["DEBUG", "INFO", "WARN", "ERROR"]
        );
        assert_eq!(
            serde_json::to_value(LogLevel::Warn).expect("json"),
            serde_json::json!("warn")
        );
        assert!(LogLevel::Debug < LogLevel::Error);
    }

    #[test]
    fn the_level_and_kind_types_export_for_the_console() {
        let config = ts_rs::Config::default();
        let level = LogLevel::decl(&config);
        assert!(
            level.contains(r#""debug" | "info" | "warn" | "error""#),
            "{level}"
        );
        assert_eq!(
            LogLevel::output_path().expect("exported").to_str(),
            Some("observe/LogLevel.ts")
        );
        let kind = kinds::LogKindInfo::decl(&config);
        for field in [
            "kind: string",
            "label: string",
            "problem: boolean",
            "marker: boolean",
            "internal: boolean",
        ] {
            assert!(kind.contains(field), "{kind}");
        }
    }

    #[test]
    fn every_kind_is_declared_once_with_a_label() {
        let mut seen = BTreeSet::new();
        for info in kinds::all() {
            assert!(seen.insert(info.kind), "{} is declared twice", info.kind);
            assert!(!info.label.is_empty(), "{} has no label", info.kind);
            assert!(
                info.label.chars().next().is_some_and(char::is_uppercase),
                "{} label is sentence case",
                info.kind
            );
            assert!(
                !(info.problem && info.marker),
                "{} is a problem or a marker, not both",
                info.kind
            );
            assert_eq!(kinds::info(info.kind), Some(info));
        }
        let expected = [
            "engine.ready",
            "engine.configured",
            "engine.notice",
            "functions.receipt",
            "functions.reloaded",
            "function.start",
            "function.finish",
            "function.failed",
            "function.timeout",
            "function.crashed",
            "function.unknown",
            "worker.failed",
            "eventarc.failed",
            "hub.backgroundTriggers",
            "rules.denied",
            "rules.denied.console",
            "rules.reloaded",
            "rules.fileError",
            "rules.applied",
            "firestore.cleared",
            "project.mismatch",
            "import.done",
            "data.exported",
            "data.reset",
            "diagnostics.omitted",
            "auth.message",
            "auth.config",
            "storage.denied",
            "storage.denied.console",
            "storage.rules",
            "storage.flush",
            "pubsub.schedule",
            "pubsub.push",
            "tasks.failed",
        ];
        assert_eq!(seen, expected.into_iter().collect::<BTreeSet<_>>());
        assert_eq!(kinds::info("not.a.kind"), None);
    }

    #[test]
    fn the_problem_marker_and_internal_sets_are_the_specified_ones() {
        let set = |pick: fn(&kinds::LogKindInfo) -> bool| {
            kinds::all()
                .filter(|info| pick(info))
                .map(|info| info.kind)
                .collect::<BTreeSet<_>>()
        };
        assert_eq!(
            set(|info| info.problem),
            [
                "rules.denied",
                "storage.denied",
                "function.failed",
                "function.timeout",
                "function.crashed",
                "function.unknown",
                "worker.failed",
                "eventarc.failed",
                "rules.fileError",
                "storage.rules",
                "storage.flush",
                "pubsub.schedule",
                "tasks.failed",
                "project.mismatch",
            ]
            .into_iter()
            .collect()
        );
        assert_eq!(
            set(|info| info.marker),
            [
                "engine.ready",
                "functions.reloaded",
                "rules.reloaded",
                "rules.applied",
                "firestore.cleared",
                "data.reset",
                "data.exported",
                "import.done",
                "hub.backgroundTriggers",
            ]
            .into_iter()
            .collect()
        );
        assert_eq!(
            set(|info| info.internal),
            ["engine.configured", "functions.receipt"]
                .into_iter()
                .collect()
        );
        assert!(kinds::is_problem(kinds::RULES_DENIED));
        assert!(!kinds::is_problem(kinds::RULES_DENIED_CONSOLE));
        assert!(kinds::is_marker(kinds::ENGINE_READY));
        assert!(kinds::is_internal(kinds::FUNCTIONS_RECEIPT));
        assert!(!kinds::is_problem("unknown.kind"));
    }

    #[test]
    fn a_kind_serializes_as_the_console_reads_it() {
        let info = kinds::info(kinds::TASKS_FAILED).expect("declared");
        assert_eq!(
            serde_json::to_value(info).expect("json"),
            serde_json::json!({
                "kind": "tasks.failed",
                "label": "Task failed",
                "problem": true,
                "marker": false,
                "internal": false,
            })
        );
    }
}
