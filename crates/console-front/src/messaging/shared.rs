//! What Pub/Sub and Cloud Tasks share in the console: the stamped windows
//! the console ages, times as the API writes them, counts in words, and the
//! key coalescer behind the invalidation topics.

use std::collections::BTreeSet;
use std::time::{Duration, SystemTime};

use firenook_pubsub_front::broker::rfc3339_millis;
use firenook_suite_front::window::StampedWindow;
use serde::Serialize;
use ts_rs::TS;

/// A per-second count that ends at `ends_at`; the console ages it on its
/// own clock, so "12/min" decays to "0/min" when traffic stops.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct MessagingSecondWindow {
    /// The last whole second the window covers, RFC 3339.
    pub ends_at: String,
    /// `[seconds before endsAt, count]` for the non-zero seconds of the last
    /// sixty, newest first.
    pub buckets: Vec<(u8, u32)>,
}

/// The same, in ten-second buckets over five minutes: `[buckets before
/// endsAt, count]`, so bucket 3 ends thirty seconds before `endsAt`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct MessagingTenSecondWindow {
    /// The last whole second the window covers, RFC 3339.
    pub ends_at: String,
    /// `[ten-second buckets before endsAt, count]` for the non-zero buckets
    /// of the last thirty, newest first.
    pub buckets: Vec<(u8, u32)>,
}

/// A time as the console API writes it: RFC 3339 with milliseconds.
pub(crate) fn time(at: SystemTime) -> String {
    rfc3339_millis(at)
}

/// An optional time, the same way.
pub(crate) fn time_of(at: Option<SystemTime>) -> Option<String> {
    at.map(rfc3339_millis)
}

/// A per-second window (a topic's publishes, a queue's dispatches), as the
/// console ages it.
pub(crate) fn second_window(window: &StampedWindow) -> MessagingSecondWindow {
    MessagingSecondWindow {
        ends_at: time(window.ends_at),
        buckets: window.buckets.clone(),
    }
}

/// A ten-second window (a queue's failures).
pub(crate) fn stamped_ten_seconds(window: &StampedWindow) -> MessagingTenSecondWindow {
    MessagingTenSecondWindow {
        ends_at: time(window.ends_at),
        buckets: window.buckets.clone(),
    }
}

/// `1,204`: a count with thousands separators, as the console writes it.
pub(crate) fn count_text(count: u64) -> String {
    let digits = count.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// `1 queue`, `3 queues`.
pub(crate) fn counted(count: u64, one: &str, other: &str) -> String {
    format!(
        "{} {}",
        count_text(count),
        if count == 1 { one } else { other }
    )
}

/// A count as the API's `u32`, saturating.
pub(crate) fn u32_of(count: usize) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
}

/// A count as the API's `u64`, saturating.
pub(crate) fn u64_of(count: usize) -> u64 {
    u64::try_from(count).unwrap_or(u64::MAX)
}

/// Milliseconds of a duration, for the API's `…Ms` fields.
pub(crate) fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

/// Keys an invalidation topic sends at most in one event; past it the
/// subscriber reloads (`reset`) instead.
pub(crate) const MAX_KEYS: usize = 1_000;

/// The keys an invalidation topic collected in one 100 ms window,
/// deduplicated, in the order they first arrived. Past [`MAX_KEYS`] it
/// stops collecting and says the subscriber must reload.
#[derive(Debug, Default)]
pub(crate) struct KeyWindow {
    keys: Vec<String>,
    seen: BTreeSet<String>,
    overflow: bool,
}

impl KeyWindow {
    /// Adds `key` once.
    pub(crate) fn add(&mut self, key: String) {
        if self.overflow || self.seen.contains(&key) {
            return;
        }
        if self.keys.len() >= MAX_KEYS {
            self.overflow = true;
            self.keys.clear();
            self.seen.clear();
            return;
        }
        self.seen.insert(key.clone());
        self.keys.push(key);
    }

    /// Too many keys arrived: the subscriber reloads.
    pub(crate) fn overflow(&mut self) {
        self.overflow = true;
        self.keys.clear();
        self.seen.clear();
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.keys.is_empty() && !self.overflow
    }

    /// The window's keys (or that it overflowed), emptying it.
    pub(crate) fn take(&mut self) -> Result<Vec<String>, ()> {
        let overflow = std::mem::take(&mut self.overflow);
        self.seen.clear();
        let keys = std::mem::take(&mut self.keys);
        if overflow { Err(()) } else { Ok(keys) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_are_written_with_separators() {
        assert_eq!(count_text(0), "0");
        assert_eq!(count_text(999), "999");
        assert_eq!(count_text(1_000), "1,000");
        assert_eq!(count_text(1_234_567), "1,234,567");
        assert_eq!(counted(1, "queue", "queues"), "1 queue");
        assert_eq!(counted(12_000, "topic", "topics"), "12,000 topics");
    }

    #[test]
    fn a_key_window_deduplicates_and_overflows() {
        let mut window = KeyWindow::default();
        assert!(window.is_empty());
        window.add("row:1".to_owned());
        window.add("row:2".to_owned());
        window.add("row:1".to_owned());
        assert_eq!(
            window.take(),
            Ok(vec!["row:1".to_owned(), "row:2".to_owned()])
        );
        assert!(window.is_empty());
        for index in 0..=MAX_KEYS {
            window.add(format!("row:{index}"));
        }
        assert!(!window.is_empty());
        assert_eq!(window.take(), Err(()));
        assert!(window.is_empty(), "a reset starts a fresh window");
    }
}
