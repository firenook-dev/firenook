//! Endpoint discovery through the firebase-functions SDK's own control API
//! (`node_modules/firebase-functions/lib/bin/firebase-functions.js` with
//! `FUNCTIONS_CONTROL_API=true`, `GET /__/functions.yaml`, then
//! `/__/quitquitquit`) or a static `functions.yaml` in the source directory,
//! which takes precedence as in firebase-tools.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncBufReadExt as _, BufReader};
use tokio::net::TcpListener;
use tokio::process::Command;

use crate::RuntimeError;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

/// Resolves the SDK's discovery binary the way Node resolution would from the
/// source directory (walking up `node_modules`), mirroring
/// `findFunctionsBinary`.
#[must_use]
pub fn find_sdk_root(source_dir: &Path, project_dir: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    let mut current = Some(source_dir);
    while let Some(directory) = current {
        candidates.push(directory.join("node_modules/firebase-functions"));
        current = directory.parent();
    }
    candidates.push(project_dir.join("node_modules/firebase-functions"));
    candidates
        .into_iter()
        .find(|candidate| candidate.join("package.json").is_file())
}

/// The installed firebase-functions version of a codebase, if resolvable.
#[must_use]
pub fn sdk_version(sdk_root: &Path) -> Option<String> {
    let package: Value =
        serde_json::from_slice(&std::fs::read(sdk_root.join("package.json")).ok()?).ok()?;
    package.get("version")?.as_str().map(str::to_owned)
}

/// Discovery timeout: `FUNCTIONS_DISCOVERY_TIMEOUT` seconds or ten seconds.
#[must_use]
pub fn discovery_timeout() -> Duration {
    std::env::var("FUNCTIONS_DISCOVERY_TIMEOUT")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|seconds| *seconds > 0)
        .map_or(DEFAULT_TIMEOUT, Duration::from_secs)
}

/// Reads and parses a static `functions.yaml` (YAML or JSON) if present.
pub fn static_manifest(source_dir: &Path) -> Result<Option<serde_norway::Value>, RuntimeError> {
    let path = source_dir.join("functions.yaml");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(RuntimeError(format!(
                "Unexpected error looking for functions.yaml file: {error}"
            )));
        }
    };
    let parsed: serde_norway::Value = serde_norway::from_str(&text)
        .map_err(|error| RuntimeError(format!("Failed to parse build specification: {error}")))?;
    Ok(Some(parsed))
}

/// Serves the SDK manifest from the codebase and returns the parsed JSON.
pub async fn discover_from_sdk(
    node: &Path,
    sdk_root: &Path,
    source_dir: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<serde_norway::Value, RuntimeError> {
    let binary = sdk_root.join("lib/bin/firebase-functions.js");
    if !binary.is_file() {
        return Err(RuntimeError(
            "Failed to find location of Firebase Functions SDK. Please file a bug on Github (https://github.com/firebase/firebase-tools/).".to_owned(),
        ));
    }
    let port = reserve_port().await?;
    let mut command = Command::new(node);
    command
        .arg(&binary)
        .arg(source_dir)
        .current_dir(source_dir)
        .env_clear()
        .envs(environment)
        .env("FUNCTIONS_CONTROL_API", "true")
        .env("PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for key in [
        "HOME",
        "PATH",
        "NODE_ENV",
        "__FIREBASE_FRAMEWORKS_ENTRY__",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
    ] {
        if let Ok(value) = std::env::var(key) {
            command.env(key, value);
        }
    }
    let mut child = command.spawn().map_err(|error| {
        RuntimeError(format!(
            "failed to start the functions discovery process: {error}"
        ))
    })?;
    let mut stderr_lines = Vec::new();
    let stderr = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut collected = Vec::new();
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                collected.push(line);
            }
        }
        collected
    });
    let stdout = child.stdout.take();
    let stdout_task = tokio::spawn(async move {
        let mut collected = Vec::new();
        if let Some(stdout) = stdout {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                collected.push(line);
            }
        }
        collected
    });
    let timeout = discovery_timeout();
    let deadline = Instant::now() + timeout;
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| RuntimeError(format!("failed to build discovery client: {error}")))?;
    let url = format!("http://127.0.0.1:{port}/__/functions.yaml");
    let result = loop {
        if let Ok(Some(status)) = child.try_wait() {
            break Err(RuntimeError(format!(
                "User code failed to load. Cannot determine backend specification. The discovery process exited with {status}"
            )));
        }
        if Instant::now() >= deadline {
            break Err(RuntimeError(format!(
                "User code failed to load. Cannot determine backend specification. Timeout after {}. See https://firebase.google.com/docs/functions/tips#avoid_deployment_timeouts_during_initialization'",
                timeout.as_millis()
            )));
        }
        match client.get(&url).send().await {
            Ok(response) => {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                if !status.is_success() {
                    break Err(RuntimeError(
                        "Functions codebase could not be analyzed successfully. It may have a syntax or runtime error".to_owned(),
                    ));
                }
                // The SDK serves JSON (valid YAML); the YAML parser keeps the
                // endpoint order either way.
                break serde_norway::from_str::<serde_norway::Value>(&text).map_err(|_| {
                    RuntimeError(format!(
                        "Failed to load function definition from source: {text}"
                    ))
                });
            }
            Err(error) if error.is_connect() || error.is_request() => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => break Err(RuntimeError(format!("discovery request failed: {error}"))),
        }
    };
    let _ = client
        .get(format!("http://127.0.0.1:{port}/__/quitquitquit"))
        .send()
        .await;
    if tokio::time::timeout(Duration::from_secs(10), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
    stderr_lines.extend(stderr_task.await.unwrap_or_default());
    let stdout_lines = stdout_task.await.unwrap_or_default();
    match result {
        Ok(manifest) => Ok(manifest),
        Err(RuntimeError(message)) => {
            let detail: Vec<String> = stderr_lines
                .iter()
                .chain(
                    stdout_lines
                        .iter()
                        .filter(|line| !line.starts_with("Serving at port")),
                )
                .cloned()
                .collect();
            if detail.is_empty() {
                Err(RuntimeError(message))
            } else {
                Err(RuntimeError(format!("{message}\n{}", detail.join("\n"))))
            }
        }
    }
}

async fn reserve_port() -> Result<u16, RuntimeError> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| RuntimeError(format!("failed to reserve a discovery port: {error}")))?;
    let port = listener
        .local_addr()
        .map_err(|error| RuntimeError(format!("failed to read the discovery port: {error}")))?
        .port();
    drop(listener);
    Ok(port)
}
