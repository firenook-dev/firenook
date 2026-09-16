//! Field extraction from encoded documents without decoding them.
//!
//! Disk scans hand the query engine documents as they are stored: one bincode
//! value per document. Evaluating a filter or an order key on such a document
//! only needs one field, so this module walks the encoding, skipping every
//! value it does not need, and decodes just the requested subtree. A document
//! is decoded in full only once it is known to be part of the result.
//!
//! The walker mirrors the derived `Encode` layout of [`Document`] and [`Value`]
//! under bincode's standard configuration. Lengths and enum variant indexes
//! are varints, floats are fixed eight bytes, and strings, bytes and
//! references are a length followed by their bytes. Map keys are `String`s in
//! `BTreeMap` order, so a lookup can stop as soon as it passes the wanted key.
//!
//! Skipping a large nested value still costs a walk over every element it
//! contains, so stored documents carry a field directory: the byte range of
//! every top-level field, computed once at write time. A top-level lookup then
//! jumps straight to its value, and only a nested path walks inside that one
//! subtree. The stored layout is `0xFF`, the bincode-encoded directory
//! (`Vec<(String, u32, u32)>` of key, offset and length relative to the
//! document bytes), then the unchanged bincode [`Document`]. A plain bincode
//! document never starts with `0xFF`: its first byte is the field-count
//! varint, whose only multi-byte markers are 251 to 254. Readers therefore
//! accept both layouts, and stores written before the directory existed keep
//! working at the walking speed until each document is rewritten.

use std::borrow::Cow;
use std::fmt;
use std::sync::Arc;

use bincode::de::read::{Reader, SliceReader};
use bincode::de::{Decode, Decoder, DecoderImpl};
use bincode::error::{DecodeError, EncodeError};
use bincode::{config, decode_from_slice, encode_to_vec};

use super::{Document, Timestamp, Value, nested_value};

const VARIANT_NULL: u32 = 0;
const VARIANT_BOOLEAN: u32 = 1;
const VARIANT_INTEGER: u32 = 2;
const VARIANT_DOUBLE: u32 = 3;
const VARIANT_TIMESTAMP: u32 = 4;
const VARIANT_STRING: u32 = 5;
const VARIANT_BYTES: u32 = 6;
const VARIANT_REFERENCE: u32 = 7;
const VARIANT_GEO_POINT: u32 = 8;
const VARIANT_ARRAY: u32 = 9;
const VARIANT_MAP: u32 = 10;
const VARIANT_VECTOR: u32 = 11;

/// First byte of a stored document that carries a field directory.
const DIRECTORY_MARKER: u8 = 0xFF;

type SliceDecoder<'a> = DecoderImpl<CountingReader<'a>, config::Configuration, ()>;

fn decoder(bytes: &[u8]) -> SliceDecoder<'_> {
    DecoderImpl::new(CountingReader::new(bytes), config::standard(), ())
}

/// A slice reader that also reports how many bytes it has consumed, so the
/// directory builder can record value offsets.
struct CountingReader<'a> {
    inner: SliceReader<'a>,
    consumed: usize,
}

impl<'a> CountingReader<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self {
            inner: SliceReader::new(bytes),
            consumed: 0,
        }
    }
}

impl Reader for CountingReader<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> Result<(), DecodeError> {
        self.inner.read(bytes)?;
        self.consumed += bytes.len();
        Ok(())
    }

    fn peek_read(&mut self, n: usize) -> Option<&[u8]> {
        self.inner.peek_read(n)
    }

    fn consume(&mut self, n: usize) {
        self.inner.consume(n);
        self.consumed += n;
    }
}

/// Encodes a document for the documents table: directory marker, directory,
/// then the plain bincode document.
pub(crate) fn encode_stored_document(document: &Document) -> Result<Vec<u8>, EncodeError> {
    let body = encode_to_vec(document, config::standard())?;
    let directory =
        field_directory(&body).map_err(|error| EncodeError::OtherString(error.to_string()))?;
    let directory = encode_to_vec(&directory, config::standard())?;
    let mut stored = Vec::with_capacity(1 + directory.len() + body.len());
    stored.push(DIRECTORY_MARKER);
    stored.extend_from_slice(&directory);
    stored.extend_from_slice(&body);
    Ok(stored)
}

/// Decodes a documents-table value in either layout.
pub(crate) fn decode_stored_document(bytes: &[u8]) -> Result<Document, DecodeError> {
    let body = document_body(bytes)?;
    let (document, consumed) = decode_from_slice::<Document, _>(body, config::standard())?;
    if consumed != body.len() {
        return Err(DecodeError::Other("trailing bytes after encoded document"));
    }
    Ok(document)
}

/// The plain bincode document inside a stored value.
fn document_body(bytes: &[u8]) -> Result<&[u8], DecodeError> {
    if bytes.first() != Some(&DIRECTORY_MARKER) {
        return Ok(bytes);
    }
    let mut decoder = decoder(&bytes[1..]);
    skip_directory(&mut decoder)?;
    let start = 1 + decoder.reader().consumed;
    bytes
        .get(start..)
        .ok_or(DecodeError::UnexpectedEnd { additional: 1 })
}

/// Byte ranges of every top-level field value inside a plain bincode document.
fn field_directory(body: &[u8]) -> Result<Vec<(String, u32, u32)>, DecodeError> {
    let mut decoder = decoder(body);
    let entries = length(&mut decoder)?;
    let mut directory = Vec::with_capacity(entries.min(1_024));
    for _ in 0..entries {
        let key_len = length(&mut decoder)?;
        let key = {
            let key = decoder
                .reader()
                .peek_read(key_len)
                .ok_or(DecodeError::UnexpectedEnd {
                    additional: key_len,
                })?;
            String::from_utf8(key.to_vec())
                .map_err(|_| DecodeError::Other("field key is not UTF-8"))?
        };
        decoder.reader().consume(key_len);
        let start = decoder.reader().consumed;
        skip_value(&mut decoder)?;
        let end = decoder.reader().consumed;
        let offset =
            u32::try_from(start).map_err(|_| DecodeError::Other("document exceeds 4 GiB"))?;
        let len =
            u32::try_from(end - start).map_err(|_| DecodeError::Other("field exceeds 4 GiB"))?;
        directory.push((key, offset, len));
    }
    Ok(directory)
}

fn skip_directory(decoder: &mut SliceDecoder<'_>) -> Result<(), DecodeError> {
    let entries = length(decoder)?;
    for _ in 0..entries {
        skip_bytes(decoder)?;
        u32::decode(decoder)?;
        u32::decode(decoder)?;
    }
    Ok(())
}

/// Looks `target` up in the directory of a stored value and returns that
/// field's encoded bytes. The whole directory is walked so the body offset is
/// known.
fn directory_lookup<'a>(bytes: &'a [u8], target: &str) -> Result<Option<&'a [u8]>, DecodeError> {
    let mut decoder = decoder(&bytes[1..]);
    let entries = length(&mut decoder)?;
    let mut found = None;
    for _ in 0..entries {
        let key_len = length(&mut decoder)?;
        let matches = {
            let key = decoder
                .reader()
                .peek_read(key_len)
                .ok_or(DecodeError::UnexpectedEnd {
                    additional: key_len,
                })?;
            key == target.as_bytes()
        };
        decoder.reader().consume(key_len);
        let offset = u32::decode(&mut decoder)?;
        let len = u32::decode(&mut decoder)?;
        if matches {
            found = Some((offset as usize, len as usize));
        }
    }
    let Some((offset, len)) = found else {
        return Ok(None);
    };
    let body_start = 1 + decoder.reader().consumed;
    let start = body_start
        .checked_add(offset)
        .ok_or(DecodeError::Other("directory offset overflows"))?;
    let end = start
        .checked_add(len)
        .ok_or(DecodeError::Other("directory length overflows"))?;
    bytes
        .get(start..end)
        .map(Some)
        .ok_or(DecodeError::UnexpectedEnd { additional: len })
}

/// A document still in its stored encoding.
#[derive(Clone)]
pub struct EncodedDocument {
    bytes: Arc<[u8]>,
}

impl fmt::Debug for EncodedDocument {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EncodedDocument")
            .field("bytes", &self.bytes.len())
            .finish()
    }
}

impl EncodedDocument {
    pub(crate) fn new(bytes: &[u8]) -> Self {
        Self {
            bytes: Arc::from(bytes),
        }
    }

    /// Encoded size in bytes.
    #[must_use]
    pub fn encoded_len(&self) -> usize {
        self.bytes.len()
    }

    /// Decodes only the value at `segments`, if present. Invalid encodings
    /// behave as a missing field; [`decode`](Self::decode) reports them.
    #[must_use]
    pub fn field(&self, segments: &[String]) -> Option<Value> {
        find_field(&self.bytes, segments).ok().flatten()
    }

    /// Decodes the whole document.
    pub fn decode(&self) -> Result<Document, DecodeError> {
        decode_stored_document(&self.bytes)
    }
}

/// A scanned document that is decoded only when its contents are needed.
#[derive(Clone, Debug)]
pub enum LazyDocument {
    /// Already decoded: an in-memory store entry or a snapshot overlay.
    Decoded(Arc<Document>),
    /// Still encoded as stored on disk.
    Encoded(EncodedDocument),
}

impl LazyDocument {
    /// Reads one field path, decoding only that subtree for encoded documents.
    #[must_use]
    pub fn field(&self, segments: &[String]) -> Option<Cow<'_, Value>> {
        match self {
            Self::Decoded(document) => nested_value(document.fields(), segments).map(Cow::Borrowed),
            Self::Encoded(document) => document.field(segments).map(Cow::Owned),
        }
    }

    /// Whether the document was already decoded when scanned.
    #[must_use]
    pub const fn is_decoded(&self) -> bool {
        matches!(self, Self::Decoded(_))
    }

    /// The fully decoded document.
    ///
    /// # Panics
    ///
    /// Stored encodings were produced by this crate and pass redb's
    /// checksums, so an encoding that fails to decode is a programming error,
    /// not a data error, and panics rather than being silently dropped.
    #[must_use]
    pub fn into_document(self) -> Arc<Document> {
        match self {
            Self::Decoded(document) => document,
            Self::Encoded(document) => {
                Arc::new(document.decode().expect("stored document encodings decode"))
            }
        }
    }
}

impl From<Arc<Document>> for LazyDocument {
    fn from(document: Arc<Document>) -> Self {
        Self::Decoded(document)
    }
}

fn find_field(bytes: &[u8], segments: &[String]) -> Result<Option<Value>, DecodeError> {
    let Some((first, rest)) = segments.split_first() else {
        return Ok(None);
    };
    if bytes.first() == Some(&DIRECTORY_MARKER) {
        let Some(value) = directory_lookup(bytes, first)? else {
            return Ok(None);
        };
        let mut decoder = decoder(value);
        let Some((next, next_rest)) = rest.split_first() else {
            return Value::decode(&mut decoder).map(Some);
        };
        if u32::decode(&mut decoder)? != VARIANT_MAP {
            return Ok(None);
        }
        let entries = u64::decode(&mut decoder)?;
        return find_in_map(&mut decoder, entries, next, next_rest);
    }
    let mut decoder = decoder(bytes);
    // A plain `Document` starts with its `fields` map.
    let entries = u64::decode(&mut decoder)?;
    find_in_map(&mut decoder, entries, first, rest)
}

/// Walks map entries (already positioned after the entry count) for `target`,
/// descending through nested maps for the remaining segments.
fn find_in_map<'s>(
    decoder: &mut SliceDecoder<'_>,
    mut entries: u64,
    mut target: &'s String,
    mut rest: &'s [String],
) -> Result<Option<Value>, DecodeError> {
    loop {
        let mut found = false;
        while entries > 0 {
            entries -= 1;
            let key_len = length(decoder)?;
            let ordering = {
                let key =
                    decoder
                        .reader()
                        .peek_read(key_len)
                        .ok_or(DecodeError::UnexpectedEnd {
                            additional: key_len,
                        })?;
                key.cmp(target.as_bytes())
            };
            decoder.reader().consume(key_len);
            match ordering {
                std::cmp::Ordering::Less => skip_value(decoder)?,
                std::cmp::Ordering::Equal => {
                    found = true;
                    break;
                }
                std::cmp::Ordering::Greater => return Ok(None),
            }
        }
        if !found {
            return Ok(None);
        }
        let Some((next, next_rest)) = rest.split_first() else {
            return Value::decode(decoder).map(Some);
        };
        if u32::decode(decoder)? != VARIANT_MAP {
            return Ok(None);
        }
        entries = u64::decode(decoder)?;
        target = next;
        rest = next_rest;
    }
}

fn length(decoder: &mut SliceDecoder<'_>) -> Result<usize, DecodeError> {
    usize::try_from(u64::decode(decoder)?).map_err(|_| DecodeError::Other("length exceeds usize"))
}

fn skip_exact(decoder: &mut SliceDecoder<'_>, bytes: usize) -> Result<(), DecodeError> {
    if decoder.reader().peek_read(bytes).is_none() {
        return Err(DecodeError::UnexpectedEnd { additional: bytes });
    }
    decoder.reader().consume(bytes);
    Ok(())
}

/// Skips a length-prefixed string, byte string or reference.
fn skip_bytes(decoder: &mut SliceDecoder<'_>) -> Result<(), DecodeError> {
    let len = length(decoder)?;
    skip_exact(decoder, len)
}

fn skip_value(decoder: &mut SliceDecoder<'_>) -> Result<(), DecodeError> {
    match u32::decode(decoder)? {
        VARIANT_NULL => {}
        VARIANT_BOOLEAN => {
            bool::decode(decoder)?;
        }
        VARIANT_INTEGER => {
            i64::decode(decoder)?;
        }
        VARIANT_DOUBLE => {
            f64::decode(decoder)?;
        }
        VARIANT_TIMESTAMP => {
            Timestamp::decode(decoder)?;
        }
        VARIANT_STRING | VARIANT_BYTES | VARIANT_REFERENCE => skip_bytes(decoder)?,
        VARIANT_GEO_POINT => {
            f64::decode(decoder)?;
            f64::decode(decoder)?;
        }
        VARIANT_ARRAY => {
            let len = length(decoder)?;
            for _ in 0..len {
                skip_value(decoder)?;
            }
        }
        VARIANT_MAP => {
            let len = length(decoder)?;
            for _ in 0..len {
                skip_bytes(decoder)?;
                skip_value(decoder)?;
            }
        }
        VARIANT_VECTOR => {
            let len = length(decoder)?;
            skip_exact(
                decoder,
                len.checked_mul(8)
                    .ok_or(DecodeError::Other("vector length overflows"))?,
            )?;
        }
        _ => return Err(DecodeError::Other("unknown Value variant")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use bincode::encode_to_vec;

    use super::*;
    use crate::Fields;

    fn rich_fields() -> Fields {
        BTreeMap::from([
            (
                "array".to_owned(),
                Value::Array(vec![
                    Value::Null,
                    Value::Boolean(true),
                    Value::Integer(i64::MIN),
                    Value::Integer(300),
                    Value::Double(f64::NAN),
                    Value::String("火🔥".into()),
                    Value::Map(BTreeMap::from([(
                        "deep".to_owned(),
                        Value::Vector(vec![1.5, -2.0]),
                    )])),
                ]),
            ),
            ("bytes".to_owned(), Value::Bytes(Arc::from([0_u8, 1, 255]))),
            ("count".to_owned(), Value::Integer(42)),
            ("empty".to_owned(), Value::Map(BTreeMap::new())),
            (
                "geo".to_owned(),
                Value::GeoPoint {
                    latitude: 1.5,
                    longitude: -2.5,
                },
            ),
            ("long".to_owned(), Value::String("x".repeat(10_000).into())),
            (
                "nested".to_owned(),
                Value::Map(BTreeMap::from([
                    ("a".to_owned(), Value::Integer(1)),
                    (
                        "b".to_owned(),
                        Value::Map(BTreeMap::from([
                            (
                                "c".to_owned(),
                                Value::Timestamp(Timestamp::new(1, 2).unwrap()),
                            ),
                            (
                                "d".to_owned(),
                                Value::Reference(Arc::from(
                                    "projects/p/databases/(default)/documents/x/y",
                                )),
                            ),
                        ])),
                    ),
                    ("z".to_owned(), Value::Null),
                ])),
            ),
            ("vector".to_owned(), Value::Vector(vec![0.25; 64])),
            ("zeta".to_owned(), Value::Double(-0.0)),
        ])
    }

    fn document(fields: Fields) -> Document {
        Document {
            fields,
            create_time: Timestamp::new(5, 6).unwrap(),
            update_time: Timestamp::new(7, 8).unwrap(),
        }
    }

    /// Both stored layouts: the directory form written today and the plain
    /// bincode form of stores written before the directory existed.
    fn layouts(fields: Fields) -> Vec<(&'static str, EncodedDocument, Document)> {
        let document = document(fields);
        let plain = encode_to_vec(&document, config::standard()).unwrap();
        let stored = encode_stored_document(&document).unwrap();
        assert_eq!(stored[0], DIRECTORY_MARKER);
        assert_ne!(plain[0], DIRECTORY_MARKER);
        vec![
            ("directory", EncodedDocument::new(&stored), document.clone()),
            ("plain", EncodedDocument::new(&plain), document),
        ]
    }

    fn encoded(fields: Fields) -> (EncodedDocument, Document) {
        let mut layouts = layouts(fields);
        let (_, encoded, document) = layouts.remove(0);
        (encoded, document)
    }

    // NaN never equals itself; compare canonical encodings instead.
    fn bytes_of(document: &Document) -> Vec<u8> {
        encode_to_vec(document, config::standard()).unwrap()
    }

    fn segments(path: &str) -> Vec<String> {
        path.split('.').map(str::to_owned).collect()
    }

    #[test]
    fn every_field_path_matches_the_decoded_document() {
        for (layout, encoded, document) in layouts(rich_fields()) {
            assert_eq!(
                bytes_of(&encoded.decode().unwrap()),
                bytes_of(&document),
                "{layout}"
            );
            for path in [
                "array",
                "bytes",
                "count",
                "empty",
                "geo",
                "long",
                "nested",
                "nested.a",
                "nested.b",
                "nested.b.c",
                "nested.b.d",
                "nested.z",
                "vector",
                "zeta",
            ] {
                let segments = segments(path);
                let expected = nested_value(document.fields(), &segments).cloned();
                let actual = encoded.field(&segments);
                // NaN compares unequal to itself; compare encodings instead.
                assert_eq!(
                    actual
                        .as_ref()
                        .map(|v| encode_to_vec(v, config::standard()).unwrap()),
                    expected
                        .as_ref()
                        .map(|v| encode_to_vec(v, config::standard()).unwrap()),
                    "{layout} {path}"
                );
            }
        }
    }

    #[test]
    fn missing_paths_are_none_without_decoding_errors() {
        for (layout, encoded, _) in layouts(rich_fields()) {
            for path in [
                "",
                "aaa",
                "zzz",
                "count.x",
                "nested.b.c.d",
                "nested.q",
                "array.0",
                "nested.b.zz",
            ] {
                let segments: Vec<String> = if path.is_empty() {
                    Vec::new()
                } else {
                    segments(path)
                };
                assert!(encoded.field(&segments).is_none(), "{layout} {path}");
            }
        }
    }

    #[test]
    fn directory_survives_many_fields_and_empty_documents() {
        let wide = (0..300)
            .map(|index| (format!("field{index:03}"), Value::Integer(index)))
            .collect::<Fields>();
        for (layout, encoded, document) in layouts(wide) {
            assert_eq!(
                bytes_of(&encoded.decode().unwrap()),
                bytes_of(&document),
                "{layout}"
            );
            assert_eq!(
                encoded.field(&segments("field299")).as_ref(),
                Some(&Value::Integer(299)),
                "{layout}"
            );
        }
        for (layout, encoded, document) in layouts(Fields::new()) {
            assert_eq!(
                bytes_of(&encoded.decode().unwrap()),
                bytes_of(&document),
                "{layout}"
            );
            assert!(encoded.field(&segments("anything")).is_none(), "{layout}");
        }
    }

    #[test]
    fn lazy_document_reads_fields_on_both_representations() {
        let (encoded, document) = encoded(rich_fields());
        let decoded = LazyDocument::Decoded(Arc::new(document.clone()));
        let lazy = LazyDocument::Encoded(encoded);
        assert_eq!(
            decoded.field(&segments("nested.a")).as_deref(),
            Some(&Value::Integer(1))
        );
        assert_eq!(
            lazy.field(&segments("nested.a")).as_deref(),
            Some(&Value::Integer(1))
        );
        assert!(!lazy.is_decoded());
        assert_eq!(bytes_of(&lazy.into_document()), bytes_of(&document));
    }

    #[test]
    fn truncated_encodings_fail_closed() {
        let (encoded, _) = encoded(rich_fields());
        let bytes = encode_to_vec(encoded.decode().unwrap(), config::standard()).unwrap();
        let truncated = EncodedDocument::new(&bytes[..bytes.len() / 2]);
        assert!(truncated.field(&segments("zeta")).is_none());
        assert!(truncated.decode().is_err());
    }
}
