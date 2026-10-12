#![allow(clippy::too_many_lines)] // Scenarios read best whole.

use axum::http::StatusCode;
use serde_json::{Value, json};

use super::super::tests::{Setup, Suite};

fn param<'a>(detail: &'a Value, name: &str) -> &'a Value {
    detail["params"]
        .as_array()
        .and_then(|params| params.iter().find(|param| param["param"] == name))
        .unwrap_or_else(|| panic!("{name} in {detail}"))
}

#[tokio::test]
async fn without_extensions_the_snapshot_is_empty_and_says_what_is_emulated() {
    let suite = Suite::starting();
    let (status, snapshot) = suite.get("/extensions/instances").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["phase"], "starting");
    assert_eq!(snapshot["instances"], json!([]));
    assert!(
        snapshot["emulatedApis"]
            .as_array()
            .is_some_and(|apis| apis.contains(&json!("firestore.googleapis.com"))),
        "{snapshot}"
    );
    let (status, body) = suite.get("/extensions/instances/greeter").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    let suite = Suite::running(Setup::default()).await;
    let (_, snapshot) = suite.get("/extensions/instances").await;
    assert_eq!(snapshot["instances"], json!([]));
    let (status, _) = suite.get("/extensions/instances/greeter").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    suite.stop().await;
}

#[tokio::test]
async fn an_instance_shows_its_source_configuration_functions_apis_and_events() {
    let suite = Suite::running(Setup {
        greeter: true,
        ..Setup::default()
    })
    .await;
    let (status, snapshot) = suite.get("/extensions/instances").await;
    assert_eq!(status, StatusCode::OK, "{snapshot}");
    assert_eq!(snapshot["offline"], true);
    let greeter = &snapshot["instances"][0];
    assert_eq!(greeter["instanceId"], "greeter");
    assert_eq!(greeter["written"], "./extensions-local/greeter");
    assert_eq!(greeter["kind"], "local");
    assert_eq!(greeter["reference"], Value::Null);
    assert_eq!(greeter["displayName"], "Greeter");
    assert_eq!(greeter["origin"], "local");
    assert_eq!(greeter["sourceDir"], "extensions-local/greeter");
    assert_eq!(greeter["state"], "running");
    let warnings = greeter["warnings"].as_array().expect("warnings");
    assert!(
        warnings.iter().any(|warning| warning
            .as_str()
            .is_some_and(|text| text.contains("translate.googleapis.com"))),
        "{warnings:?}"
    );
    assert!(
        warnings.iter().any(|warning| warning
            .as_str()
            .is_some_and(|text| text.contains("API_KEY has no value"))),
        "{warnings:?}"
    );
    assert!(
        warnings.iter().any(|warning| warning
            .as_str()
            .is_some_and(|text| text.contains("GREETING: Start with a capital letter."))),
        "{warnings:?}"
    );

    let (status, detail) = suite.get("/extensions/instances/greeter").await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["license"], "Apache-2.0");
    assert_eq!(
        detail["author"],
        json!({"name": "Example Author", "url": "https://example.com"})
    );
    let location = param(&detail, "LOCATION");
    assert_eq!(location["type"], "select");
    assert_eq!(location["value"], "us-central1");
    assert_eq!(location["source"], "file");
    assert_eq!(location["file"], "extensions/greeter.env");
    assert_eq!(location["immutable"], true);
    assert_eq!(
        location["options"][1],
        json!({"value": "europe-west1", "label": "Belgium"})
    );
    assert_eq!(location["problem"], Value::Null);
    let greeting = param(&detail, "GREETING");
    assert_eq!(greeting["value"], "hello");
    assert_eq!(greeting["problem"], "Start with a capital letter.");
    let secret = param(&detail, "API_KEY");
    assert_eq!(secret["type"], "secret");
    assert_eq!(secret["value"], Value::Null);
    assert_eq!(secret["provided"], false);
    assert_eq!(secret["source"], "missing");
    assert_eq!(
        secret["problem"],
        "Set it in extensions/greeter.secret.local."
    );
    let auto: Vec<&str> = detail["autoParams"]
        .as_array()
        .expect("auto params")
        .iter()
        .map(|param| param["name"].as_str().unwrap_or_default())
        .collect();
    assert!(
        auto.contains(&"PROJECT_ID") && auto.contains(&"EXT_INSTANCE_ID"),
        "{auto:?}"
    );
    let translate = detail["apis"]
        .as_array()
        .and_then(|apis| {
            apis.iter()
                .find(|api| api["apiName"] == "translate.googleapis.com")
        })
        .expect("translate");
    assert_eq!(translate["emulated"], false);
    assert_eq!(detail["roles"][0]["role"], "datastore.user");
    let events = &detail["events"];
    assert_eq!(
        events["channel"],
        "projects/demo-compute/locations/us-central1/channels/firebase"
    );
    assert_eq!(events["channelRef"]["kind"], "eventarc.channel");
    assert_eq!(events["allowed"], json!(["test.greeter.v1.greeted"]));
    assert_eq!(events["declared"][0]["allowed"], true);
    assert_eq!(events["declared"][1]["allowed"], false);
    assert_eq!(events["source"], "projects/demo-compute/instances/greeter");
    assert_eq!(
        detail["lifecycle"],
        json!([{"stage": "onInstall", "function": "backfill", "processingMessage": "Greeting existing users"}])
    );
    assert_eq!(
        detail["postinstall"],
        "# Greeter\n\nSee [Firestore](/console/firestore) for greetings.\n"
    );
    let functions = detail["functions"].as_array().expect("functions");
    let greet = functions
        .iter()
        .find(|function| function["resource"] == "greet")
        .expect("greet");
    assert_eq!(greet["functionId"], "us-central1-ext-greeter-greet");
    assert_eq!(greet["function"]["key"], "us-central1-ext-greeter-greet");
    assert_eq!(greet["kind"], "http");
    assert_eq!(greet["status"], "receiving");
    assert_eq!(greet["stats"]["runs"], 0);
    // A task-queue function keeps its definition and is not delivered; the
    // spec still says what it is, and the reason says why.
    let backfill = functions
        .iter()
        .find(|function| function["resource"] == "backfill")
        .expect("backfill");
    assert_eq!(backfill["status"], "ignored", "{backfill}");
    assert_eq!(backfill["kind"], "tasks", "{backfill}");
    assert!(
        backfill["ignoredReason"]
            .as_str()
            .is_some_and(|reason| reason.starts_with("Task queue functions of an extension")),
        "{backfill}"
    );
    assert_eq!(detail["envFiles"], json!(["extensions/greeter.env"]));
    suite.stop().await;
}

#[tokio::test]
async fn reconfigure_lists_every_problem_or_writes_the_files_and_reloads() {
    let suite = Suite::running(Setup {
        greeter: true,
        ..Setup::default()
    })
    .await;
    let (status, refused) = suite
        .post(
            "/extensions/instances/greeter/reconfigure",
            json!({"values": {"GREETING": "lower", "LOCATION": "mars-central1"}}),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    assert_eq!(refused["error"]["code"], "invalid-argument");
    let problems = refused["problems"].as_array().expect("problems");
    assert_eq!(problems.len(), 2, "{refused}");
    assert!(
        problems
            .iter()
            .any(|problem| problem["param"] == "GREETING")
    );
    assert!(problems.iter().any(|problem| problem["param"] == "LOCATION"
        && problem["message"] == "Choose one of: us-central1, europe-west1."));
    let env = suite.directory.path().join("extensions/greeter.env");
    assert!(
        std::fs::read_to_string(&env)
            .expect("read")
            .contains("GREETING=hello"),
        "nothing was written"
    );
    let (status, done) = suite
        .post(
            "/extensions/instances/greeter/reconfigure",
            json!({"values": {"GREETING": "Hi there"}, "secrets": {"API_KEY": "k-1"}}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(
        done["written"],
        json!(["extensions/greeter.env", "extensions/greeter.secret.local"])
    );
    assert!(
        std::fs::read_to_string(&env)
            .expect("read")
            .contains("GREETING=\"Hi there\""),
        "the winning file was written"
    );
    let instance = &done["instance"];
    assert_eq!(param(instance, "GREETING")["value"], "Hi there");
    assert_eq!(param(instance, "GREETING")["problem"], Value::Null);
    assert_eq!(param(instance, "API_KEY")["provided"], true);
    assert_eq!(param(instance, "API_KEY")["value"], Value::Null);
    // A secret names the file it comes from, as a value does.
    assert_eq!(param(instance, "API_KEY")["source"], "file");
    assert_eq!(
        param(instance, "API_KEY")["file"],
        "extensions/greeter.secret.local"
    );
    // An immutable param changes here as editing its file would.
    let (status, moved) = suite
        .post(
            "/extensions/instances/greeter/reconfigure",
            json!({"values": {"LOCATION": "europe-west1"}}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(
        param(&moved["instance"], "LOCATION")["value"],
        "europe-west1"
    );
    let (status, secret) = suite
        .get("/extensions/instances/greeter/secrets/API_KEY")
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(secret["value"], "k-1");
    let (status, _) = suite
        .get("/extensions/instances/greeter/secrets/NOPE")
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, reloaded) = suite
        .post("/extensions/instances/greeter/reload", json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{reloaded}");
    assert_eq!(reloaded["summary"]["state"], "running");
    let (status, vendor) = suite
        .post("/extensions/instances/greeter/vendor", json!({}))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{vendor}");
    for uri in [
        "/extensions/instances/nothing/reload",
        "/extensions/instances/nothing/vendor",
        "/extensions/instances/nothing/reconfigure",
    ] {
        let (status, _) = suite.post(uri, json!({})).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
    }
    suite.stop().await;
}

/// A project spelt through a symbolic link (macOS's `/var` is
/// `/private/var`) still shows its instances' sources relative to it.
#[cfg(unix)]
#[test]
fn a_source_directory_is_relative_to_a_project_spelt_through_a_link() {
    let real = super::super::tests::Scratch::new("relative-real");
    real.write("extensions/greeter/extension.yaml", "name: greeter\n");
    let link = std::env::temp_dir().join(format!(
        "firenook-compute-relative-link-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(real.path(), &link).expect("link");
    let source = real.path().join("extensions/greeter");
    assert_eq!(super::relative(&link, &source), "extensions/greeter");
    assert_eq!(super::relative(real.path(), &source), "extensions/greeter");
    let outside = std::env::temp_dir();
    assert_eq!(
        super::relative(real.path(), &outside),
        outside
            .canonicalize()
            .expect("canonical")
            .display()
            .to_string()
    );
    std::fs::remove_file(&link).expect("unlinked");
}
