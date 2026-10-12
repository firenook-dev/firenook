use std::path::PathBuf;

use firenook_functions_bridge::TriggerRegistry;
use firenook_functions_runtime::{
    EmulatorHosts, FunctionsRuntime, MonitorLimits, RuntimeConfig, RuntimeOptions,
};

use super::*;
use crate::SourceOrigin;
use crate::registry::Endpoints;
use crate::source::RegistrySidecar;

const SPEC: &str = "name: greeter
version: 0.1.0
specVersion: v1beta
resources:
  - name: greet
    type: firebaseextensions.v1beta.function
    description: ${param:NOTE}
    properties:
      location: ${param:LOCATION}
      runtime: nodejs22
      httpsTrigger: {}
params:
  - param: LOCATION
    type: select
    options:
      - value: us-central1
      - value: europe-west1
    default: us-central1
    required: true
  - param: GREETING
    type: string
    validationRegex: ^[A-Za-z ]+$
    validationErrorMessage: Letters and spaces only.
    required: true
  - param: NOTE
    type: string
    default: plain
  - param: COLLECTION
    type: string
    immutable: true
    default: greetings
  - param: API_KEY
    type: secret
";

struct Setup {
    directory: tempfile::TempDir,
    project: PathBuf,
    control: ExtensionsControl,
    runtime: FunctionsRuntime,
    monitor: Monitor,
}

fn config(project: &Path, extensions: Vec<(String, String)>) -> ExtensionsConfig {
    ExtensionsConfig {
        project_id: "demo-control".to_owned(),
        project_dir: project.to_path_buf(),
        extensions,
        aliases: Vec::new(),
        database_url: "https://demo-control.firebaseio.com".to_owned(),
        storage_bucket: "demo-control.appspot.com".to_owned(),
        npm: PathBuf::from("npm"),
        cache_dir: project.join("cache"),
        endpoints: Endpoints {
            registry_origin: "http://127.0.0.1:1".to_owned(),
            token_origin: "http://127.0.0.1:1".to_owned(),
            client_id: String::new(),
            client_secret: String::new(),
        },
        credential: None,
        offline: true,
        ui_origin: None,
    }
}

fn write_local(project: &Path) {
    let extension = project.join("extensions-local/greeter");
    std::fs::create_dir_all(extension.join("functions")).unwrap();
    std::fs::write(extension.join("extension.yaml"), SPEC).unwrap();
    std::fs::write(extension.join("POSTINSTALL.md"), "# Greeter\n").unwrap();
    std::fs::write(
        extension.join("functions/package.json"),
        "{\"name\":\"greeter\"}",
    )
    .unwrap();
    std::fs::create_dir_all(project.join("extensions")).unwrap();
    std::fs::write(
        project.join("extensions/greeter.env"),
        "# the greeter\nLOCATION=us-central1\nGREETING=hello\n",
    )
    .unwrap();
    std::fs::write(
        project.join("extensions/greeter.env.local"),
        "NOTE=local note\n",
    )
    .unwrap();
}

async fn start(
    config: ExtensionsConfig,
    project: &Path,
) -> (ExtensionsControl, FunctionsRuntime, Monitor) {
    let (log, _events) = LogSink::recording();
    let outcome = crate::load_outcome(&config, &log).await.expect("loaded");
    let monitor = Monitor::new(MonitorLimits::default());
    let host = "127.0.0.1:1".to_owned();
    let runtime = FunctionsRuntime::start_with(
        RuntimeConfig {
            project_id: config.project_id.clone(),
            project_alias: None,
            host: "127.0.0.1".to_owned(),
            functions_port: 5001,
            project_dir: project.to_path_buf(),
            node: PathBuf::from("/nonexistent/firenook-test-node"),
            state_dir: project.join("state"),
            default_bucket: config.storage_bucket.clone(),
            hosts: EmulatorHosts {
                firestore: host.clone(),
                auth: host.clone(),
                storage: host.clone(),
                pubsub: host.clone(),
                hub: host.clone(),
                eventarc: host.clone(),
                tasks: host,
            },
            codebases: Vec::new(),
            extensions: outcome
                .loaded
                .iter()
                .map(|loaded| loaded.backend.clone())
                .collect(),
            inspect: None,
        },
        TriggerRegistry::default(),
        log.clone(),
        RuntimeOptions {
            monitor: monitor.clone(),
            ..RuntimeOptions::default()
        },
    )
    .await
    .expect("the runtime starts");
    let control = ExtensionsControl::new(config, &outcome, runtime.console(), monitor.clone(), log);
    (control, runtime, monitor)
}

async fn setup() -> Setup {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().canonicalize().unwrap();
    write_local(&project);
    let config = config(
        &project,
        vec![(
            "greeter".to_owned(),
            "./extensions-local/greeter".to_owned(),
        )],
    );
    let (control, runtime, monitor) = start(config, &project).await;
    Setup {
        directory,
        project,
        control,
        runtime,
        monitor,
    }
}

fn loads(monitor: &Monitor) -> u32 {
    monitor.codebase("greeter").expect("registered").loads
}

#[tokio::test]
async fn reconfigure_writes_the_winning_files_and_reloads_once() {
    let setup = setup().await;
    let state = setup.control.instance("greeter").await.expect("running");
    let loaded = state.loaded.expect("loaded");
    assert_eq!(loaded.param_sources["GREETING"], "extensions/greeter.env");
    assert_eq!(loaded.param_sources["NOTE"], "extensions/greeter.env.local");
    assert_eq!(loaded.defaults_applied, ["COLLECTION"]);
    assert_eq!(loaded.written, "./extensions-local/greeter");
    assert_eq!(loads(&setup.monitor), 1);
    let reconfigured = setup
        .control
        .reconfigure(
            "greeter",
            BTreeMap::from([
                ("GREETING".to_owned(), "good day".to_owned()),
                ("NOTE".to_owned(), "changed".to_owned()),
                ("LOCATION".to_owned(), "europe-west1".to_owned()),
            ]),
            BTreeMap::from([("API_KEY".to_owned(), "s3cret".to_owned())]),
        )
        .await
        .expect("reconfigured");
    assert_eq!(
        reconfigured.written,
        [
            "extensions/greeter.env",
            "extensions/greeter.env.local",
            "extensions/greeter.secret.local"
        ]
    );
    assert_eq!(
        std::fs::read_to_string(setup.project.join("extensions/greeter.env")).unwrap(),
        "# the greeter\nLOCATION=europe-west1\nGREETING=\"good day\"\n"
    );
    assert_eq!(
        std::fs::read_to_string(setup.project.join("extensions/greeter.env.local")).unwrap(),
        "NOTE=changed\n"
    );
    assert_eq!(
        std::fs::read_to_string(setup.project.join("extensions/greeter.secret.local")).unwrap(),
        "API_KEY=s3cret\n"
    );
    let backend = reconfigured.state.loaded.expect("loaded").backend;
    assert_eq!(backend.env["GREETING"], "good day");
    assert_eq!(backend.secret_values["API_KEY"], "s3cret");
    assert_eq!(loads(&setup.monitor), 2);
    assert_eq!(
        setup.control.secret("greeter", "API_KEY").await.as_deref(),
        Some("s3cret")
    );
    // The watcher reporting the console's own writes reloads nothing.
    setup
        .control
        .files_changed(vec![
            setup.project.join("extensions/greeter.env"),
            setup.project.join("extensions/greeter.secret.local"),
        ])
        .await;
    assert_eq!(loads(&setup.monitor), 2);
    // A change made in an editor does.
    std::fs::write(
        setup.project.join("extensions/greeter.env"),
        "LOCATION=us-central1\nGREETING=edited\n",
    )
    .unwrap();
    setup
        .control
        .files_changed(vec![setup.project.join("extensions/greeter.env")])
        .await;
    assert_eq!(loads(&setup.monitor), 3);
    let state = setup.control.instance("greeter").await.expect("running");
    assert_eq!(
        state.loaded.expect("loaded").backend.env["GREETING"],
        "edited"
    );
    setup.runtime.shutdown().await;
    drop(setup.directory);
}

#[tokio::test]
async fn values_that_do_not_load_are_put_back_byte_for_byte() {
    let setup = setup().await;
    let env = setup.project.join("extensions/greeter.env.local");
    let before = std::fs::read(&env).unwrap();
    let failed = setup
        .control
        .reconfigure(
            "greeter",
            BTreeMap::from([("NOTE".to_owned(), "say \"hi\"".to_owned())]),
            BTreeMap::new(),
        )
        .await
        .expect_err("refused");
    let ReconfigureError::LoadFailed { message, detail } = failed else {
        panic!("a load failure: {failed:?}");
    };
    assert_eq!(
        message,
        "greeter did not load with these values, so your files were put back."
    );
    assert!(detail.contains("invalid JSON"), "{detail}");
    assert_eq!(std::fs::read(&env).unwrap(), before);
    assert_eq!(loads(&setup.monitor), 1);
    let state = setup.control.instance("greeter").await.expect("running");
    assert_eq!(state.state, ExtensionState::Running);
    // The restore was the console's own write: no reload follows it.
    setup.control.files_changed(vec![env]).await;
    assert_eq!(loads(&setup.monitor), 1);
    setup.runtime.shutdown().await;
}

#[tokio::test]
async fn every_problem_is_reported_at_once() {
    let setup = setup().await;
    let refused = setup
        .control
        .reconfigure(
            "greeter",
            BTreeMap::from([
                ("GREETING".to_owned(), "hi 42".to_owned()),
                ("LOCATION".to_owned(), "mars".to_owned()),
                ("COLLECTION".to_owned(), "other".to_owned()),
                ("UNKNOWN".to_owned(), "x".to_owned()),
                ("API_KEY".to_owned(), "in the clear".to_owned()),
            ]),
            BTreeMap::from([("NOTE".to_owned(), "not a secret".to_owned())]),
        )
        .await
        .expect_err("refused");
    let ReconfigureError::Invalid(problems) = refused else {
        panic!("problems: {refused:?}");
    };
    let messages: BTreeMap<&str, &str> = problems
        .iter()
        .map(|problem| (problem.param.as_str(), problem.message.as_str()))
        .collect();
    assert_eq!(messages["GREETING"], "Letters and spaces only.");
    assert_eq!(
        messages["LOCATION"],
        "Choose one of: us-central1, europe-west1."
    );
    assert_eq!(
        messages["COLLECTION"],
        "This parameter cannot change after the instance is installed."
    );
    assert_eq!(
        messages["UNKNOWN"],
        "The extension declares no such parameter."
    );
    assert_eq!(messages["API_KEY"], "This is a secret: set it as a secret.");
    assert_eq!(messages["NOTE"], "This is not a secret parameter.");
    assert_eq!(loads(&setup.monitor), 1);
    setup.runtime.shutdown().await;
}

#[tokio::test]
async fn a_reconfigure_and_a_watcher_reload_never_overlap() {
    let setup = setup().await;
    std::fs::write(
        setup.project.join("extensions/greeter.env"),
        "LOCATION=us-central1\nGREETING=from the editor\n",
    )
    .unwrap();
    let (reconfigured, ()) = tokio::join!(
        setup.control.reconfigure(
            "greeter",
            BTreeMap::from([("NOTE".to_owned(), "together".to_owned())]),
            BTreeMap::new(),
        ),
        setup
            .control
            .files_changed(vec![setup.project.join("extensions/greeter.env")]),
    );
    reconfigured.expect("reconfigured");
    // Each ran whole under the instance's lock: two loads, nothing torn.
    let loads_now = loads(&setup.monitor);
    assert!((2..=3).contains(&loads_now), "{loads_now}");
    let backend = setup
        .control
        .instance("greeter")
        .await
        .expect("running")
        .loaded
        .expect("loaded")
        .backend;
    assert_eq!(backend.env["NOTE"], "together");
    assert_eq!(backend.env["GREETING"], "from the editor");
    setup.runtime.shutdown().await;
}

#[tokio::test]
async fn vendoring_reloads_from_the_vendored_copy() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().canonicalize().unwrap();
    std::fs::create_dir_all(project.join("extensions")).unwrap();
    std::fs::write(
        project.join("extensions/stripe.env"),
        "LOCATION=us-central1\n",
    )
    .unwrap();
    // A cached registry source with its sidecar: loads offline.
    let cached = project.join("cache/acme/greeter@1.2.3");
    std::fs::create_dir_all(cached.join("functions")).unwrap();
    std::fs::write(cached.join("extension.yaml"), "name: greeter\n").unwrap();
    std::fs::write(cached.join("functions/package.json"), "{}").unwrap();
    crate::source::write_sidecar(
        &cached,
        &RegistrySidecar {
            extension: serde_json::json!({ "name": "publishers/acme/extensions/greeter" }),
            extension_version: serde_json::json!({
                "name": "publishers/acme/extensions/greeter/versions/1.2.3",
                "spec": { "name": "greeter", "version": "1.2.3", "resources": [
                    { "name": "greet", "type": "firebaseextensions.v1beta.function",
                      "propertiesYaml": "location: ${param:LOCATION}\nhttpsTrigger: {}\n" }
                ], "params": [{ "param": "LOCATION", "type": "select" }] }
            }),
        },
    )
    .unwrap();
    let config = config(
        &project,
        vec![("stripe".to_owned(), "acme/greeter@1.2.3".to_owned())],
    );
    let (control, runtime, _monitor) = start(config, &project).await;
    let before = control.instance("stripe").await.expect("running");
    assert_eq!(before.loaded.expect("loaded").origin, SourceOrigin::Cache);
    let vendored = control.vendor("stripe").await.expect("vendored");
    assert_eq!(vendored.directory, "extensions/.sources/acme/greeter@1.2.3");
    assert_eq!(vendored.version, "1.2.3");
    let loaded = vendored.state.loaded.expect("loaded");
    assert_eq!(loaded.origin, SourceOrigin::Vendored);
    assert_eq!(
        loaded.backend.functions_dir,
        project.join("extensions/.sources/acme/greeter@1.2.3/functions")
    );
    assert_eq!(vendored.state.status.source, Some("vendored"));
    runtime.shutdown().await;
}

#[test]
fn instance_files_are_recognised_by_name() {
    assert!(instance_file("greeter", "greeter.env"));
    assert!(instance_file("greeter", "greeter.env.local"));
    assert!(instance_file("greeter", "greeter.env.demo-project"));
    assert!(instance_file("greeter", "greeter.secret.local"));
    assert!(!instance_file("greeter", "greeter.env."));
    assert!(!instance_file("greeter", "greeterx.env"));
    assert!(!instance_file("greeter", "other.env"));
}
