//! Pub/Sub and Cloud Tasks in the console (the messaging stream's module).
//! Owns `/api/v1/pubsub/...` and `/api/v1/tasks/...`.
//!
//! Both start after the console is serving (Cloud Tasks with Functions,
//! Pub/Sub after them), so each arrives through a [`Late`]. These are the
//! only `Late`s for the two runtimes: compute's section holds clones of
//! them, and reaches Pub/Sub and Tasks through what this stream adds to
//! [`PubsubConsole`] and [`TasksConsole`].

use axum::Router;
use futures_util::StreamExt as _;
use futures_util::stream::BoxStream;
use tokio_stream::wrappers::WatchStream;

use crate::late::{Late, late_native};
use crate::section::{Section, SectionContext, SectionStatus};

/// Where Pub/Sub's HTTP/JSON application is mounted, as the browser sees it.
pub(crate) const PUBSUB_PREFIX: &str = "/console/api/v1/pubsub/native";
/// Where Cloud Tasks' HTTP application is mounted.
pub(crate) const TASKS_PREFIX: &str = "/console/api/v1/tasks/native";

/// The running Pub/Sub emulator, as the console reaches it.
#[derive(Clone)]
pub struct PubsubConsole {
    /// Pub/Sub's HTTP/JSON application.
    pub native: Router,
}

/// The running Cloud Tasks emulator, as the console reaches it.
#[derive(Clone)]
pub struct TasksConsole {
    /// Cloud Tasks' HTTP application.
    pub native: Router,
}

/// The Pub/Sub section.
pub(crate) struct PubsubSection(pub(crate) Late<PubsubConsole>);

impl PubsubSection {
    /// The section over the one `Late` for the Pub/Sub runtime.
    pub(crate) const fn new(late: Late<PubsubConsole>) -> Self {
        Self(late)
    }
}

/// The Cloud Tasks section.
pub(crate) struct TasksSection(pub(crate) Late<TasksConsole>);

impl TasksSection {
    /// The section over the one `Late` for the Cloud Tasks runtime.
    pub(crate) const fn new(late: Late<TasksConsole>) -> Self {
        Self(late)
    }
}

impl Section for PubsubSection {
    fn statuses(&self) -> Vec<SectionStatus> {
        vec![if self.0.is_ready() {
            SectionStatus::ready("pubsub")
        } else {
            SectionStatus::starting("pubsub", "Pub/Sub starts once Functions are ready.")
        }]
    }

    fn status_changes(&self) -> Option<BoxStream<'static, ()>> {
        Some(
            WatchStream::from_changes(self.0.changes())
                .map(|_| ())
                .boxed(),
        )
    }

    fn router(&self, _context: &SectionContext) -> Router {
        Router::new().nest_service(
            "/pubsub/native",
            late_native(self.0.clone(), PUBSUB_PREFIX, |console| {
                console.native.clone()
            }),
        )
    }
}

impl Section for TasksSection {
    fn statuses(&self) -> Vec<SectionStatus> {
        vec![if self.0.is_ready() {
            SectionStatus::ready("tasks")
        } else {
            SectionStatus::starting("tasks", "Cloud Tasks starts with Functions.")
        }]
    }

    fn status_changes(&self) -> Option<BoxStream<'static, ()>> {
        Some(
            WatchStream::from_changes(self.0.changes())
                .map(|_| ())
                .boxed(),
        )
    }

    fn router(&self, _context: &SectionContext) -> Router {
        Router::new().nest_service(
            "/tasks/native",
            late_native(self.0.clone(), TASKS_PREFIX, |console| {
                console.native.clone()
            }),
        )
    }
}

/// The messaging stream's TypeScript bindings, into `generated/messaging/`.
#[cfg(test)]
pub(crate) fn export_bindings(_config: &ts_rs::Config) {}

/// A Pub/Sub console whose native application is `native`, for the
/// crate's tests.
#[cfg(test)]
pub(crate) fn test_pubsub_console(native: Router) -> PubsubConsole {
    PubsubConsole { native }
}

/// A Cloud Tasks console whose native application is `native`, for the
/// crate's tests.
#[cfg(test)]
pub(crate) fn test_tasks_console(native: Router) -> TasksConsole {
    TasksConsole { native }
}
