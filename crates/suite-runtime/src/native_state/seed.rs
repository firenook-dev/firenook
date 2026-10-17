//! The seed's record: every file's size, times and SHA-256, kept beside the
//! receipt so that picking saved data up compares file details instead of
//! reading the whole seed again. Files that operating systems write into any
//! folder they show (Finder's `.DS_Store`, Windows' `Thumbs.db` …) are not
//! part of it: no importer reads them, and they change without anyone
//! changing the seed.
//!
//! The receipt keeps its one whole-seed fingerprint, in the format earlier
//! engines compute, so saved data stays readable by them.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read as _, Write as _};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

const RECORD: &str = "native-seed.json";
const VERSION: u32 = 1;
/// A file changed this close to when its details were recorded may have
/// changed again within the clock's resolution: it is read once more.
const RACY_NANOS: i64 = 2_000_000_000;
/// Files up to this size are read ahead by the workers; larger ones are read
/// in order by the thread that keeps the whole-seed fingerprint. Tests use
/// small sizes, so that their small seeds take every path.
const PREFETCH_LIMIT: u64 = if cfg!(test) { 8 } else { 32 * 1024 * 1024 };
/// Bytes read ahead and not yet folded into the whole-seed fingerprint.
const PREFETCH_BUDGET: u64 = if cfg!(test) { 16 } else { 256 * 1024 * 1024 };
const BUFFER: usize = if cfg!(test) { 3 } else { 1024 * 1024 };
/// How often a waiting thread looks at the cancel flag again.
const POLL: Duration = Duration::from_millis(50);
/// Files whose details are read by one thread before others are added.
const STAT_CHUNK: usize = if cfg!(test) { 2 } else { 1024 };

/// Whether `name` is a file an operating system writes on its own.
pub(super) fn junk_file(name: &str) -> bool {
    name == ".DS_Store"
        || name.starts_with("._")
        || name == "Icon\r"
        || name.eq_ignore_ascii_case("Thumbs.db")
        || name.eq_ignore_ascii_case("ehthumbs.db")
        || name.eq_ignore_ascii_case("desktop.ini")
}

/// Whether `name` is a folder an operating system keeps on its own.
fn junk_directory(name: &str) -> bool {
    matches!(
        name,
        "__MACOSX" | ".Spotlight-V100" | ".Trashes" | ".fseventsd" | ".TemporaryItems"
    )
}

/// One file of the seed as found on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Found {
    /// Relative to the seed, as the platform spells it.
    pub(super) path: String,
    pub(super) size: u64,
    pub(super) modified: i64,
    pub(super) changed: i64,
    /// Written by the operating system: not part of the record.
    pub(super) junk: bool,
}

/// Lists every file of the seed with its size and times, in the order
/// earlier engines fingerprinted them: each folder's entries sorted by name,
/// a folder's own files where the folder sorts. A symbolic link or any
/// other special file is refused, so nothing outside the seed is read.
pub(super) fn scan(root: &Path) -> Result<Vec<Found>, String> {
    let mut found = Vec::new();
    scan_directory(root, root, false, &mut found)?;
    Ok(found)
}

fn scan_directory(
    root: &Path,
    directory: &Path,
    inside_junk: bool,
    found: &mut Vec<Found>,
) -> Result<(), String> {
    let mut entries = fs::read_dir(directory)
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|error| format!("cannot list {}: {error}", directory.display()))?;
    entries.sort_by_key(fs::DirEntry::file_name);
    let mut files = Vec::new();
    for entry in entries {
        let kind = entry
            .file_type()
            .map_err(|error| format!("cannot read {}: {error}", entry.path().display()))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if kind.is_dir() {
            found.extend(stat_all(root, &files)?);
            files.clear();
            scan_directory(
                root,
                &entry.path(),
                inside_junk || junk_directory(&name),
                found,
            )?;
        } else if kind.is_file() {
            let junk = inside_junk || junk_file(&name);
            files.push((entry, junk));
        } else {
            return Err(format!(
                "seed contains a symlink or special file: {}",
                entry.path().display()
            ));
        }
    }
    found.extend(stat_all(root, &files)?);
    Ok(())
}

/// The details of a folder's files; a folder of thousands is read by several
/// threads at once.
fn stat_all(root: &Path, files: &[(fs::DirEntry, bool)]) -> Result<Vec<Found>, String> {
    if files.len() <= STAT_CHUNK {
        return files
            .iter()
            .map(|(entry, junk)| stat(root, entry, *junk))
            .collect();
    }
    std::thread::scope(|scope| {
        let handles = files
            .chunks(STAT_CHUNK)
            .map(|chunk| {
                scope.spawn(move || {
                    chunk
                        .iter()
                        .map(|(entry, junk)| stat(root, entry, *junk))
                        .collect::<Result<Vec<_>, _>>()
                })
            })
            .collect::<Vec<_>>();
        let mut all = Vec::with_capacity(files.len());
        for handle in handles {
            all.extend(
                handle
                    .join()
                    .map_err(|_| "a seed scan thread panicked".to_owned())??,
            );
        }
        Ok(all)
    })
}

fn stat(root: &Path, entry: &fs::DirEntry, junk: bool) -> Result<Found, String> {
    let path = entry.path();
    // Not followed: a link was refused by its file type already.
    let metadata = entry
        .metadata()
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    let relative = path
        .strip_prefix(root)
        .map_err(|error| error.to_string())?
        .to_str()
        .ok_or_else(|| "seed paths must be UTF-8".to_owned())?
        .to_owned();
    let modified = metadata.modified().map(nanos).unwrap_or_default();
    Ok(Found {
        path: relative,
        size: metadata.len(),
        modified,
        changed: changed(&metadata).unwrap_or(modified),
        junk,
    })
}

/// When the file's inode last changed: no tool can set it back, so a copy
/// that keeps the modification time still shows as changed.
#[cfg(unix)]
fn changed(metadata: &fs::Metadata) -> Option<i64> {
    use std::os::unix::fs::MetadataExt as _;
    metadata
        .ctime()
        .checked_mul(1_000_000_000)?
        .checked_add(metadata.ctime_nsec())
}

#[cfg(not(unix))]
fn changed(_metadata: &fs::Metadata) -> Option<i64> {
    None
}

fn nanos(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(after) => i64::try_from(after.as_nanos()).unwrap_or(i64::MAX),
        Err(before) => i64::try_from(before.duration().as_nanos()).map_or(i64::MIN, |n| -n),
    }
}

fn now() -> i64 {
    nanos(SystemTime::now())
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(64), |mut text, byte| {
            let _ = write!(text, "{byte:02x}");
            text
        })
}

/// What one full read of the seed yields.
pub(super) struct Hashed {
    /// Each file's SHA-256, in `Found` order.
    pub(super) files: Vec<[u8; 32]>,
    /// The whole-seed fingerprint earlier engines compute, over every file.
    pub(super) whole: String,
    /// The same fingerprint as if the operating system's files were gone.
    pub(super) whole_without_junk: String,
}

/// A file read ahead: its bytes (none for a large file, which the
/// fingerprint thread reads itself) and its SHA-256.
struct Ahead {
    bytes: Option<Vec<u8>>,
    hash: [u8; 32],
}

struct Pipeline {
    ready: HashMap<usize, Result<Ahead, String>>,
    held: u64,
    position: usize,
    stop: bool,
}

fn guard(state: &Mutex<Pipeline>) -> MutexGuard<'_, Pipeline> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Reads every file once: workers read and hash files ahead, several at a
/// time, while this thread folds them in order into the whole-seed
/// fingerprint, and into the one without the operating system's files when
/// `without_junk` asks (a second digest, so only when it is needed).
/// `cancel` ends the read early, as an error.
pub(super) fn hash_all(
    root: &Path,
    found: &[Found],
    cancel: &AtomicBool,
    without_junk: bool,
) -> Result<Hashed, String> {
    let state = Mutex::new(Pipeline {
        ready: HashMap::new(),
        held: 0,
        position: 0,
        stop: false,
    });
    let wake = Condvar::new();
    let next = AtomicUsize::new(0);
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get().clamp(2, 12));
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| read_ahead(root, found, &state, &wake, &next));
        }
        let folded = fold(root, found, &state, &wake, cancel, without_junk);
        guard(&state).stop = true;
        wake.notify_all();
        folded
    })
}

fn read_ahead(
    root: &Path,
    found: &[Found],
    state: &Mutex<Pipeline>,
    wake: &Condvar,
    next: &AtomicUsize,
) {
    let mut buffer = vec![0_u8; BUFFER];
    loop {
        let index = next.fetch_add(1, Ordering::Relaxed);
        let Some(file) = found.get(index) else { return };
        let ahead = if file.size > PREFETCH_LIMIT {
            Ok(Ahead {
                bytes: None,
                hash: [0; 32],
            })
        } else {
            {
                let mut pipeline = guard(state);
                // The file the fingerprint needs next is always read.
                while !pipeline.stop
                    && index != pipeline.position
                    && pipeline.held + file.size > PREFETCH_BUDGET
                {
                    pipeline = wake
                        .wait_timeout(pipeline, POLL)
                        .unwrap_or_else(PoisonError::into_inner)
                        .0;
                }
                if pipeline.stop {
                    return;
                }
                pipeline.held += file.size;
            }
            read_whole(&root.join(&file.path), &mut buffer)
        };
        let mut pipeline = guard(state);
        if pipeline.stop {
            return;
        }
        pipeline.ready.insert(index, ahead);
        wake.notify_all();
    }
}

fn read_whole(path: &Path, buffer: &mut [u8]) -> Result<Ahead, String> {
    let failed = |error: std::io::Error| format!("cannot read {}: {error}", path.display());
    let mut file = File::open(path).map_err(failed)?;
    let mut bytes = Vec::new();
    let mut digest = Sha256::new();
    loop {
        let length = file.read(buffer).map_err(failed)?;
        if length == 0 {
            break;
        }
        digest.update(&buffer[..length]);
        bytes.extend_from_slice(&buffer[..length]);
    }
    Ok(Ahead {
        bytes: Some(bytes),
        hash: digest.finalize().into(),
    })
}

/// The whole-seed fingerprint frames each file with its path and length.
fn frame(digest: &mut Sha256, path: &str, length: u64) {
    digest.update((path.len() as u64).to_le_bytes());
    digest.update(path.as_bytes());
    digest.update(length.to_le_bytes());
}

fn fold(
    root: &Path,
    found: &[Found],
    state: &Mutex<Pipeline>,
    wake: &Condvar,
    cancel: &AtomicBool,
    without_junk: bool,
) -> Result<Hashed, String> {
    let mut whole = Sha256::new();
    // The same digest until the first file the operating system wrote.
    let mut without: Option<Sha256> = None;
    let mut files = Vec::with_capacity(found.len());
    let mut buffer = vec![0_u8; BUFFER];
    for (index, file) in found.iter().enumerate() {
        let ahead = {
            let mut pipeline = guard(state);
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err("the seed check was stopped".to_owned());
                }
                if let Some(ahead) = pipeline.ready.remove(&index) {
                    break ahead?;
                }
                pipeline = wake
                    .wait_timeout(pipeline, POLL)
                    .unwrap_or_else(PoisonError::into_inner)
                    .0;
            }
        };
        if without_junk && file.junk && without.is_none() {
            without = Some(whole.clone());
        }
        let others = without.as_mut().filter(|_| !file.junk);
        let hash = if let Some(bytes) = ahead.bytes {
            frame(&mut whole, &file.path, bytes.len() as u64);
            whole.update(&bytes);
            if let Some(digest) = others {
                frame(digest, &file.path, bytes.len() as u64);
                digest.update(&bytes);
            }
            let mut pipeline = guard(state);
            pipeline.held -= file.size;
            pipeline.position = index + 1;
            wake.notify_all();
            ahead.hash
        } else {
            guard(state).position = index;
            let hash = stream(
                &root.join(&file.path),
                file,
                &mut buffer,
                &mut whole,
                others,
                cancel,
            )?;
            guard(state).position = index + 1;
            wake.notify_all();
            hash
        };
        files.push(hash);
    }
    let whole = hex(&whole.finalize());
    let whole_without_junk =
        without.map_or_else(|| whole.clone(), |digest| hex(&digest.finalize()));
    Ok(Hashed {
        files,
        whole,
        whole_without_junk,
    })
}

/// A large file, read in order straight into the fingerprints.
fn stream(
    path: &Path,
    file: &Found,
    buffer: &mut [u8],
    whole: &mut Sha256,
    mut others: Option<&mut Sha256>,
    cancel: &AtomicBool,
) -> Result<[u8; 32], String> {
    let failed = |error: std::io::Error| format!("cannot read {}: {error}", path.display());
    let mut handle = File::open(path).map_err(failed)?;
    // Framed with the length when opened, as earlier engines did.
    let length = handle.metadata().map_err(failed)?.len();
    frame(whole, &file.path, length);
    if let Some(digest) = others.as_deref_mut() {
        frame(digest, &file.path, length);
    }
    let mut own = Sha256::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("the seed check was stopped".to_owned());
        }
        let read = handle.read(buffer).map_err(failed)?;
        if read == 0 {
            break;
        }
        let bytes = &buffer[..read];
        own.update(bytes);
        whole.update(bytes);
        if let Some(digest) = others.as_deref_mut() {
            digest.update(bytes);
        }
    }
    Ok(own.finalize().into())
}

/// Hashes only `files`, several at a time; order does not matter here.
fn hash_some(root: &Path, files: &[&Found], cancel: &AtomicBool) -> Result<Vec<[u8; 32]>, String> {
    let next = AtomicUsize::new(0);
    let results = Mutex::new(vec![None; files.len()]);
    let workers = std::thread::available_parallelism()
        .map_or(4, |n| n.get().clamp(2, 12))
        .min(files.len().max(1));
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                let mut buffer = vec![0_u8; BUFFER];
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(file) = files.get(index) else { return };
                    let hash = if cancel.load(Ordering::Relaxed) {
                        Err("the seed check was stopped".to_owned())
                    } else {
                        hash_file(&root.join(&file.path), &mut buffer)
                    };
                    results.lock().unwrap_or_else(PoisonError::into_inner)[index] = Some(hash);
                }
            });
        }
    });
    results
        .into_inner()
        .unwrap_or_else(PoisonError::into_inner)
        .into_iter()
        .map(|hash| hash.unwrap_or_else(|| Err("a seed file was not read".to_owned())))
        .collect()
}

fn hash_file(path: &Path, buffer: &mut [u8]) -> Result<[u8; 32], String> {
    let failed = |error: std::io::Error| format!("cannot read {}: {error}", path.display());
    let mut file = File::open(path).map_err(failed)?;
    let mut digest = Sha256::new();
    loop {
        let length = file.read(buffer).map_err(failed)?;
        if length == 0 {
            return Ok(digest.finalize().into());
        }
        digest.update(&buffer[..length]);
    }
}

/// The record written beside the receipt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Record {
    version: u32,
    /// The receipt's whole-seed fingerprint this record belongs to: a
    /// record left from another receipt is ignored.
    pub(super) seed_sha256: String,
    /// When the details were taken, in nanoseconds since 1970.
    recorded_at: i64,
    files: Vec<RecordedFile>,
}

/// `[path, size, modified, changed, sha256]`, kept as an array: a large seed
/// has tens of thousands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct RecordedFile(String, u64, i64, i64, String);

impl Record {
    /// The record of `found` (the operating system's files left out), with
    /// each file's hash from the same read.
    pub(super) fn new(found: &[Found], hashes: &[[u8; 32]], seed_sha256: &str) -> Self {
        Self::taken(
            found
                .iter()
                .zip(hashes)
                .filter(|(file, _)| !file.junk)
                .map(|(file, hash)| {
                    RecordedFile(
                        file.path.clone(),
                        file.size,
                        file.modified,
                        file.changed,
                        hex(hash),
                    )
                })
                .collect(),
            seed_sha256,
        )
    }

    fn taken(files: Vec<RecordedFile>, seed_sha256: &str) -> Self {
        Self {
            version: VERSION,
            seed_sha256: seed_sha256.to_owned(),
            recorded_at: now(),
            files,
        }
    }

    pub(super) fn files(&self) -> usize {
        self.files.len()
    }

    /// The record saved in `state`, when there is one this engine reads.
    pub(super) fn read(state: &Path) -> Option<Self> {
        let bytes = fs::read(state.join(RECORD)).ok()?;
        serde_json::from_slice::<Self>(&bytes)
            .ok()
            .filter(|record| record.version == VERSION)
    }

    /// Replaces the saved record in one step.
    pub(super) fn write(&self, state: &Path) -> Result<(), String> {
        let temporary = state.join(format!("{RECORD}.tmp"));
        let failed = |error: std::io::Error| format!("cannot save the seed record: {error}");
        // A temporary left by an interrupted write is the record's own.
        match fs::remove_file(&temporary) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(failed(error));
            }
            _ => {}
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(failed)?;
        file.write_all(&serde_json::to_vec(self).map_err(|error| error.to_string())?)
            .map_err(failed)?;
        file.sync_all().map_err(failed)?;
        fs::rename(&temporary, state.join(RECORD)).map_err(failed)
    }
}

/// How the seed on disk differs from its record.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Changes {
    pub(super) changed: Vec<String>,
    pub(super) added: Vec<String>,
    pub(super) removed: Vec<String>,
}

impl Changes {
    pub(super) fn is_empty(&self) -> bool {
        self.changed.is_empty() && self.added.is_empty() && self.removed.is_empty()
    }
}

pub(super) enum Verdict {
    /// The seed is as recorded. A record to save when some details were
    /// taken again (a file touched but not changed, or one recorded too
    /// close to its last change to trust its times).
    Same(Option<Record>),
    Changed(Changes),
}

/// Compares the seed's files with the record: only a file whose details
/// differ is read, to tell a touched file from a changed one.
pub(super) fn compare(
    root: &Path,
    record: &Record,
    found: &[Found],
    cancel: &AtomicBool,
) -> Result<Verdict, String> {
    let mut recorded = record
        .files
        .iter()
        .map(|file| (file.0.as_str(), file))
        .collect::<HashMap<_, _>>();
    let mut changes = Changes::default();
    let mut doubtful = Vec::new();
    for file in found.iter().filter(|file| !file.junk) {
        let Some(saved) = recorded.remove(file.path.as_str()) else {
            changes.added.push(file.path.clone());
            continue;
        };
        if saved.1 != file.size {
            changes.changed.push(file.path.clone());
        } else if saved.2 != file.modified
            || saved.3 != file.changed
            || saved.2.max(saved.3).saturating_add(RACY_NANOS) > record.recorded_at
        {
            doubtful.push((file, saved));
        }
    }
    changes.removed = recorded.into_keys().map(str::to_owned).collect();
    changes.removed.sort();
    if !changes.is_empty() {
        return Ok(Verdict::Changed(changes));
    }
    if doubtful.is_empty() {
        return Ok(Verdict::Same(None));
    }
    let read = doubtful.iter().map(|(file, _)| *file).collect::<Vec<_>>();
    let hashes = hash_some(root, &read, cancel)?;
    let mut retaken = HashMap::new();
    for ((file, saved), hash) in doubtful.iter().zip(&hashes) {
        if hex(hash) == saved.4 {
            retaken.insert(file.path.as_str(), (file.modified, file.changed));
        } else {
            changes.changed.push(file.path.clone());
        }
    }
    if !changes.is_empty() {
        return Ok(Verdict::Changed(changes));
    }
    let files = record
        .files
        .iter()
        .map(|file| match retaken.get(file.0.as_str()) {
            Some(&(modified, inode_changed)) => RecordedFile(
                file.0.clone(),
                file.1,
                modified,
                inode_changed,
                file.4.clone(),
            ),
            None => file.clone(),
        })
        .collect();
    Ok(Verdict::Same(Some(Record::taken(
        files,
        &record.seed_sha256,
    ))))
}

/// The seed's non-junk files, to tell whether it changed while it was read.
pub(super) fn details(found: &[Found]) -> Vec<(&str, u64, i64, i64)> {
    found
        .iter()
        .filter(|file| !file.junk)
        .map(|file| (file.path.as_str(), file.size, file.modified, file.changed))
        .collect()
}
