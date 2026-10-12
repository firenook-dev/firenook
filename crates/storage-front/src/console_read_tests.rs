//! The console's read half: listings by name and by view, both ways, while
//! writers interleave; batch reads; markers and empty segments; media
//! headers; search; identities.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header};
use firenook_functions_bridge::{TriggerObserver, TriggerRegistry};
use tower::ServiceExt as _;

use super::*;

const PROJECT: &str = "demo-console-reads";
const BUCKET: &str = "demo-console-reads.appspot.com";

pub(crate) struct Harness {
    pub(crate) runtime: StorageRuntime,
    pub(crate) root: PathBuf,
}

pub(crate) async fn start_with_rules(
    label: &str,
    rules: Option<&str>,
    options: StorageOptions,
) -> Harness {
    let root = std::env::temp_dir().join(format!(
        "firenook-console-{label}-{}-{}",
        std::process::id(),
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    let registry = TriggerRegistry::default();
    let (observer, _dispatches) = TriggerObserver::channel(registry.clone());
    let runtime = StorageRuntime::start_with(
        StorageConfig {
            project: PROJECT.to_owned(),
            origin: "http://127.0.0.1:21002".to_owned(),
            data_dir: root.clone(),
            rules: rules.map(|source| NativeRulesConfig {
                source: RulesSource::Single(RulesFile {
                    name: "storage.rules".to_owned(),
                    content: source.to_owned(),
                }),
                documents: Arc::new(NoFirestoreDocuments),
            }),
            durability: StorageDurability::PerCommit,
        },
        options,
        observer.queue(),
        registry,
    )
    .await
    .expect("Storage runtime");
    Harness { runtime, root }
}

async fn start(label: &str) -> Harness {
    start_with_rules(label, None, StorageOptions::default()).await
}

impl Harness {
    pub(crate) async fn finish(self) {
        let Self { runtime, root } = self;
        runtime.shutdown().await.expect("shutdown");
        let _ = std::fs::remove_dir_all(root);
    }

    /// Puts an object straight into the map, as an import would.
    pub(crate) fn put(&self, name: &str, size: u64) {
        self.put_with(name, size, |_| {});
    }

    pub(crate) fn put_with(&self, name: &str, size: u64, edit: impl FnOnce(&mut StoredObject)) {
        let mut object = object(name, size);
        edit(&mut object);
        lock(&self.runtime.state.inner).put(object, &ChangeContext::system());
    }

    pub(crate) fn remove(&self, name: &str) {
        lock(&self.runtime.state.inner).remove(&object_key(BUCKET, name), &ChangeContext::system());
    }

    async fn upload(&self, name: &str, body: &[u8], headers: &[(&str, &str)]) -> StatusCode {
        let mut request = Request::builder().method(Method::POST).uri(format!(
            "/upload/storage/v1/b/{BUCKET}/o?uploadType=media&name={}",
            percent_encode(name)
        ));
        request = request.header(header::AUTHORIZATION, "Bearer owner");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        self.runtime
            .application()
            .oneshot(request.body(Body::from(body.to_vec())).expect("request"))
            .await
            .expect("response")
            .status()
    }

    async fn ready(&self) {
        assert!(
            self.runtime
                .console()
                .folder_index_ready(std::time::Duration::from_secs(30))
                .await
                .expect("index"),
            "the folder index builds"
        );
    }
}

pub(crate) fn object(name: &str, size: u64) -> StoredObject {
    StoredObject {
        name: name.to_owned(),
        bucket: BUCKET.to_owned(),
        generation: 1,
        metageneration: 1,
        content_type: Some("text/plain".to_owned()),
        storage_class: "STANDARD".to_owned(),
        content_disposition: None,
        content_encoding: None,
        content_language: None,
        cache_control: None,
        download_tokens: Vec::new(),
        custom_metadata: BTreeMap::new(),
        time_created: "2026-10-01T00:00:00Z".to_owned(),
        updated: "2026-10-01T00:00:00Z".to_owned(),
        size,
        md5_hash: String::new(),
        crc32c: 0,
        etag: String::new(),
        data_file: String::new(),
    }
}

fn query(prefix: &str) -> ConsoleListQuery {
    ConsoleListQuery {
        bucket: BUCKET.to_owned(),
        prefix: prefix.to_owned(),
        flat: false,
        kind: ListKind::All,
        order: ListOrder::default(),
        filter: None,
        filter_key: String::new(),
        after: None,
        before: None,
        limit: 100,
    }
}

fn key_of(entry: &ListEntry) -> String {
    match entry {
        ListEntry::Folder(folder) => folder.prefix.clone(),
        ListEntry::File(file) => file.name.clone(),
    }
}

fn keys(result: &ListResult) -> Vec<String> {
    result
        .entries
        .iter()
        .map(|(entry, _)| key_of(entry))
        .collect()
}

/// Pages through `query` forwards from the start, then backwards from its
/// last page, calling `between` after every page; returns both orders' keys.
async fn page_both_ways(
    console: &StorageConsoleApi,
    query: &ConsoleListQuery,
    mut between: impl FnMut(),
) -> (Vec<String>, Vec<String>) {
    let list = |after: Option<ListCursor>, before: Option<ListCursor>| {
        let query = ConsoleListQuery {
            after,
            before,
            ..query.clone()
        };
        async move {
            console
                .list(&query, &Identity::Admin, true)
                .await
                .expect("page")
        }
    };
    let mut forward = Vec::new();
    let mut page = list(None, None).await;
    loop {
        forward.extend(keys(&page));
        between();
        if !page.more_after {
            break;
        }
        let cursor = page.entries.last().map(|(_, cursor)| cursor.clone());
        page = list(cursor, None).await;
    }
    let mut backward = keys(&page);
    while page.more_before {
        let cursor = page.entries.first().map(|(_, cursor)| cursor.clone());
        page = list(None, cursor).await;
        let mut above = keys(&page);
        above.extend(backward);
        backward = above;
        between();
    }
    (forward, backward)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::too_many_lines, reason = "three listings, one story")]
async fn console_cursor_survives_writes() {
    let harness = start("cursors").await;
    for folder in 0..30 {
        harness.put(&format!("level/d{folder:02}/inside.txt"), 1);
    }
    for file in 0..250 {
        harness.put(&format!("level/f{file:03}.txt"), file);
    }
    harness.ready().await;
    let console = harness.runtime.console();
    let untouched: BTreeSet<String> = (0..30)
        .map(|folder| format!("level/d{folder:02}/"))
        .chain((0..250).map(|file| format!("level/f{file:03}.txt")))
        .collect();
    for (label, query) in [
        (
            "fast level",
            ConsoleListQuery {
                limit: 37,
                ..query("level/")
            },
        ),
        (
            "view level",
            ConsoleListQuery {
                limit: 37,
                order: ListOrder {
                    column: SortColumn::Size,
                    descending: true,
                },
                ..query("level/")
            },
        ),
        (
            "fast flat",
            ConsoleListQuery {
                limit: 41,
                flat: true,
                ..query("level/")
            },
        ),
    ] {
        // Names that come and go between pages: never among the untouched.
        let mut written = 0;
        let (forward, backward) = page_both_ways(&console, &query, || {
            written += 1;
            harness.put(&format!("level/new{written:03}.txt"), 7);
            if written > 2 {
                harness.remove(&format!("level/new{:03}.txt", written - 2));
            }
        })
        .await;
        let expected: BTreeSet<String> = if query.flat {
            untouched
                .iter()
                .map(|key| {
                    if key.ends_with('/') {
                        format!("{key}inside.txt")
                    } else {
                        key.clone()
                    }
                })
                .collect()
        } else {
            untouched.clone()
        };
        for (direction, keys) in [("forward", &forward), ("backward", &backward)] {
            let seen = keys
                .iter()
                .filter(|key| expected.contains(*key))
                .collect::<Vec<_>>();
            let unique = seen.iter().collect::<BTreeSet<_>>();
            assert_eq!(
                seen.len(),
                unique.len(),
                "{label} {direction}: no duplicates"
            );
            assert_eq!(
                unique.len(),
                expected.len(),
                "{label} {direction}: nothing skipped"
            );
        }
        // Folders first, then files, in every order.
        let first_file = forward.iter().position(|key| !key.ends_with('/'));
        if let Some(first_file) = first_file {
            assert!(
                forward[first_file..].iter().all(|key| !key.ends_with('/')),
                "{label}"
            );
        }
        for index in 3..40 {
            harness.remove(&format!("level/new{index:03}.txt"));
        }
    }
    // Every page's previous cursor leads back to the page before it.
    let first = console
        .list(
            &ConsoleListQuery {
                limit: 50,
                ..query("level/")
            },
            &Identity::Admin,
            true,
        )
        .await
        .expect("first");
    assert!(!first.more_before);
    let second = console
        .list(
            &ConsoleListQuery {
                limit: 50,
                after: first.entries.last().map(|(_, cursor)| cursor.clone()),
                ..query("level/")
            },
            &Identity::Admin,
            true,
        )
        .await
        .expect("second");
    assert!(second.more_before);
    let back = console
        .list(
            &ConsoleListQuery {
                limit: 50,
                before: second.entries.first().map(|(_, cursor)| cursor.clone()),
                ..query("level/")
            },
            &Identity::Admin,
            true,
        )
        .await
        .expect("back");
    assert_eq!(keys(&back), keys(&first));
    assert!(!back.more_before);
    // A cursor of another kind of listing is refused.
    let refused = console
        .list(
            &ConsoleListQuery {
                after: second.entries.last().map(|(_, cursor)| cursor.clone()),
                flat: true,
                ..query("level/")
            },
            &Identity::Admin,
            true,
        )
        .await
        .expect_err("foreign cursor");
    assert!(matches!(refused, ConsoleError::Invalid(_)));
    harness.finish().await;
}

#[tokio::test]
async fn batch_get_patches_and_places() {
    let harness = start("batch").await;
    for name in ["a/b.png", "a/c/x.txt", "a/d.png", "a/e/y.txt"] {
        harness.put(name, 3);
    }
    harness.ready().await;
    let console = harness.runtime.console();
    let scope = query("a/");
    let rows = console
        .batch_get(
            &scope,
            &[
                "a/b.png".to_owned(),
                "a/c/".to_owned(),
                "a/gone.png".to_owned(),
                "a/c/x.txt".to_owned(),
                "elsewhere/z".to_owned(),
            ],
            &Identity::Admin,
            true,
        )
        .expect("rows");
    assert!(matches!(&rows[0], Some((ListEntry::File(file), _)) if file.name == "a/b.png"));
    match &rows[1] {
        Some((ListEntry::Folder(folder), cursor)) => {
            assert_eq!(folder.prefix, "a/c/");
            assert_eq!(folder.stats.expect("counts").objects, 1);
            assert_eq!(
                *cursor,
                ListCursor::Level {
                    p: Phase::Folders,
                    a: "c/".to_owned()
                }
            );
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(rows[2], None, "gone");
    assert_eq!(rows[3], None, "deeper than the level");
    assert_eq!(rows[4], None, "another folder");
    // A created file sorts between the cursors of the loaded pages.
    harness.put("a/c2.png", 1);
    let created = console
        .batch_get(&scope, &["a/c2.png".to_owned()], &Identity::Admin, true)
        .expect("created");
    let (_, cursor) = created[0].clone().expect("row");
    let folders_end = ListCursor::Level {
        p: Phase::Folders,
        a: "e/".to_owned(),
    };
    let after_b = ListCursor::Level {
        p: Phase::Files,
        a: "b.png".to_owned(),
    };
    let at_d = ListCursor::Level {
        p: Phase::Files,
        a: "d.png".to_owned(),
    };
    assert!(folders_end < cursor && after_b < cursor && cursor < at_d);
    // A view is refreshed, never patched.
    let refused = console
        .batch_get(
            &ConsoleListQuery {
                order: ListOrder {
                    column: SortColumn::Size,
                    descending: false,
                },
                ..scope
            },
            &["a/b.png".to_owned()],
            &Identity::Admin,
            true,
        )
        .expect_err("view");
    assert!(matches!(refused, ConsoleError::Invalid(_)));
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn views_are_reused_rebuilt_and_single_flight() {
    let harness = start("views").await;
    for file in 0..300 {
        harness.put(&format!("v/f{file:03}.bin"), file);
    }
    harness.ready().await;
    let console = harness.runtime.console();
    let by_size = ConsoleListQuery {
        order: ListOrder {
            column: SortColumn::Size,
            descending: true,
        },
        limit: 10,
        ..query("v/")
    };
    // Two at once build once.
    let (left, right) = tokio::join!(
        console.list(&by_size, &Identity::Admin, true),
        console.list(&by_size, &Identity::Admin, true)
    );
    let (left, right) = (left.expect("left"), right.expect("right"));
    assert_eq!(keys(&left), keys(&right));
    assert_eq!(keys(&left)[0], "v/f299.bin");
    let views = &harness.runtime.state.views;
    assert_eq!(
        views.views_built.load(std::sync::atomic::Ordering::Relaxed),
        1
    );
    // Reused while nothing changed.
    let again = console
        .list(&by_size, &Identity::Admin, true)
        .await
        .expect("again");
    assert!(!again.stale);
    assert_eq!(
        views.views_built.load(std::sync::atomic::Ordering::Relaxed),
        1
    );
    // A change: served stale, with the changes counted, for up to 2 s.
    harness.put("v/big.bin", 10_000);
    harness.put("v/bigger.bin", 20_000);
    let stale = console
        .list(&by_size, &Identity::Admin, true)
        .await
        .expect("stale");
    assert!(stale.stale);
    assert_eq!(stale.changes_since, 2);
    assert_eq!(keys(&stale)[0], "v/f299.bin", "the old view");
    assert_eq!(
        views.views_built.load(std::sync::atomic::Ordering::Relaxed),
        1
    );
    tokio::time::sleep(view_cache::STALE_FOR + std::time::Duration::from_millis(100)).await;
    let rebuilt = console
        .list(&by_size, &Identity::Admin, true)
        .await
        .expect("rebuilt");
    assert!(!rebuilt.stale);
    assert_eq!(keys(&rebuilt)[0], "v/bigger.bin");
    assert_eq!(
        views.views_built.load(std::sync::atomic::Ordering::Relaxed),
        2
    );
    // A second sort of the same level reuses the level's names.
    let bases = views.bases_built.load(std::sync::atomic::Ordering::Relaxed);
    let by_type = ConsoleListQuery {
        order: ListOrder {
            column: SortColumn::Updated,
            descending: false,
        },
        ..by_size.clone()
    };
    console
        .list(&by_type, &Identity::Admin, true)
        .await
        .expect("updated");
    assert_eq!(
        views.bases_built.load(std::sync::atomic::Ordering::Relaxed),
        bases
    );
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn view_entries_are_compact() {
    let harness = start("compact").await;
    {
        let mut data = lock(&harness.runtime.state.inner);
        for file in 0..200_000_u64 {
            let mut entry = object(&format!("exports/{file:06}.csv"), file % 977);
            entry.content_type = Some(
                if file % 2 == 0 {
                    "text/csv"
                } else {
                    "application/json"
                }
                .to_owned(),
            );
            data.put(entry, &ChangeContext::system());
        }
    }
    harness.ready().await;
    let console = harness.runtime.console();
    for column in [SortColumn::Size, SortColumn::Type] {
        let page = console
            .list(
                &ConsoleListQuery {
                    order: ListOrder {
                        column,
                        descending: false,
                    },
                    ..query("exports/")
                },
                &Identity::Admin,
                true,
            )
            .await
            .expect("view");
        assert_eq!(page.totals.files, Some(200_000));
    }
    let views = &harness.runtime.state.views;
    assert_eq!(
        views.bases_built.load(std::sync::atomic::Ordering::Relaxed),
        1,
        "one base for both sorts"
    );
    let names = 200_000 * "000000.csv".len();
    let per_entry = (views.bytes() - names) / 200_000;
    // One base (a 4-byte offset and 24 bytes of facts per entry) shared by
    // two views of 4 bytes per entry.
    assert!(
        per_entry <= 28 + 2 * 4,
        "{per_entry} bytes per entry beyond the names"
    );
    // A filter evaluated by the engine.
    let filtered = console
        .list(
            &ConsoleListQuery {
                filter: Some(StorageFilter {
                    clauses: vec![
                        FilterClause {
                            any: vec![FilterPredicate::Type {
                                value: "text/csv".to_owned(),
                                prefix: false,
                            }],
                            negated: false,
                        },
                        FilterClause {
                            any: vec![FilterPredicate::Size {
                                min: Some(900),
                                max: None,
                            }],
                            negated: false,
                        },
                    ],
                }),
                filter_key: "type:text/csv size:>=900".to_owned(),
                ..query("exports/")
            },
            &Identity::Admin,
            true,
        )
        .await
        .expect("filtered");
    assert!(filtered.totals.filtered);
    let expected = (0..200_000_u64)
        .filter(|file| file % 2 == 0 && file % 977 >= 900)
        .count() as u64;
    assert_eq!(filtered.totals.files, Some(expected));
    harness.finish().await;
}

#[tokio::test]
async fn markers_are_folders_not_files() {
    let harness = start("markers").await;
    harness.put("a/", 0);
    harness.put("a/b/", 0);
    harness.put("c.txt", 4);
    harness.ready().await;
    let console = harness.runtime.console();
    let inside = console
        .list(&query("a/"), &Identity::Admin, true)
        .await
        .expect("inside");
    assert!(inside.placeholder);
    assert_eq!(keys(&inside), ["a/b/"], "the marker itself is not a row");
    match &inside.entries[0].0 {
        ListEntry::Folder(folder) => assert_eq!(folder.stats.expect("counts").objects, 0),
        other @ ListEntry::File(_) => panic!("{other:?}"),
    }
    let root = console
        .list(&query(""), &Identity::Admin, true)
        .await
        .expect("root");
    assert_eq!(keys(&root), ["a/", "c.txt"]);
    assert_eq!(root.totals.files, Some(1), "markers are not files");
    let flat = console
        .list(
            &ConsoleListQuery {
                flat: true,
                ..query("")
            },
            &Identity::Admin,
            true,
        )
        .await
        .expect("flat");
    assert_eq!(keys(&flat), ["c.txt"]);
    harness.finish().await;
}

#[tokio::test]
async fn empty_segments_are_kept() {
    let harness = start("segments").await;
    harness.put("a//b.png", 1);
    harness.put("/lead.png", 1);
    harness.ready().await;
    let console = harness.runtime.console();
    let root = console
        .list(&query(""), &Identity::Admin, true)
        .await
        .expect("root");
    assert_eq!(keys(&root), ["/", "a/"]);
    let a = console
        .list(&query("a/"), &Identity::Admin, true)
        .await
        .expect("a");
    assert_eq!(keys(&a), ["a//"]);
    let empty = console
        .list(&query("a//"), &Identity::Admin, true)
        .await
        .expect("a//");
    assert_eq!(keys(&empty), ["a//b.png"]);
    let slash = console
        .list(&query("/"), &Identity::Admin, true)
        .await
        .expect("/");
    assert_eq!(keys(&slash), ["/lead.png"]);
    let refused = console
        .list(&query("a"), &Identity::Admin, true)
        .await
        .expect_err("bad prefix");
    assert_eq!(
        refused,
        ConsoleError::Invalid("prefix must be empty or end with `/`.".to_owned())
    );
    harness.finish().await;
}

#[tokio::test]
async fn media_headers() {
    let harness = start("media").await;
    for (name, content_type) in [("page.html", "text/html"), ("doc.pdf", "application/pdf")] {
        assert_eq!(
            harness
                .upload(name, b"<html>hi</html>", &[("content-type", content_type)])
                .await,
            StatusCode::OK
        );
    }
    let console = harness.runtime.console();
    let html = console.stored(BUCKET, "page.html").expect("html");
    let response = console
        .media(
            BUCKET,
            "page.html",
            Some(html.generation),
            &HeaderMap::new(),
            MediaMode::Inline,
        )
        .await
        .expect("media");
    let headers = response.headers();
    assert_eq!(
        headers["content-disposition"],
        "inline; filename*=UTF-8''page.html"
    );
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert!(
        headers["content-security-policy"]
            .to_str()
            .expect("csp")
            .starts_with("sandbox;")
    );
    assert_eq!(
        headers["cache-control"],
        "private, max-age=31536000, immutable"
    );
    let stale = console
        .media(
            BUCKET,
            "page.html",
            Some(html.generation + 1),
            &HeaderMap::new(),
            MediaMode::Attachment,
        )
        .await
        .expect("media");
    assert_eq!(stale.headers()["cache-control"], "no-store");
    assert!(
        stale.headers()["content-disposition"]
            .to_str()
            .expect("text")
            .starts_with("attachment;")
    );
    let pdf = console
        .media(
            BUCKET,
            "doc.pdf",
            None,
            &HeaderMap::new(),
            MediaMode::Inline,
        )
        .await
        .expect("pdf");
    assert!(
        !pdf.headers().contains_key("content-security-policy"),
        "Chrome refuses sandboxed PDFs"
    );
    let mut ranged = HeaderMap::new();
    ranged.insert(header::RANGE, HeaderValue::from_static("bytes=0-5"));
    let partial = console
        .media(BUCKET, "page.html", None, &ranged, MediaMode::Inline)
        .await
        .expect("range");
    assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        to_bytes(partial.into_body(), usize::MAX)
            .await
            .expect("body")
            .as_ref(),
        b"<html>"
    );
    harness.finish().await;
}

#[tokio::test]
async fn gzip_is_decoded_and_never_ranged() {
    use std::io::Write as _;
    let harness = start("gzip").await;
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(b"hello, decoded world").expect("gzip");
    let body = encoder.finish().expect("finish");
    let metadata = "--b\r\ncontent-type: application/json\r\n\r\n{\"name\":\"note.txt\",\"contentType\":\"text/plain\",\"contentEncoding\":\"gzip\"}\r\n--b\r\ncontent-type: text/plain\r\n\r\n";
    let mut multipart = metadata.as_bytes().to_vec();
    multipart.extend_from_slice(&body);
    multipart.extend_from_slice(b"\r\n--b--");
    let response = harness
        .runtime
        .application()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!(
                    "/upload/storage/v1/b/{BUCKET}/o?uploadType=multipart"
                ))
                .header(header::AUTHORIZATION, "Bearer owner")
                .header(header::CONTENT_TYPE, "multipart/related; boundary=b")
                .body(Body::from(multipart))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let mut request = HeaderMap::new();
    request.insert(header::RANGE, HeaderValue::from_static("bytes=0-3"));
    request.insert(
        header::ACCEPT_ENCODING,
        HeaderValue::from_static("identity"),
    );
    let console = harness.runtime.console();
    let response = console
        .media(BUCKET, "note.txt", None, &request, MediaMode::Inline)
        .await
        .expect("media");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["accept-ranges"], "none");
    assert!(!response.headers().contains_key("content-encoding"));
    assert!(!response.headers().contains_key("content-length"));
    assert_eq!(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body")
            .as_ref(),
        b"hello, decoded world"
    );
    let view = console
        .object(BUCKET, "note.txt", &Identity::Admin, true)
        .await
        .expect("object");
    assert_eq!(
        view.sniffed.map(|sniffed| sniffed.mime),
        Some("text/plain"),
        "sniffed decoded"
    );
    harness.finish().await;
}

#[tokio::test]
async fn search_bounded_and_ordered() {
    let harness = start("search").await;
    for name in [
        "users/u1/avatar.png",
        "avatar.png",
        "users/u2/my-avatar.png",
        "users/u3/notes.txt",
        "avatars/a.png",
    ] {
        harness.put(name, 1);
    }
    let console = harness.runtime.console();
    let cancel = AtomicBool::new(false);
    let before_index = console.search("avatar", 10, &cancel);
    assert!(
        before_index
            .hits
            .iter()
            .all(|hit| hit.kind == SearchKind::Object),
        "no folders before the index is built"
    );
    harness.ready().await;
    let found = console.search("avatar.png", 10, &cancel);
    assert_eq!(found.hits[0].key, "avatar.png", "the exact name first");
    assert_eq!(found.hits[0].rank, 0);
    let ordered = console.search("avatar", 10, &cancel);
    let ranks = ordered.hits.iter().map(|hit| hit.rank).collect::<Vec<_>>();
    assert!(ranks.windows(2).all(|pair| pair[0] <= pair[1]), "{ranks:?}");
    assert!(
        ordered
            .hits
            .iter()
            .any(|hit| hit.kind == SearchKind::Folder && hit.key == "avatars/")
    );
    let my = ordered
        .hits
        .iter()
        .find(|hit| hit.key == "users/u2/my-avatar.png")
        .expect("substring");
    assert_eq!(my.rank, 2);
    let limited = console.search("a", 10, &cancel);
    assert_eq!(limited.hits, [], "two characters at least");
    let two = console.search("avatar", 2, &cancel);
    assert_eq!(two.hits.len(), 2);
    cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(
        console.search("notes", 10, &cancel).partial,
        "a cancelled search says so"
    );
    harness.finish().await;
}

#[tokio::test]
async fn a_client_meets_the_rules_and_sees_no_tokens() {
    let rules = "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /public/{allPaths=**} {\n      allow read: if true;\n    }\n    match /private/{file} {\n      allow read: if request.auth != null && request.auth.uid == 'u1';\n    }\n  }\n}\n";
    let harness = start_with_rules(
        "identity",
        Some(rules),
        StorageOptions {
            diagnostics: true,
            ..StorageOptions::default()
        },
    )
    .await;
    assert_eq!(
        harness.upload("public/a.txt", b"hi", &[]).await,
        StatusCode::OK
    );
    assert_eq!(
        harness.upload("private/b.txt", b"hi", &[]).await,
        StatusCode::OK
    );
    let console = harness.runtime.console();
    let anonymous = Identity::Client {
        authorization: None,
    };
    let listed = console
        .list(&query("public/"), &anonymous, true)
        .await
        .expect("allowed");
    assert!(listed.decision.is_some(), "recorded");
    let object = console
        .object(BUCKET, "public/a.txt", &anonymous, true)
        .await
        .expect("read");
    assert!(!object.tokens_visible);
    assert_eq!(object.download_tokens, Vec::<String>::new());
    let admin = console
        .object(BUCKET, "public/a.txt", &Identity::Admin, true)
        .await
        .expect("admin");
    assert!(admin.tokens_visible);
    let refused = console
        .object(BUCKET, "private/b.txt", &anonymous, true)
        .await
        .expect_err("refused");
    match refused {
        ConsoleError::Denied {
            refusal: Some(refusal),
            no_ruleset: false,
            message,
            ..
        } => {
            assert_eq!(message, "Permission denied. No READ permission.");
            assert!(refusal.decision.is_some());
            assert_eq!(refusal.line, Some(8));
            let evaluation = refusal.evaluation.expect("explained");
            assert_ne!(evaluation.explanation, []);
            assert!(refusal.request.is_some());
        }
        other => panic!("{other:?}"),
    }
    harness.finish().await;
}
