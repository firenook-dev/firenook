//! Replays the official emulator's Requests recordings
//! (`conformance/fixtures/developer-tools-request-metadata-v1` and
//! `developer-tools-request-values-v1`) through the code that serves them in
//! the suite: each recorded REST request goes to the real Firestore REST
//! router and store, the rules runtime records its evaluations, and the
//! evaluations are read from the real `/requests` WebSocket, the protocol the
//! official Emulator UI's Requests view reads (Firenook serves it unchanged
//! beside its own console, `support/console-parity.md`).
//!
//! Each operation's case is its HTTP answer and how many evaluation messages
//! it produced; each message's case is the evaluation object itself.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::http::Request;
use firenook_conformance_ledger::{self as ledger, Compared};
use firenook_core_store::{Store, StoreOptions};
use firenook_rules_runtime::RulesRuntime;
use firenook_rules_runtime::request_history::RequestHistory;
use futures_util::StreamExt as _;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use tower::ServiceExt as _;

const METADATA_SET: &str = "developer-tools-request-metadata-v1";
const VALUES_SET: &str = "developer-tools-request-values-v1";

/// Cases another replay already notes: compared here too, not noted twice.
/// `rest-front` notes the typed create's status and rounded timestamp; its
/// evaluation count differs here exactly as the metadata recording's
/// create-typed does, which this replay notes.
const NOTED_ELSEWHERE: &[(&str, &str)] = &[(VALUES_SET, "operations/create-typed")];

/// Recorded messages Firenook answers otherwise with no documented reason.
/// The replay asserts each still differs as described; whoever fixes one
/// moves it out of this table and the replay notes it in the ledger.
const BUG_CANDIDATES: &[(&str, &str, &str)] = &[
    (METADATA_SET, "messages/5", LIST_RESOURCE),
    (METADATA_SET, "messages/6", LIST_RESOURCE),
    (METADATA_SET, "messages/7", LIST_RESOURCE),
    (METADATA_SET, "messages/8", LIST_RESOURCE),
    (METADATA_SET, "messages/9", LIST_RESOURCE_NAME),
    (VALUES_SET, "messages/5", LIST_RESOURCE),
];
const LIST_RESOURCE: &str = "a query's evaluation reports `resource` as {\"undefined\":{}}; the official emulator reports the query's resource, {\"mapValue\":{\"fields\":{\"data\":{\"mapValue\":{}}}}}";
const LIST_RESOURCE_NAME: &str = "a query's evaluation reports `resource` as {\"undefined\":{}}; the official emulator reports the query's resource with its name constraint, {\"mapValue\":{\"fields\":{\"data\":{\"mapValue\":{}},\"__name__\":{\"constraintValue\":{}}}}}";

// The documented reasons a recorded answer differs.
const LAZY_RESOURCE: &str = "Firenook reports the document the evaluation had (`resource`, `request.resource`) where the official emulator's lazy context reports {\"undefined\":{}} for a document it did not load (DESIGN.md, Opt-in evaluation producer and typed context)";
const PRELIMINARY_WRITE: &str = "Firenook evaluates a write once, as the create or update it is, where the official emulator also sends a preliminary create or update check (DESIGN.md: the producer evaluates once; fixture README: not permission to manufacture additional evaluations)";
const SHARED_OUTCOMES: &str = "a write's granular outcomes are its own evaluation's; the official emulator's update event also carries its preliminary check's outcome (DESIGN.md, Allow-decision instrumentation: no duplicated entries imitating the jar's shared mutable history)";
const RUN_QUERY_DONE: &str =
    "a runQuery stream ends without \"done\": true, as production's does (COMPATIBILITY.md)";
const DENIED_TEXT: &str = "a refusal's message is production's `Missing or insufficient permissions.` followed by the official emulator's text on the next line (COMPATIBILITY.md)";
const OWN_WORDS: &str = "the REST error message is Firenook's own words for the same status and code (COMPATIBILITY.md: most error messages are Firenook's own words)";

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// One case's verdict.
enum Outcome {
    Checked(Compared),
    Differs(Compared, Vec<&'static str>),
    Bug(&'static str),
}

struct Replay {
    fixture: Value,
    project: String,
    history: RequestHistory,
    rest: axum::Router,
    socket: Socket,
    _shutdown: watch::Sender<bool>,
    seen: usize,
    transactions: BTreeMap<String, String>,
    request_ids: BTreeSet<String>,
}

impl Replay {
    async fn start(fixture: &str) -> Self {
        let fixture: Value = serde_json::from_str(fixture).expect("fixture");
        let project = fixture["project"].as_str().expect("project").to_owned();
        let history = RequestHistory::default();
        let runtime = RulesRuntime::with_request_history(history.clone());
        runtime
            .install_project(&project, fixture["rules"].as_str().expect("rules"))
            .expect("recorded rules compile");
        let rest = firenook_rest_front::router_with_query_policy_memory_and_rules(
            Store::new(StoreOptions::default()),
            firenook_query_engine::QueryPolicy::default(),
            None,
            runtime,
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let url = format!("ws://{}/requests", listener.local_addr().expect("address"));
        let (shutdown, receiver) = watch::channel(false);
        let requests = crate::requests_router(Some(history.clone()), receiver);
        tokio::spawn(async move {
            axum::serve(listener, requests).await.expect("serve");
        });
        let (socket, _) = connect_async(&url).await.expect("Requests handshake");
        Self {
            fixture,
            project,
            history,
            rest,
            socket,
            _shutdown: shutdown,
            seen: 0,
            transactions: BTreeMap::new(),
            request_ids: BTreeSet::new(),
        }
    }

    async fn frame(&mut self) -> Value {
        let frame = tokio::time::timeout(Duration::from_secs(30), self.socket.next())
            .await
            .expect("Requests frame deadline")
            .expect("open socket")
            .expect("valid frame");
        serde_json::from_str(frame.to_text().expect("text frame")).expect("JSON frame")
    }

    /// How many evaluations the history holds: the first frame a new
    /// subscriber receives is the retained history, so the live socket is
    /// read for exactly the evaluations an operation added, with no waiting
    /// for frames that will not come.
    async fn retained(&self) -> usize {
        let mut subscription = self.history.subscribe().expect("history");
        let frame = subscription.recv().await.expect("history frame");
        serde_json::from_str::<Value>(frame.text())
            .expect("history JSON")
            .as_array()
            .expect("history array")
            .len()
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        body: &Value,
        auth: Option<&str>,
    ) -> (u16, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(format!(
                "/v1/projects/{}/databases/(default)/documents{path}",
                self.project
            ))
            .header("content-type", "application/json");
        if let Some(auth) = auth {
            request = request.header("authorization", auth);
        }
        let body = if body.is_null() {
            Body::empty()
        } else {
            Body::from(body.to_string())
        };
        let response = self
            .rest
            .clone()
            .oneshot(request.body(body).expect("request"))
            .await
            .expect("response");
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| panic!("non-JSON answer {}", String::from_utf8_lossy(&bytes)));
        (status, value)
    }

    /// The stored document as the Admin SDK reads it; the owner bypasses
    /// the rules, so this read adds no evaluation.
    async fn stored(&self, path: &str) -> Option<Value> {
        let (status, body) = self
            .send("GET", path, &Value::Null, Some("Bearer owner"))
            .await;
        (status == 200).then_some(body)
    }
}

#[tokio::test]
async fn request_metadata_oracle_replays_through_rest_and_the_requests_socket() {
    replay(
        METADATA_SET,
        include_str!(
            "../../../conformance/fixtures/developer-tools-request-metadata-v1/fixture.json"
        ),
    )
    .await;
}

#[tokio::test]
async fn request_values_oracle_replays_through_rest_and_the_requests_socket() {
    replay(
        VALUES_SET,
        include_str!(
            "../../../conformance/fixtures/developer-tools-request-values-v1/fixture.json"
        ),
    )
    .await;
}

/// What one recorded operation did in Firenook.
struct Run {
    status: u16,
    answer: Value,
    /// The evaluations it added to the Requests feed, as the socket sent them.
    events: Vec<Value>,
    /// The document it reads or writes, as stored before and after it.
    before: Option<Value>,
    after: Option<Value>,
}

impl Replay {
    /// The document an operation reads or writes, for its evaluations'
    /// `resource` and `request.resource`: in its path, or named in a
    /// commit's or batchGet's body. A query reads no one document.
    fn document(&self, operation: &Value) -> Option<String> {
        let path = operation["path"].as_str().expect("path");
        let prefix = format!("projects/{}/databases/(default)/documents", self.project);
        let named = operation["body"]["writes"][0]["update"]["name"]
            .as_str()
            .or_else(|| operation["body"]["documents"][0].as_str())
            .map(|name| {
                name.strip_prefix(&prefix)
                    .expect("named document")
                    .to_owned()
            });
        match path.split(['?', ':']).next().expect("path") {
            _ if path.contains(":runQuery") => None,
            "" => named,
            document => Some(document.to_owned()),
        }
    }

    async fn run(&mut self, operation: &Value, messages: &[Value]) -> Run {
        let id = operation["id"].as_str().expect("id");
        let document = self.document(operation);
        let before = match &document {
            Some(document) => self.stored(document).await,
            None => None,
        };
        let mut body = operation["body"].clone();
        if let Some(recorded) = body.get("transaction").and_then(Value::as_str) {
            // A transaction handle the recording's begin answered; Firenook's
            // own begin answered another one.
            body["transaction"] = json!(self.transactions[recorded]);
        }
        let auth = (operation["authenticated"] == true)
            .then(|| bearer(&messages[index(&operation["firstMessage"])]));
        let (status, answer) = self
            .send(
                operation["method"].as_str().expect("method"),
                operation["path"].as_str().expect("path"),
                &body,
                auth.as_deref(),
            )
            .await;
        if let (Some(recorded), Some(actual)) = (
            operation["response"]["transaction"].as_str(),
            answer["transaction"].as_str(),
        ) {
            self.transactions
                .insert(recorded.to_owned(), actual.to_owned());
        }
        let after = match &document {
            Some(document) => self.stored(document).await,
            None => None,
        };
        let total = self.retained().await;
        let mut events = Vec::new();
        for _ in self.seen..total {
            events.push(self.frame().await);
        }
        self.seen = total;
        for event in &events {
            let request_id = event["requestId"].as_str().expect("requestId");
            assert!(
                self.request_ids.insert(request_id.to_owned()),
                "{id}: request ids are unique"
            );
        }
        Run {
            status,
            answer,
            events,
            before,
            after,
        }
    }
}

fn index(value: &Value) -> usize {
    usize::try_from(value.as_u64().expect("message index")).expect("message index")
}

async fn replay(set: &'static str, fixture: &str) {
    let mut replay = Replay::start(fixture).await;
    let mut outcomes: Vec<(String, Outcome)> = Vec::new();

    // messages/0: the history a new reader receives first.
    let first = replay.frame().await;
    assert_eq!(first, replay.fixture["messages"][0], "initial history");
    outcomes.push(("messages/0".into(), Outcome::Checked(Compared::Answer)));

    let operations = replay.fixture["operations"]
        .as_array()
        .expect("operations")
        .clone();
    let messages = replay.fixture["messages"]
        .as_array()
        .expect("messages")
        .clone();
    for operation in &operations {
        let id = operation["id"].as_str().expect("id");
        let run = replay.run(operation, &messages).await;
        let first = index(&operation["firstMessage"]);
        let recorded_events = &messages[first..index(&operation["endMessage"])];
        outcomes.push((
            format!("operations/{id}"),
            compare_operation(
                operation,
                run.status,
                &run.answer,
                run.events.len(),
                recorded_events,
            ),
        ));
        for (index, outcome) in compare_events(
            id,
            recorded_events,
            &run.events,
            run.before.as_ref(),
            run.after.as_ref(),
        ) {
            outcomes.push((format!("messages/{}", first + index), outcome));
        }
    }
    assert_eq!(replay.seen, replay.request_ids.len());
    // Every recorded message and operation was compared.
    assert_eq!(outcomes.len(), messages.len() + operations.len());
    note(set, &outcomes);
}

/// Notes each compared case, and asserts the bug candidates are exactly the
/// listed ones.
fn note(set: &'static str, outcomes: &[(String, Outcome)]) {
    let mut bugs = BTreeSet::new();
    for (case, outcome) in outcomes {
        if NOTED_ELSEWHERE.contains(&(set, case.as_str())) {
            continue;
        }
        match outcome {
            Outcome::Checked(compared) => ledger::checked(set, case, *compared),
            Outcome::Differs(compared, reasons) => {
                ledger::differs(set, case, *compared, &reasons.join("; "));
            }
            Outcome::Bug(description) => {
                assert!(
                    BUG_CANDIDATES.contains(&(set, case.as_str(), *description)),
                    "{set} {case}: undocumented difference: {description}"
                );
                bugs.insert(case.clone());
            }
        }
    }
    let listed = BUG_CANDIDATES
        .iter()
        .filter(|(table, _, _)| *table == set)
        .map(|(_, case, _)| (*case).to_owned())
        .collect::<BTreeSet<_>>();
    assert_eq!(bugs, listed, "every listed bug candidate still differs");
}

/// An operation's recorded answer: its status, its body and how many
/// evaluation messages it produced.
fn compare_operation(
    operation: &Value,
    status: u16,
    answer: &Value,
    evaluations: usize,
    recorded_events: &[Value],
) -> Outcome {
    let id = &operation["id"];
    assert_eq!(
        u64::from(status),
        operation["status"].as_u64().expect("status"),
        "{id}: {answer}"
    );
    let recorded = normalized_answer(operation["response"].clone());
    let mut actual = normalized_answer(answer.clone());
    let mut reasons = Vec::new();
    let compared = if (200..300).contains(&status) {
        // Firenook's last runQuery element lacks the official `done`.
        if let (Some(recorded), Some(actual)) = (recorded.as_array(), actual.as_array_mut())
            && recorded.last().is_some_and(|last| last["done"] == true)
            && let Some(last) = actual.last_mut()
            && last.get("done").is_none()
        {
            last["done"] = json!(true);
            reasons.push(RUN_QUERY_DONE);
        }
        assert_eq!(actual, recorded, "{id}: answer");
        Compared::Answer
    } else {
        let (recorded, actual) = (&recorded["error"], &actual["error"]);
        assert_eq!(actual["code"], recorded["code"], "{id}");
        assert_eq!(actual["status"], recorded["status"], "{id}");
        let (recorded_text, actual_text) = (
            recorded["message"].as_str().expect("message"),
            actual["message"].as_str().expect("message"),
        );
        if actual_text != recorded_text {
            if recorded["status"] == "PERMISSION_DENIED" {
                assert_eq!(
                    actual_text,
                    format!("Missing or insufficient permissions.\n{recorded_text}"),
                    "{id}"
                );
                reasons.push(DENIED_TEXT);
            } else {
                // The same document is named, in Firenook's words.
                assert_eq!(recorded["status"], "NOT_FOUND", "{id}: {actual_text}");
                let name = recorded_text
                    .split(['(', ')'])
                    .nth(1)
                    .expect("recorded name");
                assert!(actual_text.contains(name), "{id}: {actual_text}");
                reasons.push(OWN_WORDS);
            }
        }
        Compared::Error
    };
    if evaluations != recorded_events.len() {
        assert!(
            is_write_pair(recorded_events),
            "{id}: {evaluations} evaluations"
        );
        assert_eq!(evaluations, 1, "{id}");
        reasons.push(PRELIMINARY_WRITE);
    }
    if reasons.is_empty() {
        Outcome::Checked(compared)
    } else {
        Outcome::Differs(compared, reasons)
    }
}

/// The official emulator's pair for one write: a create check, then an update.
fn is_write_pair(events: &[Value]) -> bool {
    events.len() == 2
        && events[0]["rulesContext"]["method"] == "create"
        && events[1]["rulesContext"]["method"] == "update"
}

/// Pairs an operation's recorded evaluations with Firenook's and compares
/// each pair; answers each recorded message's outcome by its index in the
/// operation.
fn compare_events(
    id: &str,
    recorded: &[Value],
    actual: &[Value],
    before: Option<&Value>,
    after: Option<&Value>,
) -> Vec<(usize, Outcome)> {
    if recorded.len() == actual.len() {
        return recorded
            .iter()
            .zip(actual)
            .enumerate()
            .map(|(index, (recorded, actual))| {
                (
                    index,
                    compare_event(id, recorded, actual, None, before, after),
                )
            })
            .collect();
    }
    assert!(is_write_pair(recorded), "{id}: unpaired evaluations");
    assert_eq!(actual.len(), 1, "{id}");
    let method = actual[0]["rulesContext"]["method"]
        .as_str()
        .expect("method");
    // Firenook's one evaluation is the create (new document) or the update
    // (existing one); the official emulator's other one is its preliminary
    // check, which Firenook does not manufacture.
    let (paired, extra) = match (method, before.is_some()) {
        ("create", false) => (0, 1),
        ("update", true) => (1, 0),
        other => panic!("{id}: unexpected write evaluation {other:?}"),
    };
    vec![
        (
            paired,
            compare_event(
                id,
                &recorded[paired],
                &actual[0],
                Some(&recorded[extra]),
                before,
                after,
            ),
        ),
        (
            extra,
            Outcome::Differs(Compared::Behaviour, vec![PRELIMINARY_WRITE]),
        ),
    ]
}

fn compare_event(
    id: &str,
    recorded: &Value,
    actual: &Value,
    preliminary: Option<&Value>,
    before: Option<&Value>,
    after: Option<&Value>,
) -> Outcome {
    let mut recorded = normalized_event(recorded.clone());
    let actual = normalized_event(actual.clone());
    let mut reasons = Vec::new();
    let mut bug = None;
    let method = actual["rulesContext"]["method"].as_str().expect("method");
    let undefined = json!({"undefined": {}});

    // The outer `resource`: the document before a write, the one read by a
    // read; a query's is the query's resource.
    let resource = &actual["rulesContext"]["resource"];
    if recorded["rulesContext"]["resource"] != *resource {
        if method == "list" {
            let fields = &recorded["rulesContext"]["resource"]["mapValue"]["fields"];
            assert_eq!(*resource, undefined, "{id}");
            assert_eq!(fields["data"], json!({"mapValue": {}}), "{id}");
            bug = Some(if fields.get("__name__").is_some() {
                assert_eq!(fields["__name__"], json!({"constraintValue": {}}), "{id}");
                LIST_RESOURCE_NAME
            } else {
                LIST_RESOURCE
            });
        } else {
            assert_eq!(recorded["rulesContext"]["resource"], undefined, "{id}");
            let current = if method == "get" { after } else { before };
            assert_eq!(
                Some(resource),
                current.map(rules_resource).as_ref(),
                "{id}: Firenook reports the stored document"
            );
            reasons.push(LAZY_RESOURCE);
        }
        recorded["rulesContext"]["resource"] = resource.clone();
    }
    // A write's `request.resource`: the document as the write leaves it.
    if let Some(request_resource) =
        actual["rulesContext"]["request"]["mapValue"]["fields"].get("resource")
    {
        let recorded_request_resource =
            &mut recorded["rulesContext"]["request"]["mapValue"]["fields"]["resource"];
        if recorded_request_resource != request_resource {
            assert_eq!(*recorded_request_resource, undefined, "{id}");
            assert_eq!(
                Some(request_resource),
                after.map(rules_resource).as_ref(),
                "{id}: Firenook reports the written document"
            );
            recorded_request_resource.clone_from(request_resource);
            if !reasons.contains(&LAZY_RESOURCE) {
                reasons.push(LAZY_RESOURCE);
            }
        }
    }
    if recorded["granularAllowOutcomes"] != actual["granularAllowOutcomes"] {
        let preliminary = preliminary.expect("only a write pair shares outcomes");
        let mut shared = preliminary["granularAllowOutcomes"]
            .as_array()
            .expect("outcomes")
            .clone();
        shared.extend(
            actual["granularAllowOutcomes"]
                .as_array()
                .expect("outcomes")
                .iter()
                .cloned(),
        );
        assert_eq!(recorded["granularAllowOutcomes"], json!(shared), "{id}");
        recorded["granularAllowOutcomes"] = actual["granularAllowOutcomes"].clone();
        reasons.push(SHARED_OUTCOMES);
    }
    assert_eq!(actual, recorded, "{id}: evaluation");
    match (bug, reasons.is_empty()) {
        (Some(description), true) => Outcome::Bug(description),
        (Some(description), false) => panic!("{id}: {description} beside {reasons:?}"),
        (None, true) => Outcome::Checked(Compared::Answer),
        (None, false) => Outcome::Differs(Compared::Answer, reasons),
    }
}

/// Values that differ on every run, in an HTTP answer: document and commit
/// times (the recording kept `<request-time>`) and transaction handles.
fn normalized_answer(value: Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(key, value)| {
                    let value = match key.as_str() {
                        "createTime" | "updateTime" | "readTime" | "commitTime" => {
                            assert!(value.is_string(), "{key}: {value}");
                            json!("<request-time>")
                        }
                        "transaction" => {
                            assert!(value.as_str().is_some_and(|handle| !handle.is_empty()));
                            json!("<transaction>")
                        }
                        _ => normalized_answer(value),
                    };
                    (key, value)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(normalized_answer).collect()),
        other => other,
    }
}

/// Values that differ on every run, in an evaluation: the request time (the
/// recording kept `<request-time>`), the request id (the recording renumbered
/// its own; Firenook's are process-scoped unique ids, checked unique above)
/// and the opaque release suffix after `cloud.firestore` (the recording kept
/// `<release-id>`; Firenook's is a hash of the rules, DESIGN.md).
fn normalized_event(mut event: Value) -> Value {
    for path in [
        &["time"][..],
        &["rulesContext", "time"],
        &[
            "rulesContext",
            "request",
            "mapValue",
            "fields",
            "time",
            "timestampValue",
        ],
    ] {
        let time = path.iter().fold(&mut event, |value, key| &mut value[*key]);
        assert!(time.is_string(), "request time {time}");
        *time = json!("<request-time>");
    }
    assert!(event["requestId"].as_str().is_some_and(|id| !id.is_empty()));
    event["requestId"] = json!("<request-id>");
    let release = event["rulesReleaseKey"].as_str().expect("release");
    let (prefix, suffix) = release
        .split_once("cloud.firestore")
        .expect("release names cloud.firestore");
    assert!(!suffix.is_empty(), "{release}");
    event["rulesReleaseKey"] = json!(format!("{prefix}cloud.firestore<release-id>"));
    event
}

/// A REST document as the Requests context shows a resource.
fn rules_resource(document: &Value) -> Value {
    let name = document["name"].as_str().expect("name");
    let fields = document["fields"].as_object().cloned().unwrap_or_default();
    json!({"mapValue": {"fields": {
        "data": rules_map(&fields),
        "__name__": rules_path(name),
        "id": {"stringValue": name.rsplit('/').next().expect("id")},
    }}})
}

fn rules_map(fields: &serde_json::Map<String, Value>) -> Value {
    if fields.is_empty() {
        return json!({"mapValue": {}});
    }
    json!({"mapValue": {"fields": fields
        .iter()
        .map(|(key, value)| (key.clone(), rules_value(value)))
        .collect::<serde_json::Map<_, _>>()}})
}

fn rules_path(name: &str) -> Value {
    let path = &name[name.find("/databases/").map_or(0, |index| index + 1)..];
    json!({"pathValue": {"segments": path
        .split('/')
        .map(|segment| json!({"simple": segment}))
        .collect::<Vec<_>>()}})
}

/// A REST value as the Requests context types it.
fn rules_value(value: &Value) -> Value {
    let (kind, inner) = value
        .as_object()
        .and_then(|object| object.iter().next())
        .expect("typed value");
    match kind.as_str() {
        "nullValue" => json!({"nullValue": null}),
        "booleanValue" => json!({"boolValue": inner}),
        "integerValue" => json!({"intValue": inner}),
        "doubleValue" => json!({"floatValue": inner}),
        "stringValue" | "bytesValue" | "timestampValue" => {
            Value::Object(serde_json::Map::from_iter([(kind.clone(), inner.clone())]))
        }
        "referenceValue" => rules_path(inner.as_str().expect("reference")),
        "geoPointValue" => json!({"latlngValue": inner}),
        "arrayValue" => match inner["values"].as_array() {
            Some(values) if !values.is_empty() => {
                json!({"listValue": {"values": values.iter().map(rules_value).collect::<Vec<_>>()}})
            }
            _ => json!({"listValue": {}}),
        },
        "mapValue" => rules_map(&inner["fields"].as_object().cloned().unwrap_or_default()),
        other => panic!("uncaptured value type {other}"),
    }
}

/// The ID token the recording sent: its decoded claims are in the
/// evaluation it produced (the recording kept no credential), unsigned, as
/// the official emulator and Firenook read tokens without verifying them.
fn bearer(evaluation: &Value) -> String {
    let token = &evaluation["rulesContext"]["request"]["mapValue"]["fields"]["auth"]["mapValue"]["fields"]
        ["token"];
    let claims = json_value(token);
    format!(
        "Bearer {}.{}.",
        base64url(br#"{"alg":"none","typ":"JWT"}"#),
        base64url(claims.to_string().as_bytes())
    )
}

/// A Requests-typed value as plain JSON (the claims of a token).
fn json_value(value: &Value) -> Value {
    let (kind, inner) = value
        .as_object()
        .and_then(|object| object.iter().next())
        .expect("typed value");
    match kind.as_str() {
        "stringValue" | "boolValue" => inner.clone(),
        "intValue" => json!(inner.as_str().expect("int").parse::<i64>().expect("int")),
        "mapValue" => Value::Object(
            inner["fields"]
                .as_object()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|(key, value)| (key.clone(), json_value(value)))
                .collect(),
        ),
        other => panic!("uncaptured claim type {other}"),
    }
}

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0_u32, |n, (index, byte)| {
            n | (u32::from(*byte) << (16 - 8 * index))
        });
        for index in 0..=chunk.len() {
            out.push(char::from(
                ALPHABET[((n >> (18 - 6 * index)) & 63) as usize],
            ));
        }
    }
    out
}
