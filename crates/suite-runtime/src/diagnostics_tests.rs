//! Test the real static listener assembly, not a second hand-wired Requests router.
use super::*;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::Duration;

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn suite_listener_assembly_shares_real_evaluations_and_closes_idle_debug_clients() {
    for enabled in [false, true] {
        let mut listeners = BTreeMap::new();
        let mut addresses = BTreeMap::new();
        for name in [
            "firestore",
            "auth",
            "storage",
            "hub",
            "ui",
            "logging",
            "eventarc",
            "tasks",
            "firestore.websocket",
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            addresses.insert(name, listener.local_addr().unwrap());
            listeners.insert(name, listener);
        }
        let applications = applications(enabled);
        let (shutdown, _) = watch::channel(false);
        let (failed, mut failures) = mpsc::unbounded_channel();
        let config = test_config();
        let logging = LoggingRuntime::new();
        let servers = spawn_static_servers(
            &config,
            &mut ListenerSet(listeners),
            applications,
            &logging,
            &shutdown,
            &failed,
        )
        .unwrap();
        let url = format!("ws://{}/requests", addresses["firestore.websocket"]);
        let result = tokio_tungstenite::connect_async(url).await;
        let mut client = if enabled {
            let mut client = result.unwrap().0;
            let frame = tokio::time::timeout(Duration::from_secs(3), client.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(frame.to_text().unwrap()).unwrap(),
                json!([])
            );
            let response = reqwest::get(format!(
                "http://{}/v1/projects/demo-diagnostics/databases/(default)/documents/items/one",
                addresses["firestore"]
            ))
            .await
            .unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
            let frame = tokio::time::timeout(Duration::from_secs(3), client.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let event: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
            assert_eq!(event["outcome"], "allow");
            assert!(event["requestId"].is_string());
            let report = reqwest::get(format!(
                "http://{}/emulator/v1/projects/demo-diagnostics:ruleCoverage",
                addresses["firestore"]
            ))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
            let report: Value = serde_json::from_str(&report).unwrap();
            assert_eq!(report["report"][0]["values"][0]["count"], 1);
            Some(client)
        } else {
            let tokio_tungstenite::tungstenite::Error::Http(response) = result.unwrap_err() else {
                panic!("disabled diagnostics must reject the upgrade");
            };
            assert_eq!(
                response.status(),
                axum::http::StatusCode::SERVICE_UNAVAILABLE
            );
            None
        };
        shutdown.send(true).unwrap();
        for server in servers {
            tokio::time::timeout(Duration::from_secs(3), server)
                .await
                .unwrap()
                .unwrap();
        }
        if let Some(client) = client.as_mut() {
            let frame = tokio::time::timeout(Duration::from_secs(3), client.next())
                .await
                .unwrap();
            assert!(
                frame.is_none()
                    || frame.as_ref().is_some_and(|frame| frame.is_err()
                        || frame
                            .as_ref()
                            .is_ok_and(tokio_tungstenite::tungstenite::Message::is_close))
            );
        }
        assert!(failures.try_recv().is_err());
    }
}

fn applications(enabled: bool) -> StaticApplications {
    let runtime = if enabled {
        RulesRuntime::with_request_history(RequestHistory::default())
    } else {
        RulesRuntime::default()
    };
    runtime.install_default("rules_version = '2'; service cloud.firestore { match /databases/{db}/documents/items/{id} { allow get: if request.method == 'get'; } }").unwrap();
    let history = runtime.request_history();
    let rest = fireside_rest_front::router_with_query_policy_memory_rules_and_triggers(
        Store::default(),
        QueryPolicy::default(),
        None,
        runtime,
        TriggerRegistry::default(),
    );
    StaticApplications {
        firestore: Some(tonic::service::Routes::from(rest)),
        request_history: history,
        // Unrelated services are inert shells in this listener-assembly test.
        auth: Some(Router::new()),
        storage: Some(Router::new()),
        hub: Router::new(),
        ui: Some(Router::new()),
        logging: Router::new(),
    }
}

fn test_config() -> SuiteConfig {
    let root = std::env::temp_dir();
    SuiteConfig {
        host: "127.0.0.1".into(),
        project_id: "demo-diagnostics".into(),
        services: ServiceSelection::ALL,
        ui_enabled: true,
        single_project_mode: true,
        debug_log: None,
        project_dir: root.clone(),
        firebase_json: root.join("firebase.json"),
        node: root.clone(),
        inspect_functions: None,
        offline: true,
        ui_archive: root.clone(),
        state_dir: root.join("state"),
        resume_state: false,
        firestore_in_memory: true,
        durability: fireside_core_store::DiskDurability::default(),
        diagnostics: true,
        firestore_rules: None,
        firestore_indexes: None,
        storage_rules: StorageRulesConfig::OpenDefault,
        default_bucket: "demo-diagnostics.appspot.com".into(),
        import: None,
        export_on_exit: None,
        ports: SuitePorts {
            firestore: 1,
            auth: 2,
            storage: 3,
            functions: 4,
            pubsub: 5,
            hub: 6,
            ui: 7,
            firestore_websocket: 8,
            logging: 9,
            eventarc: 10,
            tasks: 11,
        },
        minimum_functions: 0,
    }
}
