//! Every rules decision Storage recorded, as the console shows it: a ring of
//! summaries that is the `storage.decisions` topic, an index by object so
//! one file's decisions cost what they number, and a `storage.denied` log
//! line for each refusal.
//!
//! The ring holds 10,000 summaries (8 MiB); the engine keeps the newest
//! 2,000 re-runnable for "Why". A forwarder copies each recorded decision
//! from storage-front's broadcast into the ring and the index; one that
//! falls behind counts what it missed, and the window says so. Denials are
//! logged at most 50 a second; past that, one line says how many more were
//! not logged one by one.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use firenook_storage_front::{
    DecisionLog, DecisionOutcome, Operation, StorageDecisionRecord, StorageRulesHandle,
};
use firenook_suite_front::replay::random_epoch;
use firenook_suite_front::{
    Audience, Cursor, EntityRef, Entry, LogInput, LogLevel, LoggingRuntime, ReplayRing, RingBudget,
    RingLimits, kinds,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::broadcast::error::RecvError;
use ts_rs::TS;

use super::rules::{StorageDecision, allow_trace, method_of};
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
/// Denial lines one second carries before they are counted instead.
const DENIALS_PER_SECOND: u32 = 50;

/// `storage.decisions` params, every one evaluated by the engine.
#[derive(Clone, Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "storage/")]
pub(crate) struct StorageDecisionsParams {
    #[ts(optional)]
    pub bucket: Option<String>,
    /// A folder (ending in `/`, or empty) matches everything under it; any
    /// other value one exact name.
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

/// `storage.decisions` `decisions`, and `GET /storage/rules/decisions`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageDecisionBatch {
    pub items: Vec<StorageDecision>,
    pub window: StorageDecisionWindow,
}

/// What the engine still holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageDecisionWindow {
    /// Decisions in the feed (at most 10,000).
    pub retained: u32,
    /// The oldest one's time, RFC 3339; null when empty.
    pub since: Option<String>,
    /// How many of the newest can be re-run for Why and impact (at most
    /// 2,000).
    pub re_runnable: u32,
    /// Decisions the feed missed because its forwarder fell behind.
    #[ts(type = "number")]
    pub omitted: u64,
}

/// What a ring entry carries beside its JSON, for the topic's filters and
/// the first paint.
#[derive(Clone, Debug)]
pub(crate) struct DecisionMeta {
    decision: Arc<StorageDecision>,
    bucket: Arc<str>,
    path: Arc<str>,
    uid: Option<Arc<str>>,
    method: RulesMethod,
    denied: bool,
}

impl StorageDecisionsParams {
    /// Whether a decision passes these params.
    fn keeps(&self, meta: &DecisionMeta) -> bool {
        self.bucket
            .as_deref()
            .is_none_or(|bucket| *meta.bucket == *bucket)
            && self.path.as_deref().is_none_or(|path| {
                if path.is_empty() || path.ends_with('/') {
                    meta.path.starts_with(path)
                } else {
                    *meta.path == *path
                }
            })
            && self
                .uid
                .as_deref()
                .is_none_or(|uid| meta.uid.as_deref() == Some(uid))
            && (!self.denied || meta.denied)
            && self.method.is_none_or(|method| method == meta.method)
    }
}

/// A bucket and an object name.
type ObjectKey = (Arc<str>, Arc<str>);

/// Decisions by object, pruned as the ring forgets them.
#[derive(Default)]
struct NameIndex {
    by_name: HashMap<ObjectKey, VecDeque<(Cursor, Arc<StorageDecision>)>>,
    /// Every pushed key in ring order, with its time, to prune and to say
    /// when the window starts.
    order: VecDeque<(Cursor, ObjectKey, OffsetDateTime)>,
}

impl NameIndex {
    fn prune(&mut self, oldest: Option<Cursor>) {
        while let Some((cursor, key, _)) = self.order.front() {
            if oldest.is_some_and(|oldest| *cursor >= oldest) {
                break;
            }
            let key = key.clone();
            self.order.pop_front();
            if let Some(list) = self.by_name.get_mut(&key) {
                list.pop_front();
                if list.is_empty() {
                    self.by_name.remove(&key);
                }
            }
        }
    }
}

/// Denial lines: at most 50 a second, then a count.
struct Denials {
    window: Instant,
    logged: u32,
    suppressed: u64,
}

struct FeedInner {
    ring: ReplayRing<DecisionMeta>,
    index: Mutex<NameIndex>,
    omitted: AtomicU64,
    log: Option<Arc<dyn Fn() -> (usize, u64) + Send + Sync>>,
    denials: Mutex<Denials>,
    logging: LoggingRuntime,
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

fn rfc3339(at: OffsetDateTime) -> String {
    at.format(&Rfc3339).unwrap_or_default()
}

/// The console's summary of one decision.
pub(crate) fn summary(record: &StorageDecisionRecord) -> StorageDecision {
    StorageDecision {
        id: record.id.clone(),
        at: rfc3339(record.at),
        bucket: record.bucket.clone(),
        method: method_of(record.operation),
        path: record.name.clone(),
        outcome: record.outcome.into(),
        error: record.error.clone(),
        uid: record.uid.clone(),
        tenant: record.tenant.clone(),
        provider: record.provider.clone(),
        anonymous: record.anonymous,
        allows: record.allows.iter().map(allow_trace).collect(),
        rules_hash: record.rules_hash.clone(),
        no_ruleset: record.no_ruleset,
        size: record.proposed_size,
        content_type: record.proposed_content_type.clone(),
        via_console: record.via_console,
    }
}

impl DecisionFeed {
    /// The feed of `rules`' decision log (none without diagnostics),
    /// forwarding until `shutdown` and logging denials through `logging`.
    pub(crate) fn start(
        rules: Option<&StorageRulesHandle>,
        budget: &RingBudget,
        logging: LoggingRuntime,
        shutdown: Shutdown,
    ) -> Option<Self> {
        let rules = rules?.clone();
        let decisions = rules.decisions()?;
        let mut receiver = decisions.subscribe();
        let counts = {
            let rules = rules.clone();
            Arc::new(move || {
                rules.decisions().map_or((0, 0), |log: &DecisionLog| {
                    (log.re_runnable(), log.omitted())
                })
            })
        };
        let feed = Self {
            inner: Arc::new(FeedInner {
                ring: ReplayRing::new("storage.decisions", FEED_RING, random_epoch(), budget),
                index: Mutex::new(NameIndex::default()),
                omitted: AtomicU64::new(0),
                log: Some(counts),
                denials: Mutex::new(Denials {
                    window: Instant::now(),
                    logged: 0,
                    suppressed: 0,
                }),
                logging,
            }),
        };
        let forwarder = feed.clone();
        let stopped = shutdown.stopped();
        tokio::spawn(async move {
            tokio::pin!(stopped);
            let mut ticks = tokio::time::interval(Duration::from_secs(1));
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
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
                    _ = ticks.tick() => forwarder.flush_denials(),
                }
            }
        });
        Some(feed)
    }

    /// Appends one decision to the ring and the index, and logs a denial.
    fn record(&self, record: &Arc<StorageDecisionRecord>) {
        let decision = Arc::new(summary(record));
        let bucket: Arc<str> = Arc::from(record.bucket.as_str());
        let path: Arc<str> = Arc::from(record.name.as_str());
        let denied = record.outcome != DecisionOutcome::Allow;
        let meta = DecisionMeta {
            decision: Arc::clone(&decision),
            bucket: Arc::clone(&bucket),
            path: Arc::clone(&path),
            uid: record.uid.as_deref().map(Arc::from),
            method: decision.method,
            denied,
        };
        let json: Arc<str> =
            Arc::from(serde_json::to_string(decision.as_ref()).unwrap_or_default());
        let mut index = lock(&self.inner.index);
        // The summary lives twice, as JSON and as the value the first paint
        // reads: both count against the ring's limits.
        let extra = json.len();
        let cursor = self.inner.ring.push_weighted(meta, json, extra);
        let key = (bucket, path);
        index
            .by_name
            .entry(key.clone())
            .or_default()
            .push_back((cursor, Arc::clone(&decision)));
        index.order.push_back((cursor, key, record.at));
        index.prune(self.inner.ring.oldest());
        drop(index);
        if denied {
            self.deny(record);
        }
    }

    /// One `storage.denied` line, within the per-second allowance.
    fn deny(&self, record: &StorageDecisionRecord) {
        {
            let mut denials = lock(&self.inner.denials);
            if denials.window.elapsed() >= Duration::from_secs(1) {
                drop(denials);
                self.flush_denials();
                denials = lock(&self.inner.denials);
            }
            if denials.logged >= DENIALS_PER_SECOND {
                denials.suppressed += 1;
                return;
            }
            denials.logged += 1;
        }
        let who = record
            .uid
            .as_deref()
            .map_or_else(|| "an unauthenticated client".to_owned(), str::to_owned);
        let mut message = format!(
            "Rules denied {} on {} for {who}",
            record.operation.method(),
            if record.name.is_empty() {
                format!("gs://{}", record.bucket)
            } else {
                record.name.clone()
            }
        );
        if let Some(error) = &record.error {
            message.push_str(": ");
            message.push_str(error);
        }
        let mut refs = vec![
            if record.operation == Operation::List {
                EntityRef::storage_folder(&record.bucket, &record.name)
            } else {
                EntityRef::storage_object(&record.bucket, &record.name)
            },
            EntityRef::storage_decision(Some(&record.bucket), &record.id),
        ];
        if let Some(uid) = &record.uid {
            refs.push(EntityRef::auth_user(record.tenant.as_deref(), uid));
        }
        self.inner.logging.emit(LogInput {
            level: if record.via_console {
                LogLevel::Info
            } else {
                LogLevel::Warn
            },
            service: "storage".to_owned(),
            kind: Some(if record.via_console {
                kinds::STORAGE_DENIED_CONSOLE
            } else {
                kinds::STORAGE_DENIED
            }),
            message,
            payload: Some(serde_json::json!({
                "method": record.operation.method(),
                "bucket": record.bucket,
                "path": record.name,
                "uid": record.uid,
                "decision": record.id,
            })),
            refs,
            audience: Audience::Console,
            ..LogInput::default()
        });
    }

    /// Starts a new second, saying how many denials the last one did not
    /// log one by one.
    fn flush_denials(&self) {
        let suppressed = {
            let mut denials = lock(&self.inner.denials);
            if denials.window.elapsed() < Duration::from_secs(1) {
                return;
            }
            denials.window = Instant::now();
            denials.logged = 0;
            std::mem::take(&mut denials.suppressed)
        };
        if suppressed > 0 {
            self.inner.logging.emit(LogInput {
                level: LogLevel::Warn,
                service: "storage".to_owned(),
                kind: Some(kinds::STORAGE_DENIED),
                message: format!(
                    "{suppressed} more {} in the last second {} not logged one by one",
                    if suppressed == 1 { "denial" } else { "denials" },
                    if suppressed == 1 { "was" } else { "were" }
                ),
                audience: Audience::Console,
                ..LogInput::default()
            });
        }
    }

    /// What the engine holds now.
    pub(crate) fn window(&self) -> StorageDecisionWindow {
        let (re_runnable, _) = self.inner.log.as_ref().map_or((0, 0), |counts| counts());
        let index = lock(&self.inner.index);
        StorageDecisionWindow {
            retained: u32::try_from(self.inner.ring.len()).unwrap_or(u32::MAX),
            since: index.order.front().map(|(_, _, at)| rfc3339(*at)),
            re_runnable: u32::try_from(re_runnable).unwrap_or(u32::MAX),
            omitted: self.inner.omitted.load(Ordering::Relaxed),
        }
    }

    /// The decisions the ring holds that pass `params`, oldest first.
    pub(crate) fn snapshot(&self, params: &StorageDecisionsParams) -> StorageDecisionBatch {
        let items = match (&params.bucket, &params.path) {
            // One object: from the index.
            (Some(bucket), Some(path)) if !path.is_empty() && !path.ends_with('/') => self
                .of(bucket, path)
                .into_iter()
                .filter(|decision| {
                    params
                        .uid
                        .as_deref()
                        .is_none_or(|uid| decision.uid.as_deref() == Some(uid))
                        && (!params.denied || decision.outcome != RulesOutcome::Allow)
                        && params.method.is_none_or(|method| method == decision.method)
                })
                .collect(),
            _ => self
                .inner
                .ring
                .snapshot()
                .into_iter()
                .filter(|entry| params.keeps(&entry.meta))
                .map(|entry| entry.meta.decision.as_ref().clone())
                .collect(),
        };
        StorageDecisionBatch {
            items,
            window: self.window(),
        }
    }

    /// One object's decisions the ring still holds, oldest first.
    pub(crate) fn of(&self, bucket: &str, name: &str) -> Vec<StorageDecision> {
        let mut index = lock(&self.inner.index);
        index.prune(self.inner.ring.oldest());
        index
            .by_name
            .get(&(Arc::from(bucket), Arc::from(name)))
            .map(|list| {
                list.iter()
                    .map(|(_, decision)| decision.as_ref().clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The oldest decision the ring holds, RFC 3339.
    pub(crate) fn since(&self) -> Option<String> {
        lock(&self.inner.index)
            .order
            .front()
            .map(|(_, _, at)| rfc3339(*at))
    }
}

/// The live channel's `storage.decisions` topic: `decisions` →
/// [`StorageDecisionBatch`], the params evaluated by the engine, replayed
/// from the ring's cursor.
pub(crate) struct DecisionsTopic(pub(crate) DecisionFeed);

impl LiveTopic for DecisionsTopic {
    fn name(&self) -> &'static str {
        "storage.decisions"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: StorageDecisionsParams = topic_params(params)?;
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
