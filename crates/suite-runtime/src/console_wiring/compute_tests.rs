//! Compute's wiring through the hooks `run()` calls: the console answers
//! from the Monitor before Functions start, the start helper records into
//! that Monitor and hands its Extensions over, `ready` serves them, the
//! parameter-file watcher reloads an instance (also when `extensions/`
//! appears after the start), and `before_finish` stops the watcher. The
//! worker never starts: a static `functions.yaml` loads without Node.
#![allow(clippy::too_many_lines)] // Scenarios read best whole.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use firenook_console_front::{ConsoleServices, ForeignProjects, Shutdown, console_router};
use firenook_functions_bridge::TriggerRegistry;
use firenook_suite_front::{LoggingRuntime, ServiceInfo, SuiteDirectory};
use serde_json::Value;
use tower::ServiceExt as _;

use super::*;
use crate::diagnostics_tests::test_config;
use crate::{ServiceSelection, SuiteConfig};

/// A fresh project directory, removed when dropped.
struct Project(PathBuf);

impl Project {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "firenook-compute-wiring-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("project directory");
        Self(path.canonicalize().expect("canonical"))
    }

    fn write(&self, relative: &str, text: &str) {
        let path = self.0.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("directory");
        }
        std::fs::write(path, text).expect("written");
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// One codebase (static manifest) and one local extension instance.
fn project(name: &str, with_extension_files: bool) -> Project {
    let project = Project::new(name);
    project.write(
        "firebase.json",
        r#"{"functions": [{"source": "functions"}], "extensions": {"greeter": "./extensions-local/greeter"}}"#,
    );
    project.write(
        "functions/functions.yaml",
        "specVersion: v1alpha1\nendpoints:\n  api:\n    entryPoint: api\n    platform: gcfv2\n    httpsTrigger: {}\n",
    );
    project.write(
        "functions/package.json",
        "{\"name\":\"wiring\",\"main\":\"index.js\"}",
    );
    project.write("functions/index.js", "");
    project.write(
        "extensions-local/greeter/extension.yaml",
        "name: greeter\nversion: 0.1.0\nspecVersion: v1beta\nresources:\n  - name: greet\n    type: firebaseextensions.v1beta.function\n    properties:\n      location: us-central1\n      runtime: nodejs22\n      httpsTrigger: {}\nparams:\n  - param: GREETING\n    type: string\n    default: Hello\n",
    );
    project.write("extensions-local/greeter/POSTINSTALL.md", "# Greeter\n");
    project.write(
        "extensions-local/greeter/functions/package.json",
        "{\"name\":\"greeter\"}",
    );
    if with_extension_files {
        project.write("extensions/greeter.env", "GREETING=Hi\n");
    }
    project
}

fn config(project: &Project) -> SuiteConfig {
    SuiteConfig {
        project_id: "demo-compute".to_owned(),
        project_dir: project.path().to_path_buf(),
        firebase_json: project.path().join("firebase.json"),
        node: PathBuf::from("/nonexistent/firenook-test-node"),
        state_dir: project.path().join("state"),
        services: ServiceSelection::parse("functions,firestore").expect("selection"),
        ..test_config()
    }
}

fn running() -> Shutdown {
    let (stop, receiver) = tokio::sync::watch::channel(false);
    std::mem::forget(stop);
    Shutdown::new(receiver)
}

fn console(parts: &ComputeParts) -> Router {
    console_router(ConsoleServices {
        compute: Some(parts.clone()),
        ..ConsoleServices::new(
            SuiteDirectory::new(
                "demo-compute",
                [ServiceInfo::listening("hub", "127.0.0.1", 34_400)],
            )
            .expect("directory"),
            running(),
        )
    })
}

async fn get(router: &Router, uri: &str) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(Request::get(uri).body(Body::empty()).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

/// The value the console shows for the greeter's GREETING.
async fn greeting(router: &Router) -> Option<String> {
    let (_, detail) = get(router, "/api/v1/extensions/instances/greeter").await;
    detail["params"]
        .as_array()?
        .iter()
        .find(|param| param["param"] == "GREETING")?["value"]
        .as_str()
        .map(str::to_owned)
}

/// Waits (up to 15 s, the watcher debounces one second) until the console
/// shows `expected`.
async fn shows_greeting(router: &Router, expected: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if greeting(router).await.as_deref() == Some(expected) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the console never showed GREETING={expected} (it shows {:?})",
            greeting(router).await
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
async fn the_console_answers_from_the_monitor_then_serves_the_runtime_and_watches_parameter_files()
{
    let project = project("ready", true);
    let config = config(&project);
    let logging = LoggingRuntime::new();
    let triggers = TriggerRegistry::default();
    let foreign = ForeignProjects::default();
    let parts = parts(&config);
    let router = console(&parts);
    // Before Functions start: the snapshot answers from the Monitor, the
    // control routes say starting.
    let (status, snapshot) = get(&router, "/api/v1/functions").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["phase"], "starting");
    assert_eq!(
        snapshot["address"],
        format!("http://127.0.0.1:{}", config.ports.functions)
    );
    let (status, _) = get(&router, "/api/v1/functions/us-central1-api").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

    let hooks = HookContext {
        compute: Some(&parts),
        ..HookContext::new(&config, &logging, &foreign, &triggers)
    };
    let mut options = FunctionsConsoleOptions::default();
    functions_options(&hooks, &mut options);
    assert!(options.compute.is_some());
    let runtime = crate::start_functions_runtime(&config, triggers.clone(), &logging, options)
        .await
        .expect("Functions start");
    // The runtime records into the console's Monitor.
    assert!(parts.monitor().codebase("default-0").is_some());
    assert!(parts.monitor().codebase("greeter").is_some());
    assert!(!parts.handed_over());
    ready(&HookContext {
        functions: Some(&runtime),
        ..hooks
    });
    assert!(parts.handed_over());
    assert_eq!(parts.watcher_count(), 1);
    let (status, snapshot) = get(&router, "/api/v1/functions").await;
    assert_eq!(status, StatusCode::OK);
    let ids: Vec<&str> = snapshot["functions"]
        .as_array()
        .expect("functions")
        .iter()
        .filter_map(|function| function["id"].as_str())
        .collect();
    assert!(ids.contains(&"us-central1-api"), "{ids:?}");
    assert!(ids.contains(&"us-central1-ext-greeter-greet"), "{ids:?}");
    // Storage is not part of this suite.
    let (_, status_json) = get(&router, "/api/v1/status").await;
    let functions = status_json["sections"]
        .as_array()
        .and_then(|sections| sections.iter().find(|section| section["id"] == "functions"))
        .expect("functions section");
    assert_eq!(functions["state"], "ready");
    let (status, instances) = get(&router, "/api/v1/extensions/instances").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(instances["instances"][0]["instanceId"], "greeter");
    assert_eq!(greeting(&router).await.as_deref(), Some("Hi"));

    // An edit in an editor reloads the instance.
    project.write("extensions/greeter.env", "GREETING=Howdy\n");
    shows_greeting(&router, "Howdy").await;

    before_finish(&HookContext {
        functions: Some(&runtime),
        ..hooks
    })
    .await;
    assert_eq!(parts.watcher_count(), 0);
    runtime.shutdown().await;
}

#[tokio::test]
async fn the_parameter_watcher_follows_an_extensions_directory_that_is_replaced() {
    let project = project("replaced", true);
    let config = config(&project);
    let logging = LoggingRuntime::new();
    let triggers = TriggerRegistry::default();
    let foreign = ForeignProjects::default();
    let parts = parts(&config);
    let router = console(&parts);
    let hooks = HookContext {
        compute: Some(&parts),
        ..HookContext::new(&config, &logging, &foreign, &triggers)
    };
    let mut options = FunctionsConsoleOptions::default();
    functions_options(&hooks, &mut options);
    let runtime = crate::start_functions_runtime(&config, triggers.clone(), &logging, options)
        .await
        .expect("Functions start");
    ready(&HookContext {
        functions: Some(&runtime),
        ..hooks
    });
    assert_eq!(greeting(&router).await.as_deref(), Some("Hi"));
    // A branch switch removes `extensions/` and writes it back: the watcher
    // on the old directory is gone, the project's watcher sees the new one
    // appear and reads the files written with it.
    std::fs::remove_dir_all(project.path().join("extensions")).expect("removed");
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    project.write(
        "extensions/greeter.env",
        "GREETING=From the new directory\n",
    );
    shows_greeting(&router, "From the new directory").await;
    // The new directory's own watcher took over: a later edit reloads too.
    project.write("extensions/greeter.env", "GREETING=Edited again\n");
    shows_greeting(&router, "Edited again").await;
    before_finish(&hooks).await;
    assert_eq!(parts.watcher_count(), 0);
    runtime.shutdown().await;
}

#[tokio::test]
async fn without_functions_the_hooks_leave_everything_alone() {
    let config = test_config();
    let logging = LoggingRuntime::new();
    let triggers = TriggerRegistry::default();
    let foreign = ForeignProjects::default();
    let hooks = HookContext::new(&config, &logging, &foreign, &triggers);
    let mut options = FunctionsConsoleOptions::default();
    functions_options(&hooks, &mut options);
    assert!(options.compute.is_none());
    ready(&hooks);
    before_finish(&hooks).await;
    // With parts but no runtime yet, `ready` hands nothing over.
    let compute = parts(&config);
    ready(&HookContext {
        compute: Some(&compute),
        ..hooks
    });
    assert!(!compute.handed_over());
    // The parts name every service the suite runs and the address apps use.
    let selected = SuiteConfig {
        services: ServiceSelection::parse("functions,auth").expect("selection"),
        ..test_config()
    };
    let (status, snapshot) = get(&console(&parts(&selected)), "/api/v1/functions").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["address"], "http://127.0.0.1:4");
}

#[test]
fn only_an_instances_own_files_in_extensions_count() {
    let instances = vec!["greeter".to_owned()];
    for (path, expected) in [
        ("/p/extensions/greeter.env", true),
        ("/p/extensions/greeter.env.local", true),
        ("/p/extensions/greeter.env.demo-compute", true),
        ("/p/extensions/greeter.secret.local", true),
        ("/p/extensions/greeter.json", false),
        ("/p/extensions/other.env", false),
        ("/p/greeter.env", false),
        ("/p/extensions/.sources/greeter.env", false),
    ] {
        assert_eq!(
            is_parameter_file(Path::new(path), &instances),
            expected,
            "{path}"
        );
    }
}
