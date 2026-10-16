//! Counts over the last minutes that a console view ages on its own clock:
//! a topic's publishes per second, a queue's dispatches per second and its
//! failures per ten seconds. The engine stamps the window with the end of
//! its newest bucket and sends only the non-zero buckets; the view shifts
//! them by the time since, so a rate decays to zero by itself when traffic
//! stops and nothing changes to send another frame. One counter for every
//! service, so each window says the same thing the same way.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// `SLOTS` buckets of `WIDTH` seconds ending at the newest bucket an event
/// fell in. Recording is O(1) amortized; an event older than the window is
/// dropped.
#[derive(Debug, Clone)]
pub struct CountWindow<const SLOTS: usize, const WIDTH: u64> {
    counts: [u32; SLOTS],
    /// The newest bucket, as seconds since the epoch divided by `WIDTH`.
    newest: u64,
}

/// Per second over the last minute.
pub type SecondCounts = CountWindow<60, 1>;

/// Per ten seconds over the last five minutes.
pub type TenSecondCounts = CountWindow<30, 10>;

impl<const SLOTS: usize, const WIDTH: u64> Default for CountWindow<SLOTS, WIDTH> {
    fn default() -> Self {
        Self {
            counts: [0; SLOTS],
            newest: 0,
        }
    }
}

impl<const SLOTS: usize, const WIDTH: u64> CountWindow<SLOTS, WIDTH> {
    fn slot(bucket: u64) -> usize {
        usize::try_from(bucket % SLOTS as u64).unwrap_or(0)
    }

    /// Counts `count` events at `at`: a newer bucket clears the ones it
    /// moves past, an event older than the window is dropped.
    pub fn record(&mut self, at: SystemTime, count: u32) {
        let bucket = at.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() / WIDTH;
        if bucket > self.newest {
            for step in 1..=(bucket - self.newest).min(SLOTS as u64) {
                self.counts[Self::slot(self.newest + step)] = 0;
            }
            self.newest = bucket;
        } else if bucket + SLOTS as u64 <= self.newest {
            return;
        }
        let slot = Self::slot(bucket);
        self.counts[slot] = self.counts[slot].saturating_add(count);
    }

    /// The window as a view receives it: when its newest bucket ends, and
    /// `(buckets before it, count)` for the non-zero buckets, newest first.
    #[must_use]
    pub fn window(&self) -> StampedWindow {
        let buckets = (0..SLOTS)
            .filter_map(|age| {
                let age = u8::try_from(age).ok()?;
                let bucket = self.newest.checked_sub(u64::from(age))?;
                let count = self.counts[Self::slot(bucket)];
                (count > 0).then_some((age, count))
            })
            .collect();
        StampedWindow {
            ends_at: UNIX_EPOCH + Duration::from_secs((self.newest + 1) * WIDTH - 1),
            width_seconds: u32::try_from(WIDTH).unwrap_or(1),
            buckets,
        }
    }
}

/// A count over time that a view ages on its own clock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StampedWindow {
    /// The last whole second the newest bucket covers.
    pub ends_at: SystemTime,
    /// One bucket's width in seconds.
    pub width_seconds: u32,
    /// `(buckets before the newest, count)` for the non-zero buckets,
    /// newest first.
    pub buckets: Vec<(u8, u32)>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
    }

    #[test]
    fn counts_land_in_their_second_newest_first() {
        let mut window = SecondCounts::default();
        window.record(at(1_000), 2);
        window.record(at(1_000), 1);
        window.record(at(1_003), 4);
        let stamped = window.window();
        assert_eq!(stamped.ends_at, at(1_003));
        assert_eq!(stamped.width_seconds, 1);
        assert_eq!(stamped.buckets, [(0, 4), (3, 3)]);
    }

    #[test]
    fn a_newer_second_clears_what_it_moves_past_and_late_counts_are_dropped() {
        let mut window = SecondCounts::default();
        window.record(at(1_000), 5);
        // Sixty seconds on, the old slot is reused: it starts from zero.
        window.record(at(1_060), 1);
        assert_eq!(window.window().buckets, [(0, 1)]);
        // An event older than the window counts for nothing.
        window.record(at(1_000), 7);
        assert_eq!(window.window().buckets, [(0, 1)]);
        // One inside it still counts, in its own second.
        window.record(at(1_059), 2);
        assert_eq!(window.window().buckets, [(0, 1), (1, 2)]);
        // A long silence clears every slot.
        window.record(at(5_000), 1);
        assert_eq!(window.window().buckets, [(0, 1)]);
    }

    #[test]
    fn ten_second_buckets_end_at_their_last_second() {
        let mut window = TenSecondCounts::default();
        window.record(at(1_005), 1);
        window.record(at(1_019), 2);
        window.record(at(1_021), 3);
        let stamped = window.window();
        assert_eq!(stamped.ends_at, at(1_029));
        assert_eq!(stamped.width_seconds, 10);
        assert_eq!(stamped.buckets, [(0, 3), (1, 2), (2, 1)]);
    }

    #[test]
    fn an_empty_window_has_no_buckets() {
        let window = SecondCounts::default();
        assert_eq!(window.window().buckets, Vec::<(u8, u32)>::new());
        assert_eq!(window.window().ends_at, UNIX_EPOCH);
    }

    #[test]
    fn a_count_saturates() {
        let mut window = SecondCounts::default();
        window.record(at(10), u32::MAX);
        window.record(at(10), 1);
        assert_eq!(window.window().buckets, [(0, u32::MAX)]);
    }
}
