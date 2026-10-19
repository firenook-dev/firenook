//! The console at the scale Storage is designed for, run by hand and in the
//! acceptance lane:
//!
//! ```text
//! cargo test -p firenook-storage-front --release console_scale -- --ignored --nocapture
//! ```
//!
//! `console_scale` builds one bucket of about a million objects — `users/`
//! with 50,000 users of 1 to 31 files each, `exports/` with 200,000 files
//! in one folder, `public/` with 2,000 files in 40 folders, 20 files at the
//! root — and a second bucket of 30 images, then prints the timings the
//! console's targets name, the view upkeep under a steady writer and the
//! process's resident memory. It asserts that every answer is right, never
//! a time: times are claimed only from a recorded run on the acceptance
//! host.
//!
//! `large_entries_use_zip64` streams a 4.1 GB sparse file through a folder
//! download and reads it back.

use std::io::{Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use axum::body::to_bytes;
use firenook_functions_bridge::{TriggerObserver, TriggerRegistry};

use super::*;

const BUCKET: &str = "demo-scale.appspot.com";
const OTHER: &str = "demo-scale-images";

fn object(bucket: &str, name: &str, size: u64, content_type: &str, minute: u64) -> StoredObject {
    StoredObject {
        name: name.to_owned(),
        bucket: bucket.to_owned(),
        generation: 1,
        metageneration: 1,
        content_type: Some(content_type.to_owned()),
        storage_class: "STANDARD".to_owned(),
        content_disposition: None,
        content_encoding: None,
        content_language: None,
        cache_control: None,
        download_tokens: vec!["token".to_owned()],
        custom_metadata: BTreeMap::new(),
        time_created: "2026-10-01T00:00:00Z".to_owned(),
        updated: format!(
            "2026-10-{:02}T{:02}:{:02}:00Z",
            1 + (minute / 1_440) % 28,
            (minute / 60) % 24,
            minute % 60
        ),
        size,
        md5_hash: String::new(),
        crc32c: 0,
        etag: String::new(),
        data_file: String::new(),
    }
}

fn open(root: &Path, label: &str) -> StorageRuntime {
    let registry = TriggerRegistry::default();
    let (observer, _dispatches) = TriggerObserver::channel(registry.clone());
    StorageRuntime::open(
        StorageConfig {
            project: format!("demo-{label}"),
            origin: "http://127.0.0.1:9".to_owned(),
            data_dir: root.to_path_buf(),
            rules: None,
            durability: StorageDurability::PerCommit,
        },
        StorageOptions {
            functions: false,
            ..StorageOptions::default()
        },
        observer.queue(),
        registry,
    )
    .expect("Storage runtime")
}

fn temp(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "firenook-{label}-{}-{}",
        std::process::id(),
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    ))
}

/// The process's resident memory in kilobytes, from `ps`.
fn resident_kilobytes() -> u64 {
    ps_field("rss=")
        .and_then(|text| text.parse().ok())
        .unwrap_or(0)
}

/// The process's CPU time so far: `/proc` where there is one (to the
/// clock tick), `ps` otherwise (to the hundredth on macOS).
fn cpu_seconds() -> f64 {
    if let Ok(stat) = std::fs::read_to_string("/proc/self/stat")
        && let Some((_, rest)) = stat.rsplit_once(')')
    {
        let fields = rest.split_whitespace().collect::<Vec<_>>();
        // utime and stime: fields 14 and 15 of the whole line, here 12 and
        // 13 after the state field; in ticks of 1/100 s on every Linux the
        // acceptance lane runs.
        if let (Some(user), Some(system)) = (fields.get(11), fields.get(12))
            && let (Ok(user), Ok(system)) = (user.parse::<f64>(), system.parse::<f64>())
        {
            return (user + system) / 100.0;
        }
    }
    ps_field("time=").map_or(0.0, |text| {
        text.split(':').fold(0.0, |total, part| {
            total * 60.0 + part.parse::<f64>().unwrap_or(0.0)
        })
    })
}

fn ps_field(field: &str) -> Option<String> {
    let output = std::process::Command::new("ps")
        .args(["-o", field, "-p", &std::process::id().to_string()])
        .output()
        .ok()?;
    Some(String::from_utf8(output.stdout).ok()?.trim().to_owned())
}

/// The median of 25 runs of `work`, after one warm-up.
async fn median<F, Fut>(mut work: F) -> Duration
where
    F: FnMut() -> Fut,
    Fut: Future<Output = ()>,
{
    work().await;
    let mut times = Vec::with_capacity(25);
    for _ in 0..25 {
        let started = Instant::now();
        work().await;
        times.push(started.elapsed());
    }
    times.sort();
    times[times.len() / 2]
}

fn report(label: &str, time: Duration, target: &str) {
    println!(
        "{label:<58} {:>10.3} ms   target {target}",
        time.as_secs_f64() * 1_000.0
    );
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
        fresh: false,
    }
}

/// The §8.1 set, straight into the map as an import would put it. Returns
/// how many objects `users/` holds.
fn build_set(state: &StorageState) -> u64 {
    let mut data = lock(&state.inner);
    let mut users = 0;
    for user in 0..50_000_u64 {
        for file in 0..=(user % 31) {
            let name = if file == 0 {
                format!("users/u{user:05}/avatar.png")
            } else {
                format!("users/u{user:05}/upload{file:02}.png")
            };
            let entry = object(
                BUCKET,
                &name,
                1_000 + (user * 7 + file) % 90_000,
                "image/png",
                user * 3 + file,
            );
            data.put(entry, &ChangeContext::system());
            users += 1;
        }
    }
    for file in 0..200_000_u64 {
        let content_type = if file % 3 == 0 {
            "text/csv"
        } else {
            "application/json"
        };
        let entry = object(
            BUCKET,
            &format!("exports/e{file:06}.csv"),
            (file * 13) % 10_000,
            content_type,
            file,
        );
        data.put(entry, &ChangeContext::system());
    }
    for folder in 0..40_u64 {
        for file in 0..50_u64 {
            let name = format!("public/p{folder:02}/f{file:02}.svg");
            data.put(
                object(BUCKET, &name, 512, "image/svg+xml", file),
                &ChangeContext::system(),
            );
        }
    }
    for file in 0..20_u64 {
        let name = format!("root{file:02}.txt");
        data.put(
            object(BUCKET, &name, 10, "text/plain", file),
            &ChangeContext::system(),
        );
    }
    for file in 0..30_u64 {
        let name = format!("i{file:02}.jpg");
        data.put(
            object(OTHER, &name, 4_096, "image/jpeg", file),
            &ChangeContext::system(),
        );
    }
    users
}

/// A writer on its own thread putting one object every `every` into
/// `prefix` of `bucket` until `stop`; answers how many it wrote and the
/// slowest write, the lock's wait included.
fn writer(
    state: StorageState,
    bucket: &'static str,
    prefix: &'static str,
    every: Duration,
    stop: Arc<AtomicBool>,
) -> std::thread::JoinHandle<(u64, Duration)> {
    std::thread::spawn(move || {
        let mut written = 0_u64;
        let mut slowest = Duration::ZERO;
        let mut next = Instant::now();
        while !stop.load(Ordering::Relaxed) {
            let entry = object(
                bucket,
                &format!("{prefix}w{written:07}.csv"),
                100,
                "text/csv",
                written,
            );
            let started = Instant::now();
            lock(&state.inner).put(entry, &ChangeContext::system());
            slowest = slowest.max(started.elapsed());
            written += 1;
            next += every;
            if let Some(wait) = next.checked_duration_since(Instant::now()) {
                std::thread::sleep(wait);
            }
        }
        (written, slowest)
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "builds a million objects; run by hand with --release"]
#[allow(clippy::too_many_lines, reason = "one report, printed in order")]
async fn console_scale() {
    let root = temp("console-scale");
    let runtime = open(&root, "scale");
    let state = runtime.state.clone();
    let console = runtime.console();
    let admin = Identity::Admin;

    let empty = resident_kilobytes();
    let started = Instant::now();
    let users = build_set(&state);
    let objects = lock(&state.inner).objects.len();
    let loaded = resident_kilobytes();
    println!(
        "set: {objects} objects ({users} under users/) put in {:.2} s; RSS {empty} KB -> {loaded} KB",
        started.elapsed().as_secs_f64()
    );

    // The folder index walk, with a writer putting into the other bucket
    // throughout: no write may wait long behind the walk.
    let stop = Arc::new(AtomicBool::new(false));
    let during = writer(
        state.clone(),
        OTHER,
        "during/",
        Duration::from_millis(1),
        stop.clone(),
    );
    let walk = Instant::now();
    assert!(
        console
            .folder_index_ready(Duration::from_secs(300))
            .await
            .expect("index")
    );
    let walked = walk.elapsed();
    stop.store(true, Ordering::Relaxed);
    let (written, slowest) = during.join().expect("writer");
    report("folder index build, 1M objects", walked, "< 1.5 s");
    report(
        &format!("slowest of {written} writes during the walk"),
        slowest,
        "< 50 ms",
    );
    let indexed = resident_kilobytes();
    println!(
        "RSS after the index: {indexed} KB (+{} KB over the loaded set, which took {} KB)",
        indexed.saturating_sub(loaded),
        loaded.saturating_sub(empty)
    );

    let root_page = median(|| async {
        let page = console.list(&query(""), &admin, true).await.expect("root");
        assert_eq!(page.entries.len(), 23);
        assert_eq!(page.totals.folders, Some(3));
    })
    .await;
    report("GET /objects root, name asc", root_page, "p50 < 5 ms");
    let users_page = median(|| async {
        let page = console
            .list(&query("users/"), &admin, true)
            .await
            .expect("users");
        assert_eq!(page.entries.len(), 100);
        assert_eq!(page.totals.folders, Some(50_000));
    })
    .await;
    report("GET /objects users/, name asc", users_page, "p50 < 5 ms");
    let first = console
        .list(&query("exports/"), &admin, true)
        .await
        .expect("exports");
    let exports_page = median(|| async {
        let page = console
            .list(&query("exports/"), &admin, true)
            .await
            .expect("exports");
        assert_eq!(page.entries.len(), 100);
    })
    .await;
    report(
        "GET /objects exports/ first page, name asc",
        exports_page,
        "p50 < 5 ms",
    );
    let after = first.entries.last().map(|(_, cursor)| cursor.clone());
    let second = console
        .list(
            &ConsoleListQuery {
                after,
                ..query("exports/")
            },
            &admin,
            true,
        )
        .await
        .expect("second");
    let before = second.entries.first().map(|(_, cursor)| cursor.clone());
    let before_page = median(|| async {
        let page = console
            .list(
                &ConsoleListQuery {
                    before: before.clone(),
                    ..query("exports/")
                },
                &admin,
                true,
            )
            .await
            .expect("before");
        assert_eq!(page.entries, first.entries);
    })
    .await;
    report(
        "GET /objects exports/ a before page",
        before_page,
        "p50 < 5 ms",
    );

    let by_size = ConsoleListQuery {
        order: ListOrder {
            column: SortColumn::Size,
            descending: true,
        },
        ..query("exports/")
    };
    let cold = Instant::now();
    let page = console.list(&by_size, &admin, true).await.expect("size");
    report(
        "GET /objects exports/ sort=size, cold",
        cold.elapsed(),
        "< 400 ms",
    );
    assert_eq!(page.totals.files, Some(200_000));
    let warm = median(|| async {
        console.list(&by_size, &admin, true).await.expect("size");
    })
    .await;
    report("GET /objects exports/ sort=size, warm", warm, "< 5 ms");

    let filtered = ConsoleListQuery {
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
                        min: Some(1_025),
                        max: None,
                    }],
                    negated: false,
                },
            ],
        }),
        filter_key: "type:text/csv size:>1KB".to_owned(),
        ..query("exports/")
    };
    let cold = Instant::now();
    let page = console
        .list(&filtered, &admin, true)
        .await
        .expect("filtered");
    report(
        "GET /objects exports/ q=type:text/csv size:>1KB, cold",
        cold.elapsed(),
        "< 150 ms",
    );
    let expected = (0..200_000_u64)
        .filter(|file| file % 3 == 0 && (file * 13) % 10_000 >= 1_025)
        .count() as u64;
    assert_eq!(page.totals.files, Some(expected));
    let warm = median(|| async {
        console
            .list(&filtered, &admin, true)
            .await
            .expect("filtered");
    })
    .await;
    report(
        "GET /objects exports/ q=type:text/csv size:>1KB, warm",
        warm,
        "< 5 ms",
    );

    let flat_updated = ConsoleListQuery {
        flat: true,
        order: ListOrder {
            column: SortColumn::Updated,
            descending: true,
        },
        ..query("users/")
    };
    let cold = Instant::now();
    let flat = console
        .list(&flat_updated, &admin, true)
        .await
        .expect("flat");
    report(
        "GET /objects users/ flat sort=updated, cold",
        cold.elapsed(),
        "< 1.5 s",
    );
    assert_eq!(flat.totals.files, Some(users));
    let warm = median(|| async {
        console
            .list(&flat_updated, &admin, true)
            .await
            .expect("flat");
    })
    .await;
    report(
        "GET /objects users/ flat sort=updated, warm",
        warm,
        "< 5 ms",
    );
    println!(
        "views cached: {} KB; RSS {} KB",
        state.views.bytes() / 1_024,
        resident_kilobytes()
    );

    let protocol = median(|| async {
        let data = lock(&state.inner);
        let page = list_objects(&data, BUCKET, "users/", Some("/"), None, 1_000);
        assert_eq!(page.prefixes.len(), 50_000);
    })
    .await;
    report(
        "protocol listAll() page of users/ (1,000 items)",
        protocol,
        "< 20 ms",
    );

    let keys = (0..50)
        .map(|user| format!("users/u{user:05}/"))
        .collect::<Vec<_>>();
    let batch = median(|| async {
        let rows = console
            .batch_get(&query("users/"), &keys, &admin, true)
            .expect("batch");
        assert_eq!(rows.iter().flatten().count(), 50);
    })
    .await;
    report("POST /objects:batchGet, 50 touched keys", batch, "< 2 ms");

    let figures = median(|| async {
        assert!(console.summary().objects.is_some());
        assert_eq!(console.buckets().buckets.len(), 2);
        assert!(console.folder(BUCKET, "users/").is_some());
    })
    .await;
    report(
        "GET /folder + /buckets + Section::summary together",
        figures,
        "< 1 ms each",
    );

    let cancel = AtomicBool::new(false);
    let search = median(|| async {
        let found = console.search("upload07", 20, &cancel);
        assert_eq!(found.hits.len(), 20);
    })
    .await;
    report("search over 1M names, 20 hits", search, "<= 50 ms");

    // A 12 MP photograph's 320 px thumbnail, cold then cached.
    let photo = "objects/scale-photo.jpg";
    {
        let image = image::RgbImage::from_fn(4_000, 3_000, |x, y| {
            image::Rgb([
                x.to_le_bytes()[0],
                y.to_le_bytes()[0],
                (x + y).to_le_bytes()[0],
            ])
        });
        let mut file = std::fs::File::create(root.join(photo)).expect("photo");
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, 85)
            .encode_image(&image)
            .expect("jpeg");
        let size = file.metadata().expect("size").len();
        let mut entry = object(OTHER, "photo.jpg", size, "image/jpeg", 0);
        entry.data_file = photo.to_owned();
        lock(&state.inner).put(entry, &ChangeContext::system());
    }
    let cold = Instant::now();
    let (thumbnail, _) = console
        .thumbnail(OTHER, "photo.jpg", Some(1), 320)
        .await
        .expect("thumbnail");
    report(
        "thumbnail 320 px of a 12 MP JPEG, cold",
        cold.elapsed(),
        "< 150 ms",
    );
    println!(
        "thumbnail: {} bytes, {}",
        thumbnail.bytes.len(),
        thumbnail.content_type
    );
    let cached = median(|| async {
        console
            .thumbnail(OTHER, "photo.jpg", Some(1), 320)
            .await
            .expect("thumbnail");
    })
    .await;
    report("thumbnail 320 px, cached", cached, "< 1 ms");

    // One write with the index maintained, the lock's wait included.
    let writes = 20_000_u64;
    let started = Instant::now();
    for index in 0..writes {
        let entry = object(
            BUCKET,
            &format!("users/u{:05}/new{index}.png", index % 50_000),
            10,
            "image/png",
            index,
        );
        lock(&state.inner).put(entry, &ChangeContext::system());
    }
    report(
        "one write with the folder index maintained (mean of 20,000)",
        started.elapsed() / u32::try_from(writes).expect("count"),
        "< 5 us",
    );

    // The view's upkeep: `exports/` sorted by size open and refreshed by
    // the console every 500 ms while the app writes 10,000 files a minute
    // into `exports/`, against the same writer alone.
    let window = Duration::from_secs(10);
    let every = Duration::from_millis(6);
    let stop = Arc::new(AtomicBool::new(false));
    let alone = writer(state.clone(), BUCKET, "exports/a-", every, stop.clone());
    let cpu = cpu_seconds();
    tokio::time::sleep(window).await;
    let writes_alone = cpu_seconds() - cpu;
    stop.store(true, Ordering::Relaxed);
    alone.join().expect("writer");
    let stop = Arc::new(AtomicBool::new(false));
    let viewed = writer(state.clone(), BUCKET, "exports/b-", every, stop.clone());
    let built = state.views.views_built.load(Ordering::Relaxed);
    let cpu = cpu_seconds();
    let deadline = Instant::now() + window;
    let mut refreshes = 0;
    while Instant::now() < deadline {
        console.list(&by_size, &admin, true).await.expect("size");
        refreshes += 1;
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let with_view = cpu_seconds() - cpu;
    stop.store(true, Ordering::Relaxed);
    viewed.join().expect("writer");
    let rebuilt = state.views.views_built.load(Ordering::Relaxed) - built;
    println!(
        "{:<58} {:>10.1} %    target < 10 % of one core ({refreshes} refreshes, {rebuilt} rebuilds; writer alone {:.2} s CPU, with the view {:.2} s)",
        "exports/ sort=size upkeep under 10,000 writes a minute",
        (with_view - writes_alone).max(0.0) / window.as_secs_f64() * 100.0,
        writes_alone,
        with_view
    );
    assert!(rebuilt <= u64::try_from(refreshes).expect("count"));

    println!("RSS at the end: {} KB", resident_kilobytes());
    runtime.shutdown().await.expect("shutdown");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "streams 4.1 GB; run by hand with --release"]
async fn large_entries_use_zip64() {
    const SIZE: u64 = 4_100_000_000;
    const TAIL: &[u8] = b"the last bytes of a 4.1 GB file";
    let root = temp("zip64");
    let runtime = open(&root, "zip64");
    // A sparse file: 4.1 GB long, a few bytes on disk, a tail to check.
    let data_file = "objects/large.bin";
    {
        let mut file = std::fs::File::create(root.join(data_file)).expect("file");
        file.set_len(SIZE).expect("length");
        file.seek(SeekFrom::Start(SIZE - TAIL.len() as u64))
            .expect("seek");
        file.write_all(TAIL).expect("tail");
    }
    let mut entry = object(BUCKET, "big/large.bin", SIZE, "application/octet-stream", 0);
    entry.data_file = data_file.to_owned();
    lock(&runtime.state.inner).put(entry, &ChangeContext::system());
    let (file_name, body) = runtime
        .console()
        .export_stream(&ExportSource::Folder {
            bucket: BUCKET.to_owned(),
            prefix: "big/".to_owned(),
        })
        .expect("export");
    assert_eq!(file_name, "big.zip");
    let zipped = to_bytes(body, usize::MAX).await.expect("stream");
    println!("4.1 GB of mostly zeros as {} bytes of zip", zipped.len());
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zipped)).expect("a zip");
    assert_eq!(archive.len(), 1);
    let mut large = archive.by_index(0).expect("entry");
    assert_eq!(large.name().expect("name"), "large.bin");
    assert_eq!(large.size(), SIZE);
    // Read to the end, so the zip crate checks the CRC, keeping the tail.
    let mut length = 0_u64;
    let mut last = Vec::new();
    let mut buffer = vec![0; 1 << 20];
    loop {
        let read = large.read(&mut buffer).expect("read");
        if read == 0 {
            break;
        }
        length += read as u64;
        last.extend_from_slice(&buffer[..read]);
        if last.len() > TAIL.len() {
            last.drain(..last.len() - TAIL.len());
        }
    }
    assert_eq!(length, SIZE);
    assert_eq!(last, TAIL);
    drop(large);
    runtime.shutdown().await.expect("shutdown");
    let _ = std::fs::remove_dir_all(root);
}
