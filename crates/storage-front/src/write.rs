//! The one write path, in pieces a caller holding the mutation guard runs.
//!
//! Every object write takes the service's mutation guard, a tokio mutex,
//! which is not reentrant: bulk work that held the guard and called the
//! protocol's write functions would deadlock itself and every writer behind
//! it. So the protocol handlers and the console's bulk work share these
//! inner pieces, each of which runs under a guard its caller already holds:
//! read what is there (for the rules), change the object map, and collect in
//! a [`Pending`] what must follow — the metadata changes to persist (one
//! transaction for the whole batch), the data files nothing names any more,
//! and the Storage events to dispatch once the guard is released. A
//! protocol handler is a one-item batch, so its responses and journal
//! records are what they always were.

use std::path::PathBuf;

use serde_json::Value as JsonValue;
use sha2::{Digest as _, Sha256};

use crate::changes::ChangeContext;
use crate::{
    CommitSpec, StorageApiError, StorageEvent, StorageState, StoredObject, Uploaded,
    apply_metadata, etag, generation, io_error, lock, metadata, now_rfc3339, object_key, stable_id,
    storage_error, uuid_shaped,
};

/// The mutation guard a caller holds while it runs the pieces below.
pub(crate) type MutationGuard<'a> = tokio::sync::MutexGuard<'a, ()>;

/// A metadata record a batch changed.
enum PendingChange {
    Object(String),
    Upload(String),
}

/// What a batch of writes leaves to do: persist, unlink, dispatch.
#[derive(Default)]
pub(crate) struct Pending {
    changes: Vec<PendingChange>,
    unlink: Vec<PathBuf>,
    events: Vec<(u64, StorageEvent, StoredObject)>,
}

impl Pending {
    /// The object at `key` changed (or went).
    pub(crate) fn object(&mut self, key: String) {
        self.changes.push(PendingChange::Object(key));
    }

    /// The upload session `id` changed (or went).
    pub(crate) fn upload(&mut self, id: String) {
        self.changes.push(PendingChange::Upload(id));
    }

    /// A data file nothing names once the batch is persisted.
    pub(crate) fn unlink(&mut self, path: PathBuf) {
        self.unlink.push(path);
    }

    /// The Storage event of the change committed at `revision`.
    pub(crate) fn event(&mut self, revision: u64, event: StorageEvent, object: StoredObject) {
        self.events.push((revision, event, object));
    }

    /// Forgets the files to unlink, as a crash would.
    #[cfg(test)]
    pub(crate) fn keep_files(&mut self) {
        self.unlink.clear();
    }

    /// Persists every change in one metadata transaction (one journal line),
    /// then removes the data files nothing names now. Runs under the
    /// caller's guard: a data file's path is its object's name, so a write
    /// after the guard could otherwise lose its new bytes to this unlink.
    /// The first unlink failure is returned after every file was tried.
    pub(crate) async fn commit(&mut self, state: &StorageState) -> Result<(), StorageApiError> {
        if !self.changes.is_empty() {
            let data = lock(&state.inner);
            let changes = self
                .changes
                .iter()
                .map(|change| match change {
                    PendingChange::Object(key) => metadata::Change::Object(key),
                    PendingChange::Upload(id) => metadata::Change::Upload(id),
                })
                .collect::<Vec<_>>();
            state
                .metadata
                .update_many(&data, &changes)
                .map_err(storage_error)?;
            drop(data);
            self.changes.clear();
        }
        let mut failure = None;
        for path in self.unlink.drain(..) {
            match tokio::fs::remove_file(&path).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    failure.get_or_insert_with(|| io_error(error));
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }

    /// Dispatches the batch's events, each settled on its activity record.
    /// Called once the guard is released.
    pub(crate) fn dispatch(self, state: &StorageState) {
        for (revision, event, object) in self.events {
            state.dispatch_change(revision, event, &object);
        }
    }
}

/// An upload about to be committed: the object as the rules see it and the
/// one it replaces.
pub(crate) struct Commit {
    pub(crate) before: Option<StoredObject>,
    pub(crate) object: StoredObject,
    firebase: bool,
}

/// Builds the object an upload commits, under the caller's guard: a new
/// generation, metageneration 1, a minted download token for a Firebase
/// upload (or, with `keep_tokens`, the replaced object's tokens), the
/// request's metadata, and the creation time of the object it replaces.
pub(crate) fn prepare_commit(
    state: &StorageState,
    _guard: &MutationGuard<'_>,
    spec: &CommitSpec<'_>,
    uploaded: &Uploaded,
) -> Commit {
    let key = object_key(spec.bucket, spec.name);
    let now = now_rfc3339();
    let (before, generation, token) = {
        let mut data = lock(&state.inner);
        let before = data.objects.get(&key).cloned();
        data.next_id = data.next_id.saturating_add(1);
        let generation = generation(&mut data);
        let token = spec.firebase.then(|| {
            uuid_shaped(&Sha256::digest(
                stable_id(&[
                    &state.config.project,
                    spec.bucket,
                    spec.name,
                    "download",
                    &data.next_id.to_string(),
                ])
                .as_bytes(),
            ))
        });
        (before, generation, token)
    };
    let tokens = match (&before, spec.keep_tokens) {
        (Some(previous), true) => previous.download_tokens.clone(),
        _ => token.into_iter().collect(),
    };
    let mut object = StoredObject {
        name: spec.name.to_owned(),
        bucket: spec.bucket.to_owned(),
        generation,
        metageneration: 1,
        content_type: Some(spec.content_type.to_owned()),
        storage_class: "STANDARD".to_owned(),
        content_disposition: None,
        content_encoding: None,
        content_language: None,
        cache_control: None,
        download_tokens: tokens,
        custom_metadata: spec.metadata.clone(),
        time_created: now.clone(),
        updated: now,
        size: uploaded.size,
        md5_hash: uploaded.md5_hash.clone(),
        crc32c: uploaded.crc32c,
        etag: etag(generation, 1),
        data_file: format!("objects/{}", stable_id(&[spec.bucket, spec.name])),
    };
    apply_metadata(&mut object, spec.object_metadata);
    if let Some(previous) = &before {
        object.time_created.clone_from(&previous.time_created);
    }
    Commit {
        before,
        object,
        firebase: spec.firebase,
    }
}

/// Publishes a prepared upload, under the caller's guard: the staged bytes
/// renamed onto the object's data file (a reader never sees new bytes with
/// old metadata), the record put, its persistence and its `finalized` event
/// left to `pending`.
pub(crate) async fn commit_locked(
    state: &StorageState,
    _guard: &MutationGuard<'_>,
    pending: &mut Pending,
    commit: Commit,
    uploaded: Uploaded,
    cx: &ChangeContext,
) -> Result<StoredObject, StorageApiError> {
    let Commit {
        mut object,
        firebase,
        ..
    } = commit;
    // The official emulator dispatches finalize before defaulting the
    // disposition on the (shared) stored record, so the finalize event lacks
    // it while later events and responses carry "inline".
    let disposition_defaulted = firebase && object.content_disposition.is_none();
    if disposition_defaulted {
        object.content_disposition = Some("inline".to_owned());
    }
    let final_path = state.config.data_dir.join(&object.data_file);
    tokio::fs::rename(uploaded.staged.path(), &final_path)
        .await
        .map_err(io_error)?;
    uploaded.staged.committed();
    // The bytes were recorded under the staging path; sync the published one.
    state.metadata.note_unsynced_file(final_path);
    let revision = {
        let mut data = lock(&state.inner);
        data.put(object.clone(), cx);
        data.revision
    };
    pending.object(object_key(&object.bucket, &object.name));
    let mut event_object = object.clone();
    if disposition_defaulted {
        event_object.content_disposition = None;
    }
    pending.event(revision, StorageEvent::Finalize, event_object);
    Ok(object)
}

/// The object a metadata change would leave, for the rules: `request` merged
/// over `before`, the metageneration and update time it would have.
pub(crate) fn proposed_metadata(before: &StoredObject, request: &JsonValue) -> StoredObject {
    let mut proposed = before.clone();
    apply_metadata(&mut proposed, request);
    proposed.metageneration = proposed.metageneration.saturating_add(1);
    proposed.updated = now_rfc3339();
    proposed
}

/// Applies a metadata change to `object` (as it was read under the caller's
/// guard): merged, a new metageneration, the record put, its persistence
/// and its `metadataUpdated` event left to `pending`.
pub(crate) fn update_metadata_locked(
    state: &StorageState,
    _guard: &MutationGuard<'_>,
    pending: &mut Pending,
    mut object: StoredObject,
    request: &JsonValue,
    cx: &ChangeContext,
) -> StoredObject {
    apply_metadata(&mut object, request);
    object.metageneration = object.metageneration.saturating_add(1);
    object.updated = now_rfc3339();
    object.etag = etag(object.generation, object.metageneration);
    let revision = {
        let mut data = lock(&state.inner);
        data.put(object.clone(), cx);
        data.revision
    };
    pending.object(object_key(&object.bucket, &object.name));
    pending.event(revision, StorageEvent::Metadata, object.clone());
    object
}

/// What a download token change does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TokenOp {
    /// Mint one more token.
    Create,
    /// Revoke this token.
    Revoke(String),
}

/// Changes `object`'s download tokens (as it was read under the caller's
/// guard): a new metageneration, the record put, a `metadataUpdated` event.
pub(crate) fn token_locked(
    state: &StorageState,
    _guard: &MutationGuard<'_>,
    pending: &mut Pending,
    mut object: StoredObject,
    op: &TokenOp,
    cx: &ChangeContext,
) -> StoredObject {
    match op {
        TokenOp::Create => {
            let token = crate::next_token(state, &object.bucket, &object.name);
            object.download_tokens.push(token);
        }
        TokenOp::Revoke(token) => object.download_tokens.retain(|value| value != token),
    }
    object.metageneration = object.metageneration.saturating_add(1);
    object.updated = now_rfc3339();
    object.etag = etag(object.generation, object.metageneration);
    let revision = {
        let mut data = lock(&state.inner);
        data.put(object.clone(), cx);
        data.revision
    };
    pending.object(object_key(&object.bucket, &object.name));
    pending.event(revision, StorageEvent::Metadata, object.clone());
    object
}

/// Deletes `object` (as it was read under the caller's guard): the record
/// removed, its persistence, its data file and its `deleted` event left to
/// `pending`.
pub(crate) fn delete_locked(
    state: &StorageState,
    _guard: &MutationGuard<'_>,
    pending: &mut Pending,
    object: StoredObject,
    cx: &ChangeContext,
) {
    let key = object_key(&object.bucket, &object.name);
    let revision = {
        let mut data = lock(&state.inner);
        data.remove(&key, cx);
        data.revision
    };
    pending.object(key);
    pending.unlink(state.config.data_dir.join(&object.data_file));
    pending.event(revision, StorageEvent::Delete, object);
}
