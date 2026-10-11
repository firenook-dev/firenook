//! Suite-wide state no section owns: whether background triggers are
//! delivered, where the data lives, saving an export on the engine's
//! machine, and the console's buffer memory.
//!
//! Each is drawn once, by the shell (its banners and engine popover) and the
//! Overview; no section keeps a copy. `POST /suite/background` is the only
//! console route that pauses or resumes background triggers, and it does
//! exactly what the hub's own switches do. `POST /suite/export` sends the
//! hub's export command to a destination the engine lists: the browser
//! names a destination, never a path.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use firenook_functions_bridge::TriggerRegistry;
use firenook_suite_front::{BackgroundRequest, ExportCommand, RingBudget};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, watch};
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::blocking::blocking;

/// How long a switch waits for the Functions runtime to acknowledge it, as
/// the hub's own switches do.
const BACKGROUND_ACK: Duration = Duration::from_secs(30);
/// The largest request body these routes accept.
const BODY_LIMIT: usize = 64 * 1024;
/// What an export may name in `targets`.
const EXPORT_TARGETS: [&str; 3] = ["firestore", "auth", "storage"];

/// Background trigger delivery, as the hub or the console last set it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTriggers {
    /// Whether events reach the functions that listen for them. A test
    /// harness can pause them through the hub, which changes what every
    /// section does: while paused, events are dropped, not queued.
    pub enabled: bool,
}

/// Where this engine keeps its data, fixed for the engine's life.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DataFacts {
    /// `memory`: Firestore runs in memory and nothing survives a restart;
    /// `disk`: the state directory holds it.
    pub mode: DataMode,
    /// The native state directory, shown and copyable, when `disk`.
    pub state_dir: Option<String>,
    /// This start resumed the previous state (`--resume-state`).
    pub resumed: bool,
    /// The export this start imported (`--import`), when any.
    pub imported_from: Option<String>,
    /// Where the suite exports on exit (`--export-on-exit`), when set.
    pub export_on_exit: Option<String>,
    /// `write-behind` or `per-commit` (`--durability`).
    pub durability: String,
}

/// Whether the data survives a restart.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum DataMode {
    Memory,
    Disk,
}

/// A folder an export may be saved to, by id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExportDestination {
    /// `export-on-exit`, `seed` or `project`: what `POST /suite/export`
    /// names.
    pub id: String,
    /// "The export-on-exit folder".
    pub label: String,
    /// The folder, on the engine's machine.
    pub path: String,
    /// Why the engine will not export there now, when it will not.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub refused: Option<String>,
}

/// A finished export.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    /// The destination's id.
    pub destination: String,
    /// The folder written.
    pub path: String,
    /// The services exported; empty means every stateful service.
    pub targets: Vec<String>,
    /// How long the export took.
    #[ts(type = "number")]
    pub took_ms: u64,
}

/// `GET /status/memory`: the console's buffers against their shared budget.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReport {
    #[ts(type = "number")]
    pub budget_bytes: u64,
    #[ts(type = "number")]
    pub used_bytes: u64,
    /// Each buffer, in the order it was created.
    pub rings: Vec<RingSize>,
}

/// One buffer's size.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
pub struct RingSize {
    /// `logs`, `firestore.changes`, …
    pub name: String,
    #[ts(type = "number")]
    pub entries: u64,
    #[ts(type = "number")]
    pub bytes: u64,
}

/// What the suite hands the console's suite controls.
pub struct SuiteSettings {
    /// The trigger registry whose background flag the hub also flips.
    pub triggers: TriggerRegistry,
    /// Where a switch is forwarded so the Functions runtime can follow it
    /// (the hub's own channel); `None` when nothing listens.
    pub background: Option<mpsc::UnboundedSender<BackgroundRequest>>,
    /// The suite's exporter, the channel the hub's export uses.
    pub exporter: mpsc::Sender<ExportCommand>,
    /// Where the data lives.
    pub data: DataFacts,
    /// Where an export may be saved.
    pub destinations: Vec<ExportDestination>,
}

struct SuiteInner {
    triggers: Option<TriggerRegistry>,
    background: Option<mpsc::UnboundedSender<BackgroundRequest>>,
    exporter: Option<mpsc::Sender<ExportCommand>>,
    data: DataFacts,
    destinations: Vec<ExportDestination>,
    /// Bumped when the console flips background triggers.
    flips: watch::Sender<u64>,
}

/// Background triggers, persistence facts and export. Cheap to clone.
#[derive(Clone)]
pub struct SuiteControls {
    inner: Arc<SuiteInner>,
}

impl SuiteControls {
    /// The controls of `settings`'s suite.
    #[must_use]
    pub fn new(settings: SuiteSettings) -> Self {
        Self::build(
            Some(settings.triggers),
            settings.background,
            Some(settings.exporter),
            settings.data,
            settings.destinations,
        )
    }

    /// Controls for a console built without a suite (tests, tools): data in
    /// memory, nowhere to export, background triggers always on.
    #[must_use]
    pub fn detached() -> Self {
        Self::build(
            None,
            None,
            None,
            DataFacts {
                mode: DataMode::Memory,
                state_dir: None,
                resumed: false,
                imported_from: None,
                export_on_exit: None,
                durability: "write-behind".to_owned(),
            },
            Vec::new(),
        )
    }

    fn build(
        triggers: Option<TriggerRegistry>,
        background: Option<mpsc::UnboundedSender<BackgroundRequest>>,
        exporter: Option<mpsc::Sender<ExportCommand>>,
        data: DataFacts,
        destinations: Vec<ExportDestination>,
    ) -> Self {
        Self {
            inner: Arc::new(SuiteInner {
                triggers,
                background,
                exporter,
                data,
                destinations,
                flips: watch::Sender::new(0),
            }),
        }
    }

    /// Whether background triggers are delivered now.
    pub(crate) fn background_triggers(&self) -> BackgroundTriggers {
        BackgroundTriggers {
            enabled: self
                .inner
                .triggers
                .as_ref()
                .is_none_or(TriggerRegistry::background_enabled),
        }
    }

    /// Where the data lives.
    pub(crate) fn data(&self) -> DataFacts {
        self.inner.data.clone()
    }

    /// Ticks when the console flips background triggers.
    pub(crate) fn changes(&self) -> watch::Receiver<u64> {
        self.inner.flips.subscribe()
    }

    /// `POST /suite/background`, `GET /suite/destinations`,
    /// `POST /suite/export`.
    pub(crate) fn router(&self) -> Router {
        Router::new()
            .route("/suite/background", post(set_background))
            .route("/suite/destinations", get(destinations))
            .route("/suite/export", post(export))
            .with_state(self.clone())
    }
}

/// `GET /status/memory`.
pub(crate) fn memory_router(rings: RingBudget) -> Router {
    Router::new()
        .route("/status/memory", get(memory))
        .with_state(rings)
}

async fn memory(State(rings): State<RingBudget>) -> Json<MemoryReport> {
    let wide = |value: usize| u64::try_from(value).unwrap_or(u64::MAX);
    Json(MemoryReport {
        budget_bytes: wide(rings.limit()),
        used_bytes: wide(rings.used()),
        rings: rings
            .report()
            .into_iter()
            .map(|ring| RingSize {
                name: ring.name,
                entries: wide(ring.entries),
                bytes: wide(ring.bytes),
            })
            .collect(),
    })
}

/// Reads a JSON body of at most 64 KiB; the guard has already required
/// the JSON content type.
async fn json_body<T: DeserializeOwned>(body: Body, what: &str) -> Result<T, ApiError> {
    let bytes = axum::body::to_bytes(body, BODY_LIMIT).await.map_err(|_| {
        ApiError::too_large(format!(
            "This request is larger than {} KiB, the most this route accepts.",
            BODY_LIMIT / 1024
        ))
    })?;
    serde_json::from_slice(&bytes)
        .map_err(|error| ApiError::invalid(format!("This {what} is not valid: {error}.")))
}

/// `{ enabled }`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct BackgroundRequestBody {
    enabled: bool,
}

/// `POST /suite/background {enabled}`: what the hub's
/// `disableBackgroundTriggers` and `enableBackgroundTriggers` do — set the
/// flag, forward it to the Functions runtime and wait for its
/// acknowledgement (up to 30 s) — then the shell's status says so.
async fn set_background(
    State(suite): State<SuiteControls>,
    body: Body,
) -> Result<Json<BackgroundTriggers>, ApiError> {
    let request: BackgroundRequestBody = json_body(body, "background trigger switch").await?;
    let Some(triggers) = &suite.inner.triggers else {
        return Err(ApiError::precondition(
            "This console is not attached to a running suite, so there are no background triggers to switch.",
        ));
    };
    triggers.set_background_enabled(request.enabled);
    if let Some(sender) = &suite.inner.background {
        let (done, acknowledged) = oneshot::channel();
        if sender
            .send(BackgroundRequest {
                enabled: request.enabled,
                done,
            })
            .is_ok()
        {
            let _ = tokio::time::timeout(BACKGROUND_ACK, acknowledged).await;
        }
    }
    suite.inner.flips.send_modify(|flips| *flips += 1);
    Ok(Json(suite.background_triggers()))
}

async fn destinations(State(suite): State<SuiteControls>) -> Json<Vec<ExportDestination>> {
    Json(suite.inner.destinations.clone())
}

/// `{ destination, targets?, overwrite? }`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ExportRequest {
    /// An id from `GET /suite/destinations`; never a path.
    destination: String,
    #[serde(default)]
    targets: Vec<String>,
    /// Replace a folder that already holds files (after the console asked).
    #[serde(default)]
    overwrite: bool,
}

/// `POST /suite/export`: the hub's export, to a listed destination.
async fn export(
    State(suite): State<SuiteControls>,
    body: Body,
) -> Result<Json<ExportResult>, ApiError> {
    let request: ExportRequest = json_body(body, "export request").await?;
    let Some(exporter) = suite.inner.exporter.clone() else {
        return Err(ApiError::precondition(
            "This console is not attached to a running suite, so there is nothing to export.",
        ));
    };
    let known = || {
        suite
            .inner
            .destinations
            .iter()
            .map(|destination| destination.id.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let Some(destination) = suite
        .inner
        .destinations
        .iter()
        .find(|destination| destination.id == request.destination)
        .cloned()
    else {
        return Err(ApiError::invalid(format!(
            "No export destination is named `{}`; this engine lists {}.",
            request.destination,
            known()
        ))
        .with_fix(
            "Choose a destination from the list, or export anywhere else with firenook emulators:export <dir>.",
        ));
    };
    if let Some(refused) = &destination.refused {
        return Err(ApiError::precondition(refused.clone()));
    }
    let targets: BTreeSet<String> = request.targets.iter().cloned().collect();
    if let Some(unknown) = targets
        .iter()
        .find(|target| !EXPORT_TARGETS.contains(&target.as_str()))
    {
        return Err(ApiError::invalid(format!(
            "An export covers firestore, auth or storage, not `{unknown}`."
        )));
    }
    let path = PathBuf::from(&destination.path);
    if !request.overwrite {
        let probe = path.clone();
        let holds_files = blocking("the destination check", move || {
            Ok(std::fs::read_dir(&probe).is_ok_and(|mut entries| entries.next().is_some()))
        })
        .await?;
        if holds_files {
            return Err(ApiError::already_exists(format!(
                "{} already holds files; the export would replace them.",
                destination.path
            ))
            .with_fix("Confirm, and send the export again with overwrite: true."));
        }
    }
    let started = Instant::now();
    let (completion, finished) = oneshot::channel();
    exporter
        .send(ExportCommand {
            destination: path,
            targets: targets.clone(),
            completion,
        })
        .await
        .map_err(|_| ApiError::unavailable("The engine's exporter has stopped."))?;
    match finished.await {
        Ok(Ok(())) => Ok(Json(ExportResult {
            destination: destination.id,
            path: destination.path,
            targets: targets.into_iter().collect(),
            took_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })),
        Ok(Err(message)) => Err(ApiError::precondition(format!(
            "The export failed: {message}"
        ))),
        Err(_) => Err(ApiError::unavailable(
            "The export stopped because the engine is stopping.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use axum::http::{Request, StatusCode};
    use serde_json::{Value, json};
    use tower::ServiceExt as _;

    use super::*;

    fn facts() -> DataFacts {
        DataFacts {
            mode: DataMode::Disk,
            state_dir: Some("/state".to_owned()),
            resumed: true,
            imported_from: None,
            export_on_exit: None,
            durability: "per-commit".to_owned(),
        }
    }

    struct Suite {
        controls: SuiteControls,
        triggers: TriggerRegistry,
        folder: PathBuf,
    }

    type Receivers = (
        mpsc::UnboundedReceiver<BackgroundRequest>,
        mpsc::Receiver<ExportCommand>,
    );

    impl Drop for Suite {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.folder);
        }
    }

    fn suite(name: &str) -> (Suite, Receivers) {
        let folder = std::env::temp_dir().join(format!(
            "firenook-suite-controls-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&folder);
        let triggers = TriggerRegistry::default();
        let (background_sender, background) = mpsc::unbounded_channel();
        let (exporter, exports) = mpsc::channel(4);
        let controls = SuiteControls::new(SuiteSettings {
            triggers: triggers.clone(),
            background: Some(background_sender),
            exporter,
            data: facts(),
            destinations: vec![
                ExportDestination {
                    id: "project".to_owned(),
                    label: "The project's export folder".to_owned(),
                    path: folder.display().to_string(),
                    refused: None,
                },
                ExportDestination {
                    id: "seed".to_owned(),
                    label: "The import seed".to_owned(),
                    path: "/seed".to_owned(),
                    refused: Some(
                        "The engine resumed its state, so the seed must not change.".to_owned(),
                    ),
                },
            ],
        });
        (
            Suite {
                controls,
                triggers,
                folder,
            },
            (background, exports),
        )
    }

    async fn post(router: &Router, uri: &str, body: Value) -> (StatusCode, Value) {
        let response = router
            .clone()
            .oneshot(
                Request::post(uri)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .expect("request"),
            )
            .await
            .expect("response");
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn the_background_switch_flips_the_registry_forwards_it_and_says_so() {
        let (suite, (mut background, _exports)) = suite("background");
        let router = suite.controls.router();
        let mut flips = suite.controls.changes();
        let acknowledge = tokio::spawn(async move {
            let request = background.recv().await.expect("forwarded");
            assert!(!request.enabled);
            let _ = request.done.send(());
            background
        });
        let (status, body) = post(&router, "/suite/background", json!({ "enabled": false })).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, json!({ "enabled": false }));
        assert!(!suite.triggers.background_enabled());
        assert!(flips.has_changed().expect("open"));
        flips.mark_unchanged();
        assert!(!suite.controls.background_triggers().enabled);
        let _background = acknowledge.await.expect("acknowledged");
        // A flip made through the hub is read whenever the status is built.
        suite.triggers.set_background_enabled(true);
        assert!(suite.controls.background_triggers().enabled);
        let (status, body) = post(&router, "/suite/background", json!({ "on": true })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["error"]["code"], "invalid-argument");
    }

    #[tokio::test]
    async fn an_export_names_a_listed_destination_and_never_a_path() {
        let (suite, (_background, mut exports)) = suite("export");
        let router = suite.controls.router();
        let response = router
            .clone()
            .oneshot(
                Request::get("/suite/destinations")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let listed: Value = serde_json::from_slice(&bytes).expect("json");
        assert_eq!(listed[0]["id"], "project");
        assert!(listed[0].get("refused").is_none(), "{listed}");
        assert_eq!(
            listed[1]["refused"],
            "The engine resumed its state, so the seed must not change."
        );
        for (body, code) in [
            (
                json!({ "destination": "/tmp/anywhere" }),
                "invalid-argument",
            ),
            (json!({ "destination": "seed" }), "failed-precondition"),
            (
                json!({ "destination": "project", "targets": ["database"] }),
                "invalid-argument",
            ),
            (
                json!({ "destination": "project", "path": "/x" }),
                "invalid-argument",
            ),
        ] {
            let (_, answer) = post(&router, "/suite/export", body.clone()).await;
            assert_eq!(answer["error"]["code"], code, "{body} → {answer}");
        }
        let folder = suite.folder.clone();
        let exporter = tokio::spawn(async move {
            let command = exports.recv().await.expect("an export");
            assert_eq!(command.destination, folder);
            assert_eq!(command.targets, BTreeSet::from(["firestore".to_owned()]));
            std::fs::create_dir_all(&command.destination).expect("written");
            std::fs::write(
                command.destination.join("firebase-export-metadata.json"),
                "{}",
            )
            .expect("written");
            let _ = command.completion.send(Ok(()));
            exports
        });
        let (status, body) = post(
            &router,
            "/suite/export",
            json!({ "destination": "project", "targets": ["firestore"] }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["destination"], "project");
        assert_eq!(body["path"], suite.folder.display().to_string());
        assert_eq!(body["targets"], json!(["firestore"]));
        assert!(body["tookMs"].is_u64());
        let mut exports = exporter.await.expect("exported");
        // The folder now holds an export: replacing it needs a yes.
        let (status, body) = post(
            &router,
            "/suite/export",
            json!({ "destination": "project" }),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"]["code"], "already-exists");
        let exporter = tokio::spawn(async move {
            let command = exports.recv().await.expect("an export");
            let _ = command.completion.send(Err("the disk is full".to_owned()));
            exports
        });
        let (status, body) = post(
            &router,
            "/suite/export",
            json!({ "destination": "project", "overwrite": true }),
        )
        .await;
        assert_eq!(status, StatusCode::PRECONDITION_FAILED, "{body}");
        assert_eq!(
            body["error"]["message"],
            "The export failed: the disk is full"
        );
        let _exports = exporter.await.expect("answered");
    }

    #[tokio::test]
    async fn a_detached_console_has_nothing_to_switch_or_export() {
        let controls = SuiteControls::detached();
        assert!(controls.background_triggers().enabled);
        assert_eq!(controls.data().mode, DataMode::Memory);
        let router = controls.router();
        let (status, _) = post(&router, "/suite/background", json!({ "enabled": false })).await;
        assert_eq!(status, StatusCode::PRECONDITION_FAILED);
        let (status, _) = post(
            &router,
            "/suite/export",
            json!({ "destination": "project" }),
        )
        .await;
        assert_eq!(status, StatusCode::PRECONDITION_FAILED);
    }

    #[tokio::test]
    async fn the_memory_report_lists_each_ring_against_the_budget() {
        let budget = RingBudget::new(1024 * 1024);
        let ring: firenook_suite_front::ReplayRing<()> = firenook_suite_front::ReplayRing::new(
            "logs",
            firenook_suite_front::RingLimits::DEFAULT,
            7,
            &budget,
        );
        ring.push((), Arc::from("{\"line\":1}"));
        let response = memory_router(budget)
            .oneshot(
                Request::get("/status/memory")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let report: Value = serde_json::from_slice(&bytes).expect("json");
        assert_eq!(report["budgetBytes"], 1024 * 1024);
        assert_eq!(report["rings"][0]["name"], "logs");
        assert_eq!(report["rings"][0]["entries"], 1);
        assert!(report["usedBytes"].as_u64().expect("used") > 0, "{report}");
    }
}
