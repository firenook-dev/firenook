//! The handle a console calls: plain Rust over the service's own state, so
//! every read and write shares the real paths, rules and lock discipline.
//! No console wire types are invented here; the console crate maps these
//! answers to its API.
//!
//! Who a call acts as is an [`Identity`]: the operator (Admin, as owner
//! credentials are) skips the rules and may look into a bucket the emulator
//! refuses to clients, which is the way to fix one; a client identity meets
//! exactly the rules an app meets, and a refusal carries its explanation.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use axum::http::HeaderMap;
use axum::response::Response;
use time::OffsetDateTime;
use tokio::sync::broadcast;

use crate::archive::ArchiveListing;
use crate::decisions::{NO_RULESET_MESSAGE, RulesCheck, judge};
use crate::download::MediaMode;
use crate::filter::StorageFilter;
use crate::folder_index::{self, FolderIndexError, FolderStats};
use crate::listing::{
    FastScope, ListCursor, ListEntry, ListKind, ListOrder, fast_page, fast_row, is_marker,
};
use crate::rules::{
    Operation, RulesMode, RulesScope, Verdict, auth_from_authorization, evaluation_request, now,
    rules_object,
};
use crate::rules_manager::{ConsoleRefusal, StorageRulesHandle};
use crate::search::SearchOutcome;
use crate::sniff::Sniffed;
use crate::staging::{self, InFlight};
use crate::thumbnails::{THUMBNAIL_WIDTHS, Thumbnail, ThumbnailError};
use crate::view_cache::{self, ViewKey};
use crate::{
    ChangeEvent, ObjectChangeRecord, StorageState, StoredObject, known_buckets, lock, object_key,
};

/// How long a listing that needs the folder index waits for it.
pub const INDEX_WAIT: Duration = Duration::from_secs(30);
/// Names one existence check takes.
pub const EXISTS_NAMES: usize = 1_000;
/// Objects a folder profile reads at most.
pub const PROFILE_OBJECTS: usize = 50_000;

/// The figures the Overview shows for Storage.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StorageSummaryCounts {
    /// Buckets the console knows: configured, and every one holding objects.
    pub buckets: usize,
    /// Files in every bucket; `None` while the folder index is being built.
    pub objects: Option<u64>,
    /// Their bytes; `None` while the folder index is being built.
    pub bytes: Option<u64>,
}

/// Who a console call acts as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Identity {
    /// The operator: skips the rules, as owner credentials do.
    Admin,
    /// A client: the rules judge the `Authorization` header it carries, or
    /// an unauthenticated request without one.
    Client { authorization: Option<String> },
}

impl Identity {
    /// The identity an `Authorization` header names: owner credentials are
    /// Admin, anything else (or nothing) a client.
    #[must_use]
    pub fn from_authorization(authorization: Option<&str>) -> Self {
        match authorization {
            Some("Bearer owner" | "Firebase owner") => Self::Admin,
            other => Self::Client {
                authorization: other.map(str::to_owned),
            },
        }
    }

    /// The header the rules judge.
    pub(crate) fn authorization(&self) -> Option<&str> {
        match self {
            Self::Admin => Some("Bearer owner"),
            Self::Client { authorization } => authorization.as_deref(),
        }
    }
}

/// Why a console call failed, in the console's own vocabulary.
#[derive(Clone, Debug, PartialEq)]
pub enum ConsoleError {
    /// The request is malformed (400).
    Invalid(String),
    /// Nothing at that name (404).
    NotFound(String),
    /// The name is taken (409).
    AlreadyExists(String),
    /// The rules refused, a client asked for an Admin-only action, or the
    /// bucket has no ruleset (403).
    Denied {
        message: String,
        fix: Option<String>,
        /// A rules refusal, explained.
        refusal: Option<Box<ConsoleRefusal>>,
        /// The bucket has no loaded ruleset.
        no_ruleset: bool,
    },
    /// The object changed since it was read (412).
    Precondition { message: String, current: u64 },
    /// The request conflicts with the current state (409).
    Conflict(String),
    /// A type with no thumbnail or archive (415).
    Unsupported(String),
    /// Over a limit (413).
    TooLarge(String),
    /// Cannot answer now (503).
    Unavailable(String),
    /// A fault (500).
    Internal(String),
}

impl std::fmt::Display for ConsoleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message)
            | Self::NotFound(message)
            | Self::AlreadyExists(message)
            | Self::Conflict(message)
            | Self::Unsupported(message)
            | Self::TooLarge(message)
            | Self::Unavailable(message)
            | Self::Internal(message)
            | Self::Denied { message, .. }
            | Self::Precondition { message, .. } => formatter.write_str(message),
        }
    }
}

impl std::error::Error for ConsoleError {}

impl From<FolderIndexError> for ConsoleError {
    fn from(error: FolderIndexError) -> Self {
        Self::Unavailable(error.to_string())
    }
}

fn not_found(bucket: &str, name: &str) -> ConsoleError {
    ConsoleError::NotFound(format!("No object {name} in gs://{bucket}."))
}

/// One bucket the console can show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BucketInfo {
    pub name: String,
    pub is_default: bool,
    /// Named by `firebase.json`, or the project default.
    pub configured: bool,
    /// A ruleset is loaded for it (always, without rules).
    pub served: bool,
    /// The rules file governing it, when one does.
    pub rules_file: Option<PathBuf>,
    /// `None` while the folder index is being built.
    pub objects: Option<u64>,
    pub bytes: Option<u64>,
    pub in_flight: InFlight,
}

/// Every bucket the console can show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Buckets {
    pub default_bucket: String,
    /// `None` when the service runs without rules.
    pub rules_mode: Option<RulesMode>,
    /// The default bucket first, then configured buckets, then any other
    /// bucket holding objects, by name.
    pub buckets: Vec<BucketInfo>,
    pub index_ready: bool,
}

/// One console listing request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsoleListQuery {
    pub bucket: String,
    /// Empty for the bucket root, else ending in `/`; empty segments kept.
    pub prefix: String,
    /// Every file below the folder, without folders.
    pub flat: bool,
    pub kind: ListKind,
    pub order: ListOrder,
    pub filter: Option<StorageFilter>,
    /// The filter as the console normalized it, for the view cache.
    pub filter_key: String,
    pub after: Option<ListCursor>,
    pub before: Option<ListCursor>,
    pub limit: usize,
    /// A view whose folder moved is rebuilt now instead of served stale
    /// within its window: what an explicit Refresh asks for.
    pub fresh: bool,
}

impl ConsoleListQuery {
    /// By name, ascending, unfiltered: read straight from the map.
    #[must_use]
    pub fn fast(&self) -> bool {
        self.order == ListOrder::default()
            && self.filter.as_ref().is_none_or(StorageFilter::is_empty)
    }

    fn scope(&self) -> FastScope<'_> {
        FastScope {
            bucket: &self.bucket,
            prefix: &self.prefix,
            flat: self.flat,
            kind: self.kind,
        }
    }

    fn view_key(&self) -> ViewKey {
        ViewKey {
            bucket: self.bucket.clone(),
            prefix: self.prefix.clone(),
            flat: self.flat,
            kind: self.kind,
            order: self.order,
            filter: self.filter_key.clone(),
        }
    }
}

/// What the whole listing holds, not only one page.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ListTotals {
    /// Direct subfolders (zero in a flat listing).
    pub folders: Option<u64>,
    pub files: Option<u64>,
    pub bytes: Option<u64>,
    /// The counts are a filter's matches.
    pub filtered: bool,
}

/// One page of a console listing.
#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "independent facts about one page, each said on the wire"
)]
pub struct ListResult {
    /// Each entry with the cursor that continues after it.
    pub entries: Vec<(ListEntry, ListCursor)>,
    pub more_after: bool,
    pub more_before: bool,
    pub totals: ListTotals,
    /// A marker object names the listed folder.
    pub placeholder: bool,
    /// The storage revision the page was read at.
    pub revision: u64,
    /// The decision that allowed a client to list, when recorded.
    pub decision: Option<String>,
    /// A sorted or filtered view served after its folder changed.
    pub stale: bool,
    pub changes_since: u64,
}

/// One object, everything the engine knows about it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectView {
    pub bucket: String,
    pub name: String,
    pub size: u64,
    pub content_type: Option<String>,
    pub cache_control: Option<String>,
    pub content_disposition: Option<String>,
    pub content_encoding: Option<String>,
    pub content_language: Option<String>,
    pub custom_metadata: BTreeMap<String, String>,
    /// Empty unless `tokens_visible`.
    pub download_tokens: Vec<String>,
    /// Only Admin may read tokens.
    pub tokens_visible: bool,
    pub md5_hash: String,
    /// Base64 big-endian, as the JSON API writes it.
    pub crc32c: String,
    pub etag: String,
    pub generation: u64,
    pub metageneration: u64,
    pub storage_class: String,
    pub time_created: String,
    pub updated: String,
    pub sniffed: Option<Sniffed>,
    /// A zero-byte folder marker.
    pub placeholder: bool,
    /// The decision that allowed a client to read it.
    pub decision: Option<String>,
}

impl ObjectView {
    pub(crate) fn of(object: &StoredObject, admin: bool) -> Self {
        use base64::Engine as _;
        Self {
            bucket: object.bucket.clone(),
            name: object.name.clone(),
            size: object.size,
            content_type: object.content_type.clone(),
            cache_control: object.cache_control.clone(),
            content_disposition: object.content_disposition.clone(),
            content_encoding: object.content_encoding.clone(),
            content_language: object.content_language.clone(),
            custom_metadata: object.custom_metadata.clone(),
            download_tokens: if admin {
                object.download_tokens.clone()
            } else {
                Vec::new()
            },
            tokens_visible: admin,
            md5_hash: object.md5_hash.clone(),
            crc32c: crate::BASE64.encode(object.crc32c.to_be_bytes()),
            etag: object.etag.clone(),
            generation: object.generation,
            metageneration: object.metageneration,
            storage_class: object.storage_class.clone(),
            time_created: object.time_created.clone(),
            updated: object.updated.clone(),
            sniffed: None,
            placeholder: is_marker(object),
            decision: None,
        }
    }
}

/// What a folder holds, for starter rules, completion and filter values.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Profile {
    pub bucket: String,
    pub prefix: String,
    pub objects: u64,
    pub bytes: u64,
    pub max_size: u64,
    /// The 95th percentile of sizes.
    pub typical_size: u64,
    /// Up to eight `(contentType, objects, bytes)`, most objects first.
    pub content_types: Vec<(String, u64, u64)>,
    /// Up to twenty custom metadata keys, most frequent first.
    pub metadata_keys: Vec<String>,
    /// Up to two hundred direct subfolder names (without the slash).
    pub child_folders: Vec<String>,
    /// Read from the first 50,000 objects only.
    pub sampled: bool,
}

/// What the console's routes, topics, search, summary and clear call. A
/// cheap clone of the runtime's state.
#[derive(Clone)]
pub struct StorageConsoleApi {
    state: StorageState,
}

impl StorageConsoleApi {
    pub(crate) const fn new(state: StorageState) -> Self {
        Self { state }
    }

    pub(crate) const fn state_ref(&self) -> &StorageState {
        &self.state
    }

    /// The bucket `getStorage()` uses when given none.
    #[must_use]
    pub fn default_bucket(&self) -> String {
        self.state.default_bucket()
    }

    /// How `firebase.json` assigns rules to buckets; `None` when the
    /// service runs without rules (every request allowed).
    #[must_use]
    pub fn rules_mode(&self) -> Option<RulesMode> {
        self.state
            .rules
            .as_ref()
            .map(crate::rules::NativeRules::mode)
    }

    /// The Storage rules: what is in force, installs, history, decisions,
    /// dry runs and coverage; `None` when the service runs without rules.
    #[must_use]
    pub fn rules(&self) -> Option<StorageRulesHandle> {
        self.state
            .rules
            .is_some()
            .then(|| StorageRulesHandle::new(self.state.clone()))
    }

    /// The suite runs Functions, so object changes send Storage events.
    #[must_use]
    pub fn functions(&self) -> bool {
        self.state.options.functions
    }

    /// Rules decisions are recorded (the suite's diagnostics are on).
    #[must_use]
    pub fn diagnostics(&self) -> bool {
        self.state.decisions.is_some()
    }

    /// The storage revision: every committed change moved it on by one.
    #[must_use]
    pub fn revision(&self) -> u64 {
        lock(&self.state.inner).revision
    }

    /// Every object change from now on, in commit order.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<ChangeEvent> {
        self.state.feed.subscribe()
    }

    /// One object's changes the engine still holds, newest first, and the
    /// time its window starts (the oldest change it holds of any object).
    #[must_use]
    pub fn activity(
        &self,
        bucket: &str,
        name: &str,
    ) -> (Vec<ObjectChangeRecord>, Option<OffsetDateTime>) {
        self.state.feed.activity(bucket, name)
    }

    /// Buckets at once, and objects and bytes once the folder index is built.
    /// The first call starts the index walk; none waits for it.
    #[must_use]
    pub fn summary(&self) -> StorageSummaryCounts {
        folder_index::ensure_built(&self.state);
        let data = lock(&self.state.inner);
        let mut buckets = known_buckets(&self.state, &data);
        buckets.insert(self.state.default_bucket());
        let buckets = buckets.len();
        match &data.folders {
            Some(index) if index.is_built() => {
                let (objects, bytes) =
                    index
                        .roots()
                        .fold((0_u64, 0_u64), |(objects, bytes), (_, root)| {
                            (objects + root.objects, bytes.saturating_add(root.bytes))
                        });
                StorageSummaryCounts {
                    buckets,
                    objects: Some(objects),
                    bytes: Some(bytes),
                }
            }
            _ => StorageSummaryCounts {
                buckets,
                objects: None,
                bytes: None,
            },
        }
    }

    /// Every bucket the console can show: the default bucket first, then
    /// configured ones, then any other holding objects. Never waits for the
    /// folder index (it starts its walk).
    #[must_use]
    pub fn buckets(&self) -> Buckets {
        folder_index::ensure_built(&self.state);
        let default_bucket = self.state.default_bucket();
        let rules = self.rules();
        let data = lock(&self.state.inner);
        let configured: BTreeSet<String> = match rules.as_ref().map(StorageRulesHandle::scopes) {
            Some(scopes) => scopes
                .into_iter()
                .filter_map(|scope| scope.bucket().map(str::to_owned))
                .collect(),
            None => BTreeSet::new(),
        };
        let mut names = known_buckets(&self.state, &data);
        names.insert(default_bucket.clone());
        let index = data.folders.as_ref().filter(|index| index.is_built());
        let mut buckets = names
            .into_iter()
            .map(|name| {
                let root = index.map(|index| index.stats(&name, "").unwrap_or_default());
                let (served, rules_file) = match &rules {
                    Some(rules) => {
                        let scope = rules.scope_of(&name);
                        (rules.current(&scope).is_some(), rules.file(&scope))
                    }
                    None => (true, None),
                };
                BucketInfo {
                    is_default: name == default_bucket,
                    configured: name == default_bucket || configured.contains(&name),
                    served,
                    rules_file,
                    objects: root.map(|root| root.objects),
                    bytes: root.map(|root| root.bytes),
                    in_flight: staging::in_flight(&self.state.staging, &data, &name),
                    name,
                }
            })
            .collect::<Vec<_>>();
        buckets.sort_by(|left, right| {
            right
                .is_default
                .cmp(&left.is_default)
                .then_with(|| right.configured.cmp(&left.configured))
                .then_with(|| left.name.cmp(&right.name))
        });
        Buckets {
            default_bucket,
            rules_mode: self.rules_mode(),
            buckets,
            index_ready: index.is_some(),
        }
    }

    /// Whether the folder index is built, starting its walk if no console
    /// has yet and waiting up to `wait` for it (zero: never waits). An error
    /// once the walk has failed for good.
    pub async fn folder_index_ready(&self, wait: Duration) -> Result<bool, FolderIndexError> {
        folder_index::ready(&self.state, wait).await
    }

    /// One folder's figures (`prefix` empty for the bucket root, else ending
    /// in `/`); `None` while the index is being built or when nothing is
    /// there.
    #[must_use]
    pub fn folder(&self, bucket: &str, prefix: &str) -> Option<FolderStats> {
        let data = lock(&self.state.inner);
        data.folders
            .as_ref()
            .filter(|index| index.is_built())
            .and_then(|index| index.stats(bucket, prefix))
    }

    /// Bytes staged by uploads still in progress in `bucket`: single
    /// uploads being received and resumable sessions not yet finished.
    #[must_use]
    pub fn in_flight(&self, bucket: &str) -> InFlight {
        let data = lock(&self.state.inner);
        staging::in_flight(&self.state.staging, &data, bucket)
    }

    /// Judges one console request as `who`. Admin and a service without
    /// rules skip them; a client meets them exactly as an app does, and a
    /// refusal carries its explanation.
    pub(crate) fn judge(
        &self,
        who: &Identity,
        check: &RulesCheck<'_>,
    ) -> Result<Option<String>, ConsoleError> {
        let (Identity::Client { .. }, Some(rules)) = (who, &self.state.rules) else {
            return Ok(None);
        };
        let judged = judge(rules, self.state.decisions.as_deref(), check);
        match judged.verdict {
            Verdict::Allowed => Ok(judged.decision),
            Verdict::Denied(error) => {
                if let Some(error) = &error {
                    self.state.log.emit(
                        crate::StorageLogLevel::Warn,
                        crate::log::RULES,
                        format!(
                            "{} on gs://{}/{} failed in the rules: {error}",
                            check.operation.method(),
                            check.bucket,
                            check.name
                        ),
                    );
                }
                let refusal = self.refusal(check, judged.decision);
                let fix = refusal
                    .line
                    .map(|line| format!("Line {line} refused it; see why on the Rules page."));
                Err(ConsoleError::Denied {
                    message: format!(
                        "Permission denied. No {} permission.",
                        check.operation.permission()
                    ),
                    fix,
                    refusal: Some(Box::new(refusal)),
                    no_ruleset: false,
                })
            }
            Verdict::NoRuleset => Err(ConsoleError::Denied {
                message: format!(
                    "No rules govern gs://{}, so every client request is refused.",
                    check.bucket
                ),
                fix: Some("Add the bucket to `storage` in firebase.json.".to_owned()),
                refusal: Some(Box::new(ConsoleRefusal {
                    decision: judged.decision,
                    line: None,
                    evaluation: None,
                    request: None,
                })),
                no_ruleset: true,
            }),
        }
    }

    /// The explanation of a refused console request: the same request,
    /// re-run with every expression's value.
    fn refusal(&self, check: &RulesCheck<'_>, decision: Option<String>) -> ConsoleRefusal {
        let request = evaluation_request(
            check.operation,
            check.bucket,
            check.name,
            check.before.map(rules_object),
            check.after.map(rules_object),
            auth_from_authorization(check.authorization),
            now(),
        );
        let replay = crate::dry_run::replay(check.bucket, check.name, &request);
        StorageRulesHandle::new(self.state.clone()).explain_refusal(&replay, decision)
    }

    /// One page of a folder, or of everything below it: by name straight
    /// from the map, otherwise from a cached view. A client must be allowed
    /// to `list` the folder.
    pub async fn list(
        &self,
        query: &ConsoleListQuery,
        who: &Identity,
        console: bool,
    ) -> Result<ListResult, ConsoleError> {
        check_prefix(&query.prefix)?;
        let decision = self.judge(
            who,
            &RulesCheck {
                bucket: &query.bucket,
                name: &query.prefix,
                operation: Operation::List,
                before: None,
                after: None,
                authorization: who.authorization(),
                console,
            },
        )?;
        folder_index::ensure_built(&self.state);
        if query.fast() {
            return self.fast_list(query, decision);
        }
        self.view_list(query, decision).await
    }

    fn fast_list(
        &self,
        query: &ConsoleListQuery,
        decision: Option<String>,
    ) -> Result<ListResult, ConsoleError> {
        for cursor in [&query.after, &query.before].into_iter().flatten() {
            let fits = match cursor {
                ListCursor::Level { .. } => !query.flat,
                ListCursor::Flat { .. } => query.flat,
                ListCursor::View { .. } => false,
            };
            if !fits {
                return Err(foreign_cursor());
            }
        }
        let data = lock(&self.state.inner);
        let page = fast_page(
            &data,
            &query.scope(),
            query.after.as_ref(),
            query.before.as_ref(),
            query.limit,
        );
        let totals = data
            .folders
            .as_ref()
            .filter(|index| index.is_built())
            .map_or_else(ListTotals::default, |index| {
                let stats = index
                    .stats(&query.bucket, &query.prefix)
                    .unwrap_or_default();
                if query.flat {
                    ListTotals {
                        folders: Some(0),
                        files: Some(stats.objects),
                        bytes: Some(stats.bytes),
                        filtered: false,
                    }
                } else {
                    ListTotals {
                        folders: Some(stats.folders),
                        files: Some(stats.direct_files),
                        bytes: Some(stats.direct_bytes),
                        filtered: false,
                    }
                }
            });
        Ok(ListResult {
            entries: page.entries,
            more_after: page.more_after,
            more_before: page.more_before,
            totals,
            placeholder: placeholder(&data, &query.bucket, &query.prefix),
            revision: data.revision,
            decision,
            stale: false,
            changes_since: 0,
        })
    }

    async fn view_list(
        &self,
        query: &ConsoleListQuery,
        decision: Option<String>,
    ) -> Result<ListResult, ConsoleError> {
        if [&query.after, &query.before]
            .into_iter()
            .flatten()
            .any(|cursor| !matches!(cursor, ListCursor::View { .. }))
        {
            return Err(foreign_cursor());
        }
        if !folder_index::ready(&self.state, INDEX_WAIT).await? {
            return Err(ConsoleError::Unavailable(
                "The folder index is still being built, so this sorted or filtered view cannot be made yet; try again in a moment.".to_owned(),
            ));
        }
        let served = view_cache::view(
            &self.state,
            &query.view_key(),
            query.filter.as_ref(),
            query.fresh,
        )
        .await
        .map_err(ConsoleError::Unavailable)?;
        let (range, more_after, more_before) =
            served
                .view
                .page(query.after.as_ref(), query.before.as_ref(), query.limit);
        let entries = view_cache::rows(
            &self.state,
            &served.view,
            &query.bucket,
            &query.prefix,
            range,
        );
        let data = lock(&self.state.inner);
        Ok(ListResult {
            entries,
            more_after,
            more_before,
            totals: ListTotals {
                folders: Some(served.view.folders),
                files: Some(served.view.files),
                bytes: Some(served.view.bytes),
                filtered: query
                    .filter
                    .as_ref()
                    .is_some_and(|filter| !filter.is_empty()),
            },
            placeholder: placeholder(&data, &query.bucket, &query.prefix),
            revision: data.revision,
            decision,
            stale: served.stale,
            changes_since: served.changes_since,
        })
    }

    /// The rows a live event named, for a listing by name: each key a file's
    /// full name or a folder's full prefix, answered under one short hold;
    /// `None` for a key that is gone or not an entry of the listing.
    pub fn batch_get(
        &self,
        scope: &ConsoleListQuery,
        keys: &[String],
        who: &Identity,
        console: bool,
    ) -> Result<Vec<Option<(ListEntry, ListCursor)>>, ConsoleError> {
        check_prefix(&scope.prefix)?;
        if !scope.fast() {
            return Err(ConsoleError::Invalid(
                "A batch read patches a list sorted by name without a filter; a sorted or filtered view is refreshed instead.".to_owned(),
            ));
        }
        self.judge(
            who,
            &RulesCheck {
                bucket: &scope.bucket,
                name: &scope.prefix,
                operation: Operation::List,
                before: None,
                after: None,
                authorization: who.authorization(),
                console,
            },
        )?;
        let data = lock(&self.state.inner);
        let fast = scope.scope();
        Ok(keys.iter().map(|key| fast_row(&data, &fast, key)).collect())
    }

    /// Which of `names` exist in `bucket` (at most [`EXISTS_NAMES`]), for
    /// an upload's conflict check.
    pub fn exists(&self, bucket: &str, names: &[String]) -> Result<Vec<String>, ConsoleError> {
        if names.len() > EXISTS_NAMES {
            return Err(ConsoleError::Invalid(format!(
                "An existence check names at most {EXISTS_NAMES} objects; this one names {}.",
                names.len()
            )));
        }
        let data = lock(&self.state.inner);
        Ok(names
            .iter()
            .filter(|name| data.objects.contains_key(&object_key(bucket, name)))
            .cloned()
            .collect())
    }

    /// One object as `who` may read it: a client is judged as `get`, and
    /// only Admin sees download tokens. What the first bytes are is read
    /// too.
    pub async fn object(
        &self,
        bucket: &str,
        name: &str,
        who: &Identity,
        console: bool,
    ) -> Result<ObjectView, ConsoleError> {
        let stored = self.stored(bucket, name);
        // The rules run before the existence check, as on the protocol: a
        // missing object is refused when the rules refuse.
        let decision = self.judge(
            who,
            &RulesCheck {
                bucket,
                name,
                operation: Operation::Get,
                before: stored.as_ref(),
                after: None,
                authorization: who.authorization(),
                console,
            },
        )?;
        let stored = stored.ok_or_else(|| not_found(bucket, name))?;
        let mut view = ObjectView::of(&stored, *who == Identity::Admin);
        view.decision = decision;
        let path = self.state.config.data_dir.join(&stored.data_file);
        let gzip = stored.content_encoding.as_deref() == Some("gzip");
        view.sniffed = tokio::task::spawn_blocking(move || crate::sniff::sniff_file(&path, gzip))
            .await
            .ok()
            .flatten();
        Ok(view)
    }

    pub(crate) fn stored(&self, bucket: &str, name: &str) -> Option<StoredObject> {
        lock(&self.state.inner)
            .objects
            .get(&object_key(bucket, name))
            .cloned()
    }

    /// The object's bytes for the console's media route (an operator read):
    /// `generation` is what the URL names; only the current one is cached
    /// for ever.
    pub async fn media(
        &self,
        bucket: &str,
        name: &str,
        generation: Option<u64>,
        request: &HeaderMap,
        mode: MediaMode,
    ) -> Result<Response, ConsoleError> {
        let stored = self
            .stored(bucket, name)
            .ok_or_else(|| not_found(bucket, name))?;
        crate::download::media_response(
            &self.state,
            &stored,
            request,
            mode,
            generation == Some(stored.generation),
        )
        .await
        .map_err(|error| ConsoleError::Internal(error.message))
    }

    /// A thumbnail of an image object (an operator read), `width` one of
    /// 160, 320 or 640, from the cache when made before for its generation.
    /// Also whether the URL named the current generation.
    pub async fn thumbnail(
        &self,
        bucket: &str,
        name: &str,
        generation: Option<u64>,
        width: u32,
    ) -> Result<(Thumbnail, bool), ConsoleError> {
        if !THUMBNAIL_WIDTHS.contains(&width) {
            return Err(ConsoleError::Invalid(
                "A thumbnail is 160, 320 or 640 pixels wide.".to_owned(),
            ));
        }
        let stored = self
            .stored(bucket, name)
            .ok_or_else(|| not_found(bucket, name))?;
        let current = generation == Some(stored.generation);
        let cache = &self.state.thumbnails;
        if let Some(thumbnail) = cache.get(bucket, name, stored.generation, width) {
            return Ok((thumbnail, current));
        }
        let _permit = cache
            .decodes
            .acquire()
            .await
            .map_err(|_| ConsoleError::Unavailable("The service is stopping.".to_owned()))?;
        // Another request may have made it while this one waited.
        if let Some(thumbnail) = cache.get(bucket, name, stored.generation, width) {
            return Ok((thumbnail, current));
        }
        let path = self.state.config.data_dir.join(&stored.data_file);
        let content_type = stored.content_type.clone();
        let gzip = stored.content_encoding.as_deref() == Some("gzip");
        let rendered = self
            .state
            .tasks
            .run_blocking(move || {
                crate::thumbnails::render(&path, content_type.as_deref(), gzip, width)
            })
            .ok_or_else(|| ConsoleError::Unavailable("The service is stopping.".to_owned()))?
            .await
            .map_err(|_| ConsoleError::Unavailable("The service is stopping.".to_owned()))?
            .map_err(|error| match error {
                ThumbnailError::Unsupported(message) | ThumbnailError::Unreadable(message) => {
                    ConsoleError::Unsupported(message)
                }
                ThumbnailError::TooLarge(message) => ConsoleError::TooLarge(message),
            })?;
        cache.insert(bucket, name, stored.generation, width, rendered.clone());
        Ok((rendered, current))
    }

    /// The entries of a `.zip` object, from its central directory (an
    /// operator read), at most `limit` (up to 2,000).
    pub async fn archive(
        &self,
        bucket: &str,
        name: &str,
        limit: usize,
    ) -> Result<ArchiveListing, ConsoleError> {
        let stored = self
            .stored(bucket, name)
            .ok_or_else(|| not_found(bucket, name))?;
        if stored.content_encoding.is_some() {
            return Err(ConsoleError::Unsupported(
                "This archive is stored with a contentEncoding; download it to look inside."
                    .to_owned(),
            ));
        }
        let path = self.state.config.data_dir.join(&stored.data_file);
        self.state
            .tasks
            .run_blocking(move || crate::archive::list(&path, limit))
            .ok_or_else(|| ConsoleError::Unavailable("The service is stopping.".to_owned()))?
            .await
            .map_err(|_| ConsoleError::Unavailable("The service is stopping.".to_owned()))?
            .map_err(|error| {
                ConsoleError::Unsupported(format!("This .zip cannot be read: {error}."))
            })
    }

    /// What a folder holds, read from its first [`PROFILE_OBJECTS`] files in
    /// chunks: content types, metadata keys, sizes and direct subfolders.
    /// Blocking: call it off the request workers.
    #[must_use]
    pub fn profile(&self, bucket: &str, prefix: &str) -> Profile {
        let mut profile = Profile {
            bucket: bucket.to_owned(),
            prefix: prefix.to_owned(),
            ..Profile::default()
        };
        let scope = object_key(bucket, prefix);
        let mut sizes = Vec::new();
        let mut types: HashMap<String, (u64, u64)> = HashMap::new();
        let mut keys: HashMap<String, u64> = HashMap::new();
        let mut after: Option<String> = None;
        'walk: loop {
            let data = lock(&self.state.inner);
            let range = match &after {
                Some(key) => data.objects.range::<str, _>((
                    std::ops::Bound::Excluded(key.as_str()),
                    std::ops::Bound::Unbounded,
                )),
                None => data.objects.range::<str, _>((
                    std::ops::Bound::Included(scope.as_str()),
                    std::ops::Bound::Unbounded,
                )),
            };
            let mut steps = 0;
            for (key, object) in range {
                if !key.starts_with(scope.as_str()) {
                    break 'walk;
                }
                after = Some(key.clone());
                steps += 1;
                if is_marker(object) {
                    continue;
                }
                if sizes.len() >= PROFILE_OBJECTS {
                    profile.sampled = true;
                    break 'walk;
                }
                sizes.push(object.size);
                profile.objects += 1;
                profile.bytes = profile.bytes.saturating_add(object.size);
                profile.max_size = profile.max_size.max(object.size);
                if let Some(content_type) = &object.content_type {
                    let entry = types.entry(content_type.clone()).or_default();
                    entry.0 += 1;
                    entry.1 = entry.1.saturating_add(object.size);
                }
                for key in object.custom_metadata.keys() {
                    if keys.len() < 1_000 || keys.contains_key(key) {
                        *keys.entry(key.clone()).or_default() += 1;
                    }
                }
                if steps >= 10_000 {
                    break;
                }
            }
            if steps < 10_000 {
                break;
            }
            drop(data);
            std::thread::sleep(Duration::from_micros(200));
        }
        sizes.sort_unstable();
        profile.typical_size = sizes
            .get((sizes.len() * 95).div_ceil(100).saturating_sub(1))
            .copied()
            .unwrap_or(0);
        let mut types = types.into_iter().collect::<Vec<_>>();
        types.sort_by(|left, right| right.1.0.cmp(&left.1.0).then_with(|| left.0.cmp(&right.0)));
        profile.content_types = types
            .into_iter()
            .take(8)
            .map(|(content_type, (objects, bytes))| (content_type, objects, bytes))
            .collect();
        let mut keys = keys.into_iter().collect::<Vec<_>>();
        keys.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
        profile.metadata_keys = keys.into_iter().take(20).map(|(key, _)| key).collect();
        profile.child_folders = self.child_folders(bucket, prefix, 200);
        profile
    }

    /// Up to `limit` direct subfolder names of `prefix`, without the slash.
    fn child_folders(&self, bucket: &str, prefix: &str, limit: usize) -> Vec<String> {
        let query = ConsoleListQuery {
            bucket: bucket.to_owned(),
            prefix: prefix.to_owned(),
            flat: false,
            kind: ListKind::Folders,
            order: ListOrder::default(),
            filter: None,
            filter_key: String::new(),
            after: None,
            before: None,
            limit,
            fresh: false,
        };
        let data = lock(&self.state.inner);
        fast_page(&data, &query.scope(), None, None, limit)
            .entries
            .into_iter()
            .filter_map(|(entry, _)| match entry {
                ListEntry::Folder(folder) => Some(
                    folder.prefix[prefix.len()..]
                        .trim_end_matches('/')
                        .to_owned(),
                ),
                ListEntry::File(_) => None,
            })
            .collect()
    }

    /// ⌘K: objects by name across buckets, folders from a built index.
    /// Blocking and bounded (its own deadline, `cancel`, `limit`).
    #[must_use]
    pub fn search(&self, text: &str, limit: usize, cancel: &AtomicBool) -> SearchOutcome {
        crate::search::search(&self.state, text, limit, cancel)
    }

    /// The scope whose rules govern `bucket`, when the service has rules.
    #[must_use]
    pub fn scope_of(&self, bucket: &str) -> Option<RulesScope> {
        self.state
            .rules
            .as_ref()
            .map(|rules| rules.scope_of(bucket))
    }

    /// The message a request to a bucket without rules is refused with.
    #[must_use]
    pub const fn no_ruleset_message() -> &'static str {
        NO_RULESET_MESSAGE
    }
}

/// A folder is the bucket root (empty) or ends with `/`.
fn check_prefix(prefix: &str) -> Result<(), ConsoleError> {
    if prefix.is_empty() || prefix.ends_with('/') {
        Ok(())
    } else {
        Err(ConsoleError::Invalid(
            "prefix must be empty or end with `/`.".to_owned(),
        ))
    }
}

fn foreign_cursor() -> ConsoleError {
    ConsoleError::Invalid(
        "This cursor belongs to another view of this folder; load the list again from its first page."
            .to_owned(),
    )
}

/// A marker object names the folder `prefix` of `bucket`.
fn placeholder(data: &crate::StorageData, bucket: &str, prefix: &str) -> bool {
    !prefix.is_empty()
        && data
            .objects
            .get(&object_key(bucket, prefix))
            .is_some_and(is_marker)
}
