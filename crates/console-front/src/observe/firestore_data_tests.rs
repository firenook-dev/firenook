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
