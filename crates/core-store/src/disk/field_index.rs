//! Order-preserving index over the top-level fields of disk-store documents.
//!
//! A query that filters a collection with `==` or `in` on a top-level field,
//! or orders it by one, would otherwise read every document of the
//! collection. This index lists, for each direct collection and top-level
//! field, every document holding the field, sorted by the field's value in the
//! query engine's order and then by the document's name. An equality reads
//! one value's documents; an order walks the field's entries from a seek
//! position and stops once it has enough.
//!
//! The index narrows and orders candidates and never decides a result: the
//! query engine still evaluates every filter and cursor on each candidate. It
//! must therefore never omit a document that holds the field, and every
//! document it yields in its exact place must be in that place. The value key
//! gives that guarantee:
//!
//! - It follows the query engine's value order: when a value orders before
//!   another, its key is not greater, and values the engine compares as equal
//!   have the same key. Integers and doubles share one numeric domain (`1 ==
//!   1.0`, `-0.0 == 0`), NaNs equal each other and order first, strings and
//!   bytes compare only their first 1,500 bytes in the Standard edition, and
//!   references compare by resource path with numeric ids by value
//!   (`__id5__` equals `__id05__`).
//! - It is exact when equal keys imply equal values. Strings and bytes longer
//!   than [`INLINE_BYTES`], references longer than
//!   [`INLINE_REFERENCE_BYTES`], and non-empty arrays, maps and vectors, are
//!   not: their key keeps an order-preserving prefix (a group),
//!   and the walk marks each group so the engine sorts its members itself. A
//!   long string's key adds a digest of the bytes it compares after the
//!   group, so an equality on it still reads only the documents with that
//!   digest; a collision only adds candidates.
//! - Every value of every top-level field is indexed, arrays, maps and vectors
//!   included, so an order over a field reaches every document holding it.
//!
//! Entries live in redb tables written in the same transaction as the
//! documents they describe, so a read transaction always sees the index and
//! the documents at the same revision. Each `[database][collection path]
//! [field]` is named once, in a prefix table of this index's own, by a 4-byte
//! id. An entry's key is `[prefix id][value key][ordered document id]`: a
//! self-delimiting value key and the scope index's ordered resource id, so the
//! documents of one value come out in the collection's query order and a join
//! can seek every value range to the same document. Its value is the document
//! id as stored, from which the document's key is rebuilt.

use std::cmp::Ordering;
use std::ops::Bound;

use redb::{ReadOnlyTable, ReadableTable, Table};
use sha2::{Digest, Sha256};

use super::{
    DiskError, database_prefix, prefix_successor, push_length_prefixed, push_ordered_resource_id,
};
use crate::lazy::StoredField;
use crate::{DatabaseName, Document, DocumentKey, FieldEquality, Value};

/// The prefix table's own key for the next unassigned id; every real prefix
/// starts with a length-prefixed project id, so it is never empty.
const NEXT_PREFIX_ID: &[u8] = b"";

/// Strings and bytes up to this many bytes are keyed exactly; longer ones by
/// this prefix and a digest.
pub(crate) const INLINE_BYTES: usize = 64;
/// The same for a reference's canonical form, which spells every segment of
/// the full resource name, so most references stay exact.
const INLINE_REFERENCE_BYTES: usize = 256;
/// Digest bytes kept for a long value.
const DIGEST_BYTES: usize = 16;
/// The prefix of strings and bytes that the Standard edition compares. Two
/// values that agree on it are equal there, so they must share a key; the
/// Enterprise edition compares whole values, which share it too.
const COMPARED_PREFIX_BYTES: usize = 1_500;

// One tag per type, in the query engine's type order; numbers take six, one
// per class of the shared numeric domain. Tags are spaced so that `tag + 1`
// ends a type's range.
const TAG_NULL: u8 = 0x10;
const TAG_BOOLEAN: u8 = 0x20;
const TAG_NAN: u8 = 0x30;
const TAG_NEGATIVE_INFINITY: u8 = 0x31;
/// Finite doubles below `-2^63`.
const TAG_BELOW_INTEGERS: u8 = 0x32;
/// Integers, and doubles in `[-2^63, 2^63)`.
const TAG_INTEGERS: u8 = 0x33;
/// Finite doubles at or above `2^63`.
const TAG_ABOVE_INTEGERS: u8 = 0x34;
const TAG_POSITIVE_INFINITY: u8 = 0x35;
const TAG_TIMESTAMP: u8 = 0x40;
const TAG_STRING: u8 = 0x50;
const TAG_BYTES: u8 = 0x60;
const TAG_REFERENCE: u8 = 0x70;
const TAG_GEO_POINT: u8 = 0x80;
const TAG_ARRAY: u8 = 0x90;
const TAG_VECTOR: u8 = 0xA0;
const TAG_MAP: u8 = 0xB0;

/// After an integer part: the fraction is negative, zero or positive.
const FRACTION_NEGATIVE: u8 = 0;
const FRACTION_ZERO: u8 = 1;
const FRACTION_POSITIVE: u8 = 2;

/// Ends an exact string, bytes or reference key; a zero byte inside one is
/// written `0x00 0xFF`.
const END_EXACT: [u8; 2] = [0, 0];
/// Ends the group of a long one; its digest follows.
const END_GROUP: [u8; 2] = [0, 1];

/// After an array, map or vector tag: empty (exact) or not (a group).
const EMPTY: u8 = 0;
const NOT_EMPTY: u8 = 1;

/// A top-level value as the index sees it. A stored document's previous
/// entries are computed without decoding its arrays and maps, which only
/// need their emptiness here.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Indexed<'a> {
    Value(&'a Value),
    Array { empty: bool },
    Map { empty: bool },
}

impl<'a> From<&'a Value> for Indexed<'a> {
    fn from(value: &'a Value) -> Self {
        match value {
            Value::Array(values) => Self::Array {
                empty: values.is_empty(),
            },
            Value::Map(fields) => Self::Map {
                empty: fields.is_empty(),
            },
            value => Self::Value(value),
        }
    }
}

impl<'a> From<&'a StoredField> for Indexed<'a> {
    fn from(field: &'a StoredField) -> Self {
        match field {
            StoredField::Value(value) => value.into(),
            StoredField::Array { empty } => Self::Array { empty: *empty },
            StoredField::Map { empty } => Self::Map { empty: *empty },
        }
    }
}

/// The key of `value` for the index, appended to `key`.
pub(crate) fn push_value_key(key: &mut Vec<u8>, value: Indexed<'_>) {
    match value {
        Indexed::Array { empty } => {
            key.push(TAG_ARRAY);
            key.push(if empty { EMPTY } else { NOT_EMPTY });
        }
        Indexed::Map { empty } => {
            key.push(TAG_MAP);
            key.push(if empty { EMPTY } else { NOT_EMPTY });
        }
        Indexed::Value(value) => match value {
            Value::Null => key.push(TAG_NULL),
            Value::Boolean(value) => {
                key.push(TAG_BOOLEAN);
                key.push(u8::from(*value));
            }
            Value::Integer(value) => push_integral(key, *value, FRACTION_ZERO, 0.0),
            Value::Double(value) => push_double(key, *value),
            Value::Timestamp(value) => {
                key.push(TAG_TIMESTAMP);
                key.extend_from_slice(&sortable_integer(value.seconds()).to_be_bytes());
                key.extend_from_slice(&value.nanos().to_be_bytes());
            }
            Value::String(value) => push_compared_bytes(key, TAG_STRING, value.as_bytes()),
            Value::Bytes(value) => push_compared_bytes(key, TAG_BYTES, value),
            Value::Reference(value) => {
                let mut canonical = Vec::with_capacity(value.len().saturating_add(8));
                for segment in value.split('/') {
                    push_ordered_resource_id(&mut canonical, segment);
                }
                push_bytes(key, TAG_REFERENCE, &canonical, INLINE_REFERENCE_BYTES);
            }
            Value::GeoPoint {
                latitude,
                longitude,
            } => {
                key.push(TAG_GEO_POINT);
                key.extend_from_slice(&sortable_double(*latitude).to_be_bytes());
                key.extend_from_slice(&sortable_double(*longitude).to_be_bytes());
            }
            Value::Array(values) => push_value_key(
                key,
                Indexed::Array {
                    empty: values.is_empty(),
                },
            ),
            Value::Map(fields) => push_value_key(
                key,
                Indexed::Map {
                    empty: fields.is_empty(),
                },
            ),
            Value::Vector(values) => {
                // Vectors order by length first.
                key.push(TAG_VECTOR);
                let length = u32::try_from(values.len()).unwrap_or(u32::MAX);
                key.extend_from_slice(&length.to_be_bytes());
                key.push(if values.is_empty() { EMPTY } else { NOT_EMPTY });
            }
        },
    }
}

/// The key of `value`, on its own.
pub(crate) fn value_key(value: &Value) -> Vec<u8> {
    let mut key = Vec::with_capacity(20);
    push_value_key(&mut key, value.into());
    key
}

/// `i64` bits whose unsigned big-endian order is the signed order.
const fn sortable_integer(value: i64) -> u64 {
    u64::from_be_bytes(value.to_be_bytes()) ^ (1 << 63)
}

/// `f64` bits whose unsigned order is the query engine's double order: NaN
/// first, then the numeric order with both zeros equal.
fn sortable_double(value: f64) -> u64 {
    if value.is_nan() {
        0
    } else if value == 0.0 {
        1 << 63
    } else if value.is_sign_negative() {
        !value.to_bits()
    } else {
        value.to_bits() | (1 << 63)
    }
}

/// An integer part, as an `i64`, and the fraction that completes the value.
fn push_integral(key: &mut Vec<u8>, integral: i64, sign: u8, fraction: f64) {
    key.push(TAG_INTEGERS);
    key.extend_from_slice(&sortable_integer(integral).to_be_bytes());
    key.push(sign);
    if sign != FRACTION_ZERO {
        key.extend_from_slice(&sortable_double(fraction).to_be_bytes());
    }
}

/// A double inside `[-2^63, 2^63)` shares the integers' class: its integer
/// part truncated toward zero, then its fraction, which has the integer
/// part's sign. Both are exact, so equal keys are equal numbers, and the
/// pair orders as the number does. Outside that range a double is never
/// equal to an integer and keeps its own bits.
#[allow(clippy::cast_possible_truncation)]
fn push_double(key: &mut Vec<u8>, value: f64) {
    const TWO_POW_63: f64 = 9_223_372_036_854_775_808.0;
    if value.is_nan() {
        key.push(TAG_NAN);
    } else if value == f64::NEG_INFINITY {
        key.push(TAG_NEGATIVE_INFINITY);
    } else if value == f64::INFINITY {
        key.push(TAG_POSITIVE_INFINITY);
    } else if value < -TWO_POW_63 {
        key.push(TAG_BELOW_INTEGERS);
        key.extend_from_slice(&sortable_double(value).to_be_bytes());
    } else if value >= TWO_POW_63 {
        key.push(TAG_ABOVE_INTEGERS);
        key.extend_from_slice(&sortable_double(value).to_be_bytes());
    } else {
        let integral = value.trunc();
        let fraction = value - integral;
        let sign = if fraction < 0.0 {
            FRACTION_NEGATIVE
        } else if fraction > 0.0 {
            FRACTION_POSITIVE
        } else {
            FRACTION_ZERO
        };
        push_integral(key, integral as i64, sign, fraction);
    }
}

fn push_compared_bytes(key: &mut Vec<u8>, tag: u8, value: &[u8]) {
    push_bytes(
        key,
        tag,
        &value[..value.len().min(COMPARED_PREFIX_BYTES)],
        INLINE_BYTES,
    );
}

/// `value`'s bytes, escaped so the key ends where they do: up to `inline`
/// bytes exactly, longer ones as that prefix, a group end and a digest of
/// all of them.
fn push_bytes(key: &mut Vec<u8>, tag: u8, value: &[u8], inline: usize) {
    key.push(tag);
    if value.len() <= inline {
        push_escaped(key, value);
        key.extend_from_slice(&END_EXACT);
    } else {
        push_escaped(key, &value[..inline]);
        key.extend_from_slice(&END_GROUP);
        key.extend_from_slice(&Sha256::digest(value)[..DIGEST_BYTES]);
    }
}

fn push_escaped(key: &mut Vec<u8>, value: &[u8]) {
    for byte in value {
        if *byte == 0 {
            key.extend_from_slice(&[0, u8::MAX]);
        } else {
            key.push(*byte);
        }
    }
}

/// Where a value key ends, read back from an entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct KeyExtent {
    /// Bytes of the group the walk sorts by: the whole key when it is exact.
    pub(crate) group: usize,
    /// Bytes of the whole value key; the ordered document id follows.
    pub(crate) len: usize,
    /// Whether equal keys imply equal values.
    pub(crate) exact: bool,
}

/// The extent of the value key that starts `key`, or `None` when it is not
/// one this index writes.
pub(crate) fn value_key_extent(key: &[u8]) -> Option<KeyExtent> {
    let exact = |len: usize| {
        (len <= key.len()).then_some(KeyExtent {
            group: len,
            len,
            exact: true,
        })
    };
    match *key.first()? {
        TAG_NULL | TAG_NAN | TAG_NEGATIVE_INFINITY | TAG_POSITIVE_INFINITY => exact(1),
        TAG_BOOLEAN => exact(2),
        TAG_BELOW_INTEGERS | TAG_ABOVE_INTEGERS => exact(9),
        TAG_INTEGERS => match *key.get(9)? {
            FRACTION_ZERO => exact(10),
            FRACTION_NEGATIVE | FRACTION_POSITIVE => exact(18),
            _ => None,
        },
        TAG_TIMESTAMP => exact(13),
        TAG_GEO_POINT => exact(17),
        TAG_STRING | TAG_BYTES | TAG_REFERENCE => {
            let mut index = 1;
            loop {
                if *key.get(index)? != 0 {
                    index += 1;
                    continue;
                }
                match *key.get(index + 1)? {
                    u8::MAX => index += 2,
                    0 => return exact(index + 2),
                    1 => {
                        let len = index + 2 + DIGEST_BYTES;
                        return (len <= key.len()).then_some(KeyExtent {
                            group: index + 2,
                            len,
                            exact: false,
                        });
                    }
                    _ => return None,
                }
            }
        }
        TAG_ARRAY | TAG_MAP => grouped(key, 1),
        TAG_VECTOR => grouped(key, 5),
        _ => None,
    }
}

/// An array, map or vector key: `flag_at` bytes, then the emptiness flag.
fn grouped(key: &[u8], flag_at: usize) -> Option<KeyExtent> {
    let len = flag_at + 1;
    let exact = match *key.get(flag_at)? {
        EMPTY => true,
        NOT_EMPTY => false,
        _ => return None,
    };
    Some(KeyExtent {
        group: len,
        len,
        exact,
    })
}

/// The first tag of the type `value` belongs to, and the tag after its last.
/// A number's range starts after NaN, which no range filter matches.
const fn type_tags(value: &Value) -> (u8, u8) {
    match value {
        Value::Null => (TAG_NULL, TAG_NULL + 1),
        Value::Boolean(_) => (TAG_BOOLEAN, TAG_BOOLEAN + 1),
        Value::Integer(_) | Value::Double(_) => (TAG_NEGATIVE_INFINITY, TAG_POSITIVE_INFINITY + 1),
        Value::Timestamp(_) => (TAG_TIMESTAMP, TAG_TIMESTAMP + 1),
        Value::String(_) => (TAG_STRING, TAG_STRING + 1),
        Value::Bytes(_) => (TAG_BYTES, TAG_BYTES + 1),
        Value::Reference(_) => (TAG_REFERENCE, TAG_REFERENCE + 1),
        Value::GeoPoint { .. } => (TAG_GEO_POINT, TAG_GEO_POINT + 1),
        Value::Array(_) => (TAG_ARRAY, TAG_ARRAY + 1),
        Value::Vector(_) => (TAG_VECTOR, TAG_VECTOR + 1),
        Value::Map(_) => (TAG_MAP, TAG_MAP + 1),
    }
}

/// The disk field index's key for one value, with where its group ends and
/// whether it is exact; see [`FieldOrderRange`] for how a walk uses it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldIndexKey {
    /// The value key as entries hold it.
    pub bytes: Vec<u8>,
    /// Bytes of `bytes` the walk orders by. Values whose groups are equal and
    /// not exact are sorted by the query engine itself.
    pub group: usize,
    /// Whether equal keys imply values the query engine compares as equal.
    pub exact: bool,
}

/// The key the disk field index stores for `value`. It is what the query
/// engine's tests hold to its value order.
///
/// # Panics
///
/// Never for a key this module wrote: it reads back every one of them.
#[must_use]
pub fn field_index_key(value: &Value) -> FieldIndexKey {
    let bytes = value_key(value);
    let extent = value_key_extent(&bytes).expect("the index reads back every key it writes");
    debug_assert_eq!(extent.len, bytes.len());
    FieldIndexKey {
        group: extent.group,
        exact: extent.exact,
        bytes,
    }
}

/// Where a walk over one field's entries starts and stops, in ascending
/// value order, whichever way the walk then goes. Every bound only ever
/// narrows the range, so the bounds of a query's filters and cursors can be
/// added in any order. A bound on a value whose key is not exact widens to
/// the whole of its group: the walk can only promise a superset, and the
/// query engine's own checks decide.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FieldOrderRange {
    /// The first value-key position inside the range.
    lower: Option<Vec<u8>>,
    /// The first value-key position past it.
    upper: Option<Vec<u8>>,
}

impl FieldOrderRange {
    /// Every entry of the field.
    #[must_use]
    pub fn all() -> Self {
        Self::default()
    }

    /// Keeps the values at or after `value`, and with `document_id`, of the
    /// documents of `value` only those from that document on.
    pub fn at_or_after(&mut self, value: &Value, document_id: Option<&str>) {
        let position = position(value, document_id, Side::Start, true);
        self.raise(position);
    }

    /// Keeps the values after `value`, or with `document_id`, after that
    /// document of `value`.
    pub fn after(&mut self, value: &Value, document_id: Option<&str>) {
        let position = position(value, document_id, Side::Start, false);
        self.raise(position);
    }

    /// Keeps the values at or before `value`, and with `document_id`, of the
    /// documents of `value` only those up to that document.
    pub fn at_or_before(&mut self, value: &Value, document_id: Option<&str>) {
        let position = position(value, document_id, Side::End, true);
        self.lower_end(position);
    }

    /// Keeps the values before `value`, or with `document_id`, before that
    /// document of `value`.
    pub fn before(&mut self, value: &Value, document_id: Option<&str>) {
        let position = position(value, document_id, Side::End, false);
        self.lower_end(position);
    }

    /// Keeps the values of `value`'s type, the domain a range filter on it
    /// compares in; for a number, without NaN.
    pub fn within_type_of(&mut self, value: &Value) {
        let (first, past) = type_tags(value);
        self.raise(Some(vec![first]));
        self.lower_end(Some(vec![past]));
    }

    /// Keeps the span from the lowest of `values` to the highest: what an
    /// `in` needs. No value keeps nothing.
    pub fn within_values(&mut self, values: &[Value]) {
        let lowest = values
            .iter()
            .filter_map(|value| position(value, None, Side::Start, true))
            .min();
        let highest = values
            .iter()
            .map(|value| position(value, None, Side::End, true))
            .max();
        match (lowest, highest) {
            (Some(lowest), Some(highest)) => {
                self.raise(Some(lowest));
                self.lower_end(highest);
            }
            _ => self.nothing(),
        }
    }

    /// Keeps nothing.
    pub fn nothing(&mut self) {
        self.lower = Some(vec![u8::MAX]);
        self.upper = Some(Vec::new());
    }

    /// Whether no entry can be inside.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        matches!((&self.lower, &self.upper), (Some(lower), Some(upper)) if lower >= upper)
    }

    fn raise(&mut self, position: Option<Vec<u8>>) {
        let Some(position) = position else { return };
        if self.lower.as_ref().is_none_or(|lower| *lower < position) {
            self.lower = Some(position);
        }
    }

    /// `None` is the end of the field: it bounds nothing.
    fn lower_end(&mut self, position: Option<Vec<u8>>) {
        let Some(position) = position else { return };
        if self.upper.as_ref().is_none_or(|upper| *upper > position) {
            self.upper = Some(position);
        }
    }
}

#[derive(Clone, Copy)]
enum Side {
    Start,
    End,
}

/// The value-key position a bound on `value` puts the range's start or end
/// at. An exact key is cut precisely, at the document when one is named; a
/// group is kept whole. `None` is past every key (an end at the last
/// possible key), which bounds nothing.
fn position(
    value: &Value,
    document_id: Option<&str>,
    side: Side,
    inclusive: bool,
) -> Option<Vec<u8>> {
    let mut key = value_key(value);
    let extent = value_key_extent(&key).expect("the index reads back every key it writes");
    if !extent.exact {
        key.truncate(extent.group);
        return match side {
            Side::Start => Some(key),
            Side::End => prefix_successor(&key),
        };
    }
    if let Some(document_id) = document_id {
        push_ordered_resource_id(&mut key, document_id);
    }
    // A start after the key, or an end that keeps it, is the key's successor.
    match (side, inclusive) {
        (Side::Start, true) | (Side::End, false) => Some(key),
        (Side::Start, false) | (Side::End, true) => prefix_successor(&key),
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

/// The index entries of one document, one per top-level field. `assign`
/// names a field's prefix on first use; without it, a field whose prefix was
/// never named has no entry to report.
pub(crate) fn entries<'a>(
    prefixes: &mut PrefixIds<'_, '_>,
    assign: bool,
    key: &DocumentKey,
    fields: impl IntoIterator<Item = (&'a str, Indexed<'a>)>,
) -> Result<Entries, DiskError> {
    let (collection_path, document_id) = key.path().rsplit_once('/').ok_or_else(|| {
        DiskError::Corrupt(format!("document path has no collection: {}", key.path()))
    })?;
    let mut entries = Vec::new();
    for (field, value) in fields {
        let prefix = field_prefix(key.database(), collection_path, field)?;
        let id = if assign {
            prefixes.get_or_assign(&prefix)?
        } else {
            match prefixes.get(&prefix)? {
                Some(id) => id,
                None => continue,
            }
        };
        let mut entry = Vec::with_capacity(32);
        entry.extend_from_slice(&id.to_be_bytes());
        push_value_key(&mut entry, value);
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
            .map(|(field, value)| (field.as_str(), Indexed::from(value))),
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

/// The `[prefix id][value key]` of each alternative of every conjunct, or
/// `None` when a conjunct's field holds no value in this collection (its
/// prefix was never named), so nothing matches.
fn conjunct_keys(
    prefixes: &ReadOnlyTable<&'static [u8], u32>,
    database: &DatabaseName,
    collection_path: &str,
    lookups: &[FieldEquality<'_>],
) -> Result<Option<Vec<Vec<Vec<u8>>>>, ()> {
    let mut conjuncts = Vec::with_capacity(lookups.len());
    for lookup in lookups {
        let prefix = field_prefix(database, collection_path, lookup.field).map_err(|_| ())?;
        let Some(id) = prefixes
            .get(prefix.as_slice())
            .map_err(|_| ())?
            .map(|id| id.value())
        else {
            return Ok(None);
        };
        let mut keys = lookup
            .values
            .iter()
            .map(|value| {
                let mut key = id.to_be_bytes().to_vec();
                push_value_key(&mut key, value.into());
                key
            })
            .collect::<Vec<_>>();
        // `in [1, 1.0]` names one range twice.
        keys.sort_unstable();
        keys.dedup();
        conjuncts.push(keys);
    }
    Ok(Some(conjuncts))
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
    /// `None` when a key cannot be encoded. A field whose prefix was never
    /// named holds no value in this collection, so the join matches nothing.
    pub(crate) fn open(
        table: ReadOnlyTable<&'static [u8], &'static [u8]>,
        prefixes: &ReadOnlyTable<&'static [u8], u32>,
        database: &DatabaseName,
        collection_path: &str,
        lookups: &[FieldEquality<'_>],
    ) -> Option<Self> {
        let conjuncts = match conjunct_keys(prefixes, database, collection_path, lookups).ok()? {
            Some(conjuncts) => conjuncts
                .into_iter()
                .map(|keys| {
                    keys.into_iter()
                        .map(|lower| ValueRange::open(&table, lower))
                        .collect::<Option<Vec<_>>>()
                        .map(|ranges| Alternatives { ranges })
                })
                .collect::<Option<Vec<_>>>()?,
            // One conjunct with no value: the join ends at once.
            None => vec![Alternatives { ranges: Vec::new() }],
        };
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

/// The entries of one field of one collection, in value order and then
/// document order, forwards or backwards, between a range's bounds. Every
/// conjunct of `==`/`in` lookups on other fields is checked with one point
/// read of the index per value before the entry is yielded, so a document
/// that fails one is never read.
pub(crate) struct OrderWalk {
    table: ReadOnlyTable<&'static [u8], &'static [u8]>,
    range: Option<redb::Range<'static, &'static [u8], &'static [u8]>>,
    descending: bool,
    /// `[prefix id][value key]` of each alternative of each conjunct.
    conjuncts: Vec<Vec<Vec<u8>>>,
    probe: Vec<u8>,
    database: DatabaseName,
    collection_path: String,
    /// The group bytes of the inexact run being yielded, and its number.
    group: Option<(Vec<u8>, u64)>,
    groups: u64,
}

impl OrderWalk {
    /// `None` when a key cannot be encoded or the index cannot be read. A
    /// field whose prefix was never named holds no value in this collection,
    /// so its walk, or a walk with a lookup on it, yields nothing.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn open(
        table: ReadOnlyTable<&'static [u8], &'static [u8]>,
        prefixes: &ReadOnlyTable<&'static [u8], u32>,
        database: &DatabaseName,
        collection_path: &str,
        field: &str,
        descending: bool,
        bounds: &FieldOrderRange,
        lookups: &[FieldEquality<'_>],
    ) -> Option<Self> {
        let prefix = field_prefix(database, collection_path, field).ok()?;
        let id = prefixes.get(prefix.as_slice()).ok()?.map(|id| id.value());
        let conjuncts = conjunct_keys(prefixes, database, collection_path, lookups).ok()?;
        let range = match (id, conjuncts.as_ref()) {
            (Some(id), Some(_)) if !bounds.is_empty() => {
                let id = id.to_be_bytes();
                let mut lower = id.to_vec();
                lower.extend_from_slice(bounds.lower.as_deref().unwrap_or_default());
                let upper = match &bounds.upper {
                    Some(upper) => {
                        let mut position = id.to_vec();
                        position.extend_from_slice(upper);
                        Some(position)
                    }
                    None => prefix_successor(&id),
                };
                let range = match &upper {
                    Some(upper) if lower >= *upper => None,
                    Some(upper) => Some(table.range::<&[u8]>((
                        Bound::Included(lower.as_slice()),
                        Bound::Excluded(upper.as_slice()),
                    ))),
                    None => Some(
                        table.range::<&[u8]>((Bound::Included(lower.as_slice()), Bound::Unbounded)),
                    ),
                };
                range.transpose().ok()?
            }
            _ => None,
        };
        Some(Self {
            table,
            range,
            descending,
            conjuncts: conjuncts.unwrap_or_default(),
            probe: Vec::new(),
            database: database.clone(),
            collection_path: collection_path.to_owned(),
            group: None,
            groups: 0,
        })
    }

    /// The next document, and the number of its inexact group when the index
    /// does not order it exactly against its neighbours of that number.
    pub(crate) fn next(&mut self) -> Option<(DocumentKey, Option<u64>)> {
        loop {
            let range = self.range.as_mut()?;
            let entry = if self.descending {
                range.next_back()
            } else {
                range.next()
            };
            let Some(entry) = entry else {
                self.range = None;
                return None;
            };
            let Ok((key, document_id)) = entry else {
                continue;
            };
            let key = key.value();
            let Some(extent) = key.get(4..).and_then(value_key_extent) else {
                continue;
            };
            let ordered_id = &key[4 + extent.len..];
            if !self.holds_every_conjunct(ordered_id) {
                continue;
            }
            let group = if extent.exact {
                self.group = None;
                None
            } else {
                let bytes = &key[4..4 + extent.group];
                match &self.group {
                    Some((current, number)) if current.as_slice() == bytes => Some(*number),
                    _ => {
                        self.groups += 1;
                        self.group = Some((bytes.to_vec(), self.groups));
                        Some(self.groups)
                    }
                }
            };
            let Ok(document_id) = std::str::from_utf8(document_id.value()) else {
                continue;
            };
            if let Ok(key) = DocumentKey::new(
                self.database.clone(),
                format!("{}/{document_id}", self.collection_path),
            ) {
                return Some((key, group));
            }
        }
    }

    fn holds_every_conjunct(&mut self, ordered_id: &[u8]) -> bool {
        for alternatives in &self.conjuncts {
            let mut held = false;
            for alternative in alternatives {
                self.probe.clear();
                self.probe.extend_from_slice(alternative);
                self.probe.extend_from_slice(ordered_id);
                if self
                    .table
                    .get(self.probe.as_slice())
                    .is_ok_and(|entry| entry.is_some())
                {
                    held = true;
                    break;
                }
            }
            if !held {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests;
