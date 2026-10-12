//! The Logs API under `/api/v1/logs`: pages of matching lines (before,
//! after or around a line), one line by cursor, the streamed export, the
//! facets, the volume histogram, and the `logs.entries` topic.
//!
//! Every filtered read runs on the blocking pool over a snapshot of the
//! log, so a regex or payload filter never sits on a request thread and no
//! lock is held while it runs. Pages and topic batches are assembled from
//! each line's stored JSON, never serialized again.

use std::fmt::Write as _;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse as _, Response};
use axum::routing::get;
use firenook_suite_front::Cursor;
use futures_util::StreamExt as _;
use futures_util::stream;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use ts_rs::TS;

use super::fields::{LogFilter, SharedFilter, window};
use super::log::{
    CONSOLE_LOG_ENTRIES, ConsoleLog, Facets, LogEntry, LogLevelCounts, LogMeta, LogSlice,
    format_millis, now_millis,
};
use crate::api_error::ApiError;
use crate::blocking::blocking;
use crate::http::attachment;
use crate::live::replay::{ReplayOptions, replay_topic};
use crate::live::{LiveTopic, ResetReason, TopicEvent, TopicStream, topic_params};
use crate::sse::Shutdown;

/// Lines one page holds at most, and by default.
const PAGE_LIMIT: usize = 2_000;
const PAGE_DEFAULT: usize = 500;
/// Lines on each side of an `around` page at most, and by default.
const AROUND_LIMIT: usize = 500;
const AROUND_DEFAULT: usize = 100;
/// Histogram buckets at most, and by default.
const BUCKETS_LIMIT: usize = 240;
const BUCKETS_DEFAULT: usize = 60;
/// Lines one `logs.entries` event carries at most, and their bytes.
const TOPIC_ITEMS: usize = 1_000;
const TOPIC_BYTES: usize = 512 * 1024;
/// Lines per chunk of a streamed export.
const EXPORT_CHUNK: usize = 256;

/// A slice of the log: matching lines, oldest first. The routes assemble
/// it from the lines' stored JSON (`page_json`); this type is its shape for
/// TypeScript and for the tests that check the assembly.
#[allow(
    dead_code,
    reason = "assembled by hand from stored JSON; exported to TypeScript and parsed by the tests"
)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "observe/")]
pub(crate) struct LogPage {
    pub(crate) items: Vec<LogEntry>,
    /// Pass as `before` for the matching lines before these; absent at the
    /// oldest kept match.
    pub(crate) older: Option<String>,
    /// Pass as `after` for the matching lines after these; absent when they
    /// reach the newest line.
    pub(crate) newer: Option<String>,
    /// The newest line the engine had when it answered: subscribe to
    /// `logs.entries` with `after` = this.
    pub(crate) tail: String,
    /// The line an `around` page centres on, when it is still kept.
    pub(crate) anchor: Option<String>,
}

/// How many lines carry each value, each dimension counted with every
/// other filter applied.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "observe/")]
pub(crate) struct LogFacets {
    /// Lines the engine keeps.
    #[ts(type = "number")]
    pub(crate) kept: u64,
    /// Lines that match every filter.
    #[ts(type = "number")]
    pub(crate) matched: u64,
    /// Debug, info, warn and error, always all four, in that order.
    pub(crate) levels: Vec<LogFacetCount>,
    pub(crate) services: Vec<LogFacetCount>,
    pub(crate) functions: Vec<LogFacetCount>,
    pub(crate) instances: Vec<LogFacetCount>,
    pub(crate) codebases: Vec<LogFacetCount>,
    pub(crate) kinds: Vec<LogFacetCount>,
    /// Engine internals the filter leaves out (0 when it asks for them).
    #[ts(type = "number")]
    pub(crate) internal_hidden: u64,
}

/// One value of a facet and how many lines carry it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export_to = "observe/")]
pub(crate) struct LogFacetCount {
    pub(crate) value: String,
    #[ts(type = "number")]
    pub(crate) count: u64,
}

/// Lines per time bucket by level.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "observe/")]
pub(crate) struct LogHistogram {
    /// The window's start, RFC 3339.
    pub(crate) from: String,
    /// The window's end, RFC 3339.
    pub(crate) to: String,
    /// How long each bucket is, in milliseconds.
    #[ts(type = "number")]
    pub(crate) bucket_ms: u64,
    pub(crate) buckets: Vec<LogLevelCounts>,
}

/// `logs.entries` parameters: the same filter as `GET /logs/entries`.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LogsTopicParams {
    q: Option<String>,
    from: Option<String>,
    to: Option<String>,
}

/// What the Logs routes share.
#[derive(Clone)]
pub(crate) struct LogsApi {
    pub(crate) log: Option<ConsoleLog>,
    pub(crate) project: Arc<str>,
    pub(crate) shutdown: Shutdown,
}

impl LogsApi {
    fn log(&self) -> Result<&ConsoleLog, ApiError> {
        self.log
            .as_ref()
            .ok_or_else(|| ApiError::unavailable("This console runs without a suite log."))
    }
}

/// The Logs routes.
pub(crate) fn router(api: LogsApi) -> Router {
    Router::new()
        .route("/logs/entries", get(entries))
        .route("/logs/entries:export", get(export))
        .route("/logs/entries/{cursor}", get(entry))
        .route("/logs/facets", get(facets))
        .route("/logs/histogram", get(histogram))
        .with_state(api)
}

/// The filter every Logs route reads.
#[derive(Debug, Default, Deserialize)]
struct FilterParams {
    q: Option<String>,
    from: Option<String>,
    to: Option<String>,
}

impl FilterParams {
    fn compile(&self, log: &ConsoleLog) -> Result<LogFilter, ApiError> {
        compile(
            log,
            self.q.as_deref(),
            self.from.as_deref(),
            self.to.as_deref(),
        )
    }
}

fn compile(
    log: &ConsoleLog,
    q: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<LogFilter, ApiError> {
    let reload = log.last_reload().map(|(_, time)| time);
    LogFilter::parse(q, window(from, to, reload, OffsetDateTime::now_utc())?)
}

/// `GET /logs/entries` parameters.
#[derive(Debug, Default, Deserialize)]
struct EntriesParams {
    #[serde(flatten)]
    filter: FilterParams,
    before: Option<String>,
    after: Option<String>,
    around: Option<String>,
    limit: Option<String>,
    each: Option<String>,
}

/// A count parameter between 1 and `max`, `default` when absent.
fn count(value: Option<&str>, name: &str, max: usize, default: usize) -> Result<usize, ApiError> {
    let Some(value) = value else {
        return Ok(default);
    };
    value
        .parse::<usize>()
        .ok()
        .filter(|count| (1..=max).contains(count))
        .ok_or_else(|| ApiError::invalid(format!("`{name}` is a number from 1 to {max}.")))
}

/// The sequence of a cursor this engine run wrote.
fn sequence(log: &ConsoleLog, cursor: &str) -> Result<u64, ApiError> {
    let cursor = cursor
        .parse::<Cursor>()
        .map_err(|_| ApiError::invalid("This cursor is not one this engine wrote."))?;
    if cursor.epoch != log.epoch() {
        return Err(
            ApiError::not_found("This line was logged by an earlier run of the engine.")
                .with_fix("Open the latest lines instead; the engine keeps only this run's."),
        );
    }
    Ok(cursor.seq)
}

/// `20,000`.
pub(crate) fn grouped(number: usize) -> String {
    let digits = number.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// What to pass as `before` and `after` around a slice.
struct Edges {
    older: Option<u64>,
    newer: Option<u64>,
}

/// `GET /logs/entries`: the newest matching lines (before `before`), the
/// oldest after `after`, or those around `around`.
async fn entries(
    State(api): State<LogsApi>,
    Query(params): Query<EntriesParams>,
) -> Result<Response, ApiError> {
    let log = api.log()?.clone();
    let filter = params.filter.compile(&log)?;
    let positions = [&params.before, &params.after, &params.around]
        .into_iter()
        .filter(|position| position.is_some())
        .count();
    if positions > 1 {
        return Err(ApiError::invalid(
            "Use one of `before`, `after` and `around` in one request.",
        ));
    }
    let limit = count(params.limit.as_deref(), "limit", PAGE_LIMIT, PAGE_DEFAULT)?;
    let each = count(params.each.as_deref(), "each", AROUND_LIMIT, AROUND_DEFAULT)?;
    let before = params
        .before
        .as_deref()
        .map(|cursor| sequence(&log, cursor))
        .transpose()?;
    let after = params
        .after
        .as_deref()
        .map(|cursor| sequence(&log, cursor))
        .transpose()?;
    let around = params
        .around
        .as_deref()
        .map(|cursor| sequence(&log, cursor))
        .transpose()?;
    let epoch = log.epoch();
    let body = blocking("the log query", move || {
        let (slice, edges) = if let Some(seq) = around {
            let slice = log.around(&filter, seq, each);
            let edges = Edges {
                older: slice
                    .has_older
                    .then(|| slice.lines.first().map(|line| line.seq))
                    .flatten(),
                newer: slice
                    .has_newer
                    .then(|| slice.lines.last().map(|line| line.seq))
                    .flatten(),
            };
            (slice, edges)
        } else if let Some(after) = after {
            let slice = log.forward(&filter, after, limit);
            let edges = Edges {
                older: slice.has_older.then(|| {
                    slice
                        .lines
                        .first()
                        .map_or(after.saturating_add(1), |line| line.seq)
                }),
                newer: slice
                    .has_newer
                    .then(|| slice.lines.last().map(|line| line.seq))
                    .flatten(),
            };
            (slice, edges)
        } else {
            let slice = log.page(&filter, before, limit);
            let edges = Edges {
                older: slice
                    .has_older
                    .then(|| slice.lines.first().map(|line| line.seq))
                    .flatten(),
                newer: slice.has_newer.then(|| {
                    slice
                        .lines
                        .last()
                        .map_or_else(|| before.unwrap_or(1).saturating_sub(1), |line| line.seq)
                }),
            };
            (slice, edges)
        };
        Ok(page_json(&slice, &edges, epoch))
    })
    .await?;
    Ok(json_response(body))
}

/// A [`LogPage`] assembled from the lines' stored JSON.
fn page_json(slice: &LogSlice, edges: &Edges, epoch: u32) -> String {
    let cursor = |seq: u64| Cursor { epoch, seq }.to_string();
    let quoted = |seq: Option<u64>| {
        seq.map_or_else(|| "null".to_owned(), |seq| format!("\"{}\"", cursor(seq)))
    };
    let length = slice
        .lines
        .iter()
        .map(|line| line.json.len() + 1)
        .sum::<usize>();
    let mut body = String::with_capacity(length + 160);
    body.push_str("{\"items\":[");
    for (index, line) in slice.lines.iter().enumerate() {
        if index > 0 {
            body.push(',');
        }
        body.push_str(&line.json);
    }
    body.push_str("],\"older\":");
    body.push_str(&quoted(edges.older));
    body.push_str(",\"newer\":");
    body.push_str(&quoted(edges.newer));
    body.push_str(",\"tail\":\"");
    body.push_str(&cursor(slice.tail));
    body.push_str("\",\"anchor\":");
    body.push_str(&quoted(slice.anchor));
    body.push('}');
    body
}

fn json_response(body: String) -> Response {
    (
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        )],
        body,
    )
        .into_response()
}

/// `GET /logs/entries/{cursor}`: one line.
async fn entry(
    State(api): State<LogsApi>,
    Path(cursor): Path<String>,
) -> Result<Response, ApiError> {
    let log = api.log()?.clone();
    let seq = sequence(&log, &cursor)?;
    let tail = log.tail().seq;
    let line = blocking("the log query", move || Ok(log.get(seq))).await?;
    match line {
        Some(line) => Ok(json_response(line.json.to_string())),
        None if seq > tail || seq == 0 => Err(ApiError::not_found(format!(
            "No line {cursor} has been logged yet."
        ))),
        None => Err(ApiError::not_found(format!(
            "The engine no longer keeps line {cursor}; it keeps the newest {}.",
            grouped(CONSOLE_LOG_ENTRIES)
        ))
        .with_fix("Open the latest lines, or a time range, instead.")),
    }
}

/// `GET /logs/facets`.
async fn facets(
    State(api): State<LogsApi>,
    Query(params): Query<FilterParams>,
) -> Result<axum::Json<LogFacets>, ApiError> {
    let log = api.log()?.clone();
    let filter = params.compile(&log)?;
    let facets = blocking("the log query", move || Ok(log.facets(&filter))).await?;
    Ok(axum::Json(log_facets(facets)))
}

fn log_facets(facets: Facets) -> LogFacets {
    let counts = |counts: Vec<(String, u64)>| {
        counts
            .into_iter()
            .map(|(value, count)| LogFacetCount { value, count })
            .collect()
    };
    LogFacets {
        kept: facets.kept,
        matched: facets.matched,
        levels: ["debug", "info", "warn", "error"]
            .into_iter()
            .zip(facets.levels)
            .map(|(value, count)| LogFacetCount {
                value: value.to_owned(),
                count,
            })
            .collect(),
        services: counts(facets.services),
        functions: counts(facets.functions),
        instances: counts(facets.instances),
        codebases: counts(facets.codebases),
        kinds: counts(facets.kinds),
        internal_hidden: facets.internal_hidden,
    }
}

/// `GET /logs/histogram` parameters.
#[derive(Debug, Default, Deserialize)]
struct HistogramParams {
    #[serde(flatten)]
    filter: FilterParams,
    buckets: Option<String>,
}

/// `GET /logs/histogram`: matching lines per bucket by level, over the
/// window, or from the oldest line the filter reads to now.
async fn histogram(
    State(api): State<LogsApi>,
    Query(params): Query<HistogramParams>,
) -> Result<axum::Json<LogHistogram>, ApiError> {
    let log = api.log()?.clone();
    let filter = params.filter.compile(&log)?;
    let buckets = count(
        params.buckets.as_deref(),
        "buckets",
        BUCKETS_LIMIT,
        BUCKETS_DEFAULT,
    )?;
    let histogram = blocking("the log query", move || {
        Ok(log.histogram(&filter, buckets, now_millis()))
    })
    .await?;
    Ok(axum::Json(LogHistogram {
        from: format_millis(histogram.from_ms),
        to: format_millis(histogram.to_ms),
        bucket_ms: u64::try_from(histogram.bucket_ms).unwrap_or(1),
        buckets: histogram.buckets,
    }))
}

/// `GET /logs/entries:export` parameters.
#[derive(Debug, Default, Deserialize)]
struct ExportParams {
    #[serde(flatten)]
    filter: FilterParams,
    format: Option<String>,
}

/// What an export is written as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExportFormat {
    /// One [`LogEntry`] per line.
    Ndjson,
    /// `2026-10-12T04:06:09.126Z WARN  functions[us-central1-hello] Cart is empty`.
    Text,
}

/// `GET /logs/entries:export`: every matching line, oldest first, streamed
/// as a file from a snapshot (no lock is held while the browser reads it),
/// ending when the suite stops.
async fn export(
    State(api): State<LogsApi>,
    Query(params): Query<ExportParams>,
) -> Result<Response, ApiError> {
    let log = api.log()?.clone();
    let format = match params.format.as_deref().unwrap_or("ndjson") {
        "ndjson" => ExportFormat::Ndjson,
        "text" => ExportFormat::Text,
        other => {
            return Err(ApiError::invalid(format!(
                "`format` is ndjson or text, not `{other}`."
            )));
        }
    };
    let filter = params.filter.compile(&log)?;
    let lines = blocking("the log export", move || Ok(log.export(&filter))).await?;
    let now = OffsetDateTime::now_utc();
    let stamp = format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    );
    let (extension, content_type) = match format {
        ExportFormat::Ndjson => ("ndjson", "application/x-ndjson"),
        ExportFormat::Text => ("txt", "text/plain; charset=utf-8"),
    };
    let filename = format!("firenook-logs-{}-{stamp}.{extension}", api.project);
    let chunks: Vec<Vec<Arc<LogMeta>>> = lines
        .chunks(EXPORT_CHUNK)
        .map(<[Arc<LogMeta>]>::to_vec)
        .collect();
    let body = stream::iter(chunks)
        .map(move |chunk| {
            let mut bytes = String::new();
            for line in &chunk {
                match format {
                    ExportFormat::Ndjson => {
                        bytes.push_str(&line.json);
                        bytes.push('\n');
                    }
                    ExportFormat::Text => text_line(&line.json, &mut bytes),
                }
            }
            Ok::<_, std::convert::Infallible>(Bytes::from(bytes))
        })
        .take_until(api.shutdown.clone().stopped());
    let [disposition] = attachment(&filename);
    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            disposition,
        ],
        Body::from_stream(body),
    )
        .into_response())
}

/// One line of a text export: the time, the level padded to five, the
/// source (or the service), the message with its later lines indented, and
/// the payload's JSON on the next line.
fn text_line(json: &str, out: &mut String) {
    let Ok(entry) = serde_json::from_str::<LogEntry>(json) else {
        return;
    };
    let _ = write!(out, "{} {:<5} ", entry.time, entry.level.legacy());
    out.push_str(entry.source.as_deref().unwrap_or(&entry.service));
    out.push(' ');
    for (index, line) in entry.message.lines().enumerate() {
        if index > 0 {
            out.push_str("\n    ");
        }
        out.push_str(line);
    }
    out.push('\n');
    if let Some(payload) = &entry.payload {
        out.push_str("    ");
        out.push_str(&payload.to_string());
        out.push('\n');
    }
}

/// The `logs.entries` topic: matching lines as they arrive, replayed from
/// the log after the subscriber's cursor.
pub(crate) struct LogsTopic {
    pub(crate) log: Option<ConsoleLog>,
}

impl LiveTopic for LogsTopic {
    fn name(&self) -> &'static str {
        "logs.entries"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: LogsTopicParams = topic_params(params)?;
        let log = self
            .log
            .as_ref()
            .ok_or_else(|| ApiError::unavailable("This console runs without a suite log."))?;
        let filter = compile(
            log,
            params.q.as_deref(),
            params.from.as_deref(),
            params.to.as_deref(),
        )?;
        Ok(entries_topic(log, &Arc::new(filter), after))
    }
}

/// The replay options of one subscription: its filter, the foundation's
/// batching (at most one event per 100 ms) and a 512 KiB cap per event.
fn options(filter: &SharedFilter) -> ReplayOptions<Arc<LogMeta>> {
    let filter = Arc::clone(filter);
    ReplayOptions {
        filter: Some(Arc::new(move |meta: &Arc<LogMeta>| filter.matches(meta))),
        shape: None,
        max_items: TOPIC_ITEMS,
        max_bytes: TOPIC_BYTES,
    }
}

/// The `logs.entries` stream after `after`: the foundation's replay over
/// the main ring. A problems-only filter first sends the problems the main
/// ring has already evicted (from the problem ring), so `level:error` after
/// a flood still delivers the errors before it, and says the subscriber
/// missed lines only when the problem ring lost some too.
pub(crate) fn entries_topic(
    log: &ConsoleLog,
    filter: &SharedFilter,
    after: Option<&str>,
) -> TopicStream {
    let main = log.main_ring();
    let plain = || replay_topic(main, after, "entries", options(filter));
    if !filter.problems_only() {
        return plain();
    }
    let Some(first) = main.oldest() else {
        return plain();
    };
    let epoch = log.epoch();
    let tail = log.tail();
    // None: no cursor; Some(None): another run's or a malformed one.
    let resumed = after.map(|after| {
        after
            .parse::<Cursor>()
            .ok()
            .filter(|cursor| cursor.epoch == epoch && cursor.seq <= tail.seq)
    });
    let from = match resumed {
        Some(Some(cursor)) => cursor.seq,
        _ => 0,
    };
    if from + 1 >= first.seq {
        return plain();
    }
    let problems = log.problem_lines();
    let mut events = Vec::new();
    let foreign = matches!(resumed, Some(None));
    let lost = matches!(resumed, Some(Some(_)))
        && log.problems_evicted()
        && problems.first().is_none_or(|line| line.seq > from + 1);
    if foreign || lost {
        events.push(TopicEvent::Reset {
            reason: ResetReason::Gap,
            missed: None,
        });
    }
    let older: Vec<&Arc<LogMeta>> = problems
        .iter()
        .filter(|line| line.seq > from && line.seq < first.seq && filter.matches(line))
        .collect();
    let mut window: Vec<&Arc<LogMeta>> = Vec::new();
    let mut bytes = 0;
    let mut flush = |window: &mut Vec<&Arc<LogMeta>>, bytes: &mut usize| {
        if let Some(last) = window.last() {
            let mut data = String::with_capacity(*bytes + window.len() + 12);
            data.push_str("{\"items\":[");
            for (index, line) in window.iter().enumerate() {
                if index > 0 {
                    data.push(',');
                }
                data.push_str(&line.json);
            }
            data.push_str("]}");
            events.push(TopicEvent::Event {
                name: "entries",
                cursor: Some(Arc::from(last.cursor(epoch).to_string())),
                data: Arc::from(data),
            });
        }
        window.clear();
        *bytes = 0;
    };
    for line in older {
        if !window.is_empty()
            && (window.len() == TOPIC_ITEMS || bytes + line.json.len() > TOPIC_BYTES)
        {
            flush(&mut window, &mut bytes);
        }
        bytes += line.json.len();
        window.push(line);
    }
    flush(&mut window, &mut bytes);
    let resume = Cursor {
        epoch,
        seq: first.seq - 1,
    }
    .to_string();
    let rest = replay_topic(main, Some(&resume), "entries", options(filter));
    stream::iter(events).chain(rest).boxed()
}

#[cfg(test)]
#[path = "logs_tests.rs"]
mod tests;
