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
use std::marker::PhantomData;

use prost::Message;
use prost::bytes::BufMut;
use prost::encoding::{WireType, encode_key, encode_varint, encoded_len_varint, key_len};
use tonic::Status;
use tonic::codec::{BufferSettings, Codec, EncodeBuf, Encoder};
use tonic_prost::ProstDecoder;

use crate::google::firestore::v1::{self as proto, batch_get_documents_response, value::ValueType};

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
    } else if let Some(response) = any.downcast_ref::<proto::BatchGetDocumentsResponse>() {
        encode_batch_get(response, buf);
    } else if let Some(response) = any.downcast_ref::<proto::RunQueryResponse>() {
        encode_run_query(response, buf);
    } else {
        message.encode_raw(buf);
    }
}

/// prost writes fields in tag order: the document (`found`, 1), then the
/// transaction and the read time.
fn encode_batch_get(response: &proto::BatchGetDocumentsResponse, buf: &mut impl BufMut) {
    let Some(batch_get_documents_response::Result::Found(document)) = &response.result else {
        response.encode_raw(buf);
        return;
    };
    DocumentEncoder::measure(document).write_field(1, document, buf);
    proto::BatchGetDocumentsResponse {
        transaction: response.transaction.clone(),
        read_time: response.read_time,
        result: None,
    }
    .encode_raw(buf);
}

/// In tag order too: the document (1), then everything else.
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

#[cfg(test)]
mod tests;
