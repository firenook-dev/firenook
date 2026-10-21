//! Fail-closed native-state reuse. This is working data, never a disposable cache.

mod seed;

use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{SuiteConfig, SuiteRuntimeError, failure, terminal};

const LOCK: &str = ".firenook-suite.lock";
const RECEIPT: &str = "native-state.json";
// Increment on incompatible native Firestore/Auth/Storage format changes. This
// receipt is deliberately independent of compiler version and network ports.
const FORMAT: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    format: u32,
    project: String,
    default_bucket: String,
    buckets: Vec<String>,
    /// The `--import` seed the data was first imported from; empty for data
    /// started without one, which then never takes a seed.
    seed_path: PathBuf,
    /// The whole-seed fingerprint, in the format every engine computes, so
    /// that saved data stays readable by earlier ones. This engine compares
    /// the seed through its record (`native-seed.json`) instead.
    seed_sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    complete: bool,
    identity: Identity,
}

impl Identity {
    /// The seed the data came from; `None` when it was started without one.
    fn seed(&self) -> Option<&Path> {
        (!self.seed_path.as_os_str().is_empty()).then_some(self.seed_path.as_path())
    }
}

/// A first import under way: the seed's files as they were when it began,
/// and the read that hashes them meanwhile.
struct Import {
    seed: PathBuf,
    before: Vec<seed::Found>,
    hashing: Option<JoinHandle<Result<seed::Hashed, String>>>,
    cancel: Arc<AtomicBool>,
}

impl Import {
    /// Takes the seed's files' details and starts hashing them.
    fn begin(seed: &Path) -> Result<Self, SuiteRuntimeError> {
        let before = seed::scan(seed).map_err(refused)?;
        let cancel = Arc::new(AtomicBool::new(false));
        let hashing = {
            let seed = seed.to_owned();
            let found = before.clone();
            let cancel = Arc::clone(&cancel);
            std::thread::Builder::new()
                .name("firenook-seed".to_owned())
                .spawn(move || seed::hash_all(&seed, &found, &cancel, false))
                .map_err(io_error)?
        };
        Ok(Self {
            seed: seed.to_owned(),
            before,
            hashing: Some(hashing),
            cancel,
        })
    }
}

pub(super) struct NativeState {
    _lock: File,
    root: PathBuf,
    identity: Option<Identity>,
    reusing: bool,
    /// The receipt was written incomplete by this start, which completes it
    /// once the stores exist.
    first_start: bool,
    import: Option<Import>,
}

impl NativeState {
    pub(super) fn acquire(config: &SuiteConfig) -> Result<Self, SuiteRuntimeError> {
        let root = resolve_path(&config.state_dir)?;
        if config.resume_state {
            if config.firestore_in_memory {
                return Err(refused("native resume requires disk/WAL mode"));
            }
            if let Some(seed) = seed_path(config)? {
                reject_overlap(&root, &seed)?;
            }
            if let Some(destination) = &config.export_on_exit {
                validate_export_destination(config, destination)?;
            }
        }
        fs::create_dir_all(&root).map_err(io_error)?;
        let mut guard = Self {
            _lock: lock(&root)?,
            root,
            identity: None,
            reusing: false,
            first_start: false,
            import: None,
        };
        let receipt_path = guard.root.join(RECEIPT);
        if !config.resume_state {
            if receipt_path.exists() {
                let seedless = read_receipt(&guard.root)
                    .is_ok_and(|receipt| receipt.identity.seed().is_none());
                return Err(refused(if seedless {
                    "this is saved data, started without a seed: pass --resume-state to keep using it"
                } else {
                    "managed state requires --resume-state and its original --import seed"
                }));
            }
            return Ok(guard);
        }

        let seed = seed_path(config)?;
        let mut buckets = match &config.storage_rules {
            crate::StorageRulesConfig::Single(_)
            | crate::StorageRulesConfig::OpenDefault
            | crate::StorageRulesConfig::OpenDefaultIgnoringTargets => {
                vec![config.default_bucket.clone()]
            }
            crate::StorageRulesConfig::PerBucket(buckets) => buckets
                .iter()
                .map(|bucket| bucket.bucket.clone())
                .collect::<Vec<_>>(),
        };
        buckets.sort();
        buckets.dedup();
        let mut identity = Identity {
            format: FORMAT,
            project: config.project_id.clone(),
            default_bucket: config.default_bucket.clone(),
            buckets,
            // Data started without a seed records an empty one, which an
            // earlier engine reads as a seed path that changed and refuses.
            seed_path: seed.unwrap_or_default(),
            seed_sha256: String::new(),
        };
        if receipt_path.exists() {
            let receipt = read_receipt(&guard.root)?;
            if let Some(reason) = mismatch(&receipt, &identity) {
                return Err(refused(reason));
            }
            if receipt.identity.seed().is_some() {
                check_seed(&guard.root, &receipt.identity)?;
            }
            validate_files(&guard.root)?;
            identity.seed_sha256 = receipt.identity.seed_sha256;
            guard.reusing = true;
        } else {
            for entry in fs::read_dir(&guard.root).map_err(io_error)? {
                if entry.map_err(io_error)?.file_name() != LOCK {
                    return Err(refused("nonempty state has no completion receipt"));
                }
            }
            // The seed is read once, beside the import: its files' details
            // now, their hashes meanwhile, and a second look at the end
            // catches a seed edited while it was being imported. Without a
            // seed there is nothing to read.
            guard.import = identity.seed().map(Import::begin).transpose()?;
            write_receipt(
                &guard.root,
                &Receipt {
                    complete: false,
                    identity: identity.clone(),
                },
            )?;
            guard.first_start = true;
        }
        guard.identity = Some(identity);
        Ok(guard)
    }

    pub(super) fn reusing(&self) -> bool {
        self.reusing
    }

    pub(super) fn complete(&mut self) -> Result<(), SuiteRuntimeError> {
        let Some(identity) = &mut self.identity else {
            return Ok(());
        };
        validate_files(&self.root)?;
        if !self.first_start {
            return Ok(());
        }
        // Data started without a seed is complete once its stores exist.
        let Some(mut import) = self.import.take() else {
            write_receipt(
                &self.root,
                &Receipt {
                    complete: true,
                    identity: identity.clone(),
                },
            )?;
            self.first_start = false;
            return Ok(());
        };
        let hashing = import
            .hashing
            .take()
            .ok_or_else(|| refused("seed read lost"))?;
        // A large seed may still be reading after a quick import.
        let waiting = (!hashing.is_finished()).then(|| terminal::Step::begin("data", "recording"));
        let hashed = hashing
            .join()
            .map_err(|_| refused("the seed read panicked"))?
            .map_err(refused)?;
        let after = seed::scan(&import.seed).map_err(refused)?;
        if seed::details(&after) != seed::details(&import.before) {
            if let Some(step) = waiting {
                step.failed("the seed changed");
            }
            return Err(refused("seed changed during import"));
        }
        let record = seed::Record::new(&import.before, &hashed.files, &hashed.whole);
        record.write(&self.root).map_err(refused)?;
        identity.seed_sha256 = hashed.whole;
        write_receipt(
            &self.root,
            &Receipt {
                complete: true,
                identity: identity.clone(),
            },
        )?;
        self.first_start = false;
        if let Some(step) = waiting {
            step.done(&[(record.files() as u64, "seed files")], None);
        }
        Ok(())
    }
}

impl Drop for NativeState {
    fn drop(&mut self) {
        // An import that never completed stops reading its seed.
        if let Some(import) = &mut self.import {
            import.cancel.store(true, Ordering::Relaxed);
            if let Some(hashing) = import.hashing.take() {
                let _ = hashing.join();
            }
        }
    }
}

fn lock(root: &Path) -> Result<File, SuiteRuntimeError> {
    let lock_path = root.join(LOCK);
    if lock_path.exists() {
        require_file(&lock_path)?;
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(io_error)?;
    lock.try_lock()
        .map_err(|error| refused(format!("suite state is locked: {error}")))?;
    Ok(lock)
}

fn read_receipt(root: &Path) -> Result<Receipt, SuiteRuntimeError> {
    let path = root.join(RECEIPT);
    require_file(&path)?;
    serde_json::from_slice(&fs::read(&path).map_err(io_error)?)
        .map_err(|error| refused(format!("invalid completion receipt: {error}")))
}

/// Whether the seed is still the one the saved data came from. With a
/// record, only the files whose details changed are read; without one (data
/// an earlier engine saved), the seed is read once and the record written.
fn check_seed(root: &Path, saved: &Identity) -> Result<(), SuiteRuntimeError> {
    // A stop asked for meanwhile ends the read: nothing was opened yet.
    let cancel = crate::control::stop_flag();
    let read_failed = |error: String| {
        if crate::control::stop_requested() {
            crate::stopped_while_starting()
        } else {
            refused(error)
        }
    };
    let seed = &saved.seed_path;
    let found = seed::scan(seed).map_err(refused)?;
    let record = seed::Record::read(root).filter(|record| record.seed_sha256 == saved.seed_sha256);
    if let Some(record) = record {
        return match seed::compare(seed, &record, &found, cancel).map_err(read_failed)? {
            seed::Verdict::Same(retaken) => {
                // Only details taken again: keeping the old record costs a
                // re-read next time, never a wrong answer.
                if let Some(retaken) = retaken {
                    let _ = retaken.write(root);
                }
                Ok(())
            }
            seed::Verdict::Changed(changes) => {
                terminal::emit(&json!({
                    "type": "seed", "whole": false,
                    "changed": first(&changes.changed), "added": first(&changes.added),
                    "removed": first(&changes.removed),
                    "counts": [changes.changed.len(), changes.added.len(), changes.removed.len()],
                    "finder": [],
                }));
                Err(refused_seed(
                    &format!(
                        "the seed {} changed after it was imported: {}",
                        seed.display(),
                        summary(&changes)
                    ),
                    root,
                    seed,
                ))
            }
        };
    }
    let hashed = seed::hash_all(seed, &found, cancel, true).map_err(read_failed)?;
    // The whole-seed fingerprint is accepted with or without the files an
    // operating system wrote since: no importer reads them.
    if saved.seed_sha256 != hashed.whole && saved.seed_sha256 != hashed.whole_without_junk {
        let finder = found
            .iter()
            .filter(|file| file.junk)
            .map(|file| file.path.clone())
            .collect::<Vec<_>>();
        terminal::emit(&json!({
            "type": "seed", "whole": true, "changed": [], "added": [], "removed": [],
            "counts": [0, 0, 0], "finder": first(&finder),
        }));
        let mut reason = format!(
            "the seed {} changed after it was imported (the data was saved by an earlier Firenook, which kept one fingerprint for the whole seed, so the files that changed cannot be named",
            seed.display()
        );
        if let Some(file) = finder.first() {
            let _ = write!(reason, "; the seed holds {file}, which Finder writes");
        }
        reason.push(')');
        return Err(refused_seed(&reason, root, seed));
    }
    seed::Record::new(&found, &hashed.files, &saved.seed_sha256)
        .write(root)
        .map_err(refused)
}

/// The first few names of a list.
fn first(names: &[String]) -> &[String] {
    &names[..names.len().min(3)]
}

/// `2 changed (a, b), 1 added (c)`, for the plain log.
fn summary(changes: &seed::Changes) -> String {
    [
        ("changed", &changes.changed),
        ("added", &changes.added),
        ("removed", &changes.removed),
    ]
    .into_iter()
    .filter(|(_, names)| !names.is_empty())
    .map(|(what, names)| {
        let more = names.len() - first(names).len();
        let mut listed = first(names).join(", ");
        if more > 0 {
            let _ = write!(listed, " and {more} more");
        }
        format!("{} {what} ({listed})", names.len())
    })
    .collect::<Vec<_>>()
    .join(", ")
}

/// What `firenook state:adopt-seed` did.
#[derive(Debug)]
pub struct AdoptedSeed {
    pub previous_seed: PathBuf,
    pub seed: PathBuf,
    pub files: usize,
    pub backup: PathBuf,
}

/// Records the seed as it is now as the one the saved data came from,
/// keeping the data: the way out when the seed changed in a way that does not
/// matter to it. The previous receipt is kept beside the new one.
pub fn adopt_seed(state_dir: &Path, seed: &Path) -> Result<AdoptedSeed, SuiteRuntimeError> {
    let root = fs::canonicalize(state_dir)
        .map_err(|error| refused(format!("no saved data at {}: {error}", state_dir.display())))?;
    let _lock = lock(&root)?;
    let mut receipt = read_receipt(&root)?;
    if !receipt.complete {
        return Err(refused(
            "the import that made it did not finish, and adopting a seed cannot finish it",
        ));
    }
    if receipt.identity.seed().is_none() {
        return Err(refused(format!(
            "it was started without a seed, so it has none to replace, and data started without a seed never takes one; to start from {}, import it",
            seed.display()
        )));
    }
    let seed = validate_seed(seed)?;
    reject_overlap(&root, &seed)?;
    let found = seed::scan(&seed).map_err(refused)?;
    let hashed = seed::hash_all(&seed, &found, &AtomicBool::new(false), false).map_err(refused)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    let backup = root.join(format!("{RECEIPT}.before-adopt-{stamp}"));
    fs::copy(root.join(RECEIPT), &backup).map_err(io_error)?;
    let record = seed::Record::new(&found, &hashed.files, &hashed.whole);
    record.write(&root).map_err(refused)?;
    let previous_seed = std::mem::replace(&mut receipt.identity.seed_path, seed.clone());
    receipt.identity.seed_sha256 = hashed.whole;
    write_receipt(&root, &receipt)?;
    Ok(AdoptedSeed {
        previous_seed,
        seed,
        files: record.files(),
        backup,
    })
}

/// The `--import` seed, validated; `None` for a start without one.
fn seed_path(config: &SuiteConfig) -> Result<Option<PathBuf>, SuiteRuntimeError> {
    config.import.as_deref().map(validate_seed).transpose()
}

/// The seed's canonical path, once its manifest is known to point inside it.
fn validate_seed(seed: &Path) -> Result<PathBuf, SuiteRuntimeError> {
    let seed = fs::canonicalize(seed).map_err(io_error)?;
    require_file(&seed.join("firebase-export-metadata.json"))?;
    let manifest = crate::read_export_metadata(&seed)?;
    for path in [
        manifest.firestore.map(|value| value.metadata_file),
        manifest.auth.map(|value| value.path),
        manifest.storage.map(|value| value.path),
    ]
    .into_iter()
    .flatten()
    {
        if path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
            return Err(refused("seed manifest references a path outside the seed"));
        }
        let resolved = fs::canonicalize(seed.join(path)).map_err(io_error)?;
        if !resolved.starts_with(&seed) {
            return Err(refused("seed manifest escapes the seed through an alias"));
        }
    }
    Ok(seed)
}

pub(super) fn validate_export_destination(
    config: &SuiteConfig,
    destination: &Path,
) -> Result<(), SuiteRuntimeError> {
    let destination = resolve_path(destination)?;
    if let Some(seed) = seed_path(config)? {
        reject_overlap(&destination, &seed)?;
    }
    reject_overlap(&destination, &resolve_path(&config.state_dir)?)
}

fn reject_overlap(left: &Path, right: &Path) -> Result<(), SuiteRuntimeError> {
    if left.starts_with(right) || right.starts_with(left) {
        return Err(refused(
            "seed, native state, and export destinations must be separate, non-nested paths",
        ));
    }
    Ok(())
}

fn resolve_path(path: &Path) -> Result<PathBuf, SuiteRuntimeError> {
    if path.exists() {
        return fs::canonicalize(path).map_err(io_error);
    }
    if path.components().any(|part| part == Component::ParentDir) {
        return Err(refused(
            "use an absolute path without '..' for a new state/export directory",
        ));
    }
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir().map_err(io_error)?.join(path)
    };
    let parent = absolute
        .parent()
        .ok_or_else(|| refused("invalid state/export path"))?;
    let name = absolute
        .file_name()
        .ok_or_else(|| refused("invalid state/export path"))?;
    Ok(resolve_path(parent)?.join(name))
}

fn validate_files(root: &Path) -> Result<(), SuiteRuntimeError> {
    for directory in ["firestore", "storage", "storage/objects"] {
        if !fs::symlink_metadata(root.join(directory))
            .map_err(io_error)?
            .is_dir()
        {
            return Err(refused(format!(
                "missing or non-directory native state: {directory}"
            )));
        }
    }
    // State written before the rename keeps its data: the store files are
    // renamed in place once, before the structural check.
    firenook_core_store::adopt_legacy_files(&root.join("firestore")).map_err(io_error)?;
    for file in [
        "firestore/firenook.redb",
        "firestore/firenook.wal",
        "auth-state.json",
        "storage/metadata.json",
        "storage/metadata.redb",
    ] {
        require_file(&root.join(file))?;
    }
    // Typed Auth/Storage loaders and the redb/WAL parser validate their own formats
    // after this structural check, before listeners open. Storage checks blobs too.
    Ok(())
}

/// Why saved state does not match this start, in the developer's terms;
/// `None` when it does.
fn mismatch(receipt: &Receipt, identity: &Identity) -> Option<String> {
    let saved = &receipt.identity;
    if !receipt.complete {
        return Some(if saved.seed().is_some() {
            "the import that made it did not finish".to_owned()
        } else {
            "the first start that made it did not finish".to_owned()
        });
    }
    if saved.format != identity.format {
        return Some(format!(
            "it was written in state format {}, and this engine reads format {}",
            saved.format, identity.format
        ));
    }
    if saved.project != identity.project {
        return Some(format!(
            "it belongs to project {}, not {}",
            saved.project, identity.project
        ));
    }
    if saved.default_bucket != identity.default_bucket || saved.buckets != identity.buckets {
        return Some(format!(
            "it holds the Storage buckets {}, and this start serves {}",
            saved.buckets.join(", "),
            identity.buckets.join(", ")
        ));
    }
    match (saved.seed(), identity.seed()) {
        (None, Some(seed)) => {
            return Some(format!(
                "this data was started without a seed, so it cannot take the seed {}: start without --import to keep using it",
                seed.display()
            ));
        }
        (Some(saved), None) => {
            return Some(format!(
                "it was imported from {}: pass --import {} to keep using it",
                saved.display(),
                quoted(saved)
            ));
        }
        _ => {}
    }
    if saved.seed_path != identity.seed_path {
        return Some(format!(
            "it was imported from {}, not {}",
            saved.seed_path.display(),
            identity.seed_path.display()
        ));
    }
    None
}

fn require_file(path: &Path) -> Result<(), SuiteRuntimeError> {
    if !fs::symlink_metadata(path).map_err(io_error)?.is_file() {
        return Err(refused(format!(
            "required regular file missing: {}",
            path.display()
        )));
    }
    Ok(())
}

fn write_receipt(root: &Path, receipt: &Receipt) -> Result<(), SuiteRuntimeError> {
    let temporary = root.join("native-state.json.tmp");
    // create_new refuses stale temporary files left by interrupted publication.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(io_error)?;
    file.write_all(
        &serde_json::to_vec_pretty(receipt).map_err(|error| failure(error.to_string()))?,
    )
    .map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    fs::rename(temporary, root.join(RECEIPT)).map_err(io_error)?;
    #[cfg(unix)]
    File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(io_error)?;
    Ok(())
}

/// A seed that changed: both ways on, as the developer would type them.
/// Saved data's Firestore store, locked against a running emulator for as
/// long as the returned lock lives.
fn stopped_store(state_dir: &Path) -> Result<(File, PathBuf), SuiteRuntimeError> {
    let root = fs::canonicalize(state_dir)
        .map_err(|error| failure(format!("no saved data at {}: {error}", state_dir.display())))?;
    let lock = lock(&root).map_err(|_| {
        failure(format!(
            "{} is in use: stop the emulator first",
            root.display()
        ))
    })?;
    let firestore = root.join("firestore");
    if !firestore.join(STORE_FILE).is_file() {
        return Err(failure(format!("no Firestore data in {}", root.display())));
    }
    Ok((lock, firestore))
}

/// The Firestore store's file in its directory.
const STORE_FILE: &str = "firenook.redb";

/// What saved data's Firestore file holds; see
/// [`firenook_core_store::maintenance::inspect`].
pub fn inspect_state(
    state_dir: &Path,
) -> Result<(PathBuf, firenook_core_store::maintenance::StoreSize), SuiteRuntimeError> {
    let (_lock, firestore) = stopped_store(state_dir)?;
    firenook_core_store::maintenance::inspect(&firestore)
        .map(|size| (firestore.join(STORE_FILE), size))
        .map_err(|error| failure(format!("could not read the Firestore store: {error}")))
}

/// What `firenook state:compact` did.
#[derive(Debug)]
pub struct CompactedState {
    pub file: PathBuf,
    pub compaction: firenook_core_store::maintenance::Compaction,
}

/// Compacts saved data's Firestore file. With `copy_first`, the file is
/// copied beside itself first (a copy-on-write clone where the file system
/// has one) and the copy removed once the compaction succeeds; an
/// interrupted compaction otherwise leaves the next start a repair that
/// reads the whole file.
pub fn compact_state(
    state_dir: &Path,
    copy_first: bool,
) -> Result<CompactedState, SuiteRuntimeError> {
    let (_lock, firestore) = stopped_store(state_dir)?;
    let file = firestore.join(STORE_FILE);
    let copy = if copy_first {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_secs());
        let copy = firestore.join(format!("{STORE_FILE}.before-compact-{stamp}"));
        if let Err(error) = fs::copy(&file, &copy) {
            let _ = fs::remove_file(&copy);
            return Err(failure(format!(
                "could not copy the store before compacting it ({error}); nothing was changed. Free some disk, or pass --no-copy to compact without a copy"
            )));
        }
        Some(copy)
    } else {
        None
    };
    let options = firenook_core_store::DiskOptions {
        field_indexes: firenook_core_store::field_indexes_from_env(),
        ..firenook_core_store::DiskOptions::default()
    };
    match firenook_core_store::maintenance::compact(&firestore, options) {
        Ok(compaction) => {
            if let Some(copy) = &copy {
                let _ = fs::remove_file(copy);
            }
            Ok(CompactedState { file, compaction })
        }
        Err(error) => Err(failure(match copy {
            Some(copy) => format!(
                "the compaction failed: {error}. The copy taken first is {}; the store itself is repaired at the next start",
                copy.display()
            ),
            None => {
                format!("the compaction failed: {error}. The store is repaired at the next start")
            }
        })),
    }
}

fn refused_seed(reason: &str, state: &Path, seed: &Path) -> SuiteRuntimeError {
    failure(format!(
        "native state refused: {reason}; existing data preserved. Import the changed seed with a NEW --state-dir, or keep this data with the seed as it is now: firenook state:adopt-seed --state-dir {} --import {}",
        quoted(state),
        quoted(seed)
    ))
}

fn quoted(path: &Path) -> String {
    let text = path.display().to_string();
    if text.contains(|character: char| character.is_whitespace() || "\"'$`".contains(character)) {
        format!("{text:?}")
    } else {
        text
    }
}

fn io_error(error: impl std::fmt::Display) -> SuiteRuntimeError {
    refused(error.to_string())
}
fn refused(message: impl std::fmt::Display) -> SuiteRuntimeError {
    failure(format!(
        "native state refused: {message}; existing data preserved. Use a NEW --state-dir for an explicit fresh import; do not delete the previous directory."
    ))
}

#[cfg(test)]
mod tests;
