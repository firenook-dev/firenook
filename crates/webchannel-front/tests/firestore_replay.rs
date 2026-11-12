//! Replays the browser recordings of `conformance/fixtures/webchannel-v8` and
//! `conformance/fixtures/rest-v1` (the Java emulator 1.22.0 and production
//! Cloud Firestore, both driven by the pinned `firebase@12.18.0` browser
//! client through the capture proxy) against the Firestore HTTP router the
//! product serves: REST beside `WebChannel` over one `FirestoreService` on one
//! in-memory store, composed as `firestore_http_router` in `crates/cli` and
//! `prepare_firestore` in `crates/suite-runtime` compose it. The real store
//! answers, so these replays compare data behaviour: the documents, write
//! results, target changes and errors each response carried.
//! `oracle_replay.rs` replays the same `WebChannel` framing against a stand-in
//! backend, and notes the handshakes and forward requests of the recordings
//! it covers; this file notes everything else.
//!
//! A recording is replayed request by request in its recorded order. The
//! capture seeded some documents before the browser ran
//! (`prepareSyntheticDocument` in `conformance/src/webchannel/
//! capture-oracles.ts`); the replay sends the same seed first, as the same
//! REST PATCH. Requests carry the replay's own session ids, stream tokens,
//! resume tokens and document versions in place of the recorded ones, each
//! mapped from the recorded answer that issued it, and the emulator's `owner`
//! credential where the capture redacted production's OAuth token. From a
//! session's first recorded backchannel the replay keeps one open, as the
//! client does (a long poll is reopened as soon as it closes, with the last
//! array id received). A forward request or a new session waits until each
//! session has delivered what the client had acknowledged (`AID`) when it
//! sent that request: as many snapshot ends (a global `NO_CHANGE`), target
//! removals and Write responses as the recording shows by then. That is the
//! causal order the browser followed.
//!
//! What a backchannel is compared on: its status, and every Firestore message
//! it carried against the replay's messages for the same target (or the same
//! Write stream), aligned in order. Not compared, because they vary per run
//! or are framing the client does not read: which HTTP response carried a
//! message (the client reads one stream of arrays), keepalive `noop` arrays
//! and the array ids they shift, document versions beyond their order and
//! equality, a `commitTime` beyond whether it is its write's `updateTime`, a
//! `readTime` beyond whether it changed within its session, resume tokens
//! (Firenook's name a store revision, the oracles' a clock reading), stream
//! ids and tokens beyond equality within a stream. Production also sends
//! refreshes that carry no new state, as many as its timers fire: a second
//! resume-token-only `NO_CHANGE` in a row, a `documentDelete` again for a
//! document already reported absent, and an existence filter whose count is
//! the target's current document count. Both sides drop those, and a
//! backchannel whose recording carried one is noted `behaviour`, not
//! `answer`.
//!
//! A production recording is replayed with `--strict-indexes` and no index
//! file: production refuses a query that needs a composite index the project
//! does not declare, and the capture project declared none
//! (`conformance/fixtures/webchannel-v8/README.md`). A Java recording is
//! replayed with the default policy, as the official emulator answers every
//! query (COMPATIBILITY.md).
//!
//! Where Firenook answers otherwise, the case is in [`DIFFERS`] (documented,
//! with what Firenook does instead, which the test checks) or in
//! [`BUG_CANDIDATES`] (not documented: kept out of the ledger, and the test
//! fails once it matches, so whoever fixes it moves it into the ledger). A
//! Java handshake differs by rule when that is its only difference: Firenook
//! advertises production's server version (14, where Java 1.22.0 sends 12;
//! the README of `conformance/fixtures/webchannel-v8`), and the rule holds
//! only while every production handshake of the scenario matches.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::header::CONTENT_TYPE;
use axum::http::{Method, Request, Version};
use firenook_conformance_ledger::Compared;
use firenook_core_store::Store;
use firenook_functions_bridge::TriggerRegistry;
use firenook_grpc_front::FirestoreService;
use firenook_query_engine::{DatabaseEdition, IndexCatalog, QueryPolicy};
use firenook_rest_front::router_with_shared_service as rest_router;
use firenook_rules_runtime::RulesRuntime;
use firenook_webchannel_front::{FirestoreBackend, router as webchannel_router};
use http_body_util::BodyExt as _;
use serde_json::{Value, json};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tower::ServiceExt as _;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/fixtures");

/// How long a causal wait may take before the replay records that Firenook
/// did not deliver what the recording shows, and moves on. In-process, every
/// wait the replay needs ends within milliseconds.
const WAIT: Duration = Duration::from_secs(5);

/// How long the replay waits, before terminating a session, for the rest of
/// what the recording shows it carried. Nothing waits on these messages but
/// the comparison, and where Firenook sends fewer (a listed difference) the
/// whole wait is spent.
const SETTLE: Duration = Duration::from_secs(1);

/// The recordings `oracle_replay.rs` replays too: it notes their handshakes,
/// forward requests and production's unknown session.
const FRAMING_REPLAYED: &[&str] = &[
    "listen-long-poll",
    "listen-streaming",
    "bundle-nanosecond-read-time",
    "write-long-poll",
    "write-streaming",
    "write-overlap",
    "multiple-inequality-query",
    "backchannel-reconnect-replay",
    "unicode-framing",
    "unknown-sid",
];

/// rest-v1 cases `crates/rest-front` already notes.
const REST_NOTED_ELSEWHERE: &[(&str, &str)] = &[
    ("rest-v1/java-v1.22.0", "aggregation-composite-filter/2"),
    ("rest-v1/java-v1.22.0", "aggregation-limit-error/2"),
    ("rest-v1/java-v1.22.0", "transaction-commit/4"),
    ("rest-v1/java-v1.22.0", "transaction-commit/6"),
    ("rest-v1/java-v1.22.0", "transaction-commit/7"),
    ("rest-v1/java-v1.22.0", "transaction-noop-write/5"),
    ("rest-v1/production-cloud-firestore", "aggregation-count/2"),
];

const JAVA_WEBCHANNEL: &str = "webchannel-v8/java-v1.22.0";
const CLOUD_WEBCHANNEL: &str = "webchannel-v8/production-cloud-firestore";
const JAVA_REST: &str = "rest-v1/java-v1.22.0";
const CLOUD_REST: &str = "rest-v1/production-cloud-firestore";

// ------------------------------------------------------- expected results

/// What a `differs` entry checks Firenook does instead.
#[derive(Clone, Copy)]
enum Instead {
    /// Answers as the production recording of the same scenario does for
    /// this case, which this replay compares too.
    Production(&'static str),
    /// A property of the replay's answer.
    Replay(fn(&Outcome) -> bool),
}

/// A case Firenook deliberately answers otherwise, with its documented
/// source in `reason`.
struct Differs {
    set: &'static str,
    case: &'static str,
    compared: Compared,
    reason: &'static str,
    instead: Instead,
}

/// A case Firenook answers otherwise with no documented reason: a bug
/// candidate for the next release. It stays out of the ledger; the test
/// fails once it matches the recording.
struct Bug {
    set: &'static str,
    case: &'static str,
    description: &'static str,
}

const DIFFERS: &[Differs] = &[
    Differs {
        set: JAVA_WEBCHANNEL,
        case: "unknown-sid/1",
        compared: Compared::Answer,
        reason: "an unknown session is answered with production's HTTP 400 body containing `Unknown SID` (webchannel-v8/production-cloud-firestore unknown-sid/1); Java 1.22.0 sends an empty body (conformance/fixtures/webchannel-v8/README.md)",
        instead: Instead::Production("unknown-sid/1"),
    },
    Differs {
        set: JAVA_WEBCHANNEL,
        case: "unicode-framing/18",
        compared: Compared::Answer,
        reason: "a write that leaves the document as it was sends the listener nothing, as production (webchannel-v8/production-cloud-firestore unicode-framing/17); Java 1.22.0 sends the unchanged document again",
        instead: Instead::Production("unicode-framing/17"),
    },
    Differs {
        set: JAVA_WEBCHANNEL,
        case: "multiple-inequality-query/10",
        compared: Compared::Answer,
        reason: "a query ordered by more fields after `__name__` is refused without adding the target first, as production (webchannel-v8/production-cloud-firestore multiple-inequality-query/8 removes target 1006 it never added); Java 1.22.0 adds it, then removes it",
        instead: Instead::Replay(never_adds_target_1006),
    },
    Differs {
        set: CLOUD_WEBCHANNEL,
        case: "multiple-inequality-query/7",
        compared: Compared::Status,
        reason: "with --strict-indexes a query whose composite index is not declared is refused with FAILED_PRECONDITION as production does; the message is Firenook's own, naming the entry to add to firestore.indexes.json (COMPATIBILITY.md)",
        instead: Instead::Replay(refuses_target_1004_for_its_index),
    },
    Differs {
        set: JAVA_REST,
        case: "aggregation-count/2",
        compared: Compared::Answer,
        reason: "an aggregation answer ends without `\"done\": true`, as production (rest-v1/production-cloud-firestore aggregation-count/2); Java 1.22.0 adds it",
        instead: Instead::Production("aggregation-count/2"),
    },
    // `crates/rest-front` notes this case (its aggregate values); here the
    // whole body is compared, and the difference is asserted, not noted.
    Differs {
        set: JAVA_REST,
        case: "aggregation-composite-filter/2",
        compared: Compared::Answer,
        reason: "an aggregation answer ends without `\"done\": true`, as production answers an aggregation (rest-v1/production-cloud-firestore aggregation-count/2); Java 1.22.0 adds it",
        instead: Instead::Replay(aggregation_without_done),
    },
];

const BUG_CANDIDATES: &[Bug] = &[
    Bug {
        set: JAVA_WEBCHANNEL,
        case: "numeric-resource-id-ordering/15",
        description: "a Listen's first snapshot sends its documents in byte order of the path (__id-2__ before __id-9223372036854775808__), not in the query's numeric resource-id order",
    },
    Bug {
        set: JAVA_WEBCHANNEL,
        case: "numeric-resource-id-ordering/34",
        description: "a Listen's first snapshot sends its documents in byte order of the path (__id-2__ before __id-9223372036854775808__), not in the query's numeric resource-id order",
    },
    Bug {
        set: CLOUD_WEBCHANNEL,
        case: "numeric-resource-id-ordering/15",
        description: "a Listen's first snapshot sends its documents in byte order of the path (__id-2__ before __id-9223372036854775808__), not in the query's numeric resource-id order",
    },
    Bug {
        set: CLOUD_WEBCHANNEL,
        case: "numeric-resource-id-ordering/37",
        description: "a Listen's first snapshot sends its documents in byte order of the path (__id-2__ before __id-9223372036854775808__), not in the query's numeric resource-id order",
    },
    Bug {
        set: JAVA_WEBCHANNEL,
        case: "unicode-framing/4",
        description: "a document target on a missing document becomes CURRENT without the documentDelete both oracles send first",
    },
    Bug {
        set: CLOUD_WEBCHANNEL,
        case: "unicode-framing/4",
        description: "a document target on a missing document becomes CURRENT without the documentDelete both oracles send first",
    },
    Bug {
        set: JAVA_WEBCHANNEL,
        case: "multiple-inequality-query/13",
        description: "a target refused for an equality on `__name__` beside other inequalities is removed without first being added, where both oracles add it",
    },
    Bug {
        set: CLOUD_WEBCHANNEL,
        case: "multiple-inequality-query/6",
        description: "a target refused for a missing composite index is removed without first being added, where production adds it",
    },
    Bug {
        set: CLOUD_WEBCHANNEL,
        case: "multiple-inequality-query/8",
        description: "the refusal of an order by more fields after `__name__` says Java's `order by clause cannot contain more fields after the key`, where production says `Order by clause cannot contain more fields after the key key`",
    },
    Bug {
        set: CLOUD_WEBCHANNEL,
        case: "multiple-inequality-query/10",
        description: "a target refused for an equality on `__name__` beside other inequalities is removed without first being added, where production adds it",
    },
    Bug {
        set: CLOUD_WEBCHANNEL,
        case: "reserved-resource-id-error/2",
        description: "a target under a reserved resource id is removed without first being added, where production adds it (Java 1.22.0 does not)",
    },
    Bug {
        set: CLOUD_WEBCHANNEL,
        case: "reserved-resource-id-error/6",
        description: "a target under a reserved resource id is removed without first being added, where production adds it (Java 1.22.0 does not)",
    },
    Bug {
        set: JAVA_WEBCHANNEL,
        case: "write-missing-update-error/4",
        description: "a Write stream update of a missing document fails with `document not found: <name>`, where production says `No document to update: <name>` (and Java its own Datastore text)",
    },
    Bug {
        set: JAVA_WEBCHANNEL,
        case: "write-missing-update-error/7",
        description: "a Write stream update of a missing document fails with `document not found: <name>`, where production says `No document to update: <name>` (and Java its own Datastore text)",
    },
    Bug {
        set: CLOUD_WEBCHANNEL,
        case: "write-missing-update-error/4",
        description: "a Write stream error is one `{error: {status, message}}` array; production sends `{__sm__: {status: [[{error: {code: 404, message: No document to update: <name>, status}}]]}}` and then a `close` array",
    },
    Bug {
        set: CLOUD_WEBCHANNEL,
        case: "write-missing-update-error/7",
        description: "a Write stream error is one `{error: {status, message}}` array; production sends `{__sm__: {status: [[{error: {code: 404, message: No document to update: <name>, status}}]]}}` and then a `close` array",
    },
    Bug {
        set: CLOUD_REST,
        case: "aggregation-composite-filter/2",
        description: "with --strict-indexes, a count and sum over two equality filters is answered, where production refuses it with FAILED_PRECONDITION for want of a composite index (sequence, synthetic)",
    },
];

fn never_adds_target_1006(outcome: &Outcome) -> bool {
    !outcome.replayed.iter().any(|message| {
        message["targetChange"]["targetChangeType"] == "ADD"
            && message["targetChange"]["targetIds"] == json!([1006])
    }) && outcome.replayed.iter().any(|message| {
        message["targetChange"]["targetChangeType"] == "REMOVE"
            && message["targetChange"]["targetIds"] == json!([1006])
            && message["targetChange"]["cause"]["code"] == 3
    })
}

fn refuses_target_1004_for_its_index(outcome: &Outcome) -> bool {
    outcome.replayed.iter().any(|message| {
        message["targetChange"]["targetChangeType"] == "REMOVE"
            && message["targetChange"]["targetIds"] == json!([1004])
            && message["targetChange"]["cause"]["code"] == 9
    })
}

fn aggregation_without_done(outcome: &Outcome) -> bool {
    outcome.replayed.first().is_some_and(|body| {
        body[0]["result"]["aggregateFields"]["aggregate_0"]["integerValue"] == "1"
            && body[0]["result"]["aggregateFields"]["aggregate_1"]["integerValue"] == "1"
            && body[0].get("done").is_none()
    })
}

// ------------------------------------------------------------ recordings

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Oracle {
    Java,
    Cloud,
}

impl Oracle {
    const fn directory(self) -> &'static str {
        match self {
            Self::Java => "java-v1.22.0",
            Self::Cloud => "production-cloud-firestore",
        }
    }
}

/// One recording: a scenario's exchanges against one oracle.
struct Recording {
    /// The case set `conformance/src/report/cases.mjs` lists it under.
    set: String,
    name: String,
    oracle: Oracle,
    exchanges: Vec<Value>,
}

impl Recording {
    fn load(root: &str, oracle: Oracle, name: &str) -> Option<Self> {
        let path = format!(
            "{FIXTURES}/{root}/{}/{name}/decoded-contract.json",
            oracle.directory()
        );
        let text = std::fs::read_to_string(&path).ok()?;
        let contract: Value = serde_json::from_str(&text).expect("decoded contract is JSON");
        let exchanges = contract["exchanges"]
            .as_array()
            .expect("decoded contract has exchanges")
            .clone();
        Some(Self {
            set: format!("{root}/{}", oracle.directory()),
            name: name.to_owned(),
            oracle,
            exchanges,
        })
    }

    /// The case id `cases.mjs` gives exchange `index`.
    fn case(&self, index: usize) -> String {
        let sequence = self.exchanges[index]["sequence"]
            .as_u64()
            .unwrap_or(u64::try_from(index).expect("index") + 1);
        format!("{}/{sequence}", self.name)
    }

    const fn project(&self) -> &'static str {
        match self.oracle {
            Oracle::Java => "demo-fireside-phase2",
            Oracle::Cloud => "fireside-conformance",
        }
    }

    fn noted_elsewhere(&self, index: usize, stray: bool) -> bool {
        let exchange = &self.exchanges[index];
        if !is_channel(exchange) {
            return REST_NOTED_ELSEWHERE.contains(&(self.set.as_str(), self.case(index).as_str()));
        }
        FRAMING_REPLAYED.contains(&self.name.as_str())
            && self.set.starts_with("webchannel-v8/")
            && (exchange["request"]["method"] == "POST" || stray && self.oracle == Oracle::Cloud)
    }
}

fn query(exchange: &Value) -> Vec<(String, String)> {
    exchange["request"]["query"]
        .as_array()
        .map(|pairs| {
            pairs
                .iter()
                .map(|pair| {
                    (
                        pair[0].as_str().expect("query name").to_owned(),
                        pair[1].as_str().expect("query value").to_owned(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

fn query_value<'a>(query: &'a [(String, String)], name: &str) -> Option<&'a str> {
    query
        .iter()
        .find_map(|(candidate, value)| (candidate == name).then_some(value.as_str()))
}

fn form(exchange: &Value) -> Option<Vec<(String, String)>> {
    exchange["request"]["form"].as_array().map(|pairs| {
        pairs
            .iter()
            .map(|pair| {
                (
                    pair[0].as_str().expect("form name").to_owned(),
                    pair[1].as_str().expect("form value").to_owned(),
                )
            })
            .collect()
    })
}

fn is_channel(exchange: &Value) -> bool {
    exchange["request"]["path"]
        .as_str()
        .is_some_and(|path| path.ends_with("/channel"))
}

fn is_listen(exchange: &Value) -> bool {
    exchange["request"]["path"]
        .as_str()
        .is_some_and(|path| path.ends_with("/Listen/channel"))
}

/// The arrays a recorded backchannel response carried, `[id, payload]`.
fn recorded_arrays(exchange: &Value) -> Vec<(u64, Value)> {
    let mut arrays = Vec::new();
    for frame in exchange["response"]["frames"]
        .as_array()
        .into_iter()
        .flatten()
    {
        for array in frame["json"].as_array().into_iter().flatten() {
            arrays.push((array[0].as_u64().expect("array id"), array[1].clone()));
        }
    }
    arrays
}

/// The SID a recorded handshake response opened.
fn handshake_sid(exchange: &Value) -> Option<String> {
    let frame = exchange["response"]["frames"].as_array()?.first()?;
    let opened = &frame["json"][0][1];
    (opened[0] == "c").then(|| opened[1].as_str().map(str::to_owned))?
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    Rest,
    Handshake,
    Forward,
    Terminate,
    Backchannel,
    /// A request naming a session no handshake opened.
    Stray,
}

// ------------------------------------------------------------ messages

/// One Firestore message a stream carried: the array id and the message.
#[derive(Clone, Debug)]
struct Message {
    id: u64,
    body: Value,
}

/// The messages of a stream in array order: without keepalive noops, and
/// without the refreshes that carry no new state (see the module comment).
/// Returns the kept messages and the ids of the refreshes dropped.
fn normalise(arrays: &BTreeMap<u64, Value>) -> (Vec<Message>, BTreeSet<u64>) {
    let mut kept: Vec<Message> = Vec::new();
    let mut dropped = BTreeSet::new();
    let mut targets: HashMap<i64, BTreeSet<String>> = HashMap::new();
    let mut absent: BTreeSet<String> = BTreeSet::new();
    for (&id, payload) in arrays {
        if payload
            .as_array()
            .is_some_and(|items| items.first() == Some(&json!("noop")))
        {
            continue;
        }
        let body = match payload.as_array().map(Vec::as_slice) {
            Some([only]) if only.is_object() => only.clone(),
            _ => payload.clone(),
        };
        if is_bare_no_change(&body)
            && kept
                .last()
                .is_some_and(|last| is_bare_no_change(&last.body))
        {
            dropped.insert(id);
            continue;
        }
        if let Some(filter) = body.get("filter") {
            let target = filter["targetId"].as_i64().unwrap_or_default();
            let count = filter["count"].as_u64().unwrap_or_default();
            let held = targets.get(&target).map_or(0, BTreeSet::len);
            if u64::try_from(held).expect("count") == count {
                dropped.insert(id);
                continue;
            }
        }
        if let Some(delete) = body.get("documentDelete") {
            let name = delete["document"].as_str().unwrap_or_default().to_owned();
            if !absent.insert(name.clone()) {
                dropped.insert(id);
                continue;
            }
            for documents in targets.values_mut() {
                documents.remove(&name);
            }
        }
        if let Some(change) = body.get("documentChange") {
            let name = change["document"]["name"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            absent.remove(&name);
            for target in change["targetIds"].as_array().into_iter().flatten() {
                targets
                    .entry(target.as_i64().unwrap_or_default())
                    .or_default()
                    .insert(name.clone());
            }
            for target in change["removedTargetIds"].as_array().into_iter().flatten() {
                if let Some(documents) = targets.get_mut(&target.as_i64().unwrap_or_default()) {
                    documents.remove(&name);
                }
            }
        }
        if let Some(remove) = body.get("documentRemove") {
            let name = remove["document"].as_str().unwrap_or_default();
            for target in remove["removedTargetIds"].as_array().into_iter().flatten() {
                if let Some(documents) = targets.get_mut(&target.as_i64().unwrap_or_default()) {
                    documents.remove(name);
                }
            }
        }
        if let Some(change) = body.get("targetChange")
            && matches!(
                change["targetChangeType"].as_str(),
                Some("RESET" | "REMOVE")
            )
        {
            for target in change["targetIds"].as_array().into_iter().flatten() {
                targets.remove(&target.as_i64().unwrap_or_default());
            }
        }
        kept.push(Message { id, body });
    }
    (kept, dropped)
}

/// A global `NO_CHANGE` that only moves the resume token and read time.
fn is_bare_no_change(body: &Value) -> bool {
    body.as_object().is_some_and(|object| object.len() == 1)
        && body["targetChange"].as_object().is_some_and(|change| {
            change
                .keys()
                .all(|key| key == "resumeToken" || key == "readTime")
        })
}

/// A message that ends something the client waits for: a snapshot (global
/// `NO_CHANGE`), a target (`REMOVE`), or a Write response or error.
fn is_milestone(body: &Value) -> bool {
    body.get("targetChange").map_or_else(
        || {
            [
                "documentChange",
                "documentDelete",
                "documentRemove",
                "filter",
            ]
            .iter()
            .all(|key| body.get(key).is_none())
        },
        |change| is_bare_no_change(body) || change["targetChangeType"] == "REMOVE",
    )
}

/// The part of a Listen stream a message belongs to: one target, or the
/// stream-wide snapshots; a Write stream is one part.
fn substream(body: &Value) -> String {
    let first = |ids: &Value| ids.as_array()?.first()?.as_i64();
    let target = if let Some(change) = body.get("targetChange") {
        first(&change["targetIds"])
    } else if let Some(change) = body.get("documentChange") {
        first(&change["targetIds"]).or_else(|| first(&change["removedTargetIds"]))
    } else if let Some(change) = body
        .get("documentDelete")
        .or_else(|| body.get("documentRemove"))
    {
        first(&change["removedTargetIds"])
    } else if let Some(filter) = body.get("filter") {
        filter["targetId"].as_i64()
    } else {
        return "stream".to_owned();
    };
    target.map_or_else(|| "global".to_owned(), |id| format!("target {id}"))
}

/// How a session's two sides line up: the recorded ids aligned to an equal
/// replayed message (a longest common subsequence of each substream), and
/// each replayed message with no recorded counterpart, under the recorded id
/// it came before (or the last one, when it came after them all).
#[derive(Default)]
struct Alignment {
    matched: BTreeSet<u64>,
    extra: BTreeMap<u64, Vec<Value>>,
    /// Replayed messages a session with no recorded message sent.
    unattributed: Vec<Value>,
}

fn aligned(recorded: &[(u64, Value)], replayed: &[Value]) -> Alignment {
    let mut recorded_parts: BTreeMap<String, Vec<&(u64, Value)>> = BTreeMap::new();
    for message in recorded {
        recorded_parts
            .entry(substream(&message.1))
            .or_default()
            .push(message);
    }
    let mut replayed_parts: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    for message in replayed {
        replayed_parts
            .entry(substream(message))
            .or_default()
            .push(message);
    }
    let last_recorded = recorded.last().map(|(id, _)| *id);
    let mut alignment = Alignment::default();
    let extra = |before: Option<u64>, message: &Value, alignment: &mut Alignment| match before
        .or(last_recorded)
    {
        Some(id) => alignment.extra.entry(id).or_default().push(message.clone()),
        None => alignment.unattributed.push(message.clone()),
    };
    for (part, left) in &recorded_parts {
        let right = replayed_parts.remove(part).unwrap_or_default();
        let mut lengths = vec![vec![0_usize; right.len() + 1]; left.len() + 1];
        for i in (0..left.len()).rev() {
            for j in (0..right.len()).rev() {
                lengths[i][j] = if left[i].1 == *right[j] {
                    lengths[i + 1][j + 1] + 1
                } else {
                    lengths[i + 1][j].max(lengths[i][j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while j < right.len() {
            if i < left.len() && left[i].1 == *right[j] {
                alignment.matched.insert(left[i].0);
                i += 1;
                j += 1;
            } else if i < left.len() && lengths[i + 1][j] >= lengths[i][j + 1] {
                i += 1;
            } else {
                let before = left.get(i).map(|message| message.0);
                extra(
                    before.or_else(|| left.last().map(|message| message.0)),
                    right[j],
                    &mut alignment,
                );
                j += 1;
            }
        }
    }
    for right in replayed_parts.into_values() {
        for message in right {
            extra(None, message, &mut alignment);
        }
    }
    alignment
}

/// The documents each target holds once its stream is read to the end, and
/// whether it ended current; for the comparison of state only.
fn final_state(messages: &[Value]) -> BTreeMap<String, (BTreeSet<String>, bool)> {
    let mut targets: BTreeMap<String, (BTreeSet<String>, bool)> = BTreeMap::new();
    for message in messages {
        let part = substream(message);
        let entry = targets.entry(part).or_default();
        if let Some(change) = message.get("documentChange") {
            entry.0.insert(change["document"].to_string());
        } else if let Some(change) = message.get("targetChange") {
            match change["targetChangeType"].as_str() {
                Some("RESET") => *entry = (BTreeSet::new(), false),
                Some("CURRENT") => entry.1 = true,
                Some("REMOVE") => entry.1 = false,
                _ => {}
            }
        }
    }
    targets.remove("global");
    targets
}

// ------------------------------------------------------- canonical form

/// A timestamp reduced to its instant at nanosecond width, so `…076110Z` and
/// `…076110000Z` (the client echoes versions at nanosecond width) are one
/// key, and keys sort as instants do.
fn instant(value: &str) -> String {
    let Some(stripped) = value.strip_suffix('Z') else {
        return value.to_owned();
    };
    let (seconds, fraction) = stripped.split_once('.').unwrap_or((stripped, ""));
    let mut fraction = fraction.to_owned();
    fraction.truncate(9);
    while fraction.len() < 9 {
        fraction.push('0');
    }
    format!("{seconds}.{fraction}Z")
}

/// Every document version (`createTime`, `updateTime`) a value holds.
fn collect_versions(value: &Value, into: &mut BTreeSet<String>) {
    match value {
        Value::Object(object) => {
            for (key, item) in object {
                match (key.as_str(), item.as_str()) {
                    ("createTime" | "updateTime", Some(text)) => {
                        into.insert(instant(text));
                    }
                    _ => collect_versions(item, into),
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_versions(item, into);
            }
        }
        _ => {}
    }
}

/// Labels for the values that vary per run, one set per side of a
/// comparison (the recording's, the replay's).
#[derive(Default)]
struct Labels {
    /// Document versions by rank: the replay commits in the recorded order.
    versions: BTreeMap<String, usize>,
    /// Per stream: read times as changing or not, stream tokens by first
    /// appearance.
    streams: HashMap<String, StreamLabels>,
}

#[derive(Default)]
struct StreamLabels {
    read_time: Option<(String, usize)>,
    stream_tokens: HashMap<String, usize>,
}

impl Labels {
    fn new(versions: &BTreeSet<String>) -> Self {
        Self {
            versions: versions
                .iter()
                .enumerate()
                .map(|(rank, version)| (version.clone(), rank + 1))
                .collect(),
            streams: HashMap::new(),
        }
    }

    fn canonical(&mut self, stream: &str, value: &Value) -> Value {
        match value {
            Value::Object(object) => {
                let first_update = object
                    .get("writeResults")
                    .and_then(|results| results.get(0))
                    .and_then(|result| result.get("updateTime"))
                    .and_then(Value::as_str)
                    .map(instant);
                let mut out = serde_json::Map::new();
                for (key, item) in object {
                    let canonical = match (key.as_str(), item.as_str()) {
                        ("createTime" | "updateTime", Some(text)) => json!(format!(
                            "<version {}>",
                            self.versions
                                .get(&instant(text))
                                .copied()
                                .unwrap_or_default()
                        )),
                        ("commitTime", Some(text)) => {
                            if first_update.as_deref() == Some(instant(text).as_str()) {
                                json!("<the write's updateTime>")
                            } else {
                                json!("<a later commit time>")
                            }
                        }
                        ("readTime", Some(text)) => {
                            let labels = self.streams.entry(stream.to_owned()).or_default();
                            let label = match &mut labels.read_time {
                                Some((last, label)) if last == text => *label,
                                Some((last, label)) => {
                                    *label += 1;
                                    text.clone_into(last);
                                    *label
                                }
                                slot @ None => {
                                    *slot = Some((text.to_owned(), 1));
                                    1
                                }
                            };
                            json!(format!("<read time {label}>"))
                        }
                        ("resumeToken", Some(_)) => json!("<resume token>"),
                        ("streamToken", Some(text)) => {
                            let labels = self.streams.entry(stream.to_owned()).or_default();
                            let next = labels.stream_tokens.len() + 1;
                            let label =
                                *labels.stream_tokens.entry(text.to_owned()).or_insert(next);
                            json!(format!("<stream token {label}>"))
                        }
                        ("streamId", Some(_)) => json!("<stream id>"),
                        _ => self.canonical(stream, item),
                    };
                    out.insert(key.clone(), canonical);
                }
                Value::Object(out)
            }
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|item| self.canonical(stream, item))
                    .collect(),
            ),
            other => other.clone(),
        }
    }
}

/// Learns which replay value stands for each recorded token or version, by
/// walking a recorded answer beside the replay's answer to the same request.
/// Stream tokens go to `stream` (each stream numbers its own: the oracles
/// issue the same token values on every stream), the rest to `into`.
fn learn(
    recorded: &Value,
    replayed: &Value,
    stream: &mut HashMap<String, String>,
    into: &mut HashMap<String, String>,
) {
    match (recorded, replayed) {
        (Value::Object(recorded), Value::Object(replayed)) => {
            for (key, item) in recorded {
                let Some(other) = replayed.get(key) else {
                    continue;
                };
                match (key.as_str(), item.as_str(), other.as_str()) {
                    ("streamToken", Some(from), Some(to)) => {
                        stream.insert(from.to_owned(), to.to_owned());
                    }
                    ("resumeToken", Some(from), Some(to)) => {
                        into.insert(from.to_owned(), to.to_owned());
                    }
                    ("createTime" | "updateTime" | "readTime", Some(from), Some(to)) => {
                        into.insert(instant(from), to.to_owned());
                    }
                    _ => learn(item, other, stream, into),
                }
            }
        }
        (Value::Array(recorded), Value::Array(replayed)) => {
            for (item, other) in recorded.iter().zip(replayed) {
                learn(item, other, stream, into);
            }
        }
        _ => {}
    }
}

/// A recorded request value with the replay's tokens and versions.
fn translate(
    value: &Value,
    stream: &HashMap<String, String>,
    translations: &HashMap<String, String>,
) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, item)| {
                    let replaced = match (key.as_str(), item.as_str()) {
                        ("streamToken", Some(text)) => stream.get(text).map(|to| json!(to)),
                        ("resumeToken", Some(text)) => translations.get(text).map(|to| json!(to)),
                        ("updateTime" | "readTime", Some(text)) => {
                            translations.get(&instant(text)).map(|to| {
                                // Keep the recorded width: the client sends
                                // nanoseconds, the server answers microseconds.
                                let width = text.split_once('.').map_or(0, |(_, f)| f.len() - 1);
                                json!(widen(to, width))
                            })
                        }
                        _ => None,
                    };
                    (
                        key.clone(),
                        replaced.unwrap_or_else(|| translate(item, stream, translations)),
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| translate(item, stream, translations))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn widen(timestamp: &str, width: usize) -> String {
    let Some(stripped) = timestamp.strip_suffix('Z') else {
        return timestamp.to_owned();
    };
    let (seconds, fraction) = stripped.split_once('.').unwrap_or((stripped, ""));
    if width == 0 {
        return timestamp.to_owned();
    }
    let mut fraction = fraction.to_owned();
    while fraction.len() < width {
        fraction.push('0');
    }
    format!("{seconds}.{fraction}Z")
}

// ------------------------------------------------------------ the replay

/// Firestore's product HTTP router over a fresh in-memory store, with the
/// index policy the module comment gives for each oracle.
fn product_router(oracle: Oracle) -> Router {
    let query_policy = match oracle {
        Oracle::Java => QueryPolicy::new(DatabaseEdition::Standard),
        Oracle::Cloud => QueryPolicy::strict(DatabaseEdition::Standard, IndexCatalog::default()),
    };
    let store = Store::default();
    let rules = RulesRuntime::default();
    let service = FirestoreService::new_with_query_policy_and_rules(
        store.clone(),
        query_policy.clone(),
        rules.clone(),
    );
    rest_router(
        store,
        query_policy,
        None,
        rules,
        TriggerRegistry::default(),
        service.clone(),
    )
    .merge(webchannel_router(FirestoreBackend::new(service)))
}

/// What one replayed session received, in the replay's array ids.
#[derive(Default)]
struct Received {
    arrays: Mutex<BTreeMap<u64, Value>>,
    changed: Mutex<Option<watch::Sender<usize>>>,
}

impl Received {
    fn new() -> (Arc<Self>, watch::Receiver<usize>) {
        let (sender, receiver) = watch::channel(0);
        let shared = Arc::new(Self::default());
        *shared
            .changed
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(sender);
        (shared, receiver)
    }

    fn add(&self, arrays: Vec<(u64, Value)>) {
        let count = {
            let mut held = self.arrays.lock().unwrap_or_else(PoisonError::into_inner);
            for (id, payload) in arrays {
                held.entry(id).or_insert(payload);
            }
            held.len()
        };
        if let Some(sender) = self
            .changed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            sender.send_replace(count);
        }
    }

    fn snapshot(&self) -> BTreeMap<u64, Value> {
        self.arrays
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn last_id(&self) -> u64 {
        self.arrays
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .keys()
            .next_back()
            .copied()
            .unwrap_or(0)
    }
}

/// A recorded session and its replayed counterpart.
struct Session {
    listen: bool,
    /// Creation order, for a stable comparison order.
    order: usize,
    recorded: BTreeMap<u64, Value>,
    sid: String,
    gsession: String,
    received: Arc<Received>,
    changes: watch::Receiver<usize>,
    /// The backchannel loop.
    poller: Option<JoinHandle<()>>,
    /// Set before the session is terminated.
    stop: Arc<AtomicBool>,
    /// The status of every poll the loop made.
    poll_statuses: Arc<Mutex<Vec<u16>>>,
    terminated: bool,
    /// Recorded stream token to the replay's.
    stream_tokens: HashMap<String, String>,
}

fn milestones(arrays: &BTreeMap<u64, Value>, through: u64) -> usize {
    normalise(arrays)
        .0
        .iter()
        .filter(|message| message.id <= through && is_milestone(&message.body))
        .count()
}

impl Session {
    fn received_milestones(&self) -> usize {
        milestones(&self.received.snapshot(), u64::MAX)
    }

    /// Waits until the replay has delivered `count` milestones.
    async fn wait_for(&mut self, count: usize, wait: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            if self.received_milestones() >= count {
                return true;
            }
            if tokio::time::timeout_at(deadline, self.changes.changed())
                .await
                .is_err()
            {
                return self.received_milestones() >= count;
            }
        }
    }
}

/// What the replay observed for one exchange.
#[derive(Debug, Default)]
struct Observed {
    status: u16,
    body: Option<Value>,
    text: String,
}

struct Replay<'a> {
    recording: &'a Recording,
    application: Router,
    /// By recorded SID.
    sessions: HashMap<String, Session>,
    translations: HashMap<String, String>,
    observed: HashMap<usize, Observed>,
    /// Waits that ran out, for the report.
    stalls: Vec<String>,
}

impl<'a> Replay<'a> {
    fn new(recording: &'a Recording) -> Self {
        Self {
            recording,
            application: product_router(recording.oracle),
            sessions: HashMap::new(),
            translations: HashMap::new(),
            observed: HashMap::new(),
            stalls: Vec::new(),
        }
    }

    fn step(&self, index: usize) -> Step {
        let exchange = &self.recording.exchanges[index];
        if !is_channel(exchange) {
            return Step::Rest;
        }
        let query = query(exchange);
        let Some(sid) = query_value(&query, "SID") else {
            return if exchange["request"]["method"] == "POST" {
                Step::Handshake
            } else {
                Step::Stray
            };
        };
        if !self.sessions.contains_key(sid) {
            return Step::Stray;
        }
        match (
            exchange["request"]["method"].as_str(),
            query_value(&query, "TYPE"),
        ) {
            (Some("POST"), Some("terminate")) => Step::Terminate,
            (Some("POST"), _) => Step::Forward,
            _ => Step::Backchannel,
        }
    }

    /// Every recorded session, with its recorded arrays (a retried
    /// backchannel's replayed arrays counted once).
    fn open_recorded_sessions(&mut self) {
        let mut order = 0;
        for exchange in &self.recording.exchanges {
            if !is_channel(exchange)
                || exchange["request"]["method"] != "POST"
                || query_value(&query(exchange), "SID").is_some()
            {
                continue;
            }
            if let Some(sid) = handshake_sid(exchange) {
                let (received, changes) = Received::new();
                self.sessions.insert(
                    sid,
                    Session {
                        listen: is_listen(exchange),
                        order,
                        recorded: BTreeMap::new(),
                        sid: String::new(),
                        gsession: String::new(),
                        received,
                        changes,
                        poller: None,
                        stop: Arc::new(AtomicBool::new(false)),
                        poll_statuses: Arc::default(),
                        terminated: false,
                        stream_tokens: HashMap::new(),
                    },
                );
                order += 1;
            }
        }
        for exchange in &self.recording.exchanges {
            if exchange["request"]["method"] != "GET" || !is_channel(exchange) {
                continue;
            }
            let query = query(exchange);
            if let Some(session) =
                query_value(&query, "SID").and_then(|sid| self.sessions.get_mut(sid))
            {
                for (id, payload) in recorded_arrays(exchange) {
                    session.recorded.entry(id).or_insert(payload);
                }
            }
        }
    }

    /// The acknowledgement each session had reached by exchange `index`:
    /// the largest `AID` the client sent on it up to there.
    fn acknowledged_by(&self, index: usize) -> BTreeMap<String, u64> {
        let mut acknowledged = BTreeMap::new();
        for exchange in &self.recording.exchanges[..=index] {
            let query = query(exchange);
            if let (Some(sid), Some(aid)) = (query_value(&query, "SID"), query_value(&query, "AID"))
            {
                let aid = aid.parse::<u64>().expect("numeric AID");
                let entry = acknowledged.entry(sid.to_owned()).or_insert(0);
                *entry = (*entry).max(aid);
            }
        }
        acknowledged
    }

    async fn wait_causally(&mut self, index: usize) {
        let acknowledged = self.acknowledged_by(index);
        let case = self.recording.case(index);
        for (sid, aid) in acknowledged {
            let Some(session) = self.sessions.get_mut(&sid) else {
                continue;
            };
            if session.sid.is_empty() || session.terminated {
                continue;
            }
            let needed = milestones(&session.recorded, aid);
            if !session.wait_for(needed, WAIT).await {
                self.stalls.push(format!(
                    "{case}: session {} delivered {} of the {needed} milestones acknowledged by then",
                    session.order,
                    session.received_milestones()
                ));
            }
        }
        self.learn_streams();
    }

    /// Refreshes the token and version translations from every session's
    /// aligned messages.
    fn learn_streams(&mut self) {
        for session in self.sessions.values_mut() {
            let (recorded, _) = normalise(&session.recorded);
            let (replayed, _) = normalise(&session.received.snapshot());
            for (recorded, replayed) in recorded.iter().zip(&replayed) {
                learn(
                    &recorded.body,
                    &replayed.body,
                    &mut session.stream_tokens,
                    &mut self.translations,
                );
            }
        }
    }

    fn channel_body(&self, pairs: &[(String, String)], session: Option<&Session>) -> String {
        let none = HashMap::new();
        let stream = session.map_or(&none, |session| &session.stream_tokens);
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        for (name, value) in pairs {
            let value = if name == "headers" {
                // The capture redacted production's OAuth credential; the
                // emulator's equivalent of that administrator is `owner`.
                value.replace("Authorization:[REDACTED]", "Authorization:Bearer owner")
            } else if name.ends_with("___data__") {
                let map: Value = serde_json::from_str(value).expect("forward map is JSON");
                translate(&map, stream, &self.translations).to_string()
            } else {
                value.clone()
            };
            serializer.append_pair(name, &value);
        }
        serializer.finish()
    }

    fn channel_request(&self, index: usize, session: Option<&Session>) -> Request<Body> {
        let exchange = &self.recording.exchanges[index];
        let pairs = query(exchange)
            .into_iter()
            .map(|(name, value)| {
                let value = match (name.as_str(), session) {
                    ("SID", Some(session)) => session.sid.clone(),
                    ("gsessionid", Some(session)) => session.gsession.clone(),
                    ("AID", Some(session)) => session.received.last_id().to_string(),
                    _ => value,
                };
                (name, value)
            })
            .collect::<Vec<_>>();
        let uri = format!(
            "{}?{}",
            exchange["request"]["path"].as_str().expect("path"),
            encode_pairs(&pairs)
        );
        let method = exchange["request"]["method"].as_str().expect("method");
        let mut builder = Request::builder().method(method).uri(uri);
        let body =
            form(exchange).map_or_else(String::new, |pairs| self.channel_body(&pairs, session));
        if method == "POST" {
            builder = builder.header(CONTENT_TYPE, "application/x-www-form-urlencoded");
        }
        builder.body(Body::from(body)).expect("request builds")
    }

    async fn send(&self, request: Request<Body>) -> (Observed, Option<String>) {
        let response = self
            .application
            .clone()
            .oneshot(request)
            .await
            .expect("the router answers");
        let status = response.status().as_u16();
        let gsession = response
            .headers()
            .get("x-http-session-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("the body reads")
            .to_bytes();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let body = serde_json::from_str(&text).ok().or_else(|| {
            decode_frames(&text)
                .ok()
                .filter(|frames| !frames.is_empty())
                .map(Value::Array)
        });
        (Observed { status, body, text }, gsession)
    }

    async fn replay(mut self) -> Replayed {
        self.open_recorded_sessions();
        seed(&self.application, self.recording).await;
        for index in 0..self.recording.exchanges.len() {
            match self.step(index) {
                Step::Rest => self.rest(index).await,
                Step::Handshake => self.handshake(index).await,
                Step::Forward => self.forward(index).await,
                Step::Terminate => self.terminate(index).await,
                Step::Backchannel => self.backchannel(index),
                Step::Stray => {
                    let (observed, _) = self.send(self.channel_request(index, None)).await;
                    self.observed.insert(index, observed);
                }
            }
        }
        // A session the recording never terminated (the page closed with it
        // open) is compared as far as the recording goes.
        let mut open = self
            .sessions
            .iter()
            .filter(|(_, session)| !session.terminated && !session.sid.is_empty())
            .map(|(sid, _)| sid.clone())
            .collect::<Vec<_>>();
        open.sort();
        for sid in open {
            let session = self.sessions.get_mut(&sid).expect("session");
            let total = milestones(&session.recorded, u64::MAX);
            if !session.wait_for(total, SETTLE).await {
                self.stalls.push(format!(
                    "session {} delivered {} of its {total} recorded milestones",
                    session.order,
                    session.received_milestones()
                ));
            }
        }
        for session in self.sessions.values_mut() {
            session.stop.store(true, Ordering::Release);
            if let Some(poller) = session.poller.take() {
                poller.abort();
            }
        }
        Replayed {
            sessions: self.sessions,
            observed: self.observed,
            stalls: self.stalls,
        }
    }

    async fn rest(&mut self, index: usize) {
        let exchange = &self.recording.exchanges[index];
        let request = &exchange["request"];
        let method = Method::from_bytes(request["method"].as_str().expect("method").as_bytes())
            .expect("method");
        let mut uri = request["path"].as_str().expect("path").to_owned();
        let query = query(exchange);
        if !query.is_empty() {
            uri = format!("{uri}?{}", encode_pairs(&query));
        }
        let mut builder = Request::builder().method(method).uri(uri);
        for header in request["headers"].as_array().into_iter().flatten() {
            let name = header["name"].as_str().expect("header name");
            let value = header["value"].as_str().expect("header value");
            if matches!(
                name,
                "content-length" | "host" | "connection" | "accept-encoding"
            ) {
                continue;
            }
            // The capture redacted production's OAuth credential.
            let value = if name.eq_ignore_ascii_case("authorization") {
                "Bearer owner"
            } else {
                value
            };
            builder = builder.header(name, value);
        }
        let body = request["bodyText"].as_str().unwrap_or_default();
        let body = serde_json::from_str::<Value>(body).map_or_else(
            |_| body.to_owned(),
            |json| translate(&json, &HashMap::new(), &self.translations).to_string(),
        );
        let (observed, _) = self
            .send(builder.body(Body::from(body)).expect("request builds"))
            .await;
        if let (Some(recorded), Some(replayed)) = (
            exchange["response"]["bodyText"]
                .as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok()),
            observed.body.as_ref(),
        ) {
            learn(
                &recorded,
                replayed,
                &mut HashMap::new(),
                &mut self.translations,
            );
        }
        self.observed.insert(index, observed);
    }

    async fn handshake(&mut self, index: usize) {
        self.wait_causally(index).await;
        let exchange = &self.recording.exchanges[index];
        let sid = handshake_sid(exchange).expect("recorded handshake opened a session");
        let mut request = self.channel_request(index, None);
        if self.recording.oracle == Oracle::Cloud {
            // The capture proxy reached production over HTTP/2.
            *request.version_mut() = Version::HTTP_2;
        }
        let (observed, gsession) = self.send(request).await;
        let session = self.sessions.get_mut(&sid).expect("recorded session");
        observed
            .body
            .as_ref()
            .and_then(|frames| frames[0][0][1][1].as_str())
            .unwrap_or_default()
            .clone_into(&mut session.sid);
        session.gsession = gsession.unwrap_or_default();
        self.observed.insert(index, observed);
    }

    fn recorded_sid(&self, index: usize) -> String {
        query_value(&query(&self.recording.exchanges[index]), "SID")
            .expect("SID")
            .to_owned()
    }

    async fn forward(&mut self, index: usize) {
        self.wait_causally(index).await;
        let sid = self.recorded_sid(index);
        let request = self.channel_request(index, self.sessions.get(&sid));
        let (observed, _) = self.send(request).await;
        self.observed.insert(index, observed);
    }

    async fn terminate(&mut self, index: usize) {
        let sid = self.recorded_sid(index);
        let case = self.recording.case(index);
        let session = self.sessions.get_mut(&sid).expect("session");
        let total = milestones(&session.recorded, u64::MAX);
        if !session.wait_for(total, SETTLE).await {
            self.stalls.push(format!(
                "{case}: session {} delivered {} of its {total} recorded milestones",
                session.order,
                session.received_milestones()
            ));
        }
        self.learn_streams();
        let request = self.channel_request(index, self.sessions.get(&sid));
        let session = self.sessions.get_mut(&sid).expect("session");
        session.stop.store(true, Ordering::Release);
        let (observed, _) = self.send(request).await;
        self.observed.insert(index, observed);
        let session = self.sessions.get_mut(&sid).expect("session");
        session.terminated = true;
        if let Some(poller) = session.poller.take()
            && tokio::time::timeout(WAIT, poller).await.is_err()
        {
            self.stalls.push(format!(
                "{case}: the backchannel of session {} outlived its terminate",
                session.order
            ));
        }
    }

    /// The client keeps a backchannel open for as long as the session
    /// lives: a long poll is reopened as soon as it closes, with the last
    /// array id received, and a streaming one stays open. From the
    /// recording's first backchannel of a session the replay does the same,
    /// with that request's parameters, until the session is terminated.
    fn backchannel(&mut self, index: usize) {
        let sid = self.recorded_sid(index);
        let exchange = &self.recording.exchanges[index];
        let path = exchange["request"]["path"]
            .as_str()
            .expect("path")
            .to_owned();
        let template = query(exchange);
        let application = self.application.clone();
        let session = self.sessions.get_mut(&sid).expect("session");
        if session.poller.is_some() || session.terminated {
            return;
        }
        let received = Arc::clone(&session.received);
        let stop = Arc::clone(&session.stop);
        let statuses = Arc::clone(&session.poll_statuses);
        let (replay_sid, gsession) = (session.sid.clone(), session.gsession.clone());
        session.poller = Some(tokio::spawn(async move {
            while !stop.load(Ordering::Acquire) {
                let pairs = template
                    .iter()
                    .map(|(name, value)| {
                        let value = match name.as_str() {
                            "SID" => replay_sid.clone(),
                            "gsessionid" => gsession.clone(),
                            "AID" => received.last_id().to_string(),
                            _ => value.clone(),
                        };
                        (name.clone(), value)
                    })
                    .collect::<Vec<_>>();
                let request = Request::get(format!("{path}?{}", encode_pairs(&pairs)))
                    .body(Body::empty())
                    .expect("backchannel request builds");
                let response = application
                    .clone()
                    .oneshot(request)
                    .await
                    .expect("the router answers");
                let status = response.status().as_u16();
                // A poll sent as the session ended may find it gone.
                if status == 200 || !stop.load(Ordering::Acquire) {
                    statuses
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .push(status);
                }
                let mut body = response.into_body();
                let mut buffer = String::new();
                while let Some(frame) = body.frame().await {
                    let Ok(frame) = frame else { break };
                    let Ok(data) = frame.into_data() else {
                        continue;
                    };
                    buffer.push_str(&String::from_utf8_lossy(&data));
                    let (frames, rest) = split_frames(&buffer);
                    buffer = rest;
                    for frame in frames {
                        let arrays = frame
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|array| Some((array[0].as_u64()?, array[1].clone())))
                            .collect();
                        received.add(arrays);
                    }
                }
                if status != 200 {
                    break;
                }
            }
        }));
    }
}

fn encode_pairs(pairs: &[(String, String)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.extend_pairs(pairs.iter().map(|(name, value)| (name, value)));
    serializer.finish()
}

/// Splits complete length-prefixed frames (lengths in UTF-16 units) off the
/// front of `buffer`; returns them and what is left.
fn split_frames(buffer: &str) -> (Vec<Value>, String) {
    let mut frames = Vec::new();
    let mut rest = buffer;
    while let Some((prefix, after)) = rest.split_once('\n') {
        let Ok(declared) = prefix.trim().parse::<usize>() else {
            break;
        };
        let mut units = 0;
        let mut bytes = 0;
        for character in after.chars() {
            if units == declared {
                break;
            }
            units += character.len_utf16();
            bytes += character.len_utf8();
        }
        if units < declared {
            break;
        }
        let (payload, tail) = after.split_at(bytes);
        frames.push(serde_json::from_str(payload).expect("a frame holds JSON"));
        rest = tail;
    }
    (frames, rest.to_owned())
}

fn decode_frames(text: &str) -> Result<Vec<Value>, String> {
    let (frames, rest) = split_frames(text);
    if rest.trim().is_empty() {
        Ok(frames)
    } else {
        Err(format!("trailing bytes after frames: {rest:?}"))
    }
}

/// The documents the capture wrote before the browser ran
/// (`prepareSyntheticDocument` in `conformance/src/webchannel/capture-oracles.ts`),
/// sent the same way, as REST `PATCH` requests.
async fn seed(application: &Router, recording: &Recording) {
    let project = recording.project();
    let mut documents: Vec<(String, Value)> = Vec::new();
    match recording.name.as_str() {
        "multiple-inequality-query" => {
            for (id, fields) in [
                (
                    "doc1",
                    json!({"key": {"stringValue": "a"}, "sort": {"integerValue": "0"}, "v": {"integerValue": "0"}}),
                ),
                (
                    "doc2",
                    json!({"key": {"stringValue": "b"}, "sort": {"doubleValue": "NaN"}, "v": {"integerValue": "1"}}),
                ),
                (
                    "doc3",
                    json!({"key": {"stringValue": "c"}, "sort": {"nullValue": null}, "v": {"integerValue": "3"}}),
                ),
                (
                    "doc4",
                    json!({"key": {"stringValue": "d"}, "v": {"integerValue": "0"}}),
                ),
                (
                    "doc5",
                    json!({"key": {"stringValue": "e"}, "sort": {"integerValue": "1"}}),
                ),
                (
                    "doc6",
                    json!({"key": {"stringValue": "f"}, "sort": {"integerValue": "1"}, "v": {"integerValue": "1"}}),
                ),
            ] {
                documents.push((format!("fireside_webchannel_capture_query/{id}"), fields));
            }
        }
        name if name.starts_with("aggregation-") || name.starts_with("transaction-") => {
            for (id, sequence) in [("oracle", 1), ("oracle-second", 2)] {
                documents.push((
                    format!("fireside_webchannel_capture/{id}"),
                    json!({
                        "capture": {"stringValue": name},
                        "sequence": {"integerValue": sequence.to_string()},
                        "synthetic": {"booleanValue": true},
                    }),
                ));
            }
        }
        "listen-long-poll" | "listen-streaming" | "backchannel-reconnect-replay" => {
            // The seed's expiry is the capture's clock plus a day: the one
            // value taken from the recording, from the document it served.
            let expires = recording
                .exchanges
                .iter()
                .flat_map(recorded_arrays)
                .find_map(|(_, payload)| {
                    payload[0]["documentChange"]["document"]["fields"]["_fireside_expires_at"]
                        ["timestampValue"]
                        .as_str()
                        .map(str::to_owned)
                })
                .expect("the recording served the seeded document");
            documents.push((
                "fireside_webchannel_capture/oracle".to_owned(),
                json!({
                    "_fireside_expires_at": {"timestampValue": expires},
                    "capture": {"stringValue": recording.name},
                    "synthetic": {"booleanValue": true},
                }),
            ));
        }
        _ => {}
    }
    for (path, fields) in documents {
        let response = application
            .clone()
            .oneshot(
                Request::patch(format!(
                    "/v1/projects/{project}/databases/(default)/documents/{path}"
                ))
                .header(CONTENT_TYPE, "application/json")
                .header("authorization", "Bearer owner")
                .body(Body::from(json!({ "fields": fields }).to_string()))
                .expect("seed request builds"),
            )
            .await
            .expect("the router answers");
        assert!(
            response.status().is_success(),
            "seed {path}: {}",
            response.status()
        );
    }
}

// ------------------------------------------------------------ comparison

/// The replay's results.
struct Replayed {
    sessions: HashMap<String, Session>,
    observed: HashMap<usize, Observed>,
    stalls: Vec<String>,
}

/// One case's outcome.
struct Outcome {
    set: String,
    case: String,
    /// Another replay notes this case in the ledger.
    noted_elsewhere: bool,
    /// `Ok(level)` when the replay matched the recording that far.
    result: Result<Compared, String>,
    /// A handshake.
    handshake: bool,
    /// A Java handshake that differs only by advertising production's
    /// server version.
    production_handshake: bool,
    /// What the replay answered, canonical: for a backchannel, every message
    /// of its session; otherwise the body.
    replayed: Vec<Value>,
}

/// One session's messages, canonical, on both sides.
struct SessionView {
    recorded: Vec<(u64, Value)>,
    replayed: Vec<Value>,
    alignment: Alignment,
    dropped: BTreeSet<u64>,
    /// Compared on the state each target ends in, not message by message.
    state_only: bool,
}

#[allow(clippy::too_many_lines)] // One pass over the recording reads best whole.
fn compare(recording: &Recording, replayed: &Replayed) -> Vec<Outcome> {
    // Versions are labelled by rank among every version each side holds.
    let mut recorded_versions = BTreeSet::new();
    let mut replayed_versions = BTreeSet::new();
    let mut sessions = replayed.sessions.iter().collect::<Vec<_>>();
    sessions.sort_by_key(|(_, session)| session.order);
    let normalised = sessions
        .iter()
        .map(|(sid, session)| {
            (
                (*sid).clone(),
                normalise(&session.recorded),
                normalise(&session.received.snapshot()).0,
            )
        })
        .collect::<Vec<_>>();
    for (_, (recorded, _), received) in &normalised {
        for message in recorded {
            collect_versions(&message.body, &mut recorded_versions);
        }
        for message in received {
            collect_versions(&message.body, &mut replayed_versions);
        }
    }
    for (index, exchange) in recording.exchanges.iter().enumerate() {
        if !is_channel(exchange) {
            if let Some(text) = exchange["response"]["bodyText"].as_str()
                && let Ok(body) = serde_json::from_str::<Value>(text)
            {
                collect_versions(&body, &mut recorded_versions);
            }
            if let Some(body) = replayed.observed.get(&index).and_then(|o| o.body.as_ref()) {
                collect_versions(body, &mut replayed_versions);
            }
        }
    }
    let mut recorded_labels = Labels::new(&recorded_versions);
    let mut replayed_labels = Labels::new(&replayed_versions);
    let mut views = HashMap::new();
    for ((sid, (recorded, dropped), received), (_, session)) in
        normalised.into_iter().zip(&sessions)
    {
        let stream = format!("session {}", session.order);
        let recorded = recorded
            .iter()
            .map(|message| {
                (
                    message.id,
                    recorded_labels.canonical(&stream, &message.body),
                )
            })
            .collect::<Vec<_>>();
        let received = received
            .iter()
            .map(|message| replayed_labels.canonical(&stream, &message.body))
            .collect::<Vec<_>>();
        // A named query loaded from a bundle resumes from an expired read
        // time; where the reset falls differs between production's own
        // variants, so acceptance and the state delivered is what both
        // oracles agree on (conformance/fixtures/webchannel-v8/README.md).
        let state_only = session.listen && recording.name == "bundle-nanosecond-read-time";
        let alignment = if state_only {
            let recorded_messages = recorded.iter().map(|(_, m)| m.clone()).collect::<Vec<_>>();
            Alignment {
                matched: if final_state(&recorded_messages) == final_state(&received) {
                    recorded.iter().map(|(id, _)| *id).collect()
                } else {
                    BTreeSet::new()
                },
                ..Alignment::default()
            }
        } else {
            aligned(&recorded, &received)
        };

        views.insert(
            sid,
            SessionView {
                recorded,
                replayed: received,
                alignment,
                dropped,
                state_only,
            },
        );
    }
    let mut rest_labels = (
        Labels::new(&recorded_versions),
        Labels::new(&replayed_versions),
    );
    let mut outcomes = Vec::new();
    for (index, exchange) in recording.exchanges.iter().enumerate() {
        let query = query(exchange);
        let sid = query_value(&query, "SID").map(str::to_owned);
        let known = sid
            .as_ref()
            .is_some_and(|sid| replayed.sessions.contains_key(sid));
        let mut outcome = Outcome {
            set: recording.set.clone(),
            case: recording.case(index),
            noted_elsewhere: recording.noted_elsewhere(index, sid.is_some() && !known),
            result: Ok(Compared::Status),
            handshake: is_channel(exchange)
                && sid.is_none()
                && exchange["request"]["method"] == "POST",
            production_handshake: false,
            replayed: Vec::new(),
        };
        if !is_channel(exchange) {
            let observed = &replayed.observed[&index];
            outcome.replayed = observed.body.clone().into_iter().collect();
            outcome.result = compare_rest(exchange, observed, &mut rest_labels);
        } else if exchange["request"]["method"] == "GET" && known {
            let sid = sid.expect("SID");
            outcome.result = compare_backchannel(exchange, &replayed.sessions[&sid], &views[&sid]);
            outcome.replayed.clone_from(&views[&sid].replayed);
        } else {
            let observed = &replayed.observed[&index];
            outcome.replayed = observed.body.clone().into_iter().collect();
            outcome.result = compare_channel_post(exchange, observed, known, sid.is_some());
            outcome.production_handshake = recording.oracle == Oracle::Java
                && sid.is_none()
                && outcome.result.is_err()
                && advertises_production_version(exchange, observed);
        }
        outcomes.push(outcome);
    }
    outcomes
}

fn compare_backchannel(
    exchange: &Value,
    session: &Session,
    view: &SessionView,
) -> Result<Compared, String> {
    let status = exchange["response"]["status"].as_u64().unwrap_or_default();
    // Every poll the replay's client made on the session.
    let statuses = session
        .poll_statuses
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let observed = statuses
        .iter()
        .copied()
        .find(|status| *status != 200)
        .unwrap_or(if statuses.is_empty() { 0 } else { 200 });
    if u64::from(observed) != status {
        return Err(format!("status {observed}, recorded {status}"));
    }
    let carried = recorded_arrays(exchange)
        .into_iter()
        .map(|(id, _)| id)
        .collect::<BTreeSet<_>>();
    let messages = view
        .recorded
        .iter()
        .filter(|(id, _)| carried.contains(id))
        .collect::<Vec<_>>();
    let extra = carried
        .iter()
        .filter_map(|id| view.alignment.extra.get(id))
        .flatten()
        .chain(&view.alignment.unattributed)
        .collect::<Vec<_>>();
    if messages.is_empty() && extra.is_empty() {
        // Keepalives only.
        return Ok(Compared::Status);
    }
    let unmatched = messages
        .iter()
        .filter(|(id, _)| !view.alignment.matched.contains(id))
        .collect::<Vec<_>>();
    if unmatched.is_empty() && extra.is_empty() {
        return Ok(
            if view.state_only || carried.iter().any(|id| view.dropped.contains(id)) {
                Compared::Behaviour
            } else {
                Compared::Answer
            },
        );
    }
    let mut report = String::from("recorded messages the replay did not send in order:");
    for (_, message) in unmatched {
        let _ = write!(report, "\n    {message}");
    }
    report.push_str("\n  messages the replay sent that the recording does not show:");
    for message in extra {
        let _ = write!(report, "\n    {message}");
    }
    report.push_str("\n  the replay's session sent:");
    for message in &view.replayed {
        let _ = write!(report, "\n    {message}");
    }
    Err(report)
}

/// A Java handshake that differs from the recording only in the server
/// version it advertises: Firenook's is production's.
fn advertises_production_version(exchange: &Value, observed: &Observed) -> bool {
    let mut recorded = exchange["response"]["frames"][0]["json"].clone();
    let Some(mut replayed) = observed
        .body
        .as_ref()
        .and_then(|frames| frames.get(0))
        .cloned()
    else {
        return false;
    };
    recorded[0][1][1] = json!("<sid>");
    replayed[0][1][1] = json!("<sid>");
    recorded[0][1][4] = json!(14);
    recorded == replayed
}

fn compare_channel_post(
    exchange: &Value,
    observed: &Observed,
    known: bool,
    has_sid: bool,
) -> Result<Compared, String> {
    let status = exchange["response"]["status"].as_u64().unwrap_or_default();
    if u64::from(observed.status) != status {
        return Err(format!(
            "status {}, recorded {status}: {}",
            observed.status, observed.text
        ));
    }
    let query = query(exchange);
    if has_sid && !known {
        // An unknown session: the status and the body.
        let recorded = exchange["response"]["bodyText"]
            .as_str()
            .unwrap_or_default();
        return if observed.text == recorded {
            Ok(Compared::Answer)
        } else {
            Err(format!("body {:?}, recorded {recorded:?}", observed.text))
        };
    }
    if query_value(&query, "TYPE") == Some("terminate") {
        return if observed.text.is_empty() {
            Ok(Compared::Answer)
        } else {
            Err(format!("terminate body {:?}", observed.text))
        };
    }
    if !has_sid {
        // A handshake: `[[0,["c",SID,"",8,version,30000]]]`, the SID aside.
        let mut recorded = exchange["response"]["frames"][0]["json"].clone();
        let mut replayed = observed
            .body
            .as_ref()
            .and_then(|frames| frames.get(0))
            .cloned()
            .unwrap_or_default();
        recorded[0][1][1] = json!("<sid>");
        if replayed.get(0).is_some() {
            replayed[0][1][1] = json!("<sid>");
        }
        return if replayed == recorded {
            Ok(Compared::Answer)
        } else {
            Err(format!("handshake {replayed}, recorded {recorded}"))
        };
    }
    // A forward request: `[backchannel open, last array id, outstanding
    // bytes]`, all three set by timing; its status and shape.
    let acknowledgement = observed.body.as_ref().and_then(|frames| frames.get(0));
    if acknowledgement
        .and_then(Value::as_array)
        .is_some_and(|ack| ack.len() == 3 && matches!(ack[0].as_u64(), Some(0 | 1)))
    {
        Ok(Compared::Status)
    } else {
        Err(format!("forward acknowledgement {:?}", observed.text))
    }
}

fn compare_rest(
    exchange: &Value,
    observed: &Observed,
    labels: &mut (Labels, Labels),
) -> Result<Compared, String> {
    let status = exchange["response"]["status"].as_u64().unwrap_or_default();
    if u64::from(observed.status) != status {
        return Err(format!(
            "status {}, recorded {status}: {}",
            observed.status, observed.text
        ));
    }
    let recorded_text = exchange["response"]["bodyText"]
        .as_str()
        .unwrap_or_default();
    if recorded_text.trim().is_empty() {
        return if observed.text.trim().is_empty() {
            Ok(Compared::Answer)
        } else {
            Err(format!("body {:?}, recorded empty", observed.text))
        };
    }
    let recorded: Value = serde_json::from_str(recorded_text).map_err(|error| error.to_string())?;
    let replayed = observed.body.clone().unwrap_or(Value::Null);
    let recorded = labels.0.canonical("rest", &recorded);
    let replayed = labels.1.canonical("rest", &replayed);
    if recorded == replayed {
        return Ok(Compared::Answer);
    }
    // An error answer: production wraps a streaming method's error in an
    // array and adds `details`; the status, code and message are compared.
    let error = |body: &Value| {
        let body = if body.is_array() { &body[0] } else { body };
        let error = &body["error"];
        (error.is_object()).then(|| {
            (
                error["code"].clone(),
                error["status"].clone(),
                error["message"].clone(),
            )
        })
    };
    if status >= 400
        && let (Some(left), Some(right)) = (error(&recorded), error(&replayed))
        && left == right
    {
        return Ok(Compared::Error);
    }
    Err(format!("body {replayed}, recorded {recorded}"))
}

// ------------------------------------------------------------ scenarios

/// Replays one scenario against each oracle that recorded it, checks every
/// case against the recording and the tables above, and notes the ledger.
#[allow(clippy::too_many_lines)] // The tables' rules read best in one place.
async fn scenario(root: &str, name: &str) {
    let mut outcomes = Vec::new();
    let mut stalls = Vec::new();
    for oracle in [Oracle::Java, Oracle::Cloud] {
        let Some(recording) = Recording::load(root, oracle, name) else {
            continue;
        };
        let replayed = Replay::new(&recording).replay().await;
        outcomes.extend(compare(&recording, &replayed));
        stalls.extend(
            replayed
                .stalls
                .into_iter()
                .map(|stall| format!("{}: {stall}", recording.set)),
        );
    }
    assert!(!outcomes.is_empty(), "{root}/{name}: no recording");
    let production = |case: &str| {
        outcomes.iter().any(|outcome| {
            outcome.set.ends_with("production-cloud-firestore")
                && outcome.case == case
                && outcome.result.is_ok()
        })
    };
    let production_handshakes_match = outcomes
        .iter()
        .filter(|outcome| outcome.handshake && outcome.set.ends_with("production-cloud-firestore"))
        .all(|outcome| outcome.result.is_ok());
    let mut failures = Vec::new();
    for outcome in &outcomes {
        let differs = DIFFERS
            .iter()
            .find(|entry| entry.set == outcome.set && entry.case == outcome.case);
        let bug = BUG_CANDIDATES
            .iter()
            .find(|entry| entry.set == outcome.set && entry.case == outcome.case);
        match (differs, bug, &outcome.result) {
            (Some(entry), _, Err(_)) => {
                let instead = match entry.instead {
                    Instead::Production(case) => production(case),
                    Instead::Replay(check) => check(outcome),
                };
                if !instead {
                    failures.push(format!(
                        "{} {}: differs otherwise than DIFFERS says: {:?}",
                        outcome.set, outcome.case, outcome.result
                    ));
                } else if !outcome.noted_elsewhere {
                    firenook_conformance_ledger::differs(
                        &outcome.set,
                        &outcome.case,
                        entry.compared,
                        entry.reason,
                    );
                }
            }
            (Some(_), _, Ok(_)) => failures.push(format!(
                "{} {}: now matches the recording; take it out of DIFFERS",
                outcome.set, outcome.case
            )),
            (None, Some(_), Err(_)) => {}
            (None, Some(bug), Ok(_)) => failures.push(format!(
                "{} {}: the bug candidate ({}) now matches the recording; take it out of BUG_CANDIDATES",
                outcome.set, outcome.case, bug.description
            )),
            (None, None, Err(_)) if outcome.production_handshake && production_handshakes_match => {
                if !outcome.noted_elsewhere {
                    firenook_conformance_ledger::differs(
                        &outcome.set,
                        &outcome.case,
                        Compared::Answer,
                        "the handshake advertises production's server version 14 (conformance/fixtures/webchannel-v8/README.md, production handshake; every production handshake replayed here matches); Java 1.22.0 sends 12",
                    );
                }
            }
            (None, None, Err(error)) => {
                failures.push(format!("{} {}: {error}", outcome.set, outcome.case));
            }
            (None, None, Ok(compared)) => {
                if !outcome.noted_elsewhere {
                    firenook_conformance_ledger::checked(&outcome.set, &outcome.case, *compared);
                }
            }
        }
    }
    for (set, case) in DIFFERS
        .iter()
        .map(|entry| (entry.set, entry.case))
        .chain(BUG_CANDIDATES.iter().map(|entry| (entry.set, entry.case)))
    {
        if set.starts_with(root)
            && case.split('/').next() == Some(name)
            && !outcomes
                .iter()
                .any(|outcome| outcome.set == set && outcome.case == case)
        {
            failures.push(format!("{set} {case}: listed but not replayed"));
        }
    }
    assert!(
        failures.is_empty(),
        "{root}/{name}:\n{}\nwaits that ran out:\n{}",
        failures.join("\n"),
        stalls.join("\n")
    );
}

macro_rules! scenarios {
    ($($test:ident => $root:literal / $name:literal,)*) => {
        $(
            #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
            async fn $test() {
                scenario($root, $name).await;
            }
        )*
    };
}

scenarios! {
    backchannel_reconnect_replay => "webchannel-v8" / "backchannel-reconnect-replay",
    bundle_nanosecond_read_time => "webchannel-v8" / "bundle-nanosecond-read-time",
    listen_long_poll => "webchannel-v8" / "listen-long-poll",
    listen_streaming => "webchannel-v8" / "listen-streaming",
    multiple_inequality_query => "webchannel-v8" / "multiple-inequality-query",
    numeric_resource_id_ordering => "webchannel-v8" / "numeric-resource-id-ordering",
    reserved_resource_id_error => "webchannel-v8" / "reserved-resource-id-error",
    unicode_framing => "webchannel-v8" / "unicode-framing",
    unknown_sid => "webchannel-v8" / "unknown-sid",
    write_batch_six => "webchannel-v8" / "write-batch-six",
    write_cross_client_update => "webchannel-v8" / "write-cross-client-update",
    write_long_poll => "webchannel-v8" / "write-long-poll",
    write_missing_update_error => "webchannel-v8" / "write-missing-update-error",
    write_overlap => "webchannel-v8" / "write-overlap",
    write_streaming => "webchannel-v8" / "write-streaming",
    rest_aggregation_composite_filter => "rest-v1" / "aggregation-composite-filter",
    rest_aggregation_count => "rest-v1" / "aggregation-count",
    rest_aggregation_limit_error => "rest-v1" / "aggregation-limit-error",
    rest_transaction_commit => "rest-v1" / "transaction-commit",
    rest_transaction_noop_write => "rest-v1" / "transaction-noop-write",
}
