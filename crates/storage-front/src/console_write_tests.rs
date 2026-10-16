//! The console's write half: one write path shared with the protocol, bulk
//! batches (atomic, one event and one transaction each, cancellable, with
//! backpressure), moves that survive a crash, copies that never tear a
//! read, export streams, sessions, events sent again, and clearing.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use firenook_functions_bridge::{TriggerObserver, TriggerRegistry};
use tokio::sync::broadcast::error::TryRecvError;
use tower::ServiceExt as _;

use super::*;

const PROJECT: &str = "demo-console-writes";
const BUCKET: &str = "demo-console-writes.appspot.com";

struct Harness {
    runtime: StorageRuntime,
    root: PathBuf,
    dispatches: tokio::sync::mpsc::UnboundedReceiver<DispatchRequest>,
    /// The hub's background-trigger switch.
    registry: TriggerRegistry,
}

struct Setup<'a> {
    label: &'a str,
    rules: Option<&'a str>,
    functions: bool,
    durability: StorageDurability,
    root: Option<PathBuf>,
}

impl<'a> Setup<'a> {
    fn new(label: &'a str) -> Self {
        Self {
            label,
            rules: None,
            functions: true,
            durability: StorageDurability::PerCommit,
            root: None,
        }
    }
}

async fn start(setup: Setup<'_>) -> Harness {
    let root = setup.root.unwrap_or_else(|| {
        std::env::temp_dir().join(format!(
            "firenook-writes-{}-{}-{}",
            setup.label,
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        ))
    });
    let registry = TriggerRegistry::default();
    let (observer, dispatches) = TriggerObserver::channel(registry.clone());
    let runtime = StorageRuntime::start_with(
        StorageConfig {
            project: PROJECT.to_owned(),
            origin: "http://127.0.0.1:21002".to_owned(),
            data_dir: root.clone(),
            rules: setup.rules.map(|source| NativeRulesConfig {
                source: RulesSource::Single(RulesFile {
                    name: "storage.rules".to_owned(),
                    content: source.to_owned(),
                }),
                documents: Arc::new(NoFirestoreDocuments),
            }),
            durability: setup.durability,
        },
        StorageOptions {
            functions: setup.functions,
            diagnostics: true,
            ..StorageOptions::default()
        },
        observer.queue(),
        registry.clone(),
    )
    .await
    .expect("Storage runtime");
    Harness {
        runtime,
        root,
        dispatches,
        registry,
    }
}

impl Harness {
    async fn finish(self) {
        let Self { runtime, root, .. } = self;
        runtime.shutdown().await.expect("shutdown");
        let _ = std::fs::remove_dir_all(root);
    }

    fn console(&self) -> StorageConsoleApi {
        self.runtime.console()
    }

    /// Uploads `body` as Admin through the console's upload.
    async fn upload(&self, name: &str, body: &[u8]) -> ObjectView {
        self.console()
            .upload(
                ConsoleUpload {
                    bucket: BUCKET.to_owned(),
                    name: name.to_owned(),
                    content_type: Some("text/plain".to_owned()),
                    console: true,
                    ..ConsoleUpload::default()
                },
                Body::from(body.to_vec()),
                &Identity::Admin,
            )
            .await
            .expect("upload")
    }

    /// Puts many small objects with their bytes on disk, fast.
    fn seed(&self, names: impl IntoIterator<Item = String>) {
        let state = &self.runtime.state;
        let mut data = lock(&state.inner);
        for name in names {
            let data_file = format!("objects/{}", stable_id(&[BUCKET, &name]));
            std::fs::write(state.config.data_dir.join(&data_file), name.as_bytes()).expect("bytes");
            let mut object = crate::console_read_tests::object(&name, name.len() as u64);
            object.bucket = BUCKET.to_owned();
            object.data_file = data_file;
            object.generation = generation(&mut data);
            data.put(object, &ChangeContext::system());
        }
        state.metadata.replace(&data).expect("persisted");
    }

    fn drain(&mut self) -> usize {
        let mut count = 0;
        while self.dispatches.try_recv().is_ok() {
            count += 1;
        }
        count
    }

    fn names(&self) -> Vec<String> {
        lock(&self.runtime.state.inner)
            .objects
            .values()
            .map(|object| object.name.clone())
            .collect()
    }

    async fn bytes_of(&self, name: &str) -> Vec<u8> {
        let response = self
            .console()
            .media(
                BUCKET,
                name,
                None,
                &axum::http::HeaderMap::new(),
                MediaMode::Inline,
            )
            .await
            .expect("media");
        to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("bytes")
            .to_vec()
    }
}

/// A bulk progress that records everything and cancels on request.
#[derive(Default)]
struct Recorder {
    done: AtomicU64,
    skipped: AtomicU64,
    failures: StdMutex<Vec<(String, String, Option<ConsoleRefusal>)>>,
    cancel: AtomicBool,
    /// Cancels once this many files are done.
    cancel_at: Option<u64>,
}

impl BulkProgress for Recorder {
    fn done(&self, by: u64) {
        let done = self.done.fetch_add(by, Ordering::SeqCst) + by;
        if self.cancel_at.is_some_and(|at| done >= at) {
            self.cancel.store(true, Ordering::SeqCst);
        }
    }

    fn skipped(&self, by: u64) {
        self.skipped.fetch_add(by, Ordering::SeqCst);
    }

    fn failed(&self, name: &str, message: &str, refusal: Option<&ConsoleRefusal>) {
        lock(&self.failures).push((name.to_owned(), message.to_owned(), refusal.cloned()));
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

fn request(verb: BulkVerb, keys: &[&str]) -> BulkRequest {
    BulkRequest {
        verb,
        bucket: BUCKET.to_owned(),
        source: BulkSource::Keys(keys.iter().map(|key| (*key).to_owned()).collect()),
        destination: None,
        rename_to: None,
        metadata: None,
        on_conflict: ConflictPolicy::Skip,
        console: true,
    }
}

#[allow(
    clippy::unnecessary_wraps,
    reason = "the request field it fills is an Option"
)]
fn into(folder: &str) -> Option<Destination> {
    Some(Destination {
        bucket: BUCKET.to_owned(),
        prefix: folder.to_owned(),
    })
}

#[test]
fn update_many_is_atomic() {
    let root = std::env::temp_dir().join(format!(
        "firenook-writes-atomic-{}-{}",
        std::process::id(),
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    std::fs::create_dir_all(&root).expect("root");
    write_json_atomic(&root.join("metadata.json"), &StorageData::default()).expect("seed");
    let write_behind = StorageDurability::WriteBehind {
        interval: Duration::from_secs(3_600),
    };
    let names = |data: &StorageData| {
        let mut names = data
            .objects
            .values()
            .map(|object| object.name.clone())
            .collect::<Vec<_>>();
        names.sort();
        names
    };
    let journal = root.join("metadata.journal");
    let backup = root.join("durable.redb");
    let (line, batch_line) = {
        let (store, mut data) = metadata::MetadataStore::open(&root, write_behind).expect("open");
        for index in 0..3 {
            let object = crate::console_read_tests::object(&format!("keep/{index}.txt"), 1);
            data.objects
                .insert(object_key(&object.bucket, &object.name), object);
        }
        store.replace(&data).expect("durable base");
        // What a power loss leaves of redb: the last durable commit.
        std::fs::copy(root.join("metadata.redb"), &backup).expect("backup");
        let single = crate::console_read_tests::object("single.txt", 1);
        let single_key = object_key(&single.bucket, &single.name);
        data.objects.insert(single_key.clone(), single);
        store
            .update_many(&data, &[metadata::Change::Object(&single_key)])
            .expect("one change");
        let keys = (0..3)
            .map(|index| {
                object_key(
                    &crate::console_read_tests::object("x", 0).bucket,
                    &format!("keep/{index}.txt"),
                )
            })
            .collect::<Vec<_>>();
        for key in &keys {
            data.objects.remove(key);
        }
        let changes = keys
            .iter()
            .map(|key| metadata::Change::Object(key))
            .collect::<Vec<_>>();
        store.update_many(&data, &changes).expect("one batch");
        let written = std::fs::read_to_string(&journal).expect("journal");
        let lines = written.lines().map(str::to_owned).collect::<Vec<_>>();
        assert_eq!(lines.len(), 2, "{written}");
        assert!(
            lines[0].contains("\"table\":\"objects\""),
            "a single change keeps its line"
        );
        assert!(lines[1].contains("\"changes\":["), "a batch is one line");
        (lines[0].clone(), lines[1].clone())
    };
    let crash = |journal_text: String| {
        std::fs::copy(&backup, root.join("metadata.redb")).expect("restore");
        std::fs::write(&journal, journal_text).expect("journal");
        let (_, data) = metadata::MetadataStore::open(&root, write_behind).expect("reopen");
        names(&data)
    };
    // A torn last line applies none of its batch; the line before replays.
    let torn = &batch_line[..batch_line.len() / 2];
    assert_eq!(
        crash(format!("{line}\n{torn}")),
        ["keep/0.txt", "keep/1.txt", "keep/2.txt", "single.txt"]
    );
    // A whole batch line applies whole.
    assert_eq!(crash(format!("{line}\n{batch_line}\n")), ["single.txt"]);
    std::fs::remove_dir_all(&root).expect("cleanup");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_transaction_per_batch_and_one_event() {
    let harness = start(Setup {
        durability: StorageDurability::WriteBehind {
            interval: Duration::from_secs(3_600),
        },
        functions: false,
        ..Setup::new("batches")
    })
    .await;
    harness.seed((0..1_000).map(|index| format!("many/{index:04}.txt")));
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut events = harness.console().subscribe();
    let recorder = Recorder::default();
    harness
        .console()
        .bulk(
            request(BulkVerb::Delete, &["many/"]),
            Identity::Admin,
            &recorder,
        )
        .await
        .expect("delete");
    assert_eq!(recorder.done.load(Ordering::SeqCst), 1_000);
    let journal = std::fs::read_to_string(harness.root.join("metadata.journal")).expect("journal");
    assert_eq!(journal.lines().count(), 5, "five batches of 200");
    let mut committed = 0;
    loop {
        match events.try_recv() {
            Ok(ChangeEvent::Committed { touches, .. }) => {
                assert_eq!(touches.len(), 200);
                committed += 1;
            }
            Ok(other) => panic!("{other:?}"),
            Err(TryRecvError::Empty) => break,
            Err(error) => panic!("{error}"),
        }
    }
    assert_eq!(committed, 5);
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[allow(clippy::too_many_lines, reason = "one story, told in order")]
async fn work_does_not_deadlock_with_protocol_writers() {
    let harness = start(Setup {
        functions: false,
        ..Setup::new("deadlock")
    })
    .await;
    harness.seed((0..2_000).map(|index| format!("del/{index:04}.txt")));
    harness.seed((0..2_000).map(|index| format!("mov/{index:04}.txt")));
    harness.seed((0..2_000).map(|index| format!("meta/{index:04}.txt")));
    let console = harness.console();
    let writers = (0..4)
        .map(|writer| {
            let router = harness.runtime.application();
            tokio::spawn(async move {
                for file in 0..40 {
                    let name = format!("app/w{writer}-{file}.txt");
                    let upload = router
                        .clone()
                        .oneshot(
                            Request::builder()
                                .method(Method::POST)
                                .uri(format!(
                                    "/upload/storage/v1/b/{BUCKET}/o?uploadType=media&name={}",
                                    crate::percent_encode(&name)
                                ))
                                .header(header::AUTHORIZATION, "Bearer owner")
                                .body(Body::from("x"))
                                .expect("request"),
                        )
                        .await
                        .expect("response");
                    assert_eq!(upload.status(), StatusCode::OK);
                    let patch = router
                        .clone()
                        .oneshot(
                            Request::builder()
                                .method(Method::PATCH)
                                .uri(format!(
                                    "/storage/v1/b/{BUCKET}/o/{}",
                                    crate::percent_encode(&name)
                                ))
                                .header(header::CONTENT_TYPE, "application/json")
                                .body(Body::from("{\"cacheControl\":\"no-store\"}"))
                                .expect("request"),
                        )
                        .await
                        .expect("response");
                    assert_eq!(patch.status(), StatusCode::OK);
                    let delete = router
                        .clone()
                        .oneshot(
                            Request::builder()
                                .method(Method::DELETE)
                                .uri(format!(
                                    "/storage/v1/b/{BUCKET}/o/{}",
                                    crate::percent_encode(&name)
                                ))
                                .body(Body::empty())
                                .expect("request"),
                        )
                        .await
                        .expect("response");
                    assert_eq!(delete.status(), StatusCode::NO_CONTENT);
                }
            })
        })
        .collect::<Vec<_>>();
    let work = async {
        let deleted = Recorder::default();
        let moved = Recorder::default();
        let patched = Recorder::default();
        let mut moving = request(BulkVerb::Move, &["mov/"]);
        moving.destination = into("moved/");
        let mut patching = request(BulkVerb::Metadata, &["meta/"]);
        patching.metadata = Some(MetadataPatch {
            cache_control: Some(Some("public, max-age=60".to_owned())),
            ..MetadataPatch::default()
        });
        let (a, b, c) = tokio::join!(
            console.bulk(
                request(BulkVerb::Delete, &["del/"]),
                Identity::Admin,
                &deleted
            ),
            console.bulk(moving, Identity::Admin, &moved),
            console.bulk(patching, Identity::Admin, &patched),
        );
        a.expect("delete");
        b.expect("move");
        c.expect("metadata");
        for writer in writers {
            writer.await.expect("writer");
        }
        (
            deleted.done.load(Ordering::SeqCst),
            moved.done.load(Ordering::SeqCst),
            patched.done.load(Ordering::SeqCst),
        )
    };
    let counts = tokio::time::timeout(Duration::from_secs(10), Box::pin(work))
        .await
        .expect("everything completes within 10 s");
    assert_eq!(counts, (2_000, 2_000, 2_000));
    let names = harness.names();
    assert!(
        names
            .iter()
            .all(|name| !name.starts_with("del/") && !name.starts_with("mov/"))
    );
    assert_eq!(
        names
            .iter()
            .filter(|name| name.starts_with("moved/"))
            .count(),
        2_000
    );
    assert!(names.iter().all(|name| !name.starts_with("app/")));
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_is_atomic_across_a_crash() {
    for (point, label) in [
        (bulk::crash::AFTER_LINK, "link"),
        (bulk::crash::AFTER_COMMIT, "commit"),
    ] {
        let harness = start(Setup {
            functions: false,
            ..Setup::new(label)
        })
        .await;
        let root = harness.root.clone();
        let source = harness.upload("from/big.bin", &[7_u8; 4096]).await;
        let mut moving = request(BulkVerb::Move, &["from/big.bin"]);
        moving.destination = into("to/");
        bulk::crash::set(point);
        let result = harness
            .console()
            .bulk(moving, Identity::Admin, &Recorder::default())
            .await;
        assert!(result.is_err(), "the crash the test asked for");
        let Harness { runtime, .. } = harness;
        runtime.shutdown().await.expect("shutdown");
        let reopened = start(Setup {
            root: Some(root.clone()),
            functions: false,
            ..Setup::new(label)
        })
        .await;
        let names = reopened.names();
        // No record ever points at a missing file.
        reopened
            .runtime
            .checkpoint_native_state()
            .expect("every record has its bytes");
        let staged = std::fs::read_dir(root.join("uploads"))
            .expect("uploads")
            .count();
        assert_eq!(staged, 0, "{label}: no orphan link is left staged");
        if point == bulk::crash::AFTER_LINK {
            assert_eq!(names, ["from/big.bin"], "the source is whole");
            assert_eq!(reopened.bytes_of("from/big.bin").await, vec![7_u8; 4096]);
            assert_eq!(
                reopened
                    .console()
                    .stored(BUCKET, "from/big.bin")
                    .expect("source")
                    .md5_hash,
                source.md5_hash
            );
        } else {
            assert_eq!(
                names,
                ["to/big.bin"],
                "the destination is whole, the source gone"
            );
            assert_eq!(reopened.bytes_of("to/big.bin").await, vec![7_u8; 4096]);
        }
        reopened.finish().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn copy_never_tears_a_read() {
    let harness = start(Setup {
        functions: false,
        ..Setup::new("tear")
    })
    .await;
    harness
        .upload("src/big.bin", &vec![1_u8; 2 * 1024 * 1024])
        .await;
    let old = harness
        .upload("dst/big.bin", &vec![2_u8; 1024 * 1024])
        .await;
    let new_md5 = harness
        .console()
        .stored(BUCKET, "src/big.bin")
        .expect("source")
        .md5_hash;
    let stop = Arc::new(AtomicBool::new(false));
    let reader = {
        let console = harness.console();
        let stop = Arc::clone(&stop);
        let old_md5 = old.md5_hash.clone();
        let new_md5 = new_md5.clone();
        tokio::spawn(async move {
            let mut reads = 0;
            while !stop.load(Ordering::SeqCst) {
                let stored = console.stored(BUCKET, "dst/big.bin").expect("destination");
                let response = console
                    .media(
                        BUCKET,
                        "dst/big.bin",
                        None,
                        &axum::http::HeaderMap::new(),
                        MediaMode::Inline,
                    )
                    .await
                    .expect("media");
                let bytes = to_bytes(response.into_body(), usize::MAX)
                    .await
                    .expect("bytes");
                let md5 = {
                    use base64::Engine as _;
                    use md5::Digest as _;
                    crate::BASE64.encode(md5::Md5::digest(&bytes))
                };
                // Bytes and the record read just before agree, or the record
                // moved on between the two reads (never a mix of both files).
                assert!(md5 == old_md5 || md5 == new_md5, "a torn read");
                assert!(stored.md5_hash == old_md5 || stored.md5_hash == new_md5);
                reads += 1;
                tokio::task::yield_now().await;
            }
            reads
        })
    };
    let mut copying = request(BulkVerb::Copy, &["src/big.bin"]);
    copying.destination = into("dst/");
    copying.on_conflict = ConflictPolicy::Replace;
    let recorder = Recorder::default();
    harness
        .console()
        .bulk(copying, Identity::Admin, &recorder)
        .await
        .expect("copy");
    tokio::time::sleep(Duration::from_millis(50)).await;
    stop.store(true, Ordering::SeqCst);
    assert!(reader.await.expect("reader") > 0);
    let copied = harness
        .console()
        .stored(BUCKET, "dst/big.bin")
        .expect("copy");
    assert_eq!(copied.md5_hash, new_md5);
    assert_eq!(
        harness.bytes_of("dst/big.bin").await,
        vec![1_u8; 2 * 1024 * 1024]
    );
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_move_copy_metadata() {
    let mut harness = start(Setup::new("verbs")).await;
    let original = harness.upload("docs/a.txt", b"alpha").await;
    harness.upload("docs/b.txt", b"bravo").await;
    harness.drain();
    let console = harness.console();
    // Copy: a new file with one new token and the same metadata.
    let mut copying = request(BulkVerb::Copy, &["docs/a.txt"]);
    copying.rename_to = Some("docs/a copy.txt".to_owned());
    console
        .bulk(copying, Identity::Admin, &Recorder::default())
        .await
        .expect("copy");
    let copy = console
        .object(BUCKET, "docs/a copy.txt", &Identity::Admin, true)
        .await
        .expect("copy");
    assert_eq!(copy.download_tokens.len(), 1);
    assert_ne!(
        copy.download_tokens, original.download_tokens,
        "a copy mints its own token"
    );
    assert_eq!(copy.metageneration, 1);
    assert_eq!(copy.content_type.as_deref(), Some("text/plain"));
    assert_eq!(harness.bytes_of("docs/a copy.txt").await, b"alpha");
    assert_eq!(harness.drain(), 2, "finalized, v1 and v2");
    // Move: the tokens go with the object; finalize then delete.
    let mut moving = request(BulkVerb::Move, &["docs/"]);
    moving.destination = into("archive/");
    let recorder = Recorder::default();
    console
        .bulk(moving, Identity::Admin, &recorder)
        .await
        .expect("move");
    assert_eq!(recorder.done.load(Ordering::SeqCst), 3);
    let moved = console
        .object(BUCKET, "archive/docs/a.txt", &Identity::Admin, true)
        .await
        .expect("moved");
    assert_eq!(moved.download_tokens, original.download_tokens);
    assert!(moved.generation > original.generation);
    assert!(console.stored(BUCKET, "docs/a.txt").is_none());
    assert_eq!(
        harness.drain(),
        3 * 4,
        "finalized and deleted per object, v1 and v2"
    );
    // Metadata: patch semantics.
    let mut patching = request(BulkVerb::Metadata, &["archive/docs/a.txt"]);
    patching.metadata = Some(MetadataPatch {
        content_type: Some(None),
        custom_metadata: Some(std::collections::BTreeMap::from([(
            "ownerUid".to_owned(),
            Some("u1".to_owned()),
        )])),
        ..MetadataPatch::default()
    });
    console
        .bulk(patching, Identity::Admin, &Recorder::default())
        .await
        .expect("metadata");
    let patched = console
        .stored(BUCKET, "archive/docs/a.txt")
        .expect("patched");
    assert_eq!(patched.content_type, None);
    assert_eq!(patched.custom_metadata["ownerUid"], "u1");
    assert_eq!(patched.metageneration, 2);
    assert_eq!(harness.drain(), 2);
    // Delete: records, bytes and events.
    let data_file = harness.root.join(&patched.data_file);
    assert!(data_file.exists());
    console
        .bulk(
            request(BulkVerb::Delete, &["archive/"]),
            Identity::Admin,
            &Recorder::default(),
        )
        .await
        .expect("delete");
    assert!(!data_file.exists());
    assert_eq!(harness.names(), Vec::<String>::new());
    assert_eq!(harness.drain(), 3 * 2);
    harness.finish().await;
}

#[tokio::test]
async fn conflicts_and_skips() {
    let harness = start(Setup {
        functions: false,
        ..Setup::new("conflicts")
    })
    .await;
    for name in ["a/one.txt", "a/two.txt", "b/one.txt"] {
        harness.upload(name, name.as_bytes()).await;
    }
    let console = harness.console();
    // A folder copied into another keeps its own name there: no conflict.
    let mut folder_copy = request(BulkVerb::Copy, &["a/"]);
    folder_copy.destination = into("b/");
    let preview = console.bulk_preview(&folder_copy).expect("preview");
    assert_eq!(preview.conflicts, 0);
    assert_eq!(preview.objects, 2);
    let mut into_root = request(BulkVerb::Copy, &["a/one.txt", "a/two.txt"]);
    into_root.destination = into("b/");
    let preview = console.bulk_preview(&into_root).expect("preview");
    assert_eq!(preview.conflicts, 1);
    assert_eq!(preview.conflict_sample, ["b/one.txt"]);
    let skipping = Recorder::default();
    console
        .bulk(into_root.clone(), Identity::Admin, &skipping)
        .await
        .expect("skip");
    assert_eq!(skipping.skipped.load(Ordering::SeqCst), 1);
    assert_eq!(skipping.done.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness.bytes_of("b/one.txt").await,
        b"b/one.txt",
        "left as it was"
    );
    let failing = Recorder::default();
    into_root.on_conflict = ConflictPolicy::Fail;
    console
        .bulk(into_root.clone(), Identity::Admin, &failing)
        .await
        .expect("fail");
    let failures = lock(&failing.failures).clone();
    assert_eq!(failures.len(), 2, "both names are taken now");
    assert_eq!(failures[0].1, "b/one.txt already exists.");
    into_root.on_conflict = ConflictPolicy::Replace;
    console
        .bulk(into_root, Identity::Admin, &Recorder::default())
        .await
        .expect("replace");
    assert_eq!(harness.bytes_of("b/one.txt").await, b"a/one.txt");
    let refused = console.bulk_preview(&{
        let mut into_itself = request(BulkVerb::Move, &["a/"]);
        into_itself.destination = into("a/inside/");
        into_itself
    });
    assert_eq!(
        refused,
        Err(ConsoleError::Invalid(
            "Cannot move a/ into itself.".to_owned()
        ))
    );
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatch_backpressure() {
    let harness = start(Setup::new("backpressure")).await;
    harness.seed((0..30_000).map(|index| format!("bp/{index:05}.txt")));
    let recorder = Arc::new(Recorder::default());
    let console = harness.console();
    let job = {
        let recorder = Arc::clone(&recorder);
        tokio::spawn(async move {
            console
                .bulk(
                    request(BulkVerb::Delete, &["bp/"]),
                    Identity::Admin,
                    recorder.as_ref(),
                )
                .await
        })
    };
    // The test's receiver never takes from the queue's count: delivery is
    // stalled, so the work must stop near the limit.
    let queue = harness.runtime.state.queue.clone();
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while queue.depth() < QUEUE_LIMIT {
        assert!(
            std::time::Instant::now() < deadline,
            "the work never filled the queue"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        queue.depth() <= QUEUE_LIMIT + 2 * BULK_BATCH,
        "{}",
        queue.depth()
    );
    let done = recorder.done.load(Ordering::SeqCst);
    assert!(done < 30_000, "it waited instead of finishing ({done})");
    recorder.cancel.store(true, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(5), job)
        .await
        .expect("cancel ends the wait")
        .expect("joined")
        .expect("no error");
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_stops_between_batches() {
    let harness = start(Setup {
        functions: false,
        ..Setup::new("cancel")
    })
    .await;
    harness.seed((0..1_000).map(|index| format!("c/{index:04}.txt")));
    let recorder = Recorder {
        cancel_at: Some(1),
        ..Recorder::default()
    };
    harness
        .console()
        .bulk(
            request(BulkVerb::Delete, &["c/"]),
            Identity::Admin,
            &recorder,
        )
        .await
        .expect("cancelled cleanly");
    assert_eq!(
        recorder.done.load(Ordering::SeqCst),
        BULK_BATCH as u64,
        "one batch, then the stop"
    );
    assert_eq!(harness.names().len(), 1_000 - BULK_BATCH);
    harness.runtime.flush().await.expect("flush");
    let before = harness.runtime.object_count();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(harness.runtime.object_count(), before, "no write after it");
    harness.finish().await;
}

const RULES: &str = "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /users/{uid}/{file=**} {\n      allow read, write: if request.auth != null && request.auth.uid == uid;\n    }\n  }\n}\n";

fn token(uid: &str) -> String {
    use base64::Engine as _;
    format!(
        "Bearer {}.{}.",
        crate::URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#),
        crate::URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({ "user_id": uid, "sub": uid })).expect("claims")
        )
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn client_identity_is_judged_per_item() {
    let harness = start(Setup {
        rules: Some(RULES),
        functions: false,
        ..Setup::new("client")
    })
    .await;
    for name in ["users/ada/a.txt", "users/ada/b.txt", "users/bob/c.txt"] {
        harness.upload(name, b"x").await;
    }
    let recorder = Recorder::default();
    let ada = Identity::Client {
        authorization: Some(token("ada")),
    };
    harness
        .console()
        .bulk(request(BulkVerb::Delete, &["users/"]), ada, &recorder)
        .await
        .expect("delete");
    assert_eq!(recorder.done.load(Ordering::SeqCst), 2);
    let failures = lock(&recorder.failures).clone();
    assert_eq!(failures.len(), 1);
    let (name, message, refusal) = &failures[0];
    assert_eq!(name, "users/bob/c.txt");
    assert_eq!(message, "Permission denied. No WRITE permission.");
    let refusal = refusal.as_ref().expect("explained");
    assert!(refusal.decision.is_some(), "the decision id");
    assert_eq!(refusal.line, Some(5));
    assert!(refusal.evaluation.is_some());
    assert_eq!(harness.names(), ["users/bob/c.txt"]);
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preview_counts() {
    let harness = start(Setup {
        functions: false,
        ..Setup::new("preview")
    })
    .await;
    harness.seed(
        (0..4)
            .flat_map(|user| (0..3).map(move |file| format!("users/u{user}/f{file}.txt")))
            .chain(["users/top.txt".to_owned()]),
    );
    let console = harness.console();
    let expected_bytes = harness
        .names()
        .iter()
        .map(|name| name.len() as u64)
        .sum::<u64>();
    let walked = console
        .bulk_preview(&request(BulkVerb::Delete, &["users/"]))
        .expect("walked");
    assert!(
        console
            .folder_index_ready(Duration::from_secs(10))
            .await
            .expect("index")
    );
    let indexed = console
        .bulk_preview(&request(BulkVerb::Delete, &["users/"]))
        .expect("indexed");
    for preview in [&walked, &indexed] {
        assert_eq!(preview.objects, 13);
        assert_eq!(preview.bytes, expected_bytes);
        assert_eq!(preview.folders, 5, "users/ and its four folders");
    }
    let recorder = Recorder::default();
    console
        .bulk(
            request(BulkVerb::Delete, &["users/"]),
            Identity::Admin,
            &recorder,
        )
        .await
        .expect("delete");
    assert_eq!(
        recorder.done.load(Ordering::SeqCst),
        indexed.objects,
        "what the preview said"
    );
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::too_many_lines, reason = "one story, told in order")]
async fn export_stream_round_trips_and_tickets_serve_a_retry() {
    use std::io::{Read as _, Write as _};
    let harness = start(Setup {
        functions: false,
        ..Setup::new("export")
    })
    .await;
    harness
        .upload("photos/a.png", b"\x89PNG\r\n\x1a\nimage bytes")
        .await;
    harness
        .upload("photos/notes/b.txt", &b"text ".repeat(1000))
        .await;
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(b"decoded body").expect("gzip");
    let gzipped = encoder.finish().expect("gzip");
    harness
        .console()
        .upload(
            ConsoleUpload {
                bucket: BUCKET.to_owned(),
                name: "photos/c.txt".to_owned(),
                content_type: Some("text/plain".to_owned()),
                content_encoding: Some("gzip".to_owned()),
                ..ConsoleUpload::default()
            },
            Body::from(gzipped),
            &Identity::Admin,
        )
        .await
        .expect("gzip upload");
    // Mark a.png as an image so it is stored, not deflated.
    harness
        .console()
        .update_metadata(
            BUCKET,
            "photos/a.png",
            &MetadataPatch {
                content_type: Some(Some("image/png".to_owned())),
                ..MetadataPatch::default()
            },
            None,
            &Identity::Admin,
            true,
        )
        .await
        .expect("type");
    let read = |bytes: Vec<u8>| {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("a zip");
        let mut entries = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).expect("entry");
            let mut body = Vec::new();
            entry.read_to_end(&mut body).expect("body");
            entries.push((entry.name().to_owned(), entry.compression(), body));
        }
        entries.sort_by(|left, right| left.0.cmp(&right.0));
        entries
    };
    let (file_name, body) = harness
        .console()
        .export_stream(&ExportSource::Folder {
            bucket: BUCKET.to_owned(),
            prefix: "photos/".to_owned(),
        })
        .expect("folder");
    assert_eq!(file_name, "photos.zip");
    let entries = read(to_bytes(body, usize::MAX).await.expect("stream").to_vec());
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].0, "a.png");
    assert_eq!(entries[0].1, zip::CompressionMethod::Stored);
    assert_eq!(entries[1].0, "c.txt");
    assert_eq!(
        entries[1].2, b"decoded body",
        "gzip objects are written decoded"
    );
    assert_eq!(entries[2].0, "notes/b.txt");
    assert_eq!(entries[2].1, zip::CompressionMethod::Deflated);
    assert_eq!(entries[2].2, b"text ".repeat(1000));
    // A ticket: refused while streaming, usable again after an abort, used
    // up once a response completes.
    let ticket = harness
        .console()
        .export_ticket(
            BUCKET,
            &BulkSource::Keys(vec!["photos/a.png".to_owned(), "photos/notes/".to_owned()]),
        )
        .expect("ticket");
    assert_eq!(ticket.objects, 2);
    let source = ExportSource::Ticket(ticket.id.clone());
    let (_, aborted) = harness.console().export_stream(&source).expect("first");
    // The archive is small enough to sit whole in the channel's buffer: the
    // writer is done long before anyone reads, and the ticket is still taken.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let busy = harness.console().export_stream(&source).expect_err("busy");
    assert!(matches!(busy, ConsoleError::Conflict(_)));
    drop(aborted);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let retried = loop {
        match harness.console().export_stream(&source) {
            Ok((_, body)) => break body,
            Err(ConsoleError::Conflict(_)) => {
                assert!(
                    std::time::Instant::now() < deadline,
                    "the aborted stream never ended"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(other) => panic!("{other:?}"),
        }
    };
    let entries = read(to_bytes(retried, usize::MAX).await.expect("retry").to_vec());
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.0.as_str())
            .collect::<Vec<_>>(),
        ["a.png", "notes/b.txt"]
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(matches!(
        harness.console().export_stream(&source),
        Err(ConsoleError::NotFound(_))
    ));
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_waits_for_an_export_stream() {
    let harness = start(Setup {
        functions: false,
        ..Setup::new("stop")
    })
    .await;
    harness
        .upload("big/blob.bin", &vec![9_u8; 4 * 1024 * 1024])
        .await;
    let (_, body) = harness
        .console()
        .export_stream(&ExportSource::Folder {
            bucket: BUCKET.to_owned(),
            prefix: "big/".to_owned(),
        })
        .expect("stream");
    // Nobody reads: the writer waits on the full channel until the stop.
    tokio::time::sleep(Duration::from_millis(100)).await;
    tokio::time::timeout(Duration::from_secs(5), harness.runtime.stop_console_tasks())
        .await
        .expect("the stop ends the writer");
    drop(body);
    harness.runtime.stop_console_tasks().await;
    harness.finish().await;
}

#[tokio::test]
async fn idle_sessions_are_swept() {
    let harness = start(Setup {
        functions: false,
        ..Setup::new("sessions")
    })
    .await;
    for name in ["old.bin", "fresh.bin"] {
        let response = harness
            .runtime
            .application()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!(
                        "/upload/storage/v1/b/{BUCKET}/o?uploadType=resumable&name={name}"
                    ))
                    .header(header::AUTHORIZATION, "Bearer owner")
                    .header("x-upload-content-length", "100")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
    }
    let names = |harness: &Harness| {
        let data = lock(&harness.runtime.state.inner);
        let mut names = data
            .uploads
            .values()
            .map(|session| session.name.clone())
            .collect::<Vec<_>>();
        names.sort();
        names
    };
    assert_eq!(names(&harness), ["fresh.bin", "old.bin"]);
    let (old_id, old_file) = {
        let mut data = lock(&harness.runtime.state.inner);
        let session = data
            .uploads
            .values_mut()
            .find(|session| session.name == "old.bin")
            .expect("old");
        session.updated_at_ms -= i64::try_from(sessions::SESSION_IDLE.as_millis()).expect("ms") + 1;
        (session.id.clone(), harness.root.join(&session.staging_file))
    };
    assert!(old_file.exists());
    let (count, _) = sessions::sweep(&harness.runtime.state, now_millis())
        .await
        .expect("sweep");
    assert_eq!(count, 1);
    assert!(!old_file.exists(), "its staged bytes went too");
    assert_eq!(names(&harness), ["fresh.bin"]);
    assert!(
        !lock(&harness.runtime.state.inner)
            .uploads
            .contains_key(&old_id)
    );
    harness.finish().await;
}

#[tokio::test]
async fn events_payloads_and_resend() {
    let mut harness = start(Setup::new("events")).await;
    harness.upload("e/a.txt", b"a").await;
    let first = harness.drain();
    assert_eq!(first, 2);
    let console = harness.console();
    let payloads = console.event_payloads(BUCKET, "e/a.txt").expect("payloads");
    assert!(payloads.functions);
    assert_eq!(
        payloads.finalize.v1["eventType"],
        "google.storage.object.finalize"
    );
    assert_eq!(
        payloads.finalize.v2["type"],
        "google.cloud.storage.object.v1.finalized"
    );
    assert_eq!(
        payloads.delete.v1["eventType"],
        "google.storage.object.delete"
    );
    assert_eq!(payloads.finalize.v1["data"]["name"], "e/a.txt");
    // Sent again twice: two more deliveries each time, every time new ids.
    let mut ids = std::collections::BTreeSet::new();
    for _ in 0..2 {
        assert_eq!(
            console.resend(BUCKET, "e/a.txt", ResendEvent::Finalize, &Identity::Admin),
            Ok(EventDelivery::Sent)
        );
        while let Ok(request) = harness.dispatches.try_recv() {
            assert!(ids.insert(request.event_id), "a fresh event id");
        }
    }
    assert_eq!(ids.len(), 4);
    assert!(matches!(
        console.resend(
            BUCKET,
            "e/a.txt",
            ResendEvent::Finalize,
            &Identity::Client {
                authorization: None
            }
        ),
        Err(ConsoleError::Denied { .. })
    ));
    // Paused triggers: not sent, and said so.
    harness.registry.set_background_enabled(false);
    assert_eq!(
        console.resend(
            BUCKET,
            "e/a.txt",
            ResendEvent::MetadataUpdate,
            &Identity::Admin
        ),
        Ok(EventDelivery::Paused)
    );
    harness.finish().await;
    // Without Functions nothing is sent.
    let quiet = start(Setup {
        functions: false,
        ..Setup::new("events-quiet")
    })
    .await;
    quiet.upload("e/b.txt", b"b").await;
    assert_eq!(
        quiet
            .console()
            .resend(BUCKET, "e/b.txt", ResendEvent::Finalize, &Identity::Admin),
        Ok(EventDelivery::NoFunctions)
    );
    assert!(
        !quiet
            .console()
            .event_payloads(BUCKET, "e/b.txt")
            .expect("payloads")
            .functions
    );
    quiet.finish().await;
}

#[tokio::test]
#[allow(clippy::too_many_lines, reason = "one story, told in order")]
async fn upload_goes_through_the_commit_path() {
    let mut harness = start(Setup {
        rules: Some(RULES),
        ..Setup::new("upload")
    })
    .await;
    let ada = Identity::Client {
        authorization: Some(token("ada")),
    };
    let console = harness.console();
    let uploaded = console
        .upload(
            ConsoleUpload {
                bucket: BUCKET.to_owned(),
                name: "users/ada/photo.png".to_owned(),
                content_type: Some("image/png".to_owned()),
                custom_metadata: std::collections::BTreeMap::from([(
                    "place".to_owned(),
                    "été".to_owned(),
                )]),
                console: true,
                ..ConsoleUpload::default()
            },
            Body::from("png bytes"),
            &ada,
        )
        .await
        .expect("allowed");
    assert!(uploaded.decision.is_some(), "judged as create and recorded");
    assert!(!uploaded.tokens_visible);
    let stored = console
        .stored(BUCKET, "users/ada/photo.png")
        .expect("stored");
    assert_eq!(stored.download_tokens.len(), 1, "a token was minted");
    assert_eq!(stored.custom_metadata["place"], "été");
    assert_eq!(harness.drain(), 2, "finalized");
    // Refused before anything is kept.
    let refused = console
        .upload(
            ConsoleUpload {
                bucket: BUCKET.to_owned(),
                name: "users/bob/photo.png".to_owned(),
                console: true,
                ..ConsoleUpload::default()
            },
            Body::from("png bytes"),
            &ada,
        )
        .await
        .expect_err("refused");
    match refused {
        ConsoleError::Denied {
            refusal: Some(refusal),
            ..
        } => {
            let request = refusal.request.expect("replayable");
            assert_eq!(request.method, Operation::Create);
        }
        other => panic!("{other:?}"),
    }
    assert!(console.stored(BUCKET, "users/bob/photo.png").is_none());
    assert_eq!(
        console.in_flight(BUCKET),
        InFlight::default(),
        "nothing left staged"
    );
    // If-None-Match: * refuses a taken name; keeping tokens is Admin's.
    let taken = console
        .upload(
            ConsoleUpload {
                bucket: BUCKET.to_owned(),
                name: "users/ada/photo.png".to_owned(),
                if_none_match: true,
                ..ConsoleUpload::default()
            },
            Body::from("again"),
            &Identity::Admin,
        )
        .await
        .expect_err("taken");
    assert_eq!(
        taken,
        ConsoleError::AlreadyExists("users/ada/photo.png already exists.".to_owned())
    );
    let kept = console
        .upload(
            ConsoleUpload {
                bucket: BUCKET.to_owned(),
                name: "users/ada/photo.png".to_owned(),
                keep_tokens: true,
                ..ConsoleUpload::default()
            },
            Body::from("edited"),
            &Identity::Admin,
        )
        .await
        .expect("edit in place");
    assert_eq!(
        kept.download_tokens, stored.download_tokens,
        "URLs the app holds keep working"
    );
    assert!(matches!(
        console
            .upload(
                ConsoleUpload {
                    bucket: BUCKET.to_owned(),
                    name: "users/ada/photo.png".to_owned(),
                    keep_tokens: true,
                    ..ConsoleUpload::default()
                },
                Body::from("edited"),
                &ada,
            )
            .await,
        Err(ConsoleError::Denied { .. })
    ));
    harness.finish().await;
}

#[test]
fn metadata_header_is_base64url_json() {
    use base64::Engine as _;
    let encoded = crate::URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&serde_json::json!({
            "cacheControl": "public, max-age=600",
            "customMetadata": { "place": "été" }
        }))
        .expect("json"),
    );
    let parsed = parse_metadata_header(&format!("b64.{encoded}")).expect("parsed");
    assert_eq!(parsed.custom_metadata["place"], "été");
    assert_eq!(parsed.cache_control.as_deref(), Some("public, max-age=600"));
    assert_eq!(
        parse_metadata_header(r#"{"customMetadata":{"place":"x"}}"#),
        Err(ConsoleError::Invalid(
            "x-firenook-metadata must be b64.<base64url of the JSON>.".to_owned()
        ))
    );
    let unknown = crate::URL_SAFE_NO_PAD.encode(br#"{"contentType":"image/png"}"#);
    assert!(matches!(
        parse_metadata_header(&format!("b64.{unknown}")),
        Err(ConsoleError::Invalid(message)) if message.contains("contentType is not a field")
    ));
    let huge = crate::URL_SAFE_NO_PAD.encode(vec![b' '; 70 * 1024]);
    assert!(matches!(
        parse_metadata_header(&format!("b64.{huge}")),
        Err(ConsoleError::TooLarge(_))
    ));
}

#[tokio::test]
async fn metadata_patch_semantics() {
    let harness = start(Setup {
        functions: false,
        ..Setup::new("patch")
    })
    .await;
    let console = harness.console();
    console
        .upload(
            ConsoleUpload {
                bucket: BUCKET.to_owned(),
                name: "p.txt".to_owned(),
                content_type: Some("text/plain".to_owned()),
                cache_control: Some("no-cache".to_owned()),
                custom_metadata: std::collections::BTreeMap::from([
                    ("keep".to_owned(), "1".to_owned()),
                    ("drop".to_owned(), "2".to_owned()),
                ]),
                ..ConsoleUpload::default()
            },
            Body::from("p"),
            &Identity::Admin,
        )
        .await
        .expect("upload");
    let patched = console
        .update_metadata(
            BUCKET,
            "p.txt",
            &MetadataPatch {
                cache_control: Some(None),
                content_language: Some(Some("en".to_owned())),
                custom_metadata: Some(std::collections::BTreeMap::from([
                    ("drop".to_owned(), None),
                    ("add".to_owned(), Some("3".to_owned())),
                ])),
                ..MetadataPatch::default()
            },
            Some(1),
            &Identity::Admin,
            true,
        )
        .await
        .expect("patched");
    assert_eq!(
        patched.content_type.as_deref(),
        Some("text/plain"),
        "absent leaves it"
    );
    assert_eq!(patched.cache_control, None, "null clears it");
    assert_eq!(
        patched.content_language.as_deref(),
        Some("en"),
        "a string sets it"
    );
    assert_eq!(
        patched.custom_metadata.keys().cloned().collect::<Vec<_>>(),
        ["add", "keep"]
    );
    assert_eq!(patched.metageneration, 2);
    let stale = console
        .update_metadata(
            BUCKET,
            "p.txt",
            &MetadataPatch::default(),
            Some(1),
            &Identity::Admin,
            true,
        )
        .await
        .expect_err("stale");
    assert_eq!(
        stale,
        ConsoleError::Precondition {
            message: "This file changed since you opened it (metageneration 2, you had 1)."
                .to_owned(),
            current: 2
        }
    );
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn summary_counts_and_clear() {
    let harness = start(Setup::new("clear")).await;
    harness.seed((0..2_500).map(|index| format!("s/{index:04}.txt")));
    let console = harness.console();
    let first = console.summary();
    assert!(first.buckets >= 1);
    assert!(
        console
            .folder_index_ready(Duration::from_secs(10))
            .await
            .expect("index")
    );
    let counted = console.summary();
    assert_eq!(counted.objects, Some(2_500));
    let revision = console.revision();
    let mut events = console.subscribe();
    let recorder = Recorder::default();
    let removed = console.clear_all(&recorder).await.expect("clear");
    assert_eq!(removed, 2_500);
    assert_eq!(
        recorder.done.load(Ordering::SeqCst),
        2_500,
        "progress per thousand files"
    );
    assert_eq!(harness.runtime.object_count(), 0);
    assert!(
        console.revision() > revision,
        "the revision keeps moving forwards"
    );
    assert_eq!(events.try_recv().expect("reset"), ChangeEvent::Reset);
    assert!(
        matches!(events.try_recv(), Err(TryRecvError::Empty)),
        "one announcement, no event per object"
    );
    assert_eq!(console.summary().objects, Some(0));
    let objects = std::fs::read_dir(harness.root.join("objects"))
        .expect("objects")
        .count();
    assert_eq!(objects, 0, "the data files went");
    harness.finish().await;
}
