//! Sorted and filtered views of a folder, built once and paged many times.
//!
//! A listing by name is read straight from the object map. Any other order,
//! and any filter, needs every entry of the level (or of everything below a
//! folder) first, which at a million objects is too much to redo for every
//! page or every live change. So such a listing builds a view:
//!
//! - A level's **base**: one string holding every name below the folder back
//!   to back, offsets into it, and what a sort or a filter reads of each
//!   entry (size, last change, an interned content type, which fields it
//!   has), in name order. It is built in chunks of 10,000 entries, the lock
//!   released between them so writers interleave, and shared, behind an
//!   `Arc`, by every view of the same folder and state.
//! - A **view**: the base's entries a filter keeps, in the order asked for,
//!   as 4-byte indexes into the base. Two sorts of one level share one base.
//!
//! Views are cached (an LRU of 128 MB estimated, each base counted once) and
//! keyed by the folder's own revision in the folder index: the level's for a
//! listing by name or type (or a filter), the subtree's for one by size or
//! last change (a folder's bytes and last change move with any write below
//! it), so a view is rebuilt only when what it shows changed. Concurrent
//! requests for one view wait for its one build. A view whose folder moved
//! is served, marked stale with the number of changes since, for up to 2 s
//! after the move was first seen; after that the next request rebuilds it.
//! So a folder under constant writes is rebuilt at most once every 2 s per
//! view, never once per page. A request that asks for a fresh view (the
//! console's Refresh) has it rebuilt at once.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::filter::{ObjectFacts, StorageFilter};
use crate::folder_index::{FolderStats, rfc3339_millis};
use crate::listing::{
    FileEntry, FolderEntry, LAST_SCALAR, LevelEntry, LevelWalk, ListCursor, ListEntry, ListKind,
    ListOrder, SortColumn, is_marker, scope_end,
};
use crate::{StorageData, StorageState, lock, object_key};

/// Estimated bytes the cache keeps.
const CACHE_BYTES: usize = 128 * 1024 * 1024;
/// How long a view whose folder moved is still served, marked stale.
pub(crate) const STALE_FOR: Duration = Duration::from_secs(2);
/// Entries one hold of the lock copies while a base is built.
const CHUNK: usize = 10_000;
/// The pause between chunks, so writers get the lock.
const PAUSE: Duration = Duration::from_micros(200);
/// A content type id meaning "none".
const NO_TYPE: u32 = u32::MAX;

/// What a sort or filter reads of one entry.
#[derive(Clone, Copy, Debug)]
struct Facts {
    /// File size, or a folder's bytes.
    size: u64,
    /// Last update (file) or last change below (folder), Unix ms.
    updated: i64,
    /// An index into the base's sorted content types, or [`NO_TYPE`].
    content_type: u32,
    folder: bool,
    /// [`TOKEN`], [`METADATA`], [`ENCODING`], [`CACHE`].
    flags: u8,
}

const TOKEN: u8 = 1;
const METADATA: u8 = 2;
const ENCODING: u8 = 4;
const CACHE: u8 = 8;

/// Every entry of a level, or of everything below a folder, in name order.
pub(crate) struct Base {
    /// Every name below the folder, back to back.
    arena: String,
    /// Where each name starts in `arena`.
    offsets: Vec<u32>,
    facts: Vec<Facts>,
    /// Content types, sorted, so an id orders as its string.
    types: Vec<String>,
    /// Revision of the folder's subtree when the base was built.
    stamp: u64,
}

impl Base {
    fn len(&self) -> usize {
        self.facts.len()
    }

    fn name(&self, index: usize) -> &str {
        let start = self.offsets[index] as usize;
        let end = self
            .offsets
            .get(index + 1)
            .map_or(self.arena.len(), |next| *next as usize);
        &self.arena[start..end]
    }

    fn estimated_bytes(&self) -> usize {
        self.arena.len()
            + self.offsets.len() * 4
            + self.facts.len() * std::mem::size_of::<Facts>()
            + self
                .types
                .iter()
                .map(|value| value.len() + 24)
                .sum::<usize>()
            + 64
    }

    fn content_type(&self, facts: &Facts) -> Option<&str> {
        (facts.content_type != NO_TYPE).then(|| self.types[facts.content_type as usize].as_str())
    }

    /// The sort key of entry `index` for `column`.
    fn key(&self, index: usize, column: SortColumn) -> u64 {
        let facts = &self.facts[index];
        match column {
            SortColumn::Name => 0,
            SortColumn::Size => facts.size,
            // Shifted so earlier times stay smaller as unsigned keys.
            SortColumn::Updated => facts.updated.cast_unsigned() ^ (1 << 63),
            SortColumn::Type => {
                if facts.folder {
                    0
                } else {
                    u64::from(facts.content_type)
                }
            }
        }
    }

    /// Where an entry named `name` sits, when the base has it.
    fn position(&self, name: &str) -> Option<usize> {
        let mut low = 0;
        let mut high = self.len();
        while low < high {
            let middle = low + (high - low) / 2;
            match self.name(middle).cmp(name) {
                std::cmp::Ordering::Less => low = middle + 1,
                std::cmp::Ordering::Greater => high = middle,
                std::cmp::Ordering::Equal => return Some(middle),
            }
        }
        None
    }
}

/// A base's entries a filter keeps, in a view's order.
pub(crate) struct View {
    pub(crate) id: u64,
    base: Arc<Base>,
    entries: Vec<u32>,
    order: ListOrder,
    /// The folder's revision the view stands for (its level's or its
    /// subtree's, by the order).
    stamp: u64,
    /// The folder's change counter when the view was built.
    changes: u64,
    pub(crate) folders: u64,
    pub(crate) files: u64,
    pub(crate) bytes: u64,
}

impl View {
    fn estimated_bytes(&self) -> usize {
        self.entries.len() * 4 + 128
    }

    /// The entries of this view as `(folder, key, name)`, compared in the
    /// view's order.
    fn compare(&self, left: (bool, u64, &str), right: (bool, u64, &str)) -> std::cmp::Ordering {
        // Folders first whatever the direction.
        right.0.cmp(&left.0).then_with(|| {
            let ordering = left.1.cmp(&right.1).then_with(|| left.2.cmp(right.2));
            if self.order.descending {
                ordering.reverse()
            } else {
                ordering
            }
        })
    }

    fn tuple(&self, position: usize) -> (bool, u64, &str) {
        let index = self.entries[position] as usize;
        (
            self.base.facts[index].folder,
            self.base.key(index, self.order.column),
            self.base.name(index),
        )
    }

    /// The offset of the first entry ordered after `cursor`'s entry.
    fn after(&self, cursor: &ListCursor) -> usize {
        match cursor {
            ListCursor::View { v, i, d, k, n } => {
                if *v == self.id {
                    return usize::try_from(*i)
                        .unwrap_or(usize::MAX)
                        .min(self.entries.len());
                }
                let target = (*d, *k, n.as_str());
                self.partition(|entry| self.compare(entry, target).is_le())
            }
            _ => 0,
        }
    }

    /// The offset of the first entry not ordered before `cursor`'s entry.
    fn before(&self, cursor: &ListCursor) -> usize {
        match cursor {
            ListCursor::View { v, i, d, k, n } => {
                if *v == self.id {
                    return usize::try_from(*i)
                        .unwrap_or(usize::MAX)
                        .saturating_sub(1)
                        .min(self.entries.len());
                }
                let target = (*d, *k, n.as_str());
                self.partition(|entry| self.compare(entry, target).is_lt())
            }
            _ => self.entries.len(),
        }
    }

    fn partition(&self, mut before: impl FnMut((bool, u64, &str)) -> bool) -> usize {
        let mut low = 0;
        let mut high = self.entries.len();
        while low < high {
            let middle = low + (high - low) / 2;
            if before(self.tuple(middle)) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        low
    }

    /// The cursor of the entry at `position`: it continues after it.
    fn cursor(&self, position: usize) -> ListCursor {
        let (folder, key, name) = self.tuple(position);
        ListCursor::View {
            v: self.id,
            i: position as u64 + 1,
            d: folder,
            k: key,
            n: name.to_owned(),
        }
    }

    /// One page of the view: positions and whether entries lie beyond it.
    pub(crate) fn page(
        &self,
        after: Option<&ListCursor>,
        before: Option<&ListCursor>,
        limit: usize,
    ) -> (std::ops::Range<usize>, bool, bool) {
        let limit = limit.max(1);
        let range = match (after, before) {
            (_, Some(before)) => {
                let end = self.before(before);
                end.saturating_sub(limit)..end
            }
            (Some(after), None) => {
                let start = self.after(after);
                start..(start + limit).min(self.entries.len())
            }
            (None, None) => 0..limit.min(self.entries.len()),
        };
        let more_after = range.end < self.entries.len();
        let more_before = range.start > 0;
        (range, more_after, more_before)
    }

    /// The full name (or prefix) and folder flag of the entry at `position`.
    pub(crate) fn entry(&self, prefix: &str, position: usize) -> (bool, String, ListCursor) {
        let index = self.entries[position] as usize;
        (
            self.base.facts[index].folder,
            format!("{prefix}{}", self.base.name(index)),
            self.cursor(position),
        )
    }
}

/// What a view is of, without the revision it stands for.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ViewKey {
    pub(crate) bucket: String,
    pub(crate) prefix: String,
    pub(crate) flat: bool,
    pub(crate) kind: ListKind,
    pub(crate) order: ListOrder,
    /// The filter as the console normalized it; empty for none.
    pub(crate) filter: String,
}

impl ViewKey {
    /// Whether this view is stamped by its folder's subtree (a flat view,
    /// or a level by size or last change, whose folder rows move with any
    /// write below) rather than by the level alone.
    fn subtree(&self) -> bool {
        self.flat || matches!(self.order.column, SortColumn::Size | SortColumn::Updated)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct BaseKey {
    bucket: String,
    prefix: String,
    flat: bool,
}

struct Slot {
    view: Arc<View>,
    /// When a request first found the folder moved past the view.
    stale_since: Option<Instant>,
    used: u64,
}

type Building = Arc<tokio::sync::OnceCell<Result<Arc<View>, String>>>;

#[derive(Default)]
struct CacheState {
    views: HashMap<ViewKey, Slot>,
    bases: HashMap<BaseKey, Arc<Base>>,
    building: HashMap<(ViewKey, u64), Building>,
    tick: u64,
}

impl CacheState {
    fn bytes(&self) -> usize {
        self.views
            .values()
            .map(|slot| slot.view.estimated_bytes())
            .sum::<usize>()
            + self
                .bases
                .values()
                .map(|base| base.estimated_bytes())
                .sum::<usize>()
    }

    /// Drops the least recently used views, and bases no view holds, until
    /// the cache fits.
    fn evict(&mut self) {
        loop {
            self.bases.retain(|_, base| Arc::strong_count(base) > 1);
            if self.bytes() <= CACHE_BYTES || self.views.is_empty() {
                return;
            }
            let Some(oldest) = self
                .views
                .iter()
                .min_by_key(|(_, slot)| slot.used)
                .map(|(key, _)| key.clone())
            else {
                return;
            };
            self.views.remove(&oldest);
        }
    }
}

/// The cache of views, single-flight per view.
#[derive(Default)]
pub(crate) struct ViewCache {
    state: Mutex<CacheState>,
    next_id: AtomicU64,
    /// Bases built, for tests.
    pub(crate) bases_built: AtomicU64,
    /// Views built, for tests.
    pub(crate) views_built: AtomicU64,
}

impl std::fmt::Debug for ViewCache {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ViewCache")
            .field("views", &lock(&self.state).views.len())
            .finish_non_exhaustive()
    }
}

/// A view as a request gets it.
pub(crate) struct Served {
    pub(crate) view: Arc<View>,
    pub(crate) stale: bool,
    pub(crate) changes_since: u64,
}

impl ViewCache {
    /// Estimated bytes held now.
    #[cfg(test)]
    pub(crate) fn bytes(&self) -> usize {
        lock(&self.state).bytes()
    }

    /// Drops every view (the data was reset).
    pub(crate) fn clear(&self) {
        let mut state = lock(&self.state);
        state.views.clear();
        state.bases.clear();
    }
}

/// The folder's revision and change counter a view of `key` stands for, from
/// the built folder index.
fn stamp_of(stats: Option<&FolderStats>, subtree: bool) -> (u64, u64) {
    stats.map_or((0, 0), |stats| {
        if subtree {
            (stats.subtree_rev, stats.subtree_changes)
        } else {
            (stats.level_rev, stats.level_changes)
        }
    })
}

/// The view for `key` with `filter`, fresh or within its stale window
/// (never stale when `fresh` asks for the folder as it is now), built
/// (once, however many requests ask) when needed. The folder index must be
/// built.
pub(crate) async fn view(
    state: &StorageState,
    key: &ViewKey,
    filter: Option<&StorageFilter>,
    fresh: bool,
) -> Result<Served, String> {
    let cache = &state.views;
    let (stamp, changes, subtree_stamp) = {
        let data = lock(&state.inner);
        let figures = data
            .folders
            .as_ref()
            .and_then(|index| index.stats(&key.bucket, &key.prefix));
        let (stamp, changes) = stamp_of(figures.as_ref(), key.subtree());
        (stamp, changes, stamp_of(figures.as_ref(), true).0)
    };
    let building = {
        let mut cached = lock(&cache.state);
        cached.tick += 1;
        let tick = cached.tick;
        if let Some(slot) = cached.views.get_mut(key) {
            if slot.view.stamp == stamp {
                slot.used = tick;
                slot.stale_since = None;
                return Ok(Served {
                    view: Arc::clone(&slot.view),
                    stale: false,
                    changes_since: 0,
                });
            }
            let since = *slot.stale_since.get_or_insert_with(Instant::now);
            if !fresh && since.elapsed() < STALE_FOR {
                slot.used = tick;
                return Ok(Served {
                    view: Arc::clone(&slot.view),
                    stale: true,
                    changes_since: changes.saturating_sub(slot.view.changes),
                });
            }
        }
        Arc::clone(
            cached
                .building
                .entry((key.clone(), stamp))
                .or_insert_with(|| Arc::new(tokio::sync::OnceCell::new())),
        )
    };
    let built = building
        .get_or_init(|| {
            let state = state.clone();
            let key = key.clone();
            let filter = filter.cloned();
            async move {
                let tasks = std::sync::Arc::clone(&state.tasks);
                let Some(built) = tasks.run_blocking(move || {
                    build(
                        &state,
                        &key,
                        filter.as_ref(),
                        (stamp, changes, subtree_stamp),
                    )
                }) else {
                    return Err("The service is stopping.".to_owned());
                };
                built
                    .await
                    .map_err(|_| "The view build did not finish.".to_owned())
                    .and_then(|built| built)
            }
        })
        .await
        .clone();
    let mut cached = lock(&cache.state);
    cached.building.remove(&(key.clone(), stamp));
    let view = built?;
    cached.tick += 1;
    let tick = cached.tick;
    let fresher = cached
        .views
        .get(key)
        .is_some_and(|slot| slot.view.stamp > view.stamp);
    if !fresher {
        cached.views.insert(
            key.clone(),
            Slot {
                view: Arc::clone(&view),
                stale_since: None,
                used: tick,
            },
        );
    }
    cached.evict();
    Ok(Served {
        view,
        stale: false,
        changes_since: 0,
    })
}

/// Builds the view of `key`: its folder's base (reused when the cache has
/// it for the same subtree revision), then the filtered, sorted indexes.
fn build(
    state: &StorageState,
    key: &ViewKey,
    filter: Option<&StorageFilter>,
    (stamp, changes, subtree_stamp): (u64, u64, u64),
) -> Result<Arc<View>, String> {
    let cache = &state.views;
    let base_key = BaseKey {
        bucket: key.bucket.clone(),
        prefix: key.prefix.clone(),
        flat: key.flat,
    };
    let cached = lock(&cache.state)
        .bases
        .get(&base_key)
        .filter(|base| base.stamp == subtree_stamp)
        .cloned();
    let base = if let Some(base) = cached {
        base
    } else {
        let base = Arc::new(build_base(state, &base_key, subtree_stamp)?);
        cache.bases_built.fetch_add(1, Ordering::Relaxed);
        lock(&cache.state).bases.insert(base_key, Arc::clone(&base));
        base
    };
    let mut entries = kept_entries(state, key, &base, filter)?;
    let column = key.order.column;
    entries.sort_unstable_by(|left, right| {
        let (left, right) = (*left as usize, *right as usize);
        let (left_facts, right_facts) = (&base.facts[left], &base.facts[right]);
        right_facts.folder.cmp(&left_facts.folder).then_with(|| {
            let ordering = base
                .key(left, column)
                .cmp(&base.key(right, column))
                // Names are in base order, so the index orders as the name.
                .then_with(|| left.cmp(&right));
            if key.order.descending {
                ordering.reverse()
            } else {
                ordering
            }
        })
    });
    let (mut folders, mut files, mut bytes) = (0, 0, 0_u64);
    for index in &entries {
        let facts = &base.facts[*index as usize];
        if facts.folder {
            folders += 1;
        } else {
            files += 1;
            bytes = bytes.saturating_add(facts.size);
        }
    }
    cache.views_built.fetch_add(1, Ordering::Relaxed);
    Ok(Arc::new(View {
        id: cache.next_id.fetch_add(1, Ordering::Relaxed) + 1,
        base,
        entries,
        order: key.order,
        stamp,
        changes,
        folders,
        files,
        bytes,
    }))
}

/// The base entries `filter` keeps (all of them without one), as indexes.
fn kept_entries(
    state: &StorageState,
    key: &ViewKey,
    base: &Base,
    filter: Option<&StorageFilter>,
) -> Result<Vec<u32>, String> {
    let keep_folders =
        key.kind != ListKind::Files && !key.flat && filter.is_none_or(StorageFilter::names_only);
    let keep_files = key.kind != ListKind::Folders;
    let matching_objects = match filter {
        Some(filter) if filter.needs_objects() && keep_files => {
            Some(object_matches(state, key, base, filter)?)
        }
        _ => None,
    };
    let mut entries = Vec::with_capacity(base.len());
    for index in 0..base.len() {
        let facts = &base.facts[index];
        let name = base.name(index);
        let kept = if facts.folder {
            keep_folders && filter.is_none_or(|filter| filter.matches_folder(name))
        } else if !keep_files {
            false
        } else if let Some(matching) = &matching_objects {
            matching[index]
        } else {
            filter.is_none_or(|filter| {
                filter.matches_facts(
                    name,
                    &ObjectFacts {
                        size: facts.size,
                        updated_ms: Some(facts.updated),
                        content_type: base.content_type(facts),
                        token: facts.flags & TOKEN != 0,
                        metadata: facts.flags & METADATA != 0,
                        encoding: facts.flags & ENCODING != 0,
                        cache: facts.flags & CACHE != 0,
                    },
                    None,
                )
            })
        };
        if kept {
            entries.push(u32::try_from(index).map_err(|_| "a level too large to view".to_owned())?);
        }
    }
    Ok(entries)
}

/// Where a chunked walk continues.
enum Resume {
    Start,
    AfterItem(String),
    AfterGroup(String),
    Done,
}

/// Walks the folder of `key` in chunks under short holds of the lock,
/// calling `visit` for every level entry (the level's own marker and, in a
/// flat walk, every marker left out). Stops early when the service stops.
fn walk_chunks(
    state: &StorageState,
    bucket: &str,
    prefix: &str,
    flat: bool,
    mut visit: impl FnMut(&StorageData, &str, LevelEntry<'_>),
) -> Result<(), String> {
    let scope = object_key(bucket, prefix);
    let end = scope_end(&scope);
    let mut resume = Resume::Start;
    loop {
        if state.tasks.stopping() {
            return Err("the service is stopping".to_owned());
        }
        {
            let data = lock(&state.inner);
            let start = match &resume {
                Resume::Start => std::ops::Bound::Included(scope.clone()),
                Resume::AfterItem(key) => std::ops::Bound::Excluded(key.clone()),
                Resume::AfterGroup(group) => {
                    let mut seek = group.clone();
                    seek.push(LAST_SCALAR);
                    std::ops::Bound::Excluded(seek)
                }
                Resume::Done => return Ok(()),
            };
            let range = data.objects.range::<str, _>((
                match &start {
                    std::ops::Bound::Included(key) => std::ops::Bound::Included(key.as_str()),
                    std::ops::Bound::Excluded(key) => std::ops::Bound::Excluded(key.as_str()),
                    std::ops::Bound::Unbounded => std::ops::Bound::Unbounded,
                },
                std::ops::Bound::Excluded(end.as_str()),
            ));
            let group = match &resume {
                Resume::AfterGroup(group) => Some(group.clone()),
                _ => None,
            };
            let walk = LevelWalk::over(
                &data.objects,
                range,
                bucket,
                prefix,
                (!flat).then_some("/"),
                group,
            );
            let mut steps = 0;
            resume = Resume::Done;
            for entry in walk {
                match entry {
                    LevelEntry::Group(group) => {
                        resume = Resume::AfterGroup(object_key(bucket, group));
                    }
                    LevelEntry::Item(object) => {
                        resume = Resume::AfterItem(object_key(bucket, &object.name));
                        if is_marker(object) && (flat || object.name == prefix) {
                            steps += 1;
                            if steps >= CHUNK {
                                break;
                            }
                            continue;
                        }
                    }
                }
                visit(&data, prefix, entry);
                steps += 1;
                if steps >= CHUNK {
                    break;
                }
            }
            if steps < CHUNK {
                return Ok(());
            }
        }
        std::thread::sleep(PAUSE);
    }
}

/// Copies the folder of `key` into a base, chunk by chunk.
fn build_base(state: &StorageState, key: &BaseKey, stamp: u64) -> Result<Base, String> {
    let mut arena = String::new();
    let mut offsets = Vec::new();
    let mut facts = Vec::new();
    let mut types: BTreeMap<String, u32> = BTreeMap::new();
    let mut type_names: Vec<String> = Vec::new();
    walk_chunks(
        state,
        &key.bucket,
        &key.prefix,
        key.flat,
        |data, prefix, entry| {
            let (relative, entry_facts) = match entry {
                LevelEntry::Group(group) => {
                    let figures = data
                        .folders
                        .as_ref()
                        .and_then(|index| index.stats(&key.bucket, group))
                        .unwrap_or_default();
                    (
                        &group[prefix.len()..],
                        Facts {
                            size: figures.bytes,
                            updated: figures.changed_at_ms.unwrap_or(0),
                            content_type: NO_TYPE,
                            folder: true,
                            flags: 0,
                        },
                    )
                }
                LevelEntry::Item(object) => {
                    let content_type = object.content_type.as_ref().map_or(NO_TYPE, |value| {
                        *types.entry(value.clone()).or_insert_with(|| {
                            type_names.push(value.clone());
                            u32::try_from(type_names.len() - 1).unwrap_or(NO_TYPE - 1)
                        })
                    });
                    let mut flags = 0;
                    if !object.download_tokens.is_empty() {
                        flags |= TOKEN;
                    }
                    if !object.custom_metadata.is_empty() {
                        flags |= METADATA;
                    }
                    if object.content_encoding.is_some() {
                        flags |= ENCODING;
                    }
                    if object.cache_control.is_some() {
                        flags |= CACHE;
                    }
                    (
                        &object.name[prefix.len()..],
                        Facts {
                            size: object.size,
                            updated: rfc3339_millis(&object.updated).unwrap_or(0),
                            content_type,
                            folder: false,
                            flags,
                        },
                    )
                }
            };
            offsets.push(u32::try_from(arena.len()).unwrap_or(u32::MAX));
            arena.push_str(relative);
            facts.push(entry_facts);
        },
    )?;
    if arena.len() > u32::MAX as usize {
        return Err("a folder whose names exceed 4 GB cannot be viewed".to_owned());
    }
    // Ids in the order the strings sort, so an id orders as its type.
    let mut remap = vec![0_u32; type_names.len()];
    let sorted: Vec<String> = types.keys().cloned().collect();
    for (sorted_id, (_, first_id)) in types.iter().enumerate() {
        remap[*first_id as usize] = u32::try_from(sorted_id).unwrap_or(NO_TYPE - 1);
    }
    for entry in &mut facts {
        if entry.content_type != NO_TYPE {
            entry.content_type = remap[entry.content_type as usize];
        }
    }
    arena.shrink_to_fit();
    offsets.shrink_to_fit();
    facts.shrink_to_fit();
    Ok(Base {
        arena,
        offsets,
        facts,
        types: sorted,
        stamp,
    })
}

/// Which base entries a filter that reads objects (metadata values,
/// creation times) keeps: one more chunked walk, each match found in the
/// base by name.
fn object_matches(
    state: &StorageState,
    key: &ViewKey,
    base: &Base,
    filter: &StorageFilter,
) -> Result<Vec<bool>, String> {
    let mut matching = vec![false; base.len()];
    walk_chunks(
        state,
        &key.bucket,
        &key.prefix,
        key.flat,
        |_, prefix, entry| {
            if let LevelEntry::Item(object) = entry {
                let relative = &object.name[prefix.len()..];
                if filter.matches_object(relative, object)
                    && let Some(position) = base.position(relative)
                {
                    matching[position] = true;
                }
            }
        },
    )?;
    Ok(matching)
}

/// The rows of one page of `view`: each entry read again under one short
/// hold, so a page shows the objects as they are now (an entry deleted since
/// the view was built is left out).
pub(crate) fn rows(
    state: &StorageState,
    view: &View,
    bucket: &str,
    prefix: &str,
    range: std::ops::Range<usize>,
) -> Vec<(ListEntry, ListCursor)> {
    let data = lock(&state.inner);
    range
        .filter_map(|position| {
            let (folder, name, cursor) = view.entry(prefix, position);
            if folder {
                let figures = data
                    .folders
                    .as_ref()
                    .and_then(|index| index.stats(bucket, &name));
                figures.map(|figures| {
                    (
                        ListEntry::Folder(FolderEntry {
                            prefix: name,
                            stats: Some(figures),
                        }),
                        cursor,
                    )
                })
            } else {
                data.objects
                    .get(&object_key(bucket, &name))
                    .map(|object| (ListEntry::File(FileEntry::of(object)), cursor))
            }
        })
        .collect()
}
