//! A Functions runtime over a real Node worker, for the dispatch tests.
//!
//! The worker resolves Express from the offline Functions SDK install
//! (`FIRENOOK_FUNCTIONS_SDK`, else `console/e2e/functions-sdk/node_modules`,
//! which `npm run e2e:sdk --prefix console` installs). Without Node or that
//! install a test prints why and returns.
#![allow(dead_code, unreachable_pub)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::Request;
use firenook_functions_bridge::TriggerRegistry;
use firenook_functions_runtime::{
    CodebaseConfig, EmulatorHosts, FunctionsRuntime, LogDelivery, LogEvent, LogSink, Monitor,
    MonitorLimits, RuntimeConfig, RuntimeOptions,
};
use tower::ServiceExt as _;

pub const PROJECT: &str = "demo-dispatch";

/// The Node binary on `PATH`.
pub fn node() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
        .find(|candidate| candidate.is_file())
}

/// A `node_modules` directory that holds Express.
pub fn sdk() -> Option<PathBuf> {
    let candidate = std::env::var_os("FIRENOOK_FUNCTIONS_SDK").map_or_else(
        || {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../console/e2e/functions-sdk/node_modules")
        },
        PathBuf::from,
    );
    candidate
        .join("express/package.json")
        .is_file()
        .then_some(candidate)
}

/// Both, or why a test cannot run.
pub fn requirements() -> Result<(PathBuf, PathBuf), String> {
    let node = node().ok_or("node is not on PATH")?;
    let sdk = sdk().ok_or(
        "no Functions SDK install: run `npm run e2e:sdk --prefix console` or set FIRENOOK_FUNCTIONS_SDK to a node_modules directory with express",
    )?;
    Ok((node, sdk))
}

/// A running runtime over one codebase, with every log event it emitted.
pub struct Harness {
    pub runtime: FunctionsRuntime,
    pub monitor: Monitor,
    pub events: Arc<Mutex<Vec<LogEvent>>>,
    pub directory: tempfile::TempDir,
}

impl Harness {
    /// Writes `index.js` and `functions.yaml` into a fresh codebase and starts
    /// the runtime over it.
    pub async fn start(index: &str, manifest: &str, delivery: LogDelivery) -> Result<Self, String> {
        Self::start_with_files(index, manifest, delivery, &[], |_| {}).await
    }

    /// [`Harness::start`] with extra files in the codebase, and a last look
    /// at the codebase directory before the runtime starts.
    pub async fn start_with_files(
        index: &str,
        manifest: &str,
        delivery: LogDelivery,
        files: &[(&str, &str)],
        prepare: impl FnOnce(&Path),
    ) -> Result<Self, String> {
        let (node, sdk) = requirements()?;
        let directory = tempfile::Builder::new()
            .prefix("firenook-dispatch-")
            .tempdir()
            .map_err(|error| error.to_string())?;
        let root = directory
            .path()
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let source = root.join("functions");
        std::fs::create_dir_all(&source).map_err(|error| error.to_string())?;
        std::fs::write(source.join("index.js"), index).map_err(|error| error.to_string())?;
        std::fs::write(source.join("functions.yaml"), manifest)
            .map_err(|error| error.to_string())?;
        std::fs::write(
            source.join("package.json"),
            "{\"name\":\"dispatch\",\"main\":\"index.js\"}",
        )
        .map_err(|error| error.to_string())?;
        link(&sdk, &source.join("node_modules"))?;
        for (name, content) in files {
            let path = source.join(name);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            std::fs::write(path, content).map_err(|error| error.to_string())?;
        }
        prepare(&source);
        let monitor = Monitor::new(MonitorLimits::default());
        let (log, events) = LogSink::recording();
        let host = "127.0.0.1:1".to_owned();
        let config = RuntimeConfig {
            project_id: PROJECT.to_owned(),
            project_alias: None,
            host: "127.0.0.1".to_owned(),
            functions_port: 5001,
            project_dir: root.clone(),
            node,
            state_dir: root.join("state"),
            default_bucket: format!("{PROJECT}.appspot.com"),
            hosts: EmulatorHosts {
                firestore: host.clone(),
                auth: host.clone(),
                storage: host.clone(),
                pubsub: host.clone(),
                hub: host.clone(),
                eventarc: host.clone(),
                tasks: host,
            },
            codebases: vec![CodebaseConfig {
                id: "default".to_owned(),
                source_dir: source,
                runtime: Some("nodejs22".to_owned()),
                ignore: Vec::new(),
                config_dir: None,
            }],
            extensions: Vec::new(),
            inspect: None,
        };
        let runtime = FunctionsRuntime::start_with(
            config,
            TriggerRegistry::default(),
            log,
            RuntimeOptions {
                monitor: monitor.clone(),
                log_delivery: delivery,
            },
        )
        .await
        .map_err(|error| error.0)?;
        Ok(Self {
            runtime,
            monitor,
            events,
            directory,
        })
    }

    pub fn events(&self) -> Vec<LogEvent> {
        self.events
            .lock()
            .map(|events| events.clone())
            .unwrap_or_default()
    }

    /// The end lines written for one invocation.
    pub fn end_lines(&self, execution: &str) -> Vec<LogEvent> {
        self.events()
            .into_iter()
            .filter(|event| event.execution.as_deref() == Some(execution))
            .filter(|event| {
                matches!(
                    event.kind,
                    Some(
                        "function.finish"
                            | "function.failed"
                            | "function.timeout"
                            | "function.crashed"
                    )
                )
            })
            .collect()
    }

    pub async fn call(&self, request: Request<Body>) -> axum::response::Response {
        self.runtime
            .router()
            .oneshot(request)
            .await
            .expect("the router answers")
    }

    /// Calls and reads the whole answer.
    pub async fn call_text(
        &self,
        request: Request<Body>,
    ) -> (axum::response::Response<()>, String) {
        let response = self.call(request).await;
        let (parts, body) = response.into_parts();
        let bytes = axum::body::to_bytes(body, usize::MAX)
            .await
            .expect("a body");
        (
            axum::response::Response::from_parts(parts, ()),
            String::from_utf8_lossy(&bytes).into_owned(),
        )
    }

    pub async fn stop(self) {
        self.runtime.shutdown().await;
    }
}

/// Waits (up to 10 s) until `check` holds.
pub async fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !check() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn link(target: &Path, link: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).map_err(|error| error.to_string())
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(target, link).map_err(|error| error.to_string())
    }
}
