//! Transactional internal metadata. HTTP/export representations remain JSON.
//! Ordinary mutations encode one record, not the whole bucket inventory.
//!
//! Durability follows the Firestore store's contract (see
//! `fireside_core_store::DiskDurability`). Under write-behind, each mutation
//! is appended to `metadata.journal` with a plain `write` and committed to
//! redb without a sync, so it survives the process; the flusher then syncs
//! the object files written since the last flush, syncs the journal, commits
//! redb durably with the applied journal sequence, and truncates the journal.
//! Opening replays journal entries newer than the durable sequence. Power
//! loss can lose at most the mutations of the last interval, and never leaves
//! metadata pointing at an object whose bytes were not also synced.
use std::fs::{File, OpenOptions};
use std::io::{BufRead as _, BufReader, Seek as _, SeekFrom, Write as _};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use redb::{Database, Durability, ReadableDatabase as _, ReadableTable as _, TableDefinition};
use serde::{Deserialize, Serialize};

use super::{FilePath, StorageData, StorageError, load_state};

const OBJECTS: TableDefinition<&str, &[u8]> = TableDefinition::new("objects");
const UPLOADS: TableDefinition<&str, &[u8]> = TableDefinition::new("uploads");
const HEADER: TableDefinition<&str, u64> = TableDefinition::new("header");
const FORMAT: u64 = 1;
const CACHE_BYTES: usize = 4 * 1024 * 1024;
const JOURNAL_FILE: &str = "metadata.journal";

/// When an acknowledged Storage mutation becomes durable against power loss.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageDurability {
    /// Every object write is synced and every metadata commit is durable
    /// before the request is acknowledged.
    PerCommit,
    /// Requests are acknowledged after the journal `write` and a non-durable
    /// metadata commit; a background flusher makes them durable every
    /// `interval`, as does shutdown.
    WriteBehind {
        /// Maximum age of an unflushed mutation.
        interval: Duration,
    },
}

impl Default for StorageDurability {
    fn default() -> Self {
        Self::WriteBehind {
            interval: Duration::from_secs(1),
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum Change<'a> {
    Object(&'a str),
    Upload(&'a str),
}

#[derive(Serialize, Deserialize)]
struct JournalEntry {
    seq: u64,
    table: JournalTable,
    key: String,
    /// The record's JSON, or null for a removal.
    value: Option<serde_json::Value>,
    next_id: u64,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum JournalTable {
    Objects,
    Uploads,
}

struct WriteBehindState {
    journal: File,
    /// Sequence of the newest journal entry (0 when the journal is empty).
    seq: u64,
    /// Sequence durably recorded in redb's header.
    durable_seq: u64,
    /// Object files written since the last flush; synced before the
    /// metadata that references them becomes durable.
    pending_files: Vec<PathBuf>,
}

pub(super) struct MetadataStore {
    database: Database,
    durability: StorageDurability,
    write_behind: Option<Mutex<WriteBehindState>>,
}

impl MetadataStore {
    pub(super) fn open(
        root: &FilePath,
        durability: StorageDurability,
    ) -> Result<(Self, StorageData), StorageError> {
        let path = root.join("metadata.redb");
        let exists = path.try_exists().map_err(error)?;
        // Never fall back to stale JSON when an existing database is invalid.
        // A failed first migration leaves the legacy input untouched and fails
        // closed on the next open rather than guessing which copy is current.
        let legacy = if exists {
            None
        } else {
            Some(load_state(&root.join("metadata.json"))?)
        };
        let mut builder = Database::builder();
        builder.set_cache_size(CACHE_BYTES);
        let database = if exists {
            builder.open(&path)
        } else {
            builder.create(&path)
        }
        .map_err(error)?;
        let mut store = Self {
            database,
            durability,
            write_behind: None,
        };
        let mut data = if let Some(data) = legacy {
            store.replace(&data)?;
            // redb's immediate commit flushes its file on every platform.
            // Directory fsync is an additional Unix operation, not a Win32 API.
            #[cfg(unix)]
            std::fs::File::open(root)
                .and_then(|directory| directory.sync_all())
                .map_err(error)?;
            data
        } else {
            store.load()?
        };
        // A journal left by a previous process is replayed whatever the
        // configured durability, so switching modes never drops mutations.
        let durable_seq = store.applied_seq()?;
        let journal_path = root.join(JOURNAL_FILE);
        let replayed = store.replay_journal(&journal_path, durable_seq, &mut data)?;
        if let StorageDurability::WriteBehind { .. } = durability {
            let mut journal = OpenOptions::new()
                .create(true)
                .truncate(true)
                .read(true)
                .write(true)
                .open(&journal_path)
                .map_err(error)?;
            journal.seek(SeekFrom::End(0)).map_err(error)?;
            store.write_behind = Some(Mutex::new(WriteBehindState {
                journal,
                seq: replayed,
                durable_seq: replayed,
                pending_files: Vec::new(),
            }));
        } else if journal_path.exists() {
            std::fs::remove_file(&journal_path).map_err(error)?;
        }
        Ok((store, data))
    }

    fn applied_seq(&self) -> Result<u64, StorageError> {
        let transaction = self.database.begin_read().map_err(error)?;
        let header = transaction.open_table(HEADER).map_err(error)?;
        Ok(header
            .get("applied_seq")
            .map_err(error)?
            .map_or(0, |value| value.value()))
    }

    /// Applies journal entries newer than `durable_seq` in one durable redb
    /// commit and returns the newest applied sequence. A torn final line
    /// (power loss mid-write) ends the replay silently; a gap or regression
    /// in sequence numbers is corruption and fails closed.
    fn replay_journal(
        &self,
        path: &FilePath,
        durable_seq: u64,
        data: &mut StorageData,
    ) -> Result<u64, StorageError> {
        if !path.exists() {
            return Ok(durable_seq);
        }
        let reader = BufReader::new(File::open(path).map_err(error)?);
        let mut entries = Vec::new();
        for line in reader.split(b'\n') {
            let line = line.map_err(error)?;
            let Ok(entry) = serde_json::from_slice::<JournalEntry>(&line) else {
                break;
            };
            entries.push(entry);
        }
        let mut applied = durable_seq;
        let pending = entries
            .into_iter()
            .filter(|entry| entry.seq > durable_seq)
            .collect::<Vec<_>>();
        if pending.is_empty() {
            return Ok(applied);
        }
        let mut transaction = self.database.begin_write().map_err(error)?;
        transaction
            .set_durability(Durability::Immediate)
            .map_err(error)?;
        {
            let mut objects = transaction.open_table(OBJECTS).map_err(error)?;
            let mut uploads = transaction.open_table(UPLOADS).map_err(error)?;
            for entry in &pending {
                if entry.seq != applied.saturating_add(1) {
                    return Err(StorageError(format!(
                        "Storage metadata journal sequence {} does not follow {applied}",
                        entry.seq
                    )));
                }
                let bytes = entry
                    .value
                    .as_ref()
                    .map(serde_json::to_vec)
                    .transpose()
                    .map_err(error)?;
                match (entry.table, bytes) {
                    (JournalTable::Objects, Some(bytes)) => {
                        objects
                            .insert(entry.key.as_str(), bytes.as_slice())
                            .map_err(error)?;
                        data.objects.insert(
                            entry.key.clone(),
                            serde_json::from_slice(&bytes).map_err(error)?,
                        );
                    }
                    (JournalTable::Objects, None) => {
                        objects.remove(entry.key.as_str()).map_err(error)?;
                        data.objects.remove(&entry.key);
                    }
                    (JournalTable::Uploads, Some(bytes)) => {
                        uploads
                            .insert(entry.key.as_str(), bytes.as_slice())
                            .map_err(error)?;
                        data.uploads.insert(
                            entry.key.clone(),
                            serde_json::from_slice(&bytes).map_err(error)?,
                        );
                    }
                    (JournalTable::Uploads, None) => {
                        uploads.remove(entry.key.as_str()).map_err(error)?;
                        data.uploads.remove(&entry.key);
                    }
                }
                data.next_id = data.next_id.max(entry.next_id);
                applied = entry.seq;
            }
        }
        {
            let mut header = transaction.open_table(HEADER).map_err(error)?;
            header.insert("next_id", data.next_id).map_err(error)?;
            header.insert("applied_seq", applied).map_err(error)?;
        }
        transaction.commit().map_err(error)?;
        Ok(applied)
    }

    pub(super) const fn durability(&self) -> StorageDurability {
        self.durability
    }

    /// Records an object file whose bytes were written without a sync; the
    /// next flush syncs it before the metadata that references it is made
    /// durable. A no-op under per-commit durability.
    pub(super) fn note_unsynced_file(&self, path: PathBuf) {
        if let Some(state) = &self.write_behind {
            lock(state).pending_files.push(path);
        }
    }

    /// Whether mutations are waiting for a durable flush.
    #[cfg(test)]
    pub(super) fn has_unflushed(&self) -> bool {
        self.write_behind.as_ref().is_some_and(|state| {
            let state = lock(state);
            state.seq != state.durable_seq || !state.pending_files.is_empty()
        })
    }

    /// Makes every acknowledged mutation durable now. Blocking; callers on an
    /// async runtime use `spawn_blocking`.
    pub(super) fn flush(&self) -> Result<(), StorageError> {
        let Some(write_behind) = &self.write_behind else {
            return Ok(());
        };
        let mut state = lock(write_behind);
        if state.seq == state.durable_seq && state.pending_files.is_empty() {
            return Ok(());
        }
        for path in std::mem::take(&mut state.pending_files) {
            match File::open(&path) {
                Ok(file) => file.sync_all().map_err(error)?,
                // Deleted since it was written: nothing references it.
                Err(io) if io.kind() == std::io::ErrorKind::NotFound => {}
                Err(io) => return Err(error(io)),
            }
        }
        state.journal.sync_all().map_err(error)?;
        let seq = state.seq;
        let mut transaction = self.database.begin_write().map_err(error)?;
        transaction
            .set_durability(Durability::Immediate)
            .map_err(error)?;
        transaction
            .open_table(HEADER)
            .map_err(error)?
            .insert("applied_seq", seq)
            .map_err(error)?;
        transaction.commit().map_err(error)?;
        state.journal.set_len(0).map_err(error)?;
        state.journal.seek(SeekFrom::Start(0)).map_err(error)?;
        state.journal.sync_all().map_err(error)?;
        state.durable_seq = seq;
        Ok(())
    }

    fn load(&self) -> Result<StorageData, StorageError> {
        let transaction = self.database.begin_read().map_err(error)?;
        let header = transaction.open_table(HEADER).map_err(error)?;
        if header.get("format").map_err(error)?.map(|v| v.value()) != Some(FORMAT) {
            return Err(StorageError(
                "unsupported Storage metadata format".to_owned(),
            ));
        }
        let mut data = StorageData {
            next_id: header
                .get("next_id")
                .map_err(error)?
                .ok_or_else(|| StorageError("missing Storage metadata sequence".to_owned()))?
                .value(),
            ..StorageData::default()
        };
        for item in transaction
            .open_table(OBJECTS)
            .map_err(error)?
            .iter()
            .map_err(error)?
        {
            let (key, value) = item.map_err(error)?;
            data.objects.insert(
                key.value().to_owned(),
                serde_json::from_slice(value.value()).map_err(error)?,
            );
        }
        for item in transaction
            .open_table(UPLOADS)
            .map_err(error)?
            .iter()
            .map_err(error)?
        {
            let (key, value) = item.map_err(error)?;
            data.uploads.insert(
                key.value().to_owned(),
                serde_json::from_slice(value.value()).map_err(error)?,
            );
        }
        Ok(data)
    }

    /// Returns bytes encoded, allowing deterministic scaling tests without a
    /// wall-clock threshold. The cache budget and durability are fixed.
    pub(super) fn update(
        &self,
        data: &StorageData,
        change: Change<'_>,
    ) -> Result<usize, StorageError> {
        let journal_table = match change {
            Change::Object(_) => JournalTable::Objects,
            Change::Upload(_) => JournalTable::Uploads,
        };
        let (table, key, value) = match change {
            Change::Object(key) => (
                OBJECTS,
                key,
                data.objects
                    .get(key)
                    .map(serde_json::to_vec)
                    .transpose()
                    .map_err(error)?,
            ),
            Change::Upload(key) => (
                UPLOADS,
                key,
                data.uploads
                    .get(key)
                    .map(serde_json::to_vec)
                    .transpose()
                    .map_err(error)?,
            ),
        };
        let bytes = value.as_ref().map_or(0, Vec::len);
        // Journal first: once the line is written the mutation outlives the
        // process even if the non-durable redb commit below is lost.
        if let Some(write_behind) = &self.write_behind {
            let mut state = lock(write_behind);
            let entry = JournalEntry {
                seq: state.seq.saturating_add(1),
                table: journal_table,
                key: key.to_owned(),
                value: value
                    .as_deref()
                    .map(serde_json::from_slice::<serde_json::Value>)
                    .transpose()
                    .map_err(error)?,
                next_id: data.next_id,
            };
            let mut line = serde_json::to_vec(&entry).map_err(error)?;
            line.push(b'\n');
            state.journal.write_all(&line).map_err(error)?;
            state.seq = entry.seq;
        }
        let mut transaction = self.database.begin_write().map_err(error)?;
        transaction
            .set_durability(match self.durability {
                StorageDurability::PerCommit => Durability::Immediate,
                StorageDurability::WriteBehind { .. } => Durability::None,
            })
            .map_err(error)?;
        {
            let mut records = transaction.open_table(table).map_err(error)?;
            if let Some(value) = value {
                records.insert(key, value.as_slice()).map_err(error)?;
            } else {
                records.remove(key).map_err(error)?;
            }
        }
        transaction
            .open_table(HEADER)
            .map_err(error)?
            .insert("next_id", data.next_id)
            .map_err(error)?;
        transaction.commit().map_err(error)?;
        Ok(bytes)
    }

    /// Whole-state replacement is reserved for import/reset/checkpoint paths.
    /// It is always durable, and it supersedes any journaled mutation.
    pub(super) fn replace(&self, data: &StorageData) -> Result<(), StorageError> {
        if let Some(write_behind) = &self.write_behind {
            let mut state = lock(write_behind);
            state.pending_files.clear();
            state.journal.set_len(0).map_err(error)?;
            state.journal.seek(SeekFrom::Start(0)).map_err(error)?;
            state.durable_seq = state.seq;
        }
        let mut transaction = self.database.begin_write().map_err(error)?;
        transaction
            .set_durability(Durability::Immediate)
            .map_err(error)?;
        transaction.delete_table(OBJECTS).map_err(error)?;
        transaction.delete_table(UPLOADS).map_err(error)?;
        {
            let mut objects = transaction.open_table(OBJECTS).map_err(error)?;
            for (key, object) in &data.objects {
                let value = serde_json::to_vec(object).map_err(error)?;
                objects
                    .insert(key.as_str(), value.as_slice())
                    .map_err(error)?;
            }
        }
        {
            let mut uploads = transaction.open_table(UPLOADS).map_err(error)?;
            for (key, upload) in &data.uploads {
                let value = serde_json::to_vec(upload).map_err(error)?;
                uploads
                    .insert(key.as_str(), value.as_slice())
                    .map_err(error)?;
            }
        }
        {
            let mut header = transaction.open_table(HEADER).map_err(error)?;
            header.insert("format", FORMAT).map_err(error)?;
            header.insert("next_id", data.next_id).map_err(error)?;
            let seq = self
                .write_behind
                .as_ref()
                .map_or(0, |state| lock(state).seq);
            header.insert("applied_seq", seq).map_err(error)?;
        }
        transaction.commit().map_err(error)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn error(error: impl std::fmt::Display) -> StorageError {
    StorageError(format!("Storage metadata persistence failed: {error}"))
}
