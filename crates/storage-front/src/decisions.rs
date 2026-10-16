//! Every request the Storage rules judged, kept so a console can show it
//! and explain it.
//!
//! A denial's runtime error used to go to standard error and nothing else:
//! no record of who asked, for what, or which line decided. With the
//! suite's diagnostics on, each judged request now becomes a
//! [`StorageDecisionRecord`], published on a broadcast for the console's
//! feed, and its evaluation context (the request and the ruleset that
//! decided it) is retained for the newest 2,000 decisions within 16 MiB, so
//! "Why" and "what would this draft change" can re-run it. Nothing here
//! ever makes a request wait: retention is admitted with `try_lock`, and a
//! contended log skips the entry and counts it.
//!
//! The console browsing as a client would otherwise evict the app's
//! decisions with its own: its list requests (every page, every live
//! refetch) are recorded at most once a minute per identity, folder and
//! outcome, and dry runs and access checks are never recorded.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use firenook_rules_engine::{
    AllowDecision, Auth, EvaluationRequest, EvaluationResult, EvaluationTrace, StorageObject, Value,
};
use firenook_rules_runtime::DecisionOutcome;
use firenook_rules_runtime::coverage::CoverageRecorder;
use time::OffsetDateTime;
use tokio::sync::broadcast;

use crate::dry_run::DecisionAllow;
use crate::rules::{
    InstalledRules, LIST_V1_MESSAGE, NativeRules, Operation, Verdict, auth_from_authorization,
    evaluation_request, now, rules_object,
};
use crate::{StoredObject, lock};

/// Decisions whose evaluation context is kept for a re-run.
pub const RE_RUNNABLE_DECISIONS: usize = 2_000;
/// Bytes charged against those contexts, each ruleset source once.
pub const RE_RUNNABLE_BYTES: usize = 16 * 1024 * 1024;
/// Summaries the broadcast holds for a subscriber that falls behind.
const FEED_CAPACITY: usize = 4_096;
/// How long one console list decision stands for the next ones.
const CONSOLE_LIST_WINDOW: Duration = Duration::from_mins(1);
/// Console list keys remembered; the map is cleared when full.
const CONSOLE_LIST_KEYS: usize = 1_024;

/// The message a request to a bucket without rules is refused with.
pub(crate) const NO_RULESET_MESSAGE: &str =
    "Permission denied. Storage Emulator has no loaded ruleset.";

/// One request the Storage rules judged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageDecisionRecord {
    /// `s` and a decimal sequence, unique in this process and path-safe.
    pub id: String,
    pub at: OffsetDateTime,
    pub bucket: String,
    pub operation: Operation,
    /// The object, or the list prefix.
    pub name: String,
    pub outcome: DecisionOutcome,
    /// The evaluator's error, or why the request never reached the rules.
    pub error: Option<String>,
    pub uid: Option<String>,
    /// The token's `firebase.tenant`; `None` for project users.
    pub tenant: Option<String>,
    /// The token's `firebase.sign_in_provider`.
    pub provider: Option<String>,
    /// No credentials at all.
    pub anonymous: bool,
    /// The allow statements the evaluation ran, in order.
    pub allows: Vec<DecisionAllow>,
    pub rules_hash: String,
    /// The bucket had no ruleset, so nothing was evaluated.
    pub no_ruleset: bool,
    /// An upload's size, as the rules saw it.
    pub proposed_size: Option<u64>,
    pub proposed_content_type: Option<String>,
    /// The request carried `x-firenook-console`.
    pub via_console: bool,
}

/// A decision's evaluation context, kept for a re-run.
pub(crate) struct Retained {
    pub(crate) record: Arc<StorageDecisionRecord>,
    pub(crate) request: EvaluationRequest,
    /// `None` for a bucket that had no ruleset.
    pub(crate) rules: Option<Arc<InstalledRules>>,
    charged: usize,
}

#[derive(Default)]
struct Retention {
    entries: VecDeque<Arc<Retained>>,
    bytes: usize,
    /// Retained entries per ruleset source hash: a source is charged once.
    sources: HashMap<String, usize>,
}

impl Retention {
    fn evict(&mut self) {
        let Some(entry) = self.entries.pop_front() else {
            return;
        };
        self.bytes = self.bytes.saturating_sub(entry.charged);
        if let Some(rules) = &entry.rules
            && let Some(count) = self.sources.get_mut(&rules.hash)
        {
            *count -= 1;
            if *count == 0 {
                self.sources.remove(&rules.hash);
                self.bytes = self.bytes.saturating_sub(rules.source().len());
            }
        }
    }
}

/// Who a console list decision stands for, and what it decided.
#[derive(Clone, Debug, Eq, PartialEq, Hash)]
struct ConsoleListKey {
    identity: (Option<String>, Option<String>, bool),
    bucket: String,
    prefix: String,
    /// `allow`, `deny` or `error`.
    outcome: &'static str,
}

/// The decisions the Storage rules made: summaries for the console's feed,
/// re-runnable contexts for the newest, and the per-expression coverage.
pub struct DecisionLog {
    sequence: AtomicU64,
    feed: broadcast::Sender<Arc<StorageDecisionRecord>>,
    retention: Mutex<Retention>,
    omitted: AtomicU64,
    /// When each console list was last recorded, and its decision's id.
    console_lists: Mutex<HashMap<ConsoleListKey, (Instant, String)>>,
    pub(crate) coverage: CoverageRecorder,
}

impl Default for DecisionLog {
    fn default() -> Self {
        Self {
            sequence: AtomicU64::new(0),
            feed: broadcast::channel(FEED_CAPACITY).0,
            retention: Mutex::new(Retention::default()),
            omitted: AtomicU64::new(0),
            console_lists: Mutex::new(HashMap::new()),
            coverage: CoverageRecorder::new(),
        }
    }
}

impl std::fmt::Debug for DecisionLog {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DecisionLog")
            .field("recorded", &self.sequence.load(Ordering::Relaxed))
            .field("omitted", &self.omitted.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

impl DecisionLog {
    /// Every decision from now on, as it is recorded. A receiver that falls
    /// behind sees `Lagged` and should say what it missed.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<StorageDecisionRecord>> {
        self.feed.subscribe()
    }

    /// How many of the newest decisions can be re-run (at most 2,000).
    #[must_use]
    pub fn re_runnable(&self) -> usize {
        lock(&self.retention).entries.len()
    }

    /// Decisions whose context was not retained because the log was busy.
    #[must_use]
    pub fn omitted(&self) -> u64 {
        self.omitted.load(Ordering::Relaxed)
    }

    /// The retained context of decision `id`, while it is kept.
    pub(crate) fn find(&self, id: &str) -> Option<Arc<Retained>> {
        lock(&self.retention)
            .entries
            .iter()
            .rev()
            .find(|entry| entry.record.id == id)
            .cloned()
    }

    /// Every retained context, oldest first.
    pub(crate) fn retained(&self) -> Vec<Arc<Retained>> {
        lock(&self.retention).entries.iter().cloned().collect()
    }

    /// The decision of a console list judged as the same identity, folder
    /// and outcome within the last minute: it stands for this one.
    fn console_list_standing(&self, key: &ConsoleListKey) -> Option<String> {
        let seen = lock(&self.console_lists);
        seen.get(key)
            .filter(|(at, _)| at.elapsed() < CONSOLE_LIST_WINDOW)
            .map(|(_, id)| id.clone())
    }

    /// Remembers a console list's decision for the minute it stands.
    fn console_list_recorded(&self, key: ConsoleListKey, id: &str) {
        let mut seen = lock(&self.console_lists);
        if seen.len() >= CONSOLE_LIST_KEYS {
            seen.clear();
        }
        seen.insert(key, (Instant::now(), id.to_owned()));
    }

    /// Records one decision: its context retained (unless the log is busy),
    /// then its summary published, and returns its id. A console list judged
    /// as one recorded in the last minute is not recorded again: the id is
    /// that decision's, which stands for it (so a refusal the page reads
    /// again still names a decision to open).
    pub(crate) fn record(&self, decided: &Decided<'_>) -> String {
        let claims = decided.request.auth.as_ref().map(|auth| &auth.token);
        let claim = |name: &str| match claims.and_then(|claims| claims.get("firebase")) {
            Some(Value::Map(firebase)) => match firebase.get(name) {
                Some(Value::String(value)) => Some(value.clone()),
                _ => None,
            },
            _ => None,
        };
        let uid = decided
            .request
            .auth
            .as_ref()
            .and_then(|auth| auth.uid.clone());
        let tenant = claim("tenant");
        let anonymous = decided.request.auth.is_none();
        let outcome = decided
            .result
            .map_or(DecisionOutcome::Error, |(result, _)| {
                DecisionOutcome::of(result)
            });
        let console_list =
            (decided.via_console && decided.operation == Operation::List).then(|| ConsoleListKey {
                identity: (uid.clone(), tenant.clone(), anonymous),
                bucket: decided.bucket.to_owned(),
                prefix: decided.name.to_owned(),
                outcome: outcome.as_str(),
            });
        if let Some(standing) = console_list
            .as_ref()
            .and_then(|key| self.console_list_standing(key))
        {
            return standing;
        }
        let id = format!("s{}", self.sequence.fetch_add(1, Ordering::Relaxed) + 1);
        if let Some(key) = console_list {
            self.console_list_recorded(key, &id);
        }
        let proposed = decided.request.storage_request_resource.as_ref();
        let record = Arc::new(StorageDecisionRecord {
            id: id.clone(),
            at: OffsetDateTime::now_utc(),
            bucket: decided.bucket.to_owned(),
            operation: decided.operation,
            name: decided.name.to_owned(),
            outcome,
            error: decided.refusal.map(str::to_owned).or_else(|| {
                decided.result.and_then(|(result, _)| {
                    result.error.as_ref().map(|error| error.message.clone())
                })
            }),
            uid,
            tenant,
            provider: claim("sign_in_provider"),
            anonymous,
            allows: decided
                .result
                .zip(decided.rules)
                .map(|((_, trace), rules)| allows(rules, trace))
                .unwrap_or_default(),
            rules_hash: decided
                .rules
                .map(|rules| rules.hash.clone())
                .unwrap_or_default(),
            no_ruleset: decided.rules.is_none(),
            proposed_size: proposed.map(|object| u64::try_from(object.size).unwrap_or(0)),
            proposed_content_type: proposed.and_then(|object| object.content_type.clone()),
            via_console: decided.via_console,
        });
        self.retain(&record, decided.request, decided.rules);
        // No subscriber is the usual case outside a console session.
        let _ = self.feed.send(record);
        id
    }

    fn retain(
        &self,
        record: &Arc<StorageDecisionRecord>,
        request: &EvaluationRequest,
        rules: Option<&Arc<InstalledRules>>,
    ) {
        // A contended log costs the request nothing, not even the copy.
        let Ok(mut retention) = self.retention.try_lock() else {
            self.omitted.fetch_add(1, Ordering::Relaxed);
            return;
        };
        let charged = charged_bytes(record, request);
        let source = rules.map_or(0, |rules| {
            if retention.sources.contains_key(&rules.hash) {
                0
            } else {
                rules.source().len()
            }
        });
        if charged + source > RE_RUNNABLE_BYTES {
            drop(retention);
            self.omitted.fetch_add(1, Ordering::Relaxed);
            return;
        }
        while retention.entries.len() >= RE_RUNNABLE_DECISIONS
            || (!retention.entries.is_empty()
                && retention.bytes + charged + source > RE_RUNNABLE_BYTES)
        {
            retention.evict();
        }
        if let Some(rules) = rules {
            // The eviction above may have released this very source.
            let fresh = !retention.sources.contains_key(&rules.hash);
            *retention.sources.entry(rules.hash.clone()).or_insert(0) += 1;
            if fresh {
                retention.bytes += rules.source().len();
            }
        }
        retention.bytes += charged;
        retention.entries.push_back(Arc::new(Retained {
            record: Arc::clone(record),
            request: request.clone(),
            rules: rules.cloned(),
            charged,
        }));
    }
}

/// What one judged request came to, for the record.
pub(crate) struct Decided<'a> {
    pub(crate) bucket: &'a str,
    pub(crate) name: &'a str,
    pub(crate) operation: Operation,
    pub(crate) request: &'a EvaluationRequest,
    /// `None` when the rules were never evaluated.
    pub(crate) result: Option<(&'a EvaluationResult, &'a EvaluationTrace)>,
    pub(crate) rules: Option<&'a Arc<InstalledRules>>,
    /// Why a request never reached the rules (no ruleset, a v1 list).
    pub(crate) refusal: Option<&'a str>,
    pub(crate) via_console: bool,
}

/// The allow statements a trace names, as an editor places them.
pub(crate) fn allows(rules: &InstalledRules, trace: &EvaluationTrace) -> Vec<DecisionAllow> {
    trace
        .outcomes()
        .iter()
        .map(|outcome| {
            let condition = rules.condition(outcome.location);
            DecisionAllow {
                line: condition.line,
                from: condition.from,
                to: condition.to,
                decision: outcome.decision,
            }
        })
        .collect()
}

/// A conservative estimate of what one context holds: the request's path,
/// credentials and objects, and the record (the source is charged apart).
fn charged_bytes(record: &StorageDecisionRecord, request: &EvaluationRequest) -> usize {
    let auth = request.auth.as_ref().map_or(0, auth_bytes);
    let object = |object: Option<&StorageObject>| {
        object.map_or(0, |object| {
            192 + object.name.len()
                + object.bucket.len()
                + object.md5_hash.len()
                + object.etag.len()
                + object.content_type.as_ref().map_or(0, String::len)
                + object
                    .metadata
                    .iter()
                    .map(|(key, value)| key.len() + value.len() + 32)
                    .sum::<usize>()
        })
    };
    512 + request.path.len()
        + record.name.len()
        + record.bucket.len()
        + record.error.as_ref().map_or(0, String::len)
        + record.allows.len() * 32
        + auth
        + object(request.storage_resource.as_ref())
        + object(request.storage_request_resource.as_ref())
}

fn auth_bytes(auth: &Auth) -> usize {
    auth.uid.as_ref().map_or(0, String::len)
        + auth
            .token
            .iter()
            .map(|(key, value)| key.len() + value_bytes(value))
            .sum::<usize>()
}

fn value_bytes(value: &Value) -> usize {
    16 + match value {
        Value::String(text) | Value::Path(text) => text.len(),
        Value::Bytes(bytes) => bytes.len(),
        Value::List(values) => values.iter().map(value_bytes).sum(),
        Value::Map(map) => map
            .iter()
            .map(|(key, value)| key.len() + value_bytes(value))
            .sum(),
        _ => 0,
    }
}

/// One request the rules are asked to judge.
pub(crate) struct RulesCheck<'a> {
    pub(crate) bucket: &'a str,
    pub(crate) name: &'a str,
    pub(crate) operation: Operation,
    pub(crate) before: Option<&'a StoredObject>,
    pub(crate) after: Option<&'a StoredObject>,
    /// The Authorization header the rules decode.
    pub(crate) authorization: Option<&'a str>,
    /// The request carried `x-firenook-console`.
    pub(crate) console: bool,
}

/// What the rules decided, and the decision recorded for it.
pub(crate) struct Judged {
    pub(crate) verdict: Verdict,
    pub(crate) decision: Option<String>,
}

/// Judges one request. Without a decision log this is the plain evaluation
/// it always was; with one, the request is evaluated once, through the
/// coverage recorder, and recorded (a missing ruleset and a list below
/// version 2 included).
pub(crate) fn judge(
    rules: &NativeRules,
    log: Option<&DecisionLog>,
    check: &RulesCheck<'_>,
) -> Judged {
    let Some(log) = log else {
        return Judged {
            verdict: rules.verify(
                check.bucket,
                check.name,
                check.operation,
                check.before,
                check.after,
                check.authorization,
            ),
            decision: None,
        };
    };
    let installed = rules.installed(check.bucket);
    let request = evaluation_request(
        check.operation,
        check.bucket,
        check.name,
        check.before.map(rules_object),
        check.after.map(rules_object),
        auth_from_authorization(check.authorization),
        now(),
    );
    let decided = |result, refusal| Decided {
        bucket: check.bucket,
        name: check.name,
        operation: check.operation,
        request: &request,
        result,
        rules: installed.as_ref(),
        refusal,
        via_console: check.console,
    };
    let Some(rules_in_force) = &installed else {
        return Judged {
            verdict: Verdict::NoRuleset,
            decision: Some(log.record(&decided(None, Some(NO_RULESET_MESSAGE)))),
        };
    };
    if check.operation == Operation::List && rules_in_force.ruleset.rules_version() < 2 {
        return Judged {
            verdict: Verdict::Denied(Some(LIST_V1_MESSAGE.to_owned())),
            decision: Some(log.record(&decided(None, Some(LIST_V1_MESSAGE)))),
        };
    }
    let (result, trace) = log.coverage.evaluate(
        &rules.scope_of(check.bucket).key(),
        &rules_in_force.ruleset,
        &request,
        &rules.access(),
    );
    let decision = Some(log.record(&decided(Some((&result, &trace)), None)));
    Judged {
        verdict: if result.allowed {
            Verdict::Allowed
        } else {
            Verdict::Denied(result.error.map(|error| error.message))
        },
        decision,
    }
}

/// `allow` decisions in the trace's terms, for a record's first deciding line.
pub(crate) fn deciding_line(allows: &[DecisionAllow], allowed: bool) -> Option<usize> {
    if allowed {
        allows
            .iter()
            .find(|allow| allow.decision == AllowDecision::Allow)
            .map(|allow| allow.line)
    } else {
        allows.last().map(|allow| allow.line)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use firenook_rules_engine::{RequestOperation, Timestamp};
    use firenook_rules_runtime::RulesOrigin;

    use super::*;

    fn rules() -> Arc<InstalledRules> {
        Arc::new(
            InstalledRules::compile(
                "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o/{path=**} {\n    allow read: if request.auth != null;\n  }\n}\n",
                RulesOrigin::Startup,
            )
            .expect("compiles"),
        )
    }

    fn request(operation: RequestOperation, claims: usize) -> EvaluationRequest {
        let mut request =
            EvaluationRequest::storage(operation, "/b/b/o/users/u1/a.png", Timestamp::new(0, 0));
        request.auth = Some(Auth {
            uid: Some("u1".to_owned()),
            token: BTreeMap::from([("padding".to_owned(), Value::String("x".repeat(claims)))]),
        });
        request
    }

    fn record(
        log: &DecisionLog,
        rules: &Arc<InstalledRules>,
        request: &EvaluationRequest,
        operation: Operation,
        via_console: bool,
    ) -> String {
        let (result, trace) = rules
            .ruleset
            .evaluate_with_trace(request, &firenook_rules_engine::EmptyDocumentAccess);
        log.record(&Decided {
            bucket: "b",
            name: "users/u1/",
            operation,
            request,
            result: Some((&result, &trace)),
            rules: Some(rules),
            refusal: None,
            via_console,
        })
    }

    #[test]
    fn retention_keeps_the_newest_within_its_bounds() {
        let log = DecisionLog::default();
        let rules = rules();
        let get = request(RequestOperation::Get, 0);
        let mut feed = log.subscribe();
        for _ in 0..2_500 {
            record(&log, &rules, &get, Operation::Get, false);
        }
        assert_eq!(log.re_runnable(), RE_RUNNABLE_DECISIONS);
        assert_eq!(
            log.find("s1").map(|kept| kept.record.id.clone()),
            None,
            "evicted"
        );
        let newest = log.find("s2500").expect("the newest is kept");
        assert_eq!(newest.record.outcome, DecisionOutcome::Allow);
        assert_eq!(newest.record.allows.len(), 1);
        assert_eq!(newest.record.allows[0].line, 4);
        assert_eq!(feed.try_recv().expect("published").id, "s1");

        // A large context: the byte budget evicts long before the count.
        let log = DecisionLog::default();
        let large = request(RequestOperation::Get, 200 * 1024);
        for _ in 0..200 {
            record(&log, &rules, &large, Operation::Get, false);
        }
        let kept = log.re_runnable();
        assert!(
            kept < 100 && kept > 50,
            "{kept} contexts of 200 KB within 16 MiB"
        );
        assert!(lock(&log.retention).bytes <= RE_RUNNABLE_BYTES);
    }

    #[test]
    fn contended_admission_is_skipped_and_counted() {
        let log = DecisionLog::default();
        let rules = rules();
        let get = request(RequestOperation::Get, 0);
        let held = log.retention.lock().expect("retention");
        let id = record(&log, &rules, &get, Operation::Get, false);
        drop(held);
        assert_eq!(id, "s1", "the decision is still published");
        assert_eq!(log.omitted(), 1);
        assert_eq!(log.re_runnable(), 0);
    }

    #[test]
    fn console_lists_are_throttled_and_app_lists_are_not() {
        let log = DecisionLog::default();
        let rules = rules();
        let list = request(RequestOperation::List, 0);
        let mut feed = log.subscribe();
        let ids = (0..30)
            .map(|_| record(&log, &rules, &list, Operation::List, true))
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            ids.len(),
            1,
            "one console list stands for the minute: {ids:?}"
        );
        let standing = ids.into_iter().next().expect("the decision's id");
        assert_eq!(feed.try_recv().expect("recorded once").id, standing);
        assert!(feed.try_recv().is_err(), "and only once");
        let recorded = (0..30)
            .map(|_| record(&log, &rules, &list, Operation::List, false))
            .collect::<std::collections::BTreeSet<_>>()
            .len();
        assert_eq!(recorded, 30, "every app list is recorded");
        // Another identity of the same folder is recorded on its own.
        let mut other = list.clone();
        other.auth.as_mut().expect("auth").uid = Some("u2".to_owned());
        let own = record(&log, &rules, &other, Operation::List, true);
        assert_ne!(own, standing);
    }
}
