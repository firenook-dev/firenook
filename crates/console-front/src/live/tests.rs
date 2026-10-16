use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::body::{Body, BodyDataStream, to_bytes};
use axum::http::{Request, StatusCode};
use futures_util::future;
use serde_json::{Value, json};
use tokio::sync::{broadcast, watch};
use tokio_stream::wrappers::BroadcastStream;
use tower::ServiceExt as _;

use super::*;

const REVISION: &str = "63d554c15f2699cf623c7fac19a4d1393c77f322";

/// A topic whose events the test sends.
struct Feed {
    sender: broadcast::Sender<TopicEvent>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FeedParams {
    #[serde(rename = "label")]
    _label: Option<String>,
}

impl LiveTopic for Feed {
    fn name(&self) -> &'static str {
        "test.feed"
    }

    fn open(&self, params: &Value, _after: Option<&str>) -> Result<TopicStream, ApiError> {
        topic_params::<FeedParams>(params)?;
        Ok(BroadcastStream::new(self.sender.subscribe())
            .filter_map(|event| future::ready(event.ok()))
            .boxed())
    }
}

/// A topic that says one thing and is done, without saying so.
struct Finite;

impl LiveTopic for Finite {
    fn name(&self) -> &'static str {
        "test.finite"
    }

    fn open(&self, _params: &Value, _after: Option<&str>) -> Result<TopicStream, ApiError> {
        Ok(stream::iter([
            TopicEvent::json("done", Some("f.1".to_owned()), &json!({ "ok": true })),
            TopicEvent::Reset {
                reason: ResetReason::Gap,
                missed: Some(42),
            },
        ])
        .boxed())
    }
}

/// A topic that answers its first subscriber with ten 1 MiB events at
/// once, more than a connection queues, and later ones with nothing.
struct Burst {
    opened: AtomicBool,
    reopened_after: Mutex<Option<String>>,
}

impl LiveTopic for Burst {
    fn name(&self) -> &'static str {
        "test.burst"
    }

    fn open(&self, _params: &Value, after: Option<&str>) -> Result<TopicStream, ApiError> {
        if self.opened.swap(true, Ordering::SeqCst) {
            *lock(&self.reopened_after) = after.map(str::to_owned);
            return Ok(stream::pending().boxed());
        }
        let big: Arc<str> = Arc::from(format!("\"{}\"", "x".repeat(1024 * 1024)));
        Ok(stream::iter((1..=10).map(move |index| TopicEvent::Event {
            name: "big",
            cursor: Some(Arc::from(format!("b.{index}"))),
            data: big.clone(),
        }))
        .boxed())
    }
}

struct Harness {
    hub: LiveHub,
    feed: broadcast::Sender<TopicEvent>,
    burst: Arc<Burst>,
    stop: watch::Sender<bool>,
}

fn harness() -> Harness {
    let (feed, _) = broadcast::channel(64);
    let burst = Arc::new(Burst {
        opened: AtomicBool::new(false),
        reopened_after: Mutex::new(None),
    });
    let (stop, receiver) = watch::channel(false);
    let hub = LiveHub::new(
        vec![
            Arc::new(Feed {
                sender: feed.clone(),
            }),
            Arc::new(Finite),
            burst.clone(),
        ],
        BTreeMap::from([("auth", "Authentication")]),
        HelloFacts {
            instance: Instance::new(),
            console_build: "0123456789abcdef".to_owned(),
            engine_revision: Some(REVISION.to_owned()),
        },
        Shutdown::new(receiver),
    );
    Harness {
        hub,
        feed,
        burst,
        stop,
    }
}

#[derive(Debug)]
struct Message {
    event: String,
    id: Option<String>,
    retry: Option<String>,
    data: Value,
}

/// Reads server-sent events off a response body.
struct Reader {
    body: BodyDataStream,
    buffer: String,
}

impl Reader {
    /// The next event, or `None` when the body ended.
    async fn next(&mut self) -> Option<Message> {
        loop {
            if let Some(end) = self.buffer.find("\n\n") {
                let raw = self.buffer[..end].to_owned();
                self.buffer.drain(..end + 2);
                if raw.starts_with(':') {
                    continue;
                }
                let mut message = Message {
                    event: "message".to_owned(),
                    id: None,
                    retry: None,
                    data: Value::Null,
                };
                let mut data = String::new();
                for line in raw.lines() {
                    let (field, value) = line.split_once(':').unwrap_or((line, ""));
                    let value = value.strip_prefix(' ').unwrap_or(value);
                    match field {
                        "event" => message.event = value.to_owned(),
                        "id" => message.id = Some(value.to_owned()),
                        "retry" => message.retry = Some(value.to_owned()),
                        "data" => data.push_str(value),
                        _ => {}
                    }
                }
                message.data = serde_json::from_str(&data).unwrap_or(Value::Null);
                return Some(message);
            }
            let chunk = tokio::time::timeout(Duration::from_secs(10), self.body.next())
                .await
                .expect("the stream said something")?;
            self.buffer
                .push_str(&String::from_utf8_lossy(&chunk.expect("bytes")));
        }
    }

    /// The next event that is not `ev` for another subscription.
    async fn next_for(&mut self, sub: &str) -> Message {
        loop {
            let message = self.next().await.expect("an event");
            if message.data["sub"] == sub {
                return message;
            }
        }
    }
}

async fn open(router: &Router) -> (StatusCode, Option<(String, Reader, Message)>) {
    let response = router
        .clone()
        .oneshot(Request::get("/live").body(Body::empty()).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    if status != StatusCode::OK {
        return (status, None);
    }
    assert_eq!(
        response.headers()["content-type"],
        "text/event-stream",
        "the live channel is a stream"
    );
    let mut reader = Reader {
        body: response.into_body().into_data_stream(),
        buffer: String::new(),
    };
    let hello = reader.next().await.expect("hello");
    assert_eq!(hello.event, "hello");
    let connection = hello.data["connection"]
        .as_str()
        .expect("a connection id")
        .to_owned();
    (status, Some((connection, reader, hello)))
}

async fn post(router: &Router, connection: &str, body: Value) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::post(format!("/live/{connection}/subscriptions"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn add(id: &str, topic: &str) -> Value {
    json!({ "id": id, "topic": topic, "params": {} })
}

#[tokio::test]
async fn hello_comes_first_with_what_a_page_compares() {
    let harness = harness();
    let router = harness.hub.clone().router();
    let (_, opened) = open(&router).await;
    let (connection, _reader, hello) = opened.expect("open");
    assert!(
        connection.starts_with('c') && connection.len() == 17,
        "{connection}"
    );
    assert_eq!(hello.retry.as_deref(), Some("1000"));
    assert_eq!(hello.data["instance"].as_str().map(str::len), Some(16));
    assert_eq!(hello.data["heartbeatMs"], 15_000);
    assert_eq!(hello.data["limits"], json!({ "subscriptions": 128 }));
    assert_eq!(hello.data["consoleBuild"], "0123456789abcdef");
    assert_eq!(hello.data["engineRevision"], REVISION);
}

#[tokio::test]
async fn added_subscriptions_carry_their_events_and_removed_ones_stop() {
    let harness = harness();
    let router = harness.hub.clone().router();
    let (connection, mut reader, _) = open(&router).await.1.expect("open");
    let (status, body) = post(
        &router,
        &connection,
        json!({ "add": [add("t1.s1", "test.feed"), add("t1.s2", "test.feed")] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["accepted"], json!(["t1.s1", "t1.s2"]));
    assert_eq!(body["refused"], json!([]));
    harness
        .feed
        .send(TopicEvent::json(
            "changed",
            Some("c.1".to_owned()),
            &json!({ "k": 1 }),
        ))
        .expect("subscribers");
    let first = reader.next_for("t1.s1").await;
    assert_eq!(first.event, "ev");
    assert!(first.id.is_some());
    assert_eq!(
        first.data,
        json!({ "sub": "t1.s1", "name": "changed", "cursor": "c.1", "data": { "k": 1 } })
    );
    let (status, _) = post(&router, &connection, json!({ "remove": ["t1.s1"] })).await;
    assert_eq!(status, StatusCode::OK);
    // A removal is a command to the connection: wait for it to land.
    tokio::time::timeout(Duration::from_secs(5), async {
        while harness.feed.receiver_count() != 1 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the removed subscription let go of its topic");
    harness
        .feed
        .send(TopicEvent::json("changed", None, &json!({ "k": 2 })))
        .expect("subscribers");
    let mut subs = Vec::new();
    loop {
        let message = reader.next().await.expect("an event");
        if message.event == "ev" {
            subs.push(message.data["sub"].clone());
            if message.data["data"]["k"] == 2 {
                break;
            }
        }
    }
    assert!(!subs.contains(&json!("t1.s1")), "{subs:?}");
}

#[tokio::test]
async fn ids_are_unique_and_a_connection_holds_at_most_128() {
    let harness = harness();
    let router = harness.hub.clone().router();
    let (connection, _reader, _) = open(&router).await.1.expect("open");
    let (status, body) = post(
        &router,
        &connection,
        json!({ "add": [add("same", "test.feed"), add("same", "test.feed")] }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["code"], "invalid-argument");
    let (status, _) = post(
        &router,
        &connection,
        json!({ "add": [add(&"x".repeat(33), "test.feed")] }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let many = (0..128)
        .map(|index| add(&format!("t1.s{index}"), "test.feed"))
        .collect::<Vec<_>>();
    let (status, body) = post(&router, &connection, json!({ "add": many })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["accepted"].as_array().map(Vec::len), Some(128));
    let (status, body) = post(
        &router,
        &connection,
        json!({ "add": [add("t1.s128", "test.feed")] }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        body["error"]["message"],
        "A live connection holds at most 128 subscriptions."
    );
    let (status, body) = post(
        &router,
        &connection,
        json!({ "add": [add("t1.s0", "test.feed")] }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "an id in use: {body}");
}

#[tokio::test]
async fn unknown_topics_and_bad_parameters_are_refused_in_the_answer() {
    let harness = harness();
    let router = harness.hub.clone().router();
    let (connection, _reader, _) = open(&router).await.1.expect("open");
    let (status, body) = post(
        &router,
        &connection,
        json!({ "add": [
            add("a", "nope.thing"),
            add("b", "auth.users"),
            { "id": "c", "topic": "test.feed", "params": { "bogus": 1 } },
            { "id": "d", "topic": "test.feed", "params": { "label": "fine" } },
        ] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["accepted"], json!(["d"]));
    let refused = body["refused"].as_array().expect("refused");
    assert_eq!(refused[0]["id"], "a");
    assert_eq!(refused[0]["error"]["code"], "invalid-argument");
    assert_eq!(
        refused[0]["error"]["message"],
        "No live topic named `nope.thing`."
    );
    assert!(refused[0]["error"].get("fix").is_none());
    assert_eq!(
        refused[1]["error"]["fix"],
        "Start the engine with Authentication."
    );
    assert_eq!(refused[2]["id"], "c");
    assert!(
        refused[2]["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("bogus")),
        "{body}"
    );
    // A refused id is free again.
    let (status, body) = post(
        &router,
        &connection,
        json!({ "add": [add("a", "test.feed")] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["accepted"], json!(["a"]));
}

#[tokio::test]
async fn a_post_to_a_connection_that_is_gone_is_not_found() {
    let harness = harness();
    let router = harness.hub.clone().router();
    let (status, body) = post(&router, "c0000000000000000", json!({ "add": [] })).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["code"], "not-found");
    assert_eq!(
        body["error"]["fix"],
        "Subscribe again after the next hello on the live stream."
    );
    let (status, body) = post(&router, "c0000000000000000", json!({ "nope": [] })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

#[tokio::test]
async fn a_finished_topic_ends_without_an_error_and_resets_carry_missed() {
    let harness = harness();
    let router = harness.hub.clone().router();
    let (connection, mut reader, _) = open(&router).await.1.expect("open");
    post(
        &router,
        &connection,
        json!({ "add": [add("t1.f", "test.finite")] }),
    )
    .await;
    let done = reader.next_for("t1.f").await;
    assert_eq!(done.event, "ev");
    assert_eq!(done.data["name"], "done");
    let reset = reader.next_for("t1.f").await;
    assert_eq!(reset.event, "reset");
    assert_eq!(
        reset.data,
        json!({ "sub": "t1.f", "reason": "gap", "missed": 42 })
    );
    let end = reader.next_for("t1.f").await;
    assert_eq!(end.event, "end");
    assert_eq!(end.data, json!({ "sub": "t1.f" }));
    // Its id is released with it.
    let (_, body) = post(
        &router,
        &connection,
        json!({ "add": [add("t1.f", "test.feed")] }),
    )
    .await;
    assert_eq!(body["accepted"], json!(["t1.f"]));
}

#[tokio::test]
async fn the_65th_connection_is_refused_and_the_probe_says_why() {
    let harness = harness();
    let router = harness.hub.clone().router();
    let mut held = Vec::new();
    for _ in 0..MAX_CONNECTIONS {
        let (status, opened) = open(&router).await;
        assert_eq!(status, StatusCode::OK);
        held.push(opened);
    }
    let (status, _) = open(&router).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let response = router
        .clone()
        .oneshot(
            Request::get("/live?probe=1")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.headers()["content-type"], "application/json");
    let probe: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(probe, json!({ "connections": 64, "limit": 64 }));
}

#[tokio::test]
async fn a_closed_browser_frees_its_slot_and_its_entry() {
    let harness = harness();
    let router = harness.hub.clone().router();
    let opened = open(&router).await.1.expect("open");
    assert_eq!(harness.hub.registered_connections(), 1);
    assert_eq!(harness.hub.open_connections(), 1);
    drop(opened);
    tokio::time::timeout(Duration::from_secs(5), async {
        while harness.hub.registered_connections() != 0 || harness.hub.open_connections() != 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the connection let go of its slot");
}

#[tokio::test]
async fn a_subscription_past_the_queue_is_reset_while_the_others_keep_flowing() {
    let harness = harness();
    let router = harness.hub.clone().router();
    let (connection, mut reader, _) = open(&router).await.1.expect("open");
    // Nothing reads the stream while the burst arrives.
    post(
        &router,
        &connection,
        json!({ "add": [add("t1.small", "test.feed"), add("t1.big", "test.burst")] }),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while !harness.burst.opened.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the burst was opened");
    tokio::time::sleep(Duration::from_millis(100)).await;
    for index in 0..3 {
        harness
            .feed
            .send(TopicEvent::json(
                "changed",
                Some(format!("s.{index}")),
                &json!({ "index": index }),
            ))
            .expect("subscribers");
    }
    let mut big = 0;
    let mut reset = None;
    let mut small_after_reset = 0;
    while small_after_reset < 3 {
        let message = reader.next().await.expect("an event");
        match (message.event.as_str(), message.data["sub"].as_str()) {
            ("ev", Some("t1.big")) => {
                assert!(
                    reset.is_none(),
                    "nothing of the lagged subscription after its reset"
                );
                big += 1;
            }
            ("reset", Some("t1.big")) => reset = Some(message.data),
            ("ev", Some("t1.small")) if reset.is_some() => small_after_reset += 1,
            _ => {}
        }
    }
    // 8 MiB of queue holds seven 1 MiB events with their envelopes.
    assert_eq!(big, 7);
    assert_eq!(
        reset,
        Some(json!({ "sub": "t1.big", "reason": "lagged", "missed": null }))
    );
    // Once the queue drained, it resumed from the last cursor delivered.
    tokio::time::timeout(Duration::from_secs(5), async {
        while lock(&harness.burst.reopened_after).is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("re-opened");
    assert_eq!(lock(&harness.burst.reopened_after).as_deref(), Some("b.7"));
}

#[tokio::test]
async fn the_stream_says_stopping_and_ends_when_the_suite_stops() {
    let harness = harness();
    let router = harness.hub.clone().router();
    let (connection, mut reader, _) = open(&router).await.1.expect("open");
    post(
        &router,
        &connection,
        json!({ "add": [add("t1.s1", "test.feed")] }),
    )
    .await;
    harness.stop.send(true).expect("a receiver");
    let stopping = reader.next().await.expect("stopping");
    assert_eq!(stopping.event, "stopping");
    assert_eq!(stopping.data, json!({}));
    assert!(reader.next().await.is_none(), "the body ended");
    // And a stopping engine opens no new stream.
    let (status, _) = open(&router).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

#[test]
fn topic_parameters_are_an_object_and_refuse_unknown_fields() {
    assert!(topic_params::<FeedParams>(&Value::Null).is_ok());
    assert!(topic_params::<FeedParams>(&json!({})).is_ok());
    let error = topic_params::<FeedParams>(&json!([1]))
        .err()
        .expect("refused");
    assert_eq!(
        error.detail().message,
        "Topic parameters are a JSON object."
    );
    let error = topic_params::<FeedParams>(&json!({ "lable": "x" }))
        .err()
        .expect("refused");
    assert!(error.detail().message.contains("lable"), "{error}");
}

#[test]
fn the_envelope_is_written_by_hand_around_the_shared_data() {
    assert_eq!(
        envelope("t\"1", "change", Some("1a.2"), "{\"a\":[1]}"),
        r#"{"sub":"t\"1","name":"change","cursor":"1a.2","data":{"a":[1]}}"#
    );
    assert_eq!(
        envelope("t1", "tick", None, "null"),
        r#"{"sub":"t1","name":"tick","cursor":null,"data":null}"#
    );
}
