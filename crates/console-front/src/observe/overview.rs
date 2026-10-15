//! The Overview's own API under `/api/v1/overview`: the state (configuration
//! notices, the newest problems, how many were logged, and the last hour's
//! volume), the engine details, and the `overview` topic.
//!
//! Section figures are not here: they are each section's summary in the
//! console status. Everything the state holds is O(1) to read: the notices
//! are fixed for the engine run, the problem count and the hour are
//! counters the log keeps, and the problems are the newest entries of the
//! problem ring.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use firenook_suite_front::{EntityRef, LogLevel, OverviewEngineDetails, OverviewNotice};
use futures_util::StreamExt as _;
use futures_util::stream;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tokio::time::Instant;
use ts_rs::TS;

use super::log::{ConsoleLog, LogEntry, LogLevelCounts, now_millis};
use crate::api_error::ApiError;
use crate::live::{LiveTopic, TopicEvent, TopicStream, topic_params};
use crate::time::rfc3339_now;

/// Problems the Overview lists.
const PROBLEMS: usize = 8;
/// The longest first line of a problem the Overview shows, in characters.
const FIRST_LINE_CHARS: usize = 200;
/// The `overview` topic sends a state at most this often.
const STATE_EVERY: Duration = Duration::from_millis(500);

/// `GET /overview` and the `overview` topic's `state`: notices, recent
/// problems, how many were logged, and the last hour.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "observe/")]
pub(crate) struct OverviewState {
    /// When this state was made, RFC 3339.
    pub(crate) generated_at: String,
    pub(crate) notices: Vec<OverviewNotice>,
    /// The newest problems (errors, failures, denials), newest first, at
    /// most 8, from the problem ring: a flood does not empty it.
    pub(crate) problems: Vec<OverviewProblem>,
    /// Problems logged since the engine started (errors, failures,
    /// denials), however many the problem ring still holds.
    #[ts(type = "number")]
    pub(crate) problems_logged: u64,
    /// Lines per minute over the last hour by level, oldest first (60
    /// buckets, the last one the current minute).
    pub(crate) hour: Vec<LogLevelCounts>,
}

/// A problem as the Overview lists it: no payload, the first line only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "observe/")]
pub(crate) struct OverviewProblem {
    /// The line's cursor, for `/logs?entry=`.
    pub(crate) cursor: String,
    pub(crate) time: String,
    pub(crate) level: LogLevel,
    pub(crate) kind: Option<String>,
    /// Where it came from, as a terminal label: the label the line was
    /// printed under, else `functions[<id>]` for a function's line or
    /// `extensions[<id>]` for an instance's, else the service.
    pub(crate) source: String,
    /// The message's first line, at most 200 characters.
    pub(crate) first_line: String,
    pub(crate) refs: Vec<EntityRef>,
}

/// `overview` parameters: none.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct OverviewParams {}

/// What the Overview routes and topic read.
#[derive(Clone)]
pub(crate) struct OverviewApi {
    pub(crate) log: Option<ConsoleLog>,
    pub(crate) engine: Arc<OverviewEngineDetails>,
    pub(crate) notices: Arc<Vec<OverviewNotice>>,
}

impl OverviewApi {
    /// The state now.
    pub(crate) fn state(&self, now_ms: i64) -> OverviewState {
        let Some(log) = &self.log else {
            return OverviewState {
                generated_at: rfc3339_now(),
                notices: self.notices.as_ref().clone(),
                problems: Vec::new(),
                problems_logged: 0,
                hour: vec![LogLevelCounts::default(); 60],
            };
        };
        OverviewState {
            generated_at: rfc3339_now(),
            notices: self.notices.as_ref().clone(),
            problems: log
                .recent_problems(PROBLEMS)
                .iter()
                .filter_map(|line| serde_json::from_str::<LogEntry>(&line.json).ok())
                .map(problem)
                .collect(),
            problems_logged: log.totals().problems,
            hour: log.hour(now_ms).to_vec(),
        }
    }

    /// What a state answers for: the problems and warnings logged (what the
    /// Overview draws: the problem list and the hour's warnings and errors;
    /// every error is a problem) and the minute it is, so a state is resent
    /// when one of them moves, never for a line of plain output.
    fn generation(&self, now_ms: i64) -> String {
        let (problems, warnings) = self.log.as_ref().map_or((0, 0), |log| {
            let totals = log.totals();
            (totals.problems, totals.levels.warn)
        });
        format!("{problems}.{warnings}.{}", now_ms.div_euclid(60_000))
    }
}

/// A kept problem line as the Overview lists it.
fn problem(entry: LogEntry) -> OverviewProblem {
    let first_line: String = entry
        .message
        .lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(FIRST_LINE_CHARS)
        .collect();
    OverviewProblem {
        cursor: entry.cursor,
        time: entry.time,
        level: entry.level,
        kind: entry.kind,
        // An attributed Functions line is printed under `functions`; the
        // function it names is its source.
        source: entry
            .source
            .or_else(|| entry.function.map(|id| format!("functions[{id}]")))
            .or_else(|| entry.extension.map(|id| format!("extensions[{id}]")))
            .unwrap_or(entry.service),
        first_line,
        refs: entry.refs,
    }
}

/// `GET /overview` and `GET /overview/engine`.
pub(crate) fn router(api: OverviewApi) -> Router {
    Router::new()
        .route("/overview", get(overview))
        .route("/overview/engine", get(engine))
        .with_state(api)
}

async fn overview(State(api): State<OverviewApi>) -> Json<OverviewState> {
    Json(api.state(now_millis()))
}

async fn engine(State(api): State<OverviewApi>) -> Json<OverviewEngineDetails> {
    Json(api.engine.as_ref().clone())
}

/// The `overview` topic: the state on open (unless the subscriber's
/// cursor says it has this one), then again whenever a warning or a
/// problem arrives or the minute turns, at most twice a second. A flood of
/// plain output neither wakes it nor resends anything.
pub(crate) struct OverviewTopic {
    pub(crate) api: OverviewApi,
    /// The wall clock, in milliseconds since the epoch. A generation names
    /// the minute, so a test that waits for quiet pins it: with the real
    /// clock, a minute turning inside the wait is (rightly) news.
    pub(crate) now: fn() -> i64,
}

impl OverviewTopic {
    pub(crate) fn new(api: OverviewApi) -> Self {
        Self {
            api,
            now: now_millis,
        }
    }
}

struct Following {
    api: OverviewApi,
    now: fn() -> i64,
    changes: Option<watch::Receiver<u64>>,
    /// The generation the subscriber has.
    seen: Option<String>,
    sent: bool,
}

impl LiveTopic for OverviewTopic {
    fn name(&self) -> &'static str {
        "overview"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let OverviewParams {} = topic_params(params)?;
        let following = Following {
            api: self.api.clone(),
            now: self.now,
            changes: self.api.log.as_ref().map(ConsoleLog::notable_changes),
            seen: after.map(str::to_owned),
            sent: false,
        };
        Ok(stream::unfold(following, |mut following| async move {
            loop {
                if following.sent {
                    tokio::time::sleep(STATE_EVERY).await;
                }
                let generation = following.api.generation((following.now)());
                if following.seen.as_deref() != Some(generation.as_str()) {
                    let state = following.api.state((following.now)());
                    following.seen = Some(generation.clone());
                    following.sent = true;
                    return Some((
                        TopicEvent::json("state", Some(generation), &state),
                        following,
                    ));
                }
                // Nothing new: wait for a warning or a problem, or the next minute.
                let now = (following.now)();
                let next_minute = Instant::now()
                    + Duration::from_millis(
                        u64::try_from(60_000 - now.rem_euclid(60_000)).unwrap_or(60_000),
                    );
                match following.changes.as_mut() {
                    Some(changes) => {
                        tokio::select! {
                            moved = changes.changed() => {
                                if moved.is_err() {
                                    return None;
                                }
                            }
                            () = tokio::time::sleep_until(next_minute) => {}
                        }
                    }
                    None => tokio::time::sleep_until(next_minute).await,
                }
                following.sent = false;
            }
        })
        .boxed())
    }
}

#[cfg(test)]
#[path = "overview_tests.rs"]
mod tests;
