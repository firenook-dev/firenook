//! The section's live side: the feed (rings, bodies, steps, badge), the
//! five topics, the status ticks and the shutdown (tests 36, 37 and 42a of
//! the section's plan).

use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body as HttpBody, Bytes, to_bytes};
use axum::http::{Request, StatusCode};
use firenook_auth_front::AuthRuntime;
use firenook_auth_front::observe::{
    Body, CallKind, CallRecord, Caller, ConfigChange, Credential, Delivery, MessageKind,
    MessageRecord, Step, UserChange,
};
use firenook_functions_bridge::{TriggerObserver, TriggerRegistry};
use futures_util::StreamExt as _;
use serde_json::{Value, json};
use tokio::sync::watch;
use tower::ServiceExt as _;

use super::feed::{ACTIVITY_CAPACITY, MAX_STEPS};
use super::{AuthConsole, AuthSection};
use crate::foreign::ForeignProjects;
use crate::instance::Instance;
use crate::jobs::JobRegistry;
use crate::live::badges::BadgeBoard;
use crate::live::{LiveTopic, ResetReason, TopicEvent, TopicStream};
use crate::section::{Section, SectionContext};
use crate::sse::Shutdown;

const PROJECT: &str = "demo-console";

struct Live {
    auth: AuthRuntime,
    console: AuthConsole,
    section: AuthSection,
    context: SectionContext,
    stop: watch::Sender<bool>,
    topics: Vec<Arc<dyn LiveTopic>>,
}

fn live() -> Live {
    let registry = TriggerRegistry::default();
    let (observer, _deliveries) = TriggerObserver::channel(registry.clone());
    let auth = firenook_auth_front::router(PROJECT, observer.queue(), registry);
    let console = AuthConsole::attach(&auth, true, firenook_suite_front::LoggingRuntime::new());
    let (stop, receiver) = watch::channel(false);
    let context = SectionContext {
        project: Arc::from(PROJECT),
        shutdown: Shutdown::new(receiver),
        badges: BadgeBoard::default(),
        instance: Instance::new(),
        jobs: JobRegistry::new(),
        rings: firenook_suite_front::RingBudget::shared(),
        foreign: ForeignProjects::default(),
    };
    let section = AuthSection(console.clone());
    let topics = section.topics(&context);
    Live {
        auth,
        console,
        section,
        context,
        stop,
        topics,
    }
}

impl Live {
    fn open(&self, name: &str, params: &Value, after: Option<&str>) -> TopicStream {
        self.topic(name).open(params, after).expect("opened")
    }

    fn topic(&self, name: &str) -> &Arc<dyn LiveTopic> {
        self.topics
            .iter()
            .find(|topic| topic.name() == name)
            .expect("the topic")
    }

    /// A call to the Auth emulator's own application.
    async fn native(&self, path: &str, body: &Value) -> Value {
        let response = self
            .console
            .native
            .clone()
            .oneshot(
                Request::post(format!(
                    "/identitytoolkit.googleapis.com/v1/{path}?key=fake"
                ))
                .header("content-type", "application/json")
                .body(HttpBody::from(body.to_string()))
                .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        serde_json::from_slice(&bytes).expect("json")
    }

    async fn sign_up(&self, email: &str) -> Value {
        self.native(
            "accounts:signUp",
            &json!({ "email": email, "password": "secret-1", "returnSecureToken": true }),
        )
        .await
    }

    fn generation(&self, tenant: Option<&str>) -> u64 {
        self.console
            .runtime
            .users(PROJECT, tenant)
            .expect("scope")
            .generation()
    }
}

/// The next event within `wait`, or `None`.
async fn next(stream: &mut TopicStream, wait: Duration) -> Option<TopicEvent> {
    tokio::time::timeout(wait, stream.next())
        .await
        .ok()
        .flatten()
}

/// Every event that arrives within `wait`.
async fn drain(stream: &mut TopicStream, wait: Duration) -> Vec<TopicEvent> {
    let mut events = Vec::new();
    let deadline = tokio::time::Instant::now() + wait;
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, stream.next()).await {
        events.push(event);
    }
    events
}

/// The next window of a feed topic, past its cursor ticks.
async fn batch(stream: &mut TopicStream) -> Value {
    loop {
        let event = next(stream, Duration::from_secs(1))
            .await
            .expect("a window");
        if let TopicEvent::Event { name: "tick", .. } = event {
            continue;
        }
        return data(&event).1;
    }
}

fn data(event: &TopicEvent) -> (&'static str, Value) {
    match event {
        TopicEvent::Event { name, data, .. } => (name, serde_json::from_str(data).expect("json")),
        other => panic!("not an event: {other:?}"),
    }
}

/// A recorded call with `steps`, for the feed.
fn record(id: u64, steps: Vec<Step>) -> CallRecord {
    CallRecord {
        id,
        at_millis: 1_790_812_800_000,
        duration: Duration::from_micros(250),
        project: PROJECT.to_owned(),
        tenant: None,
        caller: Caller::Admin,
        origin: None,
        credential: Credential::Owner,
        client: None,
        method: "POST".to_owned(),
        path: "/identitytoolkit.googleapis.com/v1/projects/demo-console/accounts:update".to_owned(),
        operation: "identitytoolkit.projects.accounts.update".to_owned(),
        kind: CallKind::Account,
        identifier: None,
        provider: None,
        uid: None,
        new_user: None,
        status: 200,
        error: None,
        request: Body::NotKept,
        response: Body::NotKept,
        query: Vec::new(),
        headers: Vec::new(),
        steps,
    }
}

fn created(uid: &str) -> Step {
    Step::User {
        tenant: None,
        uid: uid.to_owned(),
        change: UserChange::Created,
        fields: Vec::new(),
    }
}

fn message(id: u64, delivery: Delivery) -> MessageRecord {
    MessageRecord {
        id,
        project: PROJECT.to_owned(),
        tenant: None,
        kind: MessageKind::PasswordReset,
        to: "ada@example.test".to_owned(),
        new_email: None,
        uid: Some("u_ada".to_owned()),
        code: format!("code-{id}"),
        link: None,
        continue_url: None,
        delivery,
        origin: None,
        key: format!("code-{id}"),
        text: String::new(),
        at_millis: Some(1_790_812_800_000),
    }
}

use firenook_auth_front::observe::AuthObserver as _;

// ---------------------------------------------------------------- feed

#[tokio::test]
async fn the_activity_list_keeps_the_newest_calls_and_caps_steps() {
    let live = live();
    let feed = &live.console.feed;
    let total = u64::try_from(ACTIVITY_CAPACITY).expect("fits") + 5;
    for id in 1..=total {
        feed.call(record(id, Vec::new()));
    }
    let (entries, _) = feed.activity();
    assert_eq!(entries.len(), ACTIVITY_CAPACITY);
    assert_eq!(entries[0].summary.id, 6, "the oldest went first");
    assert!(feed.call_entry(5).is_none());
    assert!(feed.call_entry(total).is_some());
    let steps = (0..60)
        .map(|index| created(&format!("u_{index}")))
        .collect();
    feed.call(record(total + 1, steps));
    let entry = feed.call_entry(total + 1).expect("kept");
    assert_eq!(entry.summary.steps.len(), MAX_STEPS);
    assert_eq!(entry.summary.more_steps, 10);
    // The list's own order continues; the ring follows it.
    assert_eq!(entry.seq, total + 1);
}

#[tokio::test]
async fn bodies_are_dropped_oldest_first_beyond_their_budget() {
    let live = live();
    let feed = &live.console.feed;
    let body = Bytes::from(vec![b'x'; 16 * 1024]);
    for id in 1..=300 {
        let mut call = record(id, Vec::new());
        call.request = Body::Kept(body.clone());
        call.response = Body::Kept(body.clone());
        feed.call(call);
    }
    let first = feed.call_entry(1).expect("kept");
    let bodies = first.bodies.lock().expect("bodies");
    assert!(
        bodies.dropped && bodies.request.is_none(),
        "the oldest lost its bodies"
    );
    drop(bodies);
    let last = feed.call_entry(300).expect("kept");
    let bodies = last.bodies.lock().expect("bodies");
    assert!(bodies.kept && !bodies.dropped && bodies.request.is_some());
    assert_eq!(first.request_bytes, 16 * 1024, "the length stays");
}

#[tokio::test]
async fn the_badge_counts_issued_codes_and_not_restored_ones() {
    let live = live();
    let feed = &live.console.feed;
    feed.call(record(
        1,
        vec![Step::MessageSent(message(1, Delivery::Sent))],
    ));
    feed.call(record(
        2,
        vec![Step::MessageSent(message(2, Delivery::Restored))],
    ));
    feed.call(record(
        3,
        vec![Step::MessageSent(message(3, Delivery::Returned))],
    ));
    let badges = live.context.badges.snapshot();
    let inbox = badges
        .badges
        .iter()
        .find(|badge| badge.id == "auth.inbox")
        .expect("the auth.inbox badge");
    assert_eq!(inbox.count, 2);
    assert_eq!(inbox.noun.one, "new code or link");
    // A used code is marked with the call that used it.
    feed.call(record(
        4,
        vec![Step::MessageUsed {
            key: "code-1".to_owned(),
        }],
    ));
    let used = feed.message(1).expect("kept").wire();
    assert!(used.used);
    assert_eq!(used.used_by, Some(4));
    let sent = feed.call_entry(1).expect("kept");
    assert!(matches!(
        &sent.summary.steps[0],
        super::wire::AuthStep::Message { id, .. } if *id == 1
    ));
}

// ---------------------------------------------------------------- topics

#[tokio::test]
async fn every_topic_refuses_an_unknown_parameter() {
    let live = live();
    for name in [
        "auth.users",
        "auth.activity",
        "auth.inbox",
        "auth.config",
        "auth.hooks",
    ] {
        let refused = live
            .topic(name)
            .open(&json!({ "nope": 1 }), None)
            .err()
            .unwrap_or_else(|| panic!("{name} took an unknown parameter"));
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST, "{name}");
    }
    let refused = live
        .topic("auth.activity")
        .open(&json!({ "q": "status:abc" }), None)
        .err()
        .expect("a bad q is refused");
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn users_windows_coalesce_merge_and_skip_refreshes() {
    let live = live();
    live.auth
        .runtime()
        .update(|data| data.agent(PROJECT).ensure_tenant(PROJECT, "acme"))
        .expect("saved");
    let mut users = live.open("auth.users", &json!({}), None);
    let mut acme = live.open("auth.users", &json!({ "tenant": "acme" }), None);
    let first = live.sign_up("one@example.test").await;
    live.sign_up("two@example.test").await;
    let events = drain(&mut users, Duration::from_millis(400)).await;
    let mut seen = Vec::new();
    for event in &events {
        let (name, data) = data(event);
        assert_eq!(name, "changed");
        assert_eq!(data["tenant"], Value::Null);
        for change in data["changes"].as_array().expect("changes") {
            assert_eq!(
                change["change"], "created",
                "created then updated stays created"
            );
            seen.push(change["uid"].as_str().expect("uid").to_owned());
        }
    }
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), 2, "{events:?}");
    assert!(events.len() <= 2, "one window, or two at most: {events:?}");
    match events.last() {
        Some(TopicEvent::Event { cursor, .. }) => assert_eq!(
            cursor.as_deref(),
            Some(live.generation(None).to_string().as_str())
        ),
        other => panic!("{other:?}"),
    }
    assert!(
        next(&mut acme, Duration::from_millis(50)).await.is_none(),
        "other scope"
    );
    // A token refresh sends nothing.
    let refresh = live
        .console
        .native
        .clone()
        .oneshot(
            Request::post("/securetoken.googleapis.com/v1/token?key=fake")
                .header("content-type", "application/json")
                .body(HttpBody::from(
                    json!({ "grant_type": "refresh_token", "refresh_token": first["refreshToken"] })
                        .to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(refresh.status(), StatusCode::OK);
    assert!(
        next(&mut users, Duration::from_millis(300)).await.is_none(),
        "a refresh alone is never sent"
    );
}

#[tokio::test]
async fn a_big_window_or_an_overflow_is_a_reset() {
    let live = live();
    let mut users = live.open("auth.users", &json!({}), None);
    let steps = (0..1_001)
        .map(|index| created(&format!("u_{index}")))
        .collect();
    live.console.feed.call(record(1, steps));
    let event = next(&mut users, Duration::from_secs(1))
        .await
        .expect("an event");
    assert!(matches!(event, TopicEvent::Reset { .. }), "{event:?}");
    let steps = (0..5_000)
        .map(|index| created(&format!("v_{index}")))
        .collect();
    live.console.feed.call(record(2, steps));
    let events = drain(&mut users, Duration::from_millis(400)).await;
    assert!(
        events.iter().any(|event| matches!(
            event,
            TopicEvent::Reset {
                reason: ResetReason::Lagged,
                ..
            }
        )),
        "{events:?}"
    );
}

#[tokio::test]
async fn resuming_users_compares_the_generation() {
    let live = live();
    live.sign_up("one@example.test").await;
    // Its window goes out first.
    tokio::time::sleep(Duration::from_millis(250)).await;
    let current = live.generation(None).to_string();
    let mut resumed = live.open("auth.users", &json!({}), Some(&current));
    assert!(
        next(&mut resumed, Duration::from_millis(150))
            .await
            .is_none()
    );
    let mut behind = live.open("auth.users", &json!({}), Some("0"));
    let event = next(&mut behind, Duration::from_millis(150))
        .await
        .expect("reset");
    assert!(
        matches!(
            event,
            TopicEvent::Reset {
                reason: ResetReason::Gap,
                ..
            }
        ),
        "{event:?}"
    );
}

#[tokio::test]
async fn activity_replays_filters_and_says_when_cleared() {
    let live = live();
    live.sign_up("one@example.test").await;
    live.sign_up("two@example.test").await;
    live.native(
        "accounts:signInWithPassword",
        &json!({ "email": "one@example.test", "password": "secret-1" }),
    )
    .await;
    let mut sign_ups = live.open("auth.activity", &json!({ "q": "kind:sign-up" }), None);
    let replayed = batch(&mut sign_ups).await;
    let items = replayed["items"].as_array().expect("items");
    assert_eq!(items.len(), 2, "{replayed}");
    assert!(
        items
            .iter()
            .all(|item| item["kind"] == "call" && item["summary"]["kind"] == "sign-up")
    );
    live.console.feed.clear_activity(PROJECT);
    let cleared = batch(&mut sign_ups).await;
    assert_eq!(cleared["items"][0]["kind"], "cleared");
    // Another project's subscription never sees these.
    let mut other = live.open("auth.activity", &json!({ "project": "demo-other" }), None);
    let events = drain(&mut other, Duration::from_millis(300)).await;
    assert!(
        events
            .iter()
            .all(|event| !matches!(event, TopicEvent::Event { name: "calls", .. })),
        "{events:?}"
    );
}

#[tokio::test]
async fn the_inbox_topic_sends_issued_used_and_cleared() {
    let live = live();
    let mut inbox = live.open("auth.inbox", &json!({ "q": "type:email" }), None);
    let mut sms = live.open("auth.inbox", &json!({ "q": "type:sms" }), None);
    live.sign_up("reset@example.test").await;
    live.native(
        "accounts:sendOobCode",
        &json!({ "requestType": "PASSWORD_RESET", "email": "reset@example.test" }),
    )
    .await;
    let batch = batch(&mut inbox).await;
    let issued = &batch["items"][0];
    assert_eq!(issued["kind"], "issued", "{batch}");
    let code = issued["message"]["code"].clone();
    live.native(
        "accounts:resetPassword",
        &json!({ "oobCode": code, "newPassword": "secret-2" }),
    )
    .await;
    let used = self::batch(&mut inbox).await;
    assert_eq!(used["items"][0]["kind"], "used", "{used}");
    live.console.feed.clear_messages(PROJECT);
    let cleared = self::batch(&mut inbox).await;
    assert_eq!(cleared["items"][0]["kind"], "cleared");
    let events = drain(&mut sms, Duration::from_millis(50)).await;
    assert!(
        events
            .iter()
            .filter_map(|event| match event {
                TopicEvent::Event { data, .. } => Some(data.to_string()),
                _ => None,
            })
            .all(|data| !data.contains("issued")),
        "the SMS filter keeps no email"
    );
}

#[tokio::test]
async fn config_and_hooks_topics_follow_their_changes() {
    let live = live();
    let mut config = live.open("auth.config", &json!({}), None);
    let mut hooks = live.open("auth.hooks", &json!({}), None);
    live.console.feed.call(record(
        1,
        vec![Step::Config {
            tenant: Some("acme".to_owned()),
            what: ConfigChange::TenantCreated,
        }],
    ));
    let event = next(&mut config, Duration::from_secs(1))
        .await
        .expect("changed");
    let (name, change) = data(&event);
    assert_eq!(name, "changed");
    assert_eq!(change, json!({ "tenant": "acme", "what": "tenantCreated" }));
    let revision = live.console.feed.config_revision().to_string();
    let mut resumed = live.open("auth.config", &json!({}), Some(&revision));
    assert!(
        next(&mut resumed, Duration::from_millis(100))
            .await
            .is_none()
    );
    let mut behind = live.open("auth.config", &json!({}), Some("0"));
    assert!(matches!(
        next(&mut behind, Duration::from_millis(100)).await,
        Some(TopicEvent::Reset {
            reason: ResetReason::Gap,
            ..
        })
    ));
    live.auth.blocking_changed();
    let (name, _) = data(
        &next(&mut hooks, Duration::from_secs(1))
            .await
            .expect("hooks"),
    );
    assert_eq!(name, "changed");
}

#[tokio::test]
async fn the_status_ticks_once_for_a_burst_and_never_for_refreshes() {
    let live = live();
    let mut ticks = live.section.status_changes().expect("ticks");
    let burst = (0..500)
        .map(|index| created(&format!("u_{index}")))
        .collect();
    live.console.feed.call(record(1, burst));
    let mut count = 0;
    while tokio::time::timeout(Duration::from_millis(800), ticks.next())
        .await
        .is_ok_and(|tick| tick.is_some())
    {
        count += 1;
    }
    assert_eq!(count, 1);
    let refreshes = (0..50)
        .map(|index| Step::User {
            tenant: None,
            uid: format!("u_{index}"),
            change: UserChange::Updated,
            fields: vec!["lastRefreshAt".to_owned()],
        })
        .collect();
    live.console.feed.call(record(2, refreshes));
    assert!(
        tokio::time::timeout(Duration::from_millis(400), ticks.next())
            .await
            .is_err(),
        "refreshes move no count"
    );
}

#[tokio::test]
async fn every_stream_and_the_coalescer_end_when_the_suite_stops() {
    let live = live();
    let mut streams: Vec<TopicStream> = [
        "auth.users",
        "auth.activity",
        "auth.inbox",
        "auth.config",
        "auth.hooks",
    ]
    .iter()
    .map(|name| live.open(name, &json!({}), None))
    .collect();
    live.stop.send(true).expect("stop");
    for stream in &mut streams {
        let ended = tokio::time::timeout(Duration::from_secs(2), async {
            while stream.next().await.is_some() {}
        })
        .await;
        assert!(ended.is_ok(), "a stream outlived the suite");
    }
    // The coalescer is gone: its queue no longer takes keys.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let _ = live.console.feed.take_overflow();
    live.console.feed.call(record(1, vec![created("late")]));
    assert!(live.console.feed.take_overflow(), "nobody reads the queue");
}
