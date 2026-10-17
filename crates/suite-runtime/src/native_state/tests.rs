use super::*;
use crate::{StorageBucketConfig, StorageRulesConfig, SuitePorts};
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Case {
    root: PathBuf,
    config: SuiteConfig,
}
impl Case {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "firenook-native-state-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let seed = root.join("seed");
        fs::create_dir(&seed).unwrap();
        fs::write(seed.join("firebase-export-metadata.json"), b"{}").unwrap();
        fs::write(seed.join("documents"), "seed-\u{706b}\u{1f525}").unwrap();
        let config = SuiteConfig {
            durability: firenook_core_store::DiskDurability::default(),
            host: "127.0.0.1".into(),
            allowed_hosts: Vec::new(),
            project_id: "demo-native-resume".into(),
            services: crate::ServiceSelection::ALL,
            ui_enabled: true,
            single_project_mode: true,
            debug_log: None,
            project_dir: root.clone(),
            firebase_json: root.join("firebase.json"),
            inspect_functions: None,
            offline: true,
            node: root.clone(),
            state_dir: root.join("state"),
            resume_state: true,
            firestore_in_memory: false,
            diagnostics: false,
            firestore_databases: Vec::new(),
            storage_rules: StorageRulesConfig::PerBucket(vec![StorageBucketConfig {
                bucket: "demo-bucket".into(),
                rules: root.clone(),
            }]),
            default_bucket: "demo-bucket".into(),
            import: Some(seed),
            export_on_exit: Some(root.join("export")),
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
            minimum_functions: 1,
            launch: None,
        };
        Self { root, config }
    }
    fn files(&self) {
        let root = &self.config.state_dir;
        fs::create_dir_all(root.join("firestore")).unwrap();
        fs::create_dir_all(root.join("storage/objects")).unwrap();
        // Structural guard fixtures; real-format reopen is covered by core,
        // Auth, Storage and the process recovery tests, not these dummy bytes.
        for name in [
            "firestore/firenook.redb",
            "firestore/firenook.wal",
            "auth-state.json",
            "storage/metadata.json",
            "storage/metadata.redb",
        ] {
            fs::write(root.join(name), b"{}").unwrap();
        }
    }
    fn imported(&self) {
        let mut guard = NativeState::acquire(&self.config).unwrap();
        assert!(!guard.reusing());
        self.files();
        guard.complete().unwrap();
    }
}
impl Drop for Case {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn first_import_then_reopen_keeps_local_writes_and_allows_port_changes() {
    let mut case = Case::new();
    case.imported();
    let data = case.config.state_dir.join("auth-state.json");
    fs::write(&data, b"local changes after import").unwrap();
    case.config.ports.auth = 99;
    let guard = NativeState::acquire(&case.config).unwrap();
    assert!(guard.reusing());
    assert_eq!(fs::read(data).unwrap(), b"local changes after import");
}

#[test]
fn interrupted_import_and_unmanaged_data_are_never_overwritten() {
    let case = Case::new();
    drop(NativeState::acquire(&case.config).unwrap());
    case.files();
    assert!(NativeState::acquire(&case.config).is_err());
    fs::remove_file(case.config.state_dir.join(RECEIPT)).unwrap();
    assert!(NativeState::acquire(&case.config).is_err());
    assert!(case.config.state_dir.join("auth-state.json").exists());
}

#[test]
fn locks_are_exclusive_and_released_without_removing_the_inode() {
    let case = Case::new();
    case.imported();
    let guard = NativeState::acquire(&case.config).unwrap();
    assert!(NativeState::acquire(&case.config).is_err());
    drop(guard);
    assert!(NativeState::acquire(&case.config).unwrap().reusing());
    assert!(case.config.state_dir.join(LOCK).is_file());
}

#[test]
fn seed_change_even_at_same_length_refuses_resume() {
    let case = Case::new();
    case.imported();
    let seed = case.config.import.as_ref().unwrap().join("documents");
    let original = fs::read(&seed).unwrap();
    fs::write(&seed, vec![b'x'; original.len()]).unwrap();
    assert!(NativeState::acquire(&case.config).is_err());
    fs::write(&seed, original).unwrap();
    assert!(NativeState::acquire(&case.config).unwrap().reusing());
}

#[test]
fn seed_change_during_import_does_not_publish_complete() {
    let case = Case::new();
    let mut guard = NativeState::acquire(&case.config).unwrap();
    case.files();
    fs::write(
        case.config.import.as_ref().unwrap().join("documents"),
        "changed",
    )
    .unwrap();
    assert!(guard.complete().is_err());
    let receipt: Receipt =
        serde_json::from_slice(&fs::read(case.config.state_dir.join(RECEIPT)).unwrap()).unwrap();
    assert!(!receipt.complete);
}

#[test]
fn import_references_must_be_inside_the_fingerprinted_seed() {
    let case = Case::new();
    fs::write(
        case.config
            .import
            .as_ref()
            .unwrap()
            .join("firebase-export-metadata.json"),
        br#"{"auth":{"path":"../outside"}}"#,
    )
    .unwrap();
    assert!(NativeState::acquire(&case.config).is_err());
    assert!(!case.config.state_dir.exists());
}

#[test]
fn project_bucket_and_format_mismatches_are_rejected() {
    let case = Case::new();
    case.imported();
    let mut changed = case.config.clone();
    changed.project_id = "demo-wrong-project".into();
    assert!(NativeState::acquire(&changed).is_err());
    changed = case.config.clone();
    changed.default_bucket = "another-bucket".into();
    assert!(NativeState::acquire(&changed).is_err());
    let path = case.config.state_dir.join(RECEIPT);
    let mut receipt: Receipt = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    // In particular, the previous JSON-only Storage format must be rejected:
    // an older binary cannot safely read a transactional working directory.
    receipt.identity.format = 1;
    fs::write(path, serde_json::to_vec(&receipt).unwrap()).unwrap();
    assert!(NativeState::acquire(&case.config).is_err());
}

#[test]
fn every_required_state_file_must_exist_and_receipt_must_parse() {
    for file in [
        "firestore/firenook.redb",
        "firestore/firenook.wal",
        "auth-state.json",
        "storage/metadata.json",
        "storage/metadata.redb",
    ] {
        let case = Case::new();
        case.imported();
        fs::remove_file(case.config.state_dir.join(file)).unwrap();
        assert!(NativeState::acquire(&case.config).is_err(), "{file}");
    }
    let case = Case::new();
    case.imported();
    fs::write(case.config.state_dir.join(RECEIPT), b"{").unwrap();
    assert!(NativeState::acquire(&case.config).is_err());
}

#[test]
fn missing_seed_memory_mode_and_unmanaged_bypass_are_rejected() {
    let case = Case::new();
    case.imported();
    let mut changed = case.config.clone();
    changed.import = None;
    assert!(NativeState::acquire(&changed).is_err());
    changed = case.config.clone();
    changed.firestore_in_memory = true;
    assert!(NativeState::acquire(&changed).is_err());
    changed = case.config.clone();
    changed.resume_state = false;
    assert!(NativeState::acquire(&changed).is_err());
}

#[test]
fn exports_cannot_replace_seed_or_live_state_but_do_not_invalidate_resume() {
    let case = Case::new();
    case.imported();
    for destination in [
        case.root.clone(),
        case.config.state_dir.clone(),
        case.config.state_dir.join("export"),
        case.config.import.clone().unwrap(),
    ] {
        assert!(validate_export_destination(&case.config, &destination).is_err());
    }
    let destination = case.config.export_on_exit.as_ref().unwrap();
    assert!(validate_export_destination(&case.config, destination).is_ok());
    fs::create_dir(destination).unwrap();
    fs::write(destination.join("exported-local-changes"), b"preserved").unwrap();
    assert!(NativeState::acquire(&case.config).unwrap().reusing());
}

#[cfg(unix)]
#[test]
fn seed_symlinks_and_export_aliases_cannot_bypass_guards() {
    let case = Case::new();
    let alias = case.root.join("alias");
    std::os::unix::fs::symlink(case.config.import.as_ref().unwrap(), &alias).unwrap();
    assert!(validate_export_destination(&case.config, &alias).is_err());
    std::os::unix::fs::symlink(
        case.root.join("secret"),
        case.config.import.as_ref().unwrap().join("link"),
    )
    .unwrap();
    assert!(NativeState::acquire(&case.config).is_err());
}

fn refusal(config: &SuiteConfig) -> String {
    match NativeState::acquire(config) {
        Ok(_) => panic!("the saved state was picked up"),
        Err(error) => error.to_string(),
    }
}

#[test]
fn a_refusal_says_what_changed() {
    let case = Case::new();
    case.imported();
    let mut changed = case.config.clone();
    changed.project_id = "demo-wrong-project".into();
    assert!(
        refusal(&changed)
            .contains("it belongs to project demo-native-resume, not demo-wrong-project"),
        "{}",
        refusal(&changed)
    );
    let seed = case.config.import.clone().unwrap();
    fs::write(seed.join("documents"), "edited").unwrap();
    let edited = refusal(&case.config);
    assert!(
        edited.contains("changed after it was imported: 1 changed (documents)"),
        "{edited}"
    );
    assert!(edited.contains("existing data preserved"), "{edited}");
    assert!(
        edited.contains("firenook state:adopt-seed --state-dir"),
        "{edited}"
    );
    fs::write(seed.join("added.json"), "{}").unwrap();
    fs::remove_file(seed.join("documents")).unwrap();
    let both = refusal(&case.config);
    assert!(both.contains("1 added (added.json)"), "{both}");
    assert!(both.contains("1 removed (documents)"), "{both}");
}

fn seed_file(case: &Case, name: &str) -> PathBuf {
    case.config.import.as_ref().unwrap().join(name)
}

fn record(case: &Case) -> serde_json::Value {
    serde_json::from_slice(&fs::read(case.config.state_dir.join("native-seed.json")).unwrap())
        .unwrap()
}

#[test]
fn files_the_operating_system_writes_never_block_a_start() {
    let case = Case::new();
    case.imported();
    let seed = case.config.import.clone().unwrap();
    fs::write(seed.join(".DS_Store"), b"finder").unwrap();
    fs::write(seed.join("._documents"), b"apple double").unwrap();
    fs::write(seed.join("Thumbs.db"), b"windows").unwrap();
    fs::create_dir(seed.join("__MACOSX")).unwrap();
    fs::write(seed.join("__MACOSX/anything"), b"zip").unwrap();
    assert!(NativeState::acquire(&case.config).unwrap().reusing());
    // A changed Finder file still changes nothing.
    fs::write(seed.join(".DS_Store"), b"finder, rewritten").unwrap();
    assert!(NativeState::acquire(&case.config).unwrap().reusing());
}

#[test]
fn the_record_lists_the_seed_without_the_operating_system_files() {
    let case = Case::new();
    fs::write(seed_file(&case, ".DS_Store"), b"finder").unwrap();
    case.imported();
    let saved = record(&case);
    let paths = saved["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file[0].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(paths, ["documents", "firebase-export-metadata.json"]);
    let receipt: Receipt =
        serde_json::from_slice(&fs::read(case.config.state_dir.join(RECEIPT)).unwrap()).unwrap();
    // The receipt keeps the fingerprint earlier engines compute: over every
    // file, the Finder one included.
    assert_eq!(saved["seedSha256"], receipt.identity.seed_sha256.as_str());
    assert_eq!(receipt.identity.seed_sha256.len(), 64);
}

#[test]
fn a_touched_but_unchanged_file_is_read_once_and_then_trusted() {
    let case = Case::new();
    case.imported();
    let documents = seed_file(&case, "documents");
    let before = record(&case);
    let original = fs::read(&documents).unwrap();
    fs::write(&documents, &original).unwrap();
    assert!(NativeState::acquire(&case.config).unwrap().reusing());
    let after = record(&case);
    assert_ne!(before["recordedAt"], after["recordedAt"]);
    let entry = |saved: &serde_json::Value| {
        saved["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|file| file[0] == "documents")
            .unwrap()
            .clone()
    };
    // Same contents, so the same hash, with the new times recorded.
    assert_eq!(entry(&before)[4], entry(&after)[4]);
    assert!(NativeState::acquire(&case.config).unwrap().reusing());
}

#[cfg(unix)]
#[test]
fn a_copy_that_keeps_the_modification_time_is_still_caught() {
    let case = Case::new();
    case.imported();
    let documents = seed_file(&case, "documents");
    let modified = fs::metadata(&documents).unwrap().modified().unwrap();
    let length = fs::metadata(&documents).unwrap().len();
    fs::write(&documents, vec![b'x'; usize::try_from(length).unwrap()]).unwrap();
    File::options()
        .write(true)
        .open(&documents)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    assert_eq!(
        fs::metadata(&documents).unwrap().modified().unwrap(),
        modified
    );
    let refused = refusal(&case.config);
    assert!(refused.contains("1 changed (documents)"), "{refused}");
}

/// The seed earlier engines fingerprinted as `d0f6…ae5b`: the same files in
/// the same order (a folder where its name sorts among the files) give the
/// same fingerprint, so data either engine saved stays readable by both.
fn earlier_engine_seed(case: &Case) -> PathBuf {
    let seed = case.config.import.clone().unwrap();
    fs::write(seed.join("a.txt"), "one").unwrap();
    fs::create_dir(seed.join("a")).unwrap();
    fs::write(seed.join("a/b"), "two").unwrap();
    fs::create_dir(seed.join("storage")).unwrap();
    fs::write(seed.join("storage/c"), "three").unwrap();
    seed
}

const EARLIER_PLAIN: &str = "d0f68591e0bafb67b54bfabbae6fed230a7410431e0348f50cc70ab7aaf6ae5b";
const EARLIER_WITH_FINDER: &str =
    "3641968649e16da5f999d522d9ea10df917fcab0924b20e5a5d868a25a27346c";

fn saved_by_an_earlier_engine(case: &Case, fingerprint: &str) {
    case.imported();
    let path = case.config.state_dir.join(RECEIPT);
    let mut receipt: Receipt = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    receipt.identity.seed_sha256 = fingerprint.to_owned();
    fs::write(&path, serde_json::to_vec(&receipt).unwrap()).unwrap();
    fs::remove_file(case.config.state_dir.join("native-seed.json")).unwrap();
}

#[test]
fn the_whole_seed_fingerprint_matches_earlier_engines() {
    let case = Case::new();
    let seed = earlier_engine_seed(&case);
    let found = seed::scan(&seed).unwrap();
    let hashed = seed::hash_all(&seed, &found, &AtomicBool::new(false), true).unwrap();
    assert_eq!(hashed.whole, EARLIER_PLAIN);
    assert_eq!(hashed.whole_without_junk, EARLIER_PLAIN);
    fs::write(seed.join(".DS_Store"), "finder").unwrap();
    fs::write(seed.join("storage/.DS_Store"), "finder2").unwrap();
    let found = seed::scan(&seed).unwrap();
    let hashed = seed::hash_all(&seed, &found, &AtomicBool::new(false), true).unwrap();
    assert_eq!(hashed.whole, EARLIER_WITH_FINDER);
    assert_eq!(hashed.whole_without_junk, EARLIER_PLAIN);
    case.imported();
    let receipt: Receipt =
        serde_json::from_slice(&fs::read(case.config.state_dir.join(RECEIPT)).unwrap()).unwrap();
    assert_eq!(receipt.identity.seed_sha256, EARLIER_WITH_FINDER);
}

#[test]
fn data_an_earlier_engine_saved_is_checked_once_then_recorded() {
    let case = Case::new();
    earlier_engine_seed(&case);
    saved_by_an_earlier_engine(&case, EARLIER_PLAIN);
    assert!(NativeState::acquire(&case.config).unwrap().reusing());
    assert_eq!(record(&case)["seedSha256"], EARLIER_PLAIN);
    // The record carries the next start.
    fs::write(seed_file(&case, ".DS_Store"), "finder").unwrap();
    assert!(NativeState::acquire(&case.config).unwrap().reusing());
}

#[test]
fn an_earlier_fingerprint_is_accepted_with_finder_files_added_since() {
    let case = Case::new();
    earlier_engine_seed(&case);
    fs::write(seed_file(&case, ".DS_Store"), "finder").unwrap();
    fs::write(seed_file(&case, "storage/.DS_Store"), "finder2").unwrap();
    // Imported without them, by an earlier engine.
    saved_by_an_earlier_engine(&case, EARLIER_PLAIN);
    assert!(NativeState::acquire(&case.config).unwrap().reusing());
    // Imported with them, and they are unchanged.
    let case = Case::new();
    earlier_engine_seed(&case);
    fs::write(seed_file(&case, ".DS_Store"), "finder").unwrap();
    fs::write(seed_file(&case, "storage/.DS_Store"), "finder2").unwrap();
    saved_by_an_earlier_engine(&case, EARLIER_WITH_FINDER);
    assert!(NativeState::acquire(&case.config).unwrap().reusing());
}

#[test]
fn an_earlier_fingerprint_that_cannot_be_proven_points_to_adopting() {
    let case = Case::new();
    earlier_engine_seed(&case);
    fs::write(seed_file(&case, ".DS_Store"), "finder").unwrap();
    fs::write(seed_file(&case, "storage/.DS_Store"), "finder2").unwrap();
    saved_by_an_earlier_engine(&case, EARLIER_WITH_FINDER);
    // Finder rewrote its file: the old contents are gone, so nothing can
    // prove the rest of the seed unchanged.
    fs::write(seed_file(&case, ".DS_Store"), "finder, rewritten").unwrap();
    let refused = refusal(&case.config);
    assert!(
        refused.contains("kept one fingerprint for the whole seed"),
        "{refused}"
    );
    assert!(
        refused.contains("the seed holds .DS_Store, which Finder writes"),
        "{refused}"
    );
    assert!(refused.contains("firenook state:adopt-seed"), "{refused}");
    assert!(!case.config.state_dir.join("native-seed.json").exists());
}

#[test]
fn a_record_from_another_receipt_is_ignored() {
    let case = Case::new();
    case.imported();
    let path = case.config.state_dir.join("native-seed.json");
    let mut saved = record(&case);
    saved["seedSha256"] = "0".repeat(64).into();
    // It lists no files: trusted, it would call every file added.
    saved["files"] = serde_json::json!([]);
    fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
    assert!(NativeState::acquire(&case.config).unwrap().reusing());
    assert_ne!(record(&case)["seedSha256"], "0".repeat(64).as_str());
}

#[test]
fn adopting_the_seed_keeps_the_data_and_the_previous_receipt() {
    let case = Case::new();
    case.imported();
    let data = case.config.state_dir.join("auth-state.json");
    fs::write(&data, b"local changes").unwrap();
    fs::write(seed_file(&case, "documents"), "edited on purpose").unwrap();
    assert!(NativeState::acquire(&case.config).is_err());
    let seed = case.config.import.clone().unwrap();
    // Not while another Firenook holds the data, nor half imported.
    let held = File::options()
        .write(true)
        .open(case.config.state_dir.join(LOCK))
        .unwrap();
    held.try_lock().unwrap();
    assert!(adopt_seed(&case.config.state_dir, &seed).is_err());
    drop(held);
    let adopted = adopt_seed(&case.config.state_dir, &seed).unwrap();
    assert_eq!(adopted.files, 2);
    assert!(adopted.backup.is_file());
    assert!(NativeState::acquire(&case.config).unwrap().reusing());
    assert_eq!(fs::read(data).unwrap(), b"local changes");
    let incomplete = Case::new();
    drop(NativeState::acquire(&incomplete.config).unwrap());
    let seed = incomplete.config.import.clone().unwrap();
    assert!(adopt_seed(&incomplete.config.state_dir, &seed).is_err());
}
