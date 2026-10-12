//! Log events the runtime hands to the suite (which prints and records them).
use std::sync::Arc;
use std::time::SystemTime;

/// The output stream a worker line would have gone to without attribution:
/// `stdout` for `console.log`, `info` and `debug`; `stderr` for `warn` and
/// `error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LogStream {
    Stdout,
    Stderr,
}

impl LogStream {
    /// The level the official emulator files a line of this stream at
    /// (`INFO` for stdout, `WARN` for stderr), whatever its true level.
    #[must_use]
    pub fn legacy_level(self) -> &'static str {
        match self {
            Self::Stdout => "INFO",
            Self::Stderr => "WARN",
        }
    }
}

/// One log line with the official emulator's level vocabulary, and what the
/// runtime knows about who printed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogEvent {
    /// The line's true level (`console.debug` is `DEBUG`, `console.error`
    /// is `ERROR`).
    pub level: String,
    /// `functions`, `functions[<id>]`, `extensions`, ...
    pub label: String,
    pub message: String,
    /// The invocation that printed it (`<nonce>-<seq>`), when one did.
    pub execution: Option<String>,
    /// The function that printed it, or that a lifecycle line is about.
    pub function: Option<String>,
    /// The codebase or extension instance whose worker printed it, or that a
    /// runtime line is about.
    pub codebase: Option<String>,
    /// The engine's name for what the line is: `function.start`,
    /// `function.finish`, `function.error`, `worker.uncaught` …
    pub kind: Option<&'static str>,
    /// The facts of a lifecycle line: start `method`, `path` or `cause`; end
    /// `durationMs`, `status`, `outcome`, `clientGone`, `error`; and
    /// `consoleOnly: true` on a line today's output has no counterpart for.
    pub detail: Option<serde_json::Value>,
    /// The stream a worker's `console` call would have written to; `None`
    /// for runtime messages and the worker's own lines.
    pub stream: Option<LogStream>,
    /// When the worker wrote the line, when it said.
    pub time: Option<SystemTime>,
}

impl LogEvent {
    #[must_use]
    pub fn new(level: &str, label: &str, message: String) -> Self {
        Self {
            level: level.to_owned(),
            label: label.to_owned(),
            message,
            execution: None,
            function: None,
            codebase: None,
            kind: None,
            detail: None,
            stream: None,
            time: None,
        }
    }

    #[must_use]
    pub fn with_execution(mut self, execution: impl Into<String>) -> Self {
        self.execution = Some(execution.into());
        self
    }

    #[must_use]
    pub fn with_function(mut self, function: impl Into<String>) -> Self {
        self.function = Some(function.into());
        self
    }

    #[must_use]
    pub fn with_codebase(mut self, codebase: impl Into<String>) -> Self {
        self.codebase = Some(codebase.into());
        self
    }

    #[must_use]
    pub fn with_kind(mut self, kind: &'static str) -> Self {
        self.kind = Some(kind);
        self
    }

    #[must_use]
    pub fn with_detail(mut self, detail: serde_json::Value) -> Self {
        self.detail = Some(detail);
        self
    }

    #[must_use]
    pub fn with_stream(mut self, stream: LogStream) -> Self {
        self.stream = Some(stream);
        self
    }

    #[must_use]
    pub fn with_time(mut self, time: SystemTime) -> Self {
        self.time = Some(time);
        self
    }

    /// A line with no counterpart in the official emulator's output: the
    /// terminal and the official records skip it; the console shows it.
    #[must_use]
    pub fn is_console_only(&self) -> bool {
        self.detail
            .as_ref()
            .and_then(|detail| detail.get("consoleOnly"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    }

    /// The level the terminal prints the line at and the official records
    /// file it under: the stream's for a worker's `console` line (so
    /// `console.debug` still prints and `console.error` stays `WARN`), the
    /// line's own otherwise.
    #[must_use]
    pub fn terminal_level(&self) -> &str {
        match self.stream {
            Some(stream) => stream.legacy_level(),
            None => &self.level,
        }
    }

    /// The lines the terminal prints: a worker's `console` message one per
    /// line, as the unattributed worker's output arrived; anything else
    /// whole, embedded newlines included. Nothing for a console-only line.
    #[must_use]
    pub fn terminal_lines(&self) -> Vec<&str> {
        if self.is_console_only() {
            return Vec::new();
        }
        if self.stream.is_none() {
            return vec![self.message.as_str()];
        }
        self.message
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line))
            .collect()
    }

    /// The events the runtime handed the suite before it attributed lines:
    /// one per terminal line at the terminal level, none for a console-only
    /// line. A sink written for the earlier events keeps printing and
    /// recording exactly what it did.
    #[must_use]
    pub fn compatible_events(&self) -> Vec<Self> {
        if self.stream.is_none() && !self.is_console_only() {
            return vec![self.clone()];
        }
        let level = self.terminal_level();
        self.terminal_lines()
            .into_iter()
            .map(|line| Self {
                level: level.to_owned(),
                message: line.to_owned(),
                ..self.clone()
            })
            .collect()
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
        Self::new(|event| eprintln!("firenook {}: {}", event.label, event.message))
    }

    /// A sink that keeps every event in memory (tests and harnesses).
    #[must_use]
    pub fn recording() -> (Self, Arc<std::sync::Mutex<Vec<LogEvent>>>) {
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink_events = Arc::clone(&events);
        let sink = Self::new(move |event| {
            if let Ok(mut guard) = sink_events.lock() {
                guard.push(event);
            }
        });
        (sink, events)
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn worker_console_lines_print_at_their_streams_level_one_per_line() {
        let debug = LogEvent::new("DEBUG", "functions", "d".to_owned())
            .with_stream(LogStream::Stdout)
            .with_execution("abc123-1");
        assert_eq!(debug.terminal_level(), "INFO");
        let error = LogEvent::new("ERROR", "functions", "first\r\nsecond\n".to_owned())
            .with_stream(LogStream::Stderr);
        assert_eq!(error.terminal_level(), "WARN");
        assert_eq!(error.terminal_lines(), ["first", "second", ""]);
        let compatible = error.compatible_events();
        assert_eq!(compatible.len(), 3);
        assert!(compatible.iter().all(|event| event.level == "WARN"));
        assert_eq!(compatible[1].message, "second");
    }

    #[test]
    fn runtime_messages_stay_whole_at_their_level() {
        let timeout = LogEvent::new(
            "ERROR",
            "functions[us-central1-slow]",
            "Your function timed out after ~1s. To configure this timeout, see\n      https://example".to_owned(),
        )
        .with_kind("function.timeout");
        assert_eq!(timeout.terminal_level(), "ERROR");
        assert_eq!(timeout.terminal_lines().len(), 1);
        assert_eq!(timeout.compatible_events(), std::slice::from_ref(&timeout));
    }

    #[test]
    fn console_only_lines_never_reach_the_terminal() {
        let end = LogEvent::new("INFO", "functions", "Finished \"x\" in 1ms".to_owned())
            .with_detail(json!({"consoleOnly": true, "durationMs": 1.0}));
        assert!(end.is_console_only());
        assert_eq!(end.terminal_lines(), Vec::<&str>::new());
        assert_eq!(end.compatible_events(), Vec::<LogEvent>::new());
        let plain =
            LogEvent::new("INFO", "functions", "x".to_owned()).with_detail(json!({"status": 200}));
        assert!(!plain.is_console_only());
    }
}
