//! The Firenook console: the emulator's own UI, embedded in the engine
//! binary, and the Console API it talks to.
//!
//! The console is a client-only application built from `console/` at the
//! repository root. Its build output (`console/dist`) is embedded at compile
//! time in release builds and read from disk in debug builds, so UI work
//! needs no engine rebuild. The suite mounts [`console_router`] under
//! `/console` on the Emulator UI port; every asset and API call is
//! same-origin, so the console works whatever scheme the UI was opened with.

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::{StatusCode, Uri, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{any, get};
use firenook_suite_front::SuiteDirectory;
use rust_embed::{Embed, EmbeddedFile};
use serde::Serialize;
use serde_json::json;
use ts_rs::TS;

/// Built console assets. `console/dist/.gitkeep` keeps the folder present in
/// a checkout without a build; the router then answers with a build-needed
/// page instead of a broken shell.
#[derive(Embed)]
#[folder = "$CARGO_MANIFEST_DIR/../../console/dist"]
#[exclude = ".gitkeep"]
#[exclude = ".vite/*"]
struct Assets;

/// Where the engine serves the console on the Emulator UI port.
pub const CONSOLE_PATH: &str = "/console";

/// The console's view of the running suite.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleStatus {
    /// Configured Firebase project id.
    pub project_id: String,
    /// The engine serving this console.
    pub engine: EngineInfo,
    /// Every service the suite runs, in name order.
    pub services: Vec<ServiceStatus>,
}

/// The engine serving the console.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    /// Product name.
    pub name: String,
    /// Version of the engine crate that built this binary.
    pub crate_version: String,
}

/// One running service as the console shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    /// Emulator service name, as the hub advertises it.
    pub name: String,
    /// Connect host.
    pub host: String,
    /// Bound port.
    pub port: u16,
    /// Whether the service listens on its own port (as opposed to a
    /// dependency advertised with a port but served by another listener).
    pub listening: bool,
    /// Process id for services that expose it.
    pub pid: Option<u32>,
}

impl ConsoleStatus {
    /// The status the console shows for `directory`.
    #[must_use]
    pub fn from_directory(directory: &SuiteDirectory) -> Self {
        Self {
            project_id: directory.project().to_owned(),
            engine: EngineInfo {
                name: "Firenook".to_owned(),
                crate_version: env!("CARGO_PKG_VERSION").to_owned(),
            },
            services: directory
                .services()
                .map(|service| ServiceStatus {
                    name: service.name.clone(),
                    host: service.host.clone(),
                    port: service.port,
                    listening: service.include_listen,
                    pid: service.pid,
                })
                .collect(),
        }
    }
}

#[derive(Clone)]
struct ConsoleState {
    directory: SuiteDirectory,
}

/// The console router: the Console API under `/api/v1` and the embedded
/// application for every other path. Mount it under [`CONSOLE_PATH`].
pub fn console_router(directory: SuiteDirectory) -> Router {
    Router::new()
        .route("/api/v1/status", get(status))
        .route("/api/{*rest}", any(unknown_api))
        .fallback(asset)
        .with_state(ConsoleState { directory })
}

async fn status(State(state): State<ConsoleState>) -> Json<ConsoleStatus> {
    Json(ConsoleStatus::from_directory(&state.directory))
}

async fn unknown_api(uri: Uri) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "error": {
                "message": format!("unknown console API route: {}", uri.path()),
            }
        })),
    )
        .into_response()
}

/// Serves a built file, or the application shell for any path the client
/// router owns. Hashed build assets are immutable; the shell never caches.
async fn asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if !path.is_empty()
        && !path.split('/').any(|segment| segment == "..")
        && let Some(file) = Assets::get(path)
    {
        return serve(path, file);
    }
    match Assets::get("index.html") {
        Some(index) => serve("index.html", index),
        None => not_built(),
    }
}

fn serve(path: &str, file: EmbeddedFile) -> Response {
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    (
        [
            (header::CONTENT_TYPE, file.metadata.mimetype().to_owned()),
            (header::CACHE_CONTROL, cache.to_owned()),
        ],
        file.data,
    )
        .into_response()
}

fn not_built() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::CACHE_CONTROL, "no-store")],
        Html(NOT_BUILT_PAGE),
    )
        .into_response()
}

const NOT_BUILT_PAGE: &str = "<!doctype html><meta charset=\"utf-8\"><title>Firenook console</title>\
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#1f2328}code{font-size:.9em}</style>\
<h1>The console is not built into this engine</h1>\
<p>This binary was compiled without the console's build output. From the repository root run \
<code>npm ci --prefix console &amp;&amp; npm run build --prefix console</code> and rebuild the engine, \
or work on the console with <code>npm run dev --prefix console</code>, which proxies this engine's console API.</p>";

#[cfg(test)]
mod tests {
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use firenook_suite_front::ServiceInfo;
    use tower::ServiceExt as _;

    use super::*;

    fn directory() -> SuiteDirectory {
        SuiteDirectory::new(
            "demo-console",
            [
                ServiceInfo::listening("hub", "127.0.0.1", 34_400),
                ServiceInfo::listening("firestore", "127.0.0.1", 38_080),
                ServiceInfo::dependency("tasks", "127.0.0.1", 39_499),
            ],
        )
        .expect("valid directory")
    }

    async fn call(uri: &str) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let response = console_router(directory())
            .oneshot(Request::get(uri).body(Body::empty()).expect("request"))
            .await
            .expect("response");
        let status = response.status();
        let headers = response.headers().clone();
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body")
            .to_vec();
        (status, headers, body)
    }

    #[test]
    fn export_bindings() {
        let out = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../console/src/api/generated"
        );
        let config = ts_rs::Config::new().with_out_dir(out);
        ConsoleStatus::export_all(&config).expect("TypeScript bindings written");
        let written = std::fs::read_to_string(format!("{out}/ConsoleStatus.ts")).expect("read");
        assert!(written.contains("projectId: string"), "{written}");
        assert!(
            written.contains("services: Array<ServiceStatus>"),
            "{written}"
        );
    }

    #[tokio::test]
    async fn status_reports_the_project_and_every_service_in_name_order() {
        let (status, headers, body) = call("/api/v1/status").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CONTENT_TYPE], "application/json");
        let value: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(value["projectId"], "demo-console");
        assert_eq!(value["engine"]["name"], "Firenook");
        assert_eq!(value["engine"]["crateVersion"], env!("CARGO_PKG_VERSION"));
        let names: Vec<&str> = value["services"]
            .as_array()
            .expect("services")
            .iter()
            .map(|service| service["name"].as_str().expect("name"))
            .collect();
        assert_eq!(names, ["firestore", "hub", "tasks"]);
        assert_eq!(value["services"][0]["port"], 38_080);
        assert_eq!(value["services"][0]["listening"], true);
        assert_eq!(value["services"][2]["listening"], false);
        assert_eq!(value["services"][2]["pid"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn unknown_api_routes_answer_json_not_the_shell() {
        let (status, headers, body) = call("/api/v1/nothing").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(headers[header::CONTENT_TYPE], "application/json");
        let value: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(
            value["error"]["message"],
            "unknown console API route: /api/v1/nothing"
        );
    }

    #[tokio::test]
    async fn every_client_route_serves_the_shell_and_hashed_assets_are_immutable() {
        let Some(index) = Assets::get("index.html") else {
            assert!(
                std::env::var_os("CI").is_none(),
                "CI must build the console before the Rust checks"
            );
            let (status, _, body) = call("/firestore").await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
            assert!(String::from_utf8_lossy(&body).contains("not built"));
            return;
        };
        for uri in ["/", "/firestore", "/auth/users/abc", "/not/a/file.html"] {
            let (status, headers, body) = call(uri).await;
            assert_eq!(status, StatusCode::OK, "{uri}");
            assert_eq!(headers[header::CACHE_CONTROL], "no-cache", "{uri}");
            assert!(
                headers[header::CONTENT_TYPE]
                    .to_str()
                    .expect("utf8")
                    .starts_with("text/html")
            );
            assert_eq!(body, index.data.as_ref(), "{uri}");
        }
        let hashed = Assets::iter()
            .find(|name| name.starts_with("assets/") && name.ends_with(".js"))
            .expect("a built script");
        let (status, headers, _) = call(&format!("/{hashed}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        assert!(
            headers[header::CONTENT_TYPE]
                .to_str()
                .expect("utf8")
                .contains("javascript")
        );
        let (status, _, _) = call("/assets/../index.html").await;
        assert_eq!(status, StatusCode::OK, "traversal falls back to the shell");
    }
}
