//! The Logs filter: its fields in the console's one filter language, and
//! the compiled form every line is checked against.
//!
//! `console/src/logs/fields.ts` mirrors [`LOG_FIELDS`]; the cases file
//! `console/src/logs/filter-cases.json` pins what both sides parse, and the
//! foundation's golden harness runs it here and in Vitest. Parsing and
//! validation are the foundation's (`filter.rs`); this module only says
//! which fields exist and what each matches.

use std::sync::Arc;

use regex::{Regex, RegexBuilder};
use serde_json::Value;
use time::OffsetDateTime;

use crate::api_error::ApiError;
use crate::filter::{
    FieldKind, FieldSet, FieldSpec, FilterOp, FilterQuery, parse_number, parse_time,
};
use firenook_suite_front::{LogLevel, kinds};

use super::log::{Label, LogMeta};

/// The Logs fields, in completion order.
pub(crate) const LOG_FIELDS: &[FieldSpec] = &[
    FieldSpec {
        key: "level",
        aliases: &["severity"],
        kind: FieldKind::Enum {
            values: &["debug", "info", "warn", "error"],
            aliases: &[],
        },
        help: "How serious the line is",
    },
    FieldSpec {
        key: "service",
        aliases: &["emulator"],
        kind: FieldKind::Enum {
            values: &[
                "hub",
                "firestore",
                "auth",
                "storage",
                "functions",
                "pubsub",
                "eventarc",
                "tasks",
            ],
            aliases: &[],
        },
        help: "The emulator that wrote it",
    },
    FieldSpec {
        key: "function",
        aliases: &["fn"],
        kind: FieldKind::Exact,
        help: "Functions trigger id; end with * for a prefix",
    },
    FieldSpec {
        key: "instance",
        aliases: &["ext", "extension"],
        kind: FieldKind::Exact,
        help: "Extension instance",
    },
    FieldSpec {
        key: "codebase",
        aliases: &[],
        kind: FieldKind::Exact,
        help: "Functions codebase",
    },
    FieldSpec {
        key: "execution",
        aliases: &["exec"],
        kind: FieldKind::Exact,
        help: "One function invocation",
    },
    FieldSpec {
        key: "kind",
        aliases: &[],
        kind: FieldKind::Exact,
        help: "What happened, like function.failed; end with * for a prefix",
    },
    FieldSpec {
        key: "is",
        aliases: &[],
        kind: FieldKind::Enum {
            values: &["problem", "internal", "marker"],
            aliases: &[],
        },
        help: "Problems, engine internals or markers",
    },
    FieldSpec {
        key: "payload",
        aliases: &[],
        kind: FieldKind::Path {
            prefixes: &["payload."],
        },
        help: "A field of the structured payload; * for any value",
    },
];

/// The Logs field set: the one set that takes `/regex/` items.
pub(crate) static LOG_FIELD_SET: FieldSet = FieldSet {
    fields: LOG_FIELDS,
    regex: true,
};

/// The time window a filter keeps, in milliseconds since the Unix epoch.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Window {
    pub(crate) from_ms: Option<i64>,
    pub(crate) to_ms: Option<i64>,
}

/// Reads `from` and `to`: RFC 3339, a date, `now`, `today`, relative
/// (`-5m`), or for `from`, `reload` (since the last Functions reload,
/// `last_reload`; every line when the engine has not reloaded).
pub(crate) fn window(
    from: Option<&str>,
    to: Option<&str>,
    last_reload: Option<i64>,
    now: OffsetDateTime,
) -> Result<Window, ApiError> {
    let read = |name: &str, text: &str| {
        parse_time(text, now)
            .map(|time| i64::try_from(time.unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX))
            .ok_or_else(|| {
                ApiError::invalid(format!(
                    "`{name}` needs a time, like -5m, 2026-10-12T04:00:00Z or today{}.",
                    if name == "from" { ", or reload" } else { "" }
                ))
            })
    };
    let from_ms = match from.map(str::trim).filter(|text| !text.is_empty()) {
        None => None,
        Some(text) if text.eq_ignore_ascii_case("reload") => last_reload,
        Some(text) => Some(read("from", text)?),
    };
    let to_ms = match to.map(str::trim).filter(|text| !text.is_empty()) {
        None => None,
        Some(text) => Some(read("to", text)?),
    };
    if let (Some(from), Some(to)) = (from_ms, to_ms)
        && from > to
    {
        return Err(ApiError::invalid("`from` is after `to`.")
            .with_fix("Swap them, or leave one out for an open range."));
    }
    Ok(Window { from_ms, to_ms })
}

/// One value an exact field matches.
#[derive(Clone, Debug)]
enum Pattern {
    Exact(Box<str>),
    /// A value written with a trailing `*`.
    Prefix(Box<str>),
}

impl Pattern {
    fn new(value: &str) -> Self {
        match value.strip_suffix('*') {
            Some(prefix) => Self::Prefix(prefix.into()),
            None => Self::Exact(value.into()),
        }
    }

    fn matches(&self, text: &str) -> bool {
        match self {
            Self::Exact(value) => **value == *text,
            Self::Prefix(prefix) => text.starts_with(&**prefix),
        }
    }
}

/// One dimension's terms: any included value matches (none given: every
/// value), and no excluded one may.
#[derive(Clone, Debug, Default)]
struct Dimension {
    include: Vec<Pattern>,
    exclude: Vec<Pattern>,
}

impl Dimension {
    fn add(&mut self, value: &str, negated: bool) {
        let pattern = Pattern::new(value);
        if negated {
            self.exclude.push(pattern);
        } else {
            self.include.push(pattern);
        }
    }

    fn matches(&self, value: Option<&str>) -> bool {
        match value {
            Some(value) => {
                (self.include.is_empty() || self.include.iter().any(|item| item.matches(value)))
                    && !self.exclude.iter().any(|item| item.matches(value))
            }
            None => self.include.is_empty(),
        }
    }
}

/// `is:` values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Flag {
    Problem,
    Internal,
    Marker,
}

/// A `payload.<path>` term's value.
#[derive(Clone, Debug)]
enum PayloadValue {
    /// `*`: the field is present.
    Present,
    /// The value as typed, and as JSON when it parses.
    Value { raw: String, json: Option<Value> },
}

#[derive(Clone, Debug)]
struct PayloadTerm {
    path: Vec<String>,
    op: FilterOp,
    value: PayloadValue,
    negated: bool,
}

impl PayloadTerm {
    fn holds(&self, payload: Option<&Value>) -> bool {
        let found = payload.and_then(|payload| lookup(payload, &self.path));
        let holds = match (&self.value, found) {
            (_, None) => false,
            (PayloadValue::Present, Some(_)) => true,
            (PayloadValue::Value { raw, json }, Some(found)) => {
                compare(found, raw, json.as_ref(), self.op)
            }
        };
        holds != self.negated
    }
}

/// The value at `path` in `payload`; a numeric segment indexes an array.
fn lookup<'a>(payload: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter().try_fold(payload, |value, segment| match value {
        Value::Object(fields) => fields.get(segment),
        Value::Array(items) => segment
            .parse::<usize>()
            .ok()
            .and_then(|index| items.get(index)),
        _ => None,
    })
}

/// Whether `found` compares to the typed value with `op`: JSON equality
/// (or the same string) for `:`; numbers when both sides are numbers, else
/// strings, for `<` and `>`.
fn compare(found: &Value, raw: &str, json: Option<&Value>, op: FilterOp) -> bool {
    if op == FilterOp::Eq {
        return json.is_some_and(|json| json == found)
            || found.as_str().is_some_and(|text| text == raw);
    }
    let ordering = if let (Some(left), Some(right)) = (found.as_f64(), parse_number(raw)) {
        left.partial_cmp(&right)
    } else {
        let text = match found {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        Some(text.as_str().cmp(raw))
    };
    let Some(ordering) = ordering else {
        return false;
    };
    match op {
        FilterOp::Gt => ordering.is_gt(),
        FilterOp::Ge => ordering.is_ge(),
        FilterOp::Lt => ordering.is_lt(),
        FilterOp::Le => ordering.is_le(),
        FilterOp::Eq => ordering.is_eq(),
    }
}

/// The dimensions the facets count, in [`Checked::dimensions`] order.
pub(crate) const FACET_DIMENSIONS: usize = 6;

/// What one line passed: each faceted dimension on its own, and the rest.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Checked {
    /// Level, service, function, instance, codebase, kind.
    pub(crate) dimensions: [bool; FACET_DIMENSIONS],
    /// Time, execution, flags, words, regexes and payload.
    pub(crate) rest: bool,
    /// The line is internal and the filter leaves internals out.
    pub(crate) hidden_internal: bool,
}

impl Checked {
    /// The line matches the whole filter.
    pub(crate) fn matched(self) -> bool {
        self.rest && !self.hidden_internal && self.dimensions.iter().all(|passed| *passed)
    }

    /// The line counts in dimension `index`'s facet: it passes every term
    /// but that dimension's own.
    pub(crate) fn counts_in(self, index: usize) -> bool {
        self.rest
            && !self.hidden_internal
            && self
                .dimensions
                .iter()
                .enumerate()
                .all(|(other, passed)| other == index || *passed)
    }
}

/// A Logs filter, compiled: what each line is checked against, cheapest
/// test first (time, interned labels, flags, text, regexes, payload).
#[derive(Debug, Default)]
pub(crate) struct LogFilter {
    /// Bit per level (`1 << level`): included (0: any) and excluded.
    levels_in: u8,
    levels_out: u8,
    services: Dimension,
    functions: Dimension,
    instances: Dimension,
    codebases: Dimension,
    kinds: Dimension,
    executions: Dimension,
    flags: Vec<(Flag, bool)>,
    include_internal: bool,
    /// Words and phrases as case-insensitive literals, each with its sign.
    words: Vec<(Regex, bool)>,
    regexes: Vec<(Regex, bool)>,
    payload: Vec<PayloadTerm>,
    window: Window,
}

const fn level_bit(level: LogLevel) -> u8 {
    match level {
        LogLevel::Debug => 1,
        LogLevel::Info => 2,
        LogLevel::Warn => 4,
        LogLevel::Error => 8,
    }
}

impl LogFilter {
    /// Parses and validates `q` with the Logs fields and compiles it with
    /// `window`.
    pub(crate) fn parse(q: Option<&str>, window: Window) -> Result<Self, ApiError> {
        let query = match q {
            Some(text) => LOG_FIELD_SET.parse(text)?,
            None => FilterQuery::default(),
        };
        Self::compile(&query, window)
    }

    /// Compiles a query [`LOG_FIELD_SET`] validated.
    pub(crate) fn compile(query: &FilterQuery, window: Window) -> Result<Self, ApiError> {
        let mut filter = Self {
            window,
            ..Self::default()
        };
        for term in &query.terms {
            let value = term.value.as_str();
            match term.key.as_str() {
                "level" => {
                    let bit = level_bit(LogLevel::parse(value));
                    if term.negated {
                        filter.levels_out |= bit;
                    } else {
                        filter.levels_in |= bit;
                    }
                }
                "service" => filter.services.add(value, term.negated),
                "function" => filter.functions.add(value, term.negated),
                "instance" => filter.instances.add(value, term.negated),
                "codebase" => filter.codebases.add(value, term.negated),
                "kind" => filter.kinds.add(value, term.negated),
                "execution" => filter.executions.add(value, term.negated),
                "is" => {
                    let flag = match value {
                        "problem" => Flag::Problem,
                        "internal" => Flag::Internal,
                        _ => Flag::Marker,
                    };
                    filter.flags.push((flag, term.negated));
                }
                path => {
                    let path = path.strip_prefix("payload.").unwrap_or(path);
                    filter.payload.push(PayloadTerm {
                        path: path.split('.').map(str::to_owned).collect(),
                        op: term.op,
                        value: if value == "*" {
                            PayloadValue::Present
                        } else {
                            PayloadValue::Value {
                                raw: value.to_owned(),
                                json: serde_json::from_str(value).ok(),
                            }
                        },
                        negated: term.negated,
                    });
                }
            }
        }
        for word in &query.words {
            let regex = RegexBuilder::new(&regex::escape(&word.text))
                .case_insensitive(true)
                .build()
                .map_err(|_| ApiError::invalid("This search text is too long to search for."))?;
            filter.words.push((regex, word.negated));
        }
        for item in &query.regexes {
            let regex = RegexBuilder::new(&item.pattern)
                .case_insensitive(item.case_insensitive)
                .size_limit(1 << 20)
                .build()
                .map_err(|error| regex_refusal(&item.pattern, &error, item.from, item.to))?;
            filter.regexes.push((regex, item.negated));
        }
        filter.include_internal = filter
            .flags
            .iter()
            .any(|(flag, negated)| *flag == Flag::Internal && !negated)
            || filter.kinds.include.iter().any(|pattern| {
                kinds::all().any(|info| info.internal && pattern.matches(info.kind))
            });
        Ok(filter)
    }

    /// Whether every line this filter can match is a problem: `is:problem`,
    /// `level:error` alone, or `kind:` terms naming problem kinds only.
    /// Such a filter reads the problem ring too, so it still finds the
    /// errors a flood evicted from the main ring.
    pub(crate) fn problems_only(&self) -> bool {
        let flagged = self
            .flags
            .iter()
            .any(|(flag, negated)| *flag == Flag::Problem && !negated);
        let errors = self.levels_in == level_bit(LogLevel::Error);
        let problem_kinds = !self.kinds.include.is_empty()
            && self.kinds.include.iter().all(|pattern| {
                let mut matched = kinds::all().filter(|info| pattern.matches(info.kind));
                let mut any = false;
                let all = matched.all(|info| {
                    any = true;
                    info.problem
                });
                any && all
            });
        flagged || errors || problem_kinds
    }

    /// Whether the filter reads the payload (so a line must be parsed).
    #[cfg(test)]
    pub(crate) fn reads_payload(&self) -> bool {
        !self.payload.is_empty()
    }

    /// The window this filter keeps.
    pub(crate) const fn window(&self) -> Window {
        self.window
    }

    fn in_window(&self, meta: &LogMeta) -> bool {
        self.window.from_ms.is_none_or(|from| meta.time_ms >= from)
            && self.window.to_ms.is_none_or(|to| meta.time_ms <= to)
    }

    fn level_passes(&self, level: LogLevel) -> bool {
        let bit = level_bit(level);
        (self.levels_in == 0 || self.levels_in & bit != 0) && self.levels_out & bit == 0
    }

    fn flags_pass(&self, meta: &LogMeta) -> bool {
        self.flags.iter().all(|(flag, negated)| {
            let set = match flag {
                Flag::Problem => meta.flags.problem,
                Flag::Internal => meta.flags.internal,
                Flag::Marker => meta.flags.marker,
            };
            set != *negated
        })
    }

    fn text_passes(&self, meta: &LogMeta) -> bool {
        self.words
            .iter()
            .chain(&self.regexes)
            .all(|(regex, negated)| regex.is_match(&meta.text) != *negated)
    }

    fn payload_passes(&self, meta: &LogMeta) -> bool {
        if self.payload.is_empty() {
            return true;
        }
        let payload = if meta.has_payload {
            serde_json::from_str::<Value>(&meta.json)
                .ok()
                .and_then(|mut entry| entry.get_mut("payload").map(Value::take))
        } else {
            None
        };
        self.payload.iter().all(|term| term.holds(payload.as_ref()))
    }

    /// Whether `meta` matches the whole filter.
    pub(crate) fn matches(&self, meta: &LogMeta) -> bool {
        self.in_window(meta)
            && self.level_passes(meta.level)
            && self.services.matches(Some(meta.service.as_str()))
            && self
                .functions
                .matches(meta.function.as_ref().map(Label::as_str))
            && self
                .instances
                .matches(meta.extension.as_ref().map(Label::as_str))
            && self
                .codebases
                .matches(meta.codebase.as_ref().map(Label::as_str))
            && self.kinds.matches(meta.kind)
            && self.executions.matches(meta.execution.as_deref())
            && (self.include_internal || !meta.flags.internal)
            && self.flags_pass(meta)
            && self.text_passes(meta)
            && self.payload_passes(meta)
    }

    /// Each faceted dimension on its own and the rest, for the facets.
    /// The rest is evaluated only when the line could count somewhere.
    pub(crate) fn check(&self, meta: &LogMeta) -> Checked {
        let dimensions = [
            self.level_passes(meta.level),
            self.services.matches(Some(meta.service.as_str())),
            self.functions
                .matches(meta.function.as_ref().map(Label::as_str)),
            self.instances
                .matches(meta.extension.as_ref().map(Label::as_str)),
            self.codebases
                .matches(meta.codebase.as_ref().map(Label::as_str)),
            self.kinds.matches(meta.kind),
        ];
        let failed = dimensions.iter().filter(|passed| !**passed).count();
        let rest = failed <= 1
            && self.in_window(meta)
            && self.executions.matches(meta.execution.as_deref())
            && self.flags_pass(meta)
            && self.text_passes(meta)
            && self.payload_passes(meta);
        Checked {
            dimensions,
            rest,
            hidden_internal: meta.flags.internal && !self.include_internal,
        }
    }
}

/// The filter, shared by a topic's closures.
pub(crate) type SharedFilter = Arc<LogFilter>;

/// The message for a regular expression the engine will not compile, with
/// the item's span.
fn regex_refusal(pattern: &str, error: &regex::Error, from: usize, to: usize) -> ApiError {
    const FIX: &str = "The engine uses Rust's regex syntax: no look-around or backreferences.";
    let look_around = ["(?<=", "(?<!", "(?=", "(?!"]
        .into_iter()
        .find(|construct| pattern.contains(construct));
    let backreference = backreference(pattern);
    let message = if let Some(construct) = look_around {
        format!(
            "This regular expression uses look-around `{construct}`, which the engine's regex syntax does not support."
        )
    } else if let Some(construct) = &backreference {
        format!(
            "This regular expression uses a backreference `{construct}`, which the engine's regex syntax does not support."
        )
    } else if matches!(error, regex::Error::CompiledTooBig(_)) {
        "This regular expression is too large for the engine to search with.".to_owned()
    } else {
        let detail = error
            .to_string()
            .lines()
            .find_map(|line| line.trim().strip_prefix("error: "))
            .map_or_else(|| error.to_string(), str::to_owned);
        format!("This regular expression is not valid: {detail}.")
    };
    let fix = if matches!(error, regex::Error::CompiledTooBig(_))
        && look_around.is_none()
        && backreference.is_none()
    {
        "Make it shorter, or narrow the search with words and filters first."
    } else {
        FIX
    };
    ApiError::invalid(message)
        .with_fix(fix)
        .with_extra("span", serde_json::json!({ "from": from, "to": to }))
}

/// A backreference in `pattern` (`\1` to `\9`, `\k<name>`), outside an
/// escaped backslash.
fn backreference(pattern: &str) -> Option<String> {
    let mut characters = pattern.chars().peekable();
    while let Some(character) = characters.next() {
        if character != '\\' {
            continue;
        }
        match characters.next() {
            Some(digit @ '1'..='9') => return Some(format!("\\{digit}")),
            Some('k') if characters.peek() == Some(&'<') => return Some("\\k<".to_owned()),
            _ => {}
        }
    }
    None
}

#[cfg(test)]
#[path = "fields_tests.rs"]
mod tests;
