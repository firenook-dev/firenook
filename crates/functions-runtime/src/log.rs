//! Log events the runtime hands to the suite (which prints and records them).
use std::sync::Arc;

/// One log line with the official emulator's level vocabulary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogEvent {
    pub level: String,
    /// `functions`, `functions[<id>]`, `extensions`, ...
    pub label: String,
    pub message: String,
}

impl LogEvent {
    #[must_use]
    pub fn new(level: &str, label: &str, message: String) -> Self {
        Self {
            level: level.to_owned(),
            label: label.to_owned(),
            message,
        }
    }
}

/// Where log events go; the suite installs its logging runtime here.
#[derive(Clone)]
pub struct LogSink(Arc<dyn Fn(LogEvent) + Send + Sync>);

impl LogSink {
    #[must_use]
    pub fn new(sink: impl Fn(LogEvent) + Send + Sync + 'static) -> Self {
        Self(Arc::new(sink))
    }

    /// A sink that writes `<label>: <message>` to stderr.
    #[must_use]
    pub fn stderr() -> Self {
        Self::new(|event| eprintln!("fireside {}: {}", event.label, event.message))
    }

    pub fn record(&self, event: LogEvent) {
        (self.0)(event);
    }

    /// Records an informational `functions` line.
    pub fn info(&self, message: impl Into<String>) {
        self.record(LogEvent::new("INFO", "functions", message.into()));
    }

    /// Records a warning `functions` line.
    pub fn warn(&self, message: impl Into<String>) {
        self.record(LogEvent::new("WARN", "functions", message.into()));
    }
}

impl std::fmt::Debug for LogSink {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("LogSink")
    }
}
