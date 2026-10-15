//! Every Firestore rules decision, as the console shows it: a ring of
//! summaries that is the `firestore.decisions` topic.
//!
//! The rules page used to read the official Requests websocket
//! (`/firestore/requests`), which the Google Emulator UI and the conformance
//! fixtures pin: four clients at most, 256 decisions of the last ten
//! minutes, every event whole with its ruleset's source, filtered in the
//! browser. A fifth console tab was refused, and "See why" on a denial from
//! a quarter of an hour ago found nothing. That socket stays exactly as it
//! is for them; the console reads this topic instead, on its one live
//! channel, shared by every tab.
//!
//! A forwarder copies each decision the evaluation path records (the rules
//! runtime's decision tap, fed beside the Requests event and the retained
//! context) into a ring of 10,000 summaries within 8 MiB; one that falls
//! behind counts what it missed, and the window says so. The topic's
//! parameters — database, a path and everything under it, uid, denials
//! only, one method — are evaluated by the engine on the replay and on the
//! live tail. A decision's detail and "why" are `GET /rules/decisions/{id}`,
//! which re-runs the newest 2,000 the runtime retains.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use firenook_rules_engine::{AllowDecision, RequestOperation, Timestamp};
use firenook_rules_runtime::{DenialOrigin, RecordedDecision, RulesRuntime};
use firenook_suite_front::replay::random_epoch;
use firenook_suite_front::{Cursor, Entry, ReplayRing, RingBudget, RingLimits};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::broadcast::error::RecvError;
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::live::replay::{ReplayOptions, replay_topic};
use crate::live::{LiveTopic, TopicStream, topic_params};
use crate::rules_eval::{RulesMethod, RulesOutcome};
use crate::sse::Shutdown;

/// The decision summaries: 10,000, 8 MiB.
const FEED_RING: RingLimits = RingLimits {
    entries: 10_000,
    bytes: 8 * 1024 * 1024,
    floor: 1_000,
};

/// `firestore.decisions` params, every one evaluated by the engine.
#[derive(Clone, Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FirestoreDecisionsParams {
    /// A database id; absent is every database.
    #[ts(optional)]
    pub database: Option<String>,
    /// A relative path: the decisions about it and everything under it (a
    /// collection's documents, a document's subcollections).
    #[ts(optional)]
    pub path: Option<String>,
    #[ts(optional)]
    pub uid: Option<String>,
    /// Only `deny` and `error` outcomes.
    #[serde(default)]
    #[ts(optional, as = "Option<bool>")]
    pub denied: bool,
    #[ts(optional)]
    pub method: Option<RulesMethod>,
}

/// One allow statement a decision ran, and what its condition came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FirestoreDecisionLine {
    /// One-based line of the allow statement.
    #[ts(type = "number")]
    pub line: usize,
    pub outcome: RulesOutcome,
}

/// One request the Firestore rules judged.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FirestoreDecision {
    /// The Requests feed's `requestId`; `GET /rules/decisions/{id}` re-runs it.
    pub id: String,
    /// `request.time`, RFC 3339.
    pub at: String,
    pub database: String,
    pub method: RulesMethod,
    /// Relative to the database: a document; for a list, the collection, or
    /// for a collection group the group's id after the recursive wildcard,
    /// as a refusal in the log names it.
    pub path: String,
    pub outcome: RulesOutcome,
    /// The evaluator's error when it failed rather than denied.
    pub error: Option<String>,
    pub uid: Option<String>,
    /// The token's tenant, for a link to the Auth user; null for project
    /// users.
    pub tenant: Option<String>,
    pub provider: Option<String>,
    /// No credentials at all.
    pub anonymous: bool,
    /// The allow statements it ran, in order.
    pub allows: Vec<FirestoreDecisionLine>,
    /// The hash of the ruleset that decided it.
    pub rules_hash: String,
    /// Asked by the console's own REST mount (a "View as" read).
    pub via_console: bool,
}

/// `firestore.decisions` `decisions`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[allow(
    dead_code,
    reason = "the topic's event, written by its shaper from the ring's JSON; the type is the console's"
)]
pub(crate) struct FirestoreDecisionBatch {
    pub items: Vec<FirestoreDecision>,
    pub window: FirestoreDecisionWindow,
}

/// What the engine still holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FirestoreDecisionWindow {
    /// Decisions in the feed (at most 10,000).
    pub retained: u32,
    /// The oldest one's time, RFC 3339; null when empty.
    pub since: Option<String>,
    /// How many of the newest can be re-run for why and impact (at most
    /// 2,000, every database together).
    pub re_runnable: u32,
    /// Decisions the feed missed because its forwarder fell behind.
    #[ts(type = "number")]
    pub omitted: u64,
}

/// What a ring entry carries beside its JSON, for the topic's filters.
#[derive(Clone, Debug)]
pub(crate) struct DecisionMeta {
    database: Arc<str>,
    path: Arc<str>,
    uid: Option<Arc<str>>,
    method: RulesMethod,
    denied: bool,
}

impl FirestoreDecisionsParams {
    /// Whether a decision passes these params.
    fn keeps(&self, meta: &DecisionMeta) -> bool {
        self.database
            .as_deref()
            .is_none_or(|database| *meta.database == *database)
            && self.path.as_deref().is_none_or(|path| {
                let path = path.trim_matches('/');
                path.is_empty()
                    || *meta.path == *path
                    || meta
                        .path
                        .strip_prefix(path)
                        .is_some_and(|rest| rest.starts_with('/'))
            })
            && self
                .uid
                .as_deref()
                .is_none_or(|uid| meta.uid.as_deref() == Some(uid))
            && (!self.denied || meta.denied)
            && self.method.is_none_or(|method| method == meta.method)
    }
}

struct FeedInner {
    ring: ReplayRing<DecisionMeta>,
    /// When each pushed entry was decided, in ring order, to say when the
    /// window starts.
    times: Mutex<VecDeque<(Cursor, String)>>,
    omitted: AtomicU64,
    rules: RulesRuntime,
}

/// The decision feed. Cheap to clone.
#[derive(Clone)]
pub(crate) struct DecisionFeed {
    inner: Arc<FeedInner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn rfc3339(time: Timestamp) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(
        i128::from(time.seconds()) * 1_000_000_000 + i128::from(time.nanoseconds()),
    )
    .ok()
    .and_then(|at| at.format(&Rfc3339).ok())
    .unwrap_or_default()
}

const fn method_of(operation: RequestOperation) -> RulesMethod {
    match operation {
        RequestOperation::Get => RulesMethod::Get,
        RequestOperation::List => RulesMethod::List,
        RequestOperation::Create => RulesMethod::Create,
        RequestOperation::Update => RulesMethod::Update,
        RequestOperation::Delete => RulesMethod::Delete,
    }
}

/// The console's summary of one recorded decision.
pub(crate) fn summary(record: &RecordedDecision) -> FirestoreDecision {
    FirestoreDecision {
        id: record.request_id.to_string(),
        at: rfc3339(record.time),
        database: record.database.database_id().to_owned(),
        method: method_of(record.operation),
        path: record.relative_path().to_owned(),
        outcome: record.outcome.into(),
        error: record.error.clone(),
        uid: record.uid.clone(),
        tenant: record.tenant.clone(),
        provider: record.provider.clone(),
        anonymous: record.anonymous,
        allows: record
            .allows
            .iter()
            .map(|allow| FirestoreDecisionLine {
                line: allow.location.line,
                outcome: match allow.decision {
                    AllowDecision::Allow => RulesOutcome::Allow,
                    AllowDecision::Deny => RulesOutcome::Deny,
                    AllowDecision::Error => RulesOutcome::Error,
                },
            })
            .collect(),
        rules_hash: record.rules_hash.to_string(),
        via_console: record.origin == DenialOrigin::Console,
    }
}

impl DecisionFeed {
    /// The feed of `rules`' recorded decisions (none without diagnostics),
    /// forwarding until `shutdown`.
    pub(crate) fn start(
        rules: &RulesRuntime,
        budget: &RingBudget,
        shutdown: Shutdown,
    ) -> Option<Self> {
        if !rules.retains_decisions() {
            return None;
        }
        let mut receiver = rules.subscribe_decisions();
        let feed = Self {
            inner: Arc::new(FeedInner {
                ring: ReplayRing::new("firestore.decisions", FEED_RING, random_epoch(), budget),
                times: Mutex::new(VecDeque::new()),
                omitted: AtomicU64::new(0),
                rules: rules.clone(),
            }),
        };
        let forwarder = feed.clone();
        let stopped = shutdown.stopped();
        tokio::spawn(async move {
            tokio::pin!(stopped);
            loop {
                tokio::select! {
                    biased;
                    () = &mut stopped => return,
                    incoming = receiver.recv() => match incoming {
                        Ok(record) => forwarder.record(&record),
                        Err(RecvError::Lagged(missed)) => {
                            forwarder.inner.omitted.fetch_add(missed, Ordering::Relaxed);
                        }
                        Err(RecvError::Closed) => return,
                    },
                }
            }
        });
        Some(feed)
    }

    /// Appends one decision to the ring.
    fn record(&self, record: &RecordedDecision) {
        let decision = summary(record);
        let meta = DecisionMeta {
            database: Arc::from(decision.database.as_str()),
            path: Arc::from(decision.path.as_str()),
            uid: decision.uid.as_deref().map(Arc::from),
            method: decision.method,
            denied: decision.outcome != RulesOutcome::Allow,
        };
        let json: Arc<str> = Arc::from(serde_json::to_string(&decision).unwrap_or_default());
        let mut times = lock(&self.inner.times);
        let cursor = self.inner.ring.push(meta, json);
        times.push_back((cursor, decision.at));
        let oldest = self.inner.ring.oldest();
        while times
            .front()
            .is_some_and(|(cursor, _)| oldest.is_none_or(|oldest| *cursor < oldest))
        {
            times.pop_front();
        }
    }

    /// What the engine holds now.
    pub(crate) fn window(&self) -> FirestoreDecisionWindow {
        let (re_runnable, _) = self.inner.rules.retained_counts();
        FirestoreDecisionWindow {
            retained: u32::try_from(self.inner.ring.len()).unwrap_or(u32::MAX),
            since: lock(&self.inner.times).front().map(|(_, at)| at.clone()),
            re_runnable: u32::try_from(re_runnable).unwrap_or(u32::MAX),
            omitted: self.inner.omitted.load(Ordering::Relaxed),
        }
    }
}

/// The live channel's `firestore.decisions` topic: `decisions` →
/// [`FirestoreDecisionBatch`], the params evaluated by the engine, replayed
/// from the ring's cursor.
pub(crate) struct DecisionsTopic(pub(crate) DecisionFeed);

impl LiveTopic for DecisionsTopic {
    fn name(&self) -> &'static str {
        "firestore.decisions"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: FirestoreDecisionsParams = topic_params(params)?;
        let feed = self.0.clone();
        let filter = Arc::new(params);
        Ok(replay_topic(
            &self.0.inner.ring,
            after,
            "decisions",
            ReplayOptions {
                filter: Some(Arc::new(move |meta: &DecisionMeta| filter.keeps(meta))),
                shape: Some(Box::new(move |entries: &[Entry<DecisionMeta>]| {
                    let window = serde_json::to_string(&feed.window()).unwrap_or_default();
                    let mut data = String::with_capacity(
                        entries
                            .iter()
                            .map(|entry| entry.json.len() + 1)
                            .sum::<usize>()
                            + window.len()
                            + 24,
                    );
                    data.push_str("{\"items\":[");
                    for (index, entry) in entries.iter().enumerate() {
                        if index > 0 {
                            data.push(',');
                        }
                        data.push_str(&entry.json);
                    }
                    data.push_str("],\"window\":");
                    data.push_str(&window);
                    data.push('}');
                    Some(Arc::from(data))
                })),
                ..ReplayOptions::default()
            },
        ))
    }
}

#[cfg(test)]
#[path = "firestore_decisions_tests.rs"]
mod tests;
