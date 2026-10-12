//! The numbers the navigation shows beside a section or one of its pages.
//!
//! Sections publish to one [`BadgeBoard`]; the `shell` topic sends the whole
//! set on open and then at most every 250 ms while it changes. The board is
//! a `watch`, so it costs the same memory however fast a counter moves, and
//! writing a badge never waits on a subscriber.
//!
//! The final set is decided in the foundation specification (§7.10); a
//! section adds a badge there first.

use std::collections::BTreeMap;
use std::sync::Arc;

use firenook_suite_front::Cursor;
use serde::Serialize;
use tokio::sync::watch;
use ts_rs::TS;

/// A number the navigation shows beside a section or one of its pages.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "live/")]
pub struct Badge {
    /// `<section>.<what>`, for example `auth.inbox`.
    pub id: String,
    #[ts(type = "number")]
    pub count: u64,
    pub kind: BadgeKind,
    pub tone: BadgeTone,
    /// What is counted, as nouns the console puts the number before:
    /// "1 rules file does not compile", "3 new codes and links".
    pub noun: BadgeNoun,
    /// Counters of ring entries only: the cursor of the newest counted entry
    /// (`logs.errors`). The seen record keeps it, so the section can open at
    /// what is new.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cursor: Option<String>,
}

/// Singular and plural of what a badge counts, each a phrase that reads
/// after a number.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export_to = "live/")]
pub struct BadgeNoun {
    pub one: String,
    pub other: String,
}

impl BadgeNoun {
    /// `one` after 1, `other` after any other number.
    #[must_use]
    pub fn new(one: &str, other: &str) -> Self {
        Self {
            one: one.to_owned(),
            other: other.to_owned(),
        }
    }
}

/// How a badge's number is read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "live/")]
pub enum BadgeKind {
    /// A running total since the engine started; the console shows how much
    /// it grew since the person last opened the section.
    Counter,
    /// An amount now; shown whenever it is above zero.
    Gauge,
}

/// How loudly a badge is drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "live/")]
pub enum BadgeTone {
    Neutral,
    Attention,
    Danger,
}

/// Every badge, as the `shell` topic sends it, ordered by id.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export_to = "live/")]
pub struct BadgeSet {
    pub badges: Vec<Badge>,
}

/// Where sections publish their badges. Cheap to clone.
#[derive(Clone)]
pub(crate) struct BadgeBoard {
    board: Arc<watch::Sender<BTreeMap<String, Badge>>>,
}

impl Default for BadgeBoard {
    fn default() -> Self {
        Self {
            board: Arc::new(watch::Sender::new(BTreeMap::new())),
        }
    }
}

impl BadgeBoard {
    /// The writer of badge `id`. The badge appears (at zero) as soon as it
    /// is created, so the console knows it exists before it first counts.
    pub(crate) fn handle(&self, id: &str, kind: BadgeKind, noun: BadgeNoun) -> BadgeHandle {
        let handle = BadgeHandle {
            board: self.board.clone(),
            id: Arc::from(id),
            kind,
            noun: Arc::new(noun),
        };
        handle.update(|_| {});
        handle
    }

    /// Ticks whenever a badge changes.
    pub(crate) fn subscribe(&self) -> watch::Receiver<BTreeMap<String, Badge>> {
        self.board.subscribe()
    }

    /// Every badge now, ordered by id.
    #[cfg(test)]
    pub(crate) fn snapshot(&self) -> BadgeSet {
        set_of(&self.board.borrow())
    }
}

/// Every badge in `board`, ordered by id.
pub(crate) fn set_of(board: &BTreeMap<String, Badge>) -> BadgeSet {
    BadgeSet {
        badges: board.values().cloned().collect(),
    }
}

/// One badge's writer. `set` is O(log n) in the number of badges and never
/// blocks on a reader.
#[derive(Clone)]
pub(crate) struct BadgeHandle {
    board: Arc<watch::Sender<BTreeMap<String, Badge>>>,
    id: Arc<str>,
    kind: BadgeKind,
    noun: Arc<BadgeNoun>,
}

impl BadgeHandle {
    /// Sets the number and tone (gauges, or a counter re-read in full).
    pub(crate) fn set(&self, count: u64, tone: BadgeTone) {
        self.update(|badge| {
            badge.count = count;
            badge.tone = tone;
        });
    }

    /// Counters only: adds `by` and keeps the tone.
    #[allow(
        dead_code,
        reason = "the section streams' counters (auth.inbox, functions.failed, tasks.failed) call it"
    )]
    pub(crate) fn add(&self, by: u64, tone: BadgeTone) {
        self.update(|badge| {
            badge.count = badge.count.saturating_add(by);
            badge.tone = tone;
        });
    }

    /// Counters of ring entries: adds `by` and records the newest entry's
    /// cursor.
    #[allow(
        dead_code,
        reason = "ring-backed counters (logs.errors) call it from the observe stream"
    )]
    pub(crate) fn add_at(&self, by: u64, tone: BadgeTone, cursor: Cursor) {
        self.update(|badge| {
            badge.count = badge.count.saturating_add(by);
            badge.tone = tone;
            badge.cursor = Some(cursor.to_string());
        });
    }

    fn update(&self, change: impl FnOnce(&mut Badge)) {
        self.board.send_if_modified(|board| {
            let mut created = false;
            let badge = board.entry(self.id.to_string()).or_insert_with(|| {
                created = true;
                Badge {
                    id: self.id.to_string(),
                    count: 0,
                    kind: self.kind,
                    tone: BadgeTone::Neutral,
                    noun: (*self.noun).clone(),
                    cursor: None,
                }
            });
            let before = (badge.count, badge.tone, badge.cursor.clone());
            change(badge);
            // A new badge is announced even at zero, so the console knows it.
            created || before != (badge.count, badge.tone, badge.cursor.clone())
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_add_gauges_set_and_the_board_is_ordered_by_id() {
        let board = BadgeBoard::default();
        let mut changes = board.subscribe();
        let inbox = board.handle(
            "auth.inbox",
            BadgeKind::Counter,
            BadgeNoun::new("new code or link", "new codes and links"),
        );
        let rules = board.handle(
            "firestore.rules",
            BadgeKind::Gauge,
            BadgeNoun::new("rules file does not compile", "rules files do not compile"),
        );
        assert!(
            changes.has_changed().expect("open"),
            "a new badge is announced"
        );
        changes.mark_unchanged();
        inbox.add(2, BadgeTone::Neutral);
        inbox.add(3, BadgeTone::Neutral);
        rules.set(1, BadgeTone::Danger);
        rules.set(1, BadgeTone::Danger);
        assert!(changes.has_changed().expect("open"));
        let set = board.snapshot();
        let ids: Vec<&str> = set.badges.iter().map(|badge| badge.id.as_str()).collect();
        assert_eq!(ids, ["auth.inbox", "firestore.rules"]);
        assert_eq!(set.badges[0].count, 5);
        assert_eq!(set.badges[0].kind, BadgeKind::Counter);
        assert_eq!(set.badges[1].count, 1);
        assert_eq!(set.badges[1].tone, BadgeTone::Danger);
        assert_eq!(set.badges[1].noun.other, "rules files do not compile");
        changes.mark_unchanged();
        // Setting what is already there is not a change.
        rules.set(1, BadgeTone::Danger);
        assert!(!changes.has_changed().expect("open"));
        let json = serde_json::to_value(&set).expect("json");
        assert_eq!(json["badges"][1]["kind"], "gauge");
        assert_eq!(json["badges"][1]["tone"], "danger");
        assert!(json["badges"][1].get("cursor").is_none(), "{json}");
    }

    #[test]
    fn ring_counters_record_the_newest_cursor() {
        let board = BadgeBoard::default();
        let errors = board.handle(
            "logs.errors",
            BadgeKind::Counter,
            BadgeNoun::new("error", "errors"),
        );
        let cursor: Cursor = "1a2b3c4d.17".parse().expect("cursor");
        errors.add_at(4, BadgeTone::Attention, cursor);
        let set = board.snapshot();
        assert_eq!(set.badges[0].count, 4);
        assert_eq!(set.badges[0].cursor.as_deref(), Some("1a2b3c4d.17"));
    }
}
