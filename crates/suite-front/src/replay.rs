//! A bounded, sequenced history with a live tail: the one buffer behind
//! every feed the suite keeps (the log, Firestore's change batches, and each
//! console section's feeds).
//!
//! Entries carry a cursor (`<epoch>.<sequence>`) and their JSON, serialized
//! once when they are pushed, so a feed served to many subscribers never
//! serializes an entry twice. A subscriber that reconnects with its last
//! cursor gets exactly what it missed while the ring still holds it, and is
//! told how much it lost when the ring does not. Snapshot and subscription
//! happen under one lock, so a follower never sees a gap or a duplicate at
//! the boundary, and pushing never waits on a subscriber.
//!
//! Every ring of the process shares one memory budget ([`RingBudget`]):
//! when the rings together hold more than it, the ring whose oldest entry is
//! the oldest in the process gives entries up first, never below its floor.

use std::collections::VecDeque;
use std::fmt;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use tokio::sync::broadcast;

use super::lock;

/// The memory every ring of the process shares by default: 64 MiB.
pub const RING_BUDGET_BYTES: usize = 64 * 1024 * 1024;

/// Orders pushes across every ring, so the budget can tell which ring holds
/// the oldest entry without reading a clock on the push path.
static PUSH_CLOCK: AtomicU64 = AtomicU64::new(0);

/// Where a subscriber is in a ring: `<epoch>.<sequence>`, opaque to clients.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Cursor {
    /// The ring's epoch: random per engine start, so a cursor from another
    /// run is recognised as such.
    pub epoch: u32,
    /// The entry's sequence in its ring, from 1; 0 is "before the first".
    pub seq: u64,
}

impl fmt::Display for Cursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:08x}.{}", self.epoch, self.seq)
    }
}

/// A cursor that is not `<8 hex digits>.<decimal sequence>`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CursorError;

impl fmt::Display for CursorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("not a feed cursor")
    }
}

impl std::error::Error for CursorError {}

impl FromStr for Cursor {
    type Err = CursorError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let (epoch, seq) = text.split_once('.').ok_or(CursorError)?;
        if epoch.len() != 8 || !epoch.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(CursorError);
        }
        if seq.is_empty() || seq.len() > 20 || !seq.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(CursorError);
        }
        Ok(Self {
            epoch: u32::from_str_radix(epoch, 16).map_err(|_| CursorError)?,
            seq: seq.parse().map_err(|_| CursorError)?,
        })
    }
}

/// How much one ring keeps. The default is 10,000 entries / 8 MiB / floor
/// 256; a ring may set more (the log ring: 20,000 / 16 MiB), still under the
/// shared budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RingLimits {
    /// Entries kept at most.
    pub entries: usize,
    /// Bytes of entry JSON (and of what an entry's metadata holds) kept at
    /// most; the newest entry is kept whatever its size.
    pub bytes: usize,
    /// Never evicted below this many entries by the shared budget.
    pub floor: usize,
}

impl RingLimits {
    /// 10,000 entries / 8 MiB / floor 256.
    pub const DEFAULT: Self = Self {
        entries: 10_000,
        bytes: 8 * 1024 * 1024,
        floor: 256,
    };
}

impl Default for RingLimits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// One ring's size: what the budget counts of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RingSize {
    pub name: String,
    pub entries: usize,
    pub bytes: usize,
}

/// What the budget asks of each ring.
trait Evictable: Send + Sync {
    fn size(&self) -> RingSize;
    /// The push clock of the oldest entry, when the ring may give one up
    /// (it holds more than its floor).
    fn evictable_since(&self) -> Option<u64>;
    /// Drops the oldest entry if the ring holds more than its floor;
    /// answers the bytes freed.
    fn evict_oldest(&self) -> usize;
}

struct BudgetInner {
    limit: usize,
    used: AtomicUsize,
    rings: Mutex<Vec<Weak<dyn Evictable>>>,
}

/// The memory every ring of a process shares. When the total is over, the
/// ring whose oldest entry is the oldest gives up entries first.
#[derive(Clone)]
pub struct RingBudget {
    inner: Arc<BudgetInner>,
}

impl fmt::Debug for RingBudget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RingBudget")
            .field("limit", &self.inner.limit)
            .field("used", &self.used())
            .finish_non_exhaustive()
    }
}

impl RingBudget {
    /// A budget of `bytes` for the rings registered with it.
    #[must_use]
    pub fn new(bytes: usize) -> Self {
        Self {
            inner: Arc::new(BudgetInner {
                limit: bytes,
                used: AtomicUsize::new(0),
                rings: Mutex::new(Vec::new()),
            }),
        }
    }

    /// The process's budget ([`RING_BUDGET_BYTES`]), shared by every ring
    /// the suite and the console create.
    #[must_use]
    pub fn shared() -> Self {
        static SHARED: OnceLock<RingBudget> = OnceLock::new();
        SHARED.get_or_init(|| Self::new(RING_BUDGET_BYTES)).clone()
    }

    /// The budget, in bytes.
    #[must_use]
    pub fn limit(&self) -> usize {
        self.inner.limit
    }

    /// What every ring holds together, in bytes.
    #[must_use]
    pub fn used(&self) -> usize {
        self.inner.used.load(Ordering::Relaxed)
    }

    /// Sizes per ring, in registration order: how the budget is shared out.
    #[must_use]
    pub fn report(&self) -> Vec<RingSize> {
        let mut rings = lock(&self.inner.rings);
        rings.retain(|ring| ring.strong_count() > 0);
        rings
            .iter()
            .filter_map(Weak::upgrade)
            .map(|ring| ring.size())
            .collect()
    }

    fn register(&self, ring: Weak<dyn Evictable>) {
        lock(&self.inner.rings).push(ring);
    }

    /// Records what a push added and freed, then gives entries back while
    /// the rings together are over the budget.
    fn account(&self, added: usize, freed: usize) {
        // One atomic operation, or none when a push replaced what it evicted
        // byte for byte: this runs on every push.
        let used = match added.cmp(&freed) {
            std::cmp::Ordering::Equal => return,
            std::cmp::Ordering::Greater => {
                let grown = added - freed;
                self.inner.used.fetch_add(grown, Ordering::Relaxed) + grown
            }
            std::cmp::Ordering::Less => {
                let shrunk = freed - added;
                self.inner
                    .used
                    .fetch_sub(shrunk, Ordering::Relaxed)
                    .saturating_sub(shrunk)
            }
        };
        if used > self.inner.limit {
            self.rebalance();
        }
    }

    fn release(&self, bytes: usize) {
        self.inner.used.fetch_sub(bytes, Ordering::Relaxed);
    }

    fn rebalance(&self) {
        // Lock order: the registry, then one ring at a time. A push holds
        // no ring lock when it gets here, so no cycle can form.
        let mut rings = lock(&self.inner.rings);
        rings.retain(|ring| ring.strong_count() > 0);
        while self.used() > self.inner.limit {
            let oldest = rings
                .iter()
                .filter_map(Weak::upgrade)
                .filter_map(|ring| ring.evictable_since().map(|since| (since, ring)))
                .min_by_key(|(since, _)| *since);
            let Some((_, ring)) = oldest else {
                // Every ring is at its floor: the floors win over the budget.
                break;
            };
            let freed = ring.evict_oldest();
            if freed == 0 {
                break;
            }
            self.release(freed);
        }
    }
}

/// One entry: small metadata a filter reads (`M`: level, service, path, …)
/// and the JSON the console sends, serialized once.
#[derive(Clone, Debug)]
pub struct Entry<M> {
    pub cursor: Cursor,
    pub meta: M,
    pub json: Arc<str>,
}

struct Slot<M> {
    entry: Entry<M>,
    weight: usize,
    clock: u64,
}

struct RingState<M> {
    entries: VecDeque<Slot<M>>,
    next_seq: u64,
    bytes: usize,
}

struct RingInner<M> {
    name: &'static str,
    limits: RingLimits,
    epoch: u32,
    budget: RingBudget,
    state: Mutex<RingState<M>>,
    live: broadcast::Sender<Entry<M>>,
}

impl<M: Clone + Send + Sync + 'static> Evictable for RingInner<M> {
    fn size(&self) -> RingSize {
        let state = lock(&self.state);
        RingSize {
            name: self.name.to_owned(),
            entries: state.entries.len(),
            bytes: state.bytes,
        }
    }

    fn evictable_since(&self) -> Option<u64> {
        let state = lock(&self.state);
        if state.entries.len() <= self.limits.floor {
            return None;
        }
        state.entries.front().map(|slot| slot.clock)
    }

    fn evict_oldest(&self) -> usize {
        let mut state = lock(&self.state);
        if state.entries.len() <= self.limits.floor {
            return 0;
        }
        state.entries.pop_front().map_or(0, |slot| {
            state.bytes -= slot.weight;
            slot.weight
        })
    }
}

impl<M> Drop for RingInner<M> {
    fn drop(&mut self) {
        let bytes = self
            .state
            .get_mut()
            .map_or_else(|poisoned| poisoned.into_inner().bytes, |state| state.bytes);
        self.budget.release(bytes);
    }
}

/// A subscription taken with [`ReplayRing::follow`].
pub struct Follow<M> {
    /// Retained entries after the cursor asked for (or the whole ring on a
    /// gap, or with no cursor).
    pub replay: Vec<Entry<M>>,
    /// The cursor was older than the ring, from another epoch, or malformed.
    pub gap: bool,
    /// How many entries were lost between the cursor and the ring's start:
    /// `Some(0)` when nothing was; `None` when the cursor is from another
    /// epoch or malformed, or when none was given. Becomes `LiveReset.missed`.
    pub missed: Option<u64>,
    /// Every entry pushed after the replay, in order.
    pub live: broadcast::Receiver<Entry<M>>,
}

/// A bounded, sequenced history with a live tail. Cloning shares it.
pub struct ReplayRing<M> {
    inner: Arc<RingInner<M>>,
}

impl<M> Clone for ReplayRing<M> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl<M> fmt::Debug for ReplayRing<M> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ReplayRing")
            .field("name", &self.inner.name)
            .field("epoch", &self.inner.epoch)
            .finish_non_exhaustive()
    }
}

/// An epoch nobody else is likely to use: different on every engine start,
/// so a cursor from a previous run is a gap, not a position.
#[must_use]
pub fn random_epoch() -> u32 {
    use std::hash::{BuildHasher as _, Hasher as _};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    hasher.write_u32(std::process::id());
    if let Ok(elapsed) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        hasher.write_u128(elapsed.as_nanos());
    }
    let hash = hasher.finish();
    // Truncation keeps the low 32 bits, which is the point.
    #[allow(clippy::cast_possible_truncation)]
    let epoch = (hash ^ (hash >> 32)) as u32;
    epoch
}

impl<M: Clone + Send + Sync + 'static> ReplayRing<M> {
    /// An empty ring named `name` (it names the ring in the memory report),
    /// keeping `limits` under `budget`, writing cursors in `epoch`.
    #[must_use]
    pub fn new(name: &'static str, limits: RingLimits, epoch: u32, budget: &RingBudget) -> Self {
        let (live, _) = broadcast::channel(limits.entries.clamp(1, 1024));
        let inner = Arc::new(RingInner {
            name,
            limits,
            epoch,
            budget: budget.clone(),
            state: Mutex::new(RingState {
                entries: VecDeque::new(),
                next_seq: 1,
                bytes: 0,
            }),
            live,
        });
        // Coerce once, to the trait object the registry holds.
        let evictable: Arc<dyn Evictable> = inner.clone();
        budget.register(Arc::downgrade(&evictable));
        Self { inner }
    }

    /// Appends one entry, evicting the oldest past its limits or the budget,
    /// and tells every follower.
    pub fn push(&self, meta: M, json: Arc<str>) -> Cursor {
        self.insert(|_| (meta, json, 0))
    }

    /// The same, for an entry whose metadata holds data its JSON does not
    /// (Firestore's change batches keep the document keys and serialize per
    /// subscriber): `extra` bytes are counted against the ring's limits and
    /// the budget beside the JSON.
    pub fn push_weighted(&self, meta: M, json: Arc<str>, extra: usize) -> Cursor {
        self.insert(|_| (meta, json, extra))
    }

    /// The same, for an entry that carries its own cursor (a log line, an
    /// invocation): `build` runs inside the ring's lock with the cursor the
    /// entry will have.
    pub fn push_with(&self, build: impl FnOnce(Cursor) -> (M, Arc<str>)) -> Cursor {
        self.insert(|cursor| {
            let (meta, json) = build(cursor);
            (meta, json, 0)
        })
    }

    fn insert(&self, build: impl FnOnce(Cursor) -> (M, Arc<str>, usize)) -> Cursor {
        let limits = self.inner.limits;
        let (cursor, added, freed) = {
            let mut state = lock(&self.inner.state);
            let cursor = Cursor {
                epoch: self.inner.epoch,
                seq: state.next_seq,
            };
            state.next_seq += 1;
            let (meta, json, extra) = build(cursor);
            let weight = json.len() + extra;
            let entry = Entry { cursor, meta, json };
            // Sent under the ring's lock: a follower subscribes under the
            // same lock, so it either has this entry in its replay or will
            // receive it live, never both and never neither; and none can
            // appear between the count and the send. Nothing waits on a
            // subscriber, and with none the entry is not even copied.
            if self.inner.live.receiver_count() > 0 {
                let _ = self.inner.live.send(entry.clone());
            }
            state.entries.push_back(Slot {
                entry,
                weight,
                clock: PUSH_CLOCK.fetch_add(1, Ordering::Relaxed),
            });
            state.bytes += weight;
            let mut freed = 0;
            while state.entries.len() > limits.entries
                || (state.bytes > limits.bytes && state.entries.len() > 1)
            {
                let Some(slot) = state.entries.pop_front() else {
                    break;
                };
                state.bytes -= slot.weight;
                freed += slot.weight;
            }
            (cursor, weight, freed)
        };
        self.inner.budget.account(added, freed);
        cursor
    }

    /// Retained entries after `after` and a live receiver for the rest, both
    /// taken under one lock. Without a cursor, the whole ring.
    #[must_use]
    pub fn follow(&self, after: Option<&str>) -> Follow<M> {
        let state = lock(&self.inner.state);
        let live = self.inner.live.subscribe();
        let first = state
            .entries
            .front()
            .map_or(state.next_seq, |slot| slot.entry.cursor.seq);
        let whole = || {
            state
                .entries
                .iter()
                .map(|slot| slot.entry.clone())
                .collect()
        };
        let Some(after) = after else {
            return Follow {
                replay: whole(),
                gap: false,
                missed: None,
                live,
            };
        };
        match after.parse::<Cursor>() {
            // A cursor from this run, no newer than what was pushed.
            Ok(cursor) if cursor.epoch == self.inner.epoch && cursor.seq < state.next_seq => {
                if cursor.seq + 1 >= first {
                    let replay = state
                        .entries
                        .iter()
                        .skip_while(|slot| slot.entry.cursor.seq <= cursor.seq)
                        .map(|slot| slot.entry.clone())
                        .collect();
                    Follow {
                        replay,
                        gap: false,
                        missed: Some(0),
                        live,
                    }
                } else {
                    Follow {
                        replay: whole(),
                        gap: true,
                        missed: Some(first - cursor.seq - 1),
                        live,
                    }
                }
            }
            _ => Follow {
                replay: whole(),
                gap: true,
                missed: None,
                live,
            },
        }
    }

    /// Every retained entry (`Arc` clones), without subscribing: pages and
    /// counts over one consistent view.
    #[must_use]
    pub fn snapshot(&self) -> Vec<Entry<M>> {
        lock(&self.inner.state)
            .entries
            .iter()
            .map(|slot| slot.entry.clone())
            .collect()
    }

    /// The oldest retained cursor, so a secondary index (Storage's decisions
    /// by object name) prunes what the ring evicted.
    #[must_use]
    pub fn oldest(&self) -> Option<Cursor> {
        lock(&self.inner.state)
            .entries
            .front()
            .map(|slot| slot.entry.cursor)
    }

    /// The newest `n` entries, oldest first (the official Logging WebSocket
    /// replays 1,024).
    #[must_use]
    pub fn newest(&self, n: usize) -> Vec<Entry<M>> {
        let state = lock(&self.inner.state);
        let skip = state.entries.len().saturating_sub(n);
        state
            .entries
            .iter()
            .skip(skip)
            .map(|slot| slot.entry.clone())
            .collect()
    }

    /// Where the ring is now: the cursor of the newest entry ever pushed
    /// (sequence 0 before the first). Following from it replays nothing and
    /// delivers everything pushed afterwards.
    #[must_use]
    pub fn position(&self) -> Cursor {
        Cursor {
            epoch: self.inner.epoch,
            seq: lock(&self.inner.state).next_seq - 1,
        }
    }

    /// Entries retained.
    #[must_use]
    pub fn len(&self) -> usize {
        lock(&self.inner.state).entries.len()
    }

    /// Whether nothing is retained.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Bytes retained, as the limits count them.
    #[must_use]
    pub fn bytes(&self) -> usize {
        lock(&self.inner.state).bytes
    }

    /// The ring's name in the memory report.
    #[must_use]
    pub fn name(&self) -> &'static str {
        self.inner.name
    }

    /// The epoch every cursor of this ring carries.
    #[must_use]
    pub fn epoch(&self) -> u32 {
        self.inner.epoch
    }

    /// Live followers subscribed now.
    #[must_use]
    pub fn followers(&self) -> usize {
        self.inner.live.receiver_count()
    }
}

#[cfg(test)]
#[path = "replay_tests.rs"]
mod tests;
