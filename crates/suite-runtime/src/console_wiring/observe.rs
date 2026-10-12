//! The observe stream's part of the console: Logs and the Overview, built
//! from the running suite.

use firenook_console_front::ObserveConsole;
use firenook_functions_bridge::FunctionsInventory;

use super::{FunctionsConsoleOptions, HookContext};

/// Logs' and the Overview's console: the suite's log, with the console log
/// `prepare_logging` installed in it.
pub(crate) fn observe_console(context: &HookContext<'_>) -> ObserveConsole {
    ObserveConsole::over(context.logging)
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
