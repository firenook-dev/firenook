//! The compute stream's part of the console: Functions, Extensions and
//! Eventarc, built from the running suite.

use firenook_console_front::{ComputeConsole, ComputeParts};
use firenook_functions_bridge::FunctionsInventory;

use super::{FunctionsConsoleOptions, HookContext};
use crate::SuiteConfig;

/// What compute's console needs from before Functions start, created
/// before the console is built.
pub(crate) fn parts(_config: &SuiteConfig) -> ComputeParts {
    ComputeParts::new()
}

/// The suite's services are prepared; the console is not built yet.
pub(crate) fn prepared(_context: &HookContext<'_>) {}

/// The Functions runtime is about to start.
pub(crate) fn functions_options(
    _context: &HookContext<'_>,
    _options: &mut FunctionsConsoleOptions,
) {
}

/// Functions have started (called right after the runtime is up, with the
/// inventory it discovered): hands the runtime to the console, whose
/// Functions, Extensions and Eventarc sections then turn ready.
pub(crate) fn ready(context: &HookContext<'_>) {
    if let (Some(parts), Some(functions)) = (context.compute, context.functions) {
        parts.late.set(ComputeConsole {
            functions: functions.router(),
            eventarc: functions.eventarc_router(),
        });
    }
}

/// The suite is stopping (see `before_finish` in `mod.rs` for the order).
#[allow(
    clippy::unused_async,
    reason = "the stream awaits its own stop work here"
)]
pub(crate) async fn before_finish(_context: &HookContext<'_>) {}

/// Functions reloaded and routing was refreshed for the inventory.
pub(crate) fn inventory_refreshed(_context: &HookContext<'_>, _inventory: &FunctionsInventory) {}
