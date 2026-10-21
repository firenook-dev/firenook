//! The one-pass encoder must write exactly prost's bytes for every document
//! and response, however its values nest.

use std::collections::BTreeMap;

use prost::Message;

use super::encode_message;
use crate::google::firestore::v1::{
    self as proto, ArrayValue, MapValue, batch_get_documents_response, run_query_response,
    value::ValueType,
};

/// A small deterministic generator, so a failure reproduces from its seed.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }
}

fn text(random: &mut Lcg) -> String {
    match random.below(5) {
        0 => String::new(),
        1 => "k".repeat(usize::try_from(random.below(300)).unwrap()),
        _ => format!("f{}", random.below(50)),
    }
}

fn timestamp(random: &mut Lcg) -> pbjson_types::Timestamp {
    pbjson_types::Timestamp {
        seconds: i64::try_from(random.below(1 << 40)).unwrap() - (1 << 39),
        nanos: i32::try_from(random.below(1_000_000_000)).unwrap(),
    }
}

#[allow(clippy::cast_possible_wrap, clippy::cast_precision_loss)]
fn value(random: &mut Lcg, depth: u32) -> proto::Value {
    let leaf = depth >= 5 || random.below(3) == 0;
    let value_type = match random.below(if leaf { 11 } else { 14 }) {
        0 => None,
        1 => Some(ValueType::NullValue(0)),
        2 => Some(ValueType::BooleanValue(random.below(2) == 0)),
        3 => Some(ValueType::IntegerValue(
            (random.next() << 31) as i64 - (1 << 62),
        )),
        4 => Some(ValueType::DoubleValue(random.next() as f64 / 7.0 - 1e6)),
        5 => Some(ValueType::TimestampValue(timestamp(random))),
        6 => Some(ValueType::StringValue(text(random))),
        7 => Some(ValueType::BytesValue(text(random).into_bytes())),
        8 => Some(ValueType::ReferenceValue(text(random))),
        9 => Some(ValueType::GeoPointValue(crate::google::r#type::LatLng {
            latitude: random.next() as f64 / 1e7,
            longitude: -(random.next() as f64) / 1e7,
        })),
        10 => Some(ValueType::FieldReferenceValue(text(random))),
        11 => Some(ValueType::ArrayValue(ArrayValue {
            values: (0..random.below(6))
                .map(|_| value(random, depth + 1))
                .collect(),
        })),
        _ => Some(ValueType::MapValue(MapValue {
            fields: fields(random, depth + 1),
        })),
    };
    proto::Value { value_type }
}

fn fields(random: &mut Lcg, depth: u32) -> BTreeMap<String, proto::Value> {
    (0..random.below(if depth == 0 { 40 } else { 8 }))
        .map(|_| (text(random), value(random, depth)))
        .collect()
}

fn document(random: &mut Lcg) -> proto::Document {
    proto::Document {
        name: text(random),
        fields: fields(random, 0),
        create_time: (random.below(3) != 0).then(|| timestamp(random)),
        update_time: (random.below(3) != 0).then(|| timestamp(random)),
    }
}

fn ours<T: Message + 'static>(message: &T) -> Vec<u8> {
    let mut bytes = Vec::new();
    encode_message(message, &mut bytes);
    bytes
}

#[test]
fn documents_encode_exactly_as_prost_encodes_them() {
    for seed in 0..400_u64 {
        let mut random = Lcg(seed);
        let document = document(&mut random);
        assert_eq!(
            ours(&document),
            document.encode_to_vec(),
            "seed {seed}: {document:?}"
        );
        assert_eq!(
            proto::Document::decode(ours(&document).as_slice()).unwrap(),
            document
        );
    }
}

#[test]
fn responses_carrying_documents_encode_exactly_as_prost_encodes_them() {
    for seed in 0..300_u64 {
        let mut random = Lcg(seed.wrapping_add(1_000));
        let transaction = if random.below(2) == 0 {
            Vec::new()
        } else {
            text(&mut random).into_bytes()
        };
        let read_time = (random.below(2) == 0).then(|| timestamp(&mut random));
        let batch = proto::BatchGetDocumentsResponse {
            transaction: transaction.clone(),
            read_time,
            result: match random.below(3) {
                0 => None,
                1 => Some(batch_get_documents_response::Result::Missing(text(
                    &mut random,
                ))),
                _ => Some(batch_get_documents_response::Result::Found(document(
                    &mut random,
                ))),
            },
        };
        assert_eq!(ours(&batch), batch.encode_to_vec(), "seed {seed}");
        let query = proto::RunQueryResponse {
            transaction,
            document: (random.below(4) != 0).then(|| document(&mut random)),
            read_time,
            skipped_results: i32::try_from(random.below(3)).unwrap(),
            explain_metrics: (random.below(4) == 0).then(|| proto::ExplainMetrics {
                plan_summary: None,
                execution_stats: Some(proto::ExecutionStats {
                    results_returned: i64::try_from(random.below(100)).unwrap(),
                    ..proto::ExecutionStats::default()
                }),
            }),
            continuation_selector: (random.below(2) == 0)
                .then_some(run_query_response::ContinuationSelector::Done(true)),
        };
        assert_eq!(ours(&query), query.encode_to_vec(), "seed {seed}");
    }
}

#[test]
fn other_messages_keep_prost_encoding() {
    let request = proto::GetDocumentRequest {
        name: "projects/p/databases/(default)/documents/a/b".to_owned(),
        ..proto::GetDocumentRequest::default()
    };
    assert_eq!(ours(&request), request.encode_to_vec());
}
