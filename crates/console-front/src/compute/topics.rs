//! Compute's live topics on the console's one channel.
//!
//! - `functions.events` `{ function?, codebase?, q?, changesOnly? }` →
//!   `batch` ([`FunctionsLiveBatch`]): invocation rows, codebase and
//!   inventory changes and absolute stats, one window per 100 ms, replayed
//!   from the "functions" ring after the subscriber's cursor;
//! - `functions.invocation` `{ id }` → `snapshot`, then `log` / `chunk`
//!   arrays from the invocation's own record, then `finished` and the end;
//! - `functions.codebase-log` `{ codebase }` → `lines` of a codebase's
//!   load log;
//! - `eventarc.events` `{ channel?, q? }` → `batch` ([`EventarcLiveBatch`]);
//! - `extensions.changes` `{}` → `changed` ([`ExtensionsChanged`]) keys.
//!
//! Every feed goes through the foundation's `replay_topic`; compute adds
//! only filters and shapers. Patches are idempotent (absolute stats, rows
//! upserted by id), so a replay after a reconnect cannot double-count.

use std::collections::hash_map::Entry as Slot;
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::hash::Hash;
use std::sync::Arc;

use firenook_functions_runtime::Monitor;
use firenook_functions_runtime::monitor::{
    FunctionRegistryDiff, FunctionStats, InvocationOutcomeClass, InvocationSummary,
};
use firenook_suite_front::Entry;
use futures_util::StreamExt as _;
use futures_util::stream;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::Instant;
use ts_rs::TS;

use super::ComputeState;
use super::extensions::ExtensionsChanged;
use super::filters::{event_filter, invocation_filter};
use super::functions::{FunctionCodebaseEntry, invocation_view, kept};
use super::live::{ComputeLive, EventarcMeta, FunctionsMeta};
use crate::api_error::{ApiError, ApiErrorDetail};
use crate::live::replay::{MAX_ITEMS, ReplayOptions, WINDOW, replay_topic};
use crate::live::{LiveTopic, ResetReason, TopicEvent, TopicStream, topic_params};

/// Invocation rows (or events) one window sends at most; the rest are
/// counted in `burst`.
pub(crate) const WINDOW_ROWS: usize = 50;
/// Keys one window of `extensions.changes` holds before it resets instead.
const MAX_KEYS: usize = 1_000;

/// One 100 ms window of `functions.events` for one subscriber.
#[allow(
    dead_code,
    reason = "windows are written by joining entries serialized at push time; the type is their TypeScript contract"
)]
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionsLiveBatch {
    /// Invocation rows, newest last. A start and its finish in the same
    /// window arrive as one row (the finished one).
    pub(crate) items: Vec<InvocationSummary>,
    /// Inventory and codebase changes, in order.
    pub(crate) changes: Vec<FunctionsLiveChange>,
    /// The absolute stats, after this window, of every function an
    /// invocation in it touched, including invocations cut by `burst`.
    pub(crate) stats: Vec<FunctionStatsEntry>,
    /// How many more invocation rows matched this window than were sent.
    pub(crate) burst: Option<u32>,
}

/// One function's absolute stats.
#[allow(
    dead_code,
    reason = "windows are written by joining entries serialized at push time; the type is their TypeScript contract"
)]
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionStatsEntry {
    pub(crate) function_id: String,
    pub(crate) stats: FunctionStats,
}

/// A change to the Functions inventory.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export_to = "compute/")]
pub(crate) enum FunctionsLiveChange {
    /// Load state, worker state and stale flags of one codebase, whole.
    Codebase {
        codebase: Box<FunctionCodebaseEntry>,
    },
    /// A completed load (every one, even when the diff is empty).
    Inventory {
        codebase: String,
        diff: FunctionRegistryDiff,
        loads: u32,
    },
}

/// One 100 ms window of `eventarc.events` for one subscriber.
#[allow(
    dead_code,
    reason = "windows are written by joining entries serialized at push time; the type is their TypeScript contract"
)]
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct EventarcLiveBatch {
    /// Event summaries, newest last; a later delivery's update replaces
    /// the event's row in the window.
    pub(crate) items: Vec<firenook_functions_runtime::monitor::EventarcEventSummary>,
    /// How many more events matched this window than were sent.
    pub(crate) burst: Option<u32>,
}

/// Every compute topic.
pub(crate) fn all(state: &ComputeState) -> Vec<Arc<dyn LiveTopic>> {
    vec![
        Arc::new(FunctionsEvents {
            live: Arc::clone(&state.live),
        }),
        Arc::new(Invocation {
            state: state.clone(),
        }),
        Arc::new(CodebaseLog {
            live: Arc::clone(&state.live),
            monitor: state.monitor().clone(),
        }),
        Arc::new(EventarcEvents {
            live: Arc::clone(&state.live),
        }),
        Arc::new(ExtensionsChanges {
            live: Arc::clone(&state.live),
        }),
    ]
}

// ── functions.events ─────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FunctionsEventsParams {
    function: Option<String>,
    codebase: Option<String>,
    q: Option<String>,
    #[serde(default)]
    changes_only: bool,
}

struct FunctionsEvents {
    live: Arc<ComputeLive>,
}

impl LiveTopic for FunctionsEvents {
    fn name(&self) -> &'static str {
        "functions.events"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: FunctionsEventsParams = topic_params(params)?;
        let q = invocation_filter(params.q.as_deref().unwrap_or_default())?;
        let FunctionsEventsParams {
            function,
            codebase,
            changes_only,
            ..
        } = params;
        let filter = move |meta: &FunctionsMeta| match meta {
            FunctionsMeta::Invocation(row) => {
                !changes_only
                    && function
                        .as_deref()
                        .is_none_or(|function| row.summary.function_id == function)
                    && codebase
                        .as_deref()
                        .is_none_or(|codebase| row.summary.codebase == codebase)
                    && q.as_ref().is_none_or(|keep| keep(&row.summary))
            }
            // A function's page keeps every codebase's changes: the snapshot
            // it patches is the whole project's.
            FunctionsMeta::Codebase(id) | FunctionsMeta::Inventory(id) => codebase
                .as_deref()
                .is_none_or(|codebase| id.as_ref() == codebase),
            FunctionsMeta::LoadLine(_) => false,
        };
        Ok(replay_topic(
            &self.live.functions,
            after,
            "batch",
            ReplayOptions {
                filter: Some(Arc::new(filter)),
                shape: Some(Box::new(shape_functions)),
                max_items: MAX_ITEMS,
                ..ReplayOptions::default()
            },
        ))
    }
}

/// One window of kept "functions" entries as a `FunctionsLiveBatch`, from
/// the entries' JSON: a row's finish replaces its start, only the newest
/// state of a codebase is kept, the newest 50 rows are sent and the rest
/// counted, and the stats of every function a row touched ride along.
pub(crate) fn shape_functions(entries: &[Entry<FunctionsMeta>]) -> Option<Arc<str>> {
    let mut rows: Vec<&str> = Vec::new();
    let mut row_at: HashMap<u64, usize> = HashMap::new();
    let mut stats: Vec<&str> = Vec::new();
    let mut stats_at: HashMap<&str, usize> = HashMap::new();
    let mut changes: Vec<Option<&str>> = Vec::new();
    let mut codebase_at: HashMap<&str, usize> = HashMap::new();
    for entry in entries {
        match &entry.meta {
            FunctionsMeta::Invocation(row) => {
                upsert(&mut rows, &mut row_at, row.summary.seq, &entry.json);
                upsert(
                    &mut stats,
                    &mut stats_at,
                    &row.summary.function_id,
                    &row.stats,
                );
            }
            FunctionsMeta::Codebase(id) => {
                if let Some(index) = codebase_at.insert(id, changes.len()) {
                    changes[index] = None;
                }
                changes.push(Some(&entry.json));
            }
            FunctionsMeta::Inventory(_) => changes.push(Some(&entry.json)),
            FunctionsMeta::LoadLine(_) => {}
        }
    }
    let changes: Vec<&str> = changes.into_iter().flatten().collect();
    if rows.is_empty() && changes.is_empty() && stats.is_empty() {
        return None;
    }
    let burst = rows.len().saturating_sub(WINDOW_ROWS);
    let rows = &rows[burst..];
    let mut data = String::with_capacity(
        rows.iter()
            .chain(&changes)
            .chain(&stats)
            .map(|json| json.len() + 1)
            .sum::<usize>()
            + 64,
    );
    data.push_str("{\"items\":");
    join(&mut data, rows);
    data.push_str(",\"changes\":");
    join(&mut data, &changes);
    data.push_str(",\"stats\":");
    join(&mut data, &stats);
    data.push_str(",\"burst\":");
    if burst == 0 {
        data.push_str("null");
    } else {
        data.push_str(&burst.to_string());
    }
    data.push('}');
    Some(Arc::from(data))
}

/// Puts `item` at `key`'s place in `items`, or appends it there.
fn upsert<'a, K: Hash + Eq>(
    items: &mut Vec<&'a str>,
    at: &mut HashMap<K, usize>,
    key: K,
    item: &'a str,
) {
    match at.entry(key) {
        Slot::Occupied(slot) => items[*slot.get()] = item,
        Slot::Vacant(slot) => {
            slot.insert(items.len());
            items.push(item);
        }
    }
}

/// `[a,b,c]` from JSON fragments.
fn join(data: &mut String, items: &[&str]) {
    data.push('[');
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            data.push(',');
        }
        data.push_str(item);
    }
    data.push(']');
}

// ── functions.invocation ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InvocationParams {
    id: String,
}

struct Invocation {
    state: ComputeState,
}

impl LiveTopic for Invocation {
    fn name(&self) -> &'static str {
        "functions.invocation"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        _after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let InvocationParams { id } = topic_params(params)?;
        let monitor = self.state.monitor().clone();
        if !kept(&monitor, &id) {
            return Err(not_kept(&monitor, &id));
        }
        // Subscribed before the snapshot is read, so no change is lost
        // between them (one already in the snapshot reads as nothing new).
        let touched = monitor.touched();
        let follow = Follow {
            state: self.state.clone(),
            id: Arc::from(id),
            touched,
            lines: 0,
            bytes: 0,
            started: false,
            ended: false,
            last_sent: None,
            outbox: VecDeque::new(),
        };
        Ok(stream::unfold(follow, |mut follow| async move {
            follow.next().await.map(|event| (event, follow))
        })
        .boxed())
    }
}

/// The 404 for an invocation the engine does not keep.
pub(crate) fn not_kept(monitor: &Monitor, id: &str) -> ApiError {
    let number = id
        .rsplit_once('-')
        .and_then(|(_, seq)| seq.parse::<u64>().ok())
        .map_or_else(|| id.to_owned(), |seq| format!("#{}", super::grouped(seq)));
    ApiError::not_found(format!(
        "The engine no longer keeps invocation {number}; it keeps the newest {}.",
        super::grouped(monitor.limits().invocations as u64)
    ))
}

/// One subscriber's place in one invocation's record.
struct Follow {
    state: ComputeState,
    id: Arc<str>,
    touched: broadcast::Receiver<Arc<str>>,
    lines: u32,
    bytes: u64,
    started: bool,
    ended: bool,
    last_sent: Option<Instant>,
    outbox: VecDeque<TopicEvent>,
}

impl Follow {
    async fn next(&mut self) -> Option<TopicEvent> {
        loop {
            if let Some(event) = self.outbox.pop_front() {
                return Some(event);
            }
            if self.ended {
                return None;
            }
            if !self.started {
                self.started = true;
                self.snapshot().await;
                continue;
            }
            if !self.wait_for_touch().await {
                return None;
            }
            // At most one `log` and one `chunk` per window.
            if let Some(last) = self.last_sent {
                tokio::time::sleep_until(last + WINDOW).await;
            }
            self.read_progress();
        }
    }

    async fn snapshot(&mut self) {
        let monitor = self.state.monitor().clone();
        let Some(detail) = monitor.invocation(&self.id) else {
            self.end_gone(&monitor);
            return;
        };
        let (lines, bytes) = detail
            .live_cursor
            .split_once('.')
            .and_then(|(lines, bytes)| Some((lines.parse().ok()?, bytes.parse().ok()?)))
            .unwrap_or_default();
        self.lines = lines;
        self.bytes = bytes;
        let finished = (detail.summary.outcome_class != InvocationOutcomeClass::Running)
            .then(|| detail.summary.clone());
        let view = invocation_view(&self.state, detail).await;
        self.outbox
            .push_back(TopicEvent::json("snapshot", None, &view));
        self.last_sent = Some(Instant::now());
        if let Some(summary) = finished {
            self.finish(&summary);
        }
    }

    /// Waits until this invocation changes (or the broadcast lagged, which
    /// may have hidden one); `false` when the monitor is gone.
    async fn wait_for_touch(&mut self) -> bool {
        loop {
            match self.touched.recv().await {
                Ok(id) if *id == *self.id => return true,
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => return true,
                Err(RecvError::Closed) => return false,
            }
        }
    }

    fn read_progress(&mut self) {
        let monitor = self.state.monitor().clone();
        let Some(progress) = monitor.invocation_since(&self.id, self.lines, self.bytes) else {
            self.end_gone(&monitor);
            return;
        };
        if !progress.lines.is_empty() {
            self.outbox
                .push_back(TopicEvent::json("log", None, &progress.lines));
        }
        if !progress.chunks.is_empty() {
            self.outbox
                .push_back(TopicEvent::json("chunk", None, &progress.chunks));
        }
        self.lines = progress.next_line;
        self.bytes = progress.next_byte;
        if !self.outbox.is_empty() {
            self.last_sent = Some(Instant::now());
        }
        if let Some(summary) = progress.finished {
            self.finish(&summary);
        }
    }

    fn finish(&mut self, summary: &InvocationSummary) {
        self.outbox
            .push_back(TopicEvent::json("finished", None, summary));
        self.outbox.push_back(TopicEvent::End(None));
        self.ended = true;
    }

    fn end_gone(&mut self, monitor: &Monitor) {
        let error: ApiErrorDetail = not_kept(monitor, &self.id).detail().clone();
        self.outbox.push_back(TopicEvent::End(Some(error)));
        self.ended = true;
    }
}

// ── functions.codebase-log ───────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CodebaseLogParams {
    codebase: String,
}

struct CodebaseLog {
    live: Arc<ComputeLive>,
    monitor: Monitor,
}

impl LiveTopic for CodebaseLog {
    fn name(&self) -> &'static str {
        "functions.codebase-log"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let CodebaseLogParams { codebase } = topic_params(params)?;
        if self.monitor.codebase(&codebase).is_none() {
            return Err(ApiError::not_found(format!(
                "There is no codebase {codebase}."
            )));
        }
        let codebase: Arc<str> = Arc::from(codebase);
        Ok(replay_topic(
            &self.live.functions,
            after,
            "lines",
            ReplayOptions {
                filter: Some(Arc::new(
                    move |meta: &FunctionsMeta| matches!(meta, FunctionsMeta::LoadLine(id) if *id == codebase),
                )),
                ..ReplayOptions::default()
            },
        ))
    }
}

// ── eventarc.events ──────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventarcEventsParams {
    channel: Option<String>,
    q: Option<String>,
}

struct EventarcEvents {
    live: Arc<ComputeLive>,
}

impl LiveTopic for EventarcEvents {
    fn name(&self) -> &'static str {
        "eventarc.events"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let EventarcEventsParams { channel, q } = topic_params(params)?;
        let q = event_filter(q.as_deref().unwrap_or_default())?;
        let filter = move |meta: &EventarcMeta| {
            channel
                .as_deref()
                .is_none_or(|channel| meta.0.channel == channel)
                && q.as_ref().is_none_or(|keep| keep(&meta.0))
        };
        Ok(replay_topic(
            &self.live.eventarc,
            after,
            "batch",
            ReplayOptions {
                filter: Some(Arc::new(filter)),
                shape: Some(Box::new(shape_events)),
                max_items: MAX_ITEMS,
                ..ReplayOptions::default()
            },
        ))
    }
}

/// One window of kept event summaries as an `EventarcLiveBatch`: an
/// event's newest summary replaces its earlier one, the newest 50 are sent
/// and the rest counted.
pub(crate) fn shape_events(entries: &[Entry<EventarcMeta>]) -> Option<Arc<str>> {
    let mut rows: Vec<&str> = Vec::new();
    let mut row_at: HashMap<u64, usize> = HashMap::new();
    for entry in entries {
        upsert(&mut rows, &mut row_at, entry.meta.0.seq, &entry.json);
    }
    if rows.is_empty() {
        return None;
    }
    let burst = rows.len().saturating_sub(WINDOW_ROWS);
    let mut data = String::with_capacity(rows.iter().map(|row| row.len() + 1).sum::<usize>() + 32);
    data.push_str("{\"items\":");
    join(&mut data, &rows[burst..]);
    data.push_str(",\"burst\":");
    if burst == 0 {
        data.push_str("null");
    } else {
        data.push_str(&burst.to_string());
    }
    data.push('}');
    Some(Arc::from(data))
}

// ── extensions.changes ───────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct NoParams {}

struct ExtensionsChanges {
    live: Arc<ComputeLive>,
}

impl LiveTopic for ExtensionsChanges {
    fn name(&self) -> &'static str {
        "extensions.changes"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        _after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let NoParams {} = topic_params(params)?;
        let receiver = self.live.extensions.subscribe();
        Ok(stream::unfold(receiver, |mut receiver| async move {
            changed_window(&mut receiver)
                .await
                .map(|event| (event, receiver))
        })
        .boxed())
    }
}

/// The next window of extension changes: the instance ids that changed in
/// the 100 ms after the first one, deduplicated; a `reset` when more than
/// 1,000 changed or the subscriber fell behind.
async fn changed_window(receiver: &mut broadcast::Receiver<Arc<str>>) -> Option<TopicEvent> {
    let lagged = || TopicEvent::Reset {
        reason: ResetReason::Lagged,
        missed: None,
    };
    let first = match receiver.recv().await {
        Ok(id) => id,
        Err(RecvError::Lagged(_)) => return Some(lagged()),
        Err(RecvError::Closed) => return None,
    };
    let mut ids = BTreeSet::from([first.to_string()]);
    let deadline = Instant::now() + WINDOW;
    loop {
        match tokio::time::timeout_at(deadline, receiver.recv()).await {
            Ok(Ok(id)) => {
                ids.insert(id.to_string());
                if ids.len() > MAX_KEYS {
                    return Some(lagged());
                }
            }
            Ok(Err(RecvError::Lagged(_))) => return Some(lagged()),
            Ok(Err(RecvError::Closed)) | Err(_) => break,
        }
    }
    Some(TopicEvent::json(
        "changed",
        None,
        &ExtensionsChanged {
            instance_ids: ids.into_iter().collect(),
        },
    ))
}

#[cfg(test)]
#[path = "topics_tests.rs"]
mod tests;
