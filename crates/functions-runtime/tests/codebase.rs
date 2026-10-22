//! Codebase state end to end: loads, not-loaded endpoints and the
//! TypeScript stale-sources check, over a real Node worker.

mod support;

use std::time::{Duration, SystemTime};

use firenook_functions_runtime::LogDelivery;
use firenook_functions_runtime::monitor::{FunctionLoadState, FunctionStale};
use support::Harness;

const INDEX: &str = "exports.api = (req, res) => res.send('ok');\n";

const MANIFEST: &str = "specVersion: v1alpha1
params:
  - name: GREETING
    type: string
    default: hi
endpoints:
  api:
    entryPoint: api
    platform: gcfv2
    httpsTrigger: {}
    availableMemoryMb: 512
  onConfig:
    entryPoint: onConfig
    platform: gcfv2
    eventTrigger:
      eventType: google.firebase.remoteconfig.remoteConfig.v1.updated
      eventFilters: {}
";

async fn harness() -> Option<Harness> {
    match Harness::start(INDEX, MANIFEST, LogDelivery::Attributed).await {
        Ok(harness) => Some(harness),
        Err(reason) => {
            eprintln!("skipped: {reason}");
            None
        }
    }
}

#[tokio::test]
async fn a_load_lists_what_the_emulator_dropped() {
    let Some(harness) = harness().await else {
        return;
    };
    let codebase = harness.monitor.codebase("default").expect("registered");
    assert_eq!(codebase.state, FunctionLoadState::Ready);
    assert_eq!(codebase.loads, 1);
    assert_eq!(codebase.function_count, 1);
    assert_eq!(codebase.directory, "functions");
    assert_eq!(codebase.runtime.as_deref(), Some("nodejs22"));
    assert_eq!(codebase.not_loaded.len(), 1);
    assert_eq!(codebase.not_loaded[0].id, "us-central1-onConfig");
    assert_eq!(
        codebase.not_loaded[0].reason,
        "google.firebase.remoteconfig.remoteConfig.v1.updated is not emulated"
    );
    assert_eq!(
        codebase.last_change.expect("a diff").added,
        ["us-central1-api"]
    );
    assert_eq!(
        harness.monitor.phase(),
        firenook_functions_runtime::monitor::FunctionsPhase::Running
    );
    harness.stop().await;
}

fn set_modified(path: &std::path::Path, at: SystemTime) {
    let file = std::fs::File::options()
        .write(true)
        .open(path)
        .expect("an existing file");
    file.set_modified(at).expect("a modification time");
}

#[tokio::test]
async fn typescript_sources_newer_than_the_build_are_flagged_after_the_recheck() {
    let Some(probe) = harness().await else {
        return;
    };
    probe.stop().await;
    // A codebase whose src/ is newer than its compiled entry.
    let Ok(harness) = Harness::start_with_files(
        INDEX,
        MANIFEST,
        LogDelivery::Attributed,
        &[
            ("tsconfig.json", "{}"),
            ("src/index.ts", "export const api = 1;\n"),
        ],
        |source| {
            let past = SystemTime::now() - Duration::from_secs(60);
            set_modified(&source.join("index.js"), past);
        },
    )
    .await
    else {
        return;
    };
    assert_eq!(
        harness
            .monitor
            .codebase("default")
            .expect("registered")
            .stale,
        None
    );
    support::eventually("the stale flag", || {
        harness
            .monitor
            .codebase("default")
            .is_some_and(|codebase| codebase.stale.is_some())
    })
    .await;
    assert!(matches!(
        harness
            .monitor
            .codebase("default")
            .expect("registered")
            .stale,
        Some(FunctionStale::SourcesNewer { .. })
    ));
    harness.stop().await;
    // A build that catches up within the re-check clears it first.
    let Ok(harness) = Harness::start_with_files(
        INDEX,
        MANIFEST,
        LogDelivery::Attributed,
        &[
            ("tsconfig.json", "{}"),
            ("src/index.ts", "export const api = 1;\n"),
        ],
        |source| {
            let past = SystemTime::now() - Duration::from_secs(60);
            set_modified(&source.join("index.js"), past);
        },
    )
    .await
    else {
        return;
    };
    let entry = harness
        .directory
        .path()
        .canonicalize()
        .expect("a path")
        .join("functions/index.js");
    set_modified(&entry, SystemTime::now() + Duration::from_secs(60));
    tokio::time::sleep(Duration::from_millis(3_600)).await;
    assert_eq!(
        harness
            .monitor
            .codebase("default")
            .expect("registered")
            .stale,
        None
    );
    harness.stop().await;
}

/// The warnings about the Node the functions run on.
fn node_warnings(harness: &Harness) -> Vec<String> {
    harness
        .events()
        .into_iter()
        .filter(|event| {
            event.level == "WARN" && event.message.contains(", but these functions run on Node ")
        })
        .map(|event| event.message)
        .collect()
}

#[tokio::test]
async fn functions_on_a_node_their_codebase_does_not_ask_for_are_warned_about_once() {
    let Ok((node, _)) = support::requirements() else {
        eprintln!("skipped: no Node or Functions SDK");
        return;
    };
    let version = firenook_functions_runtime::node::probe(&node)
        .await
        .expect("the test Node prints its version");
    let other = if version.major == 22 { 24 } else { 22 };
    let package = |node: u64| {
        format!(r#"{{"name":"dispatch","main":"index.js","engines":{{"node":"{node}"}}}}"#)
    };
    // engines.node names another major: the load says so, once.
    let asks_other = package(other);
    let harness =
        Harness::start_with_runtime(INDEX, MANIFEST, &[("package.json", &asks_other)], None)
            .await
            .expect("the runtime starts");
    assert_eq!(
        node_warnings(&harness),
        [format!(
            "functions/package.json asks for Node {other} in engines.node, but these functions run on Node {version}, the Node running the emulators; start the emulators with Node {other} to run them on the Node they ask for (with nvm: nvm use {other})"
        )]
    );
    let warning = harness
        .events()
        .into_iter()
        .find(|event| event.message.contains(", but these functions run on Node "))
        .expect("the warning");
    assert_eq!(
        (warning.label.as_str(), warning.codebase.as_deref()),
        ("functions", Some("default"))
    );
    // A reload that changes nothing else does not repeat it.
    let mut updates = harness.runtime.updates();
    std::fs::write(
        harness.directory.path().join("functions/index.js"),
        format!("{INDEX}// saved again\n"),
    )
    .expect("written");
    tokio::time::timeout(Duration::from_secs(15), updates.changed())
        .await
        .expect("a reload")
        .expect("the runtime runs");
    assert_eq!(
        harness
            .monitor
            .codebase("default")
            .expect("registered")
            .loads,
        2
    );
    assert_eq!(node_warnings(&harness).len(), 1);
    harness.stop().await;

    // engines.node names the running major, or a range that admits it.
    for asks in [
        package(version.major),
        r#"{"name":"dispatch","main":"index.js","engines":{"node":">=22"}}"#.to_owned(),
    ] {
        let harness =
            Harness::start_with_runtime(INDEX, MANIFEST, &[("package.json", &asks)], None)
                .await
                .expect("the runtime starts");
        assert_eq!(node_warnings(&harness), Vec::<String>::new(), "{asks}");
        harness.stop().await;
    }

    // firebase.json's runtime comes before engines.node, as in the
    // official emulator.
    let runtime = format!("nodejs{other}");
    let asks_running = package(version.major);
    let harness = Harness::start_with_runtime(
        INDEX,
        MANIFEST,
        &[("package.json", &asks_running)],
        Some(&runtime),
    )
    .await
    .expect("the runtime starts");
    assert_eq!(
        node_warnings(&harness),
        [format!(
            "firebase.json asks for nodejs{other} for functions (its runtime), but these functions run on Node {version}, the Node running the emulators; start the emulators with Node {other} to run them on the Node they ask for (with nvm: nvm use {other})"
        )]
    );
    harness.stop().await;
}
