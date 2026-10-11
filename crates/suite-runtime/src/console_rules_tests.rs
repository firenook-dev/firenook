//! The console's rules surface as the suite assembles it: the same rules
//! runtime, schema index and REST front the suite builds, not a hand-wired
//! router.
use super::*;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use serde_json::Value;
use tower::ServiceExt as _;

const RULES: &str = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /items/{id} {\n      allow read: if request.auth != null;\n    }\n  }\n}\n";

struct Prepared {
    console: Router,
    _directory: TempDirectory,
}

struct TempDirectory(PathBuf);

impl Drop for TempDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The console router over `prepare_firestore`'s parts, with diagnostics on
/// (coverage needs them) and a rules file configured for `(default)`.
fn prepared(name: &str) -> Prepared {
    let directory = std::env::temp_dir().join(format!(
        "firenook-console-rules-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).expect("directory");
    let rules = directory.join("firestore.rules");
    std::fs::write(&rules, RULES).expect("rules");
    let mut config = diagnostics_tests::test_config();
    config.firestore_databases = vec![FirestoreDatabaseConfig::default_database(Some(rules), None)];
    let store = Store::default();
    let parts = prepare_firestore(
        &config,
        &store,
        &TriggerRegistry::default(),
        &LoggingRuntime::new(),
    )
    .expect("firestore prepares")
    .expect("firestore is selected");
    let (_stop, shutdown) = watch::channel(false);
    let console = parts.console;
    let router = console_router(ConsoleServices {
        firestore: Some(FirestoreConsole {
            rest: console.rest,
            changes: console.changes,
            schema: console.schema,
            databases: console.databases,
            explain: console.explain,
            rules: console.rules,
            requests: None,
            shutdown,
        }),
        ..ConsoleServices::new(
            SuiteDirectory::new(
                &config.project_id,
                [
                    ServiceInfo::listening("hub", "127.0.0.1", 2),
                    ServiceInfo::listening("firestore", "127.0.0.1", 1),
                ],
            )
            .expect("directory"),
        )
    });
    Prepared {
        console: router,
        _directory: TempDirectory(directory),
    }
}

async fn send(router: &Router, request: Request<Body>) -> (StatusCode, Vec<u8>) {
    let response = router.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body")
        .to_vec();
    (status, body)
}

#[tokio::test]
async fn the_official_coverage_report_is_reachable_from_the_console_origin() {
    let prepared = prepared("coverage");
    let (status, body) = send(
        &prepared.console,
        Request::get(
            "/api/v1/firestore/emulator/v1/projects/demo-diagnostics:ruleCoverage?database=(default)",
        )
        .body(Body::empty())
        .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let report: Value = serde_json::from_slice(&body).expect("json");
    // The same document the official route serves: the rules it covers,
    // and the (here still empty) per-expression report.
    assert_eq!(report["rules"]["files"][0]["name"], "firestore.rules");
    assert!(
        report["rules"]["files"][0]["content"]
            .as_str()
            .is_some_and(|rules| rules.contains("request.auth != null")),
        "the report covers the database's configured rules: {report}"
    );
}

#[tokio::test]
async fn a_checked_draft_is_mapped_against_the_suites_schema_index() {
    let prepared = prepared("check");
    let (status, body) = send(
        &prepared.console,
        Request::post("/api/v1/firestore/rules/check")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({ "source": RULES }).to_string(),
            ))
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let check: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(
        check["map"]["collections"],
        serde_json::json!([]),
        "{check}"
    );
    assert_eq!(check["diagnostics"][0]["code"], "auth-only");

    let (status, body) = send(
        &prepared.console,
        Request::get("/api/v1/firestore/rules/history")
            .body(Body::empty())
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let history: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(history[0]["origin"], "startup", "{history}");
}
