use std::sync::atomic::AtomicUsize;

use axum::body::{Body, to_bytes};
use axum::http::Request;
use tower::ServiceExt as _;

use super::*;

fn registry() -> (JobRegistry, BadgeBoard) {
    let registry = JobRegistry::with_budget(&RingBudget::new(64 * 1024 * 1024));
    let badges = BadgeBoard::default();
    let _ = registry.inner.badges.set(badges.clone());
    (registry, badges)
}

/// Opens once for every job waiting on it, started before or after.
struct Gate(tokio::sync::watch::Sender<bool>);

impl Gate {
    fn new() -> Arc<Self> {
        Arc::new(Self(tokio::sync::watch::Sender::new(false)))
    }

    fn open(&self) {
        self.0.send_replace(true);
    }
}

/// A job that waits until `gate` opens, then succeeds.
fn gated(
    gate: &Arc<Gate>,
) -> impl FnOnce(JobHandle) -> BoxFuture<'static, Result<(), ApiError>> + use<> {
    let mut opened = gate.0.subscribe();
    move |_handle| {
        async move {
            let _ = opened.wait_for(|open| *open).await;
            Ok(())
        }
        .boxed()
    }
}

async fn settled(registry: &JobRegistry, id: &str) -> Job {
    for _ in 0..2_000 {
        let job = registry.get(id).expect("kept");
        if job.state != JobState::Running {
            return job;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("job {id} never finished");
}

fn gauge(badges: &BadgeBoard, section: &str) -> Option<u64> {
    badges
        .snapshot()
        .badges
        .into_iter()
        .find(|badge| badge.id == format!("{section}.jobs"))
        .map(|badge| badge.count)
}

#[tokio::test]
async fn a_job_answers_at_once_and_reports_its_progress_skips_and_failures() {
    let (registry, _) = registry();
    let gate = Arc::new(Notify::new());
    let opened = Arc::clone(&gate);
    let job = registry
        .start(
            "auth",
            "auth.delete-users",
            "Delete 30 users".to_owned(),
            Some(30),
            move |handle| {
                async move {
                    opened.notified().await;
                    handle.skipped(2);
                    for index in 0..25_u64 {
                        handle.failed_item_with(
                            &format!("u_{index}"),
                            "The user is gone.",
                            serde_json::json!({ "index": index }),
                        );
                    }
                    handle.failed_item("u_x", "Refused.");
                    handle.progress(30);
                    Ok(())
                }
                .boxed()
            },
        )
        .expect("started");
    assert_eq!(job.state, JobState::Running);
    assert_eq!(job.done, 0);
    assert_eq!(job.total, Some(30));
    assert_eq!(job.section, "auth");
    gate.notify_one();
    let done = settled(&registry, &job.id).await;
    assert_eq!(done.state, JobState::Done);
    assert_eq!(done.done, 30);
    assert_eq!(done.skipped, 2);
    assert_eq!(done.errors.len(), 20, "the first 20 failures are kept");
    assert_eq!(done.error_count, 26, "every failure is counted");
    assert_eq!(
        done.errors[3].detail,
        Some(serde_json::json!({ "index": 3 }))
    );
    assert!(done.finished_at.is_some());
    assert_eq!(done.message, None);
}

#[tokio::test]
async fn a_cancelled_job_stops_at_its_next_check() {
    let (registry, _) = registry();
    let batches = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&batches);
    let job = registry
        .start(
            "storage",
            "storage.delete",
            "Delete".to_owned(),
            None,
            move |handle| {
                async move {
                    for batch in 0..10_000_u64 {
                        if handle.cancelled() {
                            return Ok(());
                        }
                        counted.fetch_add(1, Ordering::SeqCst);
                        handle.progress(batch);
                        tokio::time::sleep(Duration::from_millis(2)).await;
                    }
                    Ok(())
                }
                .boxed()
            },
        )
        .expect("started");
    tokio::time::sleep(Duration::from_millis(20)).await;
    let asked = registry.cancel(&job.id).expect("kept");
    assert_eq!(asked.state, JobState::Running, "it stops at its next check");
    let cancelled = settled(&registry, &job.id).await;
    assert_eq!(cancelled.state, JobState::Cancelled);
    assert_eq!(cancelled.message.as_deref(), Some("Cancelled."));
    assert!(batches.load(Ordering::SeqCst) < 10_000);
    // Cancelling a finished job changes nothing.
    assert_eq!(
        registry.cancel(&job.id).expect("kept").state,
        JobState::Cancelled
    );
    assert!(registry.cancel("nothing").is_none());
}

#[tokio::test]
async fn a_failed_job_says_why_and_a_panic_is_a_failure_too() {
    let (registry, _) = registry();
    let job = registry
        .start(
            "pubsub",
            "pubsub.publish",
            "Publish".to_owned(),
            None,
            |_| {
                async { Err(ApiError::conflict("The topic is gone.").with_fix("Create it again.")) }
                    .boxed()
            },
        )
        .expect("started");
    let failed = settled(&registry, &job.id).await;
    assert_eq!(failed.state, JobState::Failed);
    assert_eq!(
        failed.message.as_deref(),
        Some("The topic is gone. Create it again.")
    );
    let job = registry
        .start(
            "pubsub",
            "pubsub.publish",
            "Publish".to_owned(),
            None,
            |_| async { panic!("a fault in the work") }.boxed(),
        )
        .expect("started");
    let failed = settled(&registry, &job.id).await;
    assert_eq!(failed.state, JobState::Failed);
    assert!(
        failed
            .message
            .as_deref()
            .expect("message")
            .contains("fault")
    );
}

#[tokio::test]
async fn limits_are_four_per_section_and_one_for_the_suite() {
    let (registry, badges) = registry();
    let gate = Gate::new();
    let mut ids = Vec::new();
    for index in 0..4 {
        let job = registry
            .start(
                "storage",
                "storage.move",
                format!("Move {index}"),
                None,
                gated(&gate),
            )
            .expect("within the limit");
        ids.push(job.id);
    }
    assert_eq!(gauge(&badges, "storage"), Some(4));
    let refused = registry
        .start(
            "storage",
            "storage.move",
            "Move 5".to_owned(),
            None,
            gated(&gate),
        )
        .expect_err("the fifth");
    assert_eq!(refused.status(), StatusCode::CONFLICT);
    assert_eq!(
        refused.detail().message,
        "Another bulk action is still running in Storage."
    );
    // Another section is not affected.
    let other = registry
        .start(
            "auth",
            "auth.disable",
            "Disable".to_owned(),
            None,
            gated(&gate),
        )
        .expect("another section");
    let suite = registry
        .start(SUITE, "suite.clear", "Clear".to_owned(), None, gated(&gate))
        .expect("one suite job");
    let refused = registry
        .start(
            SUITE,
            "suite.clear",
            "Clear again".to_owned(),
            None,
            gated(&gate),
        )
        .expect_err("a second suite job");
    assert_eq!(
        refused.detail().message,
        "Another suite action is still running."
    );
    assert_eq!(refused.detail().code, crate::api_error::ErrorCode::Conflict);
    gate.open();
    for id in ids.iter().chain([&other.id, &suite.id]) {
        assert_eq!(settled(&registry, id).await.state, JobState::Done);
    }
    assert_eq!(
        gauge(&badges, "storage"),
        Some(0),
        "cleared when the jobs end"
    );
    assert_eq!(gauge(&badges, "suite"), Some(0));
}

#[tokio::test(start_paused = true)]
async fn the_list_keeps_running_jobs_and_those_finished_in_the_last_ten_minutes() {
    let (registry, _) = registry();
    let gate = Gate::new();
    let quick = registry
        .start("auth", "auth.verify", "Verify".to_owned(), None, |_| {
            async { Ok(()) }.boxed()
        })
        .expect("started");
    let _ = settled(&registry, &quick.id).await;
    let running = registry
        .start(
            "auth",
            "auth.revoke",
            "Revoke".to_owned(),
            None,
            gated(&gate),
        )
        .expect("started");
    let storage = registry
        .start("storage", "storage.copy", "Copy".to_owned(), None, |_| {
            async { Ok(()) }.boxed()
        })
        .expect("started");
    let _ = settled(&registry, &storage.id).await;
    let auth: Vec<String> = registry
        .list(Some("auth"))
        .into_iter()
        .map(|job| job.id)
        .collect();
    assert_eq!(auth, [quick.id.clone(), running.id.clone()]);
    assert_eq!(registry.list(None).len(), 3);
    tokio::time::advance(Duration::from_mins(11)).await;
    let auth: Vec<String> = registry
        .list(Some("auth"))
        .into_iter()
        .map(|job| job.id)
        .collect();
    assert_eq!(
        auth,
        std::slice::from_ref(&running.id),
        "the finished one aged out; the running one stays"
    );
    assert!(registry.get(&quick.id).is_none());
    gate.open();
    let _ = settled(&registry, &running.id).await;
}

#[tokio::test]
async fn the_stop_cancels_every_job_and_refuses_new_ones() {
    let (registry, badges) = registry();
    let started = Arc::new(Notify::new());
    let mut ids = Vec::new();
    for section in ["auth", "storage"] {
        let started = Arc::clone(&started);
        let job = registry
            .start(section, "x.y", "Work".to_owned(), None, move |handle| {
                async move {
                    started.notify_one();
                    while !handle.cancelled() {
                        tokio::time::sleep(Duration::from_millis(2)).await;
                    }
                    Ok(())
                }
                .boxed()
            })
            .expect("started");
        ids.push(job.id);
    }
    started.notified().await;
    registry.stop().await;
    for id in &ids {
        let job = registry.get(id).expect("kept");
        assert_eq!(job.state, JobState::Cancelled);
        assert_eq!(job.message.as_deref(), Some("The engine stopped."));
    }
    assert_eq!(gauge(&badges, "auth"), Some(0));
    let refused = registry
        .start("auth", "x.y", "Late".to_owned(), None, |_| {
            async { Ok(()) }.boxed()
        })
        .expect_err("stopping");
    assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test(start_paused = true)]
async fn a_job_that_ignores_the_stop_is_abandoned_after_the_grace() {
    let (registry, _) = registry();
    let job = registry
        .start("auth", "x.y", "Stuck".to_owned(), None, |_| {
            async {
                std::future::pending::<()>().await;
                Ok(())
            }
            .boxed()
        })
        .expect("started");
    registry.stop().await;
    let job = registry.get(&job.id).expect("kept");
    assert_eq!(job.state, JobState::Cancelled);
    assert_eq!(job.message.as_deref(), Some("The engine stopped."));
}

#[tokio::test]
async fn the_shutdown_signal_stops_the_jobs() {
    let (registry, _) = registry();
    let (stop, receiver) = tokio::sync::watch::channel(false);
    registry.attach(&BadgeBoard::default(), Shutdown::new(receiver));
    let job = registry
        .start("auth", "x.y", "Work".to_owned(), None, |handle| {
            async move {
                while !handle.cancelled() {
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
                Ok(())
            }
            .boxed()
        })
        .expect("started");
    stop.send(true).expect("stopped");
    let job = settled(&registry, &job.id).await;
    assert_eq!(job.state, JobState::Cancelled);
    assert_eq!(job.message.as_deref(), Some("The engine stopped."));
}

#[test]
fn a_bulk_target_reads_keys_or_a_query_with_its_scope() {
    let keys: BulkTarget =
        serde_json::from_value(serde_json::json!({ "by": "keys", "keys": ["a", "b"] }))
            .expect("keys");
    assert_eq!(
        keys,
        BulkTarget::Keys {
            keys: vec!["a".to_owned(), "b".to_owned()]
        }
    );
    let query: BulkTarget = serde_json::from_value(serde_json::json!({
        "by": "query", "q": "provider:google", "scope": { "tenant": "acme", "flat": true }
    }))
    .expect("query");
    let BulkTarget::Query { q, scope } = &query else {
        panic!("a query: {query:?}");
    };
    assert_eq!(q, "provider:google");
    assert_eq!(scope["tenant"], "acme");
    assert_eq!(scope["flat"], true);
    query.check().expect("a query has no key limit");
    let many = BulkTarget::Keys {
        keys: vec![String::new(); 10_001],
    };
    assert_eq!(
        many.check().expect_err("over").detail().message,
        "A bulk action names at most 10000 rows; this one names 10001."
    );
}

async fn call(router: &Router, request: Request<Body>) -> (StatusCode, serde_json::Value) {
    let response = router.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (
        status,
        serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null),
    )
}

#[tokio::test]
async fn the_routes_list_read_and_cancel() {
    let (registry, _) = registry();
    let router = registry.router();
    let gate = Gate::new();
    let job = registry
        .start(
            "storage",
            "storage.move",
            "Move".to_owned(),
            None,
            gated(&gate),
        )
        .expect("started");
    let (status, body) = call(
        &router,
        Request::get("/jobs?section=storage")
            .body(Body::empty())
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["jobs"][0]["id"], job.id.as_str());
    assert_eq!(body["jobs"][0]["state"], "running");
    assert_eq!(body["jobs"][0]["errorCount"], 0);
    let (_, body) = call(
        &router,
        Request::get("/jobs?section=auth")
            .body(Body::empty())
            .expect("request"),
    )
    .await;
    assert_eq!(body["jobs"], serde_json::json!([]));
    let (status, body) = call(
        &router,
        Request::get(format!("/jobs/{}", job.id))
            .body(Body::empty())
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["kind"], "storage.move");
    let (status, body) = call(
        &router,
        Request::get("/jobs/nothing")
            .body(Body::empty())
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["code"], "not-found");
    let cancel = |body: &'static str| {
        Request::post(format!("/jobs/{}/cancel", job.id))
            .header("content-type", "application/json")
            .body(Body::from(body))
            .expect("request")
    };
    let (status, body) = call(&router, cancel(r#"{"why":1}"#)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = call(&router, cancel("{}")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["id"], job.id.as_str());
    gate.open();
    assert_eq!(settled(&registry, &job.id).await.state, JobState::Cancelled);
    let accepted = accepted(registry.get(&job.id).expect("kept"));
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
}

async fn next_job(stream: &mut TopicStream) -> (String, Job) {
    match tokio::time::timeout(Duration::from_secs(10), stream.next())
        .await
        .expect("an event")
        .expect("the topic goes on")
    {
        TopicEvent::Event {
            name: "job",
            cursor: Some(cursor),
            data,
        } => {
            let value: serde_json::Value = serde_json::from_str(&data).expect("json");
            (
                cursor.to_string(),
                Job {
                    id: value["id"].as_str().expect("id").to_owned(),
                    kind: value["kind"].as_str().expect("kind").to_owned(),
                    section: value["section"].as_str().expect("section").to_owned(),
                    title: value["title"].as_str().expect("title").to_owned(),
                    total: value["total"].as_u64(),
                    done: value["done"].as_u64().expect("done"),
                    skipped: value["skipped"].as_u64().expect("skipped"),
                    errors: Vec::new(),
                    error_count: value["errorCount"].as_u64().expect("errors"),
                    state: serde_json::from_value(value["state"].clone()).expect("state"),
                    started_at: value["startedAt"].as_str().expect("started").to_owned(),
                    finished_at: value["finishedAt"].as_str().map(str::to_owned),
                    message: value["message"].as_str().map(str::to_owned),
                    result: None,
                },
            )
        }
        other => panic!("not a job event: {other:?}"),
    }
}

#[tokio::test]
async fn the_topic_sends_current_states_on_open_then_each_new_one_filtered_by_section() {
    let (registry, _) = registry();
    let topic = registry.topic();
    let gate = Gate::new();
    let before = registry
        .start(
            "auth",
            "auth.verify",
            "Verify".to_owned(),
            None,
            gated(&gate),
        )
        .expect("started");
    let mut auth = topic
        .open(&serde_json::json!({ "section": "auth" }), None)
        .expect("opened");
    let (_, current) = next_job(&mut auth).await;
    assert_eq!(current.id, before.id, "the running job's state on open");
    assert_eq!(current.state, JobState::Running);
    let storage = registry
        .start("storage", "storage.copy", "Copy".to_owned(), None, |_| {
            async { Ok(()) }.boxed()
        })
        .expect("started");
    let later = registry
        .start("auth", "auth.revoke", "Revoke".to_owned(), None, |_| {
            async { Ok(()) }.boxed()
        })
        .expect("started");
    let mut seen = Vec::new();
    while seen.len() < 2 {
        let (_, job) = next_job(&mut auth).await;
        assert_ne!(job.id, storage.id, "another section's job is not sent");
        if job.id == later.id {
            seen.push(job.state);
        }
    }
    assert_eq!(seen, [JobState::Running, JobState::Done]);
    assert!(
        topic
            .open(&serde_json::json!({ "sections": "auth" }), None)
            .is_err(),
        "unknown params refused"
    );
    gate.open();
    let _ = settled(&registry, &before.id).await;
}

#[tokio::test]
async fn a_reconnecting_subscriber_gets_each_jobs_newest_state_since_its_cursor() {
    let (registry, _) = registry();
    let topic = registry.topic();
    let mut first = topic.open(&serde_json::json!({}), None).expect("opened");
    let job = registry
        .start(
            "auth",
            "auth.verify",
            "Verify".to_owned(),
            Some(3),
            |handle| {
                async move {
                    handle.progress(3);
                    Ok(())
                }
                .boxed()
            },
        )
        .expect("started");
    let (cursor, running) = next_job(&mut first).await;
    assert_eq!(running.state, JobState::Running);
    drop(first);
    let _ = settled(&registry, &job.id).await;
    // While away, the job moved on: the resume replays only its newest
    // state.
    let mut resumed = topic
        .open(&serde_json::json!({}), Some(&cursor))
        .expect("resumed");
    let (_, newest) = next_job(&mut resumed).await;
    assert_eq!(newest.state, JobState::Done);
    assert_eq!(newest.done, 3);
    let pending = tokio::time::timeout(Duration::from_millis(50), resumed.next()).await;
    assert!(pending.is_err(), "nothing else: {pending:?}");
    // A cursor from another engine run is a gap, then the current states.
    let mut foreign = topic
        .open(&serde_json::json!({}), Some("0badc0de.5"))
        .expect("opened");
    match foreign.next().await.expect("an event") {
        TopicEvent::Reset { reason, missed } => {
            assert_eq!(reason, ResetReason::Gap);
            assert_eq!(missed, None);
        }
        other => panic!("a reset first: {other:?}"),
    }
    let (_, current) = next_job(&mut foreign).await;
    assert_eq!(current.id, job.id);
}

#[tokio::test(start_paused = true)]
async fn states_are_pushed_at_most_four_times_a_second_plus_the_last() {
    let (registry, _) = registry();
    let job = registry
        .start(
            "storage",
            "storage.delete",
            "Delete".to_owned(),
            Some(200),
            |handle| {
                async move {
                    for done in 1..=200_u64 {
                        handle.progress(done);
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                    Ok(())
                }
                .boxed()
            },
        )
        .expect("started");
    let finished = settled(&registry, &job.id).await;
    assert_eq!(finished.done, 200);
    let states = registry
        .inner
        .ring
        .snapshot()
        .into_iter()
        .filter(|entry| *entry.meta.id == job.id)
        .count();
    // One second of work: the start, at most one state per 250 ms, the end.
    assert!((3..=7).contains(&states), "{states} states pushed");
}
