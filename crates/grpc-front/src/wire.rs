//! The service's gRPC codec: prost's, except that documents in responses are
//! encoded in one pass.
//!
//! prost writes a nested message as its length and then its bytes, and finds
//! the length by walking the message; each nested message then does the same
//! for its own fields. A value at depth `d` of a document is therefore walked
//! `d + 1` times, and documents nest maps deeply: on a batch read of large
//! documents of many small values that repeated measuring cost more than
//! everything else the response needed. This encoder measures every value of
//! a document once, bottom-up, keeps the lengths, and then writes exactly the
//! bytes prost writes, in the same order, for the messages that carry
//! documents: `Document`, `BatchGetDocumentsResponse` and `RunQueryResponse`.
//! Every other message, and every request, keeps prost's own encoding.

use std::any::Any;
use std::borrow::Cow;
use std::marker::PhantomData;

use firenook_core_store::{EncodedDocument, StoredToken};
use prost::Message;
use prost::bytes::BufMut;
use prost::encoding::{
    DecodeContext, WireType, encode_key, encode_varint, encoded_len_varint, key_len,
};
use tonic::Status;
use tonic::codec::{BufferSettings, Codec, EncodeBuf, Encoder};
use tonic_prost::ProstDecoder;

use crate::codec::encode_timestamp;
use crate::google::firestore::v1::{self as proto, value::ValueType};

/// The codec the generated Firestore client and server use.
#[derive(Debug, Clone)]
pub(crate) struct FirestoreCodec<T, U> {
    _types: PhantomData<(T, U)>,
}

impl<T, U> Default for FirestoreCodec<T, U> {
    fn default() -> Self {
        Self {
            _types: PhantomData,
        }
    }
}

impl<T, U> Codec for FirestoreCodec<T, U>
where
    T: Message + Send + 'static,
    U: Message + Default + Send + 'static,
{
    type Encode = T;
    type Decode = U;
    type Encoder = FirestoreEncoder<T>;
    type Decoder = ProstDecoder<U>;

    fn encoder(&mut self) -> Self::Encoder {
        FirestoreEncoder { _item: PhantomData }
    }

    fn decoder(&mut self) -> Self::Decoder {
        ProstDecoder::new(BufferSettings::default())
    }
}

/// Encodes one message of the codec.
#[derive(Debug, Clone)]
pub(crate) struct FirestoreEncoder<T> {
    _item: PhantomData<T>,
}

impl<T: Message + 'static> Encoder for FirestoreEncoder<T> {
    type Item = T;
    type Error = Status;

    fn encode(&mut self, item: T, buf: &mut EncodeBuf<'_>) -> Result<(), Status> {
        encode_message(&item, buf);
        Ok(())
    }

    fn buffer_settings(&self) -> BufferSettings {
        BufferSettings::default()
    }
}

/// Writes `message` exactly as prost would.
pub(crate) fn encode_message<T: Message + 'static>(message: &T, buf: &mut impl BufMut) {
    let any: &dyn Any = message;
    if let Some(document) = any.downcast_ref::<proto::Document>() {
        DocumentEncoder::measure(document).write_document(document, buf);
    } else if let Some(response) = any.downcast_ref::<proto::RunQueryResponse>() {
        encode_run_query(response, buf);
    } else {
        message.encode_raw(buf);
    }
}

/// prost writes fields in tag order: the document (1), then everything else.
fn encode_run_query(response: &proto::RunQueryResponse, buf: &mut impl BufMut) {
    let Some(document) = &response.document else {
        response.encode_raw(buf);
        return;
    };
    DocumentEncoder::measure(document).write_field(1, document, buf);
    proto::RunQueryResponse {
        transaction: response.transaction.clone(),
        document: None,
        read_time: response.read_time,
        skipped_results: response.skipped_results,
        explain_metrics: response.explain_metrics.clone(),
        continuation_selector: response.continuation_selector,
    }
    .encode_raw(buf);
}

/// A document's encoded lengths, measured once in the order they are
/// written: the document's own, then for every value its message length and,
/// for a map or an array, the length of that map or array.
struct DocumentEncoder {
    lengths: Vec<usize>,
    next: usize,
}

impl DocumentEncoder {
    fn measure(document: &proto::Document) -> Self {
        let mut encoder = Self {
            lengths: Vec::with_capacity(document.fields.len().saturating_mul(4) + 1),
            next: 0,
        };
        encoder.lengths.push(0);
        let mut len = 0;
        if !document.name.is_empty() {
            len += prost::encoding::string::encoded_len(1, &document.name);
        }
        len += encoder.measure_fields(2, &document.fields);
        if let Some(time) = &document.create_time {
            len += prost::encoding::message::encoded_len(3, time);
        }
        if let Some(time) = &document.update_time {
            len += prost::encoding::message::encoded_len(4, time);
        }
        encoder.lengths[0] = len;
        encoder
    }

    /// The length of a map field `tag` of entries `fields`, measuring each
    /// entry's value on the way.
    fn measure_fields(
        &mut self,
        tag: u32,
        fields: &std::collections::BTreeMap<String, proto::Value>,
    ) -> usize {
        let mut len = 0;
        for (key, value) in fields {
            let value_len = self.measure_value(value);
            let entry = entry_len(key, value, value_len);
            len += key_len(tag) + encoded_len_varint(entry as u64) + entry;
        }
        len
    }

    /// The length of `value` as a message, its own slot first.
    fn measure_value(&mut self, value: &proto::Value) -> usize {
        let slot = self.lengths.len();
        self.lengths.push(0);
        let len = match &value.value_type {
            None => 0,
            Some(ValueType::MapValue(map)) => {
                let inner_slot = self.lengths.len();
                self.lengths.push(0);
                let inner = self.measure_fields(1, &map.fields);
                self.lengths[inner_slot] = inner;
                key_len(6) + encoded_len_varint(inner as u64) + inner
            }
            Some(ValueType::ArrayValue(array)) => {
                let inner_slot = self.lengths.len();
                self.lengths.push(0);
                let mut inner = 0;
                for value in &array.values {
                    let value_len = self.measure_value(value);
                    inner += key_len(1) + encoded_len_varint(value_len as u64) + value_len;
                }
                self.lengths[inner_slot] = inner;
                key_len(9) + encoded_len_varint(inner as u64) + inner
            }
            Some(value_type) => value_type.encoded_len(),
        };
        self.lengths[slot] = len;
        len
    }

    fn take(&mut self) -> usize {
        let len = self.lengths[self.next];
        self.next += 1;
        len
    }

    /// The document as the field `tag` of an enclosing message.
    fn write_field(mut self, tag: u32, document: &proto::Document, buf: &mut impl BufMut) {
        encode_key(tag, WireType::LengthDelimited, buf);
        encode_varint(self.lengths[0] as u64, buf);
        self.write_body(document, buf);
    }

    /// The document as a message of its own.
    fn write_document(mut self, document: &proto::Document, buf: &mut impl BufMut) {
        self.write_body(document, buf);
    }

    fn write_body(&mut self, document: &proto::Document, buf: &mut impl BufMut) {
        self.take();
        if !document.name.is_empty() {
            prost::encoding::string::encode(1, &document.name, buf);
        }
        self.write_fields(2, &document.fields, buf);
        if let Some(time) = &document.create_time {
            prost::encoding::message::encode(3, time, buf);
        }
        if let Some(time) = &document.update_time {
            prost::encoding::message::encode(4, time, buf);
        }
    }

    /// prost's map encoding: each entry a message of the key (unless empty)
    /// and the value (unless it is the default value).
    fn write_fields(
        &mut self,
        tag: u32,
        fields: &std::collections::BTreeMap<String, proto::Value>,
        buf: &mut impl BufMut,
    ) {
        for (key, value) in fields {
            let value_len = self.lengths[self.next];
            let entry = entry_len(key, value, value_len);
            encode_key(tag, WireType::LengthDelimited, buf);
            encode_varint(entry as u64, buf);
            if !key.is_empty() {
                prost::encoding::string::encode(1, key, buf);
            }
            if value.value_type.is_some() {
                encode_key(2, WireType::LengthDelimited, buf);
                encode_varint(value_len as u64, buf);
            }
            self.write_value(value, buf);
        }
    }

    /// The fields of `value`, its length already written by the caller.
    fn write_value(&mut self, value: &proto::Value, buf: &mut impl BufMut) {
        self.take();
        match &value.value_type {
            None => {}
            Some(ValueType::MapValue(map)) => {
                let inner = self.take();
                encode_key(6, WireType::LengthDelimited, buf);
                encode_varint(inner as u64, buf);
                self.write_fields(1, &map.fields, buf);
            }
            Some(ValueType::ArrayValue(array)) => {
                let inner = self.take();
                encode_key(9, WireType::LengthDelimited, buf);
                encode_varint(inner as u64, buf);
                for value in &array.values {
                    encode_key(1, WireType::LengthDelimited, buf);
                    encode_varint(self.lengths[self.next] as u64, buf);
                    self.write_value(value, buf);
                }
            }
            Some(value_type) => value_type.encode(buf),
        }
    }
}

/// A map entry's length: the key unless it is empty, the value unless it is
/// the default (unset) value, exactly as prost decides.
fn entry_len(key: &str, value: &proto::Value, value_len: usize) -> usize {
    let key = if key.is_empty() {
        0
    } else {
        key_len(1) + encoded_len_varint(key.len() as u64) + key.len()
    };
    let value = if value.value_type.is_none() {
        0
    } else {
        key_len(2) + encoded_len_varint(value_len as u64) + value_len
    };
    key + value
}

/// `google.firestore.v1.BatchGetDocumentsResponse`, written by hand in place
/// of the generated type (`build.rs` maps it here) so that a found document
/// can travel already encoded, transcoded straight from its stored bytes.
#[derive(Clone, PartialEq, Default, Debug)]
pub struct BatchGetDocumentsResponse {
    /// The transaction a `new_transaction` read started, in the first
    /// response only.
    pub transaction: Vec<u8>,
    /// When the document was read.
    pub read_time: Option<pbjson_types::Timestamp>,
    /// The document or the name of the one that does not exist.
    pub result: Option<batch_get_documents_response::Result>,
}

/// The result oneof of [`BatchGetDocumentsResponse`].
pub mod batch_get_documents_response {
    /// A single result.
    #[derive(Clone, PartialEq, Debug)]
    pub enum Result {
        /// A document that was requested.
        Found(super::FoundDocument),
        /// The name of a requested document that does not exist.
        Missing(String),
    }
}

/// A found document: decoded, or already the encoding of a
/// `google.firestore.v1.Document`.
#[derive(Clone, PartialEq, Debug)]
pub enum FoundDocument {
    Decoded(proto::Document),
    Encoded(Vec<u8>),
}

impl FoundDocument {
    /// The document, decoded first when it travels encoded.
    pub fn document(&self) -> Result<Cow<'_, proto::Document>, prost::DecodeError> {
        match self {
            Self::Decoded(document) => Ok(Cow::Borrowed(document)),
            Self::Encoded(bytes) => proto::Document::decode(bytes.as_slice()).map(Cow::Owned),
        }
    }
}

impl Message for BatchGetDocumentsResponse {
    // In tag order, as prost writes generated messages: the result, the
    // transaction, the read time.
    fn encode_raw(&self, buf: &mut impl BufMut) {
        match &self.result {
            Some(batch_get_documents_response::Result::Found(FoundDocument::Encoded(bytes))) => {
                encode_key(1, WireType::LengthDelimited, buf);
                encode_varint(bytes.len() as u64, buf);
                buf.put_slice(bytes);
            }
            Some(batch_get_documents_response::Result::Found(FoundDocument::Decoded(document))) => {
                DocumentEncoder::measure(document).write_field(1, document, buf);
            }
            Some(batch_get_documents_response::Result::Missing(name)) => {
                prost::encoding::string::encode(2, name, buf);
            }
            None => {}
        }
        if !self.transaction.is_empty() {
            prost::encoding::bytes::encode(3, &self.transaction, buf);
        }
        if let Some(time) = &self.read_time {
            prost::encoding::message::encode(4, time, buf);
        }
    }

    fn merge_field(
        &mut self,
        tag: u32,
        wire_type: WireType,
        buf: &mut impl prost::bytes::Buf,
        ctx: DecodeContext,
    ) -> Result<(), prost::DecodeError> {
        match tag {
            1 => {
                let mut document = match self.result.take() {
                    Some(batch_get_documents_response::Result::Found(found)) => {
                        found.document()?.into_owned()
                    }
                    _ => proto::Document::default(),
                };
                prost::encoding::message::merge(wire_type, &mut document, buf, ctx)?;
                self.result = Some(batch_get_documents_response::Result::Found(
                    FoundDocument::Decoded(document),
                ));
                Ok(())
            }
            2 => {
                let mut name = match self.result.take() {
                    Some(batch_get_documents_response::Result::Missing(name)) => name,
                    _ => String::new(),
                };
                prost::encoding::string::merge(wire_type, &mut name, buf, ctx)?;
                self.result = Some(batch_get_documents_response::Result::Missing(name));
                Ok(())
            }
            3 => prost::encoding::bytes::merge(wire_type, &mut self.transaction, buf, ctx),
            4 => prost::encoding::message::merge(
                wire_type,
                self.read_time.get_or_insert_with(Default::default),
                buf,
                ctx,
            ),
            _ => prost::encoding::skip_field(wire_type, tag, buf, ctx),
        }
    }

    fn encoded_len(&self) -> usize {
        let result = match &self.result {
            Some(batch_get_documents_response::Result::Found(FoundDocument::Encoded(bytes))) => {
                key_len(1) + encoded_len_varint(bytes.len() as u64) + bytes.len()
            }
            Some(batch_get_documents_response::Result::Found(FoundDocument::Decoded(document))) => {
                prost::encoding::message::encoded_len(1, document)
            }
            Some(batch_get_documents_response::Result::Missing(name)) => {
                prost::encoding::string::encoded_len(2, name)
            }
            None => 0,
        };
        let transaction = if self.transaction.is_empty() {
            0
        } else {
            prost::encoding::bytes::encoded_len(3, &self.transaction)
        };
        result
            + transaction
            + self
                .read_time
                .as_ref()
                .map_or(0, |time| prost::encoding::message::encoded_len(4, time))
    }

    fn clear(&mut self) {
        *self = Self::default();
    }
}

/// The JSON form the generated type had, for the REST transport.
impl serde::Serialize for BatchGetDocumentsResponse {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::{Error as _, SerializeStruct as _};
        let len = usize::from(!self.transaction.is_empty())
            + usize::from(self.read_time.is_some())
            + usize::from(self.result.is_some());
        let mut fields =
            serializer.serialize_struct("google.firestore.v1.BatchGetDocumentsResponse", len)?;
        if !self.transaction.is_empty() {
            #[allow(deprecated)]
            let transaction = pbjson::private::base64::encode(&self.transaction);
            fields.serialize_field("transaction", transaction.as_str())?;
        }
        if let Some(time) = &self.read_time {
            fields.serialize_field("readTime", time)?;
        }
        match &self.result {
            Some(batch_get_documents_response::Result::Found(found)) => {
                let document = found.document().map_err(S::Error::custom)?;
                fields.serialize_field("found", document.as_ref())?;
            }
            Some(batch_get_documents_response::Result::Missing(name)) => {
                fields.serialize_field("missing", name)?;
            }
            None => {}
        }
        fields.end()
    }
}

/// The encoding of a stored document as a `google.firestore.v1.Document`
/// named `name`, written straight from its stored bytes: exactly what
/// decoding it and encoding the result writes, without building either
/// form. Two walks over its tokens: one measures every value, bottom-up,
/// the other writes.
pub(crate) fn encode_stored_document(
    name: &str,
    document: &EncodedDocument,
) -> Result<Vec<u8>, Status> {
    let mut tokens = Vec::new();
    let (fields, create_time, update_time) = document
        .tokens(&mut tokens)
        .map_err(|error| Status::internal(format!("stored document does not decode: {error}")))?;
    let create_time = encode_timestamp(create_time);
    let update_time = encode_timestamp(update_time);
    let mut transcoder = Transcoder {
        tokens: &tokens,
        next: 0,
        lengths: Vec::with_capacity(tokens.len()),
        slot: 0,
    };
    let fields_len = transcoder.measure_entries(fields, 2)?;
    let name_len = if name.is_empty() {
        0
    } else {
        length_delimited(1, name.len())
    };
    let len = name_len
        + fields_len
        + prost::encoding::message::encoded_len(3, &create_time)
        + prost::encoding::message::encoded_len(4, &update_time);
    let mut buf = Vec::with_capacity(len);
    if !name.is_empty() {
        write_bytes(1, name.as_bytes(), &mut buf);
    }
    transcoder.next = 0;
    transcoder.write_entries(fields, 2, &mut buf);
    prost::encoding::message::encode(3, &create_time, &mut buf);
    prost::encoding::message::encode(4, &update_time, &mut buf);
    debug_assert_eq!(buf.len(), len);
    Ok(buf)
}

/// The two walks of [`encode_stored_document`]. `lengths` holds, in the
/// order the write walk needs them, the message length of every value and
/// the length of every map's and array's own message.
struct Transcoder<'t, 'a> {
    tokens: &'t [StoredToken<'a>],
    next: usize,
    lengths: Vec<usize>,
    slot: usize,
}

const VECTOR_TYPE_KEY: &str = "__type__";
const VECTOR_TYPE: &str = "__vector__";
const VECTOR_VALUES_KEY: &str = "value";

fn length_delimited(tag: u32, len: usize) -> usize {
    key_len(tag) + encoded_len_varint(len as u64) + len
}

impl<'a> Transcoder<'_, 'a> {
    fn token(&mut self) -> Result<StoredToken<'a>, Status> {
        let token = self
            .tokens
            .get(self.next)
            .copied()
            .ok_or_else(|| Status::internal("stored document ends early"))?;
        self.next += 1;
        Ok(token)
    }

    /// `count` map entries (`Key`, value) as repeated entry messages of
    /// field `tag`; the same rules as prost's map encoding.
    fn measure_entries(&mut self, count: usize, tag: u32) -> Result<usize, Status> {
        let mut len = 0;
        for _ in 0..count {
            let StoredToken::Key(key) = self.token()? else {
                return Err(Status::internal("stored map entry has no key"));
            };
            let key_len = if key.is_empty() {
                0
            } else {
                length_delimited(1, key.len())
            };
            let value = self.measure_value()?;
            len += length_delimited(tag, key_len + length_delimited(2, value));
        }
        Ok(len)
    }

    /// One value's message length; its slot comes first, then its map's or
    /// array's.
    fn measure_value(&mut self) -> Result<usize, Status> {
        let slot = self.lengths.len();
        self.lengths.push(0);
        let len = match self.token()? {
            // `NullValue(0)` on field 11, a boolean on field 1: one varint byte.
            StoredToken::Null => key_len(11) + 1,
            StoredToken::Boolean(_) => key_len(1) + 1,
            StoredToken::Integer(value) => key_len(2) + encoded_len_varint(value.cast_unsigned()),
            StoredToken::Double(_) => key_len(3) + 8,
            StoredToken::Timestamp(time) => {
                length_delimited(10, encode_timestamp(time).encoded_len())
            }
            StoredToken::String(value) => length_delimited(17, value.len()),
            StoredToken::Bytes(value) => length_delimited(18, value.len()),
            StoredToken::Reference(value) => length_delimited(5, value.len()),
            StoredToken::GeoPoint {
                latitude,
                longitude,
            } => length_delimited(8, lat_lng(latitude, longitude).encoded_len()),
            StoredToken::Array(count) => {
                let inner_slot = self.lengths.len();
                self.lengths.push(0);
                let mut inner = 0;
                for _ in 0..count {
                    let value = self.measure_value()?;
                    inner += length_delimited(1, value);
                }
                self.lengths[inner_slot] = inner;
                length_delimited(9, inner)
            }
            StoredToken::Map(count) => {
                let inner_slot = self.lengths.len();
                self.lengths.push(0);
                let inner = self.measure_entries(count, 1)?;
                self.lengths[inner_slot] = inner;
                length_delimited(6, inner)
            }
            StoredToken::Vector(count) => {
                for _ in 0..count {
                    let StoredToken::Double(_) = self.token()? else {
                        return Err(Status::internal("stored vector holds a non-double"));
                    };
                }
                length_delimited(6, vector_map_len(count))
            }
            StoredToken::Key(_) => {
                return Err(Status::internal("stored key where a value belongs"));
            }
        };
        self.lengths[slot] = len;
        Ok(len)
    }

    fn take(&mut self) -> usize {
        let len = self.lengths[self.slot];
        self.slot += 1;
        len
    }

    fn write_entries(&mut self, count: usize, tag: u32, buf: &mut Vec<u8>) {
        for _ in 0..count {
            let Some(StoredToken::Key(key)) = self.tokens.get(self.next).copied() else {
                unreachable!("the measuring walk checked every entry's key");
            };
            self.next += 1;
            let value = self.lengths[self.slot];
            let key_len = if key.is_empty() {
                0
            } else {
                length_delimited(1, key.len())
            };
            encode_key(tag, WireType::LengthDelimited, buf);
            encode_varint((key_len + length_delimited(2, value)) as u64, buf);
            if !key.is_empty() {
                encode_key(1, WireType::LengthDelimited, buf);
                encode_varint(key.len() as u64, buf);
                buf.put_slice(key.as_bytes());
            }
            encode_key(2, WireType::LengthDelimited, buf);
            encode_varint(value as u64, buf);
            self.write_value(buf);
        }
    }

    fn write_value(&mut self, buf: &mut Vec<u8>) {
        self.take();
        let token = self.tokens[self.next];
        self.next += 1;
        match token {
            StoredToken::Null => ValueType::NullValue(0).encode(buf),
            StoredToken::Boolean(value) => ValueType::BooleanValue(value).encode(buf),
            StoredToken::Integer(value) => ValueType::IntegerValue(value).encode(buf),
            StoredToken::Double(value) => ValueType::DoubleValue(value).encode(buf),
            StoredToken::Timestamp(time) => {
                ValueType::TimestampValue(encode_timestamp(time)).encode(buf);
            }
            StoredToken::String(value) => write_bytes(17, value.as_bytes(), buf),
            StoredToken::Bytes(value) => write_bytes(18, value, buf),
            StoredToken::Reference(value) => write_bytes(5, value.as_bytes(), buf),
            StoredToken::GeoPoint {
                latitude,
                longitude,
            } => ValueType::GeoPointValue(lat_lng(latitude, longitude)).encode(buf),
            StoredToken::Array(count) => {
                let inner = self.take();
                encode_key(9, WireType::LengthDelimited, buf);
                encode_varint(inner as u64, buf);
                for _ in 0..count {
                    encode_key(1, WireType::LengthDelimited, buf);
                    encode_varint(self.lengths[self.slot] as u64, buf);
                    self.write_value(buf);
                }
            }
            StoredToken::Map(count) => {
                let inner = self.take();
                encode_key(6, WireType::LengthDelimited, buf);
                encode_varint(inner as u64, buf);
                self.write_entries(count, 1, buf);
            }
            StoredToken::Vector(count) => {
                encode_key(6, WireType::LengthDelimited, buf);
                encode_varint(vector_map_len(count) as u64, buf);
                // `__type__: "__vector__"`, then `value: [doubles]`, in key order.
                let type_value = length_delimited(17, VECTOR_TYPE.len());
                encode_key(1, WireType::LengthDelimited, buf);
                encode_varint(
                    (length_delimited(1, VECTOR_TYPE_KEY.len()) + length_delimited(2, type_value))
                        as u64,
                    buf,
                );
                write_bytes(1, VECTOR_TYPE_KEY.as_bytes(), buf);
                encode_key(2, WireType::LengthDelimited, buf);
                encode_varint(type_value as u64, buf);
                write_bytes(17, VECTOR_TYPE.as_bytes(), buf);
                let array = length_delimited(9, count * length_delimited(1, key_len(3) + 8));
                encode_key(1, WireType::LengthDelimited, buf);
                encode_varint(
                    (length_delimited(1, VECTOR_VALUES_KEY.len()) + length_delimited(2, array))
                        as u64,
                    buf,
                );
                write_bytes(1, VECTOR_VALUES_KEY.as_bytes(), buf);
                encode_key(2, WireType::LengthDelimited, buf);
                encode_varint(array as u64, buf);
                encode_key(9, WireType::LengthDelimited, buf);
                encode_varint((count * length_delimited(1, key_len(3) + 8)) as u64, buf);
                for _ in 0..count {
                    let StoredToken::Double(value) = self.tokens[self.next] else {
                        unreachable!("the measuring walk checked every vector member");
                    };
                    self.next += 1;
                    encode_key(1, WireType::LengthDelimited, buf);
                    encode_varint((key_len(3) + 8) as u64, buf);
                    ValueType::DoubleValue(value).encode(buf);
                }
            }
            StoredToken::Key(_) => unreachable!("the measuring walk checked every value"),
        }
    }
}

fn write_bytes(tag: u32, value: &[u8], buf: &mut Vec<u8>) {
    encode_key(tag, WireType::LengthDelimited, buf);
    encode_varint(value.len() as u64, buf);
    buf.put_slice(value);
}

const fn lat_lng(latitude: f64, longitude: f64) -> crate::google::r#type::LatLng {
    crate::google::r#type::LatLng {
        latitude,
        longitude,
    }
}

/// A vector's `MapValue`: `__type__: "__vector__"` and `value` holding an
/// array of `count` doubles, each a field-3 double of one key byte.
fn vector_map_len(count: usize) -> usize {
    let type_entry = length_delimited(1, VECTOR_TYPE_KEY.len())
        + length_delimited(2, length_delimited(17, VECTOR_TYPE.len()));
    let array = length_delimited(9, count * length_delimited(1, key_len(3) + 8));
    let values_entry = length_delimited(1, VECTOR_VALUES_KEY.len()) + length_delimited(2, array);
    length_delimited(1, type_entry) + length_delimited(1, values_entry)
}

#[cfg(test)]
mod tests;
