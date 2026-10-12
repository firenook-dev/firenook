use std::time::Duration;

use firenook_core_store::{DocumentKey, Fields, Precondition, Write};

use super::*;
use crate::router_tests::firestore_console;

const PROJECT: &str = "demo-console";

fn key(database: &str, path: &str) -> DocumentKey {
    DocumentKey::new(
        DatabaseName::new(PROJECT, database).expect("database"),
        path,
    )
    .expect("key")
}

fn create(database: &str, path: &str) -> Write {
    Write::Create {
        key: key(database, path),
        fields: Fields::new(),
    }
}

fn delete(database: &str, path: &str) -> Write {
    Write::Delete {
        key: key(database, path),
        precondition: Precondition::None,
    }
}

/// The summary's figures: documents, and databases once the seed is in.
fn figures(console: &FirestoreConsole) -> (Option<u64>, Option<u64>) {
    let summary = summary(console);
    (summary.figures[0].value, summary.figures[1].value)
}

/// Asks for the summary until its database figure is `expected`.
async fn databases_become(console: &FirestoreConsole, expected: u64) {
    tokio::time::timeout(Duration::from_secs(30), async {
        while figures(console).1 != Some(expected) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{expected} databases in time, saw {:?}", figures(console)));
}

#[tokio::test]
async fn the_summary_counts_documents_and_databases_without_walking_on_the_caller() {
    let store = Store::default();
    let console = firestore_console(&store);
    store
        .commit(&[
            create("(default)", "users/a"),
            create("(default)", "users/b"),
            create("analytics", "events/e"),
        ])
        .expect("seeded");
    // The first answer comes at once: the seed runs on the blocking pool.
    let (documents, _) = figures(&console);
    assert_eq!(documents, Some(3));
    databases_become(&console, 2).await;
    let summary = summary(&console);
    assert_eq!(summary.headline, "3 documents · 2 databases");
    // A first document in a new database counts at once.
    store.commit(&[create("orders", "o/1")]).expect("committed");
    assert_eq!(figures(&console), (Some(4), Some(3)));
    assert_eq!(
        firestore_summary(1, Some(1)).headline,
        "1 document · 1 database"
    );
    assert_eq!(
        firestore_summary(211_260, None).headline,
        "211,260 documents"
    );
}

#[tokio::test(start_paused = true)]
async fn an_emptied_database_leaves_the_count_after_the_next_check() {
    let store = Store::default();
    let console = firestore_console(&store);
    store
        .commit(&[create("analytics", "events/e"), create("(default)", "a/1")])
        .expect("seeded");
    databases_become(&console, 2).await;
    store
        .commit(&[delete("analytics", "events/e")])
        .expect("deleted");
    // Still counted until the check confirms it.
    assert_eq!(figures(&console).1, Some(2));
    databases_become(&console, 1).await;
    // `(default)` is always listed, empty or not.
    store
        .commit(&[delete("(default)", "a/1")])
        .expect("deleted");
    tokio::time::sleep(EMPTINESS_CHECK * 2).await;
    assert_eq!(figures(&console), (Some(0), Some(1)));
}

#[tokio::test(start_paused = true)]
async fn the_status_ticks_when_documents_come_and_go_at_most_twice_a_second() {
    let store = Store::default();
    let console = firestore_console(&store);
    let _ = summary(&console);
    databases_become(&console, 1).await;
    let mut ticks = status_changes(&console);
    store
        .commit(&[create("(default)", "a/1")])
        .expect("committed");
    tokio::time::timeout(Duration::from_secs(1), ticks.next())
        .await
        .expect("a tick")
        .expect("ticking");
    let begun = Instant::now();
    store
        .commit(&[create("(default)", "a/2")])
        .expect("committed");
    store
        .commit(&[create("(default)", "a/3")])
        .expect("committed");
    tokio::time::timeout(Duration::from_secs(2), ticks.next())
        .await
        .expect("a tick")
        .expect("ticking");
    assert!(begun.elapsed() >= STATUS_TICK, "{:?}", begun.elapsed());
    // An update creates and deletes nothing: no tick.
    store
        .commit(&[Write::Set {
            key: key("(default)", "a/1"),
            fields: Fields::from([("n".to_owned(), firenook_core_store::Value::Integer(1))]),
            transforms: Vec::new(),
            precondition: Precondition::None,
        }])
        .expect("updated");
    assert!(
        tokio::time::timeout(Duration::from_secs(2), ticks.next())
            .await
            .is_err()
    );
}

/// The summary at 1,000,000 documents, timed: run with `--ignored` in a
/// release build to record the number.
#[tokio::test]
#[ignore = "builds a million documents; a timing to record, not a check for every run"]
async fn the_summary_stays_cheap_at_a_million_documents() {
    let store = Store::default();
    let console = firestore_console(&store);
    for chunk in 0..2_000 {
        let writes: Vec<Write> = (0..500)
            .map(|index| create("(default)", &format!("docs/{chunk}-{index}")))
            .collect();
        store.commit(&writes).expect("committed");
    }
    databases_become(&console, 1).await;
    let mut timings: Vec<Duration> = (0..10_000)
        .map(|_| {
            let begun = std::time::Instant::now();
            let _ = summary(&console);
            begun.elapsed()
        })
        .collect();
    timings.sort();
    let p99 = timings[9_899];
    println!("summary p99 at 1,000,000 documents: {p99:?}");
    assert!(p99 < Duration::from_micros(5), "{p99:?}");
}

/// The origin of every commit the store installs, in order.
#[derive(Default)]
struct Origins(Mutex<Vec<firenook_core_store::CommitOrigin>>);

impl firenook_core_store::CommitObserver for Origins {
    fn committed(&self, observation: &CommitObservation) {
        lock(&self.0).push(observation.origin);
    }
}

fn seeded(documents: &[(&str, usize)]) -> (Store, FirestoreConsole) {
    let store = Store::default();
    let console = firestore_console(&store);
    for (database, count) in documents {
        for chunk in 0..count.div_ceil(500) {
            let writes: Vec<Write> = (chunk * 500..((chunk + 1) * 500).min(*count))
                .map(|index| create(database, &format!("items/{index}")))
                .collect();
            store.commit(&writes).expect("seeded");
        }
    }
    (store, console)
}

/// Runs the clear as the suite's clear job does; the finished job.
async fn cleared(
    console: &FirestoreConsole,
    options: ClearOptions,
    cancel_at_once: bool,
) -> crate::jobs::Job {
    let registry = crate::jobs::JobRegistry::new();
    let work = console.clone();
    let job = registry
        .start(
            "suite",
            "suite.clear",
            "Clear Firestore".to_owned(),
            None,
            move |handle| {
                let clear =
                    clear(&work, handle.clone(), options).expect("Firestore can be cleared");
                async move {
                    let report = clear.await?;
                    handle.set_result(serde_json::to_value(&report).expect("json"));
                    Ok(())
                }
                .boxed()
            },
        )
        .expect("started");
    if cancel_at_once {
        registry.cancel(&job.id);
    }
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let now = registry.get(&job.id).expect("kept");
            if now.state != crate::jobs::JobState::Running {
                return now;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the clear finishes")
}

/// Every event `stream` has for us within a moment.
async fn drain(stream: &mut crate::live::TopicStream) -> Vec<crate::live::TopicEvent> {
    let mut events = Vec::new();
    while let Ok(Some(event)) =
        tokio::time::timeout(Duration::from_millis(400), stream.next()).await
    {
        events.push(event);
    }
    events
}

#[tokio::test]
async fn a_reset_is_housekeeping_that_open_pages_reload_twice_for() {
    use crate::live::{LiveTopic as _, ResetReason, TopicEvent};
    let (store, console) = seeded(&[("(default)", 5_000), ("analytics", 1_200)]);
    let origins = Arc::new(Origins::default());
    store.add_commit_observer(origins.clone());
    let topic = console.changes.topic();
    let mut default = topic
        .open(&serde_json::json!({ "database": "(default)" }), None)
        .expect("opened");
    let mut analytics = topic
        .open(&serde_json::json!({ "database": "analytics" }), None)
        .expect("opened");
    drain(&mut default).await;
    drain(&mut analytics).await;
    let job = cleared(&console, ClearOptions::default(), false).await;
    assert_eq!(job.state, crate::jobs::JobState::Done, "{job:?}");
    assert_eq!(job.total, Some(6_200));
    assert_eq!(job.done, 6_200);
    assert_eq!(
        job.result,
        Some(serde_json::json!({ "section": "firestore", "removed": 6_200 }))
    );
    assert_eq!(store.snapshot().logical_memory_usage().entries, 0);
    // Every batch was housekeeping: no trigger fires for one.
    let origins = lock(&origins.0).clone();
    assert_eq!(origins.len(), 13, "{origins:?}");
    assert!(
        origins
            .iter()
            .all(|origin| *origin == firenook_core_store::CommitOrigin::Maintenance)
    );
    // Each database's open page is told when the reset starts and when it
    // ends (one reset when both land in one 100 ms window), last of all, and
    // gets no batch.
    for stream in [&mut default, &mut analytics] {
        let events = drain(stream).await;
        let rebuilt = events
            .iter()
            .filter(|event| {
                matches!(
                    event,
                    TopicEvent::Reset {
                        reason: ResetReason::Rebuilt,
                        ..
                    }
                )
            })
            .count();
        assert!((1..=2).contains(&rebuilt), "{events:?}");
        assert!(
            matches!(
                events.last(),
                Some(TopicEvent::Reset {
                    reason: ResetReason::Rebuilt,
                    ..
                })
            ),
            "{events:?}"
        );
        assert!(
            events
                .iter()
                .all(|event| !matches!(event, TopicEvent::Event { name: "change", .. })),
            "{events:?}"
        );
    }
}

#[tokio::test]
async fn a_reset_that_runs_triggers_commits_as_a_client_and_sends_batches() {
    use crate::live::{LiveTopic as _, TopicEvent};
    let (store, console) = seeded(&[("(default)", 600)]);
    let origins = Arc::new(Origins::default());
    store.add_commit_observer(origins.clone());
    let mut default = console
        .changes
        .topic()
        .open(&serde_json::json!({ "database": "(default)" }), None)
        .expect("opened");
    drain(&mut default).await;
    let job = cleared(&console, ClearOptions { run_triggers: true }, false).await;
    assert_eq!(job.done, 600);
    assert!(
        lock(&origins.0)
            .iter()
            .all(|origin| *origin == firenook_core_store::CommitOrigin::Client)
    );
    let events = drain(&mut default).await;
    assert!(
        events
            .iter()
            .any(|event| matches!(event, TopicEvent::Event { name: "change", .. })),
        "{events:?}"
    );
    assert!(
        events
            .iter()
            .all(|event| !matches!(event, TopicEvent::Reset { .. })),
        "{events:?}"
    );
}

#[tokio::test]
async fn a_cancelled_reset_stops_at_the_next_batch() {
    let (store, console) = seeded(&[("(default)", 5_000)]);
    let job = cleared(&console, ClearOptions::default(), true).await;
    assert_eq!(job.state, crate::jobs::JobState::Cancelled, "{job:?}");
    let left = store.snapshot().logical_memory_usage().entries;
    assert!(left > 0, "the reset stopped before the end");
    assert_eq!(left % 500, 0, "whole batches only: {left}");
    assert_eq!(job.done, 5_000 - left);
}
