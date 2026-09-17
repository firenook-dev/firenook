//! One Node worker process per codebase: spawned with the codebase's
//! environment, reports its loopback port on stdout, streams user logs back,
//! and is restarted by the runtime when it exits.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt as _, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, mpsc};

use crate::RuntimeError;
use crate::log::{LogEvent, LogSink};

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
    #[allow(dead_code)]
    pid: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct LogLine {
    level: String,
    message: String,
}

#[derive(Debug, Deserialize)]
struct FatalLine {
    message: String,
}

/// A running worker.
pub struct Worker {
    child: Child,
    port: u16,
    exited: Arc<std::sync::atomic::AtomicBool>,
}

impl Worker {
    /// Starts the worker and waits for its readiness line.
    pub async fn spawn(
        spec: &WorkerSpec,
        log: &LogSink,
        timeout: Duration,
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
        let (ready_sender, mut ready_receiver) = mpsc::unbounded_channel::<Result<u16, String>>();
        let exited = Arc::new(std::sync::atomic::AtomicBool::new(false));
        if let Some(stdout) = child.stdout.take() {
            let log = log.clone();
            let label = spec.label.clone();
            let exited = Arc::clone(&exited);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(json) = line.strip_prefix("FIRESIDE_WORKER_READY ") {
                        match serde_json::from_str::<ReadyLine>(json) {
                            Ok(ready) => {
                                let _ = ready_sender.send(Ok(ready.port));
                            }
                            Err(error) => {
                                let _ = ready_sender
                                    .send(Err(format!("invalid worker readiness line: {error}")));
                            }
                        }
                    } else if let Some(json) = line.strip_prefix("FIRESIDE_WORKER_LOG ") {
                        if let Ok(entry) = serde_json::from_str::<LogLine>(json) {
                            log.record(LogEvent::new(&entry.level, &label, entry.message));
                        }
                    } else if let Some(json) = line.strip_prefix("FIRESIDE_WORKER_FATAL ") {
                        let message = serde_json::from_str::<FatalLine>(json)
                            .map_or_else(|_| json.to_owned(), |fatal| fatal.message);
                        log.record(LogEvent::new("ERROR", &label, message.clone()));
                        let _ = ready_sender.send(Err(message));
                    } else {
                        log.record(LogEvent::new("INFO", &label, line));
                    }
                }
                exited.store(true, std::sync::atomic::Ordering::SeqCst);
            });
        }
        if let Some(stderr) = child.stderr.take() {
            let log = log.clone();
            let label = spec.label.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log.record(LogEvent::new("WARN", &label, line));
                }
            });
        }
        let deadline = Instant::now() + timeout;
        loop {
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
                Ok(Some(Ok(port))) => {
                    return Ok(Self {
                        child,
                        port,
                        exited,
                    });
                }
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
        }
    }

    /// Loopback origin of the worker's HTTP listener.
    #[must_use]
    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Whether the process is still running.
    pub fn alive(&mut self) -> bool {
        if self.exited.load(std::sync::atomic::Ordering::SeqCst) {
            return false;
        }
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Asks the worker to exit and waits briefly before killing it.
    pub async fn stop(mut self) {
        if let Ok(Some(_)) = self.child.try_wait() {
            return;
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build();
        if let Ok(client) = client {
            let _ = client
                .post(format!("{}/__/quit", self.origin()))
                .send()
                .await;
        }
        if tokio::time::timeout(Duration::from_secs(3), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
        }
    }
}

/// The worker slot of one codebase: at most one live worker, started on
/// demand and replaced after an exit.
pub struct WorkerSlot {
    spec: Mutex<WorkerSpec>,
    worker: Mutex<Option<Worker>>,
    log: LogSink,
}

impl WorkerSlot {
    #[must_use]
    pub fn new(spec: WorkerSpec, log: LogSink) -> Self {
        Self {
            spec: Mutex::new(spec),
            worker: Mutex::new(None),
            log,
        }
    }

    /// Replaces the spec (after a reload) and stops the current worker.
    pub async fn replace(&self, spec: WorkerSpec) {
        *self.spec.lock().await = spec;
        self.stop().await;
    }

    /// Returns the live worker's origin, starting one when needed.
    pub async fn origin(&self, timeout: Duration) -> Result<String, RuntimeError> {
        let mut slot = self.worker.lock().await;
        if let Some(worker) = slot.as_mut()
            && worker.alive()
        {
            return Ok(worker.origin());
        }
        if slot.is_some() {
            let spec = self.spec.lock().await;
            self.log.record(LogEvent::new(
                "WARN",
                &spec.label,
                "functions worker exited; starting a new one".to_owned(),
            ));
        }
        let spec = self.spec.lock().await.clone();
        let worker = Worker::spawn(&spec, &self.log, timeout).await?;
        let origin = worker.origin();
        *slot = Some(worker);
        Ok(origin)
    }

    /// Starts the worker eagerly (readiness) without holding the request path.
    pub async fn warm(&self, timeout: Duration) -> Result<(), RuntimeError> {
        self.origin(timeout).await.map(|_| ())
    }

    /// Stops the current worker if any.
    pub async fn stop(&self) {
        let worker = self.worker.lock().await.take();
        if let Some(worker) = worker {
            worker.stop().await;
        }
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
