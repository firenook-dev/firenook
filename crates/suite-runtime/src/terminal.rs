//! Terminal events: the facts the npm package's terminal UI draws, one
//! `FIRENOOK_EVENT <json>` line each on stdout, in place of the human lines
//! they stand for.
//!
//! Off unless the CLI's `--terminal-events` turns it on for the process.
//! Only the npm package passes it, and only when it draws the terminal
//! itself. Off, nothing here prints and the engine prints exactly what it
//! printed before: pipes, CI, log files and every harness read that output,
//! and its `All emulators ready` line is their contract.
//!
//! On, a line with a stand-in here (the log, start-up progress, readiness)
//! is not printed; every other line still is, and the terminal UI shows it
//! as it is. Events:
//!
//! - `opening` — how the data starts: `resume` (with `savedAt`), `import`
//!   (with the `seed` directory) or `fresh`.
//! - `step` — a start-up row: `running` (a `verb`, then `done`/`total`
//!   progress), `done` (`ms`, `figures` as `[count, words]` pairs, `note`)
//!   or `failed` (`ms`, `message`). Ids: `data`, `firestore`, `auth`,
//!   `storage`, `functions`, `pubsub`.
//! - `ready` — `ms` since the process began, `console`, `ports`,
//!   `functions`, and the start-up `warnings`, said once here rather than
//!   along the log.
//! - `log` — a line of the log: `level`, `source`, `message`, and for a
//!   Functions line its `function`, `codebase`, `execution` and `kind`.
//! - `call` — an invocation `started` or `finished`, the summary the
//!   console's Invocations page shows.
//! - `codebase` — a Functions codebase or extension instance as the
//!   console's Functions page shows it, on every load.
//! - `failed` — why the suite could not start or stopped: `kind` (`port`,
//!   `state`, `other`), `message`, and for a port its `service`, `host` and
//!   `port`.
//! - `stopping`, `stopped` — shutdown, with what it saved.

use std::io::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

use firenook_functions_runtime::LogEvent;
use firenook_functions_runtime::monitor::{FunctionCodebaseKind, LiveSink, MonitorEvent};
use serde_json::{Value, json};

static ENABLED: AtomicBool = AtomicBool::new(false);
/// What is said before readiness, and whether `ready` was sent. A line is
/// decided, and the `ready` event sent, under its lock, so no line said
/// while the suite becomes ready is lost or comes before `ready`.
static START: Mutex<Start> = Mutex::new(Start {
    ready: false,
    warnings: Vec::new(),
    held: Vec::new(),
});
/// The process's start, for the ready time.
static BEGAN: LazyLock<Instant> = LazyLock::new(Instant::now);
/// At most this many progress events a second per step.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// Turns the events on for this process, in place of the human lines.
pub fn enable() {
    LazyLock::force(&BEGAN);
    ENABLED.store(true, Ordering::SeqCst);
}

/// Whether the events are on (and the lines they stand for are not printed).
#[must_use]
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Event lines on their way to stdout. One thread writes them, in order, so
/// no caller (the Functions monitor calls under its lock) ever waits on the
/// terminal reading its output.
static WRITER: Mutex<Option<Writer>> = Mutex::new(None);

struct Writer {
    lines: std::sync::mpsc::Sender<String>,
    thread: std::thread::JoinHandle<()>,
}

/// Writes one event line, whole, when the events are on.
pub fn emit(event: &Value) {
    if !enabled() {
        return;
    }
    let line = format!("FIRENOOK_EVENT {event}\n");
    let mut writer = WRITER.lock().unwrap_or_else(PoisonError::into_inner);
    if writer.is_none() {
        let (lines, received) = std::sync::mpsc::channel::<String>();
        let spawned = std::thread::Builder::new()
            .name("firenook-terminal-events".to_owned())
            .spawn(move || {
                let mut out = std::io::stdout();
                for line in received {
                    let _ = out.write_all(line.as_bytes());
                    let _ = out.flush();
                }
            });
        if let Ok(thread) = spawned {
            *writer = Some(Writer { lines, thread });
        } else {
            let _ = std::io::stdout().write_all(line.as_bytes());
            return;
        }
    }
    if let Some(writer) = writer.as_ref() {
        let _ = writer.lines.send(line);
    }
}

/// Writes every event line still on its way, before the process exits.
pub fn finish() {
    let writer = WRITER.lock().unwrap_or_else(PoisonError::into_inner).take();
    if let Some(Writer { lines, thread }) = writer {
        drop(lines);
        let _ = thread.join();
    }
}

/// A start-up row from its first progress to its outcome. Dropped without
/// one (the start-up failed elsewhere), it says nothing: the `failed` event
/// that follows stops every row still running.
pub(crate) struct Step {
    id: &'static str,
    began: Instant,
    said: Mutex<Option<Instant>>,
}

impl Step {
    /// The row starts, doing `verb` (`importing`, `resuming`, `loading` …).
    pub(crate) fn begin(id: &'static str, verb: &str) -> Self {
        emit(&json!({"type": "step", "id": id, "state": "running", "verb": verb}));
        Self {
            id,
            began: Instant::now(),
            said: Mutex::new(None),
        }
    }

    /// How far it has got; said at most ten times a second.
    pub(crate) fn progress(&self, done: u64, total: Option<u64>, detail: Option<&str>) {
        if !enabled() {
            return;
        }
        let now = Instant::now();
        {
            let mut said = self.said.lock().unwrap_or_else(PoisonError::into_inner);
            if said.is_some_and(|at| now.duration_since(at) < PROGRESS_EVERY) {
                return;
            }
            *said = Some(now);
        }
        emit(&json!({
            "type": "step", "id": self.id, "state": "running",
            "done": done, "total": total, "detail": detail,
        }));
    }

    /// It finished: what it holds, as `[count, words]` pairs.
    pub(crate) fn done(self, figures: &[(u64, &str)], note: Option<&str>) {
        emit(&json!({
            "type": "step", "id": self.id, "state": "done", "ms": millis(self.began.elapsed()),
            "figures": figures.iter().map(|(count, words)| json!([count, words])).collect::<Vec<_>>(),
            "note": note,
        }));
    }

    /// It failed, in a few words; the `failed` event says the rest.
    pub(crate) fn failed(self, message: &str) {
        emit(&json!({
            "type": "step", "id": self.id, "state": "failed",
            "ms": millis(self.began.elapsed()), "message": message,
        }));
    }
}

/// `32.6 GB`, `512 MB`: a store's size, as a person reads it.
pub(crate) fn size(bytes: u64) -> String {
    #[allow(clippy::cast_precision_loss)]
    let bytes = bytes as f64;
    if bytes >= 1e9 {
        format!("{:.1} GB", bytes / 1e9)
    } else {
        format!("{:.0} MB", (bytes / 1e6).max(1.0))
    }
}

/// The Firestore row while a repair after an unclean stop reads the store:
/// how far it has got, out of a thousand.
pub(crate) fn repairing(fraction: f64, bytes: u64) {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let done = (fraction.clamp(0.0, 1.0) * 1000.0).round() as u64;
    emit(&json!({
        "type": "step", "id": "firestore", "state": "running", "verb": "repairing",
        "done": done, "total": 1000, "unit": "percent",
        "detail": format!("after an unclean stop, {}", size(bytes)),
    }));
}

/// The repair is over: the row goes back to what it was doing.
pub(crate) fn repaired(verb: &str) {
    emit(&json!({
        "type": "step", "id": "firestore", "state": "running", "verb": verb,
        "done": null, "total": null, "unit": null, "detail": null,
    }));
}

/// Before readiness: the start-up warnings, each text once, for the `ready`
/// event, and the lines kept for the log (an Auth code), said right after
/// it. Once ready, nothing waits.
#[derive(Debug, Default)]
struct Start {
    ready: bool,
    warnings: Vec<String>,
    held: Vec<Value>,
}

impl Start {
    /// A warning: kept for `ready`, or, once ready, the log line to say.
    fn warn(&mut self, source: &str, message: &str) -> Option<Value> {
        if self.ready {
            return Some(log_event("warn", source, message));
        }
        if !self.warnings.iter().any(|known| known == message) {
            self.warnings.push(message.to_owned());
        }
        None
    }

    /// A line the log must show: held until `ready`, or said now.
    fn keep(&mut self, line: Value) -> Option<Value> {
        if self.ready {
            return Some(line);
        }
        self.held.push(line);
        None
    }

    /// Readiness: the warnings for `ready` and the lines held for after it.
    fn open(&mut self) -> (Vec<String>, Vec<Value>) {
        self.ready = true;
        (
            std::mem::take(&mut self.warnings),
            std::mem::take(&mut self.held),
        )
    }
}

fn start() -> std::sync::MutexGuard<'static, Start> {
    START.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A line of the log, as the terminal draws it.
fn log_event(level: &str, source: &str, message: &str) -> Value {
    json!({"type": "log", "level": level, "source": source, "message": message})
}

/// A line of the log from a service (`auth`, `tasks`, `rules`, `firenook`).
/// Before readiness the start-up card says what an information line would
/// (which rules file, which port), so only warnings and errors are kept,
/// for the `ready` event (each text once); after it every line is a line of
/// the log.
pub(crate) fn line(level: &str, source: &str, message: &str) {
    say(level, source, message, false);
}

/// [`line`] for a line the log must show even when it comes before
/// readiness (a sign-in code or link): an information line then waits for
/// `ready` instead of being left to the start-up card.
pub(crate) fn kept_line(level: &str, source: &str, message: &str) {
    say(level, source, message, true);
}

fn say(level: &str, source: &str, message: &str, keep: bool) {
    if !enabled() {
        return;
    }
    let level = level.to_ascii_lowercase();
    let mut start = start();
    let said = if start.ready {
        Some(log_event(&level, source, message))
    } else if matches!(level.as_str(), "warn" | "warning" | "error") {
        start.warn(source, message)
    } else if keep {
        start.keep(log_event(&level, source, message))
    } else {
        None
    };
    drop(start);
    if let Some(said) = said {
        emit(&said);
    }
}

/// Prints `plain` as the engine always has (stdout for information, stderr
/// for a warning or an error), or, with the events on, says it as a line of
/// the log instead.
pub(crate) fn print(level: &str, source: &str, message: &str, plain: &str) {
    if enabled() {
        line(level, source, message);
    } else {
        print_plain(level, plain);
    }
}

/// [`print`] for a line the log must show even before readiness
/// ([`kept_line`]).
pub(crate) fn print_kept(level: &str, source: &str, message: &str, plain: &str) {
    if enabled() {
        kept_line(level, source, message);
    } else {
        print_plain(level, plain);
    }
}

fn print_plain(level: &str, plain: &str) {
    if matches!(level, "WARN" | "ERROR") {
        err(plain);
    } else {
        out(plain);
    }
}

/// One line on stdout. Unlike `println!` it never panics: a launcher that
/// is gone leaves a pipe that refuses every write, and a stop must not end
/// part-way over a line nobody can read.
pub fn out(line: &str) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{line}");
    let _ = stdout.flush();
}

/// One line on stderr; never a panic (see [`out`]).
pub fn err(line: &str) {
    let _ = writeln!(std::io::stderr().lock(), "{line}");
}

/// A line of the Functions log, with what the runtime knows of who printed
/// it. Lifecycle lines (a call's start and end) are said by the `call`
/// events instead; a warning before readiness joins the start-up warnings.
pub(crate) fn functions_line(event: &LogEvent) {
    if !enabled() || event.is_console_only() {
        return;
    }
    if matches!(
        event.kind,
        Some("function.start" | "function.finish" | "function.failed")
    ) {
        return;
    }
    let level = event.level.to_ascii_lowercase();
    // The runtime's own information lines (which files it loaded, which
    // functions it initialized, a change it saw) are said by the `codebase`
    // events; what a function prints, and every warning, still shows.
    if event.stream.is_none()
        && event.execution.is_none()
        && matches!(level.as_str(), "info" | "debug")
    {
        return;
    }
    if level == "warn" && event.execution.is_none() {
        let mut start = start();
        if !start.ready {
            let _ = start.warn(&event.label, &startup_warning(event));
            return;
        }
    }
    emit(&json!({
        "type": "log",
        "level": level,
        "source": event.label,
        "message": event.message,
        "function": event.function,
        "codebase": event.codebase,
        "execution": event.execution,
        "kind": event.kind,
        "detail": event.detail,
        "stream": event.stream.map(|stream| match stream {
            firenook_functions_runtime::LogStream::Stdout => "stdout",
            firenook_functions_runtime::LogStream::Stderr => "stderr",
        }),
    }));
}

/// A Functions warning as the start-up list shows it. The list keeps the
/// text alone, once, so a warning about one function or instance
/// (`functions[us-central1-onUpload]`, `extensions[stripe]`) names it.
fn startup_warning(event: &LogEvent) -> String {
    if event.label.contains('[') {
        format!("{}: {}", event.label, event.message.trim_start())
    } else {
        event.message.clone()
    }
}

/// The suite is ready: every start-up warning goes with it, the lines kept
/// for the log follow it, and later ones are lines of the log.
pub(crate) fn ready(console: Option<&str>, ports: &[(&str, u16)], functions: usize) {
    if !enabled() {
        return;
    }
    let ports: serde_json::Map<String, Value> = ports
        .iter()
        .map(|(name, port)| ((*name).to_owned(), json!(port)))
        .collect();
    let mut start = start();
    let (warnings, held) = start.open();
    emit(&json!({
        "type": "ready", "ms": millis(BEGAN.elapsed()), "console": console,
        "ports": ports, "functions": functions, "warnings": warnings,
    }));
    for line in &held {
        emit(line);
    }
}

/// The Functions row's figures: its functions, then its codebases when there
/// is more than one, then its extension instances.
pub(crate) fn functions_figures(
    runtime: &firenook_functions_runtime::FunctionsRuntime,
    functions: usize,
) -> Vec<(u64, &'static str)> {
    let codebases = runtime.monitor().codebases();
    let user = codebases
        .iter()
        .filter(|codebase| codebase.kind == FunctionCodebaseKind::User)
        .count();
    let extensions = codebases.len() - user;
    let mut figures = vec![counted(count(functions), "function", "functions")];
    if user > 1 {
        figures.push((count(user), "codebases"));
    }
    if extensions > 0 {
        figures.push(counted(count(extensions), "extension", "extensions"));
    }
    figures
}

/// A figure, `[count, words]`, with its noun in the singular for one.
pub(crate) fn counted(count: u64, one: &'static str, many: &'static str) -> (u64, &'static str) {
    (count, plural(count, one, many))
}

/// `one` for a count of one, `many` for any other.
pub(crate) fn plural<'a, N: Copy + PartialEq + From<u8>>(
    count: N,
    one: &'a str,
    many: &'a str,
) -> &'a str {
    if count == N::from(1) { one } else { many }
}

fn count(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

/// The Functions runtime's record, as it changes: codebase loads and calls.
pub(crate) struct FunctionsTap;

impl LiveSink for FunctionsTap {
    fn push(&self, event: &Arc<MonitorEvent>) {
        if !enabled() {
            return;
        }
        let payload = match event.as_ref() {
            MonitorEvent::Codebase(codebase) => json!({"type": "codebase", "codebase": codebase}),
            MonitorEvent::InvocationStarted { summary, .. } => {
                json!({"type": "call", "state": "started", "call": summary})
            }
            MonitorEvent::InvocationFinished { summary, .. } => {
                json!({"type": "call", "state": "finished", "call": summary})
            }
            _ => return,
        };
        emit(&payload);
    }
}

/// Why the suite failed, sorted for the terminal: a port someone else holds,
/// saved data the engine will not pick up, or anything else.
pub fn failed(message: &str) {
    if !enabled() {
        return;
    }
    let event = if let Some((service, address, error)) = bind_failure(message) {
        let (host, port) = address
            .rsplit_once(':')
            .map_or((address, None), |(host, port)| {
                (host, port.parse::<u16>().ok())
            });
        json!({
            "type": "failed", "kind": "port", "message": message, "service": service,
            "host": host.trim_start_matches('[').trim_end_matches(']'), "port": port, "error": error,
        })
    } else if let Some((_, rest)) = message.split_once("native state refused: ") {
        let reason = rest
            .split("; existing data preserved")
            .next()
            .unwrap_or(rest);
        json!({"type": "failed", "kind": "state", "message": message, "reason": reason})
    } else {
        json!({"type": "failed", "kind": "other", "message": message})
    };
    emit(&event);
}

/// `cannot bind <service> at <address>: <error>` → its three parts.
fn bind_failure(message: &str) -> Option<(&str, &str, &str)> {
    let rest = message.split_once("cannot bind ")?.1;
    let (service, rest) = rest.split_once(" at ")?;
    let (address, error) = rest.split_once(": ")?;
    Some((service, address, error))
}

/// How the data starts: picked up from saved state (with when it was last
/// written), imported from a seed, or empty.
pub(crate) fn opening(config: &crate::SuiteConfig, reusing: bool) -> Value {
    if reusing {
        json!({
            "type": "opening", "kind": "resume", "seed": config.import,
            "savedAtMs": saved_at(&config.state_dir),
        })
    } else if let Some(seed) = &config.import {
        json!({"type": "opening", "kind": "import", "seed": seed})
    } else {
        json!({"type": "opening", "kind": "fresh"})
    }
}

/// When saved state was last written: its newest store file's modification
/// time, in milliseconds since the epoch.
fn saved_at(state: &std::path::Path) -> Option<u64> {
    [
        "firestore/firenook.redb",
        "firestore/firenook.wal",
        "auth-state.json",
        "storage/metadata.redb",
    ]
    .iter()
    .filter_map(|file| std::fs::metadata(state.join(file)).ok()?.modified().ok())
    .max()
    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
    .map(millis)
}

/// Shutdown began, exporting to `export` first when given.
pub(crate) fn stopping(export: Option<&std::path::Path>) {
    emit(&json!({"type": "stopping", "export": export}));
}

/// The suite stopped cleanly: what it ran and where its data is.
pub fn stopped(outcome: &Value) {
    emit(&json!({"type": "stopped", "outcome": outcome}));
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bind_failure_names_its_service_address_and_error() {
        assert_eq!(
            bind_failure(
                "cannot bind firestore at 127.0.0.1:8080: Address already in use (os error 48)"
            ),
            Some((
                "firestore",
                "127.0.0.1:8080",
                "Address already in use (os error 48)"
            ))
        );
        assert_eq!(bind_failure("suite state is locked"), None);
    }

    #[test]
    fn a_startup_warning_about_one_function_names_it() {
        let ignored = LogEvent::new(
            "WARN",
            "functions[us-central1-onUpload]",
            "function ignored because the storage emulator does not exist or is not running."
                .to_owned(),
        );
        assert_eq!(
            startup_warning(&ignored),
            "functions[us-central1-onUpload]: function ignored because the storage emulator does not exist or is not running."
        );
        let instance = LogEvent::new(
            "WARN",
            "extensions[stripe]",
            " ignored becuase it includes auth triggered functions".to_owned(),
        );
        assert_eq!(
            startup_warning(&instance),
            "extensions[stripe]: ignored becuase it includes auth triggered functions"
        );
        let general = LogEvent::new("WARN", "functions", "Something to know.".to_owned());
        assert_eq!(startup_warning(&general), "Something to know.");
    }

    #[test]
    fn before_readiness_warnings_wait_for_ready_and_kept_lines_follow_it() {
        let mut start = Start::default();
        assert_eq!(start.warn("auth", "a warning"), None);
        assert_eq!(start.warn("auth", "a warning"), None, "each text once");
        let code = log_event(
            "info",
            "auth",
            "To sign in as ada@example.com, follow this link: …",
        );
        assert_eq!(start.keep(code.clone()), None, "held until ready");
        let (warnings, held) = start.open();
        assert_eq!(warnings, ["a warning"]);
        assert_eq!(held, std::slice::from_ref(&code));
        // Once ready, a warning and a kept line are lines of the log at once.
        assert_eq!(
            start.warn("auth", "later"),
            Some(log_event("warn", "auth", "later"))
        );
        assert_eq!(start.keep(code.clone()), Some(code));
        assert_eq!(start.open(), (Vec::new(), Vec::new()));
    }

    #[test]
    fn a_figure_says_its_noun_in_the_singular_for_one() {
        assert_eq!(counted(1, "document", "documents"), (1, "document"));
        assert_eq!(counted(0, "document", "documents"), (0, "documents"));
        assert_eq!(
            counted(2, "user imported", "users imported"),
            (2, "users imported")
        );
        assert_eq!(plural(1, "file", "files"), "file");
    }
}
