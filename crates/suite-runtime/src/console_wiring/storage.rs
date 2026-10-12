//! The storage stream's part of the console, built from the running suite.

use std::sync::Arc;

use firenook_console_front::StorageConsole;
use firenook_functions_bridge::FunctionsInventory;
use firenook_storage_front::{LogSink, StorageLogLevel, StorageLogLine, StorageRuntime};
use firenook_suite_front::{Audience, LogInput, LogLevel, LoggingRuntime};

use super::{FunctionsConsoleOptions, HookContext};
use crate::SuiteConfig;

/// Storage's console: the Storage emulator's own application.
pub(crate) fn storage_console(
    storage: &Arc<StorageRuntime>,
    _config: &SuiteConfig,
    _logging: &LoggingRuntime,
) -> StorageConsole {
    StorageConsole {
        native: storage.application(),
    }
}

/// Storage's own log lines (rules runtime errors, failed flushes) as suite
/// log lines: printed to the terminal as they always were, and handed to the
/// console's log with their kind. The official Logging feed never carried
/// them, so they stay out of it.
pub(crate) fn log_sink(logging: &LoggingRuntime) -> LogSink {
    let logging = logging.clone();
    Arc::new(move |line: StorageLogLine| {
        let prefix = if line.kind == "storage.rules" {
            "firenook Storage rules"
        } else {
            "firenook Storage"
        };
        match line.level {
            StorageLogLevel::Info => println!("{prefix}: {}", line.message),
            StorageLogLevel::Warn | StorageLogLevel::Error => {
                eprintln!("{prefix}: {}", line.message);
            }
        }
        logging.emit(LogInput {
            level: match line.level {
                StorageLogLevel::Info => LogLevel::Info,
                StorageLogLevel::Warn => LogLevel::Warn,
                StorageLogLevel::Error => LogLevel::Error,
            },
            service: "storage".to_owned(),
            kind: Some(line.kind),
            message: line.message,
            audience: Audience::Console,
            ..LogInput::default()
        });
    })
}

/// The suite's services are prepared; the console is not built yet. From
/// here on Storage's log lines reach the suite's log.
pub(crate) fn prepared(context: &HookContext<'_>) {
    if let Some(storage) = context.storage {
        storage.set_log_sink(log_sink(context.logging));
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
/// the console's jobs have stopped, so Storage's console tasks (exports,
/// thumbnail decodes, the folder index walk, the session sweep) stop now and
/// are awaited, before trigger delivery stops and before Storage's final
/// flush.
pub(crate) async fn before_finish(context: &HookContext<'_>) {
    if let Some(storage) = context.storage {
        storage.stop_console_tasks().await;
    }
}

/// Functions reloaded and routing was refreshed for the inventory.
pub(crate) fn inventory_refreshed(_context: &HookContext<'_>, _inventory: &FunctionsInventory) {}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use firenook_suite_front::ConsoleSink;

    use super::*;

    /// Keeps every line the console would receive.
    #[derive(Default)]
    struct Captured(Mutex<Vec<LogInput>>);

    impl ConsoleSink for Captured {
        fn accept(&self, input: LogInput) {
            self.0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(input);
        }
    }

    #[test]
    fn storage_lines_reach_the_console_with_their_kind() {
        let logging = LoggingRuntime::new();
        let captured = Arc::new(Captured::default());
        logging.set_console_sink(captured.clone());
        let sink = log_sink(&logging);
        sink(StorageLogLine {
            level: StorageLogLevel::Warn,
            kind: "storage.rules",
            message: "get on gs://b/a.png failed in the rules: null value error".to_owned(),
        });
        sink(StorageLogLine {
            level: StorageLogLevel::Error,
            kind: "storage.flush",
            message: "write-behind flush failed: disk full".to_owned(),
        });
        let lines = captured
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].service, "storage");
        assert_eq!(lines[0].kind, Some("storage.rules"));
        assert_eq!(lines[0].level, LogLevel::Warn);
        assert_eq!(lines[0].audience, Audience::Console);
        assert!(lines[0].message.contains("failed in the rules"));
        assert_eq!(lines[1].kind, Some("storage.flush"));
        assert_eq!(lines[1].level, LogLevel::Error);
        // Console only: the official Logging feed never carried these.
        assert!(logging.is_empty(), "nothing reached the official feed");
    }
}
