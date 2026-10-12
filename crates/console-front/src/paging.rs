//! One paging contract for every list the console shows.
//!
//! A list answers a [`Page`]: at most `limit` items and at most
//! [`PAGE_BYTES`] of JSON, with opaque cursors both ways (`nextCursor` for
//! the page below, `prevCursor`, passed back as `before`, for the page
//! above), how many items match when the engine knows, and how far a scan
//! got when no index could answer the filter. A list serves its
//! [`ListMeta`] beside it, so the page shows a sort arrow only on columns an
//! ordered index backs, and the filter field completes the list's own
//! fields.
//!
//! A filter no index answers scans, at most [`ScanBudget`] per request, and
//! the sorted keys it found go into the section's [`ResultCache`], so later
//! pages and live refreshes slice them instead of scanning again. Tables of
//! rows that change in place re-read only the rows the live channel names
//! (`POST /<section>/<things>:batchGet`, [`BatchGetRequest`]), and
//! [`page_of`] says which loaded page a created row falls in.

use std::io::Write as _;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::filter::FieldSpecInfo;

/// One page of a list the engine pages. A section's page type may embed it
/// with `#[serde(flatten)] #[ts(flatten)]` and add facts beside it (totals,
/// a revision, whether the view is stale).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Page<T: TS> {
    pub items: Vec<T>,
    /// Pass back as `cursor` for the next page; absent at the end.
    pub next_cursor: Option<String>,
    /// Pass back as `before` for the page above this one; absent at the
    /// start. It is this page's first row as a cursor, which is also what a
    /// table sends as the page's start in a `:batchGet`.
    pub prev_cursor: Option<String>,
    /// How many items the query matches, when the engine knows.
    pub total: Option<Total>,
    /// How many items were examined when the filter needed a scan and the
    /// scan budget stopped it (`total.exact` is then false). Absent when an
    /// index answered or the scan finished.
    #[ts(type = "number | null")]
    pub scanned: Option<u64>,
}

/// A count, and whether it is exact.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
pub struct Total {
    #[ts(type = "number")]
    pub count: u64,
    /// False when counting stopped at a ceiling or a scan budget; `count` is
    /// then a floor.
    pub exact: bool,
}

/// The order of a sorted list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(
    dead_code,
    reason = "the section streams sort their lists with it; the foundation only parses it"
)]
pub(crate) enum Direction {
    Asc,
    Desc,
}

/// `?limit=&cursor=&before=&q=&sort=` on every list route.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    dead_code,
    reason = "the section streams read the filter and the cursors of their lists"
)]
pub(crate) struct PageQuery {
    pub(crate) limit: Option<u32>,
    pub(crate) cursor: Option<String>,
    pub(crate) before: Option<String>,
    pub(crate) q: Option<String>,
    pub(crate) sort: Option<String>,
}

#[allow(
    dead_code,
    reason = "the section streams page their lists with it; the tests here cover every part"
)]
impl PageQuery {
    /// The page size: `default` when absent, clamped to 1..=`max`.
    pub(crate) fn limit(&self, default: u32, max: u32) -> usize {
        let max = max.max(1);
        let limit = self.limit.unwrap_or(default).clamp(1, max);
        usize::try_from(limit).unwrap_or(usize::MAX)
    }

    /// `sort` (`<column>:asc`, `<column>:desc`, or a bare column for
    /// ascending) checked against `meta.sortable`; `None` without one.
    pub(crate) fn sort(&self, meta: &ListMeta) -> Result<Option<(String, Direction)>, ApiError> {
        let Some(raw) = self
            .sort
            .as_deref()
            .map(str::trim)
            .filter(|raw| !raw.is_empty())
        else {
            return Ok(None);
        };
        let (column, direction) = match raw.rsplit_once(':') {
            Some((column, "asc")) => (column, Direction::Asc),
            Some((column, "desc")) => (column, Direction::Desc),
            Some((_, other)) => {
                return Err(ApiError::invalid(format!(
                    "A sort is <column>:asc or <column>:desc, not `{raw}` (`{other}` is not a direction)."
                )));
            }
            None => (raw, Direction::Asc),
        };
        if meta.sortable.iter().any(|sortable| sortable == column) {
            return Ok(Some((column.to_owned(), direction)));
        }
        let sortable = if meta.sortable.is_empty() {
            "none".to_owned()
        } else {
            meta.sortable.join(", ")
        };
        Err(ApiError::invalid(format!(
            "This list cannot be sorted by {column}; sortable: {sortable}."
        )))
    }

    /// The `cursor` this page continues after, decoded.
    pub(crate) fn after<K: DeserializeOwned>(&self) -> Result<Option<K>, ApiError> {
        self.cursor.as_deref().map(decode_cursor).transpose()
    }

    /// The `before` this page ends at, decoded. A request carrying both
    /// cursors is refused: a page is read in one direction.
    pub(crate) fn before<K: DeserializeOwned>(&self) -> Result<Option<K>, ApiError> {
        if self.cursor.is_some() && self.before.is_some() {
            return Err(ApiError::invalid(
                "A page is read after `cursor` or before `before`, not both.",
            ));
        }
        self.before.as_deref().map(decode_cursor).transpose()
    }
}

/// What a list can do, served at `GET /<section>/<things>/meta` and read
/// once by the page: only these columns show a sort arrow.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ListMeta {
    /// Columns an ordered index backs, so a sorted page is a range read.
    pub sortable: Vec<String>,
    /// The order with no `sort`, as `<column>:asc|desc`.
    pub default_sort: String,
    /// Filter fields (the same specs the engine validates with), for the
    /// filter field's completions.
    pub fields: Vec<FieldSpecInfo>,
}

/// The byte budget of one page of JSON: a list stops adding items past it
/// and returns a cursor, so a page of large items is never megabytes.
pub(crate) const PAGE_BYTES: usize = 512 * 1024;

/// The page sizes every section uses unless it says otherwise.
#[allow(
    dead_code,
    reason = "the section streams page their lists with these defaults"
)]
pub(crate) const DEFAULT_LIMIT: u32 = 100;
/// The largest page a list serves.
#[allow(
    dead_code,
    reason = "the section streams page their lists with these defaults"
)]
pub(crate) const MAX_LIMIT: u32 = 500;

/// How much one request may examine when no index answers its filter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ScanBudget {
    pub(crate) items: usize,
    pub(crate) time: Duration,
}

#[allow(
    dead_code,
    reason = "the section streams scan with it; the tests here cover it"
)]
impl ScanBudget {
    /// 200,000 items or 30 ms, whichever comes first.
    pub(crate) const DEFAULT: Self = Self {
        items: 200_000,
        time: Duration::from_millis(30),
    };

    /// Starts counting against this budget.
    pub(crate) fn start(self) -> Scanner {
        Scanner {
            budget: self,
            started: Instant::now(),
            examined: 0,
            exhausted: false,
        }
    }
}

/// One scan's progress against its [`ScanBudget`].
#[derive(Debug)]
#[allow(
    dead_code,
    reason = "the section streams scan with it; the tests here cover it"
)]
pub(crate) struct Scanner {
    budget: ScanBudget,
    started: Instant,
    examined: usize,
    exhausted: bool,
}

#[allow(
    dead_code,
    reason = "the section streams scan with it; the tests here cover it"
)]
impl Scanner {
    /// How often the clock is read: reading it per item would cost more
    /// than most items do.
    const CLOCK_EVERY: usize = 256;

    /// Counts one more item about to be examined; `false` once the budget is
    /// spent (the item must then not be examined).
    pub(crate) fn examine(&mut self) -> bool {
        if self.exhausted {
            return false;
        }
        if self.examined >= self.budget.items
            || (self.examined.is_multiple_of(Self::CLOCK_EVERY)
                && self.examined > 0
                && self.started.elapsed() >= self.budget.time)
        {
            self.exhausted = true;
            return false;
        }
        self.examined += 1;
        true
    }

    /// Items examined so far.
    pub(crate) fn examined(&self) -> u64 {
        u64::try_from(self.examined).unwrap_or(u64::MAX)
    }

    /// Whether the budget stopped the scan.
    pub(crate) const fn exhausted(&self) -> bool {
        self.exhausted
    }
}

/// Sorted result sets for filters no index answers, per section: the first
/// page builds the sorted key list once (within the scan budget), later
/// cursor pages slice it. Keyed by (normalized filter, sort, data
/// revision); at most 8 entries, least recently used evicted first; every
/// entry of an older revision is dropped when a newer one is asked for; and
/// keys only, counted against the section's own limit (32 MiB by default).
pub(crate) struct ResultCache<K> {
    inner: Mutex<CacheInner<K>>,
    limit_bytes: usize,
}

struct CacheInner<K> {
    /// Most recently used last.
    entries: Vec<CacheEntry<K>>,
    bytes: usize,
}

struct CacheEntry<K> {
    filter: String,
    sort: String,
    revision: u64,
    keys: Arc<[K]>,
    bytes: usize,
}

#[allow(
    dead_code,
    reason = "the section streams cache their scans with it; the tests here cover it"
)]
impl<K> ResultCache<K> {
    /// Entries one cache keeps.
    const ENTRIES: usize = 8;
    /// A section's default limit for its cached keys.
    pub(crate) const DEFAULT_BYTES: usize = 32 * 1024 * 1024;

    /// An empty cache holding at most `limit_bytes` of keys.
    pub(crate) fn new(limit_bytes: usize) -> Self {
        Self {
            inner: Mutex::new(CacheInner {
                entries: Vec::new(),
                bytes: 0,
            }),
            limit_bytes,
        }
    }

    fn lock(&self) -> MutexGuard<'_, CacheInner<K>> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The keys cached for `filter` and `sort` at `revision`. Entries of an
    /// older revision are dropped: the data they were built from moved.
    pub(crate) fn get(&self, filter: &str, sort: &str, revision: u64) -> Option<Arc<[K]>> {
        let mut inner = self.lock();
        inner.drop_older(revision);
        let position = inner.entries.iter().position(|entry| {
            entry.revision == revision && entry.filter == filter && entry.sort == sort
        })?;
        let entry = inner.entries.remove(position);
        let keys = Arc::clone(&entry.keys);
        inner.entries.push(entry);
        Some(keys)
    }

    /// Caches `keys` (about `bytes` of memory) for `filter` and `sort` at
    /// `revision`, evicting the least recently used entries to stay within
    /// 8 entries and the byte limit. A set larger than the whole limit is
    /// not cached. Returns the keys, shared.
    pub(crate) fn insert(
        &self,
        filter: &str,
        sort: &str,
        revision: u64,
        keys: Vec<K>,
        bytes: usize,
    ) -> Arc<[K]> {
        let keys: Arc<[K]> = Arc::from(keys);
        if bytes > self.limit_bytes {
            return keys;
        }
        let mut inner = self.lock();
        inner.drop_older(revision);
        if let Some(position) = inner.entries.iter().position(|entry| {
            entry.revision == revision && entry.filter == filter && entry.sort == sort
        }) {
            let old = inner.entries.remove(position);
            inner.bytes -= old.bytes;
        }
        while !inner.entries.is_empty()
            && (inner.entries.len() >= Self::ENTRIES || inner.bytes + bytes > self.limit_bytes)
        {
            let evicted = inner.entries.remove(0);
            inner.bytes -= evicted.bytes;
        }
        inner.bytes += bytes;
        inner.entries.push(CacheEntry {
            filter: filter.to_owned(),
            sort: sort.to_owned(),
            revision,
            keys: Arc::clone(&keys),
            bytes,
        });
        keys
    }

    /// Drops every entry (the section's data was cleared).
    pub(crate) fn clear(&self) {
        let mut inner = self.lock();
        inner.entries.clear();
        inner.bytes = 0;
    }

    /// Entries held now.
    pub(crate) fn len(&self) -> usize {
        self.lock().entries.len()
    }

    /// Bytes of keys held now.
    pub(crate) fn bytes(&self) -> usize {
        self.lock().bytes
    }
}

impl<K> CacheInner<K> {
    fn drop_older(&mut self, revision: u64) {
        let mut freed = 0;
        self.entries.retain(|entry| {
            let keep = entry.revision >= revision;
            if !keep {
                freed += entry.bytes;
            }
            keep
        });
        self.bytes -= freed;
    }
}

/// The prefix of every cursor this engine writes; a later format changes it.
const CURSOR_VERSION: &str = "v1.";

/// `v1.` + base64url(JSON of `key`): opaque to the console, checked on
/// return.
pub(crate) fn encode_cursor<K: Serialize>(key: &K) -> String {
    // The console's own key types always serialize.
    let json = serde_json::to_vec(key).unwrap_or_default();
    format!("{CURSOR_VERSION}{}", URL_SAFE_NO_PAD.encode(json))
}

/// The key a cursor holds; `invalid-argument` "This cursor is not one this
/// engine wrote." for anything else.
pub(crate) fn decode_cursor<K: DeserializeOwned>(cursor: &str) -> Result<K, ApiError> {
    let refused = || {
        ApiError::invalid("This cursor is not one this engine wrote.")
            .with_fix("Load the list again from its first page.")
    };
    let encoded = cursor.strip_prefix(CURSOR_VERSION).ok_or_else(refused)?;
    let json = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| refused())?;
    serde_json::from_slice(&json).map_err(|_| refused())
}

/// Builds one [`Page`]: items are added in order until `limit` items or
/// [`PAGE_BYTES`] of JSON, and the cursors are the first and last item's
/// keys.
#[allow(
    dead_code,
    reason = "the section streams build their pages with it; the tests here cover it"
)]
pub(crate) struct PageBuilder<T, K> {
    items: Vec<T>,
    bytes: usize,
    limit: usize,
    max_bytes: usize,
    first: Option<K>,
    last: Option<K>,
    full: bool,
}

#[allow(
    dead_code,
    reason = "the section streams build their pages with it; the tests here cover it"
)]
impl<T: Serialize + TS, K: Serialize> PageBuilder<T, K> {
    /// A page of at most `limit` items.
    pub(crate) fn new(limit: usize) -> Self {
        Self::with_bytes(limit, PAGE_BYTES)
    }

    /// A page of at most `limit` items and `max_bytes` of item JSON.
    pub(crate) fn with_bytes(limit: usize, max_bytes: usize) -> Self {
        Self {
            items: Vec::new(),
            bytes: 0,
            limit: limit.max(1),
            max_bytes,
            first: None,
            last: None,
            full: false,
        }
    }

    /// Adds `item`, whose cursor key is `key`. `false` (and nothing added)
    /// when the page is full by count or by bytes; the first item is always
    /// added, however large, so a list always moves forward.
    pub(crate) fn push(&mut self, item: T, key: K) -> bool {
        if self.full || self.items.len() >= self.limit {
            self.full = true;
            return false;
        }
        let size = json_size(&item);
        if !self.items.is_empty() && self.bytes + size > self.max_bytes {
            self.full = true;
            return false;
        }
        self.bytes += size;
        self.items.push(item);
        if self.first.is_none() {
            self.first = Some(key);
        } else {
            self.last = Some(key);
        }
        true
    }

    /// Whether another item would be refused.
    pub(crate) const fn is_full(&self) -> bool {
        self.full
    }

    /// The page. `more_after`: items follow the last one added (a refused
    /// push, or more the caller did not offer); `more_before`: items precede
    /// the first one.
    pub(crate) fn finish(
        self,
        more_after: bool,
        more_before: bool,
        total: Option<Total>,
        scanned: Option<u64>,
    ) -> Page<T> {
        let last = self.last.as_ref().or(self.first.as_ref());
        Page {
            next_cursor: (more_after || self.full)
                .then(|| last.map(encode_cursor))
                .flatten(),
            prev_cursor: more_before
                .then(|| self.first.as_ref().map(encode_cursor))
                .flatten(),
            items: self.items,
            total,
            scanned,
        }
    }
}

/// The bytes `value` serializes to, counted without keeping them.
fn json_size(value: &impl Serialize) -> usize {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0 += buffer.len();
            Ok(buffer.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    let _ = serde_json::to_writer(&mut counter, value);
    let _ = counter.flush();
    counter.0
}

/// Where one page lies in a sorted key list.
#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(
    dead_code,
    reason = "the section streams slice their cached keys with it"
)]
pub(crate) struct Slice {
    /// The page's keys, as indexes into the list.
    pub(crate) range: std::ops::Range<usize>,
    /// Keys follow the page.
    pub(crate) more_after: bool,
    /// Keys precede the page.
    pub(crate) more_before: bool,
}

/// The page of `keys` (sorted, unique) that `after` or `before` asks for:
/// at most `limit` keys after `after`, at most `limit` keys before
/// `before`, or the first `limit`.
#[allow(
    dead_code,
    reason = "the section streams slice their cached keys with it"
)]
pub(crate) fn slice_sorted<K: Ord>(
    keys: &[K],
    after: Option<&K>,
    before: Option<&K>,
    limit: usize,
) -> Slice {
    let limit = limit.max(1);
    let range = match (after, before) {
        (Some(after), _) => {
            let start = keys.partition_point(|key| key <= after);
            start..(start + limit).min(keys.len())
        }
        (None, Some(before)) => {
            let end = keys.partition_point(|key| key < before);
            end.saturating_sub(limit)..end
        }
        (None, None) => 0..limit.min(keys.len()),
    };
    Slice {
        more_after: range.end < keys.len(),
        more_before: range.start > 0,
        range,
    }
}

/// `POST /<section>/<things>:batchGet`: the rows the live channel named,
/// read again so a table patches them in place.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    dead_code,
    reason = "the section streams answer their batch reads with it"
)]
pub struct BatchGetRequest {
    /// At most 500 keys the live channel named.
    pub keys: Vec<String>,
    /// The page's filter, so a row that no longer matches comes back gone.
    #[serde(default)]
    #[ts(optional)]
    pub q: Option<String>,
    /// The page's order.
    #[serde(default)]
    #[ts(optional)]
    pub sort: Option<String>,
    /// Each loaded page's `prevCursor` (its first row), in order; `null` for
    /// the page that starts the list. Says which loaded page a created row
    /// falls in.
    #[serde(default)]
    pub page_starts: Vec<Option<String>>,
    /// The last loaded page's `nextCursor`; absent when the loaded pages
    /// reach the end of the list. A row after it is outside the window.
    #[serde(default)]
    #[ts(optional)]
    pub window_end: Option<String>,
}

impl BatchGetRequest {
    /// Keys one batch may name.
    pub const MAX_KEYS: usize = 500;
    /// Pages one window holds (`maxPages`).
    pub const MAX_PAGES: usize = 20;

    /// Refuses a batch over the limits.
    pub fn check(&self) -> Result<(), ApiError> {
        if self.keys.len() > Self::MAX_KEYS {
            return Err(ApiError::invalid(format!(
                "A batch read names at most {} keys; this one names {}.",
                Self::MAX_KEYS,
                self.keys.len()
            )));
        }
        if self.page_starts.len() > Self::MAX_PAGES {
            return Err(ApiError::invalid(format!(
                "A table holds at most {} pages; this batch read names {}.",
                Self::MAX_PAGES,
                self.page_starts.len()
            )));
        }
        Ok(())
    }

    /// The page starts and the window's end, decoded.
    #[allow(
        dead_code,
        reason = "the section streams answer their batch reads with it"
    )]
    pub(crate) fn window<K: DeserializeOwned>(
        &self,
    ) -> Result<(Vec<Option<K>>, Option<K>), ApiError> {
        let starts = self
            .page_starts
            .iter()
            .map(|start| start.as_deref().map(decode_cursor).transpose())
            .collect::<Result<Vec<_>, _>>()?;
        let end = self.window_end.as_deref().map(decode_cursor).transpose()?;
        Ok((starts, end))
    }
}

/// The answer to a batch read, one item per key, in the request's order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
pub struct BatchGetResponse<T: TS> {
    pub items: Vec<BatchGetItem<T>>,
}

/// One key of a batch read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
pub struct BatchGetItem<T: TS> {
    pub key: String,
    /// Absent: deleted, or no longer matches the filter.
    pub row: Option<T>,
    /// The index in `pageStarts` of the loaded page the row sorts into;
    /// absent when it falls outside the loaded window.
    pub page: Option<u32>,
}

/// The loaded page a row whose sort key is `item` falls in. Page `i` holds
/// the keys from `starts[i]` (its first row; `None` for the start of the
/// list) up to the next page's start; the last page ends at `end` (the
/// window's end) or runs to the end of the list. `None` before the first
/// page or after the window.
#[allow(
    dead_code,
    reason = "the section streams answer their batch reads with it"
)]
pub(crate) fn page_of<K: Ord>(item: &K, starts: &[Option<K>], end: Option<&K>) -> Option<usize> {
    let page = starts
        .iter()
        .rposition(|start| start.as_ref().is_none_or(|start| start <= item))?;
    if page + 1 == starts.len() && end.is_some_and(|end| item > end) {
        return None;
    }
    Some(page)
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use axum::http::StatusCode;
    use axum::response::IntoResponse as _;

    use super::*;

    fn meta() -> ListMeta {
        ListMeta {
            sortable: vec![
                "createdAt".to_owned(),
                "lastSignIn".to_owned(),
                "uid".to_owned(),
            ],
            default_sort: "uid:asc".to_owned(),
            fields: Vec::new(),
        }
    }

    fn query(pairs: &[(&str, &str)]) -> PageQuery {
        let text = pairs
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("&");
        serde_json::from_value(serde_json::Value::Object(
            pairs
                .iter()
                .map(|(key, value)| {
                    let value = if *key == "limit" {
                        serde_json::json!(value.parse::<u32>().expect("number"))
                    } else {
                        serde_json::json!(value)
                    };
                    ((*key).to_owned(), value)
                })
                .collect(),
        ))
        .unwrap_or_else(|error| panic!("{text}: {error}"))
    }

    fn message(error: &ApiError) -> String {
        error.detail().message.clone()
    }

    #[test]
    fn a_cursor_round_trips_and_a_tampered_or_foreign_one_is_refused() {
        let key = ("2026-10-01T00:00:00Z".to_owned(), "u_1".to_owned());
        let cursor = encode_cursor(&key);
        assert!(cursor.starts_with("v1."), "{cursor}");
        let back: (String, String) = decode_cursor(&cursor).expect("decoded");
        assert_eq!(back, key);
        // The same token pages both ways.
        let both = query(&[("before", &cursor)]);
        assert_eq!(
            both.before::<(String, String)>().expect("before"),
            Some(key.clone())
        );
        let mut tampered = cursor.clone();
        tampered.insert(5, '!');
        for bad in [
            tampered.as_str(),
            "v2.e30",
            "garbage",
            "v1.",
            // Valid base64 and JSON, but not this list's key.
            &encode_cursor(&serde_json::json!({ "x": 1 })),
        ] {
            let error = decode_cursor::<(String, String)>(bad).expect_err(bad);
            assert_eq!(error.status(), StatusCode::BAD_REQUEST, "{bad}");
            assert_eq!(message(&error), "This cursor is not one this engine wrote.");
        }
        let error = query(&[("cursor", &cursor), ("before", &cursor)])
            .before::<(String, String)>()
            .expect_err("both");
        assert!(message(&error).contains("not both"), "{}", message(&error));
    }

    #[test]
    fn the_limit_defaults_and_clamps() {
        assert_eq!(PageQuery::default().limit(100, 500), 100);
        assert_eq!(query(&[("limit", "0")]).limit(100, 500), 1);
        assert_eq!(query(&[("limit", "50")]).limit(100, 500), 50);
        assert_eq!(query(&[("limit", "100000")]).limit(100, 500), 500);
    }

    #[test]
    fn only_a_column_an_index_backs_sorts() {
        assert_eq!(PageQuery::default().sort(&meta()).expect("none"), None);
        assert_eq!(
            query(&[("sort", "createdAt:desc")])
                .sort(&meta())
                .expect("sorted"),
            Some(("createdAt".to_owned(), Direction::Desc))
        );
        assert_eq!(
            query(&[("sort", "uid")]).sort(&meta()).expect("sorted"),
            Some(("uid".to_owned(), Direction::Asc))
        );
        let error = query(&[("sort", "email:asc")])
            .sort(&meta())
            .expect_err("unsortable");
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            message(&error),
            "This list cannot be sorted by email; sortable: createdAt, lastSignIn, uid."
        );
        let error = query(&[("sort", "uid:sideways")])
            .sort(&meta())
            .expect_err("direction");
        assert!(
            message(&error).contains("<column>:asc"),
            "{}",
            message(&error)
        );
        let response = error.into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn the_scan_budget_stops_at_its_item_count() {
        let mut scanner = ScanBudget {
            items: 1_000,
            time: Duration::from_secs(60),
        }
        .start();
        let mut examined = 0;
        while scanner.examine() {
            examined += 1;
        }
        assert_eq!(examined, 1_000);
        assert!(scanner.exhausted());
        assert_eq!(scanner.examined(), 1_000);
        assert!(!scanner.examine(), "stays spent");
    }

    #[test]
    fn the_scan_budget_stops_at_its_time() {
        let mut scanner = ScanBudget {
            items: usize::MAX,
            time: Duration::from_millis(5),
        }
        .start();
        let started = Instant::now();
        while scanner.examine() {
            std::hint::black_box(());
            assert!(
                started.elapsed() <= Duration::from_secs(5),
                "the time budget never stopped the scan"
            );
        }
        assert!(scanner.exhausted());
        assert!(scanner.examined() > 0);
    }

    /// A list of `count` users keyed by uid, filtered by a substring no index
    /// answers, paged the way a section does it: a scan within the budget,
    /// the sorted matches cached, later pages sliced.
    struct Users {
        uids: Vec<String>,
        revision: u64,
        cache: ResultCache<String>,
        scans: Cell<usize>,
    }

    impl Users {
        fn new(count: usize) -> Self {
            Self {
                uids: (0..count).map(|index| format!("u_{index:06}")).collect(),
                revision: 1,
                cache: ResultCache::new(ResultCache::<String>::DEFAULT_BYTES),
                scans: Cell::new(0),
            }
        }

        fn page(&self, query: &PageQuery, budget: ScanBudget) -> Page<String> {
            let text = query.q.clone().unwrap_or_default();
            let keys = if let Some(keys) = self.cache.get(&text, "uid:asc", self.revision) {
                keys
            } else {
                self.scans.set(self.scans.get() + 1);
                let mut scanner = budget.start();
                let mut matches = Vec::new();
                for uid in &self.uids {
                    if !scanner.examine() {
                        break;
                    }
                    if uid.contains(&text) {
                        matches.push(uid.clone());
                    }
                }
                if scanner.exhausted() {
                    // A partial scan is answered but not cached: the next
                    // page continues it instead.
                    let limit = query.limit(DEFAULT_LIMIT, MAX_LIMIT);
                    let mut builder = PageBuilder::new(limit);
                    let after = query.after::<String>().expect("cursor");
                    for uid in matches
                        .iter()
                        .filter(|uid| after.as_ref().is_none_or(|after| *uid > after))
                    {
                        if !builder.push(uid.clone(), uid.clone()) {
                            break;
                        }
                    }
                    let count = u64::try_from(matches.len()).expect("small");
                    return builder.finish(
                        true,
                        after.is_some(),
                        Some(Total {
                            count,
                            exact: false,
                        }),
                        Some(scanner.examined()),
                    );
                }
                let bytes = matches.iter().map(String::len).sum();
                self.cache
                    .insert(&text, "uid:asc", self.revision, matches, bytes)
            };
            let after = query.after::<String>().expect("cursor");
            let before = query.before::<String>().expect("before");
            let slice = slice_sorted(
                &keys,
                after.as_ref(),
                before.as_ref(),
                query.limit(DEFAULT_LIMIT, MAX_LIMIT),
            );
            let mut builder = PageBuilder::new(slice.range.len());
            for uid in &keys[slice.range.clone()] {
                builder.push(uid.clone(), uid.clone());
            }
            let count = u64::try_from(keys.len()).expect("small");
            builder.finish(
                slice.more_after,
                slice.more_before,
                Some(Total { count, exact: true }),
                None,
            )
        }
    }

    #[test]
    fn the_cache_serves_later_pages_without_scanning_until_the_revision_moves() {
        let mut users = Users::new(10_000);
        let first = users.page(&query(&[("q", "7"), ("limit", "100")]), ScanBudget::DEFAULT);
        assert_eq!(users.scans.get(), 1);
        assert_eq!(first.items.len(), 100);
        assert_eq!(first.prev_cursor, None);
        let total = first.total.expect("total");
        assert!(total.exact);
        assert_eq!(first.scanned, None);
        let next = first.next_cursor.clone().expect("more");
        let second = users.page(
            &query(&[("q", "7"), ("limit", "100"), ("cursor", &next)]),
            ScanBudget::DEFAULT,
        );
        assert_eq!(users.scans.get(), 1, "the second page sliced the cache");
        assert!(second.items[0] > first.items[99]);
        // Back up from the second page to the first.
        let back = users.page(
            &query(&[
                ("q", "7"),
                ("limit", "100"),
                ("before", second.prev_cursor.as_deref().expect("prev")),
            ]),
            ScanBudget::DEFAULT,
        );
        assert_eq!(back.items, first.items);
        assert_eq!(users.scans.get(), 1);
        assert_eq!(users.cache.len(), 1);
        users.revision = 2;
        let _ = users.page(&query(&[("q", "7"), ("limit", "100")]), ScanBudget::DEFAULT);
        assert_eq!(users.scans.get(), 2, "a new revision scans again");
        assert_eq!(users.cache.len(), 1, "the old revision's entry is gone");
    }

    #[test]
    fn a_scan_the_budget_stops_says_how_far_it_got_and_continues() {
        let users = Users::new(10_000);
        let budget = ScanBudget {
            items: 2_000,
            time: Duration::from_secs(60),
        };
        let page = users.page(&query(&[("q", "u_"), ("limit", "50")]), budget);
        assert_eq!(page.items.len(), 50);
        assert_eq!(page.scanned, Some(2_000));
        assert_eq!(
            page.total,
            Some(Total {
                count: 2_000,
                exact: false
            })
        );
        let next = page.next_cursor.expect("the scan continues");
        let following = users.page(
            &query(&[("q", "u_"), ("limit", "50"), ("cursor", &next)]),
            budget,
        );
        assert_eq!(following.items[0], "u_000050");
        assert_eq!(users.cache.len(), 0, "a partial scan is not cached");
    }

    #[test]
    fn the_cache_keeps_eight_entries_within_its_bytes() {
        let cache = ResultCache::<u32>::new(100);
        for index in 0..10_u32 {
            let _ = cache.insert(&format!("f{index}"), "", 1, vec![index], 10);
        }
        assert_eq!(cache.len(), 8);
        assert_eq!(cache.bytes(), 80);
        assert!(cache.get("f0", "", 1).is_none(), "the oldest went first");
        assert!(cache.get("f9", "", 1).is_some());
        // Using an entry keeps it longest; the byte limit evicts the others.
        assert!(cache.get("f2", "", 1).is_some());
        let _ = cache.insert("big", "", 1, vec![0], 90);
        assert!(cache.get("f9", "", 1).is_none(), "evicted for the bytes");
        assert!(
            cache.get("f2", "", 1).is_some(),
            "the most recently used stays"
        );
        assert!(cache.get("big", "", 1).is_some());
        assert_eq!(cache.len(), 2);
        assert!(cache.bytes() <= 100);
        // Larger than the whole limit: answered, not kept.
        let keys = cache.insert("huge", "", 1, vec![1, 2, 3], 1_000);
        assert_eq!(&*keys, &[1, 2, 3]);
        assert!(cache.get("huge", "", 1).is_none());
        cache.clear();
        assert_eq!(cache.len(), 0);
        assert_eq!(cache.bytes(), 0);
    }

    #[test]
    fn a_page_stops_at_its_byte_budget_and_always_takes_one_item() {
        let mut builder = PageBuilder::with_bytes(100, 64);
        assert!(builder.push("a".repeat(40), 1_u32));
        assert!(!builder.push("b".repeat(40), 2), "past the byte budget");
        assert!(builder.is_full());
        let page = builder.finish(false, false, None, None);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.next_cursor, Some(encode_cursor(&1_u32)));
        let mut builder = PageBuilder::with_bytes(100, 8);
        assert!(
            builder.push("x".repeat(100), 7_u32),
            "the first item always fits"
        );
        let page = builder.finish(false, false, None, None);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.next_cursor, None, "nothing follows");
        let empty = PageBuilder::<String, u32>::new(10).finish(true, true, None, None);
        assert_eq!(empty.next_cursor, None);
        assert_eq!(empty.prev_cursor, None);
    }

    #[test]
    fn slices_page_both_ways() {
        let keys: Vec<u32> = (1..=10).collect();
        let first = slice_sorted(&keys, None, None, 4);
        assert_eq!(first.range, 0..4);
        assert!(first.more_after);
        assert!(!first.more_before);
        let next = slice_sorted(&keys, Some(&4), None, 4);
        assert_eq!(next.range, 4..8);
        let last = slice_sorted(&keys, Some(&8), None, 4);
        assert_eq!(last.range, 8..10);
        assert!(!last.more_after);
        let up = slice_sorted(&keys, None, Some(&9), 4);
        assert_eq!(up.range, 4..8);
        assert!(up.more_before);
        let top = slice_sorted(&keys, None, Some(&3), 4);
        assert_eq!(top.range, 0..2);
        assert!(!top.more_before);
        // A cursor whose key is gone still lands between its neighbours.
        let gone = slice_sorted(&[1_u32, 3, 5, 7], Some(&4), None, 2);
        assert_eq!(gone.range, 2..4);
    }

    #[test]
    fn page_of_places_rows_at_boundaries_before_the_window_and_after_it() {
        // Pages starting at 10, 20 and 30; the window ends at 39.
        let starts = [Some(10_u32), Some(20), Some(30)];
        assert_eq!(page_of(&5, &starts, Some(&39)), None, "before the window");
        assert_eq!(page_of(&10, &starts, Some(&39)), Some(0));
        assert_eq!(page_of(&19, &starts, Some(&39)), Some(0));
        assert_eq!(page_of(&20, &starts, Some(&39)), Some(1));
        assert_eq!(page_of(&39, &starts, Some(&39)), Some(2));
        assert_eq!(page_of(&40, &starts, Some(&39)), None, "after the window");
        assert_eq!(
            page_of(&400, &starts, None),
            Some(2),
            "the window reaches the end"
        );
        // The first page starts the list.
        let starts = [None, Some(20_u32)];
        assert_eq!(page_of(&1, &starts, None), Some(0));
        assert_eq!(page_of(&25, &starts, None), Some(1));
        assert_eq!(page_of::<u32>(&1, &[], None), None);
    }

    #[test]
    fn a_batch_read_is_bounded_and_decodes_its_window() {
        let request: BatchGetRequest = serde_json::from_value(serde_json::json!({
            "keys": ["u_1"],
            "pageStarts": [null, encode_cursor(&"u_5")],
            "windowEnd": encode_cursor(&"u_9"),
        }))
        .expect("request");
        request.check().expect("within limits");
        let (starts, end) = request.window::<String>().expect("window");
        assert_eq!(starts, vec![None, Some("u_5".to_owned())]);
        assert_eq!(end, Some("u_9".to_owned()));
        let too_many = BatchGetRequest {
            keys: vec![String::new(); 501],
            ..request
        };
        let error = too_many.check().expect_err("over");
        assert_eq!(
            error.detail().message,
            "A batch read names at most 500 keys; this one names 501."
        );
        let unknown = serde_json::from_value::<BatchGetRequest>(serde_json::json!({
            "keys": [], "pageStarts": [], "rows": []
        }));
        assert!(unknown.is_err(), "unknown fields are refused");
    }

    #[test]
    fn a_page_serializes_with_both_cursors_and_its_scan() {
        let page = Page {
            items: vec![1_u32],
            next_cursor: Some("v1.MQ".to_owned()),
            prev_cursor: None,
            total: Some(Total {
                count: 5,
                exact: false,
            }),
            scanned: Some(200_000),
        };
        assert_eq!(
            serde_json::to_value(&page).expect("json"),
            serde_json::json!({
                "items": [1],
                "nextCursor": "v1.MQ",
                "prevCursor": null,
                "total": { "count": 5, "exact": false },
                "scanned": 200_000,
            })
        );
        let item = BatchGetItem {
            key: "u_1".to_owned(),
            row: None::<u32>,
            page: Some(2),
        };
        assert_eq!(
            serde_json::to_value(&item).expect("json"),
            serde_json::json!({ "key": "u_1", "row": null, "page": 2 })
        );
    }
}
