//! The monitor's state: in-flight and finished invocation records, the
//! event-id and task indexes, per-function counters and each codebase's
//! load log. Everything here runs under the monitor's one lock, so every
//! operation is O(1) or O(log n) except the reads a console request makes.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Instant, SystemTime};

use axum::body::Bytes;
use axum::http::HeaderMap;

use super::MonitorLimits;
use super::types::{
    EventarcDelivery, EventarcEventSummary, FunctionCodebase, FunctionKind, FunctionLogLine,
    FunctionStats, FunctionsPhase, InvocationSummary, InvocationTarget, InvocationTimings,
};

/// Bytes counted for a record beyond its bodies, headers and lines.
pub(crate) const RECORD_OVERHEAD: usize = 512;
/// Bytes counted per kept log line beyond its text.
pub(crate) const LINE_OVERHEAD: usize = 96;
/// Bytes counted per header beyond its name and value.
const HEADER_OVERHEAD: usize = 32;

/// Everything the monitor keeps.
#[derive(Default)]
pub(crate) struct State {
    pub(crate) phase: FunctionsPhase,
    /// Registration order; each with its load log.
    pub(crate) codebases: Vec<CodebaseState>,
    /// Running invocations by seq: never evicted, never scanned by eviction.
    pub(crate) in_flight: HashMap<u64, InvocationRecord>,
    /// Retained bytes of the running records (counted in the byte budget).
    pub(crate) in_flight_bytes: usize,
    pub(crate) finished: FinishedStore,
    /// Event id → the newest seq that delivered it; removed with its record.
    pub(crate) by_event: HashMap<Arc<str>, u64>,
    /// `queue \0 task \0 retry` → seq; removed with its record.
    pub(crate) by_task: HashMap<String, u64>,
    /// By function id.
    pub(crate) stats: HashMap<String, StatsState>,
    pub(crate) events: EventStore,
    pub(crate) next_invocation: u64,
    pub(crate) next_event: u64,
}

impl State {
    pub(crate) fn codebase_mut(&mut self, id: &str) -> Option<&mut CodebaseState> {
        self.codebases
            .iter_mut()
            .find(|codebase| codebase.codebase.id == id)
    }

    /// A kept record, running or finished.
    pub(crate) fn record(&self, seq: u64) -> Option<&InvocationRecord> {
        self.in_flight.get(&seq).or_else(|| self.finished.get(seq))
    }

    /// Drops the indexes of records that left the store.
    pub(crate) fn forget(&mut self, evicted: &[InvocationRecord]) {
        for record in evicted {
            if let Some(key) = &record.event_key
                && self.by_event.get(key) == Some(&record.summary.seq)
            {
                self.by_event.remove(key);
            }
            if let Some(key) = &record.task_key
                && self.by_task.get(key) == Some(&record.summary.seq)
            {
                self.by_task.remove(key);
            }
        }
    }
}

/// The index key of a Cloud Tasks attempt.
pub(crate) fn task_key(queue: &str, task: &str, retry_count: u32) -> String {
    format!("{queue}\u{0}{task}\u{0}{retry_count}")
}

/// One codebase and its load log.
pub(crate) struct CodebaseState {
    pub(crate) codebase: FunctionCodebase,
    pub(crate) load_log: VecDeque<FunctionLogLine>,
    pub(crate) next_line: u32,
    /// A worker reached `running` once, so the next start is a restart.
    pub(crate) started_once: bool,
}

/// The request as recorded.
pub(crate) struct RequestRecord {
    pub(crate) target: InvocationTarget,
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) headers: HeaderMap,
    pub(crate) content_type: Option<String>,
    /// The whole body, or a copy of its first `body_bytes`.
    pub(crate) body: Bytes,
    pub(crate) size: u64,
}

impl RequestRecord {
    pub(crate) fn retained(&self) -> usize {
        self.body.len() + header_bytes(&self.headers) + self.method.len() + self.path.len()
    }
}

/// The response as recorded.
pub(crate) struct ResponseRecord {
    pub(crate) status: u16,
    pub(crate) headers: HeaderMap,
    pub(crate) content_type: Option<String>,
    /// The first `body_bytes` of the body, appended chunk by chunk.
    pub(crate) body: Vec<u8>,
    pub(crate) size: u64,
    pub(crate) chunks: u32,
    pub(crate) client_gone: bool,
    /// The answer declared its length (so it was not streamed).
    pub(crate) has_length: bool,
}

impl ResponseRecord {
    pub(crate) fn retained(&self) -> usize {
        self.body.capacity() + header_bytes(&self.headers)
    }

    /// Text/event-stream, or a body that arrived in several chunks with no
    /// declared length.
    pub(crate) fn streaming(&self) -> bool {
        self.content_type
            .as_deref()
            .is_some_and(|value| value.contains("text/event-stream"))
            || (!self.has_length && self.chunks > 1)
    }
}

pub(crate) fn header_bytes(headers: &HeaderMap) -> usize {
    headers
        .iter()
        .map(|(name, value)| name.as_str().len() + value.len() + HEADER_OVERHEAD)
        .sum()
}

/// One invocation, running or finished.
pub(crate) struct InvocationRecord {
    pub(crate) summary: InvocationSummary,
    pub(crate) started: Instant,
    pub(crate) started_at: SystemTime,
    pub(crate) finished_at: Option<SystemTime>,
    /// `None` when only the summary is kept (too many running at once).
    pub(crate) request: Option<RequestRecord>,
    pub(crate) response: Option<ResponseRecord>,
    pub(crate) logs: Vec<FunctionLogLine>,
    pub(crate) log_bytes: usize,
    pub(crate) logs_dropped: u32,
    /// The one "not kept" line was written.
    pub(crate) logs_capped: bool,
    pub(crate) timings: InvocationTimings,
    pub(crate) event_key: Option<Arc<str>>,
    pub(crate) task_key: Option<String>,
    /// The Eventarc event and the delivery slot this invocation fulfils.
    pub(crate) delivery: Option<(u64, usize)>,
    /// Why a crash would happen: the console restarted the worker.
    pub(crate) interrupted: Option<String>,
    /// Retained bytes, as counted in the budget.
    pub(crate) retained: usize,
}

impl InvocationRecord {
    pub(crate) fn full(&self) -> bool {
        self.request.is_some()
    }
}

/// Finished records, one queue per [`FunctionKind`] ordered by seq, bounded
/// by count and retained bytes, oldest out, the newest `kind_floor` of each
/// kind kept from eviction by other kinds.
#[derive(Default)]
pub(crate) struct FinishedStore {
    queues: [BTreeMap<u64, InvocationRecord>; FunctionKind::ALL.len()],
    kinds: HashMap<u64, usize>,
    count: usize,
    pub(crate) retained: usize,
    /// Per kind, the start of the newest record let go (`kept_after`).
    pub(crate) dropped_before: [Option<SystemTime>; FunctionKind::ALL.len()],
}

pub(crate) fn kind_index(kind: FunctionKind) -> usize {
    FunctionKind::ALL
        .iter()
        .position(|candidate| *candidate == kind)
        .unwrap_or(FunctionKind::ALL.len() - 1)
}

impl FinishedStore {
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.count
    }

    pub(crate) fn get(&self, seq: u64) -> Option<&InvocationRecord> {
        let queue = *self.kinds.get(&seq)?;
        self.queues[queue].get(&seq)
    }

    pub(crate) fn get_mut(&mut self, seq: u64) -> Option<&mut InvocationRecord> {
        let queue = *self.kinds.get(&seq)?;
        self.queues[queue].get_mut(&seq)
    }

    /// Adjusts the retained total after a kept record grew (a late line).
    pub(crate) fn grew(&mut self, bytes: usize) {
        self.retained += bytes;
    }

    pub(crate) fn insert(&mut self, record: InvocationRecord) {
        let queue = kind_index(record.summary.kind);
        let seq = record.summary.seq;
        self.retained += record.retained;
        self.count += 1;
        self.kinds.insert(seq, queue);
        self.queues[queue].insert(seq, record);
    }

    /// Evicts the oldest records while the count or the retained bytes
    /// (with `in_flight_bytes`) are over their limits. The count respects
    /// each kind's floor; the byte budget does not, so memory stays bounded
    /// when every kind sits at its floor. Constant work per eviction.
    pub(crate) fn evict(
        &mut self,
        limits: &MonitorLimits,
        in_flight_bytes: usize,
    ) -> Vec<InvocationRecord> {
        let mut evicted = Vec::new();
        loop {
            let over_count = self.count > limits.invocations;
            let over_bytes = self.retained + in_flight_bytes > limits.invocation_bytes;
            if !over_count && !over_bytes {
                break;
            }
            let heads = || {
                self.queues.iter().enumerate().filter_map(|(index, queue)| {
                    queue
                        .first_key_value()
                        .map(|(seq, _)| (*seq, index, queue.len()))
                })
            };
            let candidate = heads()
                .filter(|(_, _, len)| *len > limits.kind_floor)
                .min()
                .or_else(|| if over_bytes { heads().min() } else { None });
            let Some((seq, queue, _)) = candidate else {
                break;
            };
            if let Some(record) = self.queues[queue].remove(&seq) {
                self.take_out(&record, queue);
                evicted.push(record);
            }
        }
        evicted
    }

    fn take_out(&mut self, record: &InvocationRecord, queue: usize) {
        self.kinds.remove(&record.summary.seq);
        self.count -= 1;
        self.retained = self.retained.saturating_sub(record.retained);
        let started = record.started_at;
        let slot = &mut self.dropped_before[queue];
        if slot.is_none_or(|current| current < started) {
            *slot = Some(started);
        }
    }

    /// Drops every record (the console's "Clear history"); each kind that
    /// held one now reads as let go at `at`.
    pub(crate) fn clear(&mut self, at: SystemTime) -> Vec<InvocationRecord> {
        let mut removed = Vec::with_capacity(self.count);
        for (index, queue) in self.queues.iter_mut().enumerate() {
            if !queue.is_empty() {
                self.dropped_before[index] = Some(at);
            }
            removed.extend(std::mem::take(queue).into_values());
        }
        self.kinds.clear();
        self.count = 0;
        self.retained = 0;
        removed
    }

    /// Every record, in no particular order.
    pub(crate) fn iter(&self) -> impl Iterator<Item = &InvocationRecord> {
        self.queues.iter().flat_map(BTreeMap::values)
    }
}

/// A function's counters and its recent durations.
#[derive(Default)]
pub(crate) struct StatsState {
    pub(crate) runs: u64,
    pub(crate) failures: u64,
    pub(crate) in_flight: u32,
    pub(crate) last: Option<InvocationSummary>,
    pub(crate) durations: VecDeque<f64>,
    pub(crate) p50: Option<f64>,
    pub(crate) p95: Option<f64>,
}

impl StatsState {
    pub(crate) fn record_duration(&mut self, duration_ms: f64, keep: usize) {
        if keep == 0 {
            return;
        }
        while self.durations.len() >= keep {
            self.durations.pop_front();
        }
        self.durations.push_back(duration_ms);
        let mut sorted: Vec<f64> = self.durations.iter().copied().collect();
        self.p50 = percentile(&mut sorted, 50);
        self.p95 = percentile(&mut sorted, 95);
    }

    pub(crate) fn snapshot(&self) -> FunctionStats {
        FunctionStats {
            runs: self.runs,
            failures: self.failures,
            in_flight: self.in_flight,
            last: self.last.clone(),
            p50_ms: self.p50,
            p95_ms: self.p95,
        }
    }
}

/// The nearest-rank percentile of `values` (reordered in place).
fn percentile(values: &mut [f64], percent: usize) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let rank = (values.len() * percent).div_ceil(100).max(1) - 1;
    let (_, value, _) = values.select_nth_unstable_by(rank, f64::total_cmp);
    Some(*value)
}

/// One Eventarc event as kept.
pub(crate) struct EventRecord {
    pub(crate) summary: EventarcEventSummary,
    pub(crate) attributes: BTreeMap<String, String>,
    pub(crate) datacontenttype: Option<String>,
    pub(crate) time: Option<String>,
    pub(crate) data: serde_json::Value,
    pub(crate) data_size: u64,
    pub(crate) data_truncated: bool,
    pub(crate) raw: serde_json::Value,
    pub(crate) deliveries: Vec<EventarcDelivery>,
    pub(crate) replay_of: Option<String>,
    pub(crate) retained: usize,
}

/// Kept Eventarc events in arrival (seq) order, bounded by count and bytes.
#[derive(Default)]
pub(crate) struct EventStore {
    pub(crate) events: VecDeque<EventRecord>,
    pub(crate) retained: usize,
}

impl EventStore {
    pub(crate) fn get(&self, seq: u64) -> Option<&EventRecord> {
        let index = self
            .events
            .binary_search_by_key(&seq, |event| event.summary.seq)
            .ok()?;
        self.events.get(index)
    }

    pub(crate) fn get_mut(&mut self, seq: u64) -> Option<&mut EventRecord> {
        let index = self
            .events
            .binary_search_by_key(&seq, |event| event.summary.seq)
            .ok()?;
        self.events.get_mut(index)
    }

    pub(crate) fn push(&mut self, event: EventRecord, limits: &MonitorLimits) {
        self.retained += event.retained;
        self.events.push_back(event);
        while self.events.len() > limits.events
            || (self.retained > limits.event_bytes && self.events.len() > 1)
        {
            if let Some(gone) = self.events.pop_front() {
                self.retained = self.retained.saturating_sub(gone.retained);
            }
        }
    }

    pub(crate) fn clear(&mut self) {
        self.events.clear();
        self.retained = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitor::types::{InvocationCause, InvocationOrigin, InvocationOutcomeClass};

    fn record(seq: u64, kind: FunctionKind, bytes: usize) -> InvocationRecord {
        InvocationRecord {
            summary: InvocationSummary {
                id: format!("abcdef-{seq}"),
                seq,
                function_id: "us-central1-f".to_owned(),
                codebase: "default".to_owned(),
                kind,
                origin: InvocationOrigin::Emulator,
                cause: InvocationCause::Unknown,
                summary: String::new(),
                started_at: String::new(),
                duration_ms: Some(1.0),
                outcome: None,
                outcome_class: InvocationOutcomeClass::Succeeded,
                status: None,
                callable_status: None,
                cold: false,
                attempt: 1,
                event_id: None,
                replay_of: None,
                log_count: 0,
                error: None,
            },
            started: Instant::now(),
            started_at: SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(seq),
            finished_at: None,
            request: None,
            response: None,
            logs: Vec::new(),
            log_bytes: 0,
            logs_dropped: 0,
            logs_capped: false,
            timings: InvocationTimings::default(),
            event_key: None,
            task_key: None,
            delivery: None,
            interrupted: None,
            retained: bytes,
        }
    }

    fn limits(invocations: usize, floor: usize, bytes: usize) -> MonitorLimits {
        MonitorLimits {
            invocations,
            kind_floor: floor,
            invocation_bytes: bytes,
            ..MonitorLimits::default()
        }
    }

    #[test]
    fn count_eviction_takes_the_oldest_first() {
        let limits = limits(3, 0, usize::MAX);
        let mut store = FinishedStore::default();
        let mut evicted = Vec::new();
        for seq in [2, 1, 4, 3, 5] {
            store.insert(record(seq, FunctionKind::Http, 10));
            evicted.extend(
                store
                    .evict(&limits, 0)
                    .into_iter()
                    .map(|record| record.summary.seq),
            );
        }
        assert_eq!(evicted, [1, 2]);
        assert_eq!(store.len(), 3);
        assert!(store.get(3).is_some() && store.get(1).is_none());
        assert_eq!(
            store.dropped_before[kind_index(FunctionKind::Http)],
            Some(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(2))
        );
    }

    #[test]
    fn the_kind_floor_keeps_quiet_kinds_from_a_busy_one() {
        let limits = limits(400, 200, usize::MAX);
        let mut store = FinishedStore::default();
        let mut seq = 0;
        for _ in 0..200 {
            seq += 1;
            store.insert(record(seq, FunctionKind::Pubsub, 10));
        }
        for _ in 0..2_500 {
            seq += 1;
            store.insert(record(seq, FunctionKind::Firestore, 10));
            let _ = store.evict(&limits, 0);
        }
        let pubsub = store
            .iter()
            .filter(|record| record.summary.kind == FunctionKind::Pubsub)
            .count();
        let firestore = store
            .iter()
            .filter(|record| record.summary.kind == FunctionKind::Firestore)
            .count();
        assert_eq!(pubsub, 200);
        assert_eq!(firestore, 200);
        assert_eq!(store.dropped_before[kind_index(FunctionKind::Pubsub)], None);
    }

    #[test]
    fn the_floor_yields_to_the_byte_budget() {
        let limits = limits(10_000, 200, 1_000);
        let mut store = FinishedStore::default();
        for seq in 1..=50 {
            store.insert(record(seq, FunctionKind::Pubsub, 100));
            let _ = store.evict(&limits, 0);
        }
        assert!(store.retained <= 1_000, "{}", store.retained);
        assert_eq!(store.len(), 10);
        // Running records count against the same budget.
        let evicted = store.evict(&limits, 500);
        assert_eq!(evicted.len(), 5);
    }

    #[test]
    fn percentiles_use_the_nearest_rank() {
        let mut stats = StatsState::default();
        for duration in 1..=100 {
            stats.record_duration(f64::from(duration), 256);
        }
        assert_eq!(stats.p50, Some(50.0));
        assert_eq!(stats.p95, Some(95.0));
        for _ in 0..300 {
            stats.record_duration(7.0, 256);
        }
        assert_eq!(stats.durations.len(), 256);
        assert_eq!(stats.p95, Some(7.0));
    }

    #[test]
    fn events_are_bounded_by_count_and_bytes() {
        let limits = MonitorLimits {
            events: 3,
            event_bytes: 250,
            ..MonitorLimits::default()
        };
        let mut store = EventStore::default();
        for seq in 1..=5 {
            store.push(
                EventRecord {
                    summary: EventarcEventSummary {
                        id: format!("abcdef-{seq}"),
                        seq,
                        event_id: None,
                        received_at: String::new(),
                        channel: "google".to_owned(),
                        event_type: "a".to_owned(),
                        source: None,
                        subject: None,
                        publisher: None,
                        origin: super::super::types::EventarcOrigin::App,
                        matched: 0,
                        delivered: 0,
                        failed: 0,
                        pending: 0,
                        filtered: 0,
                        unheard: true,
                        error: None,
                    },
                    attributes: BTreeMap::new(),
                    datacontenttype: None,
                    time: None,
                    data: serde_json::Value::Null,
                    data_size: 0,
                    data_truncated: false,
                    raw: serde_json::Value::Null,
                    deliveries: Vec::new(),
                    replay_of: None,
                    retained: 100,
                },
                &limits,
            );
        }
        let kept: Vec<u64> = store.events.iter().map(|event| event.summary.seq).collect();
        assert_eq!(kept, [4, 5]);
        assert!(store.get(5).is_some() && store.get(3).is_none());
    }
}
