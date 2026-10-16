//! Listing a folder by seeking past every subtree.
//!
//! Objects live in one map keyed `bucket\0name`, so everything below a
//! prefix is one contiguous run of keys. A delimiter listing needs every
//! direct item and each group (what a console calls a subfolder) once.
//! Rather than step through every object of a group, the walk jumps to the
//! first key after the whole group, so listing a folder costs
//! O((groups + direct items) · log n) instead of O(objects below it). That
//! is what lets `listAll()` of a folder holding a million objects page
//! through without scanning them all under the service's lock.

use std::collections::BTreeMap;
use std::collections::btree_map;
use std::ops::Bound;

use crate::folder_index::FolderStats;
use crate::{StorageData, StoredObject, object_key};

/// The highest Unicode scalar. A name that continues a group with any other
/// character sorts before the group followed by this one, so seeking past
/// `bucket\0<group>` + this character skips the whole group but for names
/// that themselves continue with it (legal, never seen), which the walk
/// still steps over one by one.
pub(crate) const LAST_SCALAR: char = '\u{10FFFF}';

/// One entry of a folder level, in key order.
#[derive(Clone, Copy, Debug)]
pub(crate) enum LevelEntry<'a> {
    /// Every object whose name continues past the prefix with the
    /// delimiter, named up to and including its first occurrence.
    Group(&'a str),
    /// An object directly at the level: no delimiter after the prefix.
    Item(&'a StoredObject),
}

/// Walks one level of a bucket forwards: direct items and groups, each group
/// once, seeking past its objects.
pub(crate) struct LevelWalk<'a> {
    objects: &'a BTreeMap<String, StoredObject>,
    range: btree_map::Range<'a, String, StoredObject>,
    /// `bucket\0prefix`: the walk ends at the first key without it.
    scope: String,
    bucket_len: usize,
    prefix_len: usize,
    delimiter: Option<&'a str>,
    /// The key of the last group emitted (`bucket\0<group>`), while keys
    /// continuing it with [`LAST_SCALAR`] may remain after the seek. It is
    /// never reset: a group's keys are contiguous, so once a key past them
    /// is seen no later key starts with it, and keeping the buffer saves an
    /// allocation per group.
    group: Option<String>,
    /// The seek key, reused from group to group.
    seek: String,
}

impl<'a> LevelWalk<'a> {
    /// A walk of the level `prefix` (taken byte for byte: empty segments are
    /// kept) of `bucket`, from its first key or, with `from`, from that
    /// object name inclusive. A `None` delimiter makes every object below
    /// the prefix a direct item.
    pub(crate) fn new(
        objects: &'a BTreeMap<String, StoredObject>,
        bucket: &str,
        prefix: &str,
        delimiter: Option<&'a str>,
        from: Option<&str>,
    ) -> Self {
        let scope = object_key(bucket, prefix);
        let start = from.map_or_else(|| scope.clone(), |name| object_key(bucket, name));
        Self {
            objects,
            range: objects.range::<str, _>((Bound::Included(start.as_str()), Bound::Unbounded)),
            bucket_len: bucket.len(),
            prefix_len: prefix.len(),
            scope,
            delimiter,
            group: None,
            seek: String::new(),
        }
    }
}

impl<'a> LevelWalk<'a> {
    /// A walk of the level `prefix` over `range` (keys from where the walk
    /// resumes), skipping the rest of `group` (a group key already
    /// emitted) first.
    pub(crate) fn over(
        objects: &'a BTreeMap<String, StoredObject>,
        range: btree_map::Range<'a, String, StoredObject>,
        bucket: &str,
        prefix: &str,
        delimiter: Option<&'a str>,
        group: Option<String>,
    ) -> Self {
        Self {
            objects,
            range,
            scope: object_key(bucket, prefix),
            bucket_len: bucket.len(),
            prefix_len: prefix.len(),
            delimiter,
            group,
            seek: String::new(),
        }
    }
}

/// The end of the group `name` belongs to below a prefix of `prefix_len`
/// bytes (the byte after the first delimiter past the prefix), or `None` for
/// a direct item.
fn group_end(name: &str, prefix_len: usize, delimiter: Option<&str>) -> Option<usize> {
    let delimiter = delimiter?;
    name.get(prefix_len..)?
        .find(delimiter)
        .map(|index| prefix_len + index + delimiter.len())
}

impl<'a> Iterator for LevelWalk<'a> {
    type Item = LevelEntry<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            let (key, object) = self.range.next()?;
            if !key.starts_with(self.scope.as_str()) {
                // Keys are ordered, so nothing later is under the prefix.
                self.range = btree_map::Range::default();
                return None;
            }
            if let Some(group) = &self.group
                && key.starts_with(group.as_str())
            {
                continue;
            }
            // The key is `bucket\0name`; slicing it keeps the borrow on the
            // map rather than on this walk.
            let name = &key[self.bucket_len + 1..];
            let Some(end) = group_end(name, self.prefix_len, self.delimiter) else {
                return Some(LevelEntry::Item(object));
            };
            let group = &name[..end];
            let group_key = &key[..self.bucket_len + 1 + end];
            self.seek.clear();
            self.seek.push_str(group_key);
            self.seek.push(LAST_SCALAR);
            self.range = self
                .objects
                .range::<str, _>((Bound::Excluded(self.seek.as_str()), Bound::Unbounded));
            match &mut self.group {
                Some(last) => {
                    last.clear();
                    last.push_str(group_key);
                }
                None => self.group = Some(group_key.to_owned()),
            }
            return Some(LevelEntry::Group(group));
        }
    }
}

/// Every bucket holding objects, in name order, one seek per bucket rather
/// than a step per object.
pub(crate) fn bucket_names(objects: &BTreeMap<String, StoredObject>) -> impl Iterator<Item = &str> {
    let mut range = objects.range::<str, _>(..);
    std::iter::from_fn(move || {
        let (key, _) = range.next()?;
        let bucket = &key[..key.find('\0')?];
        let mut seek = String::with_capacity(bucket.len() + 1 + LAST_SCALAR.len_utf8());
        seek.push_str(bucket);
        seek.push('\0');
        seek.push(LAST_SCALAR);
        // Names that themselves start with the highest scalar are stepped
        // over one by one; the next key of another bucket ends the skip.
        range = objects.range::<str, _>((Bound::Excluded(seek.as_str()), Bound::Unbounded));
        let scope = &seek[..=bucket.len()];
        let mut ahead = range.clone();
        while let Some((next, _)) = ahead.next() {
            if !next.starts_with(scope) {
                break;
            }
            range = ahead.clone();
        }
        Some(bucket)
    })
}

/// One page of the protocol's list routes.
pub(crate) struct ObjectListPage<'a> {
    pub(crate) items: Vec<&'a StoredObject>,
    pub(crate) prefixes: Vec<String>,
    pub(crate) next_page_token: Option<String>,
}

/// The official list shape (`files.js` in the official emulator): every
/// prefix of the level on every page, sorted; the direct items from
/// `page_token` when it names one (from the first item otherwise); and the
/// name of the item past `maximum` as the next token.
///
/// One walk of the level gathers both: groups are seeked past, so a level
/// of 50,000 folders costs 50,000 seeks once rather than twice. Without a
/// delimiter there are no groups, so the walk starts at the token and stops
/// at the item past the page.
pub(crate) fn list_objects<'a>(
    data: &'a StorageData,
    bucket: &str,
    prefix: &str,
    delimiter: Option<&'a str>,
    page_token: Option<&str>,
    maximum: usize,
) -> ObjectListPage<'a> {
    let objects = &data.objects;
    // A token resumes only when it names a direct item of this level; any
    // other value starts from the first item, as the official emulator does.
    let start = page_token.filter(|token| {
        token.starts_with(prefix)
            && objects
                .get(&object_key(bucket, token))
                .is_some_and(|object| object.bucket == bucket)
            && group_end(token, prefix.len(), delimiter).is_none()
    });
    let walk_from = if delimiter.is_none() { start } else { None };
    let mut prefixes = Vec::new();
    let mut items = Vec::with_capacity(maximum.min(1_000));
    let mut next_page_token = None;
    for entry in LevelWalk::new(objects, bucket, prefix, delimiter, walk_from) {
        match entry {
            LevelEntry::Group(group) => prefixes.push(group.to_owned()),
            LevelEntry::Item(object) => {
                if next_page_token.is_some()
                    || start.is_some_and(|start| object.name.as_str() < start)
                {
                    continue;
                }
                if items.len() == maximum {
                    next_page_token = Some(object.name.clone());
                    if delimiter.is_none() {
                        break;
                    }
                    continue;
                }
                items.push(object);
            }
        }
    }
    ObjectListPage {
        items,
        prefixes,
        next_page_token,
    }
}

// ---------------------------------------------------------------------------
// The console's listing: one level (folders first, then files) or every file
// below a folder, paged with cursors that go both ways.

/// Which entries a console listing wants.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ListKind {
    /// Folders, then files.
    #[default]
    All,
    /// Folders only (the folder tree, path completion).
    Folders,
    /// Files only.
    Files,
}

impl ListKind {
    const fn folders(self) -> bool {
        matches!(self, Self::All | Self::Folders)
    }

    const fn files(self) -> bool {
        matches!(self, Self::All | Self::Files)
    }
}

/// The column a console listing is sorted by.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum SortColumn {
    #[default]
    Name,
    /// Folder bytes, file size.
    Size,
    /// A folder's last change below it, a file's last update.
    Updated,
    /// Folders by name, files by contentType then name.
    Type,
}

/// The order of a console listing: folders always come first, each group
/// sorted by the column, ties by name.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct ListOrder {
    pub column: SortColumn,
    pub descending: bool,
}

/// Where a page of a console listing continues: opaque to the console,
/// which encodes it as its cursor. Fast-path cursors are ordered the way
/// the listing is, so a batch read can say which loaded page a row falls
/// in.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[serde(tag = "t")]
pub enum ListCursor {
    /// A level by name: its folders (`p` = `f`), then its files (`o`); `a`
    /// is the folder's segment or the file's name below the level.
    #[serde(rename = "l")]
    Level { p: Phase, a: String },
    /// Every file below a folder, by name: `n` is the full object name.
    #[serde(rename = "f")]
    Flat { n: String },
    /// A sorted or filtered view: view `v`, the entry after offset `i`,
    /// whose folder flag, sort key and name below the folder are `d`, `k`
    /// and `n`, so the page resumes in order if the view was rebuilt.
    #[serde(rename = "v")]
    View {
        v: u64,
        i: u64,
        d: bool,
        k: u64,
        n: String,
    },
}

/// The two phases of a level, folders first.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
pub enum Phase {
    #[serde(rename = "f")]
    Folders,
    #[serde(rename = "o")]
    Files,
}

/// One entry of a console listing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ListEntry {
    Folder(FolderEntry),
    File(FileEntry),
}

/// A folder row: its full prefix and, once the folder index is built, its
/// figures.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FolderEntry {
    /// The full prefix, ending in `/`.
    pub prefix: String,
    pub stats: Option<FolderStats>,
}

/// A file row: what a list shows, never tokens, hashes or metadata values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileEntry {
    pub name: String,
    pub size: u64,
    pub content_type: Option<String>,
    pub content_encoding: Option<String>,
    pub updated: String,
    pub time_created: String,
    pub generation: u64,
    pub tokens: u32,
    /// The first four custom metadata keys, in key order.
    pub metadata_keys: Vec<String>,
    pub metadata_count: u32,
}

impl FileEntry {
    pub(crate) fn of(object: &StoredObject) -> Self {
        Self {
            name: object.name.clone(),
            size: object.size,
            content_type: object.content_type.clone(),
            content_encoding: object.content_encoding.clone(),
            updated: object.updated.clone(),
            time_created: object.time_created.clone(),
            generation: object.generation,
            tokens: u32::try_from(object.download_tokens.len()).unwrap_or(u32::MAX),
            metadata_keys: object.custom_metadata.keys().take(4).cloned().collect(),
            metadata_count: u32::try_from(object.custom_metadata.len()).unwrap_or(u32::MAX),
        }
    }
}

/// A zero-byte object named like a folder: a marker a console made, which
/// is the folder and never a file.
pub(crate) fn is_marker(object: &StoredObject) -> bool {
    object.size == 0 && object.name.ends_with('/')
}

/// The smallest key after every key that starts with `scope` (which ends
/// in `\0` or `/`), so a range can end exactly where the scope does.
pub(crate) fn scope_end(scope: &str) -> String {
    let mut end = scope.to_owned();
    match end.pop() {
        Some(last) => end.push(char::from_u32(u32::from(last) + 1).unwrap_or(LAST_SCALAR)),
        None => end.push(LAST_SCALAR),
    }
    end
}

/// One step of a level walk in either direction, before it becomes a row.
enum Walked<'a> {
    Folder {
        /// The segment below the level (`b/`).
        segment: std::borrow::Cow<'a, str>,
        stats: Option<FolderStats>,
    },
    File(&'a StoredObject),
}

/// A level's direct files from `start` on, in name order, skipping groups
/// (seek-skip) and the level's own marker.
fn files_forward<'a>(
    objects: &'a BTreeMap<String, StoredObject>,
    bucket: &str,
    prefix: &'a str,
    start: Bound<&str>,
) -> impl Iterator<Item = &'a StoredObject> + use<'a> {
    let scope = object_key(bucket, prefix);
    let range = match start {
        Bound::Included(key) | Bound::Excluded(key) if key < scope.as_str() => {
            objects.range::<str, _>((Bound::Included(scope.as_str()), Bound::Unbounded))
        }
        Bound::Included(key) => objects.range::<str, _>((Bound::Included(key), Bound::Unbounded)),
        Bound::Excluded(key) => objects.range::<str, _>((Bound::Excluded(key), Bound::Unbounded)),
        Bound::Unbounded => {
            objects.range::<str, _>((Bound::Included(scope.as_str()), Bound::Unbounded))
        }
    };
    let walk = LevelWalk {
        objects,
        range,
        bucket_len: bucket.len(),
        prefix_len: prefix.len(),
        scope,
        delimiter: Some("/"),
        group: None,
        seek: String::new(),
    };
    walk.filter_map(move |entry| match entry {
        LevelEntry::Item(object) if !(object.name == prefix && is_marker(object)) => Some(object),
        LevelEntry::Item(_) | LevelEntry::Group(_) => None,
    })
}

/// A level's direct files before `end` (exclusive; the end of the level
/// when `None`), last first, skipping groups and the level's own marker.
fn files_backward<'a>(
    objects: &'a BTreeMap<String, StoredObject>,
    bucket: &str,
    prefix: &'a str,
    end: Option<String>,
) -> impl Iterator<Item = &'a StoredObject> + 'a {
    let scope = object_key(bucket, prefix);
    let end = end.unwrap_or_else(|| scope_end(&scope));
    let range = objects.range::<str, _>((
        Bound::Included(scope.as_str()),
        Bound::Excluded(end.as_str()),
    ));
    let bucket_len = bucket.len();
    LevelWalkBack {
        objects,
        range,
        scope,
        bucket_len,
        prefix_len: prefix.len(),
    }
    .filter_map(move |entry| match entry {
        LevelEntry::Item(object) if !(object.name == prefix && is_marker(object)) => Some(object),
        LevelEntry::Item(_) | LevelEntry::Group(_) => None,
    })
}

/// Walks one level backwards: direct items and groups, last first, each
/// group once, seeking before its objects.
struct LevelWalkBack<'a> {
    objects: &'a BTreeMap<String, StoredObject>,
    range: btree_map::Range<'a, String, StoredObject>,
    scope: String,
    bucket_len: usize,
    prefix_len: usize,
}

impl<'a> Iterator for LevelWalkBack<'a> {
    type Item = LevelEntry<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        let (key, object) = self.range.next_back()?;
        if !key.starts_with(self.scope.as_str()) {
            self.range = btree_map::Range::default();
            return None;
        }
        let name = &key[self.bucket_len + 1..];
        let Some(end) = group_end(name, self.prefix_len, Some("/")) else {
            return Some(LevelEntry::Item(object));
        };
        // Every key of the group sorts at or after the group's own name, so
        // continuing before it skips the whole group.
        let group_key = &key[..self.bucket_len + 1 + end];
        self.range = self.objects.range::<str, _>((
            Bound::Included(self.scope.as_str()),
            Bound::Excluded(group_key),
        ));
        Some(LevelEntry::Group(&name[..end]))
    }
}

/// A level's subfolders after `after` (a segment), in name order: from the
/// folder index when it is built, else by seeking from group to group.
fn folders_forward<'a>(
    data: &'a StorageData,
    bucket: &'a str,
    prefix: &'a str,
    after: Option<&'a str>,
) -> Box<dyn Iterator<Item = Walked<'a>> + 'a> {
    if let Some(index) = data.folders.as_ref().filter(|index| index.is_built()) {
        let Some(children) = index.children(bucket, prefix) else {
            return Box::new(std::iter::empty());
        };
        let range = match after {
            Some(after) => children.range::<str, _>((Bound::Excluded(after), Bound::Unbounded)),
            None => children.range::<str, _>(..),
        };
        return Box::new(range.map(|(segment, stats)| Walked::Folder {
            segment: std::borrow::Cow::Borrowed(segment.as_str()),
            stats: Some(*stats),
        }));
    }
    let start = after.map(|segment| {
        let mut seek = object_key(bucket, prefix);
        seek.push_str(segment);
        seek.push(LAST_SCALAR);
        seek
    });
    let scope = object_key(bucket, prefix);
    let range = match &start {
        Some(seek) => data
            .objects
            .range::<str, _>((Bound::Excluded(seek.as_str()), Bound::Unbounded)),
        None => data
            .objects
            .range::<str, _>((Bound::Included(scope.as_str()), Bound::Unbounded)),
    };
    let walk = LevelWalk {
        objects: &data.objects,
        range,
        bucket_len: bucket.len(),
        prefix_len: prefix.len(),
        scope,
        delimiter: Some("/"),
        group: start.map(|mut seek| {
            seek.pop();
            seek
        }),
        seek: String::new(),
    };
    Box::new(walk.filter_map(move |entry| match entry {
        LevelEntry::Group(group) => Some(Walked::Folder {
            segment: std::borrow::Cow::Borrowed(&group[prefix.len()..]),
            stats: None,
        }),
        LevelEntry::Item(_) => None,
    }))
}

/// A level's subfolders before `before` (a segment; the end when `None`),
/// last first.
fn folders_backward<'a>(
    data: &'a StorageData,
    bucket: &'a str,
    prefix: &'a str,
    before: Option<&'a str>,
) -> Box<dyn Iterator<Item = Walked<'a>> + 'a> {
    if let Some(index) = data.folders.as_ref().filter(|index| index.is_built()) {
        let Some(children) = index.children(bucket, prefix) else {
            return Box::new(std::iter::empty());
        };
        let range = match before {
            Some(before) => children.range::<str, _>((Bound::Unbounded, Bound::Excluded(before))),
            None => children.range::<str, _>(..),
        };
        return Box::new(range.rev().map(|(segment, stats)| Walked::Folder {
            segment: std::borrow::Cow::Borrowed(segment.as_str()),
            stats: Some(*stats),
        }));
    }
    let scope = object_key(bucket, prefix);
    let end = before.map_or_else(
        || scope_end(&scope),
        |segment| {
            let mut key = scope.clone();
            key.push_str(segment);
            key
        },
    );
    let walk = LevelWalkBack {
        objects: &data.objects,
        range: data.objects.range::<str, _>((
            Bound::Included(scope.as_str()),
            Bound::Excluded(end.as_str()),
        )),
        scope,
        bucket_len: bucket.len(),
        prefix_len: prefix.len(),
    };
    Box::new(walk.filter_map(move |entry| match entry {
        LevelEntry::Group(group) => Some(Walked::Folder {
            segment: std::borrow::Cow::Owned(group[prefix.len()..].to_owned()),
            stats: None,
        }),
        LevelEntry::Item(_) => None,
    }))
}

/// Every file below `prefix` from `start` on, by name, markers left out.
fn flat_forward<'a>(
    objects: &'a BTreeMap<String, StoredObject>,
    bucket: &str,
    prefix: &str,
    after: Option<&str>,
) -> impl Iterator<Item = &'a StoredObject> + 'a {
    let scope = object_key(bucket, prefix);
    let range = match after {
        Some(name) => {
            let key = object_key(bucket, name);
            if key < scope {
                objects.range::<str, _>((Bound::Included(scope.as_str()), Bound::Unbounded))
            } else {
                objects.range::<str, _>((Bound::Excluded(key.as_str()), Bound::Unbounded))
            }
        }
        None => objects.range::<str, _>((Bound::Included(scope.as_str()), Bound::Unbounded)),
    };
    range
        .take_while(move |(key, _)| key.starts_with(scope.as_str()))
        .map(|(_, object)| object)
        .filter(|object| !is_marker(object))
}

/// Every file below `prefix` before `before` (a full name; the end when
/// `None`), last first, markers left out.
fn flat_backward<'a>(
    objects: &'a BTreeMap<String, StoredObject>,
    bucket: &str,
    prefix: &str,
    before: Option<&str>,
) -> impl Iterator<Item = &'a StoredObject> + 'a {
    let scope = object_key(bucket, prefix);
    let end = before.map_or_else(|| scope_end(&scope), |name| object_key(bucket, name));
    objects
        .range::<str, _>((
            Bound::Included(scope.as_str()),
            Bound::Excluded(end.as_str()),
        ))
        .rev()
        .map(|(_, object)| object)
        .filter(|object| !is_marker(object))
}

/// What a fast page reads: a level or everything below a folder, by name.
#[derive(Clone, Copy, Debug)]
pub(crate) struct FastScope<'a> {
    pub(crate) bucket: &'a str,
    pub(crate) prefix: &'a str,
    pub(crate) flat: bool,
    pub(crate) kind: ListKind,
}

impl FastScope<'_> {
    fn folder_row(&self, segment: &str, stats: Option<FolderStats>) -> (ListEntry, ListCursor) {
        (
            ListEntry::Folder(FolderEntry {
                prefix: format!("{}{segment}", self.prefix),
                stats,
            }),
            ListCursor::Level {
                p: Phase::Folders,
                a: segment.to_owned(),
            },
        )
    }

    fn file_row(&self, object: &StoredObject) -> (ListEntry, ListCursor) {
        let cursor = if self.flat {
            ListCursor::Flat {
                n: object.name.clone(),
            }
        } else {
            ListCursor::Level {
                p: Phase::Files,
                a: object.name[self.prefix.len()..].to_owned(),
            }
        };
        (ListEntry::File(FileEntry::of(object)), cursor)
    }

    fn walked_row(&self, walked: Walked<'_>) -> (ListEntry, ListCursor) {
        match walked {
            Walked::Folder { segment, stats } => self.folder_row(&segment, stats),
            Walked::File(object) => self.file_row(object),
        }
    }

    /// Entries after `after` (from the start when `None`), in order.
    fn forward<'a>(
        &'a self,
        data: &'a StorageData,
        after: Option<&'a ListCursor>,
    ) -> Box<dyn Iterator<Item = Walked<'a>> + 'a> {
        let objects = &data.objects;
        if self.flat {
            let after = match after {
                Some(ListCursor::Flat { n }) => Some(n.as_str()),
                _ => None,
            };
            return Box::new(
                flat_forward(objects, self.bucket, self.prefix, after)
                    .filter(|_| self.kind.files())
                    .map(Walked::File),
            );
        }
        let files_from = |name: Option<&str>| {
            let start = name.map(|name| object_key(self.bucket, &format!("{}{name}", self.prefix)));
            files_forward(
                objects,
                self.bucket,
                self.prefix,
                start.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            )
            .map(Walked::File)
        };
        match after {
            Some(ListCursor::Level { p: Phase::Files, a }) => {
                if self.kind.files() {
                    Box::new(files_from(Some(a.as_str())))
                } else {
                    Box::new(std::iter::empty())
                }
            }
            Some(ListCursor::Level {
                p: Phase::Folders,
                a,
            }) => {
                let folders = folders_forward(data, self.bucket, self.prefix, Some(a.as_str()))
                    .filter(|_| self.kind.folders());
                if self.kind.files() {
                    Box::new(folders.chain(files_from(None)))
                } else {
                    Box::new(folders)
                }
            }
            _ => {
                let folders = folders_forward(data, self.bucket, self.prefix, None)
                    .filter(|_| self.kind.folders());
                if self.kind.files() {
                    Box::new(folders.chain(files_from(None)))
                } else {
                    Box::new(folders)
                }
            }
        }
    }

    /// Entries before `before` (from the end when `None`), last first.
    fn backward<'a>(
        &'a self,
        data: &'a StorageData,
        before: Option<&'a ListCursor>,
    ) -> Box<dyn Iterator<Item = Walked<'a>> + 'a> {
        let objects = &data.objects;
        if self.flat {
            let before = match before {
                Some(ListCursor::Flat { n }) => Some(n.as_str()),
                _ => None,
            };
            return Box::new(
                flat_backward(objects, self.bucket, self.prefix, before)
                    .filter(|_| self.kind.files())
                    .map(Walked::File),
            );
        }
        let folders_from = |segment: Option<&'a str>| -> Box<dyn Iterator<Item = Walked<'a>> + 'a> {
            if self.kind.folders() {
                folders_backward(data, self.bucket, self.prefix, segment)
            } else {
                Box::new(std::iter::empty())
            }
        };
        match before {
            Some(ListCursor::Level {
                p: Phase::Folders,
                a,
            }) => folders_from(Some(a.as_str())),
            Some(ListCursor::Level { p: Phase::Files, a }) => {
                let end = object_key(self.bucket, &format!("{}{a}", self.prefix));
                let files = files_backward(objects, self.bucket, self.prefix, Some(end))
                    .filter(|_| self.kind.files())
                    .map(Walked::File);
                Box::new(files.chain(folders_from(None)))
            }
            _ => {
                let files = files_backward(objects, self.bucket, self.prefix, None)
                    .filter(|_| self.kind.files())
                    .map(Walked::File);
                Box::new(files.chain(folders_from(None)))
            }
        }
    }
}

/// One page of a fast-path listing.
pub(crate) struct FastPage {
    pub(crate) entries: Vec<(ListEntry, ListCursor)>,
    pub(crate) more_after: bool,
    pub(crate) more_before: bool,
}

/// A page by name, read straight from the object map (and the folder
/// index's child map for folders): at most `limit` entries after `after`,
/// or before `before`, or from the start. O((page + groups skipped) · log n)
/// under the caller's one hold of the lock.
pub(crate) fn fast_page(
    data: &StorageData,
    scope: &FastScope<'_>,
    after: Option<&ListCursor>,
    before: Option<&ListCursor>,
    limit: usize,
) -> FastPage {
    let limit = limit.max(1);
    if let Some(before) = before {
        let mut walked = scope
            .backward(data, Some(before))
            .take(limit + 1)
            .map(|walked| scope.walked_row(walked))
            .collect::<Vec<_>>();
        let more_before = walked.len() > limit;
        walked.truncate(limit);
        walked.reverse();
        let more_after = walked
            .last()
            .is_some_and(|(_, cursor)| scope.forward(data, Some(cursor)).next().is_some());
        return FastPage {
            entries: walked,
            more_after,
            more_before,
        };
    }
    let mut walked = scope
        .forward(data, after)
        .take(limit + 1)
        .map(|walked| scope.walked_row(walked))
        .collect::<Vec<_>>();
    let more_after = walked.len() > limit;
    walked.truncate(limit);
    let more_before = walked
        .first()
        .is_some_and(|(_, cursor)| scope.backward(data, Some(cursor)).next().is_some());
    FastPage {
        entries: walked,
        more_after,
        more_before,
    }
}

/// The fast-path row a live event named, by its entry key (a file's full
/// name, or a folder's full prefix): `None` when it is gone or is not an
/// entry of this listing.
pub(crate) fn fast_row(
    data: &StorageData,
    scope: &FastScope<'_>,
    key: &str,
) -> Option<(ListEntry, ListCursor)> {
    let rest = key.strip_prefix(scope.prefix)?;
    if scope.flat {
        let object = data.objects.get(&object_key(scope.bucket, key))?;
        return (scope.kind.files() && !is_marker(object)).then(|| scope.file_row(object));
    }
    match rest.find('/') {
        Some(slash) if slash + 1 == rest.len() => {
            if !scope.kind.folders() {
                return None;
            }
            let stats = data
                .folders
                .as_ref()
                .filter(|index| index.is_built())
                .map(|index| index.stats(scope.bucket, key));
            match stats {
                Some(Some(stats)) => Some(scope.folder_row(rest, Some(stats))),
                Some(None) => None,
                None => {
                    let start = object_key(scope.bucket, key);
                    data.objects
                        .range::<str, _>((Bound::Included(start.as_str()), Bound::Unbounded))
                        .next()
                        .filter(|(next, _)| next.starts_with(start.as_str()))
                        .map(|_| scope.folder_row(rest, None))
                }
            }
        }
        Some(_) => None,
        None => {
            let object = data.objects.get(&object_key(scope.bucket, key))?;
            (scope.kind.files() && !(rest.is_empty() && is_marker(object)))
                .then(|| scope.file_row(object))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::listing_reference::list_objects_reference;

    /// `splitmix64`: a deterministic generator, so every failure names the
    /// seed that reproduces it.
    struct Generator(u64);

    impl Generator {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut value = self.0;
            value = (value ^ (value >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            value = (value ^ (value >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            value ^ (value >> 31)
        }

        fn below(&mut self, bound: usize) -> usize {
            usize::try_from(self.next() % u64::try_from(bound).expect("bound")).expect("index")
        }

        fn pick<'a, T>(&mut self, values: &'a [T]) -> &'a T {
            &values[self.below(values.len())]
        }
    }

    fn object(bucket: &str, name: &str) -> StoredObject {
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
            custom_metadata: BTreeMap::new(),
            time_created: String::new(),
            updated: String::new(),
            size: 0,
            md5_hash: String::new(),
            crc32c: 0,
            etag: String::new(),
            data_file: String::new(),
        }
    }

    fn insert(data: &mut StorageData, bucket: &str, name: &str) {
        data.objects
            .insert(object_key(bucket, name), object(bucket, name));
    }

    /// Segment material that exercises every delimiter the test uses, empty
    /// segments, non-ASCII text and the scalar the seek relies on.
    const PIECES: &[&str] = &["a", "b", "ab", "-", "x", "é", "z", "aab", "\u{10FFFF}"];

    fn random_name(generator: &mut Generator) -> String {
        let depth = 1 + generator.below(5);
        let mut segments = Vec::with_capacity(depth);
        for _ in 0..depth {
            let length = generator.below(4);
            let mut segment = String::new();
            for _ in 0..length {
                let piece = *generator.pick(PIECES);
                // The highest scalar is legal but rare; keep it rare here too.
                if piece == "\u{10FFFF}" && generator.below(8) != 0 {
                    segment.push('a');
                } else {
                    segment.push_str(piece);
                }
            }
            segments.push(segment);
        }
        segments.join("/")
    }

    fn random_prefix(generator: &mut Generator, names: &[String]) -> String {
        match generator.below(4) {
            0 => String::new(),
            1 => {
                // A real folder of some object, as an SDK lists it.
                let name = generator.pick(names);
                let cuts = name
                    .match_indices('/')
                    .map(|(index, _)| index + 1)
                    .collect::<Vec<_>>();
                if cuts.is_empty() {
                    String::new()
                } else {
                    name[..*generator.pick(&cuts)].to_owned()
                }
            }
            2 => {
                // Any character boundary of some object: GCS takes any prefix.
                let name = generator.pick(names);
                let cuts = name
                    .char_indices()
                    .map(|(index, _)| index)
                    .chain([name.len()])
                    .collect::<Vec<_>>();
                name[..*generator.pick(&cuts)].to_owned()
            }
            _ => random_name(generator),
        }
    }

    fn page_names(page: &ObjectListPage<'_>) -> Vec<String> {
        page.items
            .iter()
            .map(|object| object.name.clone())
            .collect()
    }

    fn assert_same(
        seed: u64,
        what: &str,
        actual: &ObjectListPage<'_>,
        expected: &ObjectListPage<'_>,
    ) {
        assert_eq!(
            page_names(actual),
            page_names(expected),
            "seed {seed} {what}: items"
        );
        assert_eq!(
            actual.prefixes, expected.prefixes,
            "seed {seed} {what}: prefixes"
        );
        assert_eq!(
            actual.next_page_token, expected.next_page_token,
            "seed {seed} {what}: next page token"
        );
    }

    #[test]
    fn seek_listing_equals_reference() {
        const BUCKET: &str = "seek.example.test";
        // Neighbours whose keys sort on either side of the bucket's.
        const NEIGHBOURS: &[&str] = &[
            "seek.example.tes",
            "seek.example.test2",
            "seek.example.tesu",
        ];
        let delimiters: &[Option<&str>] = &[Some("/"), Some("-"), Some("ab"), Some(""), None];
        for seed in 0..300_u64 {
            let mut generator = Generator(seed);
            // Mostly small trees, now and then one of thousands of objects.
            let shift = generator.below(5);
            let size = 1 + generator.below(5_000 >> shift);
            let mut data = StorageData::default();
            let mut names = Vec::with_capacity(size);
            for _ in 0..size {
                let name = random_name(&mut generator);
                insert(&mut data, BUCKET, &name);
                names.push(name);
            }
            for neighbour in NEIGHBOURS {
                let name = random_name(&mut generator);
                insert(&mut data, neighbour, &name);
            }
            for _ in 0..3 {
                let prefix = random_prefix(&mut generator, &names);
                let delimiter = *generator.pick(delimiters);
                let maximum = 1 + generator.below(50);
                let what = format!("prefix {prefix:?} delimiter {delimiter:?} max {maximum}");
                let mut token: Option<String> = None;
                let mut pages = 0;
                loop {
                    let actual =
                        list_objects(&data, BUCKET, &prefix, delimiter, token.as_deref(), maximum);
                    let expected = list_objects_reference(
                        &data,
                        BUCKET,
                        &prefix,
                        delimiter,
                        token.as_deref(),
                        maximum,
                    );
                    assert_same(seed, &format!("{what} page {pages}"), &actual, &expected);
                    pages += 1;
                    let Some(next) = actual.next_page_token else {
                        break;
                    };
                    token = Some(next);
                }
                // A token that is not a direct item of the level restarts the
                // listing in both, whatever it names.
                let stray = [
                    random_name(&mut generator),
                    generator.pick(&names).clone(),
                    format!("{prefix}\u{10FFFF}"),
                ];
                for token in &stray {
                    let actual =
                        list_objects(&data, BUCKET, &prefix, delimiter, Some(token), maximum);
                    let expected = list_objects_reference(
                        &data,
                        BUCKET,
                        &prefix,
                        delimiter,
                        Some(token),
                        maximum,
                    );
                    assert_same(seed, &format!("{what} token {token:?}"), &actual, &expected);
                }
            }
        }
    }

    #[test]
    fn a_page_of_a_huge_folder_seeks_past_its_subfolders() {
        const BUCKET: &str = "seek.example.test";
        let mut data = StorageData::default();
        for user in 0..2_000 {
            for file in 0..20 {
                insert(
                    &mut data,
                    BUCKET,
                    &format!("users/u{user:05}/f{file:02}.png"),
                );
            }
        }
        insert(&mut data, BUCKET, "users/readme.md");
        let page = list_objects(&data, BUCKET, "users/", Some("/"), None, 10);
        assert_eq!(page.prefixes.len(), 2_000);
        assert_eq!(page.prefixes[0], "users/u00000/");
        assert_eq!(page_names(&page), ["users/readme.md"]);
        assert_eq!(page.next_page_token, None);
        // Every group is emitted once, with one seek per group rather than a
        // step per object below it.
        let entries = LevelWalk::new(&data.objects, BUCKET, "users/", Some("/"), None).count();
        assert_eq!(entries, 2_001);
    }

    #[test]
    fn buckets_are_listed_once_each_by_seeking() {
        let mut data = StorageData::default();
        for (bucket, name) in [
            ("a", "x"),
            ("a", "y/z"),
            ("a", "\u{10FFFF}"),
            ("a", "\u{10FFFF}more"),
            ("a.b", "x"),
            ("b", "1"),
            ("b", "2"),
        ] {
            insert(&mut data, bucket, name);
        }
        assert_eq!(
            bucket_names(&data.objects).collect::<Vec<_>>(),
            ["a", "a.b", "b"]
        );
        assert_eq!(bucket_names(&StorageData::default().objects).count(), 0);
    }

    #[test]
    fn names_continuing_a_group_with_the_highest_scalar_stay_in_it() {
        const BUCKET: &str = "seek.example.test";
        let mut data = StorageData::default();
        for name in [
            "a/b",
            "a/\u{10FFFF}",
            "a/\u{10FFFF}x",
            "a\u{10FFFF}",
            "a\u{10FFFF}/c",
            "b",
        ] {
            insert(&mut data, BUCKET, name);
        }
        let walked = LevelWalk::new(&data.objects, BUCKET, "", Some("/"), None)
            .map(|entry| match entry {
                LevelEntry::Group(group) => format!("group {group}"),
                LevelEntry::Item(object) => format!("item {}", object.name),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            walked,
            [
                "group a/",
                "item a\u{10FFFF}",
                "group a\u{10FFFF}/",
                "item b"
            ]
        );
    }
}
