use firenook_suite_front::{RingBudget, RingLimits};
use serde::Serialize;
use tokio::time::Instant;

use super::*;

const EPOCH: u32 = 0x0abc_def0;

/// Metadata whose serialization would panic: windows are built from the
/// JSON serialized when an entry was pushed, never by serializing again.
#[derive(Clone, Debug)]
struct Meta {
    n: u32,
    even: bool,
}

impl Serialize for Meta {
    fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
        panic!("an entry was serialized twice");
    }
}

fn ring(entries: usize) -> ReplayRing<Meta> {
    ReplayRing::new(
        "replay-test",
        RingLimits {
            entries,
            bytes: usize::MAX,
            floor: 1,
        },
        EPOCH,
        &RingBudget::new(usize::MAX),
    )
}

fn push(ring: &ReplayRing<Meta>, n: u32) -> Cursor {
    ring.push(
        Meta {
            n,
            even: n.is_multiple_of(2),
        },
        Arc::from(format!("{{\"n\":{n}}}")),
    )
}

fn even_only() -> ReplayOptions<Meta> {
    ReplayOptions {
        filter: Some(Arc::new(|meta: &Meta| meta.even)),
        ..ReplayOptions::default()
    }
}

#[derive(Debug, PartialEq)]
enum Seen {
    Items(String, String),
    Tick(String),
    Reset(ResetReason, Option<u64>),
}

async fn next(stream: &mut TopicStream) -> Seen {
    match tokio::time::timeout(Duration::from_secs(30), stream.next())
        .await
        .expect("an event within the window")
        .expect("the stream goes on")
    {
        TopicEvent::Event {
            name: "tick",
            cursor,
            ..
        } => Seen::Tick(cursor.expect("a tick carries a cursor").to_string()),
        TopicEvent::Event { cursor, data, .. } => Seen::Items(
            cursor.expect("an event carries a cursor").to_string(),
            data.to_string(),
        ),
        TopicEvent::Reset { reason, missed } => Seen::Reset(reason, missed),
        TopicEvent::End(_) => panic!("a ring never ends"),
    }
}

fn at(seq: u64) -> String {
    Cursor { epoch: EPOCH, seq }.to_string()
}

fn items(numbers: impl IntoIterator<Item = u32>) -> String {
    let joined = numbers
        .into_iter()
        .map(|n| format!("{{\"n\":{n}}}"))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{\"items\":[{joined}]}}")
}

#[tokio::test(start_paused = true)]
async fn a_new_subscriber_gets_its_position_then_live_windows_of_joined_items() {
    let ring = ring(100);
    let mut stream = replay_topic(&ring, None, "entries", ReplayOptions::default());
    assert_eq!(next(&mut stream).await, Seen::Tick(at(0)));
    let began = Instant::now();
    for n in 1..=5 {
        push(&ring, n);
    }
    assert_eq!(next(&mut stream).await, Seen::Items(at(5), items(1..=5)));
    assert!(began.elapsed() >= WINDOW);
    // One event per window: the next comes a window after its first entry.
    let second = Instant::now();
    push(&ring, 6);
    tokio::time::sleep(Duration::from_millis(40)).await;
    push(&ring, 7);
    assert_eq!(next(&mut stream).await, Seen::Items(at(7), items(6..=7)));
    let waited = second.elapsed();
    assert!(waited >= WINDOW && waited < WINDOW * 2, "{waited:?}");
}

#[tokio::test(start_paused = true)]
async fn the_filter_applies_to_the_replay_and_to_live() {
    let ring = ring(100);
    for n in 1..=6 {
        push(&ring, n);
    }
    let mut stream = replay_topic(&ring, None, "entries", even_only());
    assert_eq!(
        next(&mut stream).await,
        Seen::Items(at(6), items([2, 4, 6]))
    );
    for n in 7..=10 {
        push(&ring, n);
    }
    assert_eq!(next(&mut stream).await, Seen::Items(at(10), items([8, 10])));
}

#[tokio::test(start_paused = true)]
async fn a_resumed_subscriber_gets_only_what_it_missed() {
    let ring = ring(100);
    for n in 1..=3 {
        push(&ring, n);
    }
    let mut stream = replay_topic(&ring, Some(&at(1)), "entries", ReplayOptions::default());
    assert_eq!(next(&mut stream).await, Seen::Items(at(3), items([2, 3])));
    // Nothing missed: the cursor it holds comes back as its position.
    let mut caught_up = replay_topic(&ring, Some(&at(3)), "entries", ReplayOptions::default());
    assert_eq!(next(&mut caught_up).await, Seen::Tick(at(3)));
}

#[tokio::test(start_paused = true)]
async fn a_cursor_the_ring_no_longer_holds_is_a_gap_with_what_was_lost() {
    let ring = ring(10);
    for n in 1..=30 {
        push(&ring, n);
    }
    let mut stream = replay_topic(&ring, Some(&at(1)), "entries", ReplayOptions::default());
    assert_eq!(
        next(&mut stream).await,
        Seen::Reset(ResetReason::Gap, Some(19))
    );
    assert_eq!(next(&mut stream).await, Seen::Items(at(30), items(21..=30)));
    let mut foreign = replay_topic(
        &ring,
        Some("00000001.5"),
        "entries",
        ReplayOptions::default(),
    );
    assert_eq!(
        next(&mut foreign).await,
        Seen::Reset(ResetReason::Gap, None)
    );
}

#[tokio::test(start_paused = true)]
async fn windows_are_cut_at_their_item_and_byte_caps() {
    let ring = ring(100);
    let mut stream = replay_topic(
        &ring,
        None,
        "entries",
        ReplayOptions {
            max_items: 3,
            ..ReplayOptions::default()
        },
    );
    assert_eq!(next(&mut stream).await, Seen::Tick(at(0)));
    let began = Instant::now();
    for n in 1..=7 {
        push(&ring, n);
    }
    assert_eq!(next(&mut stream).await, Seen::Items(at(3), items(1..=3)));
    assert_eq!(next(&mut stream).await, Seen::Items(at(6), items(4..=6)));
    assert!(began.elapsed() < WINDOW, "full windows go at once");
    assert_eq!(next(&mut stream).await, Seen::Items(at(7), items([7])));

    // Each entry here is 7 bytes: 15 bytes hold two.
    let ring = self::ring(100);
    let mut stream = replay_topic(
        &ring,
        None,
        "entries",
        ReplayOptions {
            max_bytes: 15,
            ..ReplayOptions::default()
        },
    );
    assert_eq!(next(&mut stream).await, Seen::Tick(at(0)));
    for n in 1..=5 {
        push(&ring, n);
    }
    assert_eq!(next(&mut stream).await, Seen::Items(at(2), items(1..=2)));
    assert_eq!(next(&mut stream).await, Seen::Items(at(4), items(3..=4)));
    assert_eq!(next(&mut stream).await, Seen::Items(at(5), items([5])));
}

#[tokio::test(start_paused = true)]
async fn a_subscriber_that_matches_nothing_is_ticked_after_a_thousand_entries_or_a_second() {
    let ring = ring(10_000);
    let mut stream = replay_topic(
        &ring,
        None,
        "entries",
        ReplayOptions {
            filter: Some(Arc::new(|_: &Meta| false)),
            ..ReplayOptions::default()
        },
    );
    assert_eq!(next(&mut stream).await, Seen::Tick(at(0)));
    let began = Instant::now();
    for n in 1..=1_000 {
        push(&ring, n);
    }
    assert_eq!(next(&mut stream).await, Seen::Tick(at(1_000)));
    assert!(
        began.elapsed() < WINDOW,
        "a thousand dropped entries tick at once"
    );
    let quiet = Instant::now();
    for n in 1_001..=1_005 {
        push(&ring, n);
    }
    assert_eq!(next(&mut stream).await, Seen::Tick(at(1_005)));
    let waited = quiet.elapsed();
    assert!(
        waited >= TICK_AFTER && waited < TICK_AFTER * 2,
        "{waited:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn a_shaper_that_has_nothing_to_say_sends_nothing_and_the_cursor_still_moves() {
    let ring = ring(100);
    let mut stream = replay_topic(
        &ring,
        None,
        "entries",
        ReplayOptions {
            shape: Some(Box::new(|entries: &[Entry<Meta>]| {
                entries
                    .iter()
                    .any(|entry| entry.meta.n > 3)
                    .then(|| Arc::from(format!("{{\"count\":{}}}", entries.len())))
            })),
            ..ReplayOptions::default()
        },
    );
    assert_eq!(next(&mut stream).await, Seen::Tick(at(0)));
    let began = Instant::now();
    for n in 1..=3 {
        push(&ring, n);
    }
    assert_eq!(next(&mut stream).await, Seen::Tick(at(3)));
    assert!(began.elapsed() >= WINDOW + TICK_AFTER);
    push(&ring, 4);
    assert_eq!(
        next(&mut stream).await,
        Seen::Items(at(4), "{\"count\":1}".to_owned())
    );
}

#[tokio::test(start_paused = true)]
async fn a_lagging_subscriber_catches_up_from_the_ring_without_a_reset() {
    // The live channel holds 1,024; the ring holds all of them.
    let ring = ring(10_000);
    let mut stream = replay_topic(&ring, None, "entries", ReplayOptions::default());
    assert_eq!(next(&mut stream).await, Seen::Tick(at(0)));
    push(&ring, 1);
    assert_eq!(next(&mut stream).await, Seen::Items(at(1), items([1])));
    for n in 2..=3_001 {
        push(&ring, n);
    }
    let mut delivered = Vec::new();
    while delivered.last().is_none_or(|&last| last < 3_001) {
        match next(&mut stream).await {
            Seen::Items(_, data) => {
                let parsed: serde_json::Value = serde_json::from_str(&data).expect("json");
                delivered.extend(
                    parsed["items"]
                        .as_array()
                        .expect("items")
                        .iter()
                        .map(|item| item["n"].as_u64().expect("n")),
                );
            }
            other => panic!("no reset while the ring holds what was missed: {other:?}"),
        }
    }
    assert_eq!(delivered, (2..=3_001).collect::<Vec<_>>());
}

#[tokio::test(start_paused = true)]
async fn a_lagging_subscriber_is_reset_when_the_ring_lost_what_it_missed() {
    let ring = ring(100);
    let mut stream = replay_topic(&ring, None, "entries", ReplayOptions::default());
    assert_eq!(next(&mut stream).await, Seen::Tick(at(0)));
    push(&ring, 1);
    assert_eq!(next(&mut stream).await, Seen::Items(at(1), items([1])));
    for n in 2..=500 {
        push(&ring, n);
    }
    assert_eq!(
        next(&mut stream).await,
        Seen::Reset(ResetReason::Lagged, Some(399))
    );
    assert_eq!(
        next(&mut stream).await,
        Seen::Items(at(500), items(401..=500))
    );
}
