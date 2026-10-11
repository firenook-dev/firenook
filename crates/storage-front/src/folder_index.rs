//! Counts, sizes and the last change under every folder of every bucket.
//!
//! The index lives in the object map's own state, so every change updates
//! it under the same lock and in the same order as the map. It is built
//! once, by the index and never by a request, and without stopping writers:
//! the walk adds the objects in chunks, each under one short hold of the
//! lock, and a change meanwhile is applied to the partial index when the
//! walk has already passed its key and left to the walk otherwise. Readers
//! wait on a notification, so one that goes away never leaves the index
//! marked as building.
//!
//! A folder is a prefix ending in `/`, taken byte for byte (`a//` and `/`
//! are folders). A zero-byte object whose name ends in `/` is a folder
//! marker, not a file: it counts in no figure, marks the folder it names and
//! keeps it, and its parents, in existence while it lasts.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::ops::Bound;
use std::panic::AssertUnwindSafe;
use std::pin::pin;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::Notify;

use crate::changes::ChangeEvent;
use crate::{StorageData, StorageState, StoredObject, lock};

/// Keys one walk step adds under one hold of the service's lock, at most.
const WALK_CHUNK: usize = 10_000;
/// And at most this long, so a writer waiting for the lock is never held up
/// longer, whatever the build.
const WALK_STEP: Duration = Duration::from_millis(5);
/// The pause between two walk steps.
const WALK_PAUSE: Duration = Duration::from_micros(200);
/// Walks one runtime starts before the index is reported as broken.
const WALK_ATTEMPTS: u8 = 3;

/// One folder's figures. Markers are not files, so every figure matches
/// what a listing shows.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct FolderStats {
    /// Files anywhere below.
    pub objects: u64,
    /// Their bytes.
    pub bytes: u64,
    /// Files directly in the folder.
    pub direct_files: u64,
    pub direct_bytes: u64,
    /// Direct subfolders.
    pub folders: u64,
    /// Subfolders at any depth below.
    pub folders_below: u64,
    /// The last create, replace, metadata change or delete below, in Unix
    /// milliseconds: the newest `updated` the index has seen until it
    /// observes a change itself; `None` when nothing is known.
    pub changed_at_ms: Option<i64>,
    /// The revision of the last change to what the folder lists directly: a
    /// direct file, or a subfolder appearing or going. Zero when no change
    /// has been observed since the index was built.
    pub level_rev: u64,
    /// The revision of the last change anywhere below.
    pub subtree_rev: u64,
    /// Changes counted in `level_rev`, ever.
    pub level_changes: u64,
    /// Changes counted in `subtree_rev`, ever.
    pub subtree_changes: u64,
    /// A marker object names this folder.
    pub placeholder: bool,
    /// Marker objects at or below this folder; one keeps it in existence.
    markers: u64,
}

impl FolderStats {
    const fn exists(&self) -> bool {
        self.objects > 0 || self.markers > 0
    }
}

/// What the index needs of an object.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Shape {
    size: u64,
    marker: bool,
}

impl Shape {
    pub(crate) fn of(object: &StoredObject) -> Self {
        Self {
            size: object.size,
            marker: object.size == 0 && object.name.ends_with('/'),
        }
    }
}

/// How a figure moved: a change the index observed, or an object the walk
/// found.
#[derive(Clone, Copy)]
enum Change {
    Committed { revision: u64, at_ms: i64 },
    Walked { updated_ms: Option<i64> },
}

/// One folder shape of a bucket, for the rules map: real folder names, with
/// a star segment standing for every folder at a level holding many.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FolderShape {
    /// `users/*/avatars/`; `''` for the bucket root.
    pub pattern: String,
    /// Files directly in the folders the pattern stands for.
    pub files: u64,
    /// The pattern is at the analysis depth and folders below it hold
    /// files that were not probed.
    pub deeper: bool,
}

/// Folder levels a rules map probes, at most.
pub const SHAPE_DEPTH: usize = 6;
/// Folder shapes a rules map lists, at most.
pub const SHAPE_PATTERNS: usize = 500;
/// Child folders above which a level is written as one star segment.
pub const SHAPE_GROUP: usize = 20;

#[derive(Debug, Default)]
struct BucketIndex {
    root: FolderStats,
    /// Parent prefix (`''` for the root) -> child segment (`'a/'`) -> the
    /// child folder's figures. Sorted, so a folder's subfolders list in
    /// name order without a scan.
    children: HashMap<String, BTreeMap<String, FolderStats>>,
}

impl BucketIndex {
    /// The figures of the folder `depth` levels down `name`'s chain (0 is
    /// the bucket root), given the end offset of each folder prefix.
    fn folder_mut(&mut self, name: &str, ends: &[usize], depth: usize) -> Option<&mut FolderStats> {
        if depth == 0 {
            return Some(&mut self.root);
        }
        let start = if depth == 1 { 0 } else { ends[depth - 2] };
        self.children
            .get_mut(&name[..start])?
            .get_mut(&name[start..ends[depth - 1]])
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Progress {
    /// The walk has added every key up to and including this one (none yet).
    Walking(Option<String>),
    Built,
}

/// Counts, sizes and last changes under every folder of every bucket, exact
/// from the moment it is built.
pub(crate) struct FolderIndex {
    buckets: HashMap<String, BucketIndex>,
    progress: Progress,
}

impl fmt::Debug for FolderIndex {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FolderIndex")
            .field("buckets", &self.buckets.len())
            .field("progress", &self.progress)
            .finish()
    }
}

impl FolderIndex {
    /// An index the walk is about to fill.
    pub(crate) fn walking() -> Self {
        Self {
            buckets: HashMap::new(),
            progress: Progress::Walking(None),
        }
    }

    /// An index of nothing, complete: what a reset leaves.
    pub(crate) fn built() -> Self {
        Self {
            buckets: HashMap::new(),
            progress: Progress::Built,
        }
    }

    pub(crate) fn is_built(&self) -> bool {
        self.progress == Progress::Built
    }

    /// A committed change to the object at `key`: applied once the walk has
    /// passed the key (the partial index already counts `before`), left to
    /// the walk otherwise (it will read the key's state when it gets there).
    pub(crate) fn observe(
        &mut self,
        key: &str,
        object: (&str, &str),
        before: Option<Shape>,
        after: Option<Shape>,
        (revision, at_ms): (u64, i64),
    ) {
        if let Progress::Walking(cursor) = &self.progress
            && cursor.as_deref().is_none_or(|cursor| key > cursor)
        {
            return;
        }
        self.apply(
            object.0,
            object.1,
            before,
            after,
            Change::Committed { revision, at_ms },
        );
    }

    fn add_walked(&mut self, object: &StoredObject) {
        self.apply(
            &object.bucket,
            &object.name,
            None,
            Some(Shape::of(object)),
            Change::Walked {
                updated_ms: rfc3339_millis(&object.updated),
            },
        );
    }

    /// The figures of `prefix` (empty for the bucket root, else ending in
    /// `/`), or `None` when nothing is there.
    pub(crate) fn stats(&self, bucket: &str, prefix: &str) -> Option<FolderStats> {
        let index = self.buckets.get(bucket)?;
        if prefix.is_empty() {
            return Some(index.root);
        }
        let folder = prefix.strip_suffix('/')?;
        let parent = folder.rfind('/').map_or(0, |slash| slash + 1);
        index
            .children
            .get(&prefix[..parent])?
            .get(&prefix[parent..])
            .copied()
    }

    /// The folder shapes of `bucket` whose folders directly hold files, each
    /// at its real depth, at most [`SHAPE_DEPTH`] levels and
    /// [`SHAPE_PATTERNS`] shapes; a level of more than [`SHAPE_GROUP`] child
    /// folders becomes one star segment. Also whether any level was grouped.
    pub(crate) fn shapes(&self, bucket: &str) -> (Vec<FolderShape>, bool) {
        // A folder as the walk carries it: its figures, and its own prefix
        // when it has subfolders (the key of its child map, borrowed, so no
        // folder's name is copied).
        type Folder<'a> = (&'a FolderStats, Option<&'a str>);
        let Some(index) = self.buckets.get(bucket) else {
            return (Vec::new(), false);
        };
        let own = |prefix: &str| {
            index
                .children
                .get_key_value(prefix)
                .map(|(key, _)| key.as_str())
        };
        let mut shapes = Vec::new();
        let mut grouped = false;
        let mut buffer = String::new();
        let mut level: Vec<(String, Vec<Folder<'_>>)> =
            vec![(String::new(), vec![(&index.root, own(""))])];
        for depth in 0..=SHAPE_DEPTH {
            let mut next = Vec::new();
            for (pattern, folders) in level {
                let files = folders
                    .iter()
                    .map(|(stats, _)| stats.direct_files)
                    .sum::<u64>();
                let deeper = depth == SHAPE_DEPTH
                    && folders
                        .iter()
                        .any(|(stats, _)| stats.objects > stats.direct_files);
                if files > 0 || deeper {
                    shapes.push(FolderShape {
                        pattern: pattern.clone(),
                        files,
                        deeper,
                    });
                    if shapes.len() == SHAPE_PATTERNS {
                        return (shapes, grouped);
                    }
                }
                if depth == SHAPE_DEPTH {
                    continue;
                }
                // Grouped by name until the level proves wide; from then on
                // every child goes to one star pattern, unsorted.
                let mut children: BTreeMap<&str, Vec<Folder<'_>>> = BTreeMap::new();
                let mut star: Option<Vec<Folder<'_>>> = None;
                for (_, key) in &folders {
                    let Some(key) = key else {
                        continue;
                    };
                    for (segment, stats) in &index.children[*key] {
                        buffer.clear();
                        buffer.push_str(key);
                        buffer.push_str(segment);
                        let folder = (stats, own(&buffer));
                        if let Some(star) = &mut star {
                            star.push(folder);
                            continue;
                        }
                        children.entry(segment.as_str()).or_default().push(folder);
                        if children.len() > SHAPE_GROUP {
                            star = Some(
                                std::mem::take(&mut children)
                                    .into_values()
                                    .flatten()
                                    .collect(),
                            );
                        }
                    }
                }
                if let Some(star) = star {
                    grouped = true;
                    next.push((format!("{pattern}*/"), star));
                } else {
                    next.extend(
                        children
                            .into_iter()
                            .map(|(segment, folders)| (format!("{pattern}{segment}"), folders)),
                    );
                }
            }
            level = next;
        }
        (shapes, grouped)
    }

    /// Every bucket holding something, with its root's figures.
    pub(crate) fn roots(&self) -> impl Iterator<Item = (&str, &FolderStats)> {
        self.buckets
            .iter()
            .map(|(bucket, index)| (bucket.as_str(), &index.root))
    }

    #[allow(clippy::cast_possible_wrap)]
    fn apply(
        &mut self,
        bucket: &str,
        name: &str,
        before: Option<Shape>,
        after: Option<Shape>,
        change: Change,
    ) {
        let file = |shape: Option<Shape>| shape.filter(|shape| !shape.marker);
        let marker = |shape: Option<Shape>| shape.is_some_and(|shape| shape.marker);
        let objects = i128::from(file(after).is_some()) - i128::from(file(before).is_some());
        let bytes = i128::from(file(after).map_or(0, |shape| shape.size))
            - i128::from(file(before).map_or(0, |shape| shape.size));
        let markers = i128::from(marker(after)) - i128::from(marker(before));
        if !self.buckets.contains_key(bucket) {
            self.buckets
                .insert(bucket.to_owned(), BucketIndex::default());
        }
        let index = self.buckets.get_mut(bucket).expect("bucket present");
        let ends = name
            .match_indices('/')
            .map(|(offset, _)| offset + 1)
            .collect::<Vec<_>>();
        let leaf = ends.len();
        let mut flips = Vec::new();
        let mut gone = Vec::new();
        for depth in 0..=leaf {
            if depth > 0 {
                // Create the folder's entry when it does not exist yet.
                let start = if depth == 1 { 0 } else { ends[depth - 2] };
                let parent = &name[..start];
                if !index.children.contains_key(parent) {
                    index.children.insert(parent.to_owned(), BTreeMap::new());
                }
                let siblings = index.children.get_mut(parent).expect("parent present");
                let segment = &name[start..ends[depth - 1]];
                if !siblings.contains_key(segment) {
                    siblings.insert(segment.to_owned(), FolderStats::default());
                }
            }
            let stats = index
                .folder_mut(name, &ends, depth)
                .expect("folder present");
            let existed = stats.exists();
            shift(&mut stats.objects, objects);
            shift(&mut stats.bytes, bytes);
            shift(&mut stats.markers, markers);
            if depth == leaf {
                shift(&mut stats.direct_files, objects);
                shift(&mut stats.direct_bytes, bytes);
                if depth > 0 && name.ends_with('/') {
                    // The object named exactly this folder: a marker, or a
                    // file with an empty name inside it.
                    stats.placeholder = marker(after);
                }
            }
            match change {
                Change::Committed { revision, at_ms } => {
                    stats.subtree_rev = revision;
                    stats.subtree_changes += 1;
                    stats.changed_at_ms =
                        Some(stats.changed_at_ms.map_or(at_ms, |at| at.max(at_ms)));
                    if depth == leaf {
                        stats.level_rev = revision;
                        stats.level_changes += 1;
                    }
                }
                Change::Walked { updated_ms } => {
                    if let Some(updated) = updated_ms {
                        stats.changed_at_ms =
                            Some(stats.changed_at_ms.map_or(updated, |at| at.max(updated)));
                    }
                }
            }
            if depth > 0 && existed != stats.exists() {
                flips.push((depth, stats.exists()));
            }
            if depth > 0 && !stats.exists() {
                gone.push(depth);
            }
        }
        // A folder that came into existence or went: its parent lists it, so
        // the parent's level moved too; every ancestor counts it below.
        for &(depth, exists) in &flips {
            let delta = if exists { 1 } else { -1 };
            for ancestor in 0..depth {
                let stats = index
                    .folder_mut(name, &ends, ancestor)
                    .expect("ancestor present");
                shift(&mut stats.folders_below, delta);
                if ancestor + 1 == depth {
                    shift(&mut stats.folders, delta);
                    if let Change::Committed { revision, .. } = change {
                        stats.level_rev = revision;
                        stats.level_changes += 1;
                    }
                }
            }
        }
        // Deepest first, so a parent's empty child map goes with it.
        for &depth in gone.iter().rev() {
            let start = if depth == 1 { 0 } else { ends[depth - 2] };
            let parent = &name[..start];
            if let Some(siblings) = index.children.get_mut(parent) {
                siblings.remove(&name[start..ends[depth - 1]]);
                if siblings.is_empty() {
                    index.children.remove(parent);
                }
            }
        }
        if !index.root.exists() {
            self.buckets.remove(bucket);
        }
    }
}

fn shift(value: &mut u64, delta: i128) {
    *value = u64::try_from((i128::from(*value) + delta).max(0)).unwrap_or(u64::MAX);
}

/// Unix milliseconds of an RFC 3339 time. The UTC form the service writes
/// (`2026-10-01T08:00:00.123456789Z`) is read by hand, because the walk
/// reads a million of them; anything else goes through the full parser.
fn rfc3339_millis(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let mut number = 0_i64;
        for &byte in bytes.get(range)? {
            if !byte.is_ascii_digit() {
                return None;
            }
            number = number * 10 + i64::from(byte - b'0');
        }
        Some(number)
    };
    let fast = || -> Option<i64> {
        if bytes.len() < 20
            || bytes[4] != b'-'
            || bytes[7] != b'-'
            || bytes[10] != b'T'
            || bytes[13] != b':'
            || bytes[16] != b':'
            || *bytes.last()? != b'Z'
        {
            return None;
        }
        let (year, month, day) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
        let (hour, minute, second) = (digits(11..13)?, digits(14..16)?, digits(17..19)?);
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
            return None;
        }
        let fraction = &bytes[19..bytes.len() - 1];
        let millis = match fraction {
            [] => 0,
            [b'.', rest @ ..] if !rest.is_empty() && rest.iter().all(u8::is_ascii_digit) => rest
                .iter()
                .chain(b"000".iter())
                .take(3)
                .fold(0, |total, digit| total * 10 + i64::from(digit - b'0')),
            _ => return None,
        };
        let days = days_from_civil(year, month, day);
        Some(((days * 24 + hour) * 60 + minute) * 60_000 + second.min(60) * 1_000 + millis)
    };
    fast().or_else(|| {
        OffsetDateTime::parse(value, &Rfc3339)
            .ok()
            .and_then(|time| i64::try_from(time.unix_timestamp_nanos() / 1_000_000).ok())
    })
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
const fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Why the folder index cannot answer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FolderIndexError(pub String);

impl fmt::Display for FolderIndexError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "The folder index could not be built: {}", self.0)
    }
}

impl std::error::Error for FolderIndexError {}

/// The walk's wake-up and its failures, beside the index in the object map.
#[derive(Debug, Default)]
pub(crate) struct IndexControl {
    done: Notify,
    failures: Mutex<Failures>,
    /// Walks the tests make fail.
    #[cfg(test)]
    pub(crate) fail_walks: std::sync::atomic::AtomicUsize,
}

#[derive(Debug, Default)]
struct Failures {
    attempts: u8,
    last: Option<String>,
}

impl IndexControl {
    fn gave_up(&self) -> Option<FolderIndexError> {
        let failures = lock(&self.failures);
        (failures.attempts >= WALK_ATTEMPTS).then(|| {
            FolderIndexError(
                failures
                    .last
                    .clone()
                    .unwrap_or_else(|| "the walk failed".to_owned()),
            )
        })
    }
}

/// Where the index stands.
enum Status {
    Absent,
    Building,
    Built,
}

fn status(data: &StorageData) -> Status {
    match &data.folders {
        None => Status::Absent,
        Some(index) if index.is_built() => Status::Built,
        Some(_) => Status::Building,
    }
}

/// Starts the walk when the index neither exists nor is being built; never
/// waits. False when it cannot start (the service is stopping, the walk
/// failed for good, or no runtime is running).
pub(crate) fn ensure_built(state: &StorageState) -> bool {
    if state.index.gave_up().is_some() {
        return false;
    }
    {
        let mut data = lock(&state.inner);
        if data.folders.is_some() {
            return true;
        }
        data.folders = Some(FolderIndex::walking());
    }
    let walker = state.clone();
    if state.tasks.spawn_blocking(move || walk(&walker)) {
        return true;
    }
    let mut data = lock(&state.inner);
    if data
        .folders
        .as_ref()
        .is_some_and(|index| index.progress == Progress::Walking(None))
    {
        data.folders = None;
    }
    false
}

/// Whether the index is built, starting the walk if needed and waiting up to
/// `wait` for it. An error once the walk has failed for good.
pub(crate) async fn ready(state: &StorageState, wait: Duration) -> Result<bool, FolderIndexError> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        // Registered before looking, so a walk that ends in between is seen.
        let mut notified = pin!(state.index.done.notified());
        notified.as_mut().enable();
        let current = status(&lock(&state.inner));
        match current {
            Status::Built => return Ok(true),
            Status::Building => {}
            Status::Absent => {
                if let Some(error) = state.index.gave_up() {
                    return Err(error);
                }
                if !ensure_built(state) {
                    return state.index.gave_up().map_or(Ok(false), Err);
                }
            }
        }
        if wait.is_zero() || tokio::time::timeout_at(deadline, notified).await.is_err() {
            return Ok(false);
        }
    }
}

/// Builds the index in chunks, each under one short hold of the lock, until
/// every key is in, the service stops, or a reset installs a complete
/// index. Runs on the blocking pool as one of the console's tasks.
fn walk(state: &StorageState) {
    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| walk_chunks(state)));
    let failure = match outcome {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(error),
        Err(panic) => Some(
            panic
                .downcast_ref::<&str>()
                .map(|message| (*message).to_owned())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "the walk panicked".to_owned()),
        ),
    };
    if let Some(error) = failure {
        {
            let mut data = lock(&state.inner);
            if data.folders.as_ref().is_some_and(|index| !index.is_built()) {
                data.folders = None;
            }
        }
        let mut failures = lock(&state.index.failures);
        failures.attempts = failures.attempts.saturating_add(1);
        failures.last = Some(error);
    }
    state.index.done.notify_waiters();
}

fn walk_chunks(state: &StorageState) -> Result<(), String> {
    #[cfg(test)]
    if state
        .index
        .fail_walks
        .try_update(
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
            |left| left.checked_sub(1),
        )
        .is_ok()
    {
        return Err("a failure the test asked for".to_owned());
    }
    loop {
        if state.tasks.stopping() {
            return Ok(());
        }
        let mut data = lock(&state.inner);
        let StorageData {
            objects, folders, ..
        } = &mut *data;
        let Some(index) = folders.as_mut() else {
            return Ok(());
        };
        let Progress::Walking(cursor) = &index.progress else {
            // A reset installed a complete index meanwhile.
            return Ok(());
        };
        let range = match cursor.as_deref() {
            Some(cursor) => objects.range::<str, _>((Bound::Excluded(cursor), Bound::Unbounded)),
            None => objects.range::<str, _>(..),
        };
        let started = Instant::now();
        let mut last = None;
        let mut finished = true;
        for (walked, (key, object)) in range.enumerate() {
            if walked == WALK_CHUNK || (walked % 256 == 255 && started.elapsed() >= WALK_STEP) {
                finished = false;
                break;
            }
            index.add_walked(object);
            last = Some(key);
        }
        if finished {
            index.progress = Progress::Built;
            // Inside the lock: subscribers learn of it in commit order.
            state.feed.announce(ChangeEvent::IndexReady);
            return Ok(());
        }
        if let Some(last) = last {
            index.progress = Progress::Walking(Some(last.clone()));
        }
        drop(data);
        // A writer waiting for the lock takes it now: a lock that does not
        // hand over in order would otherwise go straight back to the walk.
        std::thread::sleep(WALK_PAUSE);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn utc_times_are_read_by_hand_and_agree_with_the_parser() {
        for value in [
            "1970-01-01T00:00:00Z",
            "2026-10-01T08:00:00Z",
            "2026-10-01T08:00:00.5Z",
            "2026-10-01T08:00:00.123456789Z",
            "2024-02-29T23:59:59.999Z",
            "1999-12-31T23:59:59.001Z",
            "2026-10-01T16:00:00+08:00",
        ] {
            let expected = OffsetDateTime::parse(value, &Rfc3339)
                .map(|time| i64::try_from(time.unix_timestamp_nanos() / 1_000_000).unwrap())
                .ok();
            assert_eq!(rfc3339_millis(value), expected, "{value}");
        }
        assert_eq!(rfc3339_millis("not a time"), None);
    }

    /// What every folder of a bucket holds, recounted from the objects.
    fn recount(objects: &BTreeMap<String, (u64, i64)>) -> BTreeMap<String, FolderStats> {
        let mut folders: BTreeMap<String, FolderStats> = BTreeMap::new();
        folders.insert(String::new(), FolderStats::default());
        for (name, &(size, _)) in objects {
            let marker = size == 0 && name.ends_with('/');
            let ends = name
                .match_indices('/')
                .map(|(offset, _)| offset + 1)
                .collect::<Vec<_>>();
            let chain = std::iter::once(String::new())
                .chain(ends.iter().map(|end| name[..*end].to_owned()))
                .collect::<Vec<_>>();
            for (depth, prefix) in chain.iter().enumerate() {
                let stats = folders.entry(prefix.clone()).or_default();
                if marker {
                    stats.markers += 1;
                } else {
                    stats.objects += 1;
                    stats.bytes += size;
                }
                if depth + 1 == chain.len() {
                    if marker {
                        stats.placeholder = true;
                    } else {
                        stats.direct_files += 1;
                        stats.direct_bytes += size;
                    }
                }
            }
        }
        let existing = folders
            .iter()
            .filter(|(prefix, stats)| prefix.is_empty() || stats.exists())
            .map(|(prefix, _)| prefix.clone())
            .collect::<BTreeSet<_>>();
        folders.retain(|prefix, _| existing.contains(prefix));
        // Each existing folder counts once in its parent and in every
        // ancestor above it.
        for prefix in existing.iter().filter(|prefix| !prefix.is_empty()) {
            let ancestors = std::iter::once(0)
                .chain(
                    prefix[..prefix.len() - 1]
                        .match_indices('/')
                        .map(|(offset, _)| offset + 1),
                )
                .collect::<Vec<_>>();
            let parent = *ancestors.last().expect("the root at least");
            for end in &ancestors {
                let stats = folders.get_mut(&prefix[..*end]).expect("ancestor exists");
                stats.folders_below += 1;
                if *end == parent {
                    stats.folders += 1;
                }
            }
        }
        folders
    }

    /// The index's figures of every folder it holds, revisions left out.
    fn figures(index: &FolderIndex, bucket: &str) -> BTreeMap<String, FolderStats> {
        let mut folders = BTreeMap::new();
        let Some(bucket_index) = index.buckets.get(bucket) else {
            folders.insert(String::new(), FolderStats::default());
            return folders;
        };
        let strip = |stats: &FolderStats| FolderStats {
            changed_at_ms: None,
            level_rev: 0,
            subtree_rev: 0,
            level_changes: 0,
            subtree_changes: 0,
            ..*stats
        };
        folders.insert(String::new(), strip(&bucket_index.root));
        for (parent, children) in &bucket_index.children {
            for (segment, stats) in children {
                folders.insert(format!("{parent}{segment}"), strip(stats));
            }
        }
        folders
    }

    struct Generator(u64);

    impl Generator {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut value = self.0;
            value = (value ^ (value >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            value = (value ^ (value >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            value ^ (value >> 31)
        }

        fn below(&mut self, bound: u64) -> u64 {
            self.next() % bound
        }
    }

    fn random_name(generator: &mut Generator) -> String {
        const SEGMENTS: [&str; 6] = ["a", "b", "users", "", "x y", "é"];
        let depth = 1 + generator.below(6);
        let mut name = String::new();
        for level in 0..depth {
            name.push_str(SEGMENTS[usize::try_from(generator.below(6)).unwrap()]);
            if level + 1 < depth {
                name.push('/');
            }
        }
        match generator.below(5) {
            // A marker: a zero-byte object named like a folder.
            0 => name.push('/'),
            1 => {
                name.push_str("/f");
                name.push_str(&generator.below(40).to_string());
            }
            _ => name.push_str(&generator.below(40).to_string()),
        }
        name
    }

    #[test]
    fn matches_brute_force() {
        let mut generator = Generator(7);
        let mut index = FolderIndex::built();
        let mut objects: BTreeMap<String, (u64, i64)> = BTreeMap::new();
        let names = (0..2_000)
            .map(|_| random_name(&mut generator))
            .collect::<Vec<_>>();
        for operation in 1..=10_000_u64 {
            let name = &names[usize::try_from(generator.below(2_000)).unwrap()];
            let before = objects.get(name).map(|&(size, _)| Shape {
                size,
                marker: size == 0 && name.ends_with('/'),
            });
            let after = if generator.below(3) == 0 {
                objects.remove(name);
                None
            } else {
                let size = if name.ends_with('/') && generator.below(4) != 0 {
                    0
                } else {
                    1 + generator.below(1_000)
                };
                objects.insert(name.clone(), (size, 0));
                Some(Shape {
                    size,
                    marker: size == 0 && name.ends_with('/'),
                })
            };
            if before.is_none() && after.is_none() {
                continue;
            }
            index.observe(
                &format!("b\0{name}"),
                ("b", name),
                before,
                after,
                (operation, 1_000 + i64::try_from(operation).unwrap()),
            );
            if operation % 100 == 0 {
                assert_eq!(figures(&index, "b"), recount(&objects), "after {operation}");
            }
        }
    }

    #[test]
    fn markers_hold_folders_and_count_in_no_figure() {
        let mut index = FolderIndex::built();
        let marker = Some(Shape {
            size: 0,
            marker: true,
        });
        index.observe("b\0a/b/", ("b", "a/b/"), None, marker, (1, 10));
        let folder = index.stats("b", "a/b/").expect("held by its marker");
        assert!(folder.placeholder);
        assert_eq!((folder.objects, folder.direct_files), (0, 0));
        assert_eq!(index.stats("b", "a/").expect("parent").folders, 1);
        assert_eq!(index.stats("b", "").expect("root").folders_below, 2);
        // The parent lists the new folder: its level moved.
        assert_eq!(index.stats("b", "a/").expect("parent").level_rev, 1);
        index.observe(
            "b\0a/b/c.txt",
            ("b", "a/b/c.txt"),
            None,
            Some(Shape {
                size: 5,
                marker: false,
            }),
            (2, 20),
        );
        index.observe("b\0a/b/", ("b", "a/b/"), marker, None, (3, 30));
        let folder = index.stats("b", "a/b/").expect("held by its file now");
        assert!(!folder.placeholder);
        assert_eq!((folder.objects, folder.bytes), (1, 5));
        assert_eq!(folder.changed_at_ms, Some(30));
        index.observe(
            "b\0a/b/c.txt",
            ("b", "a/b/c.txt"),
            Some(Shape {
                size: 5,
                marker: false,
            }),
            None,
            (4, 40),
        );
        assert_eq!(index.stats("b", "a/b/"), None);
        assert_eq!(index.stats("b", "a/"), None);
        assert_eq!(
            index.stats("b", ""),
            None,
            "an empty bucket leaves the index"
        );
    }

    #[test]
    fn empty_segments_are_folders_of_their_own() {
        let mut index = FolderIndex::built();
        let file = Some(Shape {
            size: 3,
            marker: false,
        });
        index.observe("b\0a//b.png", ("b", "a//b.png"), None, file, (1, 1));
        index.observe("b\0/lead.png", ("b", "/lead.png"), None, file, (2, 2));
        assert_eq!(index.stats("b", "a//").expect("a//").direct_files, 1);
        assert_eq!(index.stats("b", "a/").expect("a/").folders, 1);
        assert_eq!(index.stats("b", "/").expect("/").direct_files, 1);
        assert_eq!(index.stats("b", "").expect("root").folders, 2);
    }

    mod runtime {
        use std::path::PathBuf;

        use firenook_functions_bridge::{TriggerObserver, TriggerRegistry};

        use super::super::*;
        use super::{figures, recount};
        use crate::{ChangeContext, StorageConfig, StorageDurability, StorageRuntime, object_key};

        async fn runtime(label: &str) -> (StorageRuntime, PathBuf) {
            let root = std::env::temp_dir().join(format!(
                "firenook-folder-index-{label}-{}-{}",
                std::process::id(),
                OffsetDateTime::now_utc().unix_timestamp_nanos()
            ));
            let registry = TriggerRegistry::default();
            let (observer, _receiver) = TriggerObserver::channel(registry.clone());
            let runtime = StorageRuntime::start(
                StorageConfig {
                    project: "demo-folder-index".to_owned(),
                    origin: "http://127.0.0.1:1".to_owned(),
                    data_dir: root.clone(),
                    rules: None,
                    durability: StorageDurability::PerCommit,
                },
                observer.queue(),
                registry,
            )
            .await
            .expect("runtime");
            (runtime, root)
        }

        fn object(bucket: &str, name: &str, size: u64) -> StoredObject {
            StoredObject {
                name: name.to_owned(),
                bucket: bucket.to_owned(),
                generation: 1,
                metageneration: 1,
                content_type: None,
                storage_class: "STANDARD".to_owned(),
                content_disposition: None,
                content_encoding: None,
                content_language: None,
                cache_control: None,
                download_tokens: Vec::new(),
                custom_metadata: std::collections::BTreeMap::new(),
                time_created: "2026-10-01T00:00:00Z".to_owned(),
                updated: "2026-10-01T00:00:00Z".to_owned(),
                size,
                md5_hash: String::new(),
                crc32c: 0,
                etag: String::new(),
                data_file: String::new(),
            }
        }

        /// Fills the map directly: what a large state looks like when the
        /// service opens, before any console asked for the index.
        fn seed(runtime: &StorageRuntime, count: usize) {
            let mut data = lock(&runtime.state.inner);
            for index in 0..count {
                let name = format!("users/u{:05}/f{}.png", index / 4, index % 4);
                data.objects
                    .insert(object_key("b", &name), object("b", &name, 100));
            }
        }

        fn sizes(runtime: &StorageRuntime) -> std::collections::BTreeMap<String, (u64, i64)> {
            lock(&runtime.state.inner)
                .objects
                .values()
                .filter(|object| object.bucket == "b")
                .map(|object| (object.name.clone(), (object.size, 0)))
                .collect()
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn build_does_not_block_writers() {
            let (runtime, root) = runtime("writers").await;
            seed(&runtime, 200_000);
            let console = runtime.console();
            let mut events = console.subscribe();
            assert_eq!(
                console.summary().objects,
                None,
                "the walk starts, nothing waits"
            );
            let writer_state = runtime.state.clone();
            let writer = tokio::task::spawn_blocking(move || {
                let mut slowest = Duration::ZERO;
                let mut writes = 0_u64;
                let system = ChangeContext::system();
                loop {
                    let started = Instant::now();
                    let mut data = lock(&writer_state.inner);
                    let built = data.folders.as_ref().is_some_and(FolderIndex::is_built);
                    // Across the whole key range: replace, delete and create.
                    let slot = writes * 7_919 % 50_000;
                    let name = format!("users/u{slot:05}/f{}.png", writes % 4);
                    match writes % 3 {
                        0 => {
                            data.put(object("b", &name, 50 + writes), &system);
                        }
                        1 => {
                            data.remove(&object_key("b", &name), &system);
                        }
                        _ => {
                            let fresh = format!("users/u{slot:05}/new{writes}.png");
                            data.put(object("b", &fresh, 7), &system);
                        }
                    }
                    drop(data);
                    slowest = slowest.max(started.elapsed());
                    writes += 1;
                    if built {
                        return (slowest, writes);
                    }
                    std::thread::sleep(Duration::from_micros(200));
                }
            });
            let ready = console
                .folder_index_ready(Duration::from_secs(60))
                .await
                .expect("the walk succeeds");
            assert!(ready);
            let (slowest, write_count) = writer.await.expect("writer");
            assert!(
                write_count > 10,
                "the writer ran during the walk ({write_count} writes)"
            );
            assert!(
                slowest < Duration::from_millis(50),
                "a write waited {slowest:?} for the walk"
            );
            let expected = recount(&sizes(&runtime));
            {
                let data = lock(&runtime.state.inner);
                let index = data.folders.as_ref().expect("index");
                assert_eq!(figures(index, "b"), expected);
            }
            let mut saw_ready = false;
            loop {
                match events.try_recv() {
                    Ok(event) => saw_ready |= event == ChangeEvent::IndexReady,
                    Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {}
                    Err(_) => break,
                }
            }
            assert!(saw_ready, "the build is announced");
            let summary = console.summary();
            // The bucket holding objects and the project's default bucket.
            assert_eq!(summary.buckets, 2);
            assert_eq!(
                summary.objects,
                Some(sizes(&runtime).len() as u64),
                "objects once built"
            );
            runtime.shutdown().await.expect("shutdown");
            std::fs::remove_dir_all(root).expect("remove");
        }

        #[tokio::test]
        async fn walk_survives_a_dropped_reader() {
            let (runtime, root) = runtime("dropped").await;
            seed(&runtime, 40_000);
            let console = runtime.console();
            let abandoned = console.clone();
            let started =
                tokio::spawn(
                    async move { abandoned.folder_index_ready(Duration::from_secs(30)).await },
                );
            tokio::task::yield_now().await;
            started.abort();
            let ready = tokio::time::timeout(
                Duration::from_secs(20),
                console.folder_index_ready(Duration::from_secs(30)),
            )
            .await
            .expect("a reader that left must not wedge the index")
            .expect("built");
            assert!(ready);
            assert_eq!(
                console.folder("b", "users/").expect("users/").objects,
                40_000
            );
            assert_eq!(
                console
                    .folder("b", "users/u00001/")
                    .expect("one user")
                    .direct_files,
                4
            );
            runtime.shutdown().await.expect("shutdown");
            std::fs::remove_dir_all(root).expect("remove");
        }

        #[tokio::test]
        async fn failed_walk_fails_fast() {
            let (runtime, root) = runtime("failed").await;
            seed(&runtime, 10);
            runtime.state.index.fail_walks.store(
                usize::from(WALK_ATTEMPTS),
                std::sync::atomic::Ordering::SeqCst,
            );
            let console = runtime.console();
            let started = Instant::now();
            let error = console
                .folder_index_ready(Duration::from_secs(30))
                .await
                .expect_err("a walk that keeps failing is reported");
            assert!(started.elapsed() < Duration::from_secs(5), "it failed fast");
            assert_eq!(
                error.to_string(),
                "The folder index could not be built: a failure the test asked for"
            );
            assert_eq!(console.summary().objects, None);
            assert_eq!(console.folder("b", ""), None);
            runtime.shutdown().await.expect("shutdown");
            std::fs::remove_dir_all(root).expect("remove");
        }

        #[tokio::test]
        async fn a_failed_walk_is_retried() {
            let (runtime, root) = runtime("retried").await;
            seed(&runtime, 10);
            runtime
                .state
                .index
                .fail_walks
                .store(1, std::sync::atomic::Ordering::SeqCst);
            let console = runtime.console();
            assert!(
                console
                    .folder_index_ready(Duration::from_secs(30))
                    .await
                    .expect("the second walk succeeds")
            );
            assert_eq!(console.folder("b", "").expect("root").objects, 10);
            runtime.shutdown().await.expect("shutdown");
            std::fs::remove_dir_all(root).expect("remove");
        }

        #[tokio::test]
        async fn reset_keeps_the_revision_monotonic() {
            let (runtime, root) = runtime("reset").await;
            seed(&runtime, 10);
            let console = runtime.console();
            let mut events = console.subscribe();
            let before = console.revision();
            {
                let mut data = lock(&runtime.state.inner);
                data.put(object("b", "late.txt", 3), &ChangeContext::system());
                data.clear();
            }
            assert_eq!(console.revision(), before + 2);
            assert!(matches!(
                events.try_recv().expect("the put"),
                ChangeEvent::Committed { .. }
            ));
            assert_eq!(events.try_recv().expect("the reset"), ChangeEvent::Reset);
            // Complete at once and empty, without a walk.
            assert!(
                console
                    .folder_index_ready(Duration::ZERO)
                    .await
                    .expect("built")
            );
            assert_eq!(console.folder("b", ""), None);
            assert_eq!(console.summary().objects, Some(0));
            runtime.shutdown().await.expect("shutdown");
            std::fs::remove_dir_all(root).expect("remove");
        }

        #[tokio::test]
        async fn stopping_ends_the_walk_and_refuses_another() {
            let (runtime, root) = runtime("stopping").await;
            seed(&runtime, 100_000);
            let console = runtime.console();
            assert_eq!(console.summary().objects, None);
            runtime.stop_console_tasks().await;
            // Stopped between chunks: no walk runs, and none starts again.
            assert!(
                !console
                    .folder_index_ready(Duration::from_millis(50))
                    .await
                    .expect("not an error")
            );
            runtime.stop_console_tasks().await;
            runtime.shutdown().await.expect("shutdown");
            std::fs::remove_dir_all(root).expect("remove");
        }
    }

    #[test]
    fn shapes_group_wide_levels_and_stop_at_the_depth_cap() {
        let mut index = FolderIndex::built();
        let file = Some(Shape {
            size: 1,
            marker: false,
        });
        let mut revision = 0;
        let mut add = |index: &mut FolderIndex, name: &str| {
            revision += 1;
            index.observe(
                &format!("b\0{name}"),
                ("b", name),
                None,
                file,
                (revision, 1),
            );
        };
        add(&mut index, "root.txt");
        for user in 0..25 {
            add(&mut index, &format!("users/u{user:02}/avatar.png"));
            add(&mut index, &format!("users/u{user:02}/avatars/a.png"));
        }
        add(&mut index, "misc/a.bin");
        add(&mut index, "misc/b.bin");
        add(&mut index, "deep/1/2/3/4/5/6/7/far.txt");
        let (shapes, grouped) = index.shapes("b");
        assert!(grouped);
        let summary = shapes
            .iter()
            .map(|shape| (shape.pattern.as_str(), shape.files, shape.deeper))
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            [
                ("", 1, false),
                ("misc/", 2, false),
                ("users/*/", 25, false),
                ("users/*/avatars/", 25, false),
                ("deep/1/2/3/4/5/", 0, true),
            ]
        );
        assert_eq!(index.shapes("other"), (Vec::new(), false));
    }

    #[test]
    fn a_change_the_walk_has_not_reached_is_left_to_it() {
        let mut index = FolderIndex::walking();
        let file = Some(Shape {
            size: 1,
            marker: false,
        });
        index.observe("b\0m.txt", ("b", "m.txt"), None, file, (1, 1));
        assert_eq!(index.stats("b", ""), None, "ahead of the walk");
        index.progress = Progress::Walking(Some("b\0m".to_owned()));
        index.observe("b\0a.txt", ("b", "a.txt"), None, file, (2, 2));
        index.observe("b\0z.txt", ("b", "z.txt"), None, file, (3, 3));
        assert_eq!(index.stats("b", "").expect("root").objects, 1);
    }
}
