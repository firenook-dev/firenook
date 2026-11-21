//! A double a client writes through Firestore's JSON surfaces keeps every
//! bit. Clients send a double as a JSON number in its shortest form (the web
//! SDK's `JSON.stringify` writes the fewest digits that read back as the same
//! double), so the number must be read correctly rounded; the official
//! emulator stores each one unchanged.
//!
//! Each value is written through REST (a `PATCH`) and through `WebChannel` (a
//! Write stream), then read back through REST (the JSON encoder) and over
//! gRPC (the service's protobuf answer), all on one store as the CLI and the
//! suite compose them. Bits are compared, not values, and the test reads the
//! REST answer's numbers with the standard library's parser, so the parser
//! under test is not also the judge.

use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::header::CONTENT_TYPE;
use axum::http::{Request, StatusCode};
use firenook_core_store::Store;
use firenook_functions_bridge::TriggerRegistry;
use firenook_grpc_front::FirestoreService;
use firenook_grpc_front::google::firestore::v1::GetDocumentRequest;
use firenook_grpc_front::google::firestore::v1::firestore_server::Firestore as _;
use firenook_grpc_front::google::firestore::v1::value::ValueType;
use firenook_query_engine::{DatabaseEdition, QueryPolicy};
use firenook_rest_front::router_with_shared_service as rest_router;
use firenook_rules_runtime::RulesRuntime;
use firenook_webchannel_front::{
    FirestoreBackend, WRITE_CHANNEL_PATH, router as webchannel_router,
};
use http_body_util::BodyExt as _;
use serde_json::Value;
use tower::ServiceExt as _;

const DATABASE: &str = "projects/demo/databases/(default)";
const COLLECTION: &str = "doubles";
/// Values per document, as one array field.
const PER_DOCUMENT: usize = 500;
/// The value a client was seen to write and read back one unit in the last
/// place lower.
const OBSERVED: f64 = -6.394_884_621_840_902e-14;
const RANDOM: usize = 4_000;
const COMPUTED: u32 = 1_000;
const WAIT: Duration = Duration::from_secs(10);

/// Every value the test writes: the observed one, a few boundaries, random
/// finite bit patterns and computed decimals of the kind a layout produces.
fn values() -> Vec<f64> {
    let mut values = vec![
        OBSERVED,
        0.1,
        1.0 / 3.0,
        5e-324,
        f64::MIN_POSITIVE,
        f64::MAX,
        -f64::MAX,
        1e21,
        1e-7,
        2f64.powi(63),
        2f64.powi(64),
        123_456_789_012_345_680_000.0,
    ];
    // SplitMix64, so the run is the same every time.
    let mut state: u64 = 0x5EED_F10A_7000_0001;
    while values.len() < 12 + RANDOM {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut bits = state;
        bits = (bits ^ (bits >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        bits = (bits ^ (bits >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        bits ^= bits >> 31;
        let value = f64::from_bits(bits);
        // `JSON.stringify` writes negative zero as `0`.
        if value.is_finite() && value.to_bits() != (-0.0f64).to_bits() {
            values.push(value);
        }
    }
    values.extend((0..COMPUTED).map(|step| f64::from(step) * 0.0175 / 3.0 - 37.0));
    values
}

/// `value` as JavaScript's `JSON.stringify` writes it: the shortest digits
/// that read back as `value` (which Rust's `{:e}` prints too), laid out by
/// ECMAScript's `Number::toString`. Where a value lies exactly halfway
/// between two shortest forms, JavaScript takes the even last digit and Rust
/// the higher one (2 of the values here); both read back as the value.
fn javascript(value: f64) -> String {
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').expect("scientific form");
    let digits = mantissa.replace('.', "");
    let count = i32::try_from(digits.len()).expect("few digits");
    let point = exponent.parse::<i32>().expect("exponent") + 1;
    let at = |index: i32| usize::try_from(index).expect("in range");
    let body = if count <= point && point <= 21 {
        format!("{digits}{}", "0".repeat(at(point - count)))
    } else if 0 < point && point <= 21 {
        format!("{}.{}", &digits[..at(point)], &digits[at(point)..])
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat(at(-point)))
    } else {
        let fraction = if count == 1 {
            String::new()
        } else {
            format!(".{}", &digits[1..])
        };
        let sign = if point > 0 { '+' } else { '-' };
        format!("{}{fraction}e{sign}{}", &digits[..1], (point - 1).abs())
    };
    if value.is_sign_negative() {
        format!("-{body}")
    } else {
        body
    }
}

/// A document's fields as a client sends them: one array of doubles, each
/// number written exactly as `javascript` gives it.
fn fields(values: &[f64]) -> String {
    let numbers = values
        .iter()
        .map(|value| format!(r#"{{"doubleValue":{}}}"#, javascript(*value)))
        .collect::<Vec<_>>()
        .join(",");
    format!(r#"{{"values":{{"arrayValue":{{"values":[{numbers}]}}}}}}"#)
}

/// Firestore's product HTTP router (REST beside `WebChannel` over one
/// service) and the service gRPC answers from, on one in-memory store.
fn product() -> (Router, FirestoreService) {
    let store = Store::default();
    let query_policy = QueryPolicy::new(DatabaseEdition::Standard);
    let rules = RulesRuntime::default();
    let service = FirestoreService::new_with_query_policy_and_rules(
        store.clone(),
        query_policy.clone(),
        rules.clone(),
    );
    let router = rest_router(
        store,
        query_policy,
        None,
        rules,
        TriggerRegistry::default(),
        service.clone(),
    )
    .merge(webchannel_router(FirestoreBackend::new(service.clone())));
    (router, service)
}

async fn send(application: &Router, request: Request<Body>) -> (StatusCode, String) {
    let response = application
        .clone()
        .oneshot(request)
        .await
        .expect("the router answers");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("the body reads")
        .to_bytes();
    (status, String::from_utf8(bytes.to_vec()).expect("UTF-8"))
}

async fn write_rest(application: &Router, documents: &[(String, &[f64])]) {
    for (id, values) in documents {
        let (status, body) = send(
            application,
            Request::patch(format!("/v1/{DATABASE}/documents/{COLLECTION}/{id}"))
                .header(CONTENT_TYPE, "application/json")
                .header("authorization", "Bearer owner")
                .body(Body::from(format!(r#"{{"fields":{}}}"#, fields(values))))
                .expect("request builds"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "REST PATCH {id}: {body}");
    }
}

/// The arrays of a channel answer: length-prefixed frames, each a JSON
/// array of `[array id, payload]`.
fn arrays(text: &str) -> Vec<(u64, Value)> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some((length, after)) = rest.split_once('\n') {
        let length = length.trim().parse::<usize>().expect("frame length");
        // The frames here are ASCII, so UTF-16 units are bytes.
        let (frame, tail) = after.split_at(length);
        let frame: Value = serde_json::from_str(frame).expect("a frame holds JSON");
        for array in frame.as_array().expect("arrays") {
            found.push((array[0].as_u64().expect("array id"), array[1].clone()));
        }
        rest = tail;
    }
    found
}

/// One browser session on the Write channel.
struct Channel<'a> {
    application: &'a Router,
    database: String,
    sid: String,
    aid: u64,
    rid: u64,
}

impl<'a> Channel<'a> {
    async fn open(application: &'a Router) -> Self {
        let database =
            url::form_urlencoded::byte_serialize(DATABASE.as_bytes()).collect::<String>();
        let mut handshake = url::form_urlencoded::Serializer::new(String::new());
        handshake.append_pair("headers", "Authorization:Bearer owner\r\n");
        handshake.append_pair("count", "1");
        handshake.append_pair("ofs", "0");
        handshake.append_pair("req0___data__", &format!(r#"{{"database":"{DATABASE}"}}"#));
        let (status, body) = send(
            application,
            Request::post(format!(
                "{WRITE_CHANNEL_PATH}?VER=8&database={database}&RID=1&CVER=22&X-HTTP-Session-Id=gsessionid&t=1"
            ))
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from(handshake.finish()))
            .expect("request builds"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "handshake: {body}");
        let (_, created) = arrays(&body).into_iter().next().expect("session created");
        let sid = created[1].as_str().expect("SID");
        Self {
            application,
            database,
            sid: url::form_urlencoded::byte_serialize(sid.as_bytes()).collect(),
            aid: 0,
            rid: 2,
        }
    }

    /// One backchannel poll: the messages it carried.
    async fn poll(&mut self) -> Vec<Value> {
        let (status, body) = send(
            self.application,
            Request::get(format!(
                "{WRITE_CHANNEL_PATH}?VER=8&database={}&RID=rpc&SID={}&AID={}&CI=1&TYPE=xmlhttp&t=1",
                self.database, self.sid, self.aid
            ))
            .body(Body::empty())
            .expect("request builds"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "backchannel: {body}");
        let mut messages = Vec::new();
        for (id, payload) in arrays(&body) {
            self.aid = id;
            messages.extend(payload.as_array().into_iter().flatten().cloned());
        }
        messages
    }

    /// Polls until a message holds `field`.
    async fn wait_for(&mut self, field: &str) -> Value {
        tokio::time::timeout(WAIT, async {
            loop {
                for message in self.poll().await {
                    assert!(
                        message.get("error").is_none(),
                        "the stream failed: {message}"
                    );
                    if message.get(field).is_some() {
                        return message;
                    }
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("a message with {field} arrives"))
    }

    async fn send(&mut self, message: &str) {
        let mut forward = url::form_urlencoded::Serializer::new(String::new());
        forward.append_pair("count", "1");
        forward.append_pair("ofs", &(self.rid - 1).to_string());
        forward.append_pair("req0___data__", message);
        let (status, body) = send(
            self.application,
            Request::post(format!(
                "{WRITE_CHANNEL_PATH}?VER=8&database={}&SID={}&RID={}&AID={}&t=1",
                self.database, self.sid, self.rid, self.aid
            ))
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from(forward.finish()))
            .expect("request builds"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "forward: {body}");
        self.rid += 1;
    }
}

/// The browser's Write stream: the handshake's stream token, then every
/// update in one request.
async fn write_webchannel(application: &Router, documents: &[(String, &[f64])]) {
    let mut channel = Channel::open(application).await;
    let token = channel.wait_for("streamToken").await["streamToken"]
        .as_str()
        .expect("stream token")
        .to_owned();
    let writes = documents
        .iter()
        .map(|(id, values)| {
            format!(
                r#"{{"update":{{"name":"{DATABASE}/documents/{COLLECTION}/{id}","fields":{}}}}}"#,
                fields(values)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    channel
        .send(&format!(
            r#"{{"streamToken":"{token}","writes":[{writes}]}}"#
        ))
        .await;
    let results = channel.wait_for("writeResults").await;
    assert_eq!(
        results["writeResults"].as_array().map(Vec::len),
        Some(documents.len()),
        "one result per update"
    );
}

/// The doubles of a REST answer, in order, each parsed by the standard
/// library from the number's own text.
fn rest_doubles(body: &str) -> Vec<f64> {
    let key = r#""doubleValue":"#;
    body.match_indices(key)
        .map(|(start, _)| {
            let text = body[start + key.len()..].trim_start();
            let end = text
                .find(|character: char| {
                    !matches!(character, '0'..='9' | '-' | '+' | '.' | 'e' | 'E')
                })
                .unwrap_or(text.len());
            text[..end].parse::<f64>().unwrap_or_else(|_| {
                panic!(
                    "a JSON number: {}",
                    text.chars().take(24).collect::<String>()
                )
            })
        })
        .collect()
}

async fn read_rest(application: &Router, id: &str) -> Vec<f64> {
    let (status, body) = send(
        application,
        Request::get(format!("/v1/{DATABASE}/documents/{COLLECTION}/{id}"))
            .header("authorization", "Bearer owner")
            .body(Body::empty())
            .expect("request builds"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "REST GET {id}: {body}");
    rest_doubles(&body)
}

async fn read_grpc(service: &FirestoreService, id: &str) -> Vec<f64> {
    let mut request = tonic::Request::new(GetDocumentRequest {
        name: format!("{DATABASE}/documents/{COLLECTION}/{id}"),
        ..GetDocumentRequest::default()
    });
    request
        .metadata_mut()
        .insert("authorization", "Bearer owner".parse().expect("metadata"));
    let document = service
        .get_document(request)
        .await
        .expect("the document reads")
        .into_inner();
    let Some(ValueType::ArrayValue(array)) = &document.fields["values"].value_type else {
        panic!("{id}: values is an array");
    };
    array
        .values
        .iter()
        .map(|value| match value.value_type {
            Some(ValueType::DoubleValue(double)) => double,
            ref other => panic!("{id}: a double, not {other:?}"),
        })
        .collect()
}

/// Writes every value through `path`, reads each document back both ways,
/// and lists each value whose bits changed.
async fn round_trip(path: &str) -> Vec<String> {
    let (application, service) = product();
    let values = values();
    let documents = values
        .chunks(PER_DOCUMENT)
        .enumerate()
        .map(|(index, chunk)| (format!("{path}-{index}"), chunk))
        .collect::<Vec<_>>();
    match path {
        "rest" => write_rest(&application, &documents).await,
        _ => write_webchannel(&application, &documents).await,
    }
    let mut changed = Vec::new();
    for (id, written) in &documents {
        for (read, answer) in [
            ("REST", read_rest(&application, id).await),
            ("gRPC", read_grpc(&service, id).await),
        ] {
            assert_eq!(answer.len(), written.len(), "{id} over {read}: every value");
            for (sent, got) in written.iter().zip(answer) {
                if sent.to_bits() != got.to_bits() {
                    changed.push(format!(
                        "{read}: wrote {} read {}",
                        javascript(*sent),
                        javascript(got)
                    ));
                }
            }
        }
    }
    changed
}

fn assert_unchanged(path: &str, changed: &[String]) {
    let values = values().len();
    let over = |read: &str| changed.iter().filter(|line| line.starts_with(read)).count();
    assert!(
        changed.is_empty(),
        "of {values} doubles written through {path}, {} read back changed over REST and {} over gRPC, for example:\n{}",
        over("REST"),
        over("gRPC"),
        changed
            .iter()
            .take(6)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn the_values_are_written_as_javascript_writes_them() {
    for (value, text) in [
        (OBSERVED, "-6.394884621840902e-14"),
        (0.1, "0.1"),
        (1e21, "1e+21"),
        (1e-7, "1e-7"),
        (5e-324, "5e-324"),
        (2f64.powi(63), "9223372036854776000"),
        (123_456_789_012_345_680_000.0, "123456789012345680000"),
        (-37.0, "-37"),
        (0.000_001, "0.000001"),
    ] {
        assert_eq!(javascript(value), text);
    }
    for value in values() {
        assert_eq!(
            javascript(value).parse::<f64>().map(f64::to_bits),
            Ok(value.to_bits()),
            "{value:e}"
        );
    }
}

#[tokio::test]
async fn doubles_written_over_rest_keep_their_bits() {
    assert_unchanged("REST", &round_trip("rest").await);
}

#[tokio::test]
async fn doubles_written_over_webchannel_keep_their_bits() {
    assert_unchanged("WebChannel", &round_trip("webchannel").await);
}
