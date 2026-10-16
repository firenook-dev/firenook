//! Where Storage's own log lines go: rules runtime errors and failed
//! flushes. A plain closure, so this crate needs no logging crate of the
//! suite's; the suite adapts it to its log, and without one the lines go to
//! standard error as they always did.

use std::fmt;
use std::sync::{Arc, RwLock};

/// Receives every Storage log line once it is set.
pub type LogSink = Arc<dyn Fn(StorageLogLine) + Send + Sync>;

/// How serious a log line is.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StorageLogLevel {
    Info,
    Warn,
    Error,
}

/// One line of Storage's log.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StorageLogLine {
    pub level: StorageLogLevel,
    /// `storage.rules` (a rules runtime error) or `storage.flush` (a
    /// write-behind flush that failed).
    pub kind: &'static str,
    pub message: String,
}

/// A rules runtime error.
pub(crate) const RULES: &str = "storage.rules";
/// A write-behind flush that failed.
pub(crate) const FLUSH: &str = "storage.flush";

/// The sink in force, shared by every task that logs.
#[derive(Clone, Default)]
pub(crate) struct LogHandle(Arc<RwLock<Option<LogSink>>>);

impl fmt::Debug for LogHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("LogHandle")
    }
}

impl LogHandle {
    pub(crate) fn set(&self, sink: LogSink) {
        *self
            .0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(sink);
    }

    pub(crate) fn emit(&self, level: StorageLogLevel, kind: &'static str, message: String) {
        // Cloned out so the sink never runs under the lock.
        let sink = self
            .0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        match sink {
            Some(sink) => sink(StorageLogLine {
                level,
                kind,
                message,
            }),
            None if kind == RULES => eprintln!("firenook Storage rules: {message}"),
            None => eprintln!("firenook Storage: {message}"),
        }
    }
}
