//! Compute's live state: the "functions" and "eventarc" rings the topics
//! read, filled by the Monitor's live sink, the extension-change broadcast,
//! and the section's two badges.
//!
//! The sink runs under the Monitor's lock, so everything here is a bounded,
//! non-blocking write: each entry's JSON is serialized once (an invocation
//! row with its function's absolute stats beside it, a codebase change, a
//! load line, an event summary) and a subscriber's window is built by
//! joining those strings. A route that reads the Monitor's state and a
//! ring's head cursor under that same lock gets a snapshot after which
//! every change arrives on the topic, once.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, PoisonError};

use firenook_functions_runtime::LiveSink;
use firenook_functions_runtime::Monitor;
use firenook_functions_runtime::monitor::{
    EventarcEventSummary, FunctionCodebase, FunctionCodebaseKind, FunctionLoadState, FunctionStats,
    InvocationOutcomeClass, InvocationSummary, MonitorEvent,
};
use firenook_suite_front::{ReplayRing, RingLimits};
use serde::Serialize;
use tokio::sync::{broadcast, watch};

use super::functions::FunctionCodebaseEntry;
use super::topics::FunctionsLiveChange;
use crate::entity::EntityRef;
use crate::live::badges::{BadgeHandle, BadgeKind, BadgeNoun, BadgeTone};
use crate::section::SectionContext;

/// The "functions" ring: invocation rows, codebase and inventory changes,
/// load lines.
pub(crate) const FUNCTIONS_RING: RingLimits = RingLimits {
    entries: 10_000,
    bytes: 8 * 1024 * 1024,
    floor: 256,
};

/// The "eventarc" ring: one entry per event summary pushed.
pub(crate) const EVENTARC_RING: RingLimits = RingLimits {
    entries: 4_000,
    bytes: 4 * 1024 * 1024,
    floor: 256,
};

/// Extension changes waiting for slow subscribers.
const EXTENSION_CHANGES: usize = 1_024;

/// What a "functions" ring entry is, for the topics' filters and shapers.
#[derive(Clone, Debug)]
pub(crate) enum FunctionsMeta {
    /// A started or finished invocation; the entry's JSON is the summary.
    Invocation(Arc<InvocationRow>),
    /// A codebase's state, whole; the JSON is a `FunctionsLiveChange`.
    Codebase(Arc<str>),
    /// A completed load; the JSON is a `FunctionsLiveChange`.
    Inventory(Arc<str>),
    /// A line of a codebase's load log; the JSON is the line.
    LoadLine(Arc<str>),
}

/// An invocation row as the filters read it.
#[derive(Debug)]
pub(crate) struct InvocationRow {
    pub(crate) summary: InvocationSummary,
    /// The function's absolute stats after this row, as one
    /// `FunctionStatsEntry`'s JSON.
    pub(crate) stats: Arc<str>,
}

/// What an "eventarc" ring entry is.
#[derive(Clone, Debug)]
pub(crate) struct EventarcMeta(pub(crate) Arc<EventarcEventSummary>);

/// The rings and broadcasts compute's topics read.
pub(crate) struct ComputeLive {
    pub(crate) functions: ReplayRing<FunctionsMeta>,
    pub(crate) eventarc: ReplayRing<EventarcMeta>,
    /// Instance ids whose state changed.
    pub(crate) extensions: broadcast::Sender<Arc<str>>,
}

impl ComputeLive {
    /// Builds the rings in the console's budget, the badges on its board,
    /// and installs the sink that fills them on `monitor`. `counts` ticks
    /// when a summary figure may have changed.
    pub(crate) fn install(
        monitor: &Monitor,
        context: &SectionContext,
        counts: Arc<watch::Sender<u64>>,
    ) -> Arc<Self> {
        let live = Arc::new(Self {
            functions: ReplayRing::new(
                "functions",
                FUNCTIONS_RING,
                context.instance.epoch,
                &context.rings,
            ),
            eventarc: ReplayRing::new(
                "eventarc",
                EVENTARC_RING,
                context.instance.epoch,
                &context.rings,
            ),
            extensions: broadcast::channel(EXTENSION_CHANGES).0,
        });
        let failed = context.badges.handle(
            "functions.failed",
            BadgeKind::Counter,
            BadgeNoun::new("failed invocation", "failed invocations"),
        );
        let load = context.badges.handle(
            "functions.load",
            BadgeKind::Gauge,
            BadgeNoun::new("codebase failed to load", "codebases failed to load"),
        );
        let sink = ComputeSink {
            live: Arc::clone(&live),
            failed,
            load,
            failing: Mutex::new(BTreeSet::new()),
            counts,
        };
        // The codebases registered before the console existed (none in a
        // running suite: the console is built first) count from here.
        for codebase in monitor.codebases() {
            sink.codebase_changed(&codebase);
        }
        // One sink per monitor: a second console over the same parts reads
        // the rings this one fills.
        let _ = monitor.set_live_sink(Arc::new(sink));
        live
    }
}

/// Fills the rings from the Monitor, under its lock.
struct ComputeSink {
    live: Arc<ComputeLive>,
    failed: BadgeHandle,
    load: BadgeHandle,
    /// Codebases whose last load failed.
    failing: Mutex<BTreeSet<String>>,
    counts: Arc<watch::Sender<u64>>,
}

impl ComputeSink {
    fn tick(&self) {
        self.counts
            .send_modify(|count| *count = count.wrapping_add(1));
    }

    fn codebase_changed(&self, codebase: &FunctionCodebase) {
        let failing = {
            let mut failing = self.failing.lock().unwrap_or_else(PoisonError::into_inner);
            if codebase.state == FunctionLoadState::Failed {
                failing.insert(codebase.id.clone());
            } else {
                failing.remove(&codebase.id);
            }
            failing.len() as u64
        };
        let tone = if failing == 0 {
            BadgeTone::Neutral
        } else {
            BadgeTone::Danger
        };
        self.load.set(failing, tone);
    }

    fn invocation(&self, summary: &InvocationSummary, stats: &FunctionStats) {
        let row = json(summary);
        let stats = stats_entry(&summary.function_id, stats, summary.seq, &row);
        let weight = row.len() + stats.len();
        let meta = FunctionsMeta::Invocation(Arc::new(InvocationRow {
            summary: summary.clone(),
            stats: Arc::from(stats),
        }));
        // The meta holds the row again for the filters: count it.
        self.live
            .functions
            .push_weighted(meta, Arc::from(row), weight);
    }
}

impl LiveSink for ComputeSink {
    fn push(&self, event: &Arc<MonitorEvent>) {
        match event.as_ref() {
            MonitorEvent::InvocationStarted { summary, stats } => self.invocation(summary, stats),
            MonitorEvent::InvocationFinished { summary, stats } => {
                self.invocation(summary, stats);
                if summary.outcome_class == InvocationOutcomeClass::Failed {
                    self.failed.add(1, BadgeTone::Danger);
                }
            }
            MonitorEvent::Codebase(codebase) => {
                self.codebase_changed(codebase);
                let change = FunctionsLiveChange::Codebase {
                    codebase: Box::new(codebase_entry(codebase.clone())),
                };
                self.live.functions.push(
                    FunctionsMeta::Codebase(Arc::from(codebase.id.as_str())),
                    Arc::from(json(&change)),
                );
                self.tick();
            }
            MonitorEvent::Inventory {
                codebase,
                diff,
                loads,
            } => {
                let change = FunctionsLiveChange::Inventory {
                    codebase: codebase.clone(),
                    diff: diff.clone(),
                    loads: *loads,
                };
                self.live.functions.push(
                    FunctionsMeta::Inventory(Arc::from(codebase.as_str())),
                    Arc::from(json(&change)),
                );
                self.tick();
            }
            MonitorEvent::LoadLine { codebase, line } => {
                self.live.functions.push(
                    FunctionsMeta::LoadLine(Arc::from(codebase.as_str())),
                    Arc::from(json(line)),
                );
            }
            MonitorEvent::Event(summary) => {
                let row = json(summary);
                let weight = row.len();
                self.live.eventarc.push_weighted(
                    EventarcMeta(Arc::new(summary.clone())),
                    Arc::from(row),
                    weight,
                );
                self.tick();
            }
            MonitorEvent::Extension { instance_id } => {
                let _ = self.live.extensions.send(Arc::from(instance_id.as_str()));
                self.tick();
            }
        }
    }
}

/// A codebase with its Extensions instance, for an extension's codebase.
pub(crate) fn codebase_entry(codebase: FunctionCodebase) -> FunctionCodebaseEntry {
    let instance = (codebase.kind == FunctionCodebaseKind::Extension)
        .then(|| EntityRef::extension_instance(&codebase.id));
    FunctionCodebaseEntry { codebase, instance }
}

/// The console's own types always serialize.
pub(crate) fn json(value: &impl Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned())
}

/// One `FunctionStatsEntry` as JSON, with `row` (the JSON of the summary
/// numbered `seq`) spliced in as `last` when it is the newest run, instead
/// of serializing the same summary twice.
pub(crate) fn stats_entry(function_id: &str, stats: &FunctionStats, seq: u64, row: &str) -> String {
    let last = match &stats.last {
        Some(last) if last.seq == seq => row.to_owned(),
        Some(last) => json(last),
        None => "null".to_owned(),
    };
    let mut entry = String::with_capacity(row.len() + last.len() + function_id.len() + 128);
    entry.push_str("{\"functionId\":");
    entry.push_str(&json(&function_id));
    entry.push_str(",\"stats\":{\"runs\":");
    entry.push_str(&stats.runs.to_string());
    entry.push_str(",\"failures\":");
    entry.push_str(&stats.failures.to_string());
    entry.push_str(",\"inFlight\":");
    entry.push_str(&stats.in_flight.to_string());
    entry.push_str(",\"last\":");
    entry.push_str(&last);
    entry.push_str(",\"p50Ms\":");
    entry.push_str(&json(&stats.p50_ms));
    entry.push_str(",\"p95Ms\":");
    entry.push_str(&json(&stats.p95_ms));
    entry.push_str("}}");
    entry
}
