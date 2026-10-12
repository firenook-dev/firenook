//! Logs and the Overview in the console (the observe stream's module).
//! Owns `/api/v1/logs/...` and `/api/v1/overview/...`.

pub(crate) mod fields;
pub(crate) mod firestore_data;
pub(crate) mod log;
pub(crate) mod logs;
pub(crate) mod overview;

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use firenook_suite_front::{Cursor, LoggingRuntime, OverviewEngineDetails, OverviewNotice};
use futures_util::StreamExt as _;
use futures_util::stream::{self, BoxStream};

use crate::live::LiveTopic;
use crate::live::badges::{BadgeKind, BadgeNoun, BadgeTone};
use crate::section::{
    Section, SectionContext, SectionStatus, SectionSummary, SummaryFigure, SummaryUnit,
};

use log::ConsoleLog;
#[cfg(test)]
use log::{LogEntry, LogLevelCounts};
#[cfg(test)]
use logs::{LogFacetCount, LogFacets, LogHistogram, LogPage};

/// Logs' and the Overview's part of the console.
#[derive(Clone)]
pub struct ObserveConsole {
    /// The suite's log buffer (the Logging port's source).
    pub logging: LoggingRuntime,
    /// The console log; `None` for a console built without a suite log
    /// (`--no-ui`, tests), whose Logs routes then say so.
    pub(crate) log: Option<ConsoleLog>,
    /// How the engine was started and what an app needs to reach it.
    pub(crate) engine: Arc<OverviewEngineDetails>,
    /// The configuration notices the Overview shows.
    pub(crate) notices: Arc<Vec<OverviewNotice>>,
}

impl ObserveConsole {
    /// Creates the console log and installs it as `logging`'s console sink,
    /// so every line recorded from now on is kept for the console. The
    /// suite calls it before its startup lines, only when the console runs.
    pub fn install_log(logging: &LoggingRuntime) {
        logging.set_console_sink(Arc::new(ConsoleLog::new()));
    }

    /// The console over the suite log `logging`, with the console log
    /// [`install_log`](Self::install_log) installed in it (none when it
    /// was not called).
    #[must_use]
    pub fn over(logging: &LoggingRuntime) -> Self {
        let log = logging.console_sink().and_then(|sink| {
            let sink: Arc<dyn std::any::Any + Send + Sync> = sink;
            sink.downcast::<ConsoleLog>().ok()
        });
        Self {
            logging: logging.clone(),
            log: log.map(|log| ConsoleLog::clone(&log)),
            engine: Arc::default(),
            notices: Arc::default(),
        }
    }

    /// A console over an empty log of its own, for a console built without
    /// a suite (tests, tools).
    #[must_use]
    pub fn detached() -> Self {
        Self {
            logging: LoggingRuntime::new(),
            log: None,
            engine: Arc::default(),
            notices: Arc::default(),
        }
    }

    /// The same console, with the engine's details and configuration
    /// notices for the Overview.
    #[must_use]
    pub fn with_overview(
        mut self,
        engine: OverviewEngineDetails,
        notices: Vec<OverviewNotice>,
    ) -> Self {
        self.engine = Arc::new(engine);
        self.notices = Arc::new(notices);
        self
    }
}

/// The Logs section.
pub(crate) struct ObserveSection(pub(crate) ObserveConsole);

impl Section for ObserveSection {
    fn statuses(&self) -> Vec<SectionStatus> {
        vec![SectionStatus::ready("logs")]
    }

    fn router(&self, context: &SectionContext) -> Router {
        if let Some(log) = &self.0.log {
            spawn_badges(log, context);
        }
        logs::router(logs::LogsApi {
            log: self.0.log.clone(),
            project: context.project.clone(),
            shutdown: context.shutdown.clone(),
        })
        .merge(overview::router(self.overview()))
    }

    fn topics(&self, _context: &SectionContext) -> Vec<Arc<dyn LiveTopic>> {
        vec![
            Arc::new(logs::LogsTopic {
                log: self.0.log.clone(),
            }),
            Arc::new(overview::OverviewTopic {
                api: self.overview(),
            }),
        ]
    }

    /// Lines kept and errors since the engine started, for the Overview's
    /// card and the nav tooltip.
    fn summary(&self, _id: &str) -> Option<SectionSummary> {
        let log = self.0.log.as_ref()?;
        Some(logs_summary(log.kept(), log.totals().levels.error))
    }

    /// Ticks while lines arrive, at most every 500 ms.
    fn status_changes(&self) -> Option<BoxStream<'static, ()>> {
        let changes = self.0.log.as_ref()?.changes();
        Some(
            stream::unfold((changes, false), |(mut changes, waited)| async move {
                if waited {
                    tokio::time::sleep(STATUS_TICK).await;
                }
                changes.changed().await.ok()?;
                Some(((), (changes, true)))
            })
            .boxed(),
        )
    }
}

impl ObserveSection {
    fn overview(&self) -> overview::OverviewApi {
        overview::OverviewApi {
            log: self.0.log.clone(),
            engine: self.0.engine.clone(),
            notices: self.0.notices.clone(),
        }
    }
}

/// Keeps the two badges observe publishes at the log's totals, until the
/// suite stops: `logs.errors` (attention) counts every error line, and
/// `firestore.denials` (neutral) every app request the Firestore rules
/// refused; denials of the console's own reads are not counted. Each
/// records the newest counted line's cursor, so the badge link opens at
/// what is new.
fn spawn_badges(log: &ConsoleLog, context: &SectionContext) {
    let errors = context.badges.handle(
        "logs.errors",
        BadgeKind::Counter,
        BadgeNoun::new("new error", "new errors"),
    );
    let denials = context.badges.handle(
        "firestore.denials",
        BadgeKind::Counter,
        BadgeNoun::new("rules denial", "rules denials"),
    );
    let log = log.clone();
    let mut changes = log.changes();
    let stopped = context.shutdown.clone().stopped();
    tokio::spawn(async move {
        tokio::pin!(stopped);
        let epoch = log.epoch();
        let (mut counted_errors, mut counted_denials) = (0, 0);
        loop {
            let totals = log.totals();
            if let Some(seq) = totals.newest_error
                && totals.levels.error > counted_errors
            {
                errors.add_at(
                    totals.levels.error - counted_errors,
                    BadgeTone::Attention,
                    Cursor { epoch, seq },
                );
                counted_errors = totals.levels.error;
            }
            if let Some(seq) = totals.newest_denial
                && totals.denials > counted_denials
            {
                denials.add_at(
                    totals.denials - counted_denials,
                    BadgeTone::Neutral,
                    Cursor { epoch, seq },
                );
                counted_denials = totals.denials;
            }
            tokio::select! {
                biased;
                () = &mut stopped => break,
                moved = changes.changed() => {
                    if moved.is_err() {
                        break;
                    }
                }
            }
        }
    });
}

/// How often a section's summary may tick while its counts move.
const STATUS_TICK: Duration = Duration::from_millis(500);

/// "20,000 lines · 3 errors".
fn logs_summary(kept: u64, errors: u64) -> SectionSummary {
    let count = |count: u64, one: &str, many: &str| {
        format!(
            "{} {}",
            logs::grouped(usize::try_from(count).unwrap_or(usize::MAX)),
            if count == 1 { one } else { many }
        )
    };
    SectionSummary {
        headline: format!(
            "{} · {}",
            count(kept, "line", "lines"),
            count(errors, "error", "errors")
        ),
        figures: vec![
            SummaryFigure {
                label: "Lines kept".to_owned(),
                value: Some(kept),
                unit: SummaryUnit::Count,
            },
            SummaryFigure {
                label: "Errors since start".to_owned(),
                value: Some(errors),
                unit: SummaryUnit::Count,
            },
        ],
    }
}

/// The observe stream's TypeScript bindings, into `generated/observe/`:
/// the log's types, and `LOG_KINDS` from the engine's one list of kinds.
#[cfg(test)]
pub(crate) fn export_bindings(config: &ts_rs::Config) {
    use ts_rs::TS as _;
    firenook_suite_front::LogLevel::export_all(config).expect("TypeScript bindings written");
    firenook_suite_front::kinds::LogKindInfo::export_all(config)
        .expect("TypeScript bindings written");
    LogEntry::export_all(config).expect("TypeScript bindings written");
    LogLevelCounts::export_all(config).expect("TypeScript bindings written");
    LogPage::export_all(config).expect("TypeScript bindings written");
    LogFacets::export_all(config).expect("TypeScript bindings written");
    LogFacetCount::export_all(config).expect("TypeScript bindings written");
    LogHistogram::export_all(config).expect("TypeScript bindings written");
    overview::OverviewState::export_all(config).expect("TypeScript bindings written");
    OverviewEngineDetails::export_all(config).expect("TypeScript bindings written");
    let directory = config.out_dir().join("observe");
    std::fs::create_dir_all(&directory).expect("generated/observe/ created");
    std::fs::write(directory.join("logKinds.ts"), log_kinds_module())
        .expect("TypeScript bindings written");
}

/// `generated/observe/logKinds.ts`: every kind the engine declares, so the
/// console's labels and groups cannot drift from the engine's.
#[cfg(test)]
fn log_kinds_module() -> String {
    use std::fmt::Write as _;
    let quote = |text: &str| serde_json::to_string(text).expect("a string serializes");
    let mut module = String::from(
        "// This file was generated from the engine's list of log kinds\n\
         // (crates/suite-front/src/console_input.rs). Do not edit this file manually.\n\
         import type { LogKindInfo } from \"./LogKindInfo\";\n\n\
         /**\n * Every kind of line the engine writes, with its label and how the console\n * treats it, in the engine's order.\n */\n\
         export const LOG_KINDS: readonly LogKindInfo[] = [\n",
    );
    for info in firenook_suite_front::kinds::all() {
        let _ = writeln!(
            module,
            "  {{ kind: {}, label: {}, problem: {}, marker: {}, internal: {} }},",
            quote(info.kind),
            quote(info.label),
            info.problem,
            info.marker,
            info.internal
        );
    }
    module.push_str("];\n");
    module
}

#[cfg(test)]
#[path = "mod_tests.rs"]
mod tests;
