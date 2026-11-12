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

/// The capture named every process id it found (`normalize-capture.mjs`).
fn name_pids(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(name_pids),
        Value::Object(fields) => {
            for (key, item) in fields.iter_mut() {
                if key == "pid" && item.is_number() {
                    *item = json!("<oracle-pid>");
                } else {
                    name_pids(item);
                }
            }
        }
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
    name_pids(&mut actual);
    assert_eq!(&actual, recorded, "/api/config");
    firenook_conformance_ledger::checked(
        "developer-tools-v1",
        "ui/config",
        firenook_conformance_ledger::Compared::Answer,
    );
}
