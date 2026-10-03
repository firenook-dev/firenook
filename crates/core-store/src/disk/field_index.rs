//! Equality index over the top-level fields of disk-store documents.
//!
//! A query that filters a collection with `==` or `in` on a top-level field
//! would otherwise read every document of the collection to test the filter.
//! This index lists, for each direct collection, field and value, the
//! documents holding that value, so such a query reads only those documents.
//!
//! The index narrows candidates and never decides a result: the query engine
//! still evaluates every filter, order and cursor on each candidate. It must
//! therefore never omit a document that matches, and may include documents
//! that do not. Two rules give that guarantee:
//!
//! - Every value the query engine compares as equal has the same index key.
//!   Integers and doubles share one numeric domain (`1 == 1.0`, `-0.0 ==
//!   0`), NaNs equal each other, strings and bytes compare only their first
//!   1,500 bytes in the Standard edition, and references compare by resource
//!   path with numeric ids by value (`__id5__` equals `__id05__`). Long keys
//!   are replaced by a digest; a collision only adds candidates.
//! - Every top-level field of every document is indexed unless its value is
//!   an array, a map or a vector. Those can never equal an indexed value, and
//!   a filter on one is answered by a scan.
//!
//! Entries live in redb tables written in the same transaction as the
//! documents they describe, so a read transaction always sees the index and
//! the documents at the same revision. Each `[database][collection path]
//! [field]` is named once, in a prefix table, by a 4-byte id. An entry's key
//! is `[prefix id][value key][ordered document id]`: a self-delimiting value
//! key and the scope index's ordered resource id, so the documents of one
//! value come out in the collection's query order and a join can seek every
//! value range to the same document. Its value is the document id as stored,
//! from which the document's key is rebuilt.

use std::cmp::Ordering;

use redb::{ReadOnlyTable, ReadableTable, Table};
use sha2::{Digest, Sha256};

use super::{
    DiskError, database_prefix, prefix_successor, push_length_prefixed, push_ordered_resource_id,
};

/// The prefix table's own key for the next unassigned id; every real prefix
/// starts with a length-prefixed project id, so it is never empty.
const NEXT_PREFIX_ID: &[u8] = b"";
use crate::{DatabaseName, Document, DocumentKey, FieldEquality, Value};

/// Values up to this many bytes are stored inline; longer ones as a digest.
const INLINE_BYTES: usize = 64;
/// Digest bytes kept for a long value.
const DIGEST_BYTES: usize = 16;
/// The prefix of strings and bytes that the Standard edition compares. Two
/// values that agree on it are equal there, so they must share a key; the
/// Enterprise edition compares whole values, which share it too.
const COMPARED_PREFIX_BYTES: usize = 1_500;

const TAG_NULL: u8 = 0;
const TAG_BOOLEAN: u8 = 1;
const TAG_INTEGRAL: u8 = 2;
const TAG_FRACTIONAL: u8 = 3;
const TAG_NAN: u8 = 4;
const TAG_TIMESTAMP: u8 = 5;
const TAG_STRING: u8 = 6;
const TAG_BYTES: u8 = 7;
const TAG_REFERENCE: u8 = 8;
const TAG_GEO_POINT: u8 = 9;

const BYTES_INLINE: u8 = 0;
const BYTES_DIGEST: u8 = 1;

/// The key shared by every value equal to `value`, or `None` when the value
/// is not indexed.
pub(crate) fn value_key(value: &Value) -> Option<Vec<u8>> {
    let mut key = Vec::with_capacity(16);
    match value {
        Value::Null => key.push(TAG_NULL),
        Value::Boolean(value) => {
            key.push(TAG_BOOLEAN);
            key.push(u8::from(*value));
        }
        Value::Integer(value) => push_integral(&mut key, *value),
        Value::Double(value) => push_double(&mut key, *value),
        Value::Timestamp(value) => {
            key.push(TAG_TIMESTAMP);
            key.extend_from_slice(&value.seconds().to_be_bytes());
            key.extend_from_slice(&value.nanos().to_be_bytes());
        }
        Value::String(value) => push_compared_bytes(&mut key, TAG_STRING, value.as_bytes()),
        Value::Bytes(value) => push_compared_bytes(&mut key, TAG_BYTES, value),
        Value::Reference(value) => {
            let mut canonical = Vec::with_capacity(value.len().saturating_add(8));
            for segment in value.split('/') {
                push_ordered_resource_id(&mut canonical, segment);
            }
            push_bytes(&mut key, TAG_REFERENCE, &canonical);
        }
        Value::GeoPoint {
            latitude,
            longitude,
        } => {
            key.push(TAG_GEO_POINT);
            key.extend_from_slice(&canonical_double_bits(*latitude).to_be_bytes());
            key.extend_from_slice(&canonical_double_bits(*longitude).to_be_bytes());
        }
        Value::Array(_) | Value::Map(_) | Value::Vector(_) => return None,
    }
    Some(key)
}

fn push_integral(key: &mut Vec<u8>, value: i64) {
    key.push(TAG_INTEGRAL);
    key.extend_from_slice(&value.to_be_bytes());
}

/// A double equal to an integer shares that integer's key, exactly as the
/// query engine's integer/double comparison decides: integral and inside
/// `[-2^63, 2^63)`. `-0.0` is integral zero.
#[allow(clippy::cast_possible_truncation)]
fn push_double(key: &mut Vec<u8>, value: f64) {
    if value.is_nan() {
        key.push(TAG_NAN);
    } else if value.fract() == 0.0 && value >= -(2_f64.powi(63)) && value < 2_f64.powi(63) {
        push_integral(key, value as i64);
    } else {
        key.push(TAG_FRACTIONAL);
        key.extend_from_slice(&value.to_bits().to_be_bytes());
    }
}

/// Bits that agree for doubles the query engine compares as equal: every NaN
/// and both zeros collapse to one representative.
fn canonical_double_bits(value: f64) -> u64 {
    if value.is_nan() {
        f64::NAN.to_bits()
    } else if value == 0.0 {
        0
    } else {
        value.to_bits()
    }
}

fn push_compared_bytes(key: &mut Vec<u8>, tag: u8, value: &[u8]) {
    push_bytes(key, tag, &value[..value.len().min(COMPARED_PREFIX_BYTES)]);
}

fn push_bytes(key: &mut Vec<u8>, tag: u8, value: &[u8]) {
    key.push(tag);
    if value.len() <= INLINE_BYTES {
        key.push(BYTES_INLINE);
        key.push(u8::try_from(value.len()).expect("inline values fit one length byte"));
        key.extend_from_slice(value);
    } else {
        key.push(BYTES_DIGEST);
        key.extend_from_slice(&Sha256::digest(value)[..DIGEST_BYTES]);
    }
}

/// `[database][collection path][field]`: every entry of one field of one
/// collection starts with it.
fn field_prefix(
    database: &DatabaseName,
    collection_path: &str,
    field: &str,
) -> Result<Vec<u8>, DiskError> {
    let mut prefix = database_prefix(database)?;
    push_length_prefixed(&mut prefix, collection_path)?;
    push_length_prefixed(&mut prefix, field)?;
    Ok(prefix)
}

/// The prefix ids of a write transaction.
pub(crate) struct PrefixIds<'a, 'txn> {
    pub(crate) table: &'a mut Table<'txn, &'static [u8], u32>,
}

impl PrefixIds<'_, '_> {
    fn get(&self, prefix: &[u8]) -> Result<Option<u32>, DiskError> {
        Ok(self
            .table
            .get(prefix)
            .map_err(DiskError::redb)?
            .map(|id| id.value()))
    }

    fn get_or_assign(&mut self, prefix: &[u8]) -> Result<u32, DiskError> {
        if let Some(id) = self.get(prefix)? {
            return Ok(id);
        }
        let id = self.get(NEXT_PREFIX_ID)?.unwrap_or(0);
        let next = id
            .checked_add(1)
            .ok_or_else(|| DiskError::Encoding("field index prefix ids exhausted".to_owned()))?;
        self.table.insert(prefix, id).map_err(DiskError::redb)?;
        self.table
            .insert(NEXT_PREFIX_ID, next)
            .map_err(DiskError::redb)?;
        Ok(id)
    }
}

/// One document's index entries: `(entry key, document id)`, sorted.
pub(crate) type Entries = Vec<(Vec<u8>, Vec<u8>)>;

/// The index entries of one document, one per indexed top-level field.
/// `assign` names a field's prefix on first use; without it, a field whose
/// prefix was never named has no entry to report.
pub(crate) fn entries<'a>(
    prefixes: &mut PrefixIds<'_, '_>,
    assign: bool,
    key: &DocumentKey,
    fields: impl IntoIterator<Item = (&'a str, &'a Value)>,
) -> Result<Entries, DiskError> {
    let (collection_path, document_id) = key.path().rsplit_once('/').ok_or_else(|| {
        DiskError::Corrupt(format!("document path has no collection: {}", key.path()))
    })?;
    let mut entries = Vec::new();
    for (field, value) in fields {
        let Some(value_key) = value_key(value) else {
            continue;
        };
        let prefix = field_prefix(key.database(), collection_path, field)?;
        let id = if assign {
            prefixes.get_or_assign(&prefix)?
        } else {
            match prefixes.get(&prefix)? {
                Some(id) => id,
                None => continue,
            }
        };
        let mut entry = id.to_be_bytes().to_vec();
        entry.extend_from_slice(&value_key);
        push_ordered_resource_id(&mut entry, document_id);
        entries.push((entry, document_id.as_bytes().to_vec()));
    }
    entries.sort_unstable();
    entries.dedup();
    Ok(entries)
}

/// The index entries of a decoded document, naming new prefixes.
pub(crate) fn document_entries(
    prefixes: &mut PrefixIds<'_, '_>,
    key: &DocumentKey,
    document: &Document,
) -> Result<Entries, DiskError> {
    entries(
        prefixes,
        true,
        key,
        document
            .fields()
            .iter()
            .map(|(field, value)| (field.as_str(), value)),
    )
}

/// Documents of one value of one field, from a seek position on.
struct ValueRange {
    /// `[field prefix][value key]`; the rest of an entry key is the
    /// document's ordered id.
    lower: Vec<u8>,
    upper: Vec<u8>,
    range: Option<redb::Range<'static, &'static [u8], &'static [u8]>>,
    /// The current entry: its ordered document id and the document id as
    /// stored.
    head: Option<(Vec<u8>, Vec<u8>)>,
}

impl ValueRange {
    fn open(table: &ReadOnlyTable<&'static [u8], &'static [u8]>, lower: Vec<u8>) -> Option<Self> {
        let upper = prefix_successor(&lower)?;
        let mut range = Self {
            range: table
                .range::<&[u8]>(lower.as_slice()..upper.as_slice())
                .ok(),
            lower,
            upper,
            head: None,
        };
        range.advance();
        Some(range)
    }

    fn advance(&mut self) {
        self.head = None;
        let Some(range) = self.range.as_mut() else {
            return;
        };
        for entry in range.by_ref() {
            let Ok((key, document)) = entry else {
                continue;
            };
            let Some(id) = key.value().get(self.lower.len()..) else {
                continue;
            };
            self.head = Some((id.to_vec(), document.value().to_vec()));
            return;
        }
        self.range = None;
    }

    /// Moves to the first entry whose ordered id is at or after `target`.
    fn seek(&mut self, table: &ReadOnlyTable<&'static [u8], &'static [u8]>, target: &[u8]) {
        if self
            .head
            .as_ref()
            .is_none_or(|(id, _)| id.as_slice() >= target)
        {
            return;
        }
        let mut lower = self.lower.clone();
        lower.extend_from_slice(target);
        self.range = table
            .range::<&[u8]>(lower.as_slice()..self.upper.as_slice())
            .ok();
        self.advance();
    }

    fn id(&self) -> Option<&[u8]> {
        self.head.as_ref().map(|(id, _)| id.as_slice())
    }
}

/// The documents holding one of a conjunct's values, as one ordered stream.
struct Alternatives {
    ranges: Vec<ValueRange>,
}

impl Alternatives {
    /// The smallest current id across the values, or `None` when every value
    /// is exhausted.
    fn id(&self) -> Option<&[u8]> {
        self.ranges.iter().filter_map(ValueRange::id).min()
    }

    fn seek(&mut self, table: &ReadOnlyTable<&'static [u8], &'static [u8]>, target: &[u8]) {
        for range in &mut self.ranges {
            range.seek(table, target);
        }
    }

    /// Steps past `id` and returns the stored document id of the entry at it.
    fn step_past(&mut self, id: &[u8]) -> Option<Vec<u8>> {
        let mut document = None;
        for range in &mut self.ranges {
            if range.id() == Some(id) {
                document = range.head.as_ref().map(|(_, document)| document.clone());
                range.advance();
            }
        }
        document
    }
}

/// The documents of every conjunct, in the collection's query order: a
/// zig-zag join that seeks each conjunct to the largest id any conjunct is
/// at, so the cost follows the most selective conjunct.
pub(crate) struct EqualityJoin {
    table: ReadOnlyTable<&'static [u8], &'static [u8]>,
    conjuncts: Vec<Alternatives>,
    database: DatabaseName,
    collection_path: String,
}

impl EqualityJoin {
    /// `None` when a value is not indexed or a key cannot be encoded. A field
    /// whose prefix was never named holds no value in this collection, so its
    /// conjunct, and the join, match nothing.
    pub(crate) fn open(
        table: ReadOnlyTable<&'static [u8], &'static [u8]>,
        prefixes: &ReadOnlyTable<&'static [u8], u32>,
        database: &DatabaseName,
        collection_path: &str,
        lookups: &[FieldEquality<'_>],
    ) -> Option<Self> {
        let mut conjuncts = Vec::with_capacity(lookups.len());
        for lookup in lookups {
            let prefix = field_prefix(database, collection_path, lookup.field).ok()?;
            let mut keys = lookup
                .values
                .iter()
                .map(value_key)
                .collect::<Option<Vec<_>>>()?;
            // `in [1, 1.0]` names one range twice.
            keys.sort_unstable();
            keys.dedup();
            let id = prefixes.get(prefix.as_slice()).ok()?.map(|id| id.value());
            let mut ranges = Vec::with_capacity(keys.len());
            if let Some(id) = id {
                for value_key in keys {
                    let mut lower = id.to_be_bytes().to_vec();
                    lower.extend_from_slice(&value_key);
                    ranges.push(ValueRange::open(&table, lower)?);
                }
            }
            conjuncts.push(Alternatives { ranges });
        }
        Some(Self {
            table,
            conjuncts,
            database: database.clone(),
            collection_path: collection_path.to_owned(),
        })
    }

    /// The next document every conjunct holds.
    pub(crate) fn next(&mut self) -> Option<DocumentKey> {
        loop {
            let id = self.next_id()?;
            let Ok(id) = std::str::from_utf8(&id) else {
                continue;
            };
            if let Ok(key) = DocumentKey::new(
                self.database.clone(),
                format!("{}/{id}", self.collection_path),
            ) {
                return Some(key);
            }
        }
    }

    fn next_id(&mut self) -> Option<Vec<u8>> {
        if self.conjuncts.is_empty() {
            return None;
        }
        loop {
            let mut target: Option<Vec<u8>> = None;
            for conjunct in &self.conjuncts {
                let id = conjunct.id()?;
                if target.as_deref().is_none_or(|target| id > target) {
                    target = Some(id.to_vec());
                }
            }
            let target = target?;
            let mut aligned = true;
            for conjunct in &mut self.conjuncts {
                conjunct.seek(&self.table, &target);
                match conjunct.id().map(|id| id.cmp(target.as_slice())) {
                    None => return None,
                    Some(Ordering::Equal) => {}
                    Some(_) => aligned = false,
                }
            }
            if !aligned {
                continue;
            }
            let mut document = None;
            for conjunct in &mut self.conjuncts {
                let stepped = conjunct.step_past(&target);
                document = document.or(stepped);
            }
            if document.is_some() {
                return document;
            }
        }
    }
}

#[cfg(test)]
mod tests;
