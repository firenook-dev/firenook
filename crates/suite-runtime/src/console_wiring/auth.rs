//! The auth stream's part of the console, built from the running suite.

use std::sync::Arc;

use firenook_auth_front::AuthRuntime;
use firenook_console_front::AuthConsole;
use firenook_functions_bridge::FunctionsInventory;
use firenook_suite_front::LoggingRuntime;

use super::{FunctionsConsoleOptions, HookContext};
use crate::SuiteConfig;

/// Authentication's console: the Auth emulator's own application.
pub(crate) fn auth_console(
    auth: &Arc<AuthRuntime>,
    _config: &SuiteConfig,
    _logging: &LoggingRuntime,
) -> AuthConsole {
    AuthConsole {
        native: auth.application(),
    }
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
