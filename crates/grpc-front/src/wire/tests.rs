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
                _ => Some(batch_get_documents_response::Result::Found(
                    crate::wire::FoundDocument::Decoded(document(&mut random)),
                )),
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

/// A core value of every kind, nested a few levels.
#[allow(clippy::cast_possible_wrap, clippy::cast_precision_loss)]
fn core_value(random: &mut Lcg, depth: u32) -> firenook_core_store::Value {
    use firenook_core_store::{Timestamp, Value};
    let leaf = depth >= 4 || random.below(3) == 0;
    match random.below(if leaf { 11 } else { 13 }) {
        0 => Value::Null,
        1 => Value::Boolean(random.below(2) == 0),
        2 => Value::Integer((random.next() << 31) as i64 - (1 << 62)),
        3 => Value::Double(match random.below(4) {
            0 => f64::NAN,
            1 => -0.0,
            _ => random.next() as f64 / 7.0 - 1e6,
        }),
        4 => Value::Timestamp(
            Timestamp::new(
                i64::try_from(random.below(1 << 40)).unwrap() - (1 << 39),
                u32::try_from(random.below(1_000_000_000)).unwrap(),
            )
            .unwrap(),
        ),
        5 => Value::String(text(random).into()),
        6 => Value::Bytes(text(random).into_bytes().into()),
        7 => Value::Reference(
            format!(
                "projects/demo-wire/databases/(default)/documents/c/{}",
                text(random)
            )
            .into(),
        ),
        8 => Value::GeoPoint {
            latitude: if random.below(3) == 0 {
                -0.0
            } else {
                random.next() as f64 / 1e7
            },
            longitude: if random.below(3) == 0 {
                0.0
            } else {
                -(random.next() as f64) / 1e7
            },
        },
        9 => Value::Vector((0..random.below(5)).map(|i| i as f64 - 1.5).collect()),
        10 => Value::String(String::new().into()),
        11 => Value::Array(
            (0..random.below(6))
                .map(|_| core_value(random, depth + 1))
                .collect(),
        ),
        _ => Value::Map(core_fields(random, depth + 1)),
    }
}

fn core_fields(random: &mut Lcg, depth: u32) -> firenook_core_store::Fields {
    (0..random.below(if depth == 0 { 30 } else { 7 }))
        .map(|_| (text(random), core_value(random, depth)))
        .collect()
}

#[test]
fn stored_documents_transcode_to_exactly_their_decoded_encoding() {
    use firenook_core_store::{
        DatabaseName, DiskOptions, DocumentKey, LazyDocument, Precondition, Store, Write,
    };
    let directory = std::env::temp_dir().join(format!(
        "firenook-wire-transcode-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let store = Store::open_disk(&directory, DiskOptions::default()).unwrap();
    let database = DatabaseName::new("demo-wire", "(default)").unwrap();
    let mut random = Lcg(77);
    let keys = (0..200)
        .map(|index| DocumentKey::new(database.clone(), format!("docs/d{index}")).unwrap())
        .collect::<Vec<_>>();
    let writes = keys
        .iter()
        .map(|key| Write::Set {
            key: key.clone(),
            fields: core_fields(&mut random, 0),
            transforms: Vec::new(),
            precondition: Precondition::None,
        })
        .collect::<Vec<_>>();
    store.commit(&writes).unwrap();
    let snapshot = store.snapshot();
    for key in &keys {
        let Some(LazyDocument::Encoded(encoded)) = snapshot.get_lazy(key) else {
            panic!("a disk snapshot reads documents encoded");
        };
        let decoded = encoded.decode().unwrap();
        let expected = crate::codec::encode_document_masked(key, &decoded, None)
            .unwrap()
            .encode_to_vec();
        assert_eq!(
            super::encode_stored_document(&key.to_string(), &encoded).unwrap(),
            expected,
            "{key}"
        );
    }
    drop(snapshot);
    drop(store);
    let _ = std::fs::remove_dir_all(&directory);
}

/// The generated layout of `BatchGetDocumentsResponse`, for comparison with
/// the hand-written one.
#[derive(Clone, PartialEq, prost::Message)]
struct GeneratedBatchGet {
    #[prost(oneof = "GeneratedResult", tags = "1, 2")]
    result: Option<GeneratedResult>,
    #[prost(bytes = "vec", tag = "3")]
    transaction: Vec<u8>,
    #[prost(message, optional, tag = "4")]
    read_time: Option<pbjson_types::Timestamp>,
}

#[derive(Clone, PartialEq, prost::Oneof)]
enum GeneratedResult {
    #[prost(message, tag = "1")]
    Found(proto::Document),
    #[prost(string, tag = "2")]
    Missing(String),
}

#[test]
fn the_batch_response_writes_and_reads_the_generated_layout() {
    use crate::wire::FoundDocument;
    for seed in 0..200_u64 {
        let mut random = Lcg(seed.wrapping_add(5_000));
        let transaction = if random.below(2) == 0 {
            Vec::new()
        } else {
            text(&mut random).into_bytes()
        };
        let read_time = (random.below(2) == 0).then(|| timestamp(&mut random));
        let (ours_result, generated_result) = match random.below(3) {
            0 => (None, None),
            1 => {
                let name = text(&mut random);
                (
                    Some(batch_get_documents_response::Result::Missing(name.clone())),
                    Some(GeneratedResult::Missing(name)),
                )
            }
            _ => {
                let document = document(&mut random);
                (
                    Some(batch_get_documents_response::Result::Found(
                        FoundDocument::Decoded(document.clone()),
                    )),
                    Some(GeneratedResult::Found(document)),
                )
            }
        };
        let response = proto::BatchGetDocumentsResponse {
            transaction: transaction.clone(),
            read_time,
            result: ours_result,
        };
        let generated = GeneratedBatchGet {
            result: generated_result,
            transaction,
            read_time,
        };
        let bytes = generated.encode_to_vec();
        assert_eq!(ours(&response), bytes, "seed {seed}");
        assert_eq!(response.encoded_len(), bytes.len(), "seed {seed}");
        assert_eq!(
            proto::BatchGetDocumentsResponse::decode(bytes.as_slice()).unwrap(),
            response,
            "seed {seed}"
        );
        // The same document already encoded travels unchanged.
        if let Some(batch_get_documents_response::Result::Found(FoundDocument::Decoded(document))) =
            &response.result
        {
            let encoded = proto::BatchGetDocumentsResponse {
                result: Some(batch_get_documents_response::Result::Found(
                    FoundDocument::Encoded(document.encode_to_vec()),
                )),
                ..response.clone()
            };
            assert_eq!(ours(&encoded), bytes, "seed {seed}");
            assert_eq!(encoded.encoded_len(), bytes.len(), "seed {seed}");
        }
    }
}

#[test]
fn the_batch_response_keeps_its_json_form() {
    use crate::wire::FoundDocument;
    let document = proto::Document {
        name: "projects/p/databases/(default)/documents/a/b".to_owned(),
        ..proto::Document::default()
    };
    let response = proto::BatchGetDocumentsResponse {
        transaction: vec![1, 2, 3],
        read_time: Some(pbjson_types::Timestamp {
            seconds: 5,
            nanos: 6,
        }),
        result: Some(batch_get_documents_response::Result::Found(
            FoundDocument::Encoded(document.encode_to_vec()),
        )),
    };
    let json = serde_json::to_value(&response).unwrap();
    assert_eq!(json["transaction"], "AQID");
    assert_eq!(
        json["readTime"],
        serde_json::to_value(response.read_time).unwrap()
    );
    assert_eq!(json["found"], serde_json::to_value(&document).unwrap());
    let missing = proto::BatchGetDocumentsResponse {
        result: Some(batch_get_documents_response::Result::Missing(
            "m".to_owned(),
        )),
        ..proto::BatchGetDocumentsResponse::default()
    };
    assert_eq!(
        serde_json::to_value(&missing).unwrap(),
        serde_json::json!({ "missing": "m" })
    );
}
