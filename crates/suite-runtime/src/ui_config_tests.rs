//! `/api/config` of a suite that runs what `developer-tools-v1` recorded
//! (`firebase emulators:start --only firestore,auth,storage` with the UI),
//! answered by the suite's own listing (`suite_directory`) through the UI
//! router, compared with the recorded `config`.
use super::*;
use axum::body::{Body, to_bytes};
use axum::http::Request;
use serde_json::{Value, json};
use tower::ServiceExt as _;

/// The capture named every port by its service (`normalize-capture.mjs`).
fn name_ports(value: &mut Value, ports: &BTreeMap<u16, &'static str>) {
    match value {
        Value::Number(number) => {
            if let Some(name) = number
                .as_u64()
                .and_then(|port| u16::try_from(port).ok())
                .and_then(|port| ports.get(&port))
            {
                *value = json!(name);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| name_ports(item, ports)),
        Value::Object(fields) => fields.values_mut().for_each(|item| name_ports(item, ports)),
        _ => {}
    }
}

#[tokio::test]
async fn developer_tools_ui_config_lists_the_recorded_services() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../conformance/fixtures/developer-tools-v1/fixture.json"
    ))
    .expect("fixture");
    let recorded = &fixture["config"];
    let mut config = diagnostics_tests::test_config();
    config.project_id = fixture["project"].as_str().expect("project").to_owned();
    config.services = ServiceSelection {
        firestore: true,
        auth: true,
        storage: true,
        functions: false,
        pubsub: false,
    };
    config.ports = SuitePorts {
        firestore: 21001,
        auth: 21002,
        storage: 21003,
        functions: 21004,
        pubsub: 21005,
        hub: 21006,
        ui: 21007,
        firestore_websocket: 21008,
        logging: 21009,
        eventarc: 21010,
        tasks: 21011,
    };
    let ports: BTreeMap<u16, &'static str> = [
        (21001, "firestore"),
        (21002, "auth"),
        (21003, "storage"),
        (21006, "hub"),
        (21007, "ui"),
        (21008, "websocket"),
        (21009, "logging"),
    ]
    .into_iter()
    .collect();
    let directory = suite_directory(&config).expect("directory");
    let response = ui_router(directory)
        .oneshot(
            Request::get("/api/config")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status().as_u16(), 200);
    let mut actual: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("JSON");
    name_ports(&mut actual, &ports);
    // The two differences BUG_CANDIDATES holds: the official Firestore
    // entry names the Java emulator's process id (`<oracle-pid>`), and the
    // official listing has no entry of its own for the requests WebSocket
    // (it is the Firestore entry's `webSocketPort`).
    assert_ne!(
        actual, *recorded,
        "ui/config matches now: note it and leave BUG_CANDIDATES"
    );
    assert_eq!(recorded["firestore"]["pid"], "<oracle-pid>");
    assert!(recorded.get("firestore.websocket").is_none());
    let mut expected = recorded.clone();
    expected["firestore"]
        .as_object_mut()
        .expect("firestore")
        .remove("pid");
    let listed = actual
        .as_object_mut()
        .expect("config")
        .remove("firestore.websocket")
        .expect("Firenook's own WebSocket entry");
    assert_eq!(listed["port"], "websocket");
    assert_eq!(actual, expected, "/api/config apart from the two");
    assert!(BUG_CANDIDATES.iter().any(|(case, _)| *case == "ui/config"));
}

/// Bug candidates: answered otherwise with no documented reason, kept out of
/// the ledger; the test above fails once one matches.
const BUG_CANDIDATES: &[(&str, &str)] = &[(
    "ui/config",
    "/api/config lists a `firestore.websocket` entry the official listing does not have (it names the port only as the Firestore entry's webSocketPort), and its Firestore entry has no `pid` where the official one names its emulator's process (suite-runtime suite_directory, suite-front wire_services)",
)];
