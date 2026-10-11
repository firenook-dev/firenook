//! Functions, Extensions and Eventarc in the console (the compute stream's
//! module). Owns `/api/v1/functions/...`, `/api/v1/extensions/...` and
//! `/api/v1/eventarc/...`.
//!
//! Functions start after the console is serving, so the runtime arrives
//! through a [`Late`]: the three sections report `starting` and their routes
//! answer `503 starting` until the suite hands it over, then serve it.
//! Pub/Sub and Cloud Tasks follow Functions; compute reaches them through
//! messaging's own `Late`s, cloned in by `console_router`, never a second
//! pair of its own.

use axum::Router;
use futures_util::StreamExt as _;
use futures_util::stream::BoxStream;
use tokio_stream::wrappers::WatchStream;

use crate::late::{Late, late_native};
use crate::messaging::{PubsubConsole, TasksConsole};
use crate::section::{Section, SectionContext, SectionStatus};

/// Where the Functions port's application is mounted, as the browser sees it.
pub(crate) const FUNCTIONS_PREFIX: &str = "/console/api/v1/functions/native";
/// Where the Eventarc emulator's application is mounted.
pub(crate) const EVENTARC_PREFIX: &str = "/console/api/v1/eventarc/native";

/// What a section waiting on Functions says.
const DISCOVERING: &str = "Discovering functions…";

/// What compute's console needs from before Functions start, and the late
/// runtime. Created by `console_wiring::compute::parts` before the console
/// is built and handed to `start_functions_runtime`'s pre-placed hook, so
/// what compute records exists before the first function runs.
#[derive(Clone)]
pub struct ComputeParts {
    /// The Functions runtime's routers, handed over when Functions are up.
    pub late: Late<ComputeConsole>,
}

impl ComputeParts {
    /// Functions not started yet.
    #[must_use]
    pub fn new() -> Self {
        Self {
            late: Late::pending("Functions"),
        }
    }
}

impl Default for ComputeParts {
    fn default() -> Self {
        Self::new()
    }
}

/// The running Functions runtime, as the console reaches it.
#[derive(Clone)]
pub struct ComputeConsole {
    /// The Functions port's router (`/backends`, `/{project}/{region}/{name}`).
    pub functions: Router,
    /// The Eventarc emulator's router.
    pub eventarc: Router,
}

/// The Functions, Extensions and Eventarc sections.
pub(crate) struct ComputeSection {
    pub(crate) parts: ComputeParts,
    /// Messaging's Lates, cloned in by `console_router` (one `Late` per
    /// runtime): compute publishes, enqueues and runs schedules through
    /// what the messaging stream adds to `PubsubConsole` and `TasksConsole`.
    #[allow(
        dead_code,
        reason = "compute publishes and runs schedules through it (compute stream)"
    )]
    pub(crate) pubsub: Option<Late<PubsubConsole>>,
    #[allow(
        dead_code,
        reason = "compute enqueues tasks through it (compute stream)"
    )]
    pub(crate) tasks: Option<Late<TasksConsole>>,
}

impl Section for ComputeSection {
    fn statuses(&self) -> Vec<SectionStatus> {
        let ready = self.parts.late.is_ready();
        ["functions", "extensions", "eventarc"]
            .into_iter()
            .map(|id| {
                if ready {
                    SectionStatus::ready(id)
                } else {
                    SectionStatus::starting(id, DISCOVERING)
                }
            })
            .collect()
    }

    fn status_changes(&self) -> Option<BoxStream<'static, ()>> {
        Some(
            WatchStream::from_changes(self.parts.late.changes())
                .map(|_| ())
                .boxed(),
        )
    }

    fn router(&self, _context: &SectionContext) -> Router {
        Router::new()
            .nest_service(
                "/functions/native",
                late_native(self.parts.late.clone(), FUNCTIONS_PREFIX, |console| {
                    console.functions.clone()
                }),
            )
            .nest_service(
                "/eventarc/native",
                late_native(self.parts.late.clone(), EVENTARC_PREFIX, |console| {
                    console.eventarc.clone()
                }),
            )
    }
}

/// The compute stream's TypeScript bindings, into `generated/compute/`.
#[cfg(test)]
pub(crate) fn export_bindings(_config: &ts_rs::Config) {}
