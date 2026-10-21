//! The auth stream's part of the console, built from the running suite.

use std::sync::Arc;

use firenook_auth_front::{AuthLogLine, AuthRuntime, LineSink};
use firenook_console_front::AuthConsole;
use firenook_functions_bridge::FunctionsInventory;
use firenook_suite_front::{EntityRef, LogInput, LogLevel, LoggingRuntime, kinds};

use super::{FunctionsConsoleOptions, HookContext};
use crate::{SuiteConfig, terminal};

/// Authentication's console: the Auth emulator's own application, its
/// state, and the feed the console installs as the runtime's observer
/// (request and response bodies kept while diagnostics are on).
pub(crate) fn auth_console(
    auth: &Arc<AuthRuntime>,
    config: &SuiteConfig,
    logging: &LoggingRuntime,
) -> AuthConsole {
    AuthConsole::attach(auth, config.diagnostics, logging.clone())
}

/// Auth's log lines. The plain line and the official record (and the
/// `--debug-log` line) are exactly what the suite has always written:
/// `firenook auth: <text>` on stdout, or stderr for `WARN` and `ERROR`, and
/// a record at `INFO` (`BULLET`, `SUCCESS`), `WARN` or `ERROR` filed under
/// `auth`. With the terminal's events on, the line is a line of its log (a
/// warning before readiness is a start-up warning), and a line that prints
/// a code or a link is shown even when it comes before readiness. The
/// console's line is the same text; a line that prints a code or a link is
/// an `auth.message` with links to that message and its user.
pub(crate) fn auth_line_sink(logging: LoggingRuntime) -> LineSink {
    Arc::new(move |line: &AuthLogLine<'_>| {
        let legacy = match line.kind {
            "WARN" => "WARN",
            "ERROR" => "ERROR",
            _ => "INFO",
        };
        let plain = format!("firenook auth: {}", line.text);
        if line.message.is_some() {
            terminal::print_kept(legacy, "auth", line.text, &plain);
        } else {
            terminal::print(legacy, "auth", line.text, &plain);
        }
        let mut refs = Vec::new();
        if let Some(message) = line.message {
            refs.push(EntityRef::auth_message(&message.id.to_string()));
            if let Some(uid) = &message.uid {
                refs.push(EntityRef::auth_user(message.tenant.as_deref(), uid));
            }
        }
        logging.emit(LogInput {
            level: LogLevel::parse(legacy),
            service: "auth".to_owned(),
            kind: line.message.map(|_| kinds::AUTH_MESSAGE),
            message: line.text.to_owned(),
            refs,
            legacy_level: Some(legacy),
            ..LogInput::default()
        });
    })
}

/// The suite's services are prepared; the console is not built yet.
///
/// Auth gets its own origin for the action links it writes, as the
/// registered official emulator uses its own URL: without one a link took
/// the request's `Host`, so a code requested through the console mount
/// pointed at the console's port, where no action page is served. Its log
/// lines go through [`auth_line_sink`], which replaces the text sink the
/// suite installed while preparing (the last sink set wins).
///
/// Every project other than the configured one that holds users in the
/// restored state is a foreign project (the app wrote there), as long as
/// the emulator runs in single-project mode.
pub(crate) fn prepared(context: &HookContext<'_>) {
    let Some(auth) = context.auth else {
        return;
    };
    auth.set_origin(&context.config.origin(context.config.ports.auth));
    auth.set_line_sink(auth_line_sink(context.logging.clone()));
    if !context.config.single_project_mode {
        return;
    }
    let configured = context.config.project_id.as_str();
    let holding: Vec<String> = auth.runtime().read(|data| {
        data.projects
            .iter()
            .filter(|(project, agent)| {
                project.as_str() != configured
                    && (agent.project.user_count() > 0
                        || agent
                            .tenants
                            .values()
                            .any(|tenant| tenant.project.user_count() > 0))
            })
            .map(|(project, _)| project.clone())
            .collect()
    });
    for project in holding {
        context.foreign.record(&project, "auth");
    }
}

/// The Functions runtime is about to start.
pub(crate) fn functions_options(
    _context: &HookContext<'_>,
    _options: &mut FunctionsConsoleOptions,
) {
}

/// Every service has started.
pub(crate) fn ready(_context: &HookContext<'_>) {}

/// The suite is stopping (see `before_finish` in `mod.rs` for the order):
/// Auth writes its state file now, since changes otherwise reach it within
/// 250 ms, off the request path. The encode runs on a blocking thread; a
/// failure is said in the log, as the native checkpoint says its own.
pub(crate) async fn before_finish(context: &HookContext<'_>) {
    let Some(auth) = context.auth.cloned() else {
        return;
    };
    let flushed = match tokio::task::spawn_blocking(move || auth.flush()).await {
        Ok(written) => written.map_err(|error| error.to_string()),
        Err(error) => Err(format!("the flush did not finish: {error}")),
    };
    if let Err(error) = flushed {
        context.logging.emit(LogInput {
            level: LogLevel::Warn,
            service: "auth".to_owned(),
            kind: Some(kinds::ENGINE_NOTICE),
            message: format!("The Auth state could not be saved at shutdown: {error}"),
            ..LogInput::default()
        });
    }
}

/// Functions reloaded and routing was refreshed for the inventory: the
/// blocking functions Auth calls may have changed, so the console's
/// `auth.hooks` topic tells Settings.
pub(crate) fn inventory_refreshed(context: &HookContext<'_>, _inventory: &FunctionsInventory) {
    if let Some(auth) = context.auth {
        auth.blocking_changed();
    }
}
