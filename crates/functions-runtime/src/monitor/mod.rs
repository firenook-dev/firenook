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

pub mod types;

use std::fmt;
use std::hash::{BuildHasher, Hasher, RandomState};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use tokio::sync::broadcast;

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

#[derive(Default)]
struct State {
    phase: FunctionsPhase,
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

/// The monitor's state, read under its lock (see [`Monitor::snapshot`]).
/// Every reader of [`Monitor`] is here too, so one critical section can
/// combine several (messaging joins a page of fanout records with one lock).
pub struct MonitorView<'a> {
    state: &'a State,
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
        Vec::new()
    }

    /// A codebase's load log after the line index `after` (all kept lines
    /// when `None`); `None` for a codebase the monitor does not know.
    #[must_use]
    pub fn load_log(&self, _codebase: &str, _after: Option<u32>) -> Option<Vec<FunctionLogLine>> {
        None
    }

    /// A function's absolute counters; zeros for one that never ran.
    #[must_use]
    pub fn stats(&self, _function_id: &str) -> FunctionStats {
        FunctionStats::default()
    }

    /// Kept invocations, running and finished, newest first, older than
    /// `before` when it is set.
    #[must_use]
    pub fn invocations(
        &self,
        _query: &InvocationQuery<'_>,
        _before: Option<u64>,
    ) -> InvocationPage {
        InvocationPage::default()
    }

    /// The newest kept invocation that delivered the event `event_id` (the
    /// `CloudEvent` id or the legacy `context.eventId`, as the sender put it
    /// in `x-firenook-event-id` or `ce-id`). O(1).
    #[must_use]
    pub fn by_event_id(&self, _event_id: &str) -> Option<InvocationSummary> {
        None
    }

    /// The newest kept invocation for a Cloud Tasks attempt: `queue` is the
    /// engine's queue key and `task` the task name, as the Cloud Tasks
    /// emulator sent them (`X-CloudTasks-QueueName`, `X-CloudTasks-TaskName`),
    /// and `retry_count` its `X-CloudTasks-TaskRetryCount`. O(1).
    #[must_use]
    pub fn by_task(
        &self,
        _queue: &str,
        _task: &str,
        _retry_count: u32,
    ) -> Option<InvocationSummary> {
        None
    }

    /// Every invocation of `kind` that began after this instant is still
    /// kept, running or finished; `None` while the monitor has let go of
    /// none of that kind (by eviction or a clear). A delivery made after it
    /// that no invocation answers has therefore not begun yet.
    #[must_use]
    pub fn kept_after(&self, _kind: FunctionKind) -> Option<SystemTime> {
        None
    }

    /// Everything kept about one invocation, its event decoded for reading;
    /// `None` when it is not kept or the id is from another engine start.
    #[must_use]
    pub fn invocation(&self, _id: &str) -> Option<InvocationDetail> {
        None
    }

    /// What a kept invocation added after `lines` lines and `bytes` response
    /// bytes.
    #[must_use]
    pub fn invocation_since(
        &self,
        _id: &str,
        _lines: u32,
        _bytes: u64,
    ) -> Option<InvocationProgress> {
        None
    }

    /// A kept invocation's request body, as recorded.
    #[must_use]
    pub fn request_body(&self, _id: &str) -> Option<RecordedBody> {
        None
    }

    /// A kept invocation's response body, as recorded.
    #[must_use]
    pub fn response_body(&self, _id: &str) -> Option<RecordedBody> {
        None
    }

    /// The recorded value of one of a kept invocation's request headers
    /// (the name compared case-insensitively), sensitive ones included:
    /// only the console's reveal route sends such a value to a browser.
    #[must_use]
    pub fn header(&self, _id: &str, _name: &str) -> Option<String> {
        None
    }

    /// Kept Eventarc events, newest first, older than `before` when it is set.
    #[must_use]
    pub fn events(
        &self,
        _query: &EventarcEventQuery<'_>,
        _before: Option<u64>,
    ) -> EventarcEventPage {
        EventarcEventPage::default()
    }

    /// Everything kept about one Eventarc event; `None` when it is not kept
    /// or the id is from another engine start.
    #[must_use]
    pub fn event(&self, _id: &str) -> Option<EventarcEventDetail> {
        None
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
        read(&MonitorView { state: &state })
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
        MonitorView { state: &state }.codebases()
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

    /// A receiver of the ids of invocations whose lines, response chunks or
    /// end changed. A lagging receiver re-reads the records it follows.
    #[must_use]
    pub fn touched(&self) -> broadcast::Receiver<Arc<str>> {
        self.inner.touched.subscribe()
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
mod tests {
    use super::*;

    struct Counting(std::sync::atomic::AtomicUsize);

    impl LiveSink for Counting {
        fn push(&self, _event: &Arc<MonitorEvent>) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }

    #[test]
    fn release_limits_are_the_defaults() {
        let limits = MonitorLimits::default();
        assert_eq!(limits.invocations, 2_000);
        assert_eq!(limits.kind_floor, 200);
        assert_eq!(limits.body_bytes, 256 * 1024);
        assert_eq!(limits.touched, 4_096);
    }

    #[test]
    fn nonces_are_six_hex_characters() {
        let monitor = Monitor::new(MonitorLimits::default());
        let nonce = monitor.nonce();
        assert_eq!(nonce.len(), 6, "{nonce}");
        assert!(
            nonce.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "{nonce}"
        );
        assert_eq!(monitor.clone().nonce(), nonce);
    }

    #[test]
    fn a_new_monitor_is_starting_and_holds_nothing() {
        let monitor = Monitor::new(MonitorLimits::default());
        let nonce = monitor.nonce().to_owned();
        assert_eq!(monitor.phase(), FunctionsPhase::Starting);
        assert_eq!(monitor.codebases(), Vec::new());
        assert_eq!(monitor.load_log("default", None), None);
        assert_eq!(monitor.stats("us-central1-api"), FunctionStats::default());
        let keep_all = InvocationQuery {
            filter: None,
            limit: 200,
        };
        assert_eq!(
            monitor.invocations(&keep_all, None),
            InvocationPage::default()
        );
        let failed_only =
            |summary: &InvocationSummary| summary.outcome_class == InvocationOutcomeClass::Failed;
        let failed = InvocationQuery {
            filter: Some(&failed_only),
            limit: 50,
        };
        assert_eq!(monitor.invocations(&failed, Some(10)).total, 0);
        assert_eq!(monitor.by_event_id("18"), None);
        assert_eq!(
            monitor.by_task("queue:demo-us-central1-resize", "7891", 0),
            None
        );
        assert_eq!(monitor.kept_after(FunctionKind::Pubsub), None);
        let id = format!("{nonce}-1");
        assert_eq!(monitor.invocation(&id), None);
        assert_eq!(monitor.invocation_since(&id, 0, 0), None);
        assert_eq!(monitor.request_body(&id), None);
        assert_eq!(monitor.response_body(&id), None);
        assert_eq!(monitor.header(&id, "authorization"), None);
        let google = EventarcEventQuery {
            channel: Some("google"),
            filter: None,
            limit: 200,
        };
        assert_eq!(monitor.events(&google, None), EventarcEventPage::default());
        assert_eq!(monitor.event(&id), None);
    }

    #[test]
    fn a_snapshot_reads_the_state_in_one_critical_section() {
        let monitor = Monitor::new(MonitorLimits::default());
        let (phase, codebases, by_event) =
            monitor.snapshot(|view| (view.phase(), view.codebases().len(), view.by_event_id("18")));
        assert_eq!(phase, FunctionsPhase::Starting);
        assert_eq!(codebases, 0);
        assert_eq!(by_event, None);
    }

    #[test]
    fn the_handle_and_its_queries_cross_threads_and_awaits() {
        fn shared<T: Send + Sync + Clone + 'static>() {}
        fn sendable<T: Send>(_: &T) {}
        shared::<Monitor>();
        let words = |summary: &InvocationSummary| summary.summary.contains("orders/");
        let query = InvocationQuery {
            filter: Some(&words),
            limit: 10,
        };
        sendable(&query);
        let on_google = |summary: &EventarcEventSummary| summary.channel == "google";
        let events = EventarcEventQuery {
            channel: None,
            filter: Some(&on_google),
            limit: 10,
        };
        sendable(&events);
    }

    #[test]
    fn one_live_sink_per_monitor() {
        let monitor = Monitor::new(MonitorLimits::default());
        let first: Arc<dyn LiveSink> = Arc::new(Counting(0.into()));
        let second: Arc<dyn LiveSink> = Arc::new(Counting(0.into()));
        assert!(monitor.set_live_sink(first).is_ok());
        let refused = monitor.clone().set_live_sink(Arc::clone(&second));
        assert!(refused.is_err_and(|sink| Arc::ptr_eq(&sink, &second)));
    }

    #[tokio::test]
    async fn touched_ids_reach_every_receiver() {
        let monitor = Monitor::new(MonitorLimits {
            touched: 0,
            ..MonitorLimits::default()
        });
        let mut first = monitor.touched();
        let mut second = monitor.clone().touched();
        monitor
            .inner
            .touched
            .send(Arc::from("abc123-1"))
            .expect("two receivers");
        assert_eq!(&*first.recv().await.expect("an id"), "abc123-1");
        assert_eq!(&*second.recv().await.expect("an id"), "abc123-1");
    }
}
