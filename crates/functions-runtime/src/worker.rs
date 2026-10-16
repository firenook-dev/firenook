//! One Node worker process per codebase: spawned with the codebase's
//! environment, reports its loopback port, pid and Node version on stdout,
//! streams attributed log lines back, and is watched: a task owns the child
//! process, so an exit is reported the moment it happens, not discovered by
//! the next call.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt as _, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, mpsc, oneshot};

use crate::RuntimeError;
use crate::log::{LogEvent, LogSink, LogStream};
use crate::monitor::{FUNCTION_ERROR, Monitor, WorkerTransition, exit_description};

/// The record prefix of a worker log line.
const LOG_PREFIX: &str = "FIRENOOK_WORKER_LOG ";
/// How long a stopped worker gets to exit after `/__/quit` before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(3);

/// What the runtime needs to start a codebase's worker.
#[derive(Debug, Clone)]
pub struct WorkerSpec {
    pub codebase: String,
    pub node: PathBuf,
    pub script: PathBuf,
    pub source_dir: PathBuf,
    pub environment: BTreeMap<String, String>,
    /// `--inspect=host:port` for the worker when debugging is requested.
    pub inspect: Option<(String, u16)>,
    pub label: String,
}

#[derive(Debug, Deserialize)]
struct ReadyLine {
    port: u16,
    pid: Option<u32>,
    node: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LogLine {
    level: String,
    message: String,
    #[serde(default)]
    function: Option<String>,
    #[serde(default)]
    execution: Option<String>,
    #[serde(default)]
    stream: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    /// Milliseconds since the epoch, as the worker stamped the line.
    #[serde(default)]
    time: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct FatalLine {
    message: String,
}

struct Ready {
    port: u16,
    pid: Option<u32>,
    node: Option<String>,
}

/// A running worker. The child process belongs to its watcher task.
pub struct Worker {
    port: u16,
    pid: Option<u32>,
    node: Option<String>,
    exited: Arc<AtomicBool>,
    /// Asks the watcher to stop the process; it answers once it is gone.
    stop: Option<oneshot::Sender<oneshot::Sender<()>>>,
}

impl Worker {
    /// Starts the worker and waits for its readiness line. `monitor` hears
    /// of the process's exit at once (as `codebase`).
    pub async fn spawn(
        spec: &WorkerSpec,
        log: &LogSink,
        timeout: Duration,
        monitor: &Monitor,
    ) -> Result<Self, RuntimeError> {
        let mut command = Command::new(&spec.node);
        if let Some((host, port)) = &spec.inspect {
            command.arg(format!("--inspect={host}:{port}"));
        }
        command
            .arg(&spec.script)
            .arg(&spec.source_dir)
            .arg(&spec.codebase)
            .current_dir(&spec.source_dir)
            .env_clear()
            .envs(&spec.environment)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|error| {
            RuntimeError(format!(
                "failed to start the functions worker for {}: {error}",
                spec.codebase
            ))
        })?;
        let (ready_sender, mut ready_receiver) = mpsc::unbounded_channel::<Result<Ready, String>>();
        let exited = Arc::new(AtomicBool::new(false));
        if let Some(stdout) = child.stdout.take() {
            let log = log.clone();
            let label = spec.label.clone();
            let codebase = spec.codebase.clone();
            let exited = Arc::clone(&exited);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(json) = line.strip_prefix("FIRENOOK_WORKER_READY ") {
                        let ready = serde_json::from_str::<ReadyLine>(json)
                            .map(|ready| Ready {
                                port: ready.port,
                                pid: ready.pid,
                                node: ready.node,
                            })
                            .map_err(|error| format!("invalid worker readiness line: {error}"));
                        let _ = ready_sender.send(ready);
                    } else if let Some(json) = line.strip_prefix("FIRENOOK_WORKER_FATAL ") {
                        let message = serde_json::from_str::<FatalLine>(json)
                            .map_or_else(|_| json.to_owned(), |fatal| fatal.message);
                        log.record(
                            LogEvent::new("ERROR", &label, message.clone())
                                .with_codebase(&codebase),
                        );
                        let _ = ready_sender.send(Err(message));
                    } else {
                        for event in worker_events(&line, &label, &codebase) {
                            log.record(event);
                        }
                    }
                }
                exited.store(true, Ordering::SeqCst);
            });
        }
        if let Some(stderr) = child.stderr.take() {
            let log = log.clone();
            let label = spec.label.clone();
            let codebase = spec.codebase.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log.record(LogEvent::new("WARN", &label, line).with_codebase(&codebase));
                }
            });
        }
        let deadline = Instant::now() + timeout;
        let ready = loop {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(RuntimeError(format!(
                    "the functions worker for {} exited before readiness: {status}",
                    spec.codebase
                )));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                let _ = child.kill().await;
                return Err(RuntimeError("Failed to load function.".to_owned()));
            }
            match tokio::time::timeout(
                remaining.min(Duration::from_millis(200)),
                ready_receiver.recv(),
            )
            .await
            {
                Ok(Some(Ok(ready))) => break ready,
                Ok(Some(Err(message))) => {
                    let _ = child.kill().await;
                    return Err(RuntimeError(message));
                }
                Ok(None) => {
                    let _ = child.kill().await;
                    return Err(RuntimeError(format!(
                        "the functions worker for {} closed its output before readiness",
                        spec.codebase
                    )));
                }
                Err(_) => {}
            }
        };
        let (stop, stop_requests) = oneshot::channel();
        tokio::spawn(watch(
            child,
            origin_of(ready.port),
            Arc::clone(&exited),
            stop_requests,
            monitor.clone(),
            spec.codebase.clone(),
        ));
        Ok(Self {
            port: ready.port,
            pid: ready.pid,
            node: ready.node,
            exited,
            stop: Some(stop),
        })
    }

    /// Loopback origin of the worker's HTTP listener.
    #[must_use]
    pub fn origin(&self) -> String {
        origin_of(self.port)
    }

    /// The worker process's id, as it reported it.
    #[must_use]
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// The Node version the worker runs, as it reported it.
    #[must_use]
    pub fn node(&self) -> Option<&str> {
        self.node.as_deref()
    }

    /// Whether the process is still running.
    #[must_use]
    pub fn alive(&self) -> bool {
        !self.exited.load(Ordering::SeqCst)
    }

    /// Asks the worker to exit and waits briefly before killing it.
    pub async fn stop(mut self) {
        let Some(stop) = self.stop.take() else {
            return;
        };
        let (done, gone) = oneshot::channel();
        if stop.send(done).is_ok() {
            let _ = tokio::time::timeout(STOP_GRACE * 2, gone).await;
        }
    }
}

fn origin_of(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Owns the child: reports an exit the moment it happens, or stops the
/// process on request (`/__/quit`, then a kill after the grace period).
/// Dropping the worker without stopping it kills the process.
async fn watch(
    mut child: Child,
    origin: String,
    exited: Arc<AtomicBool>,
    stop: oneshot::Receiver<oneshot::Sender<()>>,
    monitor: Monitor,
    codebase: String,
) {
    tokio::select! {
        status = child.wait() => {
            exited.store(true, Ordering::SeqCst);
            let status = status.map_or_else(
                |error| format!("could not be waited on: {error}"),
                exit_description,
            );
            monitor.worker_state(&codebase, WorkerTransition::Exited { status });
        }
        request = stop => {
            if let Ok(done) = request {
                if let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(2)).build() {
                    let _ = client.post(format!("{origin}/__/quit")).send().await;
                }
                if tokio::time::timeout(STOP_GRACE, child.wait()).await.is_err() {
                    let _ = child.kill().await;
                }
                exited.store(true, Ordering::SeqCst);
                let _ = done.send(());
            } else {
                let _ = child.kill().await;
                exited.store(true, Ordering::SeqCst);
            }
        }
    }
}

/// The events one stdout line of a worker becomes: an attributed record, a
/// plain line (INFO, as Node's stdout was always filed), or both when a
/// partial raw write ran into a record.
fn worker_events(line: &str, label: &str, codebase: &str) -> Vec<LogEvent> {
    let (raw, record) = match line.find(LOG_PREFIX) {
        Some(0) => ("", Some(&line[LOG_PREFIX.len()..])),
        Some(index) => (&line[..index], Some(&line[index + LOG_PREFIX.len()..])),
        None => (line, None),
    };
    let mut events = Vec::with_capacity(2);
    if record.is_none() || !raw.is_empty() {
        events.push(LogEvent::new("INFO", label, raw.to_owned()).with_codebase(codebase));
    }
    if let Some(json) = record
        && let Ok(entry) = serde_json::from_str::<LogLine>(json)
    {
        let mut event = LogEvent::new(&entry.level, label, entry.message).with_codebase(codebase);
        event.execution = entry.execution;
        event.function = entry.function;
        event.stream = match entry.stream.as_deref() {
            Some("stdout") => Some(LogStream::Stdout),
            Some("stderr") => Some(LogStream::Stderr),
            _ => None,
        };
        event.kind = match entry.kind.as_deref() {
            Some(FUNCTION_ERROR) => Some(FUNCTION_ERROR),
            Some("worker.uncaught") => Some("worker.uncaught"),
            _ => None,
        };
        event.time = entry
            .time
            .filter(|millis| millis.is_finite() && *millis >= 0.0)
            .map(|millis| UNIX_EPOCH + Duration::from_secs_f64(millis / 1000.0));
        events.push(event);
    }
    events
}

/// The worker slot of one codebase: at most one live worker, started on
/// demand and replaced after an exit.
pub struct WorkerSlot {
    spec: Mutex<WorkerSpec>,
    worker: Mutex<Option<Worker>>,
    log: LogSink,
    monitor: Monitor,
    codebase: String,
}

impl WorkerSlot {
    #[must_use]
    pub fn new(spec: WorkerSpec, log: LogSink, monitor: Monitor, codebase: String) -> Self {
        Self {
            spec: Mutex::new(spec),
            worker: Mutex::new(None),
            log,
            monitor,
            codebase,
        }
    }

    /// Replaces the spec (after a reload) and stops the current worker.
    pub async fn replace(&self, spec: WorkerSpec) {
        *self.spec.lock().await = spec;
        self.stop().await;
    }

    /// Returns the live worker's origin, starting one when needed.
    pub async fn origin(&self, timeout: Duration) -> Result<String, RuntimeError> {
        self.origin_timed(timeout).await.map(|(origin, _)| origin)
    }

    /// Returns the live worker's origin and, when this call had to start
    /// the worker, how long that took (a cold start).
    pub async fn origin_timed(
        &self,
        timeout: Duration,
    ) -> Result<(String, Option<Duration>), RuntimeError> {
        let mut slot = self.worker.lock().await;
        if let Some(worker) = slot.as_ref()
            && worker.alive()
        {
            return Ok((worker.origin(), None));
        }
        if slot.is_some() {
            let spec = self.spec.lock().await;
            self.log.record(
                LogEvent::new(
                    "WARN",
                    &spec.label,
                    "functions worker exited; starting a new one".to_owned(),
                )
                .with_codebase(&self.codebase),
            );
        }
        let spec = self.spec.lock().await.clone();
        self.monitor
            .worker_state(&self.codebase, WorkerTransition::Starting);
        let started = Instant::now();
        match Worker::spawn(&spec, &self.log, timeout, &self.monitor).await {
            Ok(worker) => {
                let took = started.elapsed();
                self.monitor.worker_state(
                    &self.codebase,
                    WorkerTransition::Running {
                        pid: worker.pid(),
                        node: worker.node().map(str::to_owned),
                        start: took,
                    },
                );
                let origin = worker.origin();
                *slot = Some(worker);
                Ok((origin, Some(took)))
            }
            Err(error) => {
                *slot = None;
                self.monitor.worker_state(
                    &self.codebase,
                    WorkerTransition::Failed {
                        message: error.0.clone(),
                    },
                );
                Err(error)
            }
        }
    }

    /// Starts the worker eagerly (readiness) without holding the request path.
    pub async fn warm(&self, timeout: Duration) -> Result<(), RuntimeError> {
        self.origin(timeout).await.map(|_| ())
    }

    /// Stops the current worker if any; the codebase's worker reads
    /// `stopped` ("starts on the next call") afterwards.
    pub async fn stop(&self) {
        let worker = self.worker.lock().await.take();
        if let Some(worker) = worker {
            worker.stop().await;
        }
        self.monitor
            .worker_state(&self.codebase, WorkerTransition::Stopped);
    }

    /// The source directory this slot serves.
    pub async fn source_dir(&self) -> PathBuf {
        self.spec.lock().await.source_dir.clone()
    }
}

/// Where the runtime materializes the embedded worker script.
pub fn materialize_script(state_dir: &Path, source: &str) -> Result<PathBuf, RuntimeError> {
    let path = state_dir.join("functions-worker.mjs");
    std::fs::create_dir_all(state_dir).map_err(|error| {
        RuntimeError(format!(
            "failed to create the functions state directory: {error}"
        ))
    })?;
    std::fs::write(&path, source).map_err(|error| {
        RuntimeError(format!(
            "failed to materialize the functions worker: {error}"
        ))
    })?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attributed_records_carry_their_invocation() {
        let line = r#"FIRENOOK_WORKER_LOG {"level":"DEBUG","message":"d","function":"us-central1-api","execution":"abc123-7","stream":"stdout","time":1791814931000}"#;
        let events = worker_events(line, "functions", "default");
        let [event] = events.as_slice() else {
            panic!("one event: {events:?}");
        };
        assert_eq!(event.level, "DEBUG");
        assert_eq!(event.message, "d");
        assert_eq!(event.execution.as_deref(), Some("abc123-7"));
        assert_eq!(event.function.as_deref(), Some("us-central1-api"));
        assert_eq!(event.codebase.as_deref(), Some("default"));
        assert_eq!(event.stream, Some(LogStream::Stdout));
        assert_eq!(
            event.time,
            Some(UNIX_EPOCH + Duration::from_secs(1_791_814_931))
        );
        assert_eq!(event.terminal_level(), "INFO");
    }

    #[test]
    fn handler_errors_and_plain_lines() {
        let error = worker_events(
            r#"FIRENOOK_WORKER_LOG {"level":"ERROR","message":"Error: boom","kind":"function.error","execution":"abc123-1"}"#,
            "functions",
            "default",
        );
        assert_eq!(error[0].kind, Some(FUNCTION_ERROR));
        assert_eq!(error[0].stream, None);
        let plain = worker_events(
            "written with process.stdout",
            "extensions[greeter]",
            "greeter",
        );
        assert_eq!(plain.len(), 1);
        assert_eq!(plain[0].level, "INFO");
        assert_eq!(plain[0].execution, None);
        assert_eq!(plain[0].codebase.as_deref(), Some("greeter"));
        // A partial raw write followed by a record on the same line.
        let both = worker_events(
            r#"partialFIRENOOK_WORKER_LOG {"level":"INFO","message":"x","stream":"stdout"}"#,
            "functions",
            "default",
        );
        assert_eq!(both.len(), 2);
        assert_eq!(both[0].message, "partial");
        assert_eq!(both[1].message, "x");
    }
}
