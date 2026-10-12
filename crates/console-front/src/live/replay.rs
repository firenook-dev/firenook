//! A [`ReplayRing`] as a topic stream: what a subscriber missed, then the
//! live tail, in windows.
//!
//! This is the one place that batches, recovers from lag and resumes a
//! feed: no topic builds its own. A subscription sees only the entries its
//! filter keeps; each window of kept entries becomes one event, at most one
//! every 100 ms (a window that fills up goes at once), whose data is the
//! entries' JSON joined under `items`, or what the topic's shaper builds.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use firenook_suite_front::{Cursor, Entry, ReplayRing};
use futures_util::StreamExt as _;
use futures_util::stream;
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::Instant;

use super::{ResetReason, TopicEvent, TopicStream};

/// How long a window collects entries before it is sent.
pub(crate) const WINDOW: Duration = Duration::from_millis(100);
/// How long a subscriber whose filter drops everything waits for a cursor.
pub(crate) const TICK_AFTER: Duration = Duration::from_secs(1);
/// How many dropped entries move a subscriber's cursor at once.
pub(crate) const TICK_EVERY: usize = 1_000;
/// Entries one window holds at most.
pub(crate) const MAX_ITEMS: usize = 1_000;
/// Bytes of entry JSON one window holds by default: an event's cap.
pub(crate) const MAX_BYTES: usize = 1024 * 1024;

/// Keeps only the entries one subscriber sees.
pub(crate) type ReplayFilter<M> = Arc<dyn Fn(&M) -> bool + Send + Sync>;
/// Builds one window's `data` from the entries the filter kept, in order;
/// `None` sends nothing for that window (the cursor still advances).
pub(crate) type ReplayShape<M> = Box<dyn FnMut(&[Entry<M>]) -> Option<Arc<str>> + Send>;

/// What one subscription keeps and how its windows are built.
pub(crate) struct ReplayOptions<M> {
    /// The entries this subscriber sees (a scope, a compiled `q`); `None`
    /// is all of them.
    pub(crate) filter: Option<ReplayFilter<M>>,
    /// Builds one window's `data`. Absent: `{"items":[` + the entries' JSON
    /// joined + `]}`.
    pub(crate) shape: Option<ReplayShape<M>>,
    /// Entries per window: default and maximum 1,000.
    pub(crate) max_items: usize,
    /// Bytes of entry JSON per window: default 1 MiB.
    pub(crate) max_bytes: usize,
}

impl<M> Default for ReplayOptions<M> {
    fn default() -> Self {
        Self {
            filter: None,
            shape: None,
            max_items: MAX_ITEMS,
            max_bytes: MAX_BYTES,
        }
    }
}

/// A ring as a topic stream: `Reset { reason: Gap, missed }` first when the
/// cursor had left the ring (or names another engine run), then the replay,
/// then live, keeping only entries the filter accepts. Windows: one `Event`
/// per 100 ms per subscriber, cut at `max_items` or `max_bytes`. A lagged
/// receiver re-follows from the last entry it consumed and says `Reset {
/// reason: Lagged }` only when the ring no longer holds what it missed.
/// While the filter drops entries, a cursor-only `tick` follows after 1,000
/// dropped entries or 1 s, whichever comes first; and a subscriber that has
/// not been sent a cursor by the end of its replay gets one in a `tick`, so
/// even a quiet subscription can resume where it was.
pub(crate) fn replay_topic<M: Clone + Send + Sync + 'static>(
    ring: &ReplayRing<M>,
    after: Option<&str>,
    name: &'static str,
    options: ReplayOptions<M>,
) -> TopicStream {
    let position = ring.position();
    let follow = ring.follow(after);
    let resumed = after
        .and_then(|after| after.parse::<Cursor>().ok())
        .filter(|_| !follow.gap);
    let mut outbox = VecDeque::new();
    if follow.gap && after.is_some() {
        outbox.push_back(TopicEvent::Reset {
            reason: ResetReason::Gap,
            missed: follow.missed,
        });
    }
    let state = Replay {
        ring: ring.clone(),
        name,
        max_items: options.max_items.clamp(1, MAX_ITEMS),
        max_bytes: options.max_bytes.max(1),
        filter: options.filter,
        shape: options.shape,
        live: follow.live,
        pending: follow.replay.into(),
        replaying: true,
        consumed: resumed,
        start: resumed.unwrap_or(position),
        cursor_sent: false,
        window: Vec::new(),
        window_bytes: 0,
        window_due: None,
        dropped: 0,
        tick_due: None,
        outbox,
    };
    stream::unfold(state, |mut state| async move {
        state.next().await.map(|event| (event, state))
    })
    .boxed()
}

struct Replay<M> {
    ring: ReplayRing<M>,
    name: &'static str,
    max_items: usize,
    max_bytes: usize,
    filter: Option<ReplayFilter<M>>,
    shape: Option<ReplayShape<M>>,
    live: broadcast::Receiver<Entry<M>>,
    /// Entries to replay before the live tail.
    pending: VecDeque<Entry<M>>,
    replaying: bool,
    /// The newest entry consumed, sent or dropped by the filter.
    consumed: Option<Cursor>,
    /// Where the subscriber stood when it subscribed.
    start: Cursor,
    cursor_sent: bool,
    window: Vec<Entry<M>>,
    window_bytes: usize,
    window_due: Option<Instant>,
    /// Entries dropped (filtered, or shaped to nothing) since the last
    /// cursor sent.
    dropped: usize,
    tick_due: Option<Instant>,
    outbox: VecDeque<TopicEvent>,
}

impl<M: Clone + Send + Sync + 'static> Replay<M> {
    async fn next(&mut self) -> Option<TopicEvent> {
        loop {
            if let Some(event) = self.outbox.pop_front() {
                return Some(event);
            }
            if let Some(entry) = self.pending.pop_front() {
                self.consume(entry);
                if self.pending.is_empty() {
                    self.finish_replay();
                }
                continue;
            }
            if self.replaying {
                // Nothing to replay at all.
                self.finish_replay();
                continue;
            }
            let never = Instant::now() + Duration::from_hours(24);
            let window_due = self.window_due.unwrap_or(never);
            let tick_due = self.tick_due.unwrap_or(never);
            tokio::select! {
                received = self.live.recv() => match received {
                    Ok(entry) => {
                        // A re-follow can deliver an entry the replay held.
                        if self.consumed.is_none_or(|consumed| entry.cursor > consumed) {
                            self.consume(entry);
                        }
                    }
                    Err(RecvError::Lagged(_)) => self.recover(),
                    Err(RecvError::Closed) => return None,
                },
                () = tokio::time::sleep_until(window_due), if self.window_due.is_some() => self.flush(),
                () = tokio::time::sleep_until(tick_due), if self.tick_due.is_some() => self.tick(),
            }
        }
    }

    fn consume(&mut self, entry: Entry<M>) {
        self.consumed = Some(entry.cursor);
        let kept = self
            .filter
            .as_ref()
            .is_none_or(|filter| filter(&entry.meta));
        if kept {
            // A window never holds more than its byte cap, unless one entry
            // alone is larger, which then goes alone.
            if !self.window.is_empty() && self.window_bytes + entry.json.len() > self.max_bytes {
                self.consumed = self.window.last().map(|last| last.cursor);
                self.flush();
                self.consumed = Some(entry.cursor);
            }
            self.window_bytes += entry.json.len();
            self.window.push(entry);
            if self.window.len() >= self.max_items || self.window_bytes >= self.max_bytes {
                self.flush();
            } else if !self.replaying && self.window_due.is_none() {
                self.window_due = Some(Instant::now() + WINDOW);
            }
        } else {
            self.dropped += 1;
            self.dropped_more();
        }
    }

    /// After entries were dropped: a tick at once past 1,000, else within
    /// a second.
    fn dropped_more(&mut self) {
        if self.dropped >= TICK_EVERY {
            self.tick();
        } else if !self.replaying && self.tick_due.is_none() {
            self.tick_due = Some(Instant::now() + TICK_AFTER);
        }
    }

    /// The replay is out: what it collected goes now, and a subscriber that
    /// has no cursor yet gets one.
    fn finish_replay(&mut self) {
        self.replaying = false;
        self.flush();
        if self.dropped > 0 {
            self.tick();
        }
        if !self.cursor_sent {
            self.send_tick(self.consumed.unwrap_or(self.start));
        }
    }

    fn flush(&mut self) {
        self.window_due = None;
        if self.window.is_empty() {
            return;
        }
        let entries = std::mem::take(&mut self.window);
        self.window_bytes = 0;
        let data = match self.shape.as_mut() {
            Some(shape) => shape(&entries),
            None => Some(items(&entries)),
        };
        if let (Some(data), Some(consumed)) = (data, self.consumed) {
            self.outbox.push_back(TopicEvent::Event {
                name: self.name,
                cursor: Some(Arc::from(consumed.to_string())),
                data,
            });
            self.cursor_sent = true;
            self.dropped = 0;
            self.tick_due = None;
        } else {
            self.dropped += entries.len();
            self.dropped_more();
        }
    }

    fn tick(&mut self) {
        self.tick_due = None;
        // Never move the cursor past entries a window still holds: they go
        // out first, with the cursor.
        if !self.window.is_empty() {
            self.flush();
            return;
        }
        if self.dropped > 0
            && let Some(consumed) = self.consumed
        {
            self.send_tick(consumed);
        }
    }

    fn send_tick(&mut self, cursor: Cursor) {
        self.outbox.push_back(TopicEvent::Event {
            name: "tick",
            cursor: Some(Arc::from(cursor.to_string())),
            data: Arc::from("null"),
        });
        self.cursor_sent = true;
        self.dropped = 0;
        self.tick_due = None;
    }

    /// The live receiver fell behind its channel: take what was missed from
    /// the ring, and reset only when the ring no longer holds it.
    fn recover(&mut self) {
        let after = self.consumed.map(|cursor| cursor.to_string());
        let follow = self.ring.follow(after.as_deref());
        self.live = follow.live;
        if follow.gap && after.is_some() {
            self.flush();
            self.outbox.push_back(TopicEvent::Reset {
                reason: ResetReason::Lagged,
                missed: follow.missed,
            });
        }
        self.pending = follow.replay.into();
        if !self.pending.is_empty() {
            self.replaying = true;
        }
    }
}

/// `{"items":[…]}` from entries serialized when they were pushed.
fn items<M>(entries: &[Entry<M>]) -> Arc<str> {
    let length = entries
        .iter()
        .map(|entry| entry.json.len() + 1)
        .sum::<usize>();
    let mut data = String::with_capacity(length + 12);
    data.push_str("{\"items\":[");
    for (index, entry) in entries.iter().enumerate() {
        if index > 0 {
            data.push(',');
        }
        data.push_str(&entry.json);
    }
    data.push_str("]}");
    Arc::from(data)
}

#[cfg(test)]
#[path = "replay_tests.rs"]
mod tests;
