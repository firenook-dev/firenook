//! The work of a console bulk action: delete, move, copy or change the
//! metadata of many objects, on the write path's own pieces.
//!
//! The console's job runner (progress, cancel, retention, the four-jobs
//! limit) is the console crate's; this module supplies the work. It runs in
//! batches of 200 objects: each takes the mutation guard once, runs every
//! item through the same inner pieces the protocol handlers use, persists
//! the batch in one metadata transaction, and is one live event; writers
//! interleave between batches. Events are dispatched after each batch, and
//! between batches the work waits while the Functions emulator has more
//! than 10,000 requests queued, so a million-object move never floods it.
//! A client identity is judged per item, and a refused item reports the
//! refusal with its explanation.
//!
//! Copy stages the bytes before taking the guard (a 2 GB copy holds no
//! lock) and commits like an upload, so a reader of the destination never
//! sees new bytes with old metadata. Move hard-links the source's bytes
//! (O(1) at any size), then commits the destination and the removal of the
//! source as one transaction: a crash before the commit leaves the source
//! whole and an orphan link the next open removes; a crash after leaves an
//! extra link to bytes nothing names, never a record without its bytes.

use std::collections::{BTreeMap, VecDeque};
use std::time::Duration;

use serde_json::{Map as JsonMap, Value as JsonValue, json};

use crate::changes::ChangeContext;
use crate::console::{ConsoleError, Identity, StorageConsoleApi};
use crate::decisions::RulesCheck;
use crate::filter::StorageFilter;
use crate::listing::{FastScope, ListEntry, ListKind, fast_page, is_marker};
use crate::rules::Operation;
use crate::rules_manager::ConsoleRefusal;
use crate::staging::{StagedFile, staging_path};
use crate::write::{self, Pending};
use crate::{
    CommitSpec, StorageState, StoredObject, Uploaded, etag, generation, lock, now_rfc3339,
    object_key, stable_id,
};

/// Objects one batch takes at most.
pub const BULK_BATCH: usize = 200;
/// Bytes one copy batch stages at most (one larger object goes alone).
const COPY_BATCH_BYTES: u64 = 256 * 1024 * 1024;
/// Queued deliveries above which the work waits between batches.
pub const QUEUE_LIMIT: usize = 10_000;
/// The first conflicting names a preview lists.
const CONFLICT_SAMPLE: usize = 12;

/// What a bulk action does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BulkVerb {
    Delete,
    Move,
    Copy,
    Metadata,
}

impl BulkVerb {
    /// The verb as job kinds and titles name it.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Delete => "delete",
            Self::Move => "move",
            Self::Copy => "copy",
            Self::Metadata => "metadata",
        }
    }
}

/// What a bulk action applies to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BulkSource {
    /// Object names; one ending in `/` means everything under that folder.
    Keys(Vec<String>),
    /// Every entry a listing of `prefix` matches (a level, or everything
    /// below it when `flat`); a folder entry means everything under it.
    Query {
        prefix: String,
        flat: bool,
        filter: Option<StorageFilter>,
    },
}

/// Where a move or copy goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Destination {
    pub bucket: String,
    /// A folder: empty or ending in `/`.
    pub prefix: String,
}

/// What a taken destination name does.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ConflictPolicy {
    /// Leave it, and count the item as skipped.
    #[default]
    Skip,
    /// Replace it.
    Replace,
    /// Count the item as failed.
    Fail,
}

/// A metadata patch: each standard field absent (left), `Some(None)`
/// (cleared) or `Some(Some(value))` (set); custom keys set or removed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MetadataPatch {
    pub content_type: Option<Option<String>>,
    pub cache_control: Option<Option<String>>,
    pub content_disposition: Option<Option<String>>,
    pub content_encoding: Option<Option<String>>,
    pub content_language: Option<Option<String>>,
    pub custom_metadata: Option<BTreeMap<String, Option<String>>>,
}

impl MetadataPatch {
    /// The patch in the protocol's request shape, which the write path
    /// applies (`null` clears).
    pub(crate) fn to_json(&self) -> JsonValue {
        let mut request = JsonMap::new();
        for (field, value) in [
            ("contentType", &self.content_type),
            ("cacheControl", &self.cache_control),
            ("contentDisposition", &self.content_disposition),
            ("contentEncoding", &self.content_encoding),
            ("contentLanguage", &self.content_language),
        ] {
            if let Some(value) = value {
                request.insert(field.to_owned(), json!(value));
            }
        }
        if let Some(custom) = &self.custom_metadata {
            request.insert("metadata".to_owned(), json!(custom));
        }
        JsonValue::Object(request)
    }
}

/// One bulk action.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BulkRequest {
    pub verb: BulkVerb,
    /// The bucket the source names objects in.
    pub bucket: String,
    pub source: BulkSource,
    /// Move and copy: into this folder.
    pub destination: Option<Destination>,
    /// Move or copy one file, or one folder, to this exact name.
    pub rename_to: Option<String>,
    /// Metadata: the patch applied to every item.
    pub metadata: Option<MetadataPatch>,
    pub on_conflict: ConflictPolicy,
    /// The request came from the console (`x-firenook-console`).
    pub console: bool,
}

/// What a bulk action would touch.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BulkPreview {
    /// Files (folder markers are not counted).
    pub objects: u64,
    pub bytes: u64,
    /// Folders the target spans, each folder at any depth counted once.
    pub folders: u64,
    /// Move and copy: destination names already taken.
    pub conflicts: u64,
    /// The first twelve taken names.
    pub conflict_sample: Vec<String>,
}

/// Where a bulk batch reports; the console adapts it to its job handle.
pub trait BulkProgress: Send + Sync {
    /// `by` more files done.
    fn done(&self, by: u64);
    /// `by` more files passed over on purpose (a taken name under `skip`).
    fn skipped(&self, by: u64);
    /// One item failed: why, and for a rules refusal its explanation.
    fn failed(&self, name: &str, message: &str, refusal: Option<&ConsoleRefusal>);
    /// Checked between batches; the suite's stop cancels every job.
    fn cancelled(&self) -> bool;
}

/// One object a bulk action takes, and how much of its name the
/// destination replaces.
#[derive(Clone, Debug)]
struct Item {
    name: String,
    /// The bytes of `name` the destination prefix stands for.
    base: usize,
}

/// A source not yet expanded into items.
#[derive(Clone, Debug)]
enum Unexpanded {
    File(Item),
    /// Every object under `prefix`, after `after` once a batch took some.
    Folder {
        prefix: String,
        base: usize,
        after: Option<String>,
    },
}

/// The parent folder of `name` (empty at the bucket root), as a length.
fn parent_len(name: &str) -> usize {
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    trimmed.rfind('/').map_or(0, |slash| slash + 1)
}

fn invalid(message: impl Into<String>) -> ConsoleError {
    ConsoleError::Invalid(message.into())
}

/// Checks a request's shape: what the verb needs, names that make sense,
/// and no folder moved or copied into itself.
fn validate(request: &BulkRequest) -> Result<(), ConsoleError> {
    let needs_target = matches!(request.verb, BulkVerb::Move | BulkVerb::Copy);
    if needs_target && request.destination.is_none() && request.rename_to.is_none() {
        return Err(invalid(format!(
            "A {} needs a destination folder or a new name.",
            request.verb.name()
        )));
    }
    if request.verb == BulkVerb::Metadata && request.metadata.is_none() {
        return Err(invalid("A metadata change needs the metadata to set."));
    }
    if let Some(destination) = &request.destination {
        if !(destination.prefix.is_empty() || destination.prefix.ends_with('/')) {
            return Err(invalid(
                "The destination folder must be empty or end with `/`.",
            ));
        }
        if destination.bucket.is_empty() {
            return Err(invalid("The destination names no bucket."));
        }
    }
    if let Some(rename) = &request.rename_to {
        let BulkSource::Keys(keys) = &request.source else {
            return Err(invalid("A new name applies to one file or one folder."));
        };
        let [key] = keys.as_slice() else {
            return Err(invalid("A new name applies to one file or one folder."));
        };
        if rename.is_empty() {
            return Err(invalid("The new name is empty."));
        }
        if key.ends_with('/') != rename.ends_with('/') {
            return Err(invalid(if key.ends_with('/') {
                "A folder's new name ends with `/`."
            } else {
                "A file's new name does not end with `/`."
            }));
        }
        if key.ends_with('/') && rename.starts_with(key.as_str()) {
            return Err(invalid(format!("Cannot move {key} into itself.")));
        }
    }
    if needs_target && let Some(destination) = &request.destination {
        let folders: Vec<&str> = match &request.source {
            BulkSource::Keys(keys) => keys
                .iter()
                .filter(|key| key.ends_with('/'))
                .map(String::as_str)
                .collect(),
            BulkSource::Query { prefix, .. } => vec![prefix.as_str()],
        };
        if destination.bucket == request.bucket
            && let Some(folder) = folders
                .into_iter()
                .find(|folder| destination.prefix.starts_with(folder))
        {
            return Err(invalid(format!(
                "Cannot {} {folder} into itself.",
                request.verb.name()
            )));
        }
    }
    Ok(())
}

/// The destination of `item`: its new bucket and name.
fn destination_of(request: &BulkRequest, item: &Item) -> (String, String) {
    if let (Some(rename), BulkSource::Keys(keys)) = (&request.rename_to, &request.source)
        && let Some(key) = keys.first()
    {
        let bucket = request.destination.as_ref().map_or_else(
            || request.bucket.clone(),
            |destination| destination.bucket.clone(),
        );
        return if key.ends_with('/') {
            (bucket, format!("{rename}{}", &item.name[key.len()..]))
        } else {
            (bucket, rename.clone())
        };
    }
    let destination = request
        .destination
        .as_ref()
        .expect("validated: a move or copy has a destination");
    (
        destination.bucket.clone(),
        format!("{}{}", destination.prefix, &item.name[item.base..]),
    )
}

/// The sources a request names, before folders are expanded.
fn sources(state: &StorageState, request: &BulkRequest) -> VecDeque<Unexpanded> {
    match &request.source {
        BulkSource::Keys(keys) => keys
            .iter()
            .map(|key| {
                if key.ends_with('/') {
                    Unexpanded::Folder {
                        prefix: key.clone(),
                        base: parent_len(key),
                        after: None,
                    }
                } else {
                    Unexpanded::File(Item {
                        name: key.clone(),
                        base: parent_len(key),
                    })
                }
            })
            .collect(),
        BulkSource::Query {
            prefix,
            flat,
            filter,
        } => query_sources(state, &request.bucket, prefix, *flat, filter.as_ref()),
    }
}

/// Every entry a listing matches, files as items and folders to expand.
fn query_sources(
    state: &StorageState,
    bucket: &str,
    prefix: &str,
    flat: bool,
    filter: Option<&StorageFilter>,
) -> VecDeque<Unexpanded> {
    let mut found = VecDeque::new();
    let scope = FastScope {
        bucket,
        prefix,
        flat,
        kind: ListKind::All,
    };
    let mut after = None;
    loop {
        let page = {
            let data = lock(&state.inner);
            let page = fast_page(&data, &scope, after.as_ref(), None, 10_000);
            let mut kept = Vec::with_capacity(page.entries.len());
            for (entry, _) in &page.entries {
                match entry {
                    ListEntry::Folder(folder) => {
                        if filter.is_none_or(|filter| {
                            filter.matches_folder(&folder.prefix[prefix.len()..])
                        }) {
                            kept.push(Unexpanded::Folder {
                                prefix: folder.prefix.clone(),
                                base: prefix.len(),
                                after: None,
                            });
                        }
                    }
                    ListEntry::File(file) => {
                        let matches = filter.is_none_or(|filter| {
                            data.objects
                                .get(&object_key(bucket, &file.name))
                                .is_some_and(|object| {
                                    filter.matches_object(&file.name[prefix.len()..], object)
                                })
                        });
                        if matches {
                            kept.push(Unexpanded::File(Item {
                                name: file.name.clone(),
                                base: prefix.len(),
                            }));
                        }
                    }
                }
            }
            found.extend(kept);
            page
        };
        if !page.more_after {
            return found;
        }
        after = page.entries.last().map(|(_, cursor)| cursor.clone());
        std::thread::sleep(Duration::from_micros(200));
    }
}

/// Takes the next batch of items from `sources`: up to [`BULK_BATCH`]
/// objects (folder markers included), and for a copy up to
/// `COPY_BATCH_BYTES` of them.
fn next_batch(
    state: &StorageState,
    bucket: &str,
    sources: &mut VecDeque<Unexpanded>,
    byte_limit: Option<u64>,
) -> Vec<Item> {
    let mut items = Vec::new();
    let mut bytes = 0_u64;
    let full = |items: &Vec<Item>, bytes: u64| {
        items.len() >= BULK_BATCH
            || byte_limit.is_some_and(|limit| !items.is_empty() && bytes >= limit)
    };
    while !full(&items, bytes) {
        let Some(source) = sources.front_mut() else {
            break;
        };
        match source {
            Unexpanded::File(item) => {
                bytes = bytes.saturating_add(
                    lock(&state.inner)
                        .objects
                        .get(&object_key(bucket, &item.name))
                        .map_or(0, |object| object.size),
                );
                items.push(item.clone());
                sources.pop_front();
            }
            Unexpanded::Folder {
                prefix,
                base,
                after,
            } => {
                let scope = object_key(bucket, prefix);
                let data = lock(&state.inner);
                let start = after.as_ref().map(|name| object_key(bucket, name));
                let range = match &start {
                    Some(start) => data.objects.range::<str, _>((
                        std::ops::Bound::Excluded(start.as_str()),
                        std::ops::Bound::Unbounded,
                    )),
                    None => data.objects.range::<str, _>((
                        std::ops::Bound::Included(scope.as_str()),
                        std::ops::Bound::Unbounded,
                    )),
                };
                let mut exhausted = true;
                for (key, object) in range {
                    if !key.starts_with(scope.as_str()) {
                        break;
                    }
                    if full(&items, bytes) {
                        exhausted = false;
                        break;
                    }
                    bytes = bytes.saturating_add(object.size);
                    items.push(Item {
                        name: object.name.clone(),
                        base: *base,
                    });
                    *after = Some(object.name.clone());
                }
                drop(data);
                if exhausted {
                    sources.pop_front();
                }
            }
        }
    }
    items
}

impl StorageConsoleApi {
    /// What a bulk action would touch (`dryRun`): files, bytes and folders,
    /// from the folder index where it can, and for a move or copy the
    /// destination names already taken. Changes nothing. Blocking: call it
    /// off the request workers.
    pub fn bulk_preview(&self, request: &BulkRequest) -> Result<BulkPreview, ConsoleError> {
        validate(request)?;
        let state = self.state_ref();
        let mut preview = BulkPreview::default();
        let mut sources = sources(state, request);
        let index_ready = lock(&state.inner)
            .folders
            .as_ref()
            .is_some_and(crate::folder_index::FolderIndex::is_built);
        let moving = matches!(request.verb, BulkVerb::Move | BulkVerb::Copy);
        let mut parents = std::collections::BTreeSet::new();
        if !moving && index_ready {
            // Folders from the index: no walk at all.
            let data = lock(&state.inner);
            let Some(index) = data.folders.as_ref() else {
                return Err(ConsoleError::Unavailable(
                    "The folder index went away while it was read.".to_owned(),
                ));
            };
            sources.retain(|source| match source {
                Unexpanded::Folder { prefix, .. } => {
                    if let Some(stats) = index.stats(&request.bucket, prefix) {
                        preview.objects += stats.objects;
                        preview.bytes = preview.bytes.saturating_add(stats.bytes);
                        preview.folders += 1 + stats.folders_below;
                    }
                    false
                }
                Unexpanded::File(_) => true,
            });
        } else {
            for source in &sources {
                if let Unexpanded::Folder { prefix, .. } = source {
                    parents.insert(prefix.clone());
                }
            }
        }
        loop {
            let items = next_batch(state, &request.bucket, &mut sources, None);
            if items.is_empty() {
                break;
            }
            let data = lock(&state.inner);
            for item in &items {
                let Some(object) = data.objects.get(&object_key(&request.bucket, &item.name))
                else {
                    continue;
                };
                if is_marker(object) {
                    if item.name.len() > item.base {
                        parents.insert(item.name.clone());
                    }
                    continue;
                }
                preview.objects += 1;
                preview.bytes = preview.bytes.saturating_add(object.size);
                let parent = &item.name[..parent_len(&item.name)];
                if parent.len() > item.base {
                    // Every folder between the base and the file.
                    let mut end = parent.len();
                    while end > item.base {
                        parents.insert(item.name[..end].to_owned());
                        end = parent_len(&item.name[..end]);
                    }
                }
                if moving {
                    let (bucket, name) = destination_of(request, item);
                    if (bucket != request.bucket || name != item.name)
                        && data.objects.contains_key(&object_key(&bucket, &name))
                    {
                        preview.conflicts += 1;
                        if preview.conflict_sample.len() < CONFLICT_SAMPLE {
                            preview.conflict_sample.push(name);
                        }
                    }
                }
            }
        }
        preview.folders += u64::try_from(parents.len()).unwrap_or(u64::MAX);
        Ok(preview)
    }

    /// Runs a bulk action as `who`, in batches, reporting through
    /// `progress` and stopping after the current batch once it is
    /// cancelled.
    pub async fn bulk(
        &self,
        request: BulkRequest,
        who: Identity,
        progress: &dyn BulkProgress,
    ) -> Result<(), ConsoleError> {
        validate(&request)?;
        let state = self.state_ref().clone();
        let mut sources = {
            let state = state.clone();
            let request = request.clone();
            tokio::task::spawn_blocking(move || sources(&state, &request))
                .await
                .map_err(|_| {
                    ConsoleError::Internal("The bulk action's target could not be read.".to_owned())
                })?
        };
        let byte_limit = (request.verb == BulkVerb::Copy).then_some(COPY_BATCH_BYTES);
        loop {
            if progress.cancelled() {
                return Ok(());
            }
            if !self.wait_for_queue(progress).await {
                return Ok(());
            }
            let items = next_batch(&state, &request.bucket, &mut sources, byte_limit);
            if items.is_empty() {
                return Ok(());
            }
            match request.verb {
                BulkVerb::Delete => self.delete_batch(&request, &who, items, progress).await?,
                BulkVerb::Metadata => self.metadata_batch(&request, &who, items, progress).await?,
                BulkVerb::Copy => self.copy_batch(&request, &who, items, progress).await?,
                BulkVerb::Move => self.move_batch(&request, &who, items, progress).await?,
            }
        }
    }

    /// Waits while the Functions emulator has more than [`QUEUE_LIMIT`]
    /// requests queued; false when the job was cancelled meanwhile.
    async fn wait_for_queue(&self, progress: &dyn BulkProgress) -> bool {
        let state = self.state_ref();
        if !state.options.functions {
            return true;
        }
        while state.queue.depth() >= QUEUE_LIMIT {
            if progress.cancelled() {
                return false;
            }
            tokio::select! {
                () = state.queue.wait_below(QUEUE_LIMIT) => {}
                () = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
        }
        true
    }

    fn change_context(who: &Identity, request: &BulkRequest) -> ChangeContext {
        ChangeContext::from_authorization(who.authorization(), request.console)
    }

    /// Reports a refusal or another failure of one item.
    fn report(progress: &dyn BulkProgress, name: &str, error: &ConsoleError) {
        match error {
            ConsoleError::Denied {
                message, refusal, ..
            } => progress.failed(name, message, refusal.as_deref()),
            other => progress.failed(name, &other.to_string(), None),
        }
    }

    /// Persists a batch, announces it and dispatches its events.
    async fn finish_batch(
        &self,
        guard: write::MutationGuard<'_>,
        mut pending: Pending,
    ) -> Result<(), ConsoleError> {
        let state = self.state_ref();
        let persisted = pending.commit(state).await;
        lock(&state.inner).end_batch();
        drop(guard);
        persisted.map_err(|error| ConsoleError::Internal(error.message))?;
        pending.dispatch(state);
        Ok(())
    }

    async fn delete_batch(
        &self,
        request: &BulkRequest,
        who: &Identity,
        items: Vec<Item>,
        progress: &dyn BulkProgress,
    ) -> Result<(), ConsoleError> {
        let state = self.state_ref();
        let cx = Self::change_context(who, request);
        let guard = state.mutation.lock().await;
        lock(&state.inner).begin_batch();
        let mut pending = Pending::default();
        let (mut done, mut skipped) = (0, 0);
        for item in items {
            let Some(object) = self.stored(&request.bucket, &item.name) else {
                // Gone since the batch was read: nothing left to do.
                skipped += 1;
                continue;
            };
            let marker = is_marker(&object);
            let check = RulesCheck {
                bucket: &request.bucket,
                name: &item.name,
                operation: Operation::Delete,
                before: Some(&object),
                after: None,
                authorization: who.authorization(),
                console: request.console,
            };
            match self.judge(who, &check) {
                Ok(_) => {
                    write::delete_locked(state, &guard, &mut pending, object, &cx);
                    if !marker {
                        done += 1;
                    }
                }
                Err(error) => Self::report(progress, &item.name, &error),
            }
        }
        self.finish_batch(guard, pending).await?;
        progress.skipped(skipped);
        progress.done(done);
        Ok(())
    }

    async fn metadata_batch(
        &self,
        request: &BulkRequest,
        who: &Identity,
        items: Vec<Item>,
        progress: &dyn BulkProgress,
    ) -> Result<(), ConsoleError> {
        let state = self.state_ref();
        let cx = Self::change_context(who, request);
        let patch = request
            .metadata
            .as_ref()
            .map(MetadataPatch::to_json)
            .unwrap_or_default();
        let guard = state.mutation.lock().await;
        lock(&state.inner).begin_batch();
        let mut pending = Pending::default();
        let (mut done, mut skipped) = (0, 0);
        for item in items {
            let Some(object) = self.stored(&request.bucket, &item.name) else {
                skipped += 1;
                continue;
            };
            if is_marker(&object) {
                // A folder marker has no metadata worth setting.
                continue;
            }
            let proposed = write::proposed_metadata(&object, &patch);
            let check = RulesCheck {
                bucket: &request.bucket,
                name: &item.name,
                operation: Operation::Update,
                before: Some(&object),
                after: Some(&proposed),
                authorization: who.authorization(),
                console: request.console,
            };
            match self.judge(who, &check) {
                Ok(_) => {
                    write::update_metadata_locked(state, &guard, &mut pending, object, &patch, &cx);
                    done += 1;
                }
                Err(error) => Self::report(progress, &item.name, &error),
            }
        }
        self.finish_batch(guard, pending).await?;
        progress.skipped(skipped);
        progress.done(done);
        Ok(())
    }

    /// A taken destination under the request's policy: `Ok(true)` to go
    /// ahead (nothing there, or replace), `Ok(false)` to skip, `Err` to fail.
    fn conflict(request: &BulkRequest, taken: bool, name: &str) -> Result<bool, ConsoleError> {
        if !taken {
            return Ok(true);
        }
        match request.on_conflict {
            ConflictPolicy::Replace => Ok(true),
            ConflictPolicy::Skip => Ok(false),
            ConflictPolicy::Fail => Err(ConsoleError::AlreadyExists(format!(
                "{name} already exists."
            ))),
        }
    }

    async fn copy_batch(
        &self,
        request: &BulkRequest,
        who: &Identity,
        items: Vec<Item>,
        progress: &dyn BulkProgress,
    ) -> Result<(), ConsoleError> {
        let state = self.state_ref();
        let cx = Self::change_context(who, request);
        // The bytes first, with no lock held.
        let mut staged = Vec::with_capacity(items.len());
        let mut skipped = 0;
        for item in items {
            let Some(source) = self.stored(&request.bucket, &item.name) else {
                skipped += 1;
                continue;
            };
            let (bucket, name) = destination_of(request, &item);
            let mut file = StagedFile::new(
                staging_path(&state.config, "copy"),
                state.staging.bucket(&bucket),
            );
            if let Err(error) =
                tokio::fs::copy(state.config.data_dir.join(&source.data_file), file.path()).await
            {
                progress.failed(
                    &item.name,
                    &format!("Its bytes could not be copied: {error}."),
                    None,
                );
                continue;
            }
            file.add(source.size);
            staged.push((item, source, bucket, name, file));
        }
        let guard = state.mutation.lock().await;
        lock(&state.inner).begin_batch();
        let mut pending = Pending::default();
        let mut done = 0;
        for (item, source, bucket, name, file) in staged {
            let marker = is_marker(&source);
            match self
                .copy_one(
                    &guard,
                    &mut pending,
                    request,
                    who,
                    &cx,
                    (&item, &source),
                    (&bucket, &name),
                    file,
                )
                .await
            {
                Ok(true) => {
                    if !marker {
                        done += 1;
                    }
                }
                Ok(false) => skipped += 1,
                Err(error) => Self::report(progress, &item.name, &error),
            }
        }
        self.finish_batch(guard, pending).await?;
        progress.skipped(skipped);
        progress.done(done);
        Ok(())
    }

    /// Commits one staged copy under the guard; `Ok(false)` when skipped.
    #[allow(
        clippy::too_many_arguments,
        reason = "one item of a batch, with the batch's context"
    )]
    async fn copy_one(
        &self,
        guard: &write::MutationGuard<'_>,
        pending: &mut Pending,
        request: &BulkRequest,
        who: &Identity,
        cx: &ChangeContext,
        (item, source): (&Item, &StoredObject),
        (bucket, name): (&str, &str),
        file: StagedFile,
    ) -> Result<bool, ConsoleError> {
        let state = self.state_ref();
        let current = self.stored(&request.bucket, &item.name);
        if current
            .as_ref()
            .is_none_or(|current| current.generation != source.generation)
        {
            return Err(ConsoleError::Conflict(format!(
                "{} changed while it was being copied; copy it again.",
                item.name
            )));
        }
        if bucket == request.bucket && name == item.name {
            return Ok(false);
        }
        let taken = self.stored(bucket, name).is_some();
        if !Self::conflict(request, taken, name)? {
            return Ok(false);
        }
        let mut object_metadata = crate::base_metadata(source, false);
        object_metadata["metadata"] = json!(source.custom_metadata);
        let spec = CommitSpec {
            bucket,
            name,
            content_type: source
                .content_type
                .as_deref()
                .unwrap_or("application/octet-stream"),
            metadata: source.custom_metadata.clone(),
            object_metadata: &object_metadata,
            authorization: who.authorization(),
            firebase: false,
            console: request.console,
            keep_tokens: false,
        };
        let uploaded = Uploaded {
            staged: file,
            size: source.size,
            md5_hash: source.md5_hash.clone(),
            crc32c: source.crc32c,
        };
        let mut commit = write::prepare_commit(state, guard, &spec, &uploaded);
        // A copy is a new file: one new download token, none of the old.
        commit.object.download_tokens = vec![crate::next_token(state, bucket, name)];
        commit.object.content_type.clone_from(&source.content_type);
        let check = RulesCheck {
            bucket,
            name,
            operation: Operation::Create,
            before: commit.before.as_ref(),
            after: Some(&commit.object),
            authorization: who.authorization(),
            console: request.console,
        };
        self.judge(who, &check)?;
        write::commit_locked(state, guard, pending, commit, uploaded, cx)
            .await
            .map_err(|error| ConsoleError::Internal(error.message))?;
        Ok(true)
    }

    async fn move_batch(
        &self,
        request: &BulkRequest,
        who: &Identity,
        items: Vec<Item>,
        progress: &dyn BulkProgress,
    ) -> Result<(), ConsoleError> {
        let state = self.state_ref();
        let cx = Self::change_context(who, request);
        // Links first, with no lock held: O(1) whatever the size.
        let mut linked = Vec::with_capacity(items.len());
        let mut skipped = 0;
        for item in items {
            let Some(source) = self.stored(&request.bucket, &item.name) else {
                skipped += 1;
                continue;
            };
            let (bucket, name) = destination_of(request, &item);
            if bucket == request.bucket && name == item.name {
                skipped += 1;
                continue;
            }
            let file = StagedFile::new(
                staging_path(&state.config, "move"),
                state.staging.bucket(&bucket),
            );
            let from = state.config.data_dir.join(&source.data_file);
            let linked_ok = match tokio::fs::hard_link(&from, file.path()).await {
                Ok(()) => true,
                // A filesystem without links: copy, which is staging-safe too.
                Err(_) => tokio::fs::copy(&from, file.path()).await.is_ok(),
            };
            if !linked_ok {
                progress.failed(&item.name, "Its bytes could not be linked or copied.", None);
                continue;
            }
            #[cfg(test)]
            if crash::at(crash::AFTER_LINK) {
                std::mem::forget(file);
                return Err(ConsoleError::Internal(
                    "a crash the test asked for".to_owned(),
                ));
            }
            linked.push((item, source, bucket, name, file));
        }
        let guard = state.mutation.lock().await;
        lock(&state.inner).begin_batch();
        let mut pending = Pending::default();
        let mut done = 0;
        for (item, source, bucket, name, file) in linked {
            let marker = is_marker(&source);
            match self
                .move_one(
                    &guard,
                    &mut pending,
                    request,
                    who,
                    &cx,
                    (&item, &source),
                    (&bucket, &name),
                    file,
                )
                .await
            {
                Ok(true) => {
                    if !marker {
                        done += 1;
                    }
                }
                Ok(false) => skipped += 1,
                Err(error) => Self::report(progress, &item.name, &error),
            }
        }
        #[cfg(test)]
        if crash::at(crash::AFTER_COMMIT) {
            // Persisted, but the source's bytes are never unlinked and no
            // event goes: what a crash right after the commit leaves.
            pending.keep_files();
            let _ = pending.commit(state).await;
            lock(&state.inner).end_batch();
            drop(guard);
            return Err(ConsoleError::Internal(
                "a crash the test asked for".to_owned(),
            ));
        }
        self.finish_batch(guard, pending).await?;
        progress.skipped(skipped);
        progress.done(done);
        Ok(())
    }

    /// Moves one linked object under the guard; `Ok(false)` when skipped.
    #[allow(
        clippy::too_many_arguments,
        reason = "one item of a batch, with the batch's context"
    )]
    async fn move_one(
        &self,
        guard: &write::MutationGuard<'_>,
        pending: &mut Pending,
        request: &BulkRequest,
        who: &Identity,
        cx: &ChangeContext,
        (item, source): (&Item, &StoredObject),
        (bucket, name): (&str, &str),
        file: StagedFile,
    ) -> Result<bool, ConsoleError> {
        let _ = guard;
        let state = self.state_ref();
        let current = self.stored(&request.bucket, &item.name);
        if current
            .as_ref()
            .is_none_or(|current| current.generation != source.generation)
        {
            return Err(ConsoleError::Conflict(format!(
                "{} changed while it was being moved; move it again.",
                item.name
            )));
        }
        let existing = self.stored(bucket, name);
        if !Self::conflict(request, existing.is_some(), name)? {
            return Ok(false);
        }
        let now = now_rfc3339();
        let mut moved = source.clone();
        moved.bucket = bucket.to_owned();
        moved.name = name.to_owned();
        moved.generation = generation(&mut lock(&state.inner));
        moved.metageneration = 1;
        moved.etag = etag(moved.generation, 1);
        moved.time_created.clone_from(&now);
        moved.updated = now;
        moved.data_file = format!("objects/{}", stable_id(&[bucket, name]));
        // A move is judged as what it is: a create at the destination and a
        // delete at the source.
        self.judge(
            who,
            &RulesCheck {
                bucket,
                name,
                operation: Operation::Create,
                before: existing.as_ref(),
                after: Some(&moved),
                authorization: who.authorization(),
                console: request.console,
            },
        )?;
        self.judge(
            who,
            &RulesCheck {
                bucket: &request.bucket,
                name: &item.name,
                operation: Operation::Delete,
                before: Some(source),
                after: None,
                authorization: who.authorization(),
                console: request.console,
            },
        )?;
        let final_path = state.config.data_dir.join(&moved.data_file);
        tokio::fs::rename(file.path(), &final_path)
            .await
            .map_err(|error| {
                ConsoleError::Internal(format!("Its bytes could not be moved: {error}."))
            })?;
        file.committed();
        state.metadata.note_unsynced_file(final_path);
        let source_key = object_key(&request.bucket, &item.name);
        let (created, deleted) = {
            let mut data = lock(&state.inner);
            data.put(moved.clone(), cx);
            let created = data.revision;
            data.remove(&source_key, cx);
            (created, data.revision)
        };
        pending.object(object_key(bucket, name));
        pending.object(source_key);
        pending.unlink(state.config.data_dir.join(&source.data_file));
        pending.event(created, crate::StorageEvent::Finalize, moved);
        pending.event(deleted, crate::StorageEvent::Delete, source.clone());
        Ok(true)
    }
}

/// Points where the tests stop a move as a crash would.
#[cfg(test)]
pub(crate) mod crash {
    use std::sync::atomic::{AtomicU8, Ordering};

    pub(crate) const AFTER_LINK: u8 = 1;
    pub(crate) const AFTER_COMMIT: u8 = 2;

    static AT: AtomicU8 = AtomicU8::new(0);

    pub(crate) fn set(point: u8) {
        AT.store(point, Ordering::SeqCst);
    }

    pub(crate) fn at(point: u8) -> bool {
        AT.compare_exchange(point, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}
