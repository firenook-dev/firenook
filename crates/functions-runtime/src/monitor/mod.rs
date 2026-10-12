//! The monitor: the runtime's record of everything the console shows live.
//!
//! It keeps each codebase's loads, worker and load log, every invocation with
//! its request, response, lines and outcome, per-function counters, and every
//! Eventarc event with what each subscription did with it. Everything is
//! bounded by [`MonitorLimits`]; the state sits behind one mutex held for
//! microseconds and never across an await. The suite creates the monitor
//! before Functions start and hands it to both the runtime (which feeds it)
//! and the console (which reads it and installs a [`LiveSink`]), so startup is
//! visible live.
//!
//! Other sections read it too: messaging joins its Pub/Sub fanout and Cloud
//! Tasks attempts to invocations through [`Monitor::by_event_id`] and
//! [`Monitor::by_task`], and tells a delivery still queued from one no longer
//! kept with [`Monitor::kept_after`].
//!
//! Ids are `"{nonce}-{seq}"` (`a3f9c1-1284`): the nonce is chosen when the
//! monitor is created, so an id from an earlier engine start is never
//! mistaken for a current one; such an id reads as not kept.

pub mod cause;
pub mod outcome;
mod store;
pub mod structured;
pub mod types;

use std::collections::BTreeMap;
use std::fmt;
use std::hash::{BuildHasher, Hasher, RandomState};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::http::{HeaderMap, header};
use base64::Engine as _;
use serde_json::Value;
use tokio::sync::broadcast;

use crate::log::LogEvent;
use store::{
    CodebaseState, EventRecord, InvocationRecord, LINE_OVERHEAD, RECORD_OVERHEAD, RequestRecord,
    ResponseRecord, State, kind_index, task_key,
};
pub use types::{
    EventarcDelivery, EventarcEventDetail, EventarcEventSummary, EventarcFilterMismatch,
    EventarcOrigin, FunctionBody, FunctionBodyEncoding, FunctionCodebase, FunctionCodebaseKind,
    FunctionHeader, FunctionKind, FunctionLoadError, FunctionLoadState, FunctionLogLevel,
    FunctionLogLine, FunctionNotLoaded, FunctionRegistryDiff, FunctionRequest, FunctionResponse,
    FunctionResponseChunk, FunctionStale, FunctionStats, FunctionWorker, FunctionWorkerState,
    FunctionsPhase, InvocationCause, InvocationDetail, InvocationOrigin, InvocationOutcome,
    InvocationOutcomeClass, InvocationSummary, InvocationTarget, InvocationTimings, MonitorEvent,
    format_timestamp,
};

/// Request headers whose values never leave the engine in a list or a
/// detail; the console's reveal route reads them one at a time.
pub const SENSITIVE_HEADERS: [&str; 5] = [
    "authorization",
    "cookie",
    "proxy-authorization",
    "x-firebase-appcheck",
    "x-api-key",
];

/// The kind of the one line the monitor writes when an invocation's lines
/// pass their caps.
pub const LINES_NOT_KEPT: &str = "monitor.notKept";

/// The kind of the worker line that carries a handler's error.
pub const FUNCTION_ERROR: &str = "function.error";

/// The runtime's own lines about an invocation's lifecycle. They go to the
/// Logs section (and the terminal), never into the invocation's own lines.
pub const LIFECYCLE_KINDS: [&str; 7] = [
    "function.start",
    "function.finish",
    "function.failed",
    "function.timeout",
    "function.crashed",
    "function.unknown",
    "worker.failed",
];

/// Bounds for everything the monitor keeps. Defaults are the release values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MonitorLimits {
    /// Finished invocation records kept (2,000).
    pub invocations: usize,
    /// The newest finished records of each [`FunctionKind`] kept from
    /// eviction by other kinds (200), so a busy trigger cannot empty another
    /// kind's history. It yields to the byte budget.
    pub kind_floor: usize,
    /// Bytes across kept bodies, headers and logs, counted as retained
    /// capacity (64 MiB).
    pub invocation_bytes: usize,
    /// Bytes kept per request body and per response body (256 KiB).
    pub body_bytes: usize,
    /// Log lines kept per invocation (1,000).
    pub log_lines: usize,
    /// Log bytes kept per invocation (256 KiB).
    pub log_bytes: usize,
    /// Load-log lines kept per codebase (200).
    pub load_log_lines: usize,
    /// Durations kept per function for p50 and p95 (256).
    pub durations: usize,
    /// Eventarc events kept (1,000).
    pub events: usize,
    /// Bytes across kept Eventarc events (16 MiB).
    pub event_bytes: usize,
    /// Bytes kept of each event's data and of its raw copy (64 KiB).
    pub event_data_bytes: usize,
    /// Running invocations recorded in full at once (1,000); beyond it, new
    /// ones keep their summary only (no bodies, no logs).
    pub in_flight: usize,
    /// Slots in the invocation-touched broadcast (4,096).
    pub touched: usize,
}

impl Default for MonitorLimits {
    fn default() -> Self {
        Self {
            invocations: 2_000,
            kind_floor: 200,
            invocation_bytes: 64 * 1024 * 1024,
            body_bytes: 256 * 1024,
            log_lines: 1_000,
            log_bytes: 256 * 1024,
            load_log_lines: 200,
            durations: 256,
            events: 1_000,
            event_bytes: 16 * 1024 * 1024,
            event_data_bytes: 64 * 1024,
            in_flight: 1_000,
            touched: 4_096,
        }
    }
}

/// Where the monitor's events go besides its own state: the console's
/// compute module installs one that pushes into its live rings, publishes
/// the section's badges and ticks its status. `push` is called under the
/// monitor's lock and must not block.
pub trait LiveSink: Send + Sync + 'static {
    fn push(&self, event: &Arc<MonitorEvent>);
}

/// The runtime's record of everything the console shows live. Cheap to clone.
#[derive(Clone)]
pub struct Monitor {
    inner: Arc<Inner>,
}

struct Inner {
    limits: MonitorLimits,
    /// Six hex characters chosen at creation, so ids never repeat across
    /// engine starts.
    nonce: String,
    /// Held for microseconds; never across an await.
    state: Mutex<State>,
    sink: OnceLock<Arc<dyn LiveSink>>,
    /// Invocation ids whose lines, response chunks or end changed.
    touched: broadcast::Sender<Arc<str>>,
}

/// Which invocations [`Monitor::invocations`] returns, newest first.
#[derive(Clone, Copy)]
pub struct InvocationQuery<'a> {
    /// Keeps the invocations it answers true for; `None` keeps every one.
    /// The console compiles its `q` filter into this. It runs under the
    /// monitor's lock, so it must be a pure, quick check; it is `Sync` so a
    /// query can live across an await in a request handler.
    pub filter: Option<&'a (dyn Fn(&InvocationSummary) -> bool + Sync)>,
    /// At most this many items in the page.
    pub limit: usize,
}

/// A page of invocations, newest first.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct InvocationPage {
    pub items: Vec<InvocationSummary>,
    /// The `before` that continues after the last item, while more match.
    /// It is always the last item's `seq`, so a caller that trims the page
    /// (to a byte budget) continues from the last item it kept instead.
    pub next: Option<u64>,
    /// How many kept invocations match in all. Exact: the record is bounded.
    pub total: u64,
}

/// Which Eventarc events [`Monitor::events`] returns, newest first.
#[derive(Clone, Copy)]
pub struct EventarcEventQuery<'a> {
    /// Only events on this channel: a full channel resource name, or
    /// `google` for the native channel.
    pub channel: Option<&'a str>,
    /// Keeps the events it answers true for; `None` keeps every one. It runs
    /// under the monitor's lock, so it must be a pure, quick check.
    pub filter: Option<&'a (dyn Fn(&EventarcEventSummary) -> bool + Sync)>,
    /// At most this many items in the page.
    pub limit: usize,
}

/// A page of Eventarc events, newest first.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EventarcEventPage {
    pub items: Vec<EventarcEventSummary>,
    /// The `before` that continues after the last item (its `seq`), while
    /// more match.
    pub next: Option<u64>,
    /// How many kept events match in all. Exact: the record is bounded.
    pub total: u64,
}

/// What an invocation added after a reader's position: the read behind the
/// console's `functions.invocation` topic.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct InvocationProgress {
    /// The kept lines after the position, in order.
    pub lines: Vec<FunctionLogLine>,
    /// The kept response bytes after the position.
    pub chunks: Vec<FunctionResponseChunk>,
    /// The position to read from next: lines kept so far…
    pub next_line: u32,
    /// …and response bytes kept so far.
    pub next_byte: u64,
    /// The final summary, once the invocation has finished.
    pub finished: Option<InvocationSummary>,
}

/// A recorded request or response body, exactly as kept.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RecordedBody {
    /// The kept bytes: the whole body, or its first `body_bytes`.
    pub bytes: Bytes,
    pub content_type: Option<String>,
    /// The body's full size as it arrived.
    pub size: u64,
    pub truncated: bool,
}

/// A recorded request with every header as it arrived, sensitive ones
/// included: what a replay re-sends. It never leaves the engine.
#[derive(Clone, Debug)]
pub struct RecordedRequest {
    pub function_id: String,
    pub target: InvocationTarget,
    pub method: String,
    pub path: String,
    pub headers: HeaderMap,
    pub body: Bytes,
}

/// A codebase or extension instance the runtime serves, as it registers it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodebaseRegistration {
    pub id: String,
    pub kind: FunctionCodebaseKind,
    /// The source directory, relative to the project when inside it.
    pub directory: String,
    pub runtime: Option<String>,
    pub inspect_port: Option<u16>,
}

/// What one completed load of a codebase produced.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LoadReport {
    pub function_count: u32,
    pub env_files: Vec<String>,
    pub not_loaded: Vec<FunctionNotLoaded>,
    pub error: Option<FunctionLoadError>,
    /// The load failed and the previous definitions keep serving.
    pub kept_previous: bool,
    pub diff: FunctionRegistryDiff,
    pub elapsed: Duration,
}

/// A change in a codebase's worker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkerTransition {
    Starting,
    Running {
        pid: Option<u32>,
        node: Option<String>,
        /// How long the start took.
        start: Duration,
    },
    /// The process exited on its own; `status` in words ("exited with code 1").
    Exited {
        status: String,
    },
    /// Stopped by the runtime (a reload, a restart, shutdown).
    Stopped,
    /// The worker could not be started.
    Failed {
        message: String,
    },
}

/// Everything known when an invocation begins (after its body was read).
#[derive(Clone, Debug)]
pub struct InvocationStart {
    pub function_id: String,
    pub codebase: String,
    pub kind: FunctionKind,
    pub origin: InvocationOrigin,
    pub cause: InvocationCause,
    /// The one-line summary that goes with `cause`.
    pub summary: String,
    pub target: InvocationTarget,
    pub method: String,
    /// After the function's address for URL invocations; the trigger route's
    /// query otherwise.
    pub path: String,
    pub headers: HeaderMap,
    /// The body exactly as it arrived (a larger one is cut when kept).
    pub body: Bytes,
    pub replay_of: Option<String>,
    /// The Eventarc event and the delivery slot this dispatch fulfils.
    pub delivery: Option<(u64, usize)>,
}

/// The handle of a running invocation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvocationToken {
    /// `<nonce>-<seq>`, the `x-firenook-execution` value.
    pub id: Arc<str>,
    pub seq: u64,
}

/// How an invocation ended, as the dispatch path saw it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InvocationEnd {
    /// Set for the runtime's own endings (timeout, crash, not started,
    /// paused, removed, a handler that threw); `None` classifies the answer.
    pub outcome: Option<InvocationOutcome>,
    /// The runtime's own sentence for its endings.
    pub error: Option<String>,
    /// The caller started reading the body and stopped before its end.
    pub client_gone: bool,
}

/// One subscription considered for an Eventarc event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliveryPlan {
    pub trigger_key: String,
    pub function_id: Option<String>,
    /// Empty when the subscription matched.
    pub mismatches: Vec<EventarcFilterMismatch>,
}

/// An Eventarc event as it arrived, and what each subscription will do.
#[derive(Clone, Debug)]
pub struct EventReceived {
    /// The full channel resource name, or `google` for the native channel.
    pub channel: String,
    /// The event as published (proto JSON on a channel).
    pub raw: Value,
    /// The structured `CloudEvent`, or why it could not be read.
    pub converted: Result<Value, String>,
    pub origin: EventarcOrigin,
    pub replay_of: Option<String>,
    /// One per subscription of the event's type on its channel; the slot of
    /// a delivery is its index here.
    pub deliveries: Vec<DeliveryPlan>,
}

/// A recorded Eventarc event's handle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordedEvent {
    pub seq: u64,
    /// `<nonce>-<seq>`.
    pub id: String,
}

/// The monitor's state, read under its lock (see [`Monitor::snapshot`]).
/// Every reader of [`Monitor`] is here too, so one critical section can
/// combine several (messaging joins a page of fanout records with one lock).
pub struct MonitorView<'a> {
    state: &'a State,
    nonce: &'a str,
    limits: &'a MonitorLimits,
}

impl MonitorView<'_> {
    /// Whether the Functions runtime has finished starting.
    #[must_use]
    pub fn phase(&self) -> FunctionsPhase {
        self.state.phase
    }

    /// Every registered codebase and extension instance, in registration
    /// order.
    #[must_use]
    pub fn codebases(&self) -> Vec<FunctionCodebase> {
        self.state
            .codebases
            .iter()
            .map(|codebase| codebase.codebase.clone())
            .collect()
    }

    /// One registered codebase or extension instance.
    #[must_use]
    pub fn codebase(&self, id: &str) -> Option<FunctionCodebase> {
        self.state
            .codebases
            .iter()
            .find(|codebase| codebase.codebase.id == id)
            .map(|codebase| codebase.codebase.clone())
    }

    /// A codebase's load log after the line index `after` (all kept lines
    /// when `None`); `None` for a codebase the monitor does not know.
    #[must_use]
    pub fn load_log(&self, codebase: &str, after: Option<u32>) -> Option<Vec<FunctionLogLine>> {
        let state = self
            .state
            .codebases
            .iter()
            .find(|candidate| candidate.codebase.id == codebase)?;
        Some(
            state
                .load_log
                .iter()
                .filter(|line| after.is_none_or(|after| line.index > after))
                .cloned()
                .collect(),
        )
    }

    /// A function's absolute counters; zeros for one that never ran.
    #[must_use]
    pub fn stats(&self, function_id: &str) -> FunctionStats {
        self.state
            .stats
            .get(function_id)
            .map(store::StatsState::snapshot)
            .unwrap_or_default()
    }

    /// Kept invocations, running and finished, newest first, older than
    /// `before` when it is set.
    #[must_use]
    pub fn invocations(&self, query: &InvocationQuery<'_>, before: Option<u64>) -> InvocationPage {
        let mut matching: Vec<&InvocationSummary> = self
            .state
            .in_flight
            .values()
            .chain(self.state.finished.iter())
            .map(|record| &record.summary)
            .filter(|summary| query.filter.is_none_or(|keep| keep(summary)))
            .collect();
        let total = matching.len() as u64;
        matching.sort_unstable_by_key(|summary| std::cmp::Reverse(summary.seq));
        let mut items = Vec::with_capacity(query.limit.min(matching.len()));
        let mut more = false;
        for summary in matching
            .into_iter()
            .filter(|summary| before.is_none_or(|before| summary.seq < before))
        {
            if items.len() == query.limit {
                more = true;
                break;
            }
            items.push(summary.clone());
        }
        let next = if more {
            items.last().map(|summary: &InvocationSummary| summary.seq)
        } else {
            None
        };
        InvocationPage { items, next, total }
    }

    /// The newest kept invocation that delivered the event `event_id` (the
    /// `CloudEvent` id or the legacy `context.eventId`, as the sender put it
    /// in `x-firenook-event-id` or `ce-id`). O(1).
    #[must_use]
    pub fn by_event_id(&self, event_id: &str) -> Option<InvocationSummary> {
        let seq = self.state.by_event.get(event_id)?;
        self.state.record(*seq).map(|record| record.summary.clone())
    }

    /// The newest kept invocation for a Cloud Tasks attempt: `queue` is the
    /// engine's queue key and `task` the task name, as the Cloud Tasks
    /// emulator sent them (`X-CloudTasks-QueueName`, `X-CloudTasks-TaskName`),
    /// and `retry_count` its `X-CloudTasks-TaskRetryCount`. O(1).
    #[must_use]
    pub fn by_task(&self, queue: &str, task: &str, retry_count: u32) -> Option<InvocationSummary> {
        let seq = self
            .state
            .by_task
            .get(&task_key(queue, task, retry_count))?;
        self.state.record(*seq).map(|record| record.summary.clone())
    }

    /// Every invocation of `kind` that began after this instant is still
    /// kept, running or finished; `None` while the monitor has let go of
    /// none of that kind (by eviction or a clear). A delivery made after it
    /// that no invocation answers has therefore not begun yet.
    #[must_use]
    pub fn kept_after(&self, kind: FunctionKind) -> Option<SystemTime> {
        self.state.finished.dropped_before[kind_index(kind)]
    }

    /// Everything kept about one invocation, its event decoded for reading;
    /// `None` when it is not kept or the id is from another engine start.
    #[must_use]
    pub fn invocation(&self, id: &str) -> Option<InvocationDetail> {
        let record = self.state.record(parse_id(self.nonce, id)?)?;
        Some(detail(record, self.limits))
    }

    /// What a kept invocation added after `lines` lines and `bytes` response
    /// bytes.
    #[must_use]
    pub fn invocation_since(&self, id: &str, lines: u32, bytes: u64) -> Option<InvocationProgress> {
        let record = self.state.record(parse_id(self.nonce, id)?)?;
        let from = usize::try_from(lines)
            .unwrap_or(usize::MAX)
            .min(record.logs.len());
        let new_lines = record.logs[from..].to_vec();
        let kept: &[u8] = record
            .response
            .as_ref()
            .map_or(&[], |response| response.body.as_slice());
        let start = usize::try_from(bytes).unwrap_or(usize::MAX).min(kept.len());
        let (chunk, end) = text_chunk(&kept[start..]);
        let chunks = if end == 0 { Vec::new() } else { vec![chunk] };
        Some(InvocationProgress {
            lines: new_lines,
            chunks,
            next_line: count_u32(record.logs.len()),
            next_byte: (start + end) as u64,
            finished: record.finished_at.map(|_| record.summary.clone()),
        })
    }

    /// A kept invocation's request body, as recorded.
    #[must_use]
    pub fn request_body(&self, id: &str) -> Option<RecordedBody> {
        let record = self.state.record(parse_id(self.nonce, id)?)?;
        let request = record.request.as_ref()?;
        Some(RecordedBody {
            bytes: request.body.clone(),
            content_type: request.content_type.clone(),
            size: request.size,
            truncated: request.size > request.body.len() as u64,
        })
    }

    /// A kept invocation's response body, as recorded.
    #[must_use]
    pub fn response_body(&self, id: &str) -> Option<RecordedBody> {
        let record = self.state.record(parse_id(self.nonce, id)?)?;
        let response = record.response.as_ref()?;
        Some(RecordedBody {
            bytes: Bytes::copy_from_slice(&response.body),
            content_type: response.content_type.clone(),
            size: response.size,
            truncated: response.size > response.body.len() as u64,
        })
    }

    /// The recorded value of one of a kept invocation's request headers
    /// (the name compared case-insensitively), sensitive ones included:
    /// only the console's reveal route sends such a value to a browser.
    #[must_use]
    pub fn header(&self, id: &str, name: &str) -> Option<String> {
        let record = self.state.record(parse_id(self.nonce, id)?)?;
        let request = record.request.as_ref()?;
        request
            .headers
            .get(name.to_ascii_lowercase().as_str())
            .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
    }

    /// A kept invocation's request as it arrived, for a replay; `None` when
    /// only its summary was kept.
    #[must_use]
    pub fn recorded_request(&self, id: &str) -> Option<RecordedRequest> {
        let record = self.state.record(parse_id(self.nonce, id)?)?;
        let request = record.request.as_ref()?;
        Some(RecordedRequest {
            function_id: record.summary.function_id.clone(),
            target: request.target,
            method: request.method.clone(),
            path: request.path.clone(),
            headers: request.headers.clone(),
            body: request.body.clone(),
        })
    }

    /// Kept Eventarc events, newest first, older than `before` when it is set.
    #[must_use]
    pub fn events(&self, query: &EventarcEventQuery<'_>, before: Option<u64>) -> EventarcEventPage {
        let matching = |event: &&EventRecord| {
            query
                .channel
                .is_none_or(|channel| event.summary.channel == channel)
                && query.filter.is_none_or(|keep| keep(&event.summary))
        };
        let total = self.state.events.events.iter().filter(matching).count() as u64;
        let mut items = Vec::new();
        let mut more = false;
        for event in self
            .state
            .events
            .events
            .iter()
            .rev()
            .filter(|event| before.is_none_or(|before| event.summary.seq < before))
            .filter(matching)
        {
            if items.len() == query.limit {
                more = true;
                break;
            }
            items.push(event.summary.clone());
        }
        let next = if more {
            items
                .last()
                .map(|summary: &EventarcEventSummary| summary.seq)
        } else {
            None
        };
        EventarcEventPage { items, next, total }
    }

    /// Everything kept about one Eventarc event; `None` when it is not kept
    /// or the id is from another engine start.
    #[must_use]
    pub fn event(&self, id: &str) -> Option<EventarcEventDetail> {
        let event = self.state.events.get(parse_id(self.nonce, id)?)?;
        Some(EventarcEventDetail {
            summary: event.summary.clone(),
            attributes: event.attributes.clone(),
            datacontenttype: event.datacontenttype.clone(),
            time: event.time.clone(),
            data: event.data.clone(),
            data_size: event.data_size,
            data_truncated: event.data_truncated,
            raw: event.raw.clone(),
            deliveries: event.deliveries.clone(),
            replay_of: event.replay_of.clone(),
        })
    }

    /// How many invocations of a codebase are running.
    #[must_use]
    pub fn running(&self, codebase: &str) -> u32 {
        count_u32(
            self.state
                .in_flight
                .values()
                .filter(|record| record.summary.codebase == codebase)
                .count(),
        )
    }
}

impl Monitor {
    /// An empty monitor with these bounds.
    #[must_use]
    pub fn new(limits: MonitorLimits) -> Self {
        let (touched, _) = broadcast::channel(limits.touched.max(1));
        Self {
            inner: Arc::new(Inner {
                nonce: fresh_nonce(),
                state: Mutex::new(State::default()),
                sink: OnceLock::new(),
                touched,
                limits,
            }),
        }
    }

    /// The bounds this monitor keeps to.
    #[must_use]
    pub fn limits(&self) -> &MonitorLimits {
        &self.inner.limits
    }

    /// The six hex characters every id of this monitor starts with.
    #[must_use]
    pub fn nonce(&self) -> &str {
        &self.inner.nonce
    }

    /// The id the monitor gives (or gave) the record numbered `seq`.
    #[must_use]
    pub fn id_for(&self, seq: u64) -> String {
        format!("{}-{seq}", self.inner.nonce)
    }

    /// The seq of an id this monitor minted; `None` for another start's id.
    #[must_use]
    pub fn seq_of(&self, id: &str) -> Option<u64> {
        parse_id(&self.inner.nonce, id)
    }

    /// Installs the live sink. There is one per monitor: a second sink is
    /// handed back.
    pub fn set_live_sink(&self, sink: Arc<dyn LiveSink>) -> Result<(), Arc<dyn LiveSink>> {
        self.inner.sink.set(sink)
    }

    /// Runs `read` under the monitor's lock, so a caller reads the state and
    /// whatever its live sink last wrote (a ring's head cursor) at one
    /// instant. Keep `read` short: the runtime waits on this lock.
    pub fn snapshot<R>(&self, read: impl FnOnce(&MonitorView<'_>) -> R) -> R {
        let state = self.lock();
        read(&MonitorView {
            state: &state,
            nonce: &self.inner.nonce,
            limits: &self.inner.limits,
        })
    }

    /// Whether the Functions runtime has finished starting.
    #[must_use]
    pub fn phase(&self) -> FunctionsPhase {
        self.lock().phase
    }

    /// See [`MonitorView::codebases`].
    #[must_use]
    pub fn codebases(&self) -> Vec<FunctionCodebase> {
        let state = self.lock();
        MonitorView {
            state: &state,
            nonce: &self.inner.nonce,
            limits: &self.inner.limits,
        }
        .codebases()
    }

    /// See [`MonitorView::codebase`].
    #[must_use]
    pub fn codebase(&self, id: &str) -> Option<FunctionCodebase> {
        self.snapshot(|view| view.codebase(id))
    }

    /// See [`MonitorView::load_log`].
    #[must_use]
    pub fn load_log(&self, codebase: &str, after: Option<u32>) -> Option<Vec<FunctionLogLine>> {
        self.snapshot(|view| view.load_log(codebase, after))
    }

    /// See [`MonitorView::stats`].
    #[must_use]
    pub fn stats(&self, function_id: &str) -> FunctionStats {
        self.snapshot(|view| view.stats(function_id))
    }

    /// See [`MonitorView::invocations`].
    #[must_use]
    pub fn invocations(&self, query: &InvocationQuery<'_>, before: Option<u64>) -> InvocationPage {
        self.snapshot(|view| view.invocations(query, before))
    }

    /// The newest kept invocation that delivered the event `event_id`; see
    /// [`MonitorView::by_event_id`]. O(1).
    #[must_use]
    pub fn by_event_id(&self, event_id: &str) -> Option<InvocationSummary> {
        self.snapshot(|view| view.by_event_id(event_id))
    }

    /// The newest kept invocation for a Cloud Tasks attempt; see
    /// [`MonitorView::by_task`]. O(1).
    #[must_use]
    pub fn by_task(&self, queue: &str, task: &str, retry_count: u32) -> Option<InvocationSummary> {
        self.snapshot(|view| view.by_task(queue, task, retry_count))
    }

    /// See [`MonitorView::kept_after`].
    #[must_use]
    pub fn kept_after(&self, kind: FunctionKind) -> Option<SystemTime> {
        self.snapshot(|view| view.kept_after(kind))
    }

    /// See [`MonitorView::invocation`].
    #[must_use]
    pub fn invocation(&self, id: &str) -> Option<InvocationDetail> {
        self.snapshot(|view| view.invocation(id))
    }

    /// The current summary of a kept invocation.
    #[must_use]
    pub fn summary(&self, seq: u64) -> Option<InvocationSummary> {
        self.lock().record(seq).map(|record| record.summary.clone())
    }

    /// See [`MonitorView::invocation_since`].
    #[must_use]
    pub fn invocation_since(&self, id: &str, lines: u32, bytes: u64) -> Option<InvocationProgress> {
        self.snapshot(|view| view.invocation_since(id, lines, bytes))
    }

    /// See [`MonitorView::request_body`].
    #[must_use]
    pub fn request_body(&self, id: &str) -> Option<RecordedBody> {
        self.snapshot(|view| view.request_body(id))
    }

    /// See [`MonitorView::response_body`].
    #[must_use]
    pub fn response_body(&self, id: &str) -> Option<RecordedBody> {
        self.snapshot(|view| view.response_body(id))
    }

    /// See [`MonitorView::header`].
    #[must_use]
    pub fn header(&self, id: &str, name: &str) -> Option<String> {
        self.snapshot(|view| view.header(id, name))
    }

    /// See [`MonitorView::recorded_request`].
    #[must_use]
    pub fn recorded_request(&self, id: &str) -> Option<RecordedRequest> {
        self.snapshot(|view| view.recorded_request(id))
    }

    /// See [`MonitorView::events`].
    #[must_use]
    pub fn events(&self, query: &EventarcEventQuery<'_>, before: Option<u64>) -> EventarcEventPage {
        self.snapshot(|view| view.events(query, before))
    }

    /// See [`MonitorView::event`].
    #[must_use]
    pub fn event(&self, id: &str) -> Option<EventarcEventDetail> {
        self.snapshot(|view| view.event(id))
    }

    /// See [`MonitorView::running`].
    #[must_use]
    pub fn running(&self, codebase: &str) -> u32 {
        self.snapshot(|view| view.running(codebase))
    }

    /// A receiver of the ids of invocations whose lines, response chunks or
    /// end changed. A lagging receiver re-reads the records it follows.
    #[must_use]
    pub fn touched(&self) -> broadcast::Receiver<Arc<str>> {
        self.inner.touched.subscribe()
    }

    // ── Writers ─────────────────────────────────────────────────────────

    /// The runtime finished starting (or not).
    pub fn set_phase(&self, phase: FunctionsPhase) {
        self.lock().phase = phase;
    }

    /// A codebase or extension instance the runtime will serve. Registering
    /// an id again replaces its registration and keeps its history.
    pub fn codebase_registered(&self, registration: CodebaseRegistration) {
        let mut state = self.lock();
        let codebase = if let Some(existing) = state.codebase_mut(&registration.id) {
            existing.codebase.kind = registration.kind;
            existing.codebase.directory = registration.directory;
            existing.codebase.runtime = registration.runtime;
            existing.codebase.worker.inspect_port = registration.inspect_port;
            existing.codebase.clone()
        } else {
            let codebase = FunctionCodebase {
                id: registration.id,
                kind: registration.kind,
                directory: registration.directory,
                runtime: registration.runtime,
                state: FunctionLoadState::Loading,
                serving_previous: false,
                error: None,
                loads: 0,
                loaded_at: None,
                load_ms: None,
                loading_since: None,
                function_count: 0,
                not_loaded: Vec::new(),
                env_files: Vec::new(),
                last_change: None,
                stale: None,
                worker: FunctionWorker {
                    state: FunctionWorkerState::Stopped,
                    pid: None,
                    node: None,
                    started_at: None,
                    start_ms: None,
                    restarts: 0,
                    last_exit: None,
                    exited_at: None,
                    inspect_port: registration.inspect_port,
                    in_flight: 0,
                },
            };
            state.codebases.push(CodebaseState {
                codebase: codebase.clone(),
                load_log: std::collections::VecDeque::new(),
                next_line: 0,
                started_once: false,
            });
            codebase
        };
        self.push(|| MonitorEvent::Codebase(codebase));
    }

    /// A load of the codebase began.
    pub fn codebase_loading(&self, id: &str) {
        self.update_codebase(id, |codebase| {
            codebase.state = FunctionLoadState::Loading;
            codebase.loading_since = Some(format_timestamp(SystemTime::now()));
        });
    }

    /// A load of the codebase completed, successfully or not. Every
    /// completed load counts, clears the stale flags and is announced with
    /// its diff (possibly empty).
    pub fn codebase_loaded(&self, id: &str, report: LoadReport) {
        let mut state = self.lock();
        let Some(entry) = state.codebase_mut(id) else {
            return;
        };
        let codebase = &mut entry.codebase;
        let now = format_timestamp(SystemTime::now());
        codebase.loads = codebase.loads.saturating_add(1);
        codebase.loading_since = None;
        codebase.load_ms = Some(millis(report.elapsed));
        codebase.stale = None;
        if let Some(error) = report.error {
            codebase.state = FunctionLoadState::Failed;
            codebase.serving_previous = report.kept_previous;
            codebase.error = Some(error);
            if !report.kept_previous {
                codebase.function_count = report.function_count;
                codebase.env_files = report.env_files;
                codebase.not_loaded = report.not_loaded;
            }
        } else {
            codebase.state = FunctionLoadState::Ready;
            codebase.serving_previous = false;
            codebase.error = None;
            codebase.loaded_at = Some(now);
            codebase.function_count = report.function_count;
            codebase.env_files = report.env_files;
            codebase.not_loaded = report.not_loaded;
        }
        codebase.last_change = Some(report.diff.clone());
        let loads = codebase.loads;
        let snapshot = codebase.clone();
        self.push(|| MonitorEvent::Codebase(snapshot));
        self.push(|| MonitorEvent::Inventory {
            codebase: id.to_owned(),
            diff: report.diff,
            loads,
        });
        drop(state);
    }

    /// Sets or clears why the running code may not be the code on disk.
    pub fn codebase_stale(&self, id: &str, stale: Option<FunctionStale>) {
        self.update_codebase(id, |codebase| codebase.stale = stale);
    }

    /// A codebase's worker changed.
    pub fn worker_state(&self, codebase: &str, transition: WorkerTransition) {
        let mut state = self.lock();
        let Some(entry) = state.codebase_mut(codebase) else {
            return;
        };
        let now = SystemTime::now();
        let worker = &mut entry.codebase.worker;
        match transition {
            WorkerTransition::Starting => worker.state = FunctionWorkerState::Starting,
            WorkerTransition::Running { pid, node, start } => {
                if entry.started_once {
                    worker.restarts = worker.restarts.saturating_add(1);
                }
                entry.started_once = true;
                worker.state = FunctionWorkerState::Running;
                worker.pid = pid;
                worker.node = node;
                worker.started_at = Some(format_timestamp(now));
                worker.start_ms = Some(millis(start));
            }
            WorkerTransition::Exited { status } => {
                worker.state = FunctionWorkerState::Exited;
                worker.pid = None;
                worker.last_exit = Some(status);
                worker.exited_at = Some(format_timestamp(now));
            }
            WorkerTransition::Stopped => {
                worker.state = FunctionWorkerState::Stopped;
                worker.pid = None;
            }
            WorkerTransition::Failed { message } => {
                worker.state = FunctionWorkerState::Failed;
                worker.pid = None;
                worker.last_exit = Some(message);
                worker.exited_at = Some(format_timestamp(now));
            }
        }
        let snapshot = entry.codebase.clone();
        self.push(|| MonitorEvent::Codebase(snapshot));
        drop(state);
    }

    /// An invocation began. Cheap: the body is kept by reference when it is
    /// at most `body_bytes` long, else its head is copied before the lock is
    /// taken, so the byte budget counts what is truly retained.
    pub fn begin(&self, start: InvocationStart) -> InvocationToken {
        let limits = &self.inner.limits;
        // The sender's header first; a sender without one (a legacy envelope
        // read by the classifier) still names its event in the cause.
        let event_key = cause::event_id(&start.headers)
            .or_else(|| start.cause.event_id().map(str::to_owned))
            .map(Arc::<str>::from);
        let task = cause::task_attempt(&start.headers);
        let attempt = task
            .as_ref()
            .map_or(1, |(_, _, retry, _)| retry.saturating_add(1));
        let task_key = task
            .as_ref()
            .map(|(queue, task, retry, _)| task_key(queue, task, *retry));
        let size = start.body.len() as u64;
        let kept = if start.body.len() > limits.body_bytes {
            Bytes::copy_from_slice(&start.body[..limits.body_bytes])
        } else {
            start.body
        };
        let request = RequestRecord {
            target: start.target,
            method: start.method,
            path: start.path,
            content_type: header_text(&start.headers, header::CONTENT_TYPE.as_str()),
            headers: start.headers,
            body: kept,
            size,
        };
        let request_bytes = request.retained();
        let mut cause = start.cause;
        let mut summary_line = start.summary;
        let mut state = self.lock();
        state.next_invocation += 1;
        let seq = state.next_invocation;
        let id: Arc<str> = Arc::from(self.id_for(seq));
        let started_at = SystemTime::now();
        if let Some((event_seq, slot)) = start.delivery
            && let Some(event) = state.events.get_mut(event_seq)
        {
            let (delivered_cause, delivered_summary) = cause::eventarc_delivery(
                &event.summary.channel,
                &event.summary.event_type,
                event.summary.source.as_deref(),
                event.summary.subject.as_deref(),
                event.summary.event_id.as_deref(),
                &event.summary.id,
                event.summary.publisher.as_deref(),
            );
            cause = delivered_cause;
            summary_line = delivered_summary;
            if let Some(delivery) = event.deliveries.get_mut(slot) {
                delivery.invocation_id = Some(id.to_string());
            }
            refresh_event_counts(event);
            let summary = event.summary.clone();
            self.push(|| MonitorEvent::Event(summary));
        }
        let full = state.in_flight.len() < limits.in_flight
            && state.in_flight_bytes + request_bytes <= limits.invocation_bytes;
        let summary = InvocationSummary {
            id: id.to_string(),
            seq,
            function_id: start.function_id,
            codebase: start.codebase,
            kind: start.kind,
            origin: start.origin,
            cause,
            summary: summary_line,
            started_at: format_timestamp(started_at),
            duration_ms: None,
            outcome: None,
            outcome_class: InvocationOutcomeClass::Running,
            status: None,
            callable_status: None,
            cold: false,
            attempt,
            event_id: event_key.as_deref().map(str::to_owned),
            replay_of: start.replay_of,
            log_count: 0,
            error: None,
        };
        if let Some(key) = &event_key {
            state.by_event.insert(Arc::clone(key), seq);
        }
        if let Some(key) = &task_key {
            state.by_task.insert(key.clone(), seq);
        }
        let counters = state.stats.entry(summary.function_id.clone()).or_default();
        counters.in_flight = counters.in_flight.saturating_add(1);
        let snapshot = counters.snapshot();
        if let Some(codebase) = state.codebase_mut(&summary.codebase) {
            codebase.codebase.worker.in_flight =
                codebase.codebase.worker.in_flight.saturating_add(1);
        }
        self.push(|| MonitorEvent::InvocationStarted {
            summary: summary.clone(),
            stats: snapshot,
        });
        let retained = RECORD_OVERHEAD + if full { request_bytes } else { 0 };
        state.in_flight_bytes += retained;
        state.in_flight.insert(
            seq,
            InvocationRecord {
                summary,
                started: Instant::now(),
                started_at,
                finished_at: None,
                request: full.then_some(request),
                response: None,
                logs: Vec::new(),
                log_bytes: 0,
                logs_dropped: 0,
                logs_capped: false,
                timings: InvocationTimings::default(),
                event_key,
                task_key,
                delivery: start.delivery,
                interrupted: None,
                retained,
            },
        );
        let in_flight_bytes = state.in_flight_bytes;
        let evicted = state.finished.evict(limits, in_flight_bytes);
        state.forget(&evicted);
        drop(state);
        drop(evicted);
        InvocationToken { id, seq }
    }

    /// The invocation had to start its codebase's worker first.
    pub fn started_worker(&self, token: &InvocationToken, took: Duration) {
        let mut state = self.lock();
        if let Some(record) = state.in_flight.get_mut(&token.seq) {
            record.summary.cold = true;
            record.timings.worker_start_ms = Some(millis(took));
        }
    }

    /// The worker answered with a status and headers.
    pub fn response_head(&self, token: &InvocationToken, status: u16, headers: &HeaderMap) {
        let mut state = self.lock();
        let State {
            in_flight,
            in_flight_bytes,
            ..
        } = &mut *state;
        let Some(record) = in_flight.get_mut(&token.seq) else {
            return;
        };
        record.summary.status = Some(status);
        record.timings.first_byte_ms = Some(millis(record.started.elapsed()));
        if record.full() {
            let response = ResponseRecord {
                status,
                headers: headers.clone(),
                content_type: header_text(headers, header::CONTENT_TYPE.as_str()),
                body: Vec::new(),
                size: 0,
                chunks: 0,
                client_gone: false,
                has_length: headers.contains_key(header::CONTENT_LENGTH),
            };
            let bytes = response.retained();
            record.retained += bytes;
            *in_flight_bytes += bytes;
            record.response = Some(response);
        }
    }

    /// A chunk of the response body passed through. Kept up to
    /// `body_bytes`; beyond that only counted.
    pub fn response_chunk(&self, token: &InvocationToken, chunk: &[u8]) {
        let limit = self.inner.limits.body_bytes;
        let mut state = self.lock();
        let State {
            in_flight,
            in_flight_bytes,
            ..
        } = &mut *state;
        let Some(response) = in_flight.get_mut(&token.seq).and_then(|record| {
            record
                .response
                .as_mut()
                .map(|response| (response, &mut record.retained))
        }) else {
            return;
        };
        let (response, retained) = response;
        response.size += chunk.len() as u64;
        response.chunks = response.chunks.saturating_add(1);
        let room = limit.saturating_sub(response.body.len());
        if room > 0 {
            let before = response.body.capacity();
            let take = room.min(chunk.len());
            if response.body.capacity() - response.body.len() < take {
                // Grow to what the cap needs at most, never past it.
                let wanted = (response.body.len() + take)
                    .max(response.body.capacity() * 2)
                    .min(limit);
                response.body.reserve_exact(wanted - response.body.len());
            }
            response.body.extend_from_slice(&chunk[..take]);
            let grown = response.body.capacity().saturating_sub(before);
            *retained += grown;
            *in_flight_bytes += grown;
        }
        drop(state);
        self.touch(&token.id);
    }

    /// Marks every running invocation of a codebase as interrupted: if one
    /// then crashes, `reason` is its error. Returns how many were running.
    #[must_use]
    pub fn interrupt(&self, codebase: &str, reason: &str) -> u32 {
        let mut state = self.lock();
        let mut count = 0;
        for record in state.in_flight.values_mut() {
            if record.summary.codebase == codebase {
                record.interrupted = Some(reason.to_owned());
                count += 1;
            }
        }
        count
    }

    /// The invocation ended. Moves the record to the finished store, updates
    /// the function's counters and, for a delivery, its Eventarc event.
    /// Returns the final summary (`None` for an unknown token).
    #[allow(clippy::must_use_candidate)] // A writer: most callers have no use for the summary.
    pub fn finish(&self, token: &InvocationToken, end: InvocationEnd) -> Option<InvocationSummary> {
        let limits = &self.inner.limits;
        let mut state = self.lock();
        let mut record = state.in_flight.remove(&token.seq)?;
        state.in_flight_bytes = state.in_flight_bytes.saturating_sub(record.retained);
        let now = SystemTime::now();
        let duration = millis(record.started.elapsed());
        let (outcome, callable_status) = if let Some(outcome) = end.outcome {
            (outcome, None)
        } else {
            let classified = match &record.response {
                Some(response) => outcome::classify_outcome(
                    record.summary.kind,
                    response.status,
                    response.content_type.as_deref(),
                    &response.body,
                ),
                None => outcome::classify_outcome(
                    record.summary.kind,
                    record.summary.status.unwrap_or(200),
                    None,
                    &[],
                ),
            };
            (classified.outcome, classified.callable_status)
        };
        let error = match outcome {
            InvocationOutcome::Crashed => record.interrupted.clone().or(end.error),
            _ => end.error,
        }
        .or_else(|| record.summary.error.clone())
        .map(|error| first_line(&error));
        record.summary.duration_ms = Some(duration);
        record.summary.outcome = Some(outcome);
        record.summary.outcome_class = outcome.class();
        record.summary.callable_status = callable_status;
        record.summary.error = error;
        record.timings.total_ms = Some(duration);
        record.finished_at = Some(now);
        if let Some(response) = &mut record.response {
            response.client_gone = end.client_gone;
        }
        let summary = record.summary.clone();
        let counters = state.stats.entry(summary.function_id.clone()).or_default();
        counters.runs = counters.runs.saturating_add(1);
        if summary.outcome_class == InvocationOutcomeClass::Failed {
            counters.failures = counters.failures.saturating_add(1);
        }
        counters.in_flight = counters.in_flight.saturating_sub(1);
        counters.record_duration(duration, limits.durations);
        counters.last = Some(summary.clone());
        let snapshot = counters.snapshot();
        if let Some(codebase) = state.codebase_mut(&summary.codebase) {
            codebase.codebase.worker.in_flight =
                codebase.codebase.worker.in_flight.saturating_sub(1);
        }
        if let Some((event_seq, slot)) = record.delivery
            && let Some(event) = state.events.get_mut(event_seq)
        {
            if let Some(delivery) = event.deliveries.get_mut(slot) {
                delivery.outcome = Some(outcome);
                delivery.duration_ms = Some(duration);
            }
            refresh_event_counts(event);
            let event_summary = event.summary.clone();
            self.push(|| MonitorEvent::Event(event_summary));
        }
        self.push(|| MonitorEvent::InvocationFinished {
            summary: summary.clone(),
            stats: snapshot,
        });
        state.finished.insert(record);
        let in_flight_bytes = state.in_flight_bytes;
        let evicted = state.finished.evict(limits, in_flight_bytes);
        state.forget(&evicted);
        drop(state);
        drop(evicted);
        self.touch(&token.id);
        Some(summary)
    }

    /// Routes one line: to the running invocation it names (its offset from
    /// the start), to a finished one still kept (`after_finish`), else to
    /// its codebase's load log. A `firebase-functions/logger` line keeps its
    /// severity, message and fields; a `function.error` line becomes the
    /// invocation's error. Returns the function the line belongs to, when
    /// the line named an invocation the monitor knows.
    pub fn log(&self, event: &LogEvent) -> Option<String> {
        if event
            .kind
            .is_some_and(|kind| LIFECYCLE_KINDS.contains(&kind))
        {
            return event.function.clone();
        }
        if event.execution.is_none()
            && event.codebase.is_none()
            && !event.label.starts_with("extensions[")
        {
            return None;
        }
        let at = event.time.unwrap_or_else(SystemTime::now);
        let structured = event
            .message
            .starts_with('{')
            .then(|| structured::parse(&event.message))
            .flatten();
        let (level, message, fields) = match structured {
            Some(line) => {
                let level = line.level();
                let fields = (!line.fields.is_empty()).then_some(Value::Object(line.fields));
                (level, line.message, fields)
            }
            None => (log_level(&event.level), event.message.clone(), None),
        };
        let weight = event.message.len() + LINE_OVERHEAD;
        let limits = &self.inner.limits;
        let mut state = self.lock();
        let seq = event
            .execution
            .as_deref()
            .and_then(|id| parse_id(&self.inner.nonce, id));
        if let Some(seq) = seq {
            let running = state.in_flight.contains_key(&seq);
            let record = if running {
                state.in_flight.get_mut(&seq)
            } else {
                state.finished.get_mut(seq)
            };
            if let Some(record) = record {
                let is_error = event.kind == Some(FUNCTION_ERROR);
                let after_finish = !is_error
                    && record
                        .finished_at
                        .is_some_and(|finished_at| at > finished_at);
                let mut changed = false;
                if is_error && record.summary.error.is_none() {
                    record.summary.error = Some(first_line(&message));
                    changed = record.finished_at.is_some();
                }
                let offset_ms = at.duration_since(record.started_at).map_or(0.0, millis);
                let grown = append_line(
                    record,
                    limits,
                    FunctionLogLine {
                        index: 0,
                        at: format_timestamp(at),
                        offset_ms,
                        level,
                        message,
                        kind: event.kind.map(str::to_owned),
                        fields,
                        after_finish,
                    },
                    weight,
                );
                let function = record.summary.function_id.clone();
                let id = record.summary.id.clone();
                let changed = changed.then(|| record.summary.clone());
                if running {
                    state.in_flight_bytes += grown;
                } else {
                    state.finished.grew(grown);
                }
                if let Some(summary) = changed {
                    let counters = state.stats.entry(summary.function_id.clone()).or_default();
                    if counters
                        .last
                        .as_ref()
                        .is_some_and(|last| last.seq == summary.seq)
                    {
                        counters.last = Some(summary.clone());
                    }
                    let snapshot = counters.snapshot();
                    self.push(|| MonitorEvent::InvocationFinished {
                        summary,
                        stats: snapshot,
                    });
                }
                drop(state);
                self.touch(&id);
                return Some(function);
            }
        }
        let codebase = event
            .codebase
            .clone()
            .or_else(|| codebase_of_label(&event.label))?;
        let entry = state.codebase_mut(&codebase)?;
        let line = FunctionLogLine {
            index: entry.next_line,
            at: format_timestamp(at),
            offset_ms: 0.0,
            level,
            message,
            kind: event.kind.map(str::to_owned),
            fields,
            after_finish: false,
        };
        entry.next_line = entry.next_line.saturating_add(1);
        while entry.load_log.len() >= limits.load_log_lines.max(1) {
            entry.load_log.pop_front();
        }
        if limits.load_log_lines > 0 {
            entry.load_log.push_back(line.clone());
        }
        self.push(|| MonitorEvent::LoadLine { codebase, line });
        drop(state);
        None
    }

    /// Records an Eventarc event and the subscriptions it will reach.
    pub fn event_received(&self, received: EventReceived) -> RecordedEvent {
        let limits = &self.inner.limits;
        let converted = received.converted.as_ref().ok();
        let attributes_of = converted.unwrap_or(&received.raw);
        let text_of = |name: &str| {
            converted
                .and_then(|event| event.get(name))
                .or_else(|| received.raw.get(name))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let event_type = text_of("type").unwrap_or_default();
        let source = text_of("source");
        let subject = text_of("subject").or_else(|| {
            received
                .raw
                .pointer("/attributes/subject/ceString")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
        let event_id = text_of("id");
        let time = text_of("time");
        let datacontenttype = text_of("datacontenttype");
        let mut attributes = BTreeMap::new();
        if let Some(object) = attributes_of.as_object() {
            for (name, value) in object {
                if name == "data" || name == "data_base64" || name == "textData" {
                    continue;
                }
                if let Some(text) = value.as_str() {
                    attributes.insert(name.clone(), text.to_owned());
                }
            }
        }
        let data = converted
            .and_then(|event| event.get("data"))
            .cloned()
            .unwrap_or(Value::Null);
        let (data, data_size, data_truncated) = bounded_json(data, limits.event_data_bytes);
        let (raw, raw_size, _) = bounded_json(received.raw, limits.event_data_bytes);
        let deliveries: Vec<EventarcDelivery> = received
            .deliveries
            .into_iter()
            .map(|plan| EventarcDelivery {
                trigger_key: plan.trigger_key,
                function_id: plan.function_id,
                matched: plan.mismatches.is_empty(),
                mismatches: plan.mismatches,
                invocation_id: None,
                outcome: None,
                duration_ms: None,
            })
            .collect();
        let retained = RECORD_OVERHEAD
            + usize::try_from(data_size.min(limits.event_data_bytes as u64)).unwrap_or(0)
            + usize::try_from(raw_size.min(limits.event_data_bytes as u64)).unwrap_or(0)
            + attributes
                .iter()
                .map(|(name, value)| name.len() + value.len())
                .sum::<usize>()
            + deliveries.len() * 128;
        let publisher = source.as_deref().and_then(cause::publisher_of);
        let mut state = self.lock();
        state.next_event += 1;
        let seq = state.next_event;
        let id = self.id_for(seq);
        let mut record = EventRecord {
            summary: EventarcEventSummary {
                id: id.clone(),
                seq,
                event_id,
                received_at: format_timestamp(SystemTime::now()),
                channel: received.channel,
                event_type,
                source,
                subject,
                publisher,
                origin: received.origin,
                matched: 0,
                delivered: 0,
                failed: 0,
                pending: 0,
                filtered: 0,
                unheard: false,
                error: received.converted.err(),
            },
            attributes,
            datacontenttype,
            time,
            data,
            data_size,
            data_truncated,
            raw,
            deliveries,
            replay_of: received.replay_of,
            retained,
        };
        refresh_event_counts(&mut record);
        let summary = record.summary.clone();
        state.events.push(record, limits);
        self.push(|| MonitorEvent::Event(summary));
        drop(state);
        RecordedEvent { seq, id }
    }

    /// An extension instance was reloaded, reconfigured or vendored.
    pub fn extension_changed(&self, instance_id: &str) {
        let _state = self.lock();
        self.push(|| MonitorEvent::Extension {
            instance_id: instance_id.to_owned(),
        });
    }

    /// Drops every finished invocation (running ones stay); each kind that
    /// lost records reads as let go now. Every function's figures start over
    /// with the record: runs, failures, percentiles and the last run go,
    /// calls in flight stay counted.
    pub fn clear_invocations(&self) {
        let mut state = self.lock();
        let removed = state.finished.clear(SystemTime::now());
        state.forget(&removed);
        for counters in state.stats.values_mut() {
            counters.start_over();
        }
        drop(state);
        drop(removed);
    }

    /// Drops every kept Eventarc event.
    pub fn clear_events(&self) {
        self.lock().events.clear();
    }

    fn update_codebase(&self, id: &str, change: impl FnOnce(&mut FunctionCodebase)) {
        let mut state = self.lock();
        let Some(entry) = state.codebase_mut(id) else {
            return;
        };
        change(&mut entry.codebase);
        let snapshot = entry.codebase.clone();
        self.push(|| MonitorEvent::Codebase(snapshot));
        drop(state);
    }

    /// Hands an event to the live sink; called under the lock. The event is
    /// built only when a sink is installed.
    fn push(&self, event: impl FnOnce() -> MonitorEvent) {
        if let Some(sink) = self.inner.sink.get() {
            sink.push(&Arc::new(event()));
        }
    }

    fn touch(&self, id: &str) {
        if self.inner.touched.receiver_count() > 0 {
            let _ = self.inner.touched.send(Arc::from(id));
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

impl fmt::Debug for Monitor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Monitor")
            .field("nonce", &self.inner.nonce)
            .field("limits", &self.inner.limits)
            .finish_non_exhaustive()
    }
}

/// Splits a runtime load failure into its first line and the rest, with the
/// project directory written as `.`.
#[must_use]
pub fn load_error(text: &str, project_dir: &std::path::Path, at: SystemTime) -> FunctionLoadError {
    let project = project_dir.display().to_string();
    let cleaned = if project.is_empty() {
        text.to_owned()
    } else {
        text.replace(&project, ".")
    };
    let mut lines = cleaned.splitn(2, '\n');
    let message = lines.next().unwrap_or_default().trim_end().to_owned();
    let detail = lines
        .next()
        .map(str::trim_end)
        .filter(|rest| !rest.trim().is_empty())
        .map(str::to_owned);
    FunctionLoadError {
        message,
        detail,
        at: format_timestamp(at),
    }
}

/// Describes how a process ended: `exited with code 1`, `was killed by
/// signal 9`.
#[must_use]
pub fn exit_description(status: std::process::ExitStatus) -> String {
    if let Some(code) = status.code() {
        return format!("exited with code {code}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt as _;
        if let Some(signal) = status.signal() {
            return format!("was killed by signal {signal}");
        }
    }
    "exited".to_owned()
}

fn parse_id(nonce: &str, id: &str) -> Option<u64> {
    let (prefix, seq) = id.split_once('-')?;
    if prefix != nonce {
        return None;
    }
    seq.parse().ok()
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn count_u32(count: usize) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
}

fn first_line(text: &str) -> String {
    text.lines()
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_owned()
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn log_level(level: &str) -> FunctionLogLevel {
    match level {
        "DEBUG" | "debug" => FunctionLogLevel::Debug,
        "WARN" | "WARNING" | "warn" | "warning" => FunctionLogLevel::Warn,
        "ERROR" | "error" => FunctionLogLevel::Error,
        _ => FunctionLogLevel::Info,
    }
}

/// The codebase a runtime label names: `extensions[<id>]` is the instance;
/// any other label names none.
fn codebase_of_label(label: &str) -> Option<String> {
    label
        .strip_prefix("extensions[")
        .and_then(|rest| rest.strip_suffix(']'))
        .map(str::to_owned)
}

/// Appends a line under the record's caps; past them, one "not kept" line
/// once. Returns the bytes the record grew by.
fn append_line(
    record: &mut InvocationRecord,
    limits: &MonitorLimits,
    mut line: FunctionLogLine,
    weight: usize,
) -> usize {
    if !record.full() {
        record.logs_dropped = record.logs_dropped.saturating_add(1);
        return 0;
    }
    if record.logs.len() >= limits.log_lines || record.log_bytes + weight > limits.log_bytes {
        record.logs_dropped = record.logs_dropped.saturating_add(1);
        if record.logs_capped {
            return 0;
        }
        record.logs_capped = true;
        let notice = format!(
            "Later lines are not kept: the engine keeps {} lines or {} KiB per invocation.",
            limits.log_lines,
            limits.log_bytes / 1024
        );
        line = FunctionLogLine {
            index: count_u32(record.logs.len()),
            level: FunctionLogLevel::Warn,
            message: notice,
            kind: Some(LINES_NOT_KEPT.to_owned()),
            fields: None,
            ..line
        };
        let grown = line.message.len() + LINE_OVERHEAD;
        record.logs.push(line);
        record.retained += grown;
        return grown;
    }
    line.index = count_u32(record.logs.len());
    record.logs.push(line);
    record.log_bytes += weight;
    record.retained += weight;
    record.summary.log_count = count_u32(record.logs.len());
    weight
}

/// Recounts an event's deliveries into its summary.
fn refresh_event_counts(event: &mut EventRecord) {
    let summary = &mut event.summary;
    summary.matched = 0;
    summary.filtered = 0;
    summary.delivered = 0;
    summary.failed = 0;
    summary.pending = 0;
    for delivery in &event.deliveries {
        if !delivery.matched {
            summary.filtered += 1;
            continue;
        }
        summary.matched += 1;
        match delivery.outcome.map(InvocationOutcome::class) {
            None | Some(InvocationOutcomeClass::Running) => summary.pending += 1,
            Some(InvocationOutcomeClass::Succeeded) => summary.delivered += 1,
            Some(InvocationOutcomeClass::Failed | InvocationOutcomeClass::Skipped) => {
                summary.failed += 1;
            }
        }
    }
    summary.unheard = event.deliveries.is_empty() && summary.error.is_none();
}

/// A JSON value kept within `limit` bytes of its text: the value itself, or
/// its text's head as a string. Returns the value, its full size and whether
/// it was cut.
fn bounded_json(value: Value, limit: usize) -> (Value, u64, bool) {
    let text = value.to_string();
    let size = text.len() as u64;
    if text.len() <= limit {
        return (value, size, false);
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (Value::String(text[..end].to_owned()), size, true)
}

/// The longest prefix of `bytes` that is whole UTF-8 text as a text chunk
/// (an incomplete character at the end waits for the next read); bytes that
/// are not text become one Base64 chunk. Returns the chunk and how many
/// bytes it covers.
fn text_chunk(bytes: &[u8]) -> (FunctionResponseChunk, usize) {
    match std::str::from_utf8(bytes) {
        Ok(text) => (
            FunctionResponseChunk {
                text: text.to_owned(),
                encoding: FunctionBodyEncoding::Text,
            },
            bytes.len(),
        ),
        Err(error) if error.error_len().is_none() => {
            let valid = error.valid_up_to();
            (
                FunctionResponseChunk {
                    text: String::from_utf8_lossy(&bytes[..valid]).into_owned(),
                    encoding: FunctionBodyEncoding::Text,
                },
                valid,
            )
        }
        Err(_) => (
            FunctionResponseChunk {
                text: base64::engine::general_purpose::STANDARD.encode(bytes),
                encoding: FunctionBodyEncoding::Base64,
            },
            bytes.len(),
        ),
    }
}

fn body_of(bytes: &[u8], size: u64) -> FunctionBody {
    if bytes.is_empty() {
        return FunctionBody {
            size,
            truncated: size > 0,
            encoding: FunctionBodyEncoding::Empty,
            text: String::new(),
        };
    }
    let (encoding, text) = match std::str::from_utf8(bytes) {
        Ok(text) => (FunctionBodyEncoding::Text, text.to_owned()),
        Err(error) if error.error_len().is_none() && size > bytes.len() as u64 => (
            // A cut inside a character: the kept text up to it.
            FunctionBodyEncoding::Text,
            String::from_utf8_lossy(&bytes[..error.valid_up_to()]).into_owned(),
        ),
        Err(_) => (
            FunctionBodyEncoding::Base64,
            base64::engine::general_purpose::STANDARD.encode(bytes),
        ),
    };
    FunctionBody {
        size,
        truncated: size > bytes.len() as u64,
        encoding,
        text,
    }
}

/// Headers as the console shows them: sensitive values withheld, the
/// engine's own control headers (`x-firenook-*`, never seen by the
/// function) left out.
fn shown_headers(headers: &HeaderMap) -> Vec<FunctionHeader> {
    headers
        .iter()
        .filter(|(name, _)| !name.as_str().starts_with("x-firenook-"))
        .map(|(name, value)| {
            let sensitive = SENSITIVE_HEADERS.contains(&name.as_str());
            FunctionHeader {
                name: name.as_str().to_owned(),
                value: (!sensitive).then(|| String::from_utf8_lossy(value.as_bytes()).into_owned()),
                sensitive,
            }
        })
        .collect()
}

/// The request's event, decoded for reading: a JSON envelope or structured
/// `CloudEvent` as it is, a binary `CloudEvent` as its attributes and data
/// (a second-generation Firestore event's protobuf as `{value, oldValue}`
/// REST documents). HTTP kinds have none.
fn decoded_event(record: &InvocationRecord, request: &RequestRecord) -> Option<Value> {
    if matches!(
        record.summary.kind,
        FunctionKind::Http | FunctionKind::Callable | FunctionKind::Tasks | FunctionKind::Blocking
    ) {
        return None;
    }
    let binary: serde_json::Map<String, Value> = request
        .headers
        .iter()
        .filter_map(|(name, value)| {
            let attribute = name.as_str().strip_prefix("ce-")?;
            Some((
                attribute.to_owned(),
                Value::String(String::from_utf8_lossy(value.as_bytes()).into_owned()),
            ))
        })
        .collect();
    let truncated = request.size > request.body.len() as u64;
    let data = if truncated {
        None
    } else if request
        .content_type
        .as_deref()
        .is_some_and(|value| value.contains("protobuf"))
    {
        // A second-generation Firestore event: the Base64 `DocumentEventData`
        // the Firestore emulator sent, read back into REST documents by the
        // bridge that wrote it (computed on request, never stored). A body
        // that does not decode is shown as it arrived, with why.
        Some(
            match firenook_functions_bridge::decode_document_event(&request.body) {
                Ok(documents) => documents,
                Err(error) => serde_json::json!({
                    "encoding": "base64",
                    "protobuf": String::from_utf8_lossy(&request.body),
                    "error": error.to_string(),
                }),
            },
        )
    } else {
        serde_json::from_slice::<Value>(&request.body).ok()
    };
    if binary.is_empty() {
        return data;
    }
    let mut event = binary;
    event.insert("data".to_owned(), data.unwrap_or(Value::Null));
    Some(Value::Object(event))
}

fn detail(record: &InvocationRecord, limits: &MonitorLimits) -> InvocationDetail {
    let (request, event, replayable, not_replayable) = match &record.request {
        Some(request) => {
            let truncated = request.size > request.body.len() as u64;
            (
                FunctionRequest {
                    target: request.target,
                    method: request.method.clone(),
                    path: request.path.clone(),
                    headers: shown_headers(&request.headers),
                    content_type: request.content_type.clone(),
                    body: body_of(&request.body, request.size),
                },
                decoded_event(record, request),
                !truncated,
                truncated.then(|| {
                    format!(
                        "The request body was larger than {} KiB, so only its start was kept.",
                        limits.body_bytes / 1024
                    )
                }),
            )
        }
        None => (
            FunctionRequest {
                target: InvocationTarget::Trigger,
                method: String::new(),
                path: String::new(),
                headers: Vec::new(),
                content_type: None,
                body: body_of(&[], 0),
            },
            None,
            false,
            Some(format!(
                "Only its summary was kept: more than {} invocations were running at once.",
                limits.in_flight
            )),
        ),
    };
    let response = record.response.as_ref().map(|response| FunctionResponse {
        status: response.status,
        headers: shown_headers(&response.headers),
        content_type: response.content_type.clone(),
        body: body_of(&response.body, response.size),
        chunks: response.chunks,
        streaming: response.streaming(),
        client_gone: response.client_gone,
    });
    let kept_bytes = record
        .response
        .as_ref()
        .map_or(0, |response| response.body.len());
    InvocationDetail {
        summary: record.summary.clone(),
        request,
        response,
        event,
        logs: record.logs.clone(),
        logs_dropped: record.logs_dropped,
        timings: record.timings.clone(),
        replayable,
        not_replayable,
        live_cursor: format!("{}.{kept_bytes}", record.logs.len()),
    }
}

/// Six hex characters from the process's random hasher keys, the clock and
/// the process id.
fn fresh_nonce() -> String {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos()),
    );
    hasher.write_u32(std::process::id());
    format!("{:06x}", hasher.finish() & 0x00ff_ffff)
}

#[cfg(test)]
mod tests;
