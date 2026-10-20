//! A stop leaves the data files closed: redb clears its repair mark only
//! when a database is dropped, and a file left marked makes the next start
//! repair it.

use std::path::Path;

use firenook_core_store::{DatabaseName, DocumentKey, Fields, Write};

use super::*;
use crate::diagnostics_tests::test_config;

/// Whether redb opens the file read-only, which it refuses while the file
/// is still marked for repair.
fn opens_without_repair(path: &Path) -> bool {
    redb::Builder::new().open_read_only(path).is_ok()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_before_ready_closes_firestore_and_storage() {
    let root = std::env::temp_dir().join(format!(
        "firenook-close-before-ready-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("project");
    std::fs::write(
        root.join("firebase.json"),
        r#"{"firestore":{"rules":"firestore.rules"}}"#,
    )
    .expect("firebase.json");
    std::fs::write(
        root.join("firestore.rules"),
        "rules_version = '2';\nservice cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }\n",
    )
    .expect("rules");
    let config = SuiteConfig {
        project_id: "demo-close".into(),
        project_dir: root.clone(),
        firebase_json: root.join("firebase.json"),
        state_dir: root.join("state"),
        firestore_in_memory: false,
        services: ServiceSelection::parse("firestore,auth,storage").expect("selection"),
        ..test_config()
    };
    // Everything a start opens before readiness, the console's Firestore
    // pieces (which observe the store) included.
    let prepared = prepare_suite(&config, false).await.expect("prepared");
    prepared
        .store
        .commit(&[Write::Create {
            key: DocumentKey::new(
                DatabaseName::new("demo-close", "(default)").expect("database"),
                "orders/o_1",
            )
            .expect("key"),
            fields: Fields::new(),
        }])
        .expect("committed");
    let firestore = root.join("state/firestore/firenook.redb");
    let storage = root.join("state/storage/metadata.redb");
    assert!(!opens_without_repair(&firestore));
    let outcome = stopped_before_ready(Some(prepared)).await;
    assert!(outcome.before_ready);
    assert_eq!(outcome.firestore_documents, 1);
    assert!(opens_without_repair(&firestore), "Firestore was left open");
    assert!(opens_without_repair(&storage), "Storage was left open");
    let _ = std::fs::remove_dir_all(&root);
}
