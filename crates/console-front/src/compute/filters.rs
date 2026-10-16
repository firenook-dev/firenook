//! The invocation and event filters: the fields `q` takes on
//! `/functions/invocations`, `/eventarc/events` and their live topics, and
//! the matchers a validated filter compiles to.
//!
//! One compile serves a page and a subscription alike, so a list and its
//! live tail never filter differently. Every term and word must hold; a
//! key repeated with `:` matches any of its values; ranges on one key must
//! all hold; every negated term excludes on its own. `at:` with a date is
//! that UTC day; with an instant or a relative time it means "at or after".

use std::sync::Arc;
use std::time::SystemTime;

use firenook_functions_runtime::monitor::{
    EventarcEventSummary, EventarcOrigin, FunctionKind, InvocationCause, InvocationOrigin,
    InvocationOutcomeClass, InvocationSummary, format_timestamp,
};
use time::OffsetDateTime;

use crate::filter::{
    FieldKind, FieldSet, FieldSpec, FilterError, FilterOp, FilterQuery, FilterTerm, parse_duration,
    parse_number, parse_time,
};

/// Every kind word, as the summaries spell them.
pub(crate) const KIND_WORDS: &[&str] = &[
    "http",
    "callable",
    "firestore",
    "storage",
    "auth",
    "pubsub",
    "schedule",
    "eventarc",
    "tasks",
    "blocking",
    "alerts",
    "database",
    "other",
];

const INVOCATION_SPECS: &[FieldSpec] = &[
    FieldSpec {
        key: "function",
        aliases: &["fn"],
        kind: FieldKind::Exact,
        help: "Function id, like us-central1-api",
    },
    FieldSpec {
        key: "codebase",
        aliases: &[],
        kind: FieldKind::Exact,
        help: "Codebase or extension instance",
    },
    FieldSpec {
        key: "kind",
        aliases: &[],
        kind: FieldKind::Enum {
            values: KIND_WORDS,
            aliases: &[],
        },
        help: "How the function is triggered",
    },
    FieldSpec {
        key: "topic",
        aliases: &[],
        kind: FieldKind::Exact,
        help: "Pub/Sub or schedule topic, by name or full name",
    },
    FieldSpec {
        key: "queue",
        aliases: &[],
        kind: FieldKind::Exact,
        help: "Cloud Tasks queue key, like demo-project-us-central1-resize",
    },
    FieldSpec {
        key: "outcome",
        aliases: &[],
        kind: FieldKind::Enum {
            values: &["succeeded", "failed", "skipped", "running"],
            aliases: &[],
        },
        help: "Succeeded, failed, skipped or still running",
    },
    FieldSpec {
        key: "origin",
        aliases: &[],
        kind: FieldKind::Enum {
            values: &["console", "replay", "emulator", "client"],
            aliases: &[],
        },
        help: "Who made the call",
    },
    FieldSpec {
        key: "status",
        aliases: &[],
        kind: FieldKind::Number,
        help: "HTTP status the function answered with",
    },
    FieldSpec {
        key: "took",
        aliases: &[],
        kind: FieldKind::Duration,
        help: "How long it ran, like >200ms",
    },
    FieldSpec {
        key: "at",
        aliases: &[],
        kind: FieldKind::Time,
        help: "When it started",
    },
    FieldSpec {
        key: "is",
        aliases: &[],
        kind: FieldKind::Enum {
            values: &["cold", "replay"],
            aliases: &[],
        },
        help: "A cold start or a replay",
    },
];

/// The invocation filter's fields (`/functions/invocations`, the
/// `functions.events` topic's `q`).
pub(crate) static INVOCATION_FIELDS: FieldSet = FieldSet {
    fields: INVOCATION_SPECS,
    regex: false,
};

const EVENT_SPECS: &[FieldSpec] = &[
    FieldSpec {
        key: "type",
        aliases: &[],
        kind: FieldKind::Exact,
        help: "Event type; end with * for a prefix",
    },
    FieldSpec {
        key: "source",
        aliases: &[],
        kind: FieldKind::Exact,
        help: "CloudEvent source",
    },
    FieldSpec {
        key: "subject",
        aliases: &[],
        kind: FieldKind::Exact,
        help: "CloudEvent subject",
    },
    FieldSpec {
        key: "publisher",
        aliases: &[],
        kind: FieldKind::Exact,
        help: "Extension instance that published it",
    },
    FieldSpec {
        key: "origin",
        aliases: &[],
        kind: FieldKind::Enum {
            values: &["console", "replay", "app"],
            aliases: &[],
        },
        help: "Who published it",
    },
    FieldSpec {
        key: "delivery",
        aliases: &[],
        kind: FieldKind::Enum {
            values: &["delivered", "filtered", "unheard", "failed", "pending"],
            aliases: &[],
        },
        help: "What became of it",
    },
    FieldSpec {
        key: "at",
        aliases: &[],
        kind: FieldKind::Time,
        help: "When it arrived",
    },
];

/// The Eventarc event filter's fields (`/eventarc/events`, the
/// `eventarc.events` topic's `q`).
pub(crate) static EVENT_FIELDS: FieldSet = FieldSet {
    fields: EVENT_SPECS,
    regex: false,
};

/// A compiled invocation filter.
pub(crate) type InvocationFilter = Arc<dyn Fn(&InvocationSummary) -> bool + Send + Sync>;
/// A compiled event filter.
pub(crate) type EventFilter = Arc<dyn Fn(&EventarcEventSummary) -> bool + Send + Sync>;

type Predicate<R> = Box<dyn Fn(&R) -> bool + Send + Sync>;

/// A validated filter as tests over one kind of record.
struct Compiled<R> {
    /// Groups of `key:value` terms on one key: one of each group holds.
    any_of: Vec<(String, Vec<Predicate<R>>)>,
    /// Range terms: every one holds.
    all_of: Vec<Predicate<R>>,
    /// Negated terms and words: none holds.
    none_of: Vec<Predicate<R>>,
    /// Words: every one appears in the record's text.
    words: Vec<String>,
}

impl<R> Compiled<R> {
    fn new() -> Self {
        Self {
            any_of: Vec::new(),
            all_of: Vec::new(),
            none_of: Vec::new(),
            words: Vec::new(),
        }
    }

    fn add(&mut self, term: &FilterTerm, predicate: Predicate<R>) {
        if term.negated {
            self.none_of.push(predicate);
        } else if term.op == FilterOp::Eq {
            match self.any_of.iter_mut().find(|(key, _)| *key == term.key) {
                Some((_, group)) => group.push(predicate),
                None => self.any_of.push((term.key.clone(), vec![predicate])),
            }
        } else {
            self.all_of.push(predicate);
        }
    }

    fn matches(&self, record: &R, text: impl Fn(&R, &str) -> bool) -> bool {
        self.any_of
            .iter()
            .all(|(_, group)| group.iter().any(|test| test(record)))
            && self.all_of.iter().all(|test| test(record))
            && !self.none_of.iter().any(|test| test(record))
            && self.words.iter().all(|word| text(record, word))
    }
}

/// Parses, validates and compiles an invocation filter; `None` for an
/// empty one. The error carries the span to underline.
pub(crate) fn invocation_filter(q: &str) -> Result<Option<InvocationFilter>, FilterError> {
    let Some(query) = parse(q, &INVOCATION_FIELDS)? else {
        return Ok(None);
    };
    let now = OffsetDateTime::now_utc();
    let mut compiled: Compiled<InvocationSummary> = Compiled::new();
    for term in &query.terms {
        let predicate = invocation_term(term, now);
        compiled.add(term, predicate);
    }
    add_words(
        &mut compiled,
        &query,
        |summary: &InvocationSummary, word| invocation_text(summary, word),
    );
    Ok(Some(Arc::new(move |summary: &InvocationSummary| {
        compiled.matches(summary, invocation_text)
    })))
}

/// Parses, validates and compiles an event filter; `None` for an empty one.
pub(crate) fn event_filter(q: &str) -> Result<Option<EventFilter>, FilterError> {
    let Some(query) = parse(q, &EVENT_FIELDS)? else {
        return Ok(None);
    };
    let now = OffsetDateTime::now_utc();
    let mut compiled: Compiled<EventarcEventSummary> = Compiled::new();
    for term in &query.terms {
        let predicate = event_term(term, now);
        compiled.add(term, predicate);
    }
    add_words(
        &mut compiled,
        &query,
        |event: &EventarcEventSummary, word| event_text(event, word),
    );
    Ok(Some(Arc::new(move |event: &EventarcEventSummary| {
        compiled.matches(event, event_text)
    })))
}

fn parse(q: &str, fields: &FieldSet) -> Result<Option<FilterQuery>, FilterError> {
    if q.trim().is_empty() {
        return Ok(None);
    }
    let query = fields.parse(q)?;
    if query.terms.is_empty() && query.words.is_empty() {
        return Ok(None);
    }
    Ok(Some(query))
}

fn add_words<R: 'static>(
    compiled: &mut Compiled<R>,
    query: &FilterQuery,
    text: impl Fn(&R, &str) -> bool + Send + Sync + Clone + 'static,
) {
    for word in &query.words {
        let lower = word.text.to_lowercase();
        if word.negated {
            let text = text.clone();
            compiled
                .none_of
                .push(Box::new(move |record: &R| text(record, &lower)));
        } else {
            compiled.words.push(lower);
        }
    }
}

/// Whether `word` (lowercase) appears in the invocation's summary, path,
/// error or function id.
fn invocation_text(summary: &InvocationSummary, word: &str) -> bool {
    let contains = |text: &str| text.to_lowercase().contains(word);
    contains(&summary.summary)
        || contains(&summary.function_id)
        || summary.error.as_deref().is_some_and(contains)
        || matches!(&summary.cause, InvocationCause::Http { path, .. } if contains(path))
}

/// Whether `word` (lowercase) appears in the event's type, source or
/// subject.
fn event_text(event: &EventarcEventSummary, word: &str) -> bool {
    let contains = |text: &str| text.to_lowercase().contains(word);
    contains(&event.event_type)
        || event.source.as_deref().is_some_and(contains)
        || event.subject.as_deref().is_some_and(contains)
}

/// `value` against an exact term: equal, or a prefix when it ends with `*`.
fn exact(value: &str, wanted: &str) -> bool {
    match wanted.strip_suffix('*') {
        Some(prefix) => value.starts_with(prefix),
        None => value == wanted,
    }
}

/// A topic's full name (`projects/<p>/topics/<t>`) against a `topic:`
/// value: a full name (or a prefix of one) when it holds a `/`, else the
/// topic's own name.
fn topic_matches(topic: &str, wanted: &str) -> bool {
    if wanted.contains('/') {
        return exact(topic, wanted);
    }
    exact(topic.rsplit('/').next().unwrap_or(topic), wanted)
}

/// The engine's queue key (`queue:<project>-<location>-<id>`) against a
/// `queue:` value, which may leave out the key's own `queue:`.
fn queue_matches(queue: &str, wanted: &str) -> bool {
    let bare = |key: &str| key.strip_prefix("queue:").unwrap_or(key).to_owned();
    exact(&bare(queue), &bare(wanted))
}

fn compare<T: PartialOrd + ?Sized>(value: &T, op: FilterOp, bound: &T) -> bool {
    match op {
        FilterOp::Eq => value == bound,
        FilterOp::Gt => value > bound,
        FilterOp::Ge => value >= bound,
        FilterOp::Lt => value < bound,
        FilterOp::Le => value <= bound,
    }
}

/// A time term as a test on an RFC 3339 timestamp written by
/// `format_timestamp` (UTC, millisecond precision), compared as text.
fn time_test(
    term: &FilterTerm,
    now: OffsetDateTime,
) -> impl Fn(&str) -> bool + Send + Sync + use<> {
    let instant = parse_time(&term.value, now).unwrap_or(now);
    let day = term.value.len() == 10 && term.op == FilterOp::Eq;
    let start = stamp(instant);
    let end = stamp(instant + time::Duration::days(1));
    let op = if term.op == FilterOp::Eq {
        FilterOp::Ge
    } else {
        term.op
    };
    move |at: &str| {
        if day {
            at >= start.as_str() && at < end.as_str()
        } else {
            compare(at, op, start.as_str())
        }
    }
}

fn stamp(instant: OffsetDateTime) -> String {
    format_timestamp(SystemTime::from(instant))
}

fn invocation_term(term: &FilterTerm, now: OffsetDateTime) -> Predicate<InvocationSummary> {
    let value = term.value.clone();
    match term.key.as_str() {
        "function" => {
            Box::new(move |summary: &InvocationSummary| exact(&summary.function_id, &value))
        }
        "codebase" => Box::new(move |summary: &InvocationSummary| exact(&summary.codebase, &value)),
        "kind" => Box::new(move |summary: &InvocationSummary| kind_word(summary.kind) == value),
        "topic" => Box::new(move |summary: &InvocationSummary| match &summary.cause {
            InvocationCause::Pubsub { topic, .. } | InvocationCause::Schedule { topic, .. } => {
                topic_matches(topic, &value)
            }
            _ => false,
        }),
        "queue" => Box::new(move |summary: &InvocationSummary| match &summary.cause {
            InvocationCause::Task { queue, .. } => queue_matches(queue, &value),
            _ => false,
        }),
        "outcome" => {
            Box::new(move |summary: &InvocationSummary| class_word(summary.outcome_class) == value)
        }
        "origin" => {
            Box::new(move |summary: &InvocationSummary| origin_word(summary.origin) == value)
        }
        "status" => {
            let bound = parse_number(&value).unwrap_or_default();
            let op = term.op;
            Box::new(move |summary: &InvocationSummary| {
                summary
                    .status
                    .is_some_and(|status| compare(&f64::from(status), op, &bound))
            })
        }
        "took" => {
            let bound =
                parse_duration(&value).map_or(0.0, |duration| duration.as_secs_f64() * 1000.0);
            let op = term.op;
            Box::new(move |summary: &InvocationSummary| {
                summary
                    .duration_ms
                    .is_some_and(|took| compare(&took, op, &bound))
            })
        }
        "at" => {
            let test = time_test(term, now);
            Box::new(move |summary: &InvocationSummary| test(&summary.started_at))
        }
        "is" => match value.as_str() {
            "cold" => Box::new(|summary: &InvocationSummary| summary.cold),
            _ => Box::new(|summary: &InvocationSummary| summary.replay_of.is_some()),
        },
        // Validation admits no other key.
        _ => Box::new(|_: &InvocationSummary| false),
    }
}

fn event_term(term: &FilterTerm, now: OffsetDateTime) -> Predicate<EventarcEventSummary> {
    let value = term.value.clone();
    match term.key.as_str() {
        "type" => Box::new(move |event: &EventarcEventSummary| exact(&event.event_type, &value)),
        "source" => Box::new(move |event: &EventarcEventSummary| {
            event
                .source
                .as_deref()
                .is_some_and(|source| exact(source, &value))
        }),
        "subject" => Box::new(move |event: &EventarcEventSummary| {
            event
                .subject
                .as_deref()
                .is_some_and(|subject| exact(subject, &value))
        }),
        "publisher" => Box::new(move |event: &EventarcEventSummary| {
            event
                .publisher
                .as_deref()
                .is_some_and(|publisher| exact(publisher, &value))
        }),
        "origin" => {
            Box::new(move |event: &EventarcEventSummary| event_origin_word(event.origin) == value)
        }
        "delivery" => match value.as_str() {
            "delivered" => Box::new(|event: &EventarcEventSummary| event.delivered > 0),
            "filtered" => Box::new(|event: &EventarcEventSummary| event.filtered > 0),
            "unheard" => Box::new(|event: &EventarcEventSummary| event.unheard),
            "failed" => {
                Box::new(|event: &EventarcEventSummary| event.failed > 0 || event.error.is_some())
            }
            _ => Box::new(|event: &EventarcEventSummary| event.pending > 0),
        },
        "at" => {
            let test = time_test(term, now);
            Box::new(move |event: &EventarcEventSummary| test(&event.received_at))
        }
        _ => Box::new(|_: &EventarcEventSummary| false),
    }
}

/// A kind as the filter and the summaries spell it.
pub(crate) const fn kind_word(kind: FunctionKind) -> &'static str {
    match kind {
        FunctionKind::Http => "http",
        FunctionKind::Callable => "callable",
        FunctionKind::Firestore => "firestore",
        FunctionKind::Storage => "storage",
        FunctionKind::Auth => "auth",
        FunctionKind::Pubsub => "pubsub",
        FunctionKind::Schedule => "schedule",
        FunctionKind::Eventarc => "eventarc",
        FunctionKind::Tasks => "tasks",
        FunctionKind::Blocking => "blocking",
        FunctionKind::Alerts => "alerts",
        FunctionKind::Database => "database",
        FunctionKind::Other => "other",
    }
}

const fn class_word(class: InvocationOutcomeClass) -> &'static str {
    match class {
        InvocationOutcomeClass::Succeeded => "succeeded",
        InvocationOutcomeClass::Failed => "failed",
        InvocationOutcomeClass::Skipped => "skipped",
        InvocationOutcomeClass::Running => "running",
    }
}

const fn origin_word(origin: InvocationOrigin) -> &'static str {
    match origin {
        InvocationOrigin::Console => "console",
        InvocationOrigin::Replay => "replay",
        InvocationOrigin::Emulator => "emulator",
        InvocationOrigin::Client => "client",
    }
}

const fn event_origin_word(origin: EventarcOrigin) -> &'static str {
    match origin {
        EventarcOrigin::Console => "console",
        EventarcOrigin::Replay => "replay",
        EventarcOrigin::App => "app",
    }
}

#[cfg(test)]
#[path = "filters_tests.rs"]
mod tests;
