use std::sync::Arc;
use std::thread;

use super::*;

const EPOCH: u32 = 0x1a2b_3c4d;

fn ring(limits: RingLimits) -> ReplayRing<u32> {
    ReplayRing::new("test", limits, EPOCH, &RingBudget::new(RING_BUDGET_BYTES))
}

fn json(index: u32) -> Arc<str> {
    Arc::from(format!("{{\"n\":{index}}}"))
}

fn metas(entries: &[Entry<u32>]) -> Vec<u32> {
    entries.iter().map(|entry| entry.meta).collect()
}

#[test]
fn cursors_print_and_parse_and_refuse_anything_else() {
    let cursor = Cursor {
        epoch: EPOCH,
        seq: 1834,
    };
    assert_eq!(cursor.to_string(), "1a2b3c4d.1834");
    assert_eq!("1a2b3c4d.1834".parse::<Cursor>(), Ok(cursor));
    assert_eq!(
        "0000000f.0".parse::<Cursor>(),
        Ok(Cursor { epoch: 15, seq: 0 })
    );
    for bad in [
        "",
        "1a2b3c4d",
        "1a2b3c4d.",
        ".12",
        "1a2b3c4.12",
        "1a2b3c4dd.12",
        "1a2b3c4g.12",
        "1a2b3c4d.-1",
        "1a2b3c4d.1.2",
        "1a2b3c4d.99999999999999999999999",
    ] {
        assert_eq!(bad.parse::<Cursor>(), Err(CursorError), "{bad:?}");
    }
}

#[test]
fn eviction_follows_the_entry_limit_and_the_byte_limit() {
    let by_entries = ring(RingLimits {
        entries: 3,
        bytes: usize::MAX,
        floor: 1,
    });
    for index in 0..5 {
        by_entries.push(index, json(index));
    }
    assert_eq!(metas(&by_entries.snapshot()), [2, 3, 4]);
    assert_eq!(by_entries.len(), 3);
    assert_eq!(by_entries.oldest().map(|cursor| cursor.seq), Some(3));

    // Each entry is 7 bytes of JSON; 20 bytes hold two of them.
    let by_bytes = ring(RingLimits {
        entries: 100,
        bytes: 20,
        floor: 1,
    });
    for index in 0..5 {
        by_bytes.push(index, json(index));
    }
    assert_eq!(metas(&by_bytes.snapshot()), [3, 4]);
    assert_eq!(by_bytes.bytes(), 14);
    // The newest entry is kept whatever its size.
    by_bytes.push(9, Arc::from("x".repeat(64)));
    assert_eq!(metas(&by_bytes.snapshot()), [9]);
    // Weighted entries count what their metadata holds.
    by_bytes.push_weighted(10, Arc::from(""), 15);
    by_bytes.push_weighted(11, Arc::from(""), 15);
    assert_eq!(metas(&by_bytes.snapshot()), [11]);
}

#[test]
fn a_ring_may_keep_more_than_the_default() {
    let limits = RingLimits {
        entries: 20_000,
        bytes: 16 * 1024 * 1024,
        floor: 256,
    };
    let big = ring(limits);
    for index in 0..15_000 {
        big.push(index, json(index));
    }
    assert_eq!(big.len(), 15_000);
    assert!(RingLimits::default().entries < 15_000);
}

#[test]
fn the_budget_evicts_from_the_ring_holding_the_oldest_entry_and_never_below_its_floor() {
    let budget = RingBudget::new(100);
    let limits = RingLimits {
        entries: 1_000,
        bytes: 1_000,
        floor: 2,
    };
    let older = ReplayRing::<u32>::new("older", limits, 1, &budget);
    let newer = ReplayRing::<u32>::new("newer", limits, 2, &budget);
    for index in 0..5 {
        older.push(index, Arc::from("0123456789"));
    }
    for index in 0..5 {
        newer.push(index, Arc::from("0123456789"));
    }
    assert_eq!(budget.used(), 100);
    // One more entry is over: the oldest entry in the process is older's.
    newer.push(5, Arc::from("0123456789"));
    assert_eq!(older.len(), 4);
    assert_eq!(newer.len(), 6);
    assert_eq!(budget.used(), 100);
    for index in 6..20 {
        newer.push(index, Arc::from("0123456789"));
    }
    // Older stops at its floor; newer then gives up its own oldest.
    assert_eq!(older.len(), 2);
    assert_eq!(newer.len(), 8);
    assert!(budget.used() <= 100);
    let report = budget.report();
    assert_eq!(
        report,
        [
            RingSize {
                name: "older".to_owned(),
                entries: 2,
                bytes: 20
            },
            RingSize {
                name: "newer".to_owned(),
                entries: 8,
                bytes: 80
            },
        ]
    );
    drop(newer);
    assert_eq!(budget.used(), 20, "a dropped ring returns its bytes");
    assert_eq!(budget.report().len(), 1);
}

#[test]
fn following_without_a_cursor_is_the_whole_ring_then_live() {
    let ring = ring(RingLimits::default());
    ring.push(1, json(1));
    ring.push(2, json(2));
    let mut follow = ring.follow(None);
    assert_eq!(metas(&follow.replay), [1, 2]);
    assert!(!follow.gap);
    assert_eq!(follow.missed, None);
    ring.push(3, json(3));
    assert_eq!(follow.live.try_recv().map(|entry| entry.meta), Ok(3));
}

#[test]
fn following_from_a_cursor_replays_only_what_is_newer() {
    let ring = ring(RingLimits::default());
    let first = ring.push(1, json(1));
    ring.push(2, json(2));
    ring.push(3, json(3));
    let follow = ring.follow(Some(&first.to_string()));
    assert_eq!(metas(&follow.replay), [2, 3]);
    assert!(!follow.gap);
    assert_eq!(follow.missed, Some(0));
    let caught_up = ring.follow(Some(&ring.position().to_string()));
    assert!(caught_up.replay.is_empty());
    assert!(!caught_up.gap);
    // Before the first entry of an empty ring is a position too.
    let empty = self::ring(RingLimits::default());
    let start = empty.position();
    assert_eq!(start.seq, 0);
    empty.push(1, json(1));
    let follow = empty.follow(Some(&start.to_string()));
    assert_eq!(metas(&follow.replay), [1]);
    assert!(!follow.gap);
}

#[test]
fn a_cursor_older_than_the_ring_is_a_gap_that_counts_what_was_lost() {
    let ring = ring(RingLimits {
        entries: 3,
        bytes: usize::MAX,
        floor: 1,
    });
    let first = ring.push(0, json(0));
    for index in 1..10 {
        ring.push(index, json(index));
    }
    let follow = ring.follow(Some(&first.to_string()));
    assert!(follow.gap);
    // Entries 2 to 7 (sequences) were evicted after the cursor's entry 1.
    assert_eq!(follow.missed, Some(6));
    assert_eq!(metas(&follow.replay), [7, 8, 9]);
}

#[test]
fn a_foreign_epoch_or_a_malformed_cursor_is_a_gap_without_a_count() {
    let ring = ring(RingLimits::default());
    ring.push(1, json(1));
    for after in [
        "00000001.1".to_owned(),
        "garbage".to_owned(),
        // From the future of this ring: not a position it ever had.
        Cursor {
            epoch: EPOCH,
            seq: 99,
        }
        .to_string(),
    ] {
        let follow = ring.follow(Some(&after));
        assert!(follow.gap, "{after}");
        assert_eq!(follow.missed, None, "{after}");
        assert_eq!(metas(&follow.replay), [1], "{after}");
    }
}

#[test]
fn the_snapshot_and_subscribe_boundary_has_no_gap_or_duplicate_under_concurrent_pushes() {
    const PUSHES: u32 = 3_000;
    let ring = ring(RingLimits {
        entries: 200_000,
        bytes: usize::MAX,
        floor: 1,
    });
    let pusher = {
        let ring = ring.clone();
        thread::spawn(move || {
            for index in 0..PUSHES {
                ring.push(index, json(index));
            }
        })
    };
    let mut follows = Vec::new();
    while !pusher.is_finished() {
        follows.push(ring.follow(None));
        thread::yield_now();
    }
    pusher.join().expect("pusher");
    follows.push(ring.follow(None));
    let mut checked = 0;
    for mut follow in follows {
        let mut seen = metas(&follow.replay);
        let complete = loop {
            match follow.live.try_recv() {
                Ok(entry) => seen.push(entry.meta),
                Err(broadcast::error::TryRecvError::Empty) => break true,
                // A receiver that fell behind the channel cannot speak for
                // the boundary.
                Err(_) => break false,
            }
        };
        if complete {
            assert_eq!(seen, (0..PUSHES).collect::<Vec<_>>());
            checked += 1;
        }
    }
    assert!(checked > 0);
}

#[test]
fn push_with_builds_the_entry_with_the_cursor_it_gets() {
    let ring = ring(RingLimits::default());
    ring.push(0, json(0));
    let cursor = ring.push_with(|cursor| {
        (
            u32::try_from(cursor.seq).expect("small"),
            Arc::from(format!("\"{cursor}\"")),
        )
    });
    let newest = ring.newest(1);
    assert_eq!(newest[0].cursor, cursor);
    assert_eq!(newest[0].meta, 2);
    assert_eq!(&*newest[0].json, format!("\"{cursor}\""));
}

#[test]
fn snapshot_oldest_and_newest_read_what_is_retained() {
    let ring = ring(RingLimits {
        entries: 4,
        bytes: usize::MAX,
        floor: 1,
    });
    assert!(ring.is_empty());
    assert_eq!(ring.oldest(), None);
    for index in 0..6 {
        ring.push(index, json(index));
    }
    assert_eq!(metas(&ring.snapshot()), [2, 3, 4, 5]);
    assert_eq!(ring.oldest().map(|cursor| cursor.seq), Some(3));
    ring.push(6, json(6));
    assert_eq!(ring.oldest().map(|cursor| cursor.seq), Some(4));
    assert_eq!(metas(&ring.newest(2)), [5, 6]);
    assert_eq!(metas(&ring.newest(100)), [3, 4, 5, 6]);
    assert_eq!(ring.position().seq, 7);
}

#[test]
fn epochs_differ_between_starts() {
    let epochs = (0..64)
        .map(|_| random_epoch())
        .collect::<std::collections::BTreeSet<_>>();
    assert!(epochs.len() > 60, "{epochs:?}");
}
