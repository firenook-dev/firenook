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

use crate::{StorageData, StoredObject, object_key};

/// The highest Unicode scalar. A name that continues a group with any other
/// character sorts before the group followed by this one, so seeking past
/// `bucket\0<group>` + this character skips the whole group but for names
/// that themselves continue with it (legal, never seen), which the walk
/// still steps over one by one.
const LAST_SCALAR: char = '\u{10FFFF}';

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
    /// The key of the group just emitted (`bucket\0<group>`), while keys
    /// continuing it with [`LAST_SCALAR`] may remain after the seek.
    group: Option<String>,
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
            if let Some(group) = &self.group {
                if key.starts_with(group.as_str()) {
                    continue;
                }
                self.group = None;
            }
            // The key is `bucket\0name`; slicing it keeps the borrow on the
            // map rather than on this walk.
            let name = &key[self.bucket_len + 1..];
            let Some(end) = group_end(name, self.prefix_len, self.delimiter) else {
                return Some(LevelEntry::Item(object));
            };
            let group = &name[..end];
            let group_key = &key[..self.bucket_len + 1 + end];
            let mut seek = String::with_capacity(group_key.len() + LAST_SCALAR.len_utf8());
            seek.push_str(group_key);
            seek.push(LAST_SCALAR);
            self.range = self
                .objects
                .range::<str, _>((Bound::Excluded(seek.as_str()), Bound::Unbounded));
            self.group = Some(group_key.to_owned());
            return Some(LevelEntry::Group(group));
        }
    }
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
pub(crate) fn list_objects<'a>(
    data: &'a StorageData,
    bucket: &str,
    prefix: &str,
    delimiter: Option<&'a str>,
    page_token: Option<&str>,
    maximum: usize,
) -> ObjectListPage<'a> {
    let objects = &data.objects;
    let prefixes = LevelWalk::new(objects, bucket, prefix, delimiter, None)
        .filter_map(|entry| match entry {
            LevelEntry::Group(group) => Some(group.to_owned()),
            LevelEntry::Item(_) => None,
        })
        .collect();
    // A token resumes only when it names a direct item of this level; any
    // other value starts from the first item, as the official emulator does.
    let start = page_token.filter(|token| {
        token.starts_with(prefix)
            && objects
                .get(&object_key(bucket, token))
                .is_some_and(|object| object.bucket == bucket)
            && group_end(token, prefix.len(), delimiter).is_none()
    });
    let mut items = Vec::with_capacity(maximum.min(1_000));
    let mut next_page_token = None;
    for entry in LevelWalk::new(objects, bucket, prefix, delimiter, start) {
        let LevelEntry::Item(object) = entry else {
            continue;
        };
        if items.len() == maximum {
            next_page_token = Some(object.name.clone());
            break;
        }
        items.push(object);
    }
    ObjectListPage {
        items,
        prefixes,
        next_page_token,
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
