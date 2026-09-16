//! Narrow diagnostic for the internal metadata rewrite; no HTTP contract changes.
use super::*;

fn object(index: usize) -> StoredObject {
    StoredObject {
        name: format!("objects/{index}-火🔥"),
        bucket: "demo-bucket".to_owned(),
        generation: 1,
        metageneration: 1,
        content_type: "application/json".to_owned(),
        storage_class: "STANDARD".to_owned(),
        content_disposition: Some("inline".to_owned()),
        content_encoding: Some("gzip".to_owned()),
        content_language: Some("ja".to_owned()),
        cache_control: Some("no-cache, no-store, must-revalidate".to_owned()),
        download_tokens: vec!["synthetic-token".to_owned()],
        custom_metadata: BTreeMap::new(),
        time_created: "2026-09-07T00:00:00Z".to_owned(),
        updated: "2026-09-07T00:00:00Z".to_owned(),
        size: 32,
        md5_hash: "synthetic".to_owned(),
        crc32c: 7,
        etag: "synthetic".to_owned(),
        data_file: format!("objects/{index}"),
    }
}

fn root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "fireside-metadata-{name}-{}-{}",
        std::process::id(),
        now_rfc3339().replace(':', "-")
    ));
    std::fs::create_dir(&root).unwrap();
    root
}

#[test]
fn incremental_metadata_roundtrips_changes_without_resurrecting_legacy_objects() {
    let root = root("roundtrip");
    let value = object(0);
    let key = object_key(&value.bucket, &value.name);
    let mut legacy = StorageData {
        next_id: 7,
        ..StorageData::default()
    };
    legacy.objects.insert(key.clone(), value);
    write_json_atomic(&root.join("metadata.json"), &legacy).unwrap();
    let original = std::fs::read(root.join("metadata.json")).unwrap();
    let (store, mut data) =
        metadata::MetadataStore::open(&root, StorageDurability::PerCommit).unwrap();
    data.objects.get_mut(&key).unwrap().cache_control = Some("updated-cache".to_owned());
    data.next_id = 9;
    assert!(store.update(&data, metadata::Change::Object(&key)).unwrap() < 1024);
    data.uploads.insert(
        "upload".to_owned(),
        UploadSession {
            id: "upload".to_owned(),
            bucket: "demo-bucket".to_owned(),
            name: "resume".to_owned(),
            content_type: "application/json".to_owned(),
            metadata: BTreeMap::new(),
            object_metadata: json!({"contentEncoding":"gzip"}),
            received: 19,
            staging_file: "uploads/staging".to_owned(),
        },
    );
    store
        .update(&data, metadata::Change::Upload("upload"))
        .unwrap();
    drop(store);
    let (store, mut loaded) =
        metadata::MetadataStore::open(&root, StorageDurability::PerCommit).unwrap();
    assert_eq!(
        serde_json::to_value(&loaded).unwrap(),
        serde_json::to_value(&data).unwrap()
    );
    loaded.objects.remove(&key);
    loaded.uploads.clear();
    store
        .update(&loaded, metadata::Change::Object(&key))
        .unwrap();
    store
        .update(&loaded, metadata::Change::Upload("upload"))
        .unwrap();
    drop(store);
    let (store, loaded) =
        metadata::MetadataStore::open(&root, StorageDurability::PerCommit).unwrap();
    assert!(loaded.objects.is_empty());
    assert!(loaded.uploads.is_empty());
    assert_eq!(loaded.next_id, 9);
    assert_eq!(
        std::fs::read(root.join("metadata.json")).unwrap(),
        original,
        "legacy input is preserved, not used after migration"
    );
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn one_object_update_encodes_only_one_record_among_forty_thousand() {
    let root = root("scaling");
    let (store, mut data) =
        metadata::MetadataStore::open(&root, StorageDurability::PerCommit).unwrap();
    for index in 0..40_000 {
        let object = object(index);
        data.objects
            .insert(object_key(&object.bucket, &object.name), object);
    }
    store.replace(&data).unwrap();
    let key = data.objects.keys().next().unwrap().clone();
    data.objects
        .get_mut(&key)
        .unwrap()
        .download_tokens
        .push("new-synthetic-token".to_owned());
    let expected = serde_json::to_vec(&data.objects[&key]).unwrap().len();
    assert_eq!(
        store.update(&data, metadata::Change::Object(&key)).unwrap(),
        expected
    );
    assert!(expected < 1024);
    drop(store);
    let (store, loaded) =
        metadata::MetadataStore::open(&root, StorageDurability::PerCommit).unwrap();
    assert_eq!(loaded.objects.len(), 40_000);
    assert_eq!(loaded.objects[&key].download_tokens.len(), 2);
    store.replace(&StorageData::default()).unwrap();
    drop(store);
    let (store, empty) =
        metadata::MetadataStore::open(&root, StorageDurability::PerCommit).unwrap();
    assert!(empty.objects.is_empty());
    assert_eq!(empty.next_id, 0);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn corrupt_or_locked_database_never_falls_back_to_legacy_json() {
    let root = root("fail-closed");
    write_json_atomic(&root.join("metadata.json"), &StorageData::default()).unwrap();
    let (store, _) = metadata::MetadataStore::open(&root, StorageDurability::PerCommit).unwrap();
    assert!(metadata::MetadataStore::open(&root, StorageDurability::PerCommit).is_err());
    drop(store);
    std::fs::write(
        root.join("metadata.redb"),
        b"corrupt synthetic metadata database",
    )
    .unwrap();
    assert!(metadata::MetadataStore::open(&root, StorageDurability::PerCommit).is_err());
    assert!(root.join("metadata.json").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "manual short profile against a preserved synthetic metadata file"]
fn profile_internal_metadata_serialization() {
    let filename =
        std::env::var("FIRESIDE_STORAGE_PROFILE_INPUT").expect("explicit metadata input");
    let data = load_state(FilePath::new(&filename)).expect("preserved metadata");
    assert!(!data.objects.is_empty());
    let mut samples = Vec::new();
    for _ in 0..10 {
        let start = std::time::Instant::now();
        let pretty = serde_json::to_vec_pretty(&data).unwrap();
        let pretty_micros = start.elapsed().as_micros();
        let start = std::time::Instant::now();
        let compact = serde_json::to_vec(&data).unwrap();
        let compact_micros = start.elapsed().as_micros();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&pretty).unwrap(),
            serde_json::from_slice::<serde_json::Value>(&compact).unwrap()
        );
        samples.push(json!({
            "prettyMicros": pretty_micros, "compactMicros": compact_micros,
            "prettyBytes": pretty.len(), "compactBytes": compact.len()
        }));
    }
    println!(
        "{}",
        json!({"objects": data.objects.len(), "samples": samples})
    );
}

fn write_behind(seconds: u64) -> StorageDurability {
    StorageDurability::WriteBehind {
        interval: std::time::Duration::from_secs(seconds),
    }
}

#[test]
fn write_behind_journals_each_change_and_replays_it_after_a_drop_without_flush() {
    let root = root("write-behind");
    write_json_atomic(&root.join("metadata.json"), &StorageData::default()).unwrap();
    let journal = root.join("metadata.journal");
    {
        let (store, mut data) = metadata::MetadataStore::open(&root, write_behind(3_600)).unwrap();
        assert!(!store.has_unflushed());
        for index in 0..3 {
            let value = object(index);
            let key = object_key(&value.bucket, &value.name);
            data.next_id += 1;
            data.objects.insert(key.clone(), value);
            store.update(&data, metadata::Change::Object(&key)).unwrap();
        }
        // Remove one again: the journal must carry the removal too.
        let removed = object_key(&object(1).bucket, &object(1).name);
        data.objects.remove(&removed);
        store
            .update(&data, metadata::Change::Object(&removed))
            .unwrap();
        assert!(store.has_unflushed());
        assert!(std::fs::metadata(&journal).unwrap().len() > 0);
        // Dropped without a flush: the non-durable redb commits are gone with
        // the process; the journal, written before each acknowledgement, is not.
    }
    let (store, data) = metadata::MetadataStore::open(&root, write_behind(3_600)).unwrap();
    assert_eq!(data.objects.len(), 2);
    assert!(
        data.objects
            .contains_key(&object_key(&object(0).bucket, &object(0).name))
    );
    assert!(
        data.objects
            .contains_key(&object_key(&object(2).bucket, &object(2).name))
    );
    assert_eq!(data.next_id, 3);
    assert!(!store.has_unflushed(), "replay makes the journal durable");
    assert_eq!(std::fs::metadata(&journal).unwrap().len(), 0);

    // A flushed change lives in redb and survives the journal being discarded.
    let mut data = data;
    let value = object(9);
    let key = object_key(&value.bucket, &value.name);
    data.next_id += 1;
    data.objects.insert(key.clone(), value);
    store.update(&data, metadata::Change::Object(&key)).unwrap();
    store.flush().unwrap();
    assert!(!store.has_unflushed());
    drop(store);
    std::fs::remove_file(&journal).unwrap();
    let (_, reloaded) = metadata::MetadataStore::open(&root, StorageDurability::PerCommit).unwrap();
    assert_eq!(reloaded.objects.len(), 3);
    assert!(reloaded.objects.contains_key(&key));
    assert!(!journal.exists(), "per-commit mode keeps no journal");
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn write_behind_flush_syncs_pending_object_files_and_tolerates_deleted_ones() {
    let root = root("pending-files");
    write_json_atomic(&root.join("metadata.json"), &StorageData::default()).unwrap();
    let (store, mut data) = metadata::MetadataStore::open(&root, write_behind(3_600)).unwrap();
    let present = root.join("present.bin");
    std::fs::write(&present, b"bytes").unwrap();
    store.note_unsynced_file(present.clone());
    store.note_unsynced_file(root.join("deleted-before-flush.bin"));
    assert!(store.has_unflushed());
    let value = object(0);
    let key = object_key(&value.bucket, &value.name);
    data.objects.insert(key.clone(), value);
    store.update(&data, metadata::Change::Object(&key)).unwrap();
    store.flush().unwrap();
    assert!(!store.has_unflushed());
    store.flush().unwrap();
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_torn_journal_tail_ends_replay_and_a_sequence_gap_fails_closed() {
    let root = root("torn-journal");
    write_json_atomic(&root.join("metadata.json"), &StorageData::default()).unwrap();
    let journal = root.join("metadata.journal");
    {
        let (store, mut data) = metadata::MetadataStore::open(&root, write_behind(3_600)).unwrap();
        for index in 0..2 {
            let value = object(index);
            let key = object_key(&value.bucket, &value.name);
            data.objects.insert(key.clone(), value);
            store.update(&data, metadata::Change::Object(&key)).unwrap();
        }
    }
    // Power loss mid-line: the torn tail is ignored, the complete entries replay.
    let mut bytes = std::fs::read(&journal).unwrap();
    bytes.extend_from_slice(br#"{"seq":3,"table":"objects","key":"torn"#);
    std::fs::write(&journal, &bytes).unwrap();
    let (_, data) = metadata::MetadataStore::open(&root, write_behind(3_600)).unwrap();
    assert_eq!(data.objects.len(), 2);

    // A sequence that skips ahead is corruption, not a replayable journal.
    let entry = serde_json::json!({"seq": 9, "table": "objects", "key": "gap", "value": null, "next_id": 0});
    std::fs::write(&journal, format!("{entry}\n")).unwrap();
    let Err(error) = metadata::MetadataStore::open(&root, write_behind(3_600)) else {
        panic!("a sequence gap must fail closed")
    };
    assert!(error.to_string().contains("does not follow"), "{error}");
    std::fs::remove_dir_all(&root).unwrap();
}

/// A real process kill of the whole Storage runtime: the child uploads an
/// object under write-behind and aborts before any flush; the parent reopens
/// the same directory and must serve the object with the bytes intact.
#[tokio::test(flavor = "multi_thread")]
async fn uploaded_objects_survive_a_process_abort_under_write_behind() {
    const CHILD_ENVIRONMENT: &str = "FIRESIDE_STORAGE_TEST_ABORT_CHILD";
    use axum::body::{Body, to_bytes};
    use axum::http::{Method, Request, StatusCode};
    use tower::ServiceExt as _;
    let start = |root: PathBuf, durability: StorageDurability| async move {
        let registry = fireside_functions_bridge::TriggerRegistry::default();
        let (observer, _receiver) =
            fireside_functions_bridge::TriggerObserver::channel(registry.clone());
        StorageRuntime::start(
            StorageConfig {
                project: "demo-abort".to_owned(),
                origin: "http://127.0.0.1:1".to_owned(),
                data_dir: root,
                rules: None,
                durability,
            },
            observer.queue(),
            registry,
        )
        .await
        .expect("runtime")
    };
    if let Ok(directory) = std::env::var(CHILD_ENVIRONMENT) {
        let runtime = start(PathBuf::from(directory), write_behind(3_600)).await;
        let router = runtime.application();
        for index in 0..5_u8 {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri(format!(
                            "/upload/storage/v1/b/demo-abort.appspot.com/o?uploadType=media&name=abort%2F{index}.bin"
                        ))
                        .header("authorization", "Bearer owner")
                        .header("content-type", "application/octet-stream")
                        .body(Body::from(vec![index; 4_096]))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
        std::process::abort();
    }

    let root = root("abort");
    let status = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .args([
            "--exact",
            "persistence_tests::uploaded_objects_survive_a_process_abort_under_write_behind",
            "--nocapture",
        ])
        .env(CHILD_ENVIRONMENT, &root)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("spawn child");
    assert!(!status.success(), "the child must have aborted");

    let runtime = start(root.clone(), StorageDurability::default()).await;
    assert_eq!(runtime.object_count(), 5);
    let response = runtime
        .application()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/download/storage/v1/b/demo-abort.appspot.com/o/abort%2F3.bin?alt=media")
                .header("authorization", "Bearer owner")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    assert_eq!(bytes.as_ref(), &[3_u8; 4_096][..]);
    runtime.shutdown().await.unwrap();
    std::fs::remove_dir_all(&root).unwrap();
}
