//! The Files page's API: buckets, listings both ways, batch reads of the
//! rows a live event named, one object (read, upload, metadata, tokens,
//! delete), its bytes, thumbnail, archive entries, activity and event
//! bodies, folders and zip downloads.
//!
//! Routes marked as rules routes read the `Authorization` header exactly as
//! the protocol does (owner credentials are Admin and skip the rules; any
//! other value is a client), so the console meets the rules an app meets.
//! The others are the operator's own reads.

use std::collections::BTreeMap;

use axum::Json;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use firenook_storage_front::{
    Actor, ConsoleListQuery, ConsoleUpload, EventDelivery, ExportSource, FileEntry, FolderEntry,
    FolderStats, Identity, ListCursor, ListEntry, ListKind, ListOrder, MediaMode, MetadataPatch,
    ObjectChangeKind, ObjectChangeRecord, ObjectView, ResendEvent, SniffFamily, SortColumn,
    TokenOp,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use ts_rs::TS;

use super::StorageRoutes;
use super::filter_fields::{STORAGE_FILTER_FIELDS, storage_filter};
use super::rules::StorageDecision;
use super::rules::double_option as patch_field;
use crate::api_error::ApiError;
use crate::blocking::blocking;
use crate::guard::{CONSOLE_HEADER, KEEP_TOKENS_HEADER, METADATA_HEADER};
use crate::jobs::BulkTarget;
use crate::json::ConsoleJson;
use crate::paging::{
    BatchGetItem, BatchGetRequest, BatchGetResponse, DEFAULT_LIMIT, Direction, ListMeta, MAX_LIMIT,
    PAGE_BYTES, Page, PageQuery, Total, encode_cursor, page_of,
};

/// How `firebase.json` assigns Storage rules to buckets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) enum StorageRulesMode {
    /// `storage: { rules }`: one file governs every bucket.
    Single,
    /// `storage: [{ target, rules }]`: each targeted bucket has its own file.
    PerBucket,
    /// No `storage` section in a demo project: the emulator's open default
    /// rules govern every bucket.
    OpenDefault,
}

/// Every bucket the console can show.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageBuckets {
    /// The bucket `getStorage()` uses when given none.
    pub default_bucket: String,
    /// Null when the service runs without rules (every request allowed).
    pub rules_mode: Option<StorageRulesMode>,
    /// The default bucket first, then configured buckets, then any other
    /// bucket holding objects, by name.
    pub buckets: Vec<StorageBucket>,
    /// The folder index is built, so every count below is known.
    pub index_ready: bool,
}

/// One bucket.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageBucket {
    pub name: String,
    pub is_default: bool,
    /// Named by `firebase.json`, or the project default.
    pub configured: bool,
    /// A ruleset is loaded for it. When false the emulator refuses every
    /// client request to it, the Admin SDK included.
    pub served: bool,
    /// The rules file governing it, when one does.
    pub rules_file: Option<String>,
    /// Objects in the bucket; null while the folder index is being built.
    #[ts(type = "number | null")]
    pub objects: Option<u64>,
    #[ts(type = "number | null")]
    pub bytes: Option<u64>,
    /// Bytes staged by uploads still in progress.
    pub in_flight: StorageInFlight,
}

/// Uploads in progress: single uploads being received and resumable
/// sessions not yet finished.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageInFlight {
    pub uploads: u32,
    #[ts(type = "number")]
    pub bytes: u64,
}

/// Which entries a listing wants.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "storage/")]
pub(crate) enum StorageListKind {
    #[default]
    All,
    Folders,
    Files,
}

impl From<StorageListKind> for ListKind {
    fn from(kind: StorageListKind) -> Self {
        match kind {
            StorageListKind::All => Self::All,
            StorageListKind::Folders => Self::Folders,
            StorageListKind::Files => Self::Files,
        }
    }
}

/// One page of a folder or of everything under it: the foundation's `Page`
/// plus what only Storage has.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageListPage {
    #[serde(flatten)]
    #[ts(flatten)]
    pub page: Page<StorageEntry>,
    pub bucket: String,
    pub prefix: String,
    pub totals: StorageListTotals,
    /// A zero-byte marker object names this folder (made by a console).
    pub placeholder: bool,
    /// The storage revision the page was read at.
    #[ts(type = "number")]
    pub revision: u64,
    /// The decision that allowed a client identity to list; null for Admin
    /// or when not recorded.
    pub decision: Option<String>,
    /// A sorted or filtered view served after its folder changed (at most
    /// 2 s after the change was first seen).
    pub stale: bool,
    /// Changes in the view's scope since it was built; 0 when not stale.
    #[ts(type = "number")]
    pub changes_since: u64,
}

/// What the whole listing holds, not only this page.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageListTotals {
    /// Direct subfolders (zero in a flat listing); null while the folder
    /// index is being built.
    #[ts(type = "number | null")]
    pub folders: Option<u64>,
    #[ts(type = "number | null")]
    pub files: Option<u64>,
    #[ts(type = "number | null")]
    pub bytes: Option<u64>,
    /// The counts are a filter's matches.
    pub filtered: bool,
}

/// One row of a listing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) enum StorageEntry {
    Folder(StorageFolderEntry),
    File(StorageFileEntry),
}

/// A folder row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageFolderEntry {
    /// The full prefix, ending in `/`.
    pub prefix: String,
    /// Files anywhere below; null while the folder index is being built.
    #[ts(type = "number | null")]
    pub objects: Option<u64>,
    #[ts(type = "number | null")]
    pub bytes: Option<u64>,
    /// Direct subfolders.
    #[ts(type = "number | null")]
    pub folders: Option<u64>,
    /// The last change anywhere below, RFC 3339.
    pub changed_at: Option<String>,
    /// Held only by marker objects: no file below it.
    pub empty: bool,
}

/// A file row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageFileEntry {
    /// The full object name.
    pub name: String,
    #[ts(type = "number")]
    pub size: u64,
    pub content_type: Option<String>,
    pub content_encoding: Option<String>,
    /// RFC 3339.
    pub updated: String,
    pub time_created: String,
    /// A decimal string, as the protocol writes it.
    pub generation: String,
    /// Download tokens the object carries.
    pub tokens: u32,
    /// The first four custom metadata keys, in key order.
    pub metadata_keys: Vec<String>,
    pub metadata_count: u32,
}

/// One folder's counts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageFolder {
    pub bucket: String,
    pub prefix: String,
    #[ts(type = "number")]
    pub objects: u64,
    #[ts(type = "number")]
    pub bytes: u64,
    #[ts(type = "number")]
    pub folders: u64,
    /// Every folder at any depth below.
    #[ts(type = "number")]
    pub folders_below: u64,
    #[ts(type = "number")]
    pub direct_files: u64,
    #[ts(type = "number")]
    pub direct_bytes: u64,
    pub changed_at: Option<String>,
    pub placeholder: bool,
}

/// One object, everything the engine knows about it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageObjectDetail {
    pub bucket: String,
    pub name: String,
    #[ts(type = "number")]
    pub size: u64,
    pub content_type: Option<String>,
    pub cache_control: Option<String>,
    pub content_disposition: Option<String>,
    pub content_encoding: Option<String>,
    pub content_language: Option<String>,
    pub custom_metadata: BTreeMap<String, String>,
    /// Download tokens. Empty for a client identity: only Admin may read
    /// them.
    pub download_tokens: Vec<String>,
    /// False when the identity may not see tokens, so an empty list means
    /// nothing.
    pub tokens_visible: bool,
    /// Base64, as the protocol writes it.
    pub md5_hash: String,
    /// Base64 big-endian, as the JSON API writes it.
    pub crc32c: String,
    pub etag: String,
    pub generation: String,
    pub metageneration: String,
    pub storage_class: String,
    pub time_created: String,
    pub updated: String,
    /// What the first bytes are, when they say (decoded first for a
    /// gzip-encoded object).
    pub sniffed: Option<StorageSniffed>,
    /// This object is a zero-byte folder marker.
    pub placeholder: bool,
    /// The decision that allowed a client identity to read it; null for
    /// Admin.
    pub decision: Option<String>,
}

/// A signature read from the first 512 bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageSniffed {
    /// `image/png`, `application/zip`, `text/plain`, …
    pub mime: String,
    pub family: StorageSniffFamily,
    /// A magic number matched (not only "valid UTF-8").
    pub definite: bool,
}

/// The family a signature belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "storage/")]
pub(crate) enum StorageSniffFamily {
    Image,
    Video,
    Audio,
    Pdf,
    Archive,
    Text,
    Binary,
}

/// A metadata patch. Each standard field: absent leaves it, null clears
/// it, a string sets it.
#[allow(
    clippy::option_option,
    reason = "absent, null and a value mean three different things on the wire"
)]
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "storage/")]
pub(crate) struct StorageMetadataPatch {
    #[serde(default, skip_serializing_if = "Option::is_none", with = "patch_field")]
    #[ts(optional, type = "string | null")]
    pub content_type: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "patch_field")]
    #[ts(optional, type = "string | null")]
    pub cache_control: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "patch_field")]
    #[ts(optional, type = "string | null")]
    pub content_disposition: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "patch_field")]
    #[ts(optional, type = "string | null")]
    pub content_encoding: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "patch_field")]
    #[ts(optional, type = "string | null")]
    pub content_language: Option<Option<String>>,
    /// Keys to set (a string) or remove (null).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, string | null>")]
    pub custom_metadata: Option<BTreeMap<String, Option<String>>>,
}

impl StorageMetadataPatch {
    pub(crate) fn engine(&self) -> MetadataPatch {
        MetadataPatch {
            content_type: self.content_type.clone(),
            cache_control: self.cache_control.clone(),
            content_disposition: self.content_disposition.clone(),
            content_encoding: self.content_encoding.clone(),
            content_language: self.content_language.clone(),
            custom_metadata: self.custom_metadata.clone(),
        }
    }
}

/// `POST /storage/object/metadata`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "storage/")]
pub(crate) struct StorageUpdateObjectBody {
    pub bucket: String,
    pub name: String,
    pub metadata: StorageMetadataPatch,
    /// Refuse with 412 failed-precondition when the object's metageneration
    /// is no longer this.
    #[serde(default)]
    #[ts(optional)]
    pub if_metageneration_match: Option<String>,
}

/// `POST /storage/object/token`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "storage/")]
pub(crate) struct StorageTokenBody {
    pub bucket: String,
    pub name: String,
    pub action: StorageTokenAction,
    /// The token to revoke.
    #[serde(default)]
    #[ts(optional)]
    pub token: Option<String>,
}

/// What a token change does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "storage/")]
pub(crate) enum StorageTokenAction {
    Create,
    Revoke,
}

/// `POST /storage/folders`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "storage/")]
pub(crate) struct StorageCreateFolderBody {
    pub bucket: String,
    /// The new folder's full prefix, ending in `/`.
    pub prefix: String,
}

/// `DELETE /storage/object`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "storage/")]
pub(crate) struct StorageDeleteObjectBody {
    pub bucket: String,
    pub name: String,
}

/// `POST /storage/objects:exists`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "storage/")]
pub(crate) struct StorageExistsBody {
    pub bucket: String,
    /// At most 1,000.
    pub names: Vec<String>,
}

/// Which names are taken.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageExistsResult {
    pub existing: Vec<String>,
}

/// What changed an object, and from where.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageActor {
    pub kind: StorageActorKind,
    pub uid: Option<String>,
    /// The token's tenant; null for project users.
    pub tenant: Option<String>,
    /// The request carried `x-firenook-console`.
    pub via_console: bool,
}

/// Who made a change.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "storage/")]
pub(crate) enum StorageActorKind {
    Admin,
    User,
    Anonymous,
    System,
}

/// What happened to the Storage event a change produced.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export_to = "storage/")]
pub(crate) enum StorageEventDelivery {
    /// Not settled yet.
    Pending,
    /// Queued for the Functions emulator (v1 and v2).
    Sent,
    /// The Emulator Hub's background-trigger switch is off.
    Paused,
    /// Enqueueing failed (the delivery runtime was stopping).
    Failed,
    /// Functions is not part of this suite; nothing was queued.
    NoFunctions,
    /// The change sends no Storage event (an import).
    NoEvent,
}

impl From<EventDelivery> for StorageEventDelivery {
    fn from(delivery: EventDelivery) -> Self {
        match delivery {
            EventDelivery::Pending => Self::Pending,
            EventDelivery::Sent => Self::Sent,
            EventDelivery::Paused => Self::Paused,
            EventDelivery::Failed => Self::Failed,
            EventDelivery::NoFunctions => Self::NoFunctions,
            EventDelivery::NoEvent => Self::NoEvent,
        }
    }
}

/// What a change did to an object.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "storage/")]
pub(crate) enum StorageObjectChangeKind {
    Created,
    Replaced,
    Metadata,
    Tokens,
    Deleted,
}

impl From<ObjectChangeKind> for StorageObjectChangeKind {
    fn from(kind: ObjectChangeKind) -> Self {
        match kind {
            ObjectChangeKind::Created => Self::Created,
            ObjectChangeKind::Replaced => Self::Replaced,
            ObjectChangeKind::Metadata => Self::Metadata,
            ObjectChangeKind::Tokens => Self::Tokens,
            ObjectChangeKind::Deleted => Self::Deleted,
        }
    }
}

/// One change, as Activity lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageObjectChange {
    #[ts(type = "number")]
    pub revision: u64,
    pub at: String,
    pub bucket: String,
    pub name: String,
    pub kind: StorageObjectChangeKind,
    #[ts(type = "number")]
    pub size: u64,
    pub content_type: Option<String>,
    /// Metadata changes: the fields and custom keys set or removed.
    pub metadata_keys: Vec<String>,
    pub actor: StorageActor,
    pub delivery: StorageEventDelivery,
}

/// `POST /storage/objects:batchGet`: the foundation's request plus the
/// listing's scope.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageBatchGetRequest {
    #[serde(flatten)]
    #[ts(flatten)]
    pub request: BatchGetRequest,
    pub bucket: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub flat: bool,
    #[serde(default)]
    pub kind: StorageListKind,
}

/// An object's changes and the rules decisions on its name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageActivity {
    /// Newest first.
    pub changes: Vec<StorageObjectChange>,
    /// Rules decisions on this exact name, newest first; empty when
    /// diagnostics are off.
    pub decisions: Vec<StorageDecision>,
    pub diagnostics: bool,
    /// Where each list starts: the oldest change and decision the engine
    /// still holds, RFC 3339.
    pub changes_since: Option<String>,
    pub decisions_since: Option<String>,
}

/// The Storage event bodies an object produces now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageEventPayloads {
    /// Functions is part of this suite (the Send buttons are offered only
    /// then).
    pub functions: bool,
    pub finalize: StorageEventBodies,
    pub metadata_update: StorageEventBodies,
    pub delete: StorageEventBodies,
}

/// One event's two bodies.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageEventBodies {
    #[ts(type = "Record<string, unknown>")]
    pub v1: serde_json::Value,
    #[ts(type = "Record<string, unknown>")]
    pub v2: serde_json::Value,
}

/// `POST /storage/object/resend`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "storage/")]
pub(crate) struct StorageResendEventBody {
    pub bucket: String,
    pub name: String,
    pub event: StorageResendEvent,
}

/// Which event to send again.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) enum StorageResendEvent {
    Finalize,
    MetadataUpdate,
}

/// What became of an event sent again.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageResendResult {
    pub sent: bool,
    pub delivery: StorageEventDelivery,
}

/// The first entries of a `.zip` object.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageArchive {
    pub entries: Vec<StorageArchiveEntry>,
    /// Entries in the whole archive.
    pub total: u32,
    pub truncated: bool,
}

/// One entry of an archive.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageArchiveEntry {
    pub name: String,
    #[ts(type = "number")]
    pub size: u64,
    #[ts(type = "number")]
    pub compressed: u64,
    pub directory: bool,
}

/// What a folder holds, for starter rules, completion and filter
/// suggestions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageProfile {
    pub bucket: String,
    pub prefix: String,
    #[ts(type = "number")]
    pub objects: u64,
    #[ts(type = "number")]
    pub bytes: u64,
    #[ts(type = "number")]
    pub max_size: u64,
    /// The 95th percentile of sizes.
    #[ts(type = "number")]
    pub typical_size: u64,
    /// Up to eight, most objects first.
    pub content_types: Vec<StorageContentTypeCount>,
    /// Up to twenty custom metadata keys, most frequent first.
    pub metadata_keys: Vec<String>,
    /// Up to two hundred direct subfolder names (without the slash).
    pub child_folders: Vec<String>,
    /// Read from the first 50,000 objects only.
    pub sampled: bool,
}

/// One content type of a folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageContentTypeCount {
    pub content_type: String,
    #[ts(type = "number")]
    pub objects: u64,
    #[ts(type = "number")]
    pub bytes: u64,
}

/// `POST /storage/objects:export`: a selection to download as one `.zip`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "storage/")]
pub(crate) struct StorageExportBody {
    pub bucket: String,
    pub target: BulkTarget,
}

/// A selection ready to download.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageExportTicket {
    /// `GET /console/api/v1/storage/objects:export?ticket=…`, a plain
    /// download link.
    pub url: String,
    #[ts(type = "number")]
    pub objects: u64,
    #[ts(type = "number")]
    pub bytes: u64,
}

// ---------------------------------------------------------------------------
// Conversions.

fn rfc3339_millis(millis: i64) -> Option<String> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .ok()
        .and_then(|time| time.format(&Rfc3339).ok())
}

pub(crate) fn folder_entry(folder: &FolderEntry) -> StorageFolderEntry {
    StorageFolderEntry {
        prefix: folder.prefix.clone(),
        objects: folder.stats.map(|stats| stats.objects),
        bytes: folder.stats.map(|stats| stats.bytes),
        folders: folder.stats.map(|stats| stats.folders),
        changed_at: folder
            .stats
            .and_then(|stats| stats.changed_at_ms)
            .and_then(rfc3339_millis),
        empty: folder.stats.is_some_and(|stats| stats.objects == 0),
    }
}

pub(crate) fn file_entry(file: &FileEntry) -> StorageFileEntry {
    StorageFileEntry {
        name: file.name.clone(),
        size: file.size,
        content_type: file.content_type.clone(),
        content_encoding: file.content_encoding.clone(),
        updated: file.updated.clone(),
        time_created: file.time_created.clone(),
        generation: file.generation.to_string(),
        tokens: file.tokens,
        metadata_keys: file.metadata_keys.clone(),
        metadata_count: file.metadata_count,
    }
}

pub(crate) fn entry(entry: &ListEntry) -> StorageEntry {
    match entry {
        ListEntry::Folder(folder) => StorageEntry::Folder(folder_entry(folder)),
        ListEntry::File(file) => StorageEntry::File(file_entry(file)),
    }
}

pub(crate) fn object_detail(view: ObjectView) -> StorageObjectDetail {
    StorageObjectDetail {
        bucket: view.bucket,
        name: view.name,
        size: view.size,
        content_type: view.content_type,
        cache_control: view.cache_control,
        content_disposition: view.content_disposition,
        content_encoding: view.content_encoding,
        content_language: view.content_language,
        custom_metadata: view.custom_metadata,
        download_tokens: view.download_tokens,
        tokens_visible: view.tokens_visible,
        md5_hash: view.md5_hash,
        crc32c: view.crc32c,
        etag: view.etag,
        generation: view.generation.to_string(),
        metageneration: view.metageneration.to_string(),
        storage_class: view.storage_class,
        time_created: view.time_created,
        updated: view.updated,
        sniffed: view.sniffed.map(|sniffed| StorageSniffed {
            mime: sniffed.mime.to_owned(),
            family: match sniffed.family {
                SniffFamily::Image => StorageSniffFamily::Image,
                SniffFamily::Video => StorageSniffFamily::Video,
                SniffFamily::Audio => StorageSniffFamily::Audio,
                SniffFamily::Pdf => StorageSniffFamily::Pdf,
                SniffFamily::Archive => StorageSniffFamily::Archive,
                SniffFamily::Text => StorageSniffFamily::Text,
                SniffFamily::Binary => StorageSniffFamily::Binary,
            },
            definite: sniffed.definite,
        }),
        placeholder: view.placeholder,
        decision: view.decision,
    }
}

fn folder_counts(bucket: &str, prefix: &str, stats: &FolderStats) -> StorageFolder {
    StorageFolder {
        bucket: bucket.to_owned(),
        prefix: prefix.to_owned(),
        objects: stats.objects,
        bytes: stats.bytes,
        folders: stats.folders,
        folders_below: stats.folders_below,
        direct_files: stats.direct_files,
        direct_bytes: stats.direct_bytes,
        changed_at: stats.changed_at_ms.and_then(rfc3339_millis),
        placeholder: stats.placeholder,
    }
}

fn change(record: &ObjectChangeRecord) -> StorageObjectChange {
    let (kind, uid, tenant) = match &record.actor {
        Actor::Admin => (StorageActorKind::Admin, None, None),
        Actor::User { uid, tenant } => (StorageActorKind::User, Some(uid.clone()), tenant.clone()),
        Actor::Anonymous => (StorageActorKind::Anonymous, None, None),
        Actor::System => (StorageActorKind::System, None, None),
    };
    StorageObjectChange {
        revision: record.revision,
        at: record.at.format(&Rfc3339).unwrap_or_default(),
        bucket: record.bucket.clone(),
        name: record.name.clone(),
        kind: record.kind.into(),
        size: record.size,
        content_type: record.content_type.clone(),
        metadata_keys: record.metadata_keys.clone(),
        actor: StorageActor {
            kind,
            uid,
            tenant,
            via_console: record.via_console,
        },
        delivery: record.delivery.into(),
    }
}

/// Who the request acts as: owner credentials are Admin, anything else a
/// client, as on the protocol.
pub(crate) fn identity(headers: &HeaderMap) -> Identity {
    Identity::from_authorization(
        headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok()),
    )
}

/// The request came from the console (`x-firenook-console`).
pub(crate) fn via_console(headers: &HeaderMap) -> bool {
    headers.contains_key(CONSOLE_HEADER)
}

// ---------------------------------------------------------------------------
// Routes.

/// `GET /storage/buckets`: every bucket, never waiting for the folder index.
pub(crate) async fn buckets(State(routes): State<StorageRoutes>) -> Json<StorageBuckets> {
    let buckets = routes.api.buckets();
    Json(StorageBuckets {
        default_bucket: buckets.default_bucket,
        rules_mode: buckets.rules_mode.map(|mode| match mode {
            firenook_storage_front::RulesMode::Single => StorageRulesMode::Single,
            firenook_storage_front::RulesMode::PerBucket => StorageRulesMode::PerBucket,
            firenook_storage_front::RulesMode::OpenDefault => StorageRulesMode::OpenDefault,
        }),
        buckets: buckets
            .buckets
            .into_iter()
            .map(|bucket| StorageBucket {
                name: bucket.name,
                is_default: bucket.is_default,
                configured: bucket.configured,
                served: bucket.served,
                rules_file: bucket.rules_file.map(|path| path.display().to_string()),
                objects: bucket.objects,
                bytes: bucket.bytes,
                in_flight: StorageInFlight {
                    uploads: bucket.in_flight.uploads,
                    bytes: bucket.in_flight.bytes,
                },
            })
            .collect(),
        index_ready: buckets.index_ready,
    })
}

/// The query of `GET /storage/objects`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StorageListParams {
    bucket: String,
    #[serde(default)]
    prefix: String,
    cursor: Option<String>,
    before: Option<String>,
    limit: Option<u32>,
    sort: Option<String>,
    q: Option<String>,
    #[serde(default)]
    flat: bool,
    #[serde(default)]
    kind: StorageListKind,
    /// Rebuild a sorted or filtered view the app's writes have moved,
    /// instead of serving it stale for up to 2 s (the console's Refresh).
    #[serde(default)]
    fresh: bool,
}

/// What `GET /storage/objects/meta` says.
pub(crate) fn list_meta() -> ListMeta {
    ListMeta {
        sortable: ["name", "size", "updated", "type"]
            .map(str::to_owned)
            .to_vec(),
        default_sort: "name:asc".to_owned(),
        fields: STORAGE_FILTER_FIELDS.infos(),
    }
}

/// `GET /storage/objects/meta`.
pub(crate) async fn objects_meta() -> Json<ListMeta> {
    Json(list_meta())
}

/// The engine's listing query for the page params.
fn list_query(
    bucket: String,
    prefix: String,
    flat: bool,
    kind: StorageListKind,
    paging: &PageQuery,
    fresh: bool,
) -> Result<ConsoleListQuery, ApiError> {
    let order = match paging.sort(&list_meta())? {
        None => ListOrder::default(),
        Some((column, direction)) => ListOrder {
            column: match column.as_str() {
                "size" => SortColumn::Size,
                "updated" => SortColumn::Updated,
                "type" => SortColumn::Type,
                _ => SortColumn::Name,
            },
            descending: direction == Direction::Desc,
        },
    };
    let (filter, filter_key) = match paging.q.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        Some(q) => {
            let parsed = STORAGE_FILTER_FIELDS.parse(q)?;
            let filter = storage_filter(&parsed, OffsetDateTime::now_utc());
            let key = format!("{filter:?}");
            (Some(filter), key)
        }
        None => (None, String::new()),
    };
    Ok(ConsoleListQuery {
        bucket,
        prefix,
        flat,
        kind: kind.into(),
        order,
        filter,
        filter_key,
        after: paging.after::<ListCursor>()?,
        before: paging.before::<ListCursor>()?,
        limit: paging.limit(DEFAULT_LIMIT, MAX_LIMIT),
        fresh,
    })
}

/// A page of rows within the foundation's byte budget: trimmed from the
/// end of a page read forwards, from the start of one read backwards, so
/// no row is ever skipped.
fn page(
    rows: Vec<(ListEntry, ListCursor)>,
    mut more_after: bool,
    mut more_before: bool,
    backwards: bool,
    total: Option<Total>,
) -> Page<StorageEntry> {
    let mut items: Vec<(StorageEntry, ListCursor, usize)> = rows
        .into_iter()
        .map(|(row, cursor)| {
            let item = entry(&row);
            let size = serde_json::to_vec(&item).map_or(0, |json| json.len() + 1);
            (item, cursor, size)
        })
        .collect();
    let mut bytes: usize = items.iter().map(|(_, _, size)| size).sum();
    while bytes > PAGE_BYTES && items.len() > 1 {
        let dropped = if backwards {
            more_before = true;
            items.remove(0)
        } else {
            more_after = true;
            items.pop().expect("more than one item")
        };
        bytes -= dropped.2;
    }
    Page {
        next_cursor: more_after
            .then(|| items.last().map(|(_, cursor, _)| encode_cursor(cursor)))
            .flatten(),
        prev_cursor: more_before
            .then(|| items.first().map(|(_, cursor, _)| encode_cursor(cursor)))
            .flatten(),
        items: items.into_iter().map(|(item, _, _)| item).collect(),
        total,
        scanned: None,
    }
}

/// `GET /storage/objects`: one page of a folder (folders first) or of
/// everything under it. A client must be allowed to list the folder.
pub(crate) async fn objects(
    State(routes): State<StorageRoutes>,
    headers: HeaderMap,
    Query(params): Query<StorageListParams>,
) -> Result<Json<StorageListPage>, ApiError> {
    let paging = PageQuery {
        limit: params.limit,
        cursor: params.cursor,
        before: params.before,
        q: params.q,
        sort: params.sort,
    };
    let query = list_query(
        params.bucket.clone(),
        params.prefix.clone(),
        params.flat,
        params.kind,
        &paging,
        params.fresh,
    )?;
    let backwards = query.before.is_some();
    let result = routes
        .api
        .list(&query, &identity(&headers), via_console(&headers))
        .await?;
    let total = result
        .totals
        .folders
        .zip(result.totals.files)
        .map(|(folders, files)| Total {
            count: folders + files,
            exact: true,
        });
    Ok(Json(StorageListPage {
        page: page(
            result.entries,
            result.more_after,
            result.more_before,
            backwards,
            total,
        ),
        bucket: params.bucket,
        prefix: params.prefix,
        totals: StorageListTotals {
            folders: result.totals.folders,
            files: result.totals.files,
            bytes: result.totals.bytes,
            filtered: result.totals.filtered,
        },
        placeholder: result.placeholder,
        revision: result.revision,
        decision: result.decision,
        stale: result.stale,
        changes_since: result.changes_since,
    }))
}

/// `POST /storage/objects:batchGet`: the rows a live event named, for a
/// listing by name, and the loaded page each falls in.
pub(crate) async fn batch_get(
    State(routes): State<StorageRoutes>,
    headers: HeaderMap,
    ConsoleJson(body): ConsoleJson<StorageBatchGetRequest>,
) -> Result<Json<BatchGetResponse<StorageEntry>>, ApiError> {
    body.request.check()?;
    let paging = PageQuery {
        q: body.request.q.clone(),
        sort: body.request.sort.clone(),
        ..PageQuery::default()
    };
    let scope = list_query(
        body.bucket,
        body.prefix,
        body.flat,
        body.kind,
        &paging,
        false,
    )?;
    let (starts, end) = body.request.window::<ListCursor>()?;
    let rows = routes.api.batch_get(
        &scope,
        &body.request.keys,
        &identity(&headers),
        via_console(&headers),
    )?;
    Ok(Json(BatchGetResponse {
        items: body
            .request
            .keys
            .iter()
            .zip(rows)
            .map(|(key, row)| BatchGetItem {
                key: key.clone(),
                page: row
                    .as_ref()
                    .and_then(|(_, cursor)| page_of(cursor, &starts, end.as_ref()))
                    .and_then(|page| u32::try_from(page).ok()),
                row: row.map(|(row, _)| entry(&row)),
            })
            .collect(),
    }))
}

/// `POST /storage/objects:exists`: which of the names are taken (an upload's
/// conflict check).
pub(crate) async fn exists(
    State(routes): State<StorageRoutes>,
    ConsoleJson(body): ConsoleJson<StorageExistsBody>,
) -> Result<Json<StorageExistsResult>, ApiError> {
    Ok(Json(StorageExistsResult {
        existing: routes.api.exists(&body.bucket, &body.names)?,
    }))
}

/// `?bucket&prefix`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FolderQuery {
    bucket: String,
    #[serde(default)]
    prefix: String,
}

/// `GET /storage/folder`: one folder's counts, waiting up to 30 s for the
/// folder index.
pub(crate) async fn folder(
    State(routes): State<StorageRoutes>,
    Query(query): Query<FolderQuery>,
) -> Result<Json<StorageFolder>, ApiError> {
    if !(query.prefix.is_empty() || query.prefix.ends_with('/')) {
        return Err(ApiError::invalid("prefix must be empty or end with `/`."));
    }
    if !routes
        .api
        .folder_index_ready(firenook_storage_front::INDEX_WAIT)
        .await
        .map_err(|error| ApiError::unavailable(error.to_string()))?
    {
        return Err(ApiError::unavailable(
            "The folder index is still being built; try again in a moment.",
        ));
    }
    let stats = routes
        .api
        .folder(&query.bucket, &query.prefix)
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "Nothing is stored under {} in gs://{}.",
                if query.prefix.is_empty() {
                    "/"
                } else {
                    &query.prefix
                },
                query.bucket
            ))
        })?;
    Ok(Json(folder_counts(&query.bucket, &query.prefix, &stats)))
}

/// `GET /storage/folder/profile`: what a folder holds.
pub(crate) async fn profile(
    State(routes): State<StorageRoutes>,
    Query(query): Query<FolderQuery>,
) -> Result<Json<StorageProfile>, ApiError> {
    let api = routes.api.clone();
    let profile = blocking("the folder profile", move || {
        Ok(api.profile(&query.bucket, &query.prefix))
    })
    .await?;
    Ok(Json(StorageProfile {
        bucket: profile.bucket,
        prefix: profile.prefix,
        objects: profile.objects,
        bytes: profile.bytes,
        max_size: profile.max_size,
        typical_size: profile.typical_size,
        content_types: profile
            .content_types
            .into_iter()
            .map(|(content_type, objects, bytes)| StorageContentTypeCount {
                content_type,
                objects,
                bytes,
            })
            .collect(),
        metadata_keys: profile.metadata_keys,
        child_folders: profile.child_folders,
        sampled: profile.sampled,
    }))
}

/// `POST /storage/folders`: the marker of a new folder.
pub(crate) async fn create_folder(
    State(routes): State<StorageRoutes>,
    headers: HeaderMap,
    ConsoleJson(body): ConsoleJson<StorageCreateFolderBody>,
) -> Result<(StatusCode, Json<StorageFolderEntry>), ApiError> {
    let (prefix, stats) = routes
        .api
        .create_folder(
            &body.bucket,
            &body.prefix,
            &identity(&headers),
            via_console(&headers),
        )
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(folder_entry(&FolderEntry { prefix, stats })),
    ))
}

/// `?bucket&name`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ObjectQuery {
    bucket: String,
    name: String,
}

/// `GET /storage/object`: one object as the identity may read it.
pub(crate) async fn object(
    State(routes): State<StorageRoutes>,
    headers: HeaderMap,
    Query(query): Query<ObjectQuery>,
) -> Result<Json<StorageObjectDetail>, ApiError> {
    let view = routes
        .api
        .object(
            &query.bucket,
            &query.name,
            &identity(&headers),
            via_console(&headers),
        )
        .await?;
    Ok(Json(object_detail(view)))
}

/// `PUT /storage/object?bucket&name`: a streaming upload through the commit
/// path. `Content-Type` is the object's; `x-firenook-metadata` carries the
/// rest; `If-None-Match: *` refuses a taken name; `x-firenook-keep-tokens`
/// keeps the replaced object's tokens (Admin only).
pub(crate) async fn upload(
    State(routes): State<StorageRoutes>,
    headers: HeaderMap,
    Query(query): Query<ObjectQuery>,
    body: Body,
) -> Result<Json<StorageObjectDetail>, ApiError> {
    let header_text = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let mut spec = match header_text(METADATA_HEADER) {
        Some(value) => firenook_storage_front::parse_metadata_header(value)?,
        None if headers.contains_key(METADATA_HEADER) => {
            return Err(ApiError::invalid(
                "x-firenook-metadata must be b64.<base64url of the JSON>.",
            ));
        }
        None => ConsoleUpload::default(),
    };
    spec.bucket = query.bucket;
    spec.name = query.name;
    spec.content_type = header_text(header::CONTENT_TYPE.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    spec.if_none_match =
        header_text(header::IF_NONE_MATCH.as_str()).is_some_and(|value| value.trim() == "*");
    spec.keep_tokens = header_text(KEEP_TOKENS_HEADER).is_some_and(|value| value.trim() == "true");
    spec.console = via_console(&headers);
    let view = routes.api.upload(spec, body, &identity(&headers)).await?;
    Ok(Json(object_detail(view)))
}

/// `DELETE /storage/object`.
pub(crate) async fn delete_object(
    State(routes): State<StorageRoutes>,
    headers: HeaderMap,
    ConsoleJson(body): ConsoleJson<StorageDeleteObjectBody>,
) -> Result<StatusCode, ApiError> {
    routes
        .api
        .delete(
            &body.bucket,
            &body.name,
            &identity(&headers),
            via_console(&headers),
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /storage/object/metadata`: a patch, judged as `update`.
pub(crate) async fn update_metadata(
    State(routes): State<StorageRoutes>,
    headers: HeaderMap,
    ConsoleJson(body): ConsoleJson<StorageUpdateObjectBody>,
) -> Result<Json<StorageObjectDetail>, ApiError> {
    let if_metageneration = body
        .if_metageneration_match
        .as_deref()
        .map(|value| {
            value.parse::<u64>().map_err(|_| {
                ApiError::invalid("ifMetagenerationMatch is a decimal metageneration.")
            })
        })
        .transpose()?;
    let view = routes
        .api
        .update_metadata(
            &body.bucket,
            &body.name,
            &body.metadata.engine(),
            if_metageneration,
            &identity(&headers),
            via_console(&headers),
        )
        .await?;
    Ok(Json(object_detail(view)))
}

/// `POST /storage/object/token`: create or revoke a download token (Admin
/// only).
pub(crate) async fn token(
    State(routes): State<StorageRoutes>,
    headers: HeaderMap,
    ConsoleJson(body): ConsoleJson<StorageTokenBody>,
) -> Result<Json<StorageObjectDetail>, ApiError> {
    let op = match body.action {
        StorageTokenAction::Create => TokenOp::Create,
        StorageTokenAction::Revoke => TokenOp::Revoke(
            body.token
                .ok_or_else(|| ApiError::invalid("Revoking a token names the token."))?,
        ),
    };
    let view = routes
        .api
        .token(
            &body.bucket,
            &body.name,
            &op,
            &identity(&headers),
            via_console(&headers),
        )
        .await?;
    Ok(Json(object_detail(view)))
}

/// `POST /storage/object/resend`: the object's event again, with fresh ids
/// (Admin only).
pub(crate) async fn resend(
    State(routes): State<StorageRoutes>,
    headers: HeaderMap,
    ConsoleJson(body): ConsoleJson<StorageResendEventBody>,
) -> Result<Json<StorageResendResult>, ApiError> {
    let delivery = routes.api.resend(
        &body.bucket,
        &body.name,
        match body.event {
            StorageResendEvent::Finalize => ResendEvent::Finalize,
            StorageResendEvent::MetadataUpdate => ResendEvent::MetadataUpdate,
        },
        &identity(&headers),
    )?;
    Ok(Json(StorageResendResult {
        sent: delivery == EventDelivery::Sent,
        delivery: delivery.into(),
    }))
}

/// `?bucket&name&g&download`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaQuery {
    bucket: String,
    name: String,
    g: Option<String>,
    #[serde(default)]
    download: Option<String>,
}

/// `GET /storage/object/media`: the bytes, with the console's own
/// disposition, `nosniff` and a sandbox CSP.
pub(crate) async fn media(
    State(routes): State<StorageRoutes>,
    headers: HeaderMap,
    Query(query): Query<MediaQuery>,
) -> Result<Response, ApiError> {
    let mode = if matches!(query.download.as_deref(), Some("1" | "true")) {
        MediaMode::Attachment
    } else {
        MediaMode::Inline
    };
    let generation = query.g.as_deref().and_then(|value| value.parse().ok());
    Ok(routes
        .api
        .media(&query.bucket, &query.name, generation, &headers, mode)
        .await?)
}

/// `?bucket&name&g&w`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ThumbnailQuery {
    bucket: String,
    name: String,
    g: Option<String>,
    w: Option<u32>,
}

/// `GET /storage/object/thumbnail`: a 160, 320 or 640 pixel picture,
/// cached for ever by generation.
pub(crate) async fn thumbnail(
    State(routes): State<StorageRoutes>,
    Query(query): Query<ThumbnailQuery>,
) -> Result<Response, ApiError> {
    let generation = query.g.as_deref().and_then(|value| value.parse().ok());
    let (thumbnail, current) = routes
        .api
        .thumbnail(
            &query.bucket,
            &query.name,
            generation,
            query.w.unwrap_or(320),
        )
        .await?;
    let mut response = Body::from(thumbnail.bytes.to_vec()).into_response();
    let response_headers = response.headers_mut();
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(thumbnail.content_type),
    );
    response_headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if current {
            "private, max-age=31536000, immutable"
        } else {
            "no-store"
        }),
    );
    Ok(response)
}

/// `?bucket&name&g&limit`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArchiveQuery {
    bucket: String,
    name: String,
    #[allow(
        dead_code,
        reason = "the generation the URL names, for the browser's cache"
    )]
    g: Option<String>,
    limit: Option<usize>,
}

/// `GET /storage/object/archive`: a zip's entries from its central
/// directory.
pub(crate) async fn archive(
    State(routes): State<StorageRoutes>,
    Query(query): Query<ArchiveQuery>,
) -> Result<Json<StorageArchive>, ApiError> {
    let listing = routes
        .api
        .archive(
            &query.bucket,
            &query.name,
            query
                .limit
                .unwrap_or(firenook_storage_front::ARCHIVE_ENTRIES),
        )
        .await?;
    Ok(Json(StorageArchive {
        entries: listing
            .entries
            .into_iter()
            .map(|entry| StorageArchiveEntry {
                name: entry.name,
                size: entry.size,
                compressed: entry.compressed,
                directory: entry.directory,
            })
            .collect(),
        total: listing.total,
        truncated: listing.truncated,
    }))
}

/// `GET /storage/object/activity`: the object's changes and the decisions
/// on its name, from the rings and their name indexes.
pub(crate) async fn activity(
    State(routes): State<StorageRoutes>,
    Query(query): Query<ObjectQuery>,
) -> Json<StorageActivity> {
    let (changes, changes_since) = routes.api.activity(&query.bucket, &query.name);
    let (mut decisions, decisions_since) =
        routes.feed.as_ref().map_or((Vec::new(), None), |feed| {
            (feed.of(&query.bucket, &query.name), feed.since())
        });
    decisions.reverse();
    Json(StorageActivity {
        changes: changes.iter().map(change).collect(),
        decisions,
        diagnostics: routes.feed.is_some(),
        changes_since: changes_since.and_then(|at| at.format(&Rfc3339).ok()),
        decisions_since,
    })
}

/// `GET /storage/object/events`: the event bodies the object produces now.
pub(crate) async fn events(
    State(routes): State<StorageRoutes>,
    Query(query): Query<ObjectQuery>,
) -> Result<Json<StorageEventPayloads>, ApiError> {
    let payloads = routes.api.event_payloads(&query.bucket, &query.name)?;
    let bodies = |bodies: firenook_storage_front::EventBodies| StorageEventBodies {
        v1: bodies.v1,
        v2: bodies.v2,
    };
    Ok(Json(StorageEventPayloads {
        functions: payloads.functions,
        finalize: bodies(payloads.finalize),
        metadata_update: bodies(payloads.metadata_update),
        delete: bodies(payloads.delete),
    }))
}

/// `POST /storage/objects:export`: a selection becomes a download ticket.
pub(crate) async fn export_ticket(
    State(routes): State<StorageRoutes>,
    ConsoleJson(body): ConsoleJson<StorageExportBody>,
) -> Result<Json<StorageExportTicket>, ApiError> {
    body.target.check()?;
    let source = super::bulk::source(&body.bucket, &body.target)?;
    let api = routes.api.clone();
    let bucket = body.bucket;
    let ticket = blocking("the download", move || {
        Ok(api.export_ticket(&bucket, &source)?)
    })
    .await?;
    Ok(Json(StorageExportTicket {
        url: format!(
            "/console/api/v1/storage/objects:export?ticket={}",
            ticket.id
        ),
        objects: ticket.objects,
        bytes: ticket.bytes,
    }))
}

/// `?bucket&prefix` or `?ticket`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExportQuery {
    bucket: Option<String>,
    prefix: Option<String>,
    ticket: Option<String>,
}

/// `GET /storage/objects:export`: a folder, the bucket, or a ticket's
/// selection, as one streamed `.zip`.
pub(crate) async fn export_stream(
    State(routes): State<StorageRoutes>,
    Query(query): Query<ExportQuery>,
) -> Result<Response, ApiError> {
    let source = match (query.ticket, query.bucket) {
        (Some(ticket), _) => ExportSource::Ticket(ticket),
        (None, Some(bucket)) => ExportSource::Folder {
            bucket,
            prefix: query.prefix.unwrap_or_default(),
        },
        (None, None) => {
            return Err(ApiError::invalid(
                "A download names a bucket (and a folder) or a ticket.",
            ));
        }
    };
    let (file_name, body) = routes.api.export_stream(&source)?;
    let mut response = body.into_response();
    let response_headers = response.headers_mut();
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    if let Ok(value) = HeaderValue::from_str(&format!(
        "attachment; filename*=UTF-8''{}",
        percent_encode(&file_name)
    )) {
        response_headers.insert(header::CONTENT_DISPOSITION, value);
    }
    response_headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

/// A file name for `filename*`.
fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}
