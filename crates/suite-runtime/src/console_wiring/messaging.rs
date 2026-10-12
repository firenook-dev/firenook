//! The messaging stream's part of the console: Pub/Sub and Cloud Tasks,
//! built from the running suite.

use firenook_console_front::{ComputeParts, Late, PubsubConsole, TasksConsole};
use firenook_functions_bridge::FunctionsInventory;
use firenook_pubsub_front::PubsubRuntime;
use firenook_suite_front::LoggingRuntime;
use firenook_tasks_front::TasksRuntime;

use super::{FunctionsConsoleOptions, HookContext};
use crate::SuiteConfig;

/// Cloud Tasks has started: hands it to the console (`late` is the one
/// `Late` for it; compute's section holds a clone).
pub(crate) fn tasks_ready(
    late: &Late<TasksConsole>,
    tasks: &TasksRuntime,
    _compute: Option<&ComputeParts>,
    _config: &SuiteConfig,
    _logging: &LoggingRuntime,
) {
    late.set(TasksConsole {
        native: tasks.application(),
    });
}

/// Pub/Sub has started: hands it to the console (`late` is the one `Late`
/// for it; compute's section holds a clone).
pub(crate) fn pubsub_ready(
    late: &Late<PubsubConsole>,
    pubsub: &PubsubRuntime,
    _compute: Option<&ComputeParts>,
    _config: &SuiteConfig,
    _logging: &LoggingRuntime,
) {
    late.set(PubsubConsole {
        native: pubsub.application(),
    });
}

/// The suite's services are prepared; the console is not built yet.
pub(crate) fn prepared(_context: &HookContext<'_>) {}

/// The Functions runtime is about to start.
pub(crate) fn functions_options(
    _context: &HookContext<'_>,
    _options: &mut FunctionsConsoleOptions,
) {
}

/// Every service has started.
pub(crate) fn ready(_context: &HookContext<'_>) {}

/// The suite is stopping (see `before_finish` in `mod.rs` for the order).
#[allow(
    clippy::unused_async,
    reason = "the stream awaits its own stop work here"
)]
pub(crate) async fn before_finish(_context: &HookContext<'_>) {}

/// Functions reloaded and routing was refreshed for the inventory.
pub(crate) fn inventory_refreshed(_context: &HookContext<'_>, _inventory: &FunctionsInventory) {}
