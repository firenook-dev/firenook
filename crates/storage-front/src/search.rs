//! ⌘K over Storage: objects by name across buckets, and folders from the
//! folder index when it is built.
//!
//! An exact name is one lookup per bucket. A substring walks the object map
//! in chunks under short holds of the lock, so the app's writes interleave,
//! and stops at the limit, at its own deadline or when the console cancels
//! it; a search that stopped early says so. Folders come from the folder
//! index only if it is already built: a search never starts its walk.

use std::ops::Bound;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::filter::contains_folded;
use crate::listing::{bucket_names, is_marker};
use crate::{StorageState, known_buckets, lock, object_key};

/// Objects one hold of the lock looks at.
const CHUNK: usize = 10_000;
/// How long a search may walk.
const DEADLINE: Duration = Duration::from_millis(45);

/// What a hit is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchKind {
    Object,
    Folder,
}

/// One thing a search found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchFound {
    pub kind: SearchKind,
    pub bucket: String,
    /// The object's full name, or the folder's prefix (ending in `/`).
    pub key: String,
    /// An object's size, or a folder's bytes.
    pub bytes: u64,
    /// An object's contentType.
    pub content_type: Option<String>,
    /// A folder's files.
    pub objects: u64,
    /// 0 for an exact name, 1 when the last segment starts with the text, 2
    /// for any other substring.
    pub rank: u8,
}

/// What a search found, and whether it stopped early.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SearchOutcome {
    pub hits: Vec<SearchFound>,
    pub partial: bool,
}

/// The last segment of a name or prefix (without a trailing slash).
fn last_segment(key: &str) -> &str {
    let trimmed = key.strip_suffix('/').unwrap_or(key);
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

/// How well a key's name matches: 1 when its last segment starts with the
/// text (lowercased), else 2.
fn rank_of(key: &str, needle: &str) -> u8 {
    if last_segment(key).to_lowercase().starts_with(needle) {
        1
    } else {
        2
    }
}

/// At most `limit` hits for `text` (two characters or more), best first.
pub(crate) fn search(
    state: &StorageState,
    text: &str,
    limit: usize,
    cancel: &AtomicBool,
) -> SearchOutcome {
    let text = text.trim();
    if text.chars().count() < 2 || limit == 0 {
        return SearchOutcome::default();
    }
    let started = Instant::now();
    let needle = text.to_lowercase();
    let mut outcome = SearchOutcome::default();
    exact(state, text, &mut outcome.hits);
    folders(state, &needle, limit, &mut outcome.hits);
    outcome.partial = substrings(
        state,
        text,
        &needle,
        limit,
        (started, cancel),
        &mut outcome.hits,
    );
    outcome.hits.sort_by(|left, right| {
        left.rank
            .cmp(&right.rank)
            .then_with(|| left.key.cmp(&right.key))
    });
    outcome.hits.truncate(limit);
    outcome
}

/// An object named exactly `text`, in every bucket the console knows.
fn exact(state: &StorageState, text: &str, hits: &mut Vec<SearchFound>) {
    let data = lock(&state.inner);
    let mut buckets = known_buckets(state, &data);
    buckets.insert(state.default_bucket());
    for bucket in buckets {
        if let Some(object) = data.objects.get(&object_key(&bucket, text))
            && !is_marker(object)
        {
            hits.push(SearchFound {
                kind: SearchKind::Object,
                bucket,
                key: object.name.clone(),
                bytes: object.size,
                content_type: object.content_type.clone(),
                objects: 0,
                rank: 0,
            });
        }
    }
}

/// Folders whose name contains the text, from a built index only.
fn folders(state: &StorageState, needle: &str, limit: usize, hits: &mut Vec<SearchFound>) {
    let data = lock(&state.inner);
    let Some(index) = data.folders.as_ref().filter(|index| index.is_built()) else {
        return;
    };
    let mut buckets = bucket_names(&data.objects).collect::<Vec<_>>();
    buckets.sort_unstable();
    for bucket in buckets {
        for (parent, segment, stats) in index.folders(bucket) {
            if contains_folded(segment.trim_end_matches('/'), needle) {
                let prefix = format!("{parent}{segment}");
                hits.push(SearchFound {
                    kind: SearchKind::Folder,
                    bucket: bucket.to_owned(),
                    rank: rank_of(&prefix, needle),
                    key: prefix,
                    bytes: stats.bytes,
                    content_type: None,
                    objects: stats.objects,
                });
                if hits.len() >= limit * 2 {
                    return;
                }
            }
        }
    }
}

/// Objects whose name contains the text, chunk by chunk, until `limit`
/// were found, the walk ends, the deadline passes or the console cancels.
/// Whether it stopped early.
fn substrings(
    state: &StorageState,
    text: &str,
    needle: &str,
    limit: usize,
    (started, cancel): (Instant, &AtomicBool),
    hits: &mut Vec<SearchFound>,
) -> bool {
    let mut after: Option<String> = None;
    let mut found = 0;
    loop {
        if cancel.load(Ordering::Acquire) || started.elapsed() >= DEADLINE {
            return true;
        }
        let data = lock(&state.inner);
        let range = match &after {
            Some(key) => data
                .objects
                .range::<str, _>((Bound::Excluded(key.as_str()), Bound::Unbounded)),
            None => data.objects.range::<str, _>(..),
        };
        let mut steps = 0;
        let mut last = None;
        for (key, object) in range {
            steps += 1;
            last = Some(key);
            if !is_marker(object) && object.name != text && contains_folded(&object.name, needle) {
                hits.push(SearchFound {
                    kind: SearchKind::Object,
                    bucket: object.bucket.clone(),
                    key: object.name.clone(),
                    bytes: object.size,
                    content_type: object.content_type.clone(),
                    objects: 0,
                    rank: rank_of(&object.name, needle),
                });
                found += 1;
                if found >= limit {
                    // More may follow, but the console asked for no more.
                    return false;
                }
            }
            if steps >= CHUNK {
                break;
            }
        }
        match last {
            Some(last) if steps >= CHUNK => after = Some(last.clone()),
            _ => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_segments() {
        assert_eq!(last_segment("users/u1/avatar.png"), "avatar.png");
        assert_eq!(last_segment("users/u1/"), "u1");
        assert_eq!(last_segment("lead.png"), "lead.png");
    }
}
