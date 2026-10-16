//! The console's log: every line the suite writes, kept as structured
//! entries beside the official Logging feed (which is unchanged).
//!
//! The suite's [`LoggingRuntime`](firenook_suite_front::LoggingRuntime)
//! hands every line to [`ConsoleLog`] through the [`ConsoleSink`] trait. The
//! log keeps the newest [`CONSOLE_LOG_ENTRIES`] lines in the foundation's
//! [`ReplayRing`] (so cursors, resume and batching are the foundation's),
//! and the last [`PROBLEM_LOG_ENTRIES`] problems (errors, failures,
//! denials) in a second ring holding the same entries, so a flood of output
//! never erases the error it was caused by. Everything a filter reads is
//! computed once, when the line arrives: the serialized entry, its search
//! text, the interned labels and the problem, internal and marker flags.
//! Readers take a snapshot of the rings and filter outside every lock.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard};

use super::fields::LogFilter;
use firenook_suite_front::{
    ConsoleSink, Cursor, EntityRef, LogInput, LogLevel, ReplayRing, RingBudget, RingLimits, kinds,
    replay::random_epoch,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use tokio::sync::watch;
use ts_rs::TS;

/// Lines the console keeps, newest last. Older lines leave first.
pub(crate) const CONSOLE_LOG_ENTRIES: usize = 20_000;
/// Bytes the console keeps: serialized entries, their search text and a
/// fixed per-line overhead ([`SLOT_OVERHEAD`]) all count.
pub(crate) const CONSOLE_LOG_BYTES: usize = 16 * 1024 * 1024;
/// Problem lines kept longer, in a second ring holding the same entries.
pub(crate) const PROBLEM_LOG_ENTRIES: usize = 2_000;
/// Bytes the problem ring counts (the entries are shared with the main
/// ring while both hold them).
pub(crate) const PROBLEM_LOG_BYTES: usize = 2 * 1024 * 1024;
/// A message longer than this is cut at a character boundary and marked.
/// Big enough for a whole stack trace or a pretty-printed object.
pub(crate) const CONSOLE_MESSAGE_BYTES: usize = 64 * 1024;
/// A payload whose compact JSON is longer than this is replaced by
/// `{"firenookElided": <bytes>}` and the entry marked.
pub(crate) const CONSOLE_PAYLOAD_BYTES: usize = 16 * 1024;
/// What each kept line costs beside its JSON and search text: its metadata,
/// the ring's slot and the pointers to both.
pub(crate) const SLOT_OVERHEAD: usize = 160;
/// Distinct labels (services, functions, extensions, codebases) shared
/// between lines; values beyond it are kept per line and the facets group
/// them as [`OTHER_VALUE`].
pub(crate) const INTERNED_LABELS: usize = 4_096;
/// The facet value that stands for labels beyond [`INTERNED_LABELS`].
pub(crate) const OTHER_VALUE: &str = "Other";
/// The longest service, source, function, extension, codebase or execution
/// label a line may carry; a longer one is a producer's bug, and the line is
/// replaced by a notice saying so, as the official feed omits it.
const LABEL_BYTES: usize = 64;
/// What stands in for a line whose labels the log cannot keep.
const LABEL_OMISSION: &str = "A log line was omitted: one of its labels (service, source, function, extension, codebase or execution) is longer than 64 bytes.";

/// The main ring's limits: the one ring above the foundation's default,
/// because it is every service's feed at once.
const MAIN_RING: RingLimits = RingLimits {
    entries: CONSOLE_LOG_ENTRIES,
    bytes: CONSOLE_LOG_BYTES,
    floor: 2_000,
};

/// The problem ring's limits.
const PROBLEM_RING: RingLimits = RingLimits {
    entries: PROBLEM_LOG_ENTRIES,
    bytes: PROBLEM_LOG_BYTES,
    floor: 500,
};

/// One line of the console's log.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "observe/")]
pub(crate) struct LogEntry {
    /// Where this line is in the engine's log: opaque, unique for this
    /// engine run, and the value `entry=`, `before=`, `after=` and
    /// `around=` take.
    pub(crate) cursor: String,
    /// When the line was recorded, RFC 3339 UTC with milliseconds.
    pub(crate) time: String,
    pub(crate) level: LogLevel,
    /// The emulator that wrote it: hub, firestore, auth, storage, functions,
    /// pubsub, eventarc or tasks. Extension output is functions with
    /// `extension` set.
    pub(crate) service: String,
    /// The label the terminal prints, when narrower than the service, such
    /// as functions[us-central1-hello] or extensions[resize-images].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub(crate) source: Option<String>,
    /// The Functions trigger id the line belongs to, such as
    /// us-central1-hello.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub(crate) function: Option<String>,
    /// The extension instance that wrote it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub(crate) extension: Option<String>,
    /// The Functions codebase that wrote it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub(crate) codebase: Option<String>,
    /// The invocation it was written during (the Functions monitor's id);
    /// every line one call wrote shares it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub(crate) execution: Option<String>,
    /// A machine-readable name for what happened, such as function.failed
    /// or rules.denied; absent for plain output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub(crate) kind: Option<String>,
    pub(crate) message: String,
    /// Structured fields: a firebase-functions logger call's fields, or the
    /// details of an event the engine describes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub(crate) payload: Option<serde_json::Value>,
    /// What the line is about, for links into other sections (the console
    /// resolves each through the target section's registry routes).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<EntityRef>>", optional)]
    pub(crate) refs: Vec<EntityRef>,
    /// The message or the payload was cut to fit the console's bounds.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub(crate) truncated: bool,
}

/// How many lines of each level.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export_to = "observe/")]
pub(crate) struct LogLevelCounts {
    #[ts(type = "number")]
    pub(crate) debug: u64,
    #[ts(type = "number")]
    pub(crate) info: u64,
    #[ts(type = "number")]
    pub(crate) warn: u64,
    #[ts(type = "number")]
    pub(crate) error: u64,
}

impl LogLevelCounts {
    /// One more line of `level`.
    pub(crate) const fn add(&mut self, level: LogLevel) {
        match level {
            LogLevel::Debug => self.debug += 1,
            LogLevel::Info => self.info += 1,
            LogLevel::Warn => self.warn += 1,
            LogLevel::Error => self.error += 1,
        }
    }

    /// Every line counted.
    #[cfg(test)]
    pub(crate) const fn total(&self) -> u64 {
        self.debug + self.info + self.warn + self.error
    }
}

/// A label shared between the lines that carry it.
#[derive(Clone, Debug)]
pub(crate) struct Label {
    pub(crate) text: Arc<str>,
    /// False for a value beyond [`INTERNED_LABELS`]; the facets group those.
    pub(crate) interned: bool,
}

impl Label {
    pub(crate) fn as_str(&self) -> &str {
        &self.text
    }
}

/// What a line is, besides its level and kind.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct LineFlags {
    /// An error, or a problem kind: kept longer and counted.
    pub(crate) problem: bool,
    /// Engine bookkeeping the feed leaves out unless asked for.
    pub(crate) internal: bool,
    /// A moment worth a divider in the feed.
    pub(crate) marker: bool,
}

/// What a filter reads without parsing JSON: one line's metadata. The
/// problem ring holds the same `Arc`s as the main ring.
#[derive(Debug)]
pub(crate) struct LogMeta {
    /// The main ring's sequence (the problem ring's own is never exposed).
    pub(crate) seq: u64,
    pub(crate) time_ms: i64,
    pub(crate) level: LogLevel,
    pub(crate) service: Label,
    pub(crate) function: Option<Label>,
    pub(crate) extension: Option<Label>,
    pub(crate) codebase: Option<Label>,
    pub(crate) kind: Option<&'static str>,
    pub(crate) execution: Option<Arc<str>>,
    pub(crate) flags: LineFlags,
    /// Message, source, function, extension, codebase, execution and
    /// payload values, one per line, as written: what words, phrases and
    /// regular expressions search.
    pub(crate) text: Arc<str>,
    /// The serialized [`LogEntry`], cursor included (the ring's entry holds
    /// the same string).
    pub(crate) json: Arc<str>,
    /// Whether the entry carries a payload, so payload filters skip the
    /// lines that cannot match without parsing them.
    pub(crate) has_payload: bool,
}

impl LogMeta {
    /// The line's cursor.
    pub(crate) const fn cursor(&self, epoch: u32) -> Cursor {
        Cursor {
            epoch,
            seq: self.seq,
        }
    }
}

/// Monotonic counts since the log was created, unaffected by eviction.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct TotalsSnapshot {
    pub(crate) entries: u64,
    pub(crate) levels: LogLevelCounts,
    pub(crate) problems: u64,
    /// App requests the Firestore rules refused (`rules.denied`).
    pub(crate) denials: u64,
    /// The newest error's sequence, for the badge's cursor.
    pub(crate) newest_error: Option<u64>,
    /// The newest `rules.denied` line's sequence.
    pub(crate) newest_denial: Option<u64>,
}

/// One minute of the last hour.
#[derive(Clone, Copy, Debug, Default)]
struct Minute {
    /// Minutes since the Unix epoch.
    index: i64,
    counts: LogLevelCounts,
}

#[derive(Default)]
struct Interner {
    values: HashSet<Arc<str>>,
}

impl Interner {
    fn label(&mut self, text: &str) -> Label {
        if let Some(shared) = self.values.get(text) {
            return Label {
                text: shared.clone(),
                interned: true,
            };
        }
        let text: Arc<str> = Arc::from(text);
        if self.values.len() >= INTERNED_LABELS {
            return Label {
                text,
                interned: false,
            };
        }
        self.values.insert(text.clone());
        Label {
            text,
            interned: true,
        }
    }
}

struct LogState {
    interner: Interner,
    totals: TotalsSnapshot,
    minutes: [Minute; 60],
    /// The last `functions.reloaded` line (sequence and time), kept after
    /// the line itself leaves both rings, so `from=reload` still resolves.
    last_reload: Option<(u64, i64)>,
}

struct Shared {
    epoch: u32,
    state: Mutex<LogState>,
    /// Ticks with the entry count after every line, for the badges and the
    /// Logs card.
    changes: watch::Sender<u64>,
    /// Ticks after every warning, error or problem only: what the Overview
    /// draws, so a flood of plain output never wakes it.
    notable: watch::Sender<u64>,
}

/// Every line the suite writes, as the console keeps it. Cloning shares it.
#[derive(Clone)]
pub(crate) struct ConsoleLog {
    main: ReplayRing<Arc<LogMeta>>,
    problems: ReplayRing<Arc<LogMeta>>,
    shared: Arc<Shared>,
}

impl std::fmt::Debug for ConsoleLog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConsoleLog")
            .field("epoch", &self.shared.epoch)
            .field("entries", &self.main.len())
            .finish_non_exhaustive()
    }
}

impl Default for ConsoleLog {
    fn default() -> Self {
        Self::new()
    }
}

fn lock(mutex: &Mutex<LogState>) -> MutexGuard<'_, LogState> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// What one line becomes before it takes a cursor: everything cut, built
/// and counted outside the log's lock.
struct Prepared {
    level: LogLevel,
    service: String,
    source: Option<String>,
    function: Option<String>,
    extension: Option<String>,
    codebase: Option<String>,
    execution: Option<String>,
    kind: Option<&'static str>,
    message: String,
    payload: Option<serde_json::Value>,
    refs: Vec<EntityRef>,
    truncated: bool,
    flags: LineFlags,
    text: Arc<str>,
    time_ms: i64,
    time: String,
}

/// The entry as it is serialized, borrowing what [`Prepared`] holds; it
/// writes exactly [`LogEntry`]'s JSON.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryOut<'a> {
    cursor: &'a str,
    time: &'a str,
    level: LogLevel,
    service: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    function: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    extension: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    codebase: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    execution: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<&'a str>,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<&'a serde_json::Value>,
    #[serde(skip_serializing_if = "<[EntityRef]>::is_empty")]
    refs: &'a [EntityRef],
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    truncated: bool,
}

impl ConsoleLog {
    /// An empty log under the process's ring budget, with cursors in a new
    /// epoch (so a cursor from an earlier run is recognised as foreign).
    #[must_use]
    pub(crate) fn new() -> Self {
        Self::with_budget(&RingBudget::shared())
    }

    /// An empty log whose rings count against `budget`.
    pub(crate) fn with_budget(budget: &RingBudget) -> Self {
        let epoch = random_epoch();
        Self {
            main: ReplayRing::new("logs", MAIN_RING, epoch, budget),
            problems: ReplayRing::new("logs.problems", PROBLEM_RING, epoch, budget),
            shared: Arc::new(Shared {
                epoch,
                state: Mutex::new(LogState {
                    interner: Interner::default(),
                    totals: TotalsSnapshot::default(),
                    minutes: [Minute::default(); 60],
                    last_reload: None,
                }),
                changes: watch::Sender::new(0),
                notable: watch::Sender::new(0),
            }),
        }
    }

    /// The epoch every cursor of this log carries.
    pub(crate) fn epoch(&self) -> u32 {
        self.shared.epoch
    }

    /// The main ring, for the `logs.entries` topic.
    pub(crate) const fn main_ring(&self) -> &ReplayRing<Arc<LogMeta>> {
        &self.main
    }

    /// The newest cursor (sequence 0 before the first line).
    pub(crate) fn tail(&self) -> Cursor {
        self.main.position()
    }

    /// Ticks with the entry count after every line.
    pub(crate) fn changes(&self) -> watch::Receiver<u64> {
        self.shared.changes.subscribe()
    }

    /// Ticks after every warning, error or problem, never for plain output.
    pub(crate) fn notable_changes(&self) -> watch::Receiver<u64> {
        self.shared.notable.subscribe()
    }

    /// Lines kept: the main ring, plus problems it has already evicted.
    pub(crate) fn kept(&self) -> u64 {
        let main = self.main.len();
        let first = self.main.oldest().map_or(u64::MAX, |cursor| cursor.seq);
        let older_problems = self
            .problems
            .snapshot()
            .iter()
            .take_while(|entry| entry.meta.seq < first)
            .count();
        u64::try_from(main + older_problems).unwrap_or(u64::MAX)
    }

    /// Every line kept, oldest first: the main ring, and with
    /// `with_problems` the problems older than its first line before it.
    pub(crate) fn lines(&self, with_problems: bool) -> Vec<Arc<LogMeta>> {
        let main = self.main.snapshot();
        if !with_problems {
            return main.into_iter().map(|entry| entry.meta).collect();
        }
        let first = main.first().map_or(u64::MAX, |entry| entry.meta.seq);
        let problems = self.problems.snapshot();
        let older = problems.iter().take_while(|entry| entry.meta.seq < first);
        let mut lines = Vec::with_capacity(main.len() + problems.len());
        lines.extend(older.map(|entry| entry.meta.clone()));
        lines.extend(main.into_iter().map(|entry| entry.meta));
        lines
    }

    /// Whether the problem ring has given up lines (to its own limits or
    /// the shared budget).
    pub(crate) fn problems_evicted(&self) -> bool {
        self.problems.oldest().is_some_and(|cursor| cursor.seq > 1)
    }

    /// The problem lines, oldest first.
    pub(crate) fn problem_lines(&self) -> Vec<Arc<LogMeta>> {
        self.problems
            .snapshot()
            .into_iter()
            .map(|entry| entry.meta)
            .collect()
    }

    /// The newest `limit` problems, newest first, from the problem ring.
    pub(crate) fn recent_problems(&self, limit: usize) -> Vec<Arc<LogMeta>> {
        self.problems
            .newest(limit)
            .into_iter()
            .rev()
            .map(|entry| entry.meta)
            .collect()
    }

    /// Lines per minute over the hour ending now, oldest first.
    pub(crate) fn hour(&self, now_ms: i64) -> [LogLevelCounts; 60] {
        let now = now_ms.div_euclid(60_000);
        let state = lock(&self.shared.state);
        let mut hour = [LogLevelCounts::default(); 60];
        for (offset, slot) in hour.iter_mut().enumerate() {
            let index = now - 59 + i64::try_from(offset).unwrap_or(0);
            let minute = state.minutes[minute_slot(index)];
            if minute.index == index {
                *slot = minute.counts;
            }
        }
        hour
    }

    /// The line at `seq`, from the main ring or the problem ring.
    pub(crate) fn get(&self, seq: u64) -> Option<Arc<LogMeta>> {
        let find = |lines: Vec<firenook_suite_front::Entry<Arc<LogMeta>>>| {
            lines
                .binary_search_by_key(&seq, |entry| entry.meta.seq)
                .ok()
                .map(|index| lines[index].meta.clone())
        };
        find(self.main.snapshot()).or_else(|| find(self.problems.snapshot()))
    }

    /// Counts since the log was created.
    pub(crate) fn totals(&self) -> TotalsSnapshot {
        lock(&self.shared.state).totals.clone()
    }

    /// The last Functions reload: its sequence and time.
    pub(crate) fn last_reload(&self) -> Option<(u64, i64)> {
        lock(&self.shared.state).last_reload
    }

    fn prepare(input: LogInput) -> Prepared {
        let now = OffsetDateTime::now_utc();
        let time_ms = i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX);
        let labels_fit = [
            Some(input.service.as_str()),
            input.source.as_deref(),
            input.function.as_deref(),
            input.extension.as_deref(),
            input.codebase.as_deref(),
            input.execution.as_deref(),
        ]
        .into_iter()
        .flatten()
        .all(|label| label.len() <= LABEL_BYTES);
        let input = if labels_fit {
            input
        } else {
            LogInput {
                level: LogLevel::Warn,
                service: "hub".to_owned(),
                message: LABEL_OMISSION.to_owned(),
                ..LogInput::default()
            }
        };
        let (message, cut_message) = cut(input.message, CONSOLE_MESSAGE_BYTES);
        let (payload, cut_payload) = match input.payload {
            None => (None, false),
            Some(payload) => {
                let payload = match payload {
                    object @ serde_json::Value::Object(_) => object,
                    other => serde_json::json!({ "value": other }),
                };
                let size = json_size(&payload);
                if size > CONSOLE_PAYLOAD_BYTES {
                    (Some(serde_json::json!({ "firenookElided": size })), true)
                } else {
                    (Some(payload), false)
                }
            }
        };
        let kind = input.kind;
        let flags = LineFlags {
            problem: input.level == LogLevel::Error || kind.is_some_and(kinds::is_problem),
            internal: kind.is_some_and(kinds::is_internal),
            marker: kind.is_some_and(kinds::is_marker),
        };
        let mut text = String::with_capacity(message.len() + 64);
        text.push_str(&message);
        for label in [
            input.source.as_deref(),
            input.function.as_deref(),
            input.extension.as_deref(),
            input.codebase.as_deref(),
            input.execution.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            text.push('\n');
            text.push_str(label);
        }
        if let Some(payload) = &payload {
            payload_values(payload, &mut text);
        }
        Prepared {
            level: input.level,
            service: input.service,
            source: input.source,
            function: input.function,
            extension: input.extension,
            codebase: input.codebase,
            execution: input.execution,
            kind,
            message,
            payload,
            refs: input.refs,
            truncated: cut_message || cut_payload,
            flags,
            text: Arc::from(text),
            time_ms,
            time: format_time(now),
        }
    }

    /// Adds one prepared line: the cursor, the JSON and the metadata are
    /// made under the log's lock, which orders every push so the cursor
    /// the JSON names is the one the ring gives it.
    fn push(&self, line: &Prepared) {
        let mut state = lock(&self.shared.state);
        let seq = self.main.position().seq + 1;
        let cursor = Cursor {
            epoch: self.shared.epoch,
            seq,
        }
        .to_string();
        let out = EntryOut {
            cursor: &cursor,
            time: &line.time,
            level: line.level,
            service: &line.service,
            source: line.source.as_deref(),
            function: line.function.as_deref(),
            extension: line.extension.as_deref(),
            codebase: line.codebase.as_deref(),
            execution: line.execution.as_deref(),
            kind: line.kind,
            message: &line.message,
            payload: line.payload.as_ref(),
            refs: &line.refs,
            truncated: line.truncated,
        };
        // The console's own types always serialize.
        let json: Arc<str> = Arc::from(serde_json::to_string(&out).unwrap_or_default());
        let interner = &mut state.interner;
        let meta = Arc::new(LogMeta {
            seq,
            time_ms: line.time_ms,
            level: line.level,
            service: interner.label(&line.service),
            function: line.function.as_deref().map(|text| interner.label(text)),
            extension: line.extension.as_deref().map(|text| interner.label(text)),
            codebase: line.codebase.as_deref().map(|text| interner.label(text)),
            kind: line.kind,
            execution: line.execution.as_deref().map(Arc::from),
            flags: line.flags,
            text: line.text.clone(),
            json: json.clone(),
            has_payload: line.payload.is_some(),
        });
        let extra = line.text.len() + SLOT_OVERHEAD;
        let pushed = self.main.push_weighted(meta.clone(), json.clone(), extra);
        debug_assert_eq!(pushed.seq, seq, "only the console log pushes into its ring");
        if line.flags.problem {
            self.problems.push_weighted(meta, json, extra);
        }
        let totals = &mut state.totals;
        totals.entries += 1;
        totals.levels.add(line.level);
        if line.level == LogLevel::Error {
            totals.newest_error = Some(seq);
        }
        if line.flags.problem {
            totals.problems += 1;
        }
        if let Some(kind) = line.kind {
            match kind {
                kinds::RULES_DENIED => {
                    state.totals.denials += 1;
                    state.totals.newest_denial = Some(seq);
                }
                kinds::FUNCTIONS_RELOADED => state.last_reload = Some((seq, line.time_ms)),
                _ => {}
            }
        }
        let index = line.time_ms.div_euclid(60_000);
        let minute = &mut state.minutes[minute_slot(index)];
        if minute.index != index {
            *minute = Minute {
                index,
                counts: LogLevelCounts::default(),
            };
        }
        minute.counts.add(line.level);
        let entries = state.totals.entries;
        drop(state);
        self.shared.changes.send_replace(entries);
        if line.flags.problem || line.level == LogLevel::Warn {
            self.shared.notable.send_replace(entries);
        }
    }
}

/// A slice of the log: matching lines, oldest first.
#[derive(Debug)]
pub(crate) struct LogSlice {
    pub(crate) lines: Vec<Arc<LogMeta>>,
    /// More matching lines exist before the first one.
    pub(crate) has_older: bool,
    /// More matching lines exist after the last one.
    pub(crate) has_newer: bool,
    /// The line an `around` slice centres on, when it is still kept.
    pub(crate) anchor: Option<u64>,
    /// The newest line the engine had when it answered: a subscription
    /// after it continues the slice with no gap and no duplicate.
    pub(crate) tail: u64,
}

/// How many lines carry each value of one dimension, most first.
pub(crate) type FacetCounts = Vec<(String, u64)>;

/// The facets of one filter: each dimension counted with every other term.
#[derive(Debug, Default)]
pub(crate) struct Facets {
    pub(crate) kept: u64,
    pub(crate) matched: u64,
    /// Debug, info, warn, error, always all four.
    pub(crate) levels: [u64; 4],
    pub(crate) services: FacetCounts,
    pub(crate) functions: FacetCounts,
    pub(crate) instances: FacetCounts,
    pub(crate) codebases: FacetCounts,
    pub(crate) kinds: FacetCounts,
    /// Engine internals the filter leaves out (0 when it asks for them).
    pub(crate) internal_hidden: u64,
}

/// Lines per time bucket by level.
#[derive(Debug)]
pub(crate) struct Histogram {
    pub(crate) from_ms: i64,
    pub(crate) to_ms: i64,
    pub(crate) bucket_ms: i64,
    pub(crate) buckets: Vec<LogLevelCounts>,
}

/// One facet dimension's counts, sorted by count (most first), then value.
fn sorted(counts: std::collections::HashMap<&str, u64>) -> FacetCounts {
    let mut counts: FacetCounts = counts
        .into_iter()
        .map(|(value, count)| (value.to_owned(), count))
        .collect();
    counts.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    counts
}

fn label_value(label: &Label) -> &str {
    if label.interned {
        label.as_str()
    } else {
        OTHER_VALUE
    }
}

const fn level_index(level: LogLevel) -> usize {
    match level {
        LogLevel::Debug => 0,
        LogLevel::Info => 1,
        LogLevel::Warn => 2,
        LogLevel::Error => 3,
    }
}

impl ConsoleLog {
    /// The lines a filter reads (the problem ring too for a problems-only
    /// filter), and the tail they continue to.
    fn view(&self, filter: &LogFilter) -> (Vec<Arc<LogMeta>>, u64) {
        let position = self.main.position().seq;
        let lines = self.lines(filter.problems_only());
        let tail = lines.last().map_or(position, |line| line.seq.max(position));
        (lines, tail)
    }

    /// The newest `limit` matching lines before `before` (or before the
    /// end), oldest first.
    pub(crate) fn page(&self, filter: &LogFilter, before: Option<u64>, limit: usize) -> LogSlice {
        let (lines, tail) = self.view(filter);
        let end = lines.partition_point(|line| before.is_none_or(|before| line.seq < before));
        let mut picked = Vec::with_capacity(limit.min(end));
        let mut has_older = false;
        for line in lines[..end].iter().rev() {
            if filter.matches(line) {
                if picked.len() == limit {
                    has_older = true;
                    break;
                }
                picked.push(line.clone());
            }
        }
        picked.reverse();
        let has_newer = before.is_some() && lines[end..].iter().any(|line| filter.matches(line));
        LogSlice {
            lines: picked,
            has_older,
            has_newer,
            anchor: None,
            tail,
        }
    }

    /// Up to `each` matching lines before and after the line at `seq`, the
    /// line itself included (whatever the filter) while it is kept.
    pub(crate) fn around(&self, filter: &LogFilter, seq: u64, each: usize) -> LogSlice {
        let (lines, tail) = self.view(filter);
        let at = lines.partition_point(|line| line.seq < seq);
        let anchor = lines.get(at).filter(|line| line.seq == seq).cloned();
        let mut older = Vec::with_capacity(each);
        let mut has_older = false;
        for line in lines[..at].iter().rev() {
            if filter.matches(line) {
                if older.len() == each {
                    has_older = true;
                    break;
                }
                older.push(line.clone());
            }
        }
        older.reverse();
        let after = if anchor.is_some() { at + 1 } else { at };
        let mut newer = Vec::with_capacity(each);
        let mut has_newer = false;
        for line in &lines[after.min(lines.len())..] {
            if filter.matches(line) {
                if newer.len() == each {
                    has_newer = true;
                    break;
                }
                newer.push(line.clone());
            }
        }
        let anchor_seq = anchor.as_ref().map(|line| line.seq);
        let mut picked = older;
        picked.extend(anchor);
        picked.extend(newer);
        LogSlice {
            lines: picked,
            has_older,
            has_newer,
            anchor: anchor_seq,
            tail,
        }
    }

    /// The oldest `limit` matching lines after `after`, oldest first.
    pub(crate) fn forward(&self, filter: &LogFilter, after: u64, limit: usize) -> LogSlice {
        let (lines, tail) = self.view(filter);
        let start = lines.partition_point(|line| line.seq <= after);
        let mut picked = Vec::with_capacity(limit.min(lines.len() - start));
        let mut has_newer = false;
        for line in &lines[start..] {
            if filter.matches(line) {
                if picked.len() == limit {
                    has_newer = true;
                    break;
                }
                picked.push(line.clone());
            }
        }
        let has_older = lines[..start].iter().rev().any(|line| filter.matches(line));
        LogSlice {
            lines: picked,
            has_older,
            has_newer,
            anchor: None,
            tail,
        }
    }

    /// Each dimension's values counted without its own terms, in one pass.
    pub(crate) fn facets(&self, filter: &LogFilter) -> Facets {
        use std::collections::HashMap;
        let (lines, _) = self.view(filter);
        let mut facets = Facets {
            kept: self.kept(),
            ..Facets::default()
        };
        let mut services: HashMap<&str, u64> = HashMap::new();
        let mut functions: HashMap<&str, u64> = HashMap::new();
        let mut instances: HashMap<&str, u64> = HashMap::new();
        let mut codebases: HashMap<&str, u64> = HashMap::new();
        let mut kinds_seen: HashMap<&str, u64> = HashMap::new();
        for line in &lines {
            let checked = filter.check(line);
            if checked.matched() {
                facets.matched += 1;
            }
            if checked.hidden_internal && checked.rest && checked.dimensions.iter().all(|ok| *ok) {
                facets.internal_hidden += 1;
            }
            if checked.counts_in(0) {
                facets.levels[level_index(line.level)] += 1;
            }
            if checked.counts_in(1) {
                *services.entry(label_value(&line.service)).or_insert(0) += 1;
            }
            if checked.counts_in(2)
                && let Some(function) = &line.function
            {
                *functions.entry(label_value(function)).or_insert(0) += 1;
            }
            if checked.counts_in(3)
                && let Some(extension) = &line.extension
            {
                *instances.entry(label_value(extension)).or_insert(0) += 1;
            }
            if checked.counts_in(4)
                && let Some(codebase) = &line.codebase
            {
                *codebases.entry(label_value(codebase)).or_insert(0) += 1;
            }
            if checked.counts_in(5)
                && let Some(kind) = line.kind
            {
                *kinds_seen.entry(kind).or_insert(0) += 1;
            }
        }
        facets.services = sorted(services);
        facets.functions = sorted(functions);
        facets.instances = sorted(instances);
        facets.codebases = sorted(codebases);
        facets.kinds = sorted(kinds_seen);
        facets
    }

    /// Matching lines per bucket between the filter's window or, without
    /// one, the oldest line it reads and `now_ms`.
    pub(crate) fn histogram(&self, filter: &LogFilter, buckets: usize, now_ms: i64) -> Histogram {
        let (lines, _) = self.view(filter);
        let window = filter.window();
        let from_ms = window
            .from_ms
            .or_else(|| lines.first().map(|line| line.time_ms))
            .unwrap_or(now_ms);
        let to_ms = window.to_ms.unwrap_or(now_ms).max(from_ms);
        let count = i64::try_from(buckets.max(1)).unwrap_or(1);
        let bucket_ms = ((to_ms - from_ms + count - 1) / count).max(1);
        let mut histogram = vec![LogLevelCounts::default(); buckets.max(1)];
        for line in &lines {
            if line.time_ms < from_ms || line.time_ms > to_ms || !filter.matches(line) {
                continue;
            }
            let index = usize::try_from((line.time_ms - from_ms) / bucket_ms)
                .unwrap_or(0)
                .min(histogram.len() - 1);
            histogram[index].add(line.level);
        }
        Histogram {
            from_ms,
            to_ms,
            bucket_ms,
            buckets: histogram,
        }
    }

    /// Every matching line, oldest first.
    pub(crate) fn export(&self, filter: &LogFilter) -> Vec<Arc<LogMeta>> {
        let (lines, _) = self.view(filter);
        lines
            .into_iter()
            .filter(|line| filter.matches(line))
            .collect()
    }
}

impl ConsoleSink for ConsoleLog {
    fn accept(&self, input: LogInput) {
        let line = Self::prepare(input);
        self.push(&line);
    }
}

/// Which of the hour's 60 slots minute `index` uses.
fn minute_slot(index: i64) -> usize {
    usize::try_from(index.rem_euclid(60)).unwrap_or(0)
}

/// `text` cut to at most `limit` bytes at a character boundary, and whether
/// it was cut.
fn cut(mut text: String, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text, false);
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    (text, true)
}

/// The length of `value`'s compact JSON, without building it.
fn json_size(value: &serde_json::Value) -> usize {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    let _ = serde_json::to_writer(&mut counter, value);
    counter.0
}

/// Every scalar value of `payload`, one per line, for search.
fn payload_values(payload: &serde_json::Value, text: &mut String) {
    match payload {
        serde_json::Value::Null => {}
        serde_json::Value::Bool(value) => {
            text.push('\n');
            text.push_str(if *value { "true" } else { "false" });
        }
        serde_json::Value::Number(number) => {
            text.push('\n');
            text.push_str(&number.to_string());
        }
        serde_json::Value::String(value) => {
            text.push('\n');
            text.push_str(value);
        }
        serde_json::Value::Array(values) => {
            for value in values {
                payload_values(value, text);
            }
        }
        serde_json::Value::Object(fields) => {
            for value in fields.values() {
                payload_values(value, text);
            }
        }
    }
}

/// RFC 3339 in UTC with exactly three fraction digits:
/// `2026-10-12T04:06:09.126Z`.
pub(crate) fn format_time(time: OffsetDateTime) -> String {
    let time = time.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        time.year(),
        u8::from(time.month()),
        time.day(),
        time.hour(),
        time.minute(),
        time.second(),
        time.millisecond()
    )
}

/// [`format_time`] of a time in milliseconds since the Unix epoch.
pub(crate) fn format_millis(millis: i64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .map(format_time)
        .unwrap_or_default()
}

/// Milliseconds since the Unix epoch, now.
pub(crate) fn now_millis() -> i64 {
    i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX)
}

#[cfg(test)]
#[path = "log_tests.rs"]
mod tests;
