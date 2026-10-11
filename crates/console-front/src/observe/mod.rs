//! Logs and the Overview in the console (the observe stream's module).
//! Owns `/api/v1/logs/...` and `/api/v1/overview/...`.

pub(crate) mod firestore_data;

use axum::Router;
use firenook_suite_front::LoggingRuntime;

use crate::section::{Section, SectionContext, SectionStatus};

/// Logs' and the Overview's part of the console.
#[derive(Clone)]
pub struct ObserveConsole {
    /// The suite's log buffer (the Logging port's source).
    pub logging: LoggingRuntime,
}

impl ObserveConsole {
    /// A console over an empty log of its own, for a console built without
    /// a suite (tests, tools).
    #[must_use]
    pub fn detached() -> Self {
        Self {
            logging: LoggingRuntime::new(),
        }
    }
}

/// The Logs section.
pub(crate) struct ObserveSection(
    #[allow(
        dead_code,
        reason = "the observe stream serves the log ring through it"
    )]
    pub(crate) ObserveConsole,
);

impl Section for ObserveSection {
    fn statuses(&self) -> Vec<SectionStatus> {
        vec![SectionStatus::ready("logs")]
    }

    fn router(&self, _context: &SectionContext) -> Router {
        Router::new()
    }
}

/// The observe stream's TypeScript bindings, into `generated/observe/`.
#[cfg(test)]
pub(crate) fn export_bindings(_config: &ts_rs::Config) {}
