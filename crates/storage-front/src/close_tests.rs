//! A close leaves the metadata database without redb's repair mark, which
//! it clears only when the last handle is dropped.

use super::*;
use firenook_functions_bridge::TriggerObserver;

async fn start(root: &FilePath) -> StorageRuntime {
    let registry = TriggerRegistry::default();
    let (observer, _receiver) = TriggerObserver::channel(registry.clone());
    StorageRuntime::start(
        StorageConfig {
            project: "demo-close".to_owned(),
            durability: StorageDurability::default(),
            origin: "http://127.0.0.1:21002".to_owned(),
            data_dir: root.to_path_buf(),
            rules: None,
        },
        observer.queue(),
        registry,
    )
    .await
    .expect("runtime")
}

fn opens_without_repair(root: &FilePath) -> bool {
    redb::Builder::new()
        .open_read_only(root.join("metadata.redb"))
        .is_ok()
}

fn temp(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "firenook-storage-close-{label}-{}-{}",
        std::process::id(),
        now_rfc3339().replace(':', "-")
    ))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_close_leaves_no_repair_for_the_next_open() {
    let root = temp("clean");
    let runtime = start(&root).await;
    assert!(!opens_without_repair(&root));
    runtime.close().await.expect("closed");
    assert!(opens_without_repair(&root));
    std::fs::remove_dir_all(root).expect("isolated test cleanup");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_close_reports_a_handle_still_held() {
    let root = temp("held");
    let runtime = start(&root).await;
    let console = runtime.console();
    let error = runtime.close().await.expect_err("still held");
    assert!(error.to_string().contains("still held"), "{error}");
    // Durable all the same: the file closes with the last handle.
    drop(console);
    assert!(opens_without_repair(&root));
    std::fs::remove_dir_all(root).expect("isolated test cleanup");
}
