//! A tap on every decision the rules recorded, for the console's decisions
//! feed.
//!
//! The Requests feed (`/requests`) is the official Emulator UI's: it admits
//! four clients, keeps 256 events for ten minutes and sends each whole, the
//! ruleset's source included, which is what its protocol pins. The console
//! wants something else of the same decisions — a summary of each, many
//! more of them, filtered by the engine and shared by every tab over the
//! one live channel — so the evaluation path hands every recorded decision
//! to this tap too, as a [`RecordedDecision`], beside the Requests event it
//! records and the context it retains.
//!
//! Like the refusal tap, it costs a request nothing until something
//! subscribes in the engine's life, and only runs where diagnostics record
//! decisions at all. A subscriber that falls more than
//! [`DECISION_CAPACITY`] decisions behind is told it lagged.

use std::sync::Arc;
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, Ordering};

use firenook_core_store::DatabaseName;
use firenook_rules_engine::{
    AllowOutcome, EvaluationRequest, EvaluationResult, EvaluationTrace, RequestOperation, Ruleset,
    Timestamp, Value,
};
use tokio::sync::broadcast;

use crate::deny_tap::{DenialOrigin, denied_path};
use crate::retention::DecisionOutcome;
use crate::{InstalledRules, RulesRuntime};

/// Decisions kept for a slow subscriber before it is told it lagged.
pub const DECISION_CAPACITY: usize = 4_096;

/// One decision the rules made and diagnostics recorded.
#[derive(Clone, Debug)]
pub struct RecordedDecision {
    /// The id it is recorded under: the Requests feed's `requestId` and the
    /// retained context's.
    pub request_id: Arc<str>,
    /// The database the request addressed.
    pub database: DatabaseName,
    /// What was asked: get, list, create, update or delete.
    pub operation: RequestOperation,
    /// The canonical rules path, `/databases/{database}/documents/…`: the
    /// document, or for a list the collection or the collection group
    /// (`…/documents/**/orders`), as a refusal names it.
    pub path: String,
    /// `request.time`.
    pub time: Timestamp,
    /// The signed-in user's uid.
    pub uid: Option<String>,
    /// The token's `firebase.tenant`; `None` for project users.
    pub tenant: Option<String>,
    /// The token's `firebase.sign_in_provider`.
    pub provider: Option<String>,
    /// No credentials at all.
    pub anonymous: bool,
    /// What it came to.
    pub outcome: DecisionOutcome,
    /// The evaluator's error when it failed rather than denied.
    pub error: Option<String>,
    /// The allow statements it ran, in order.
    pub allows: Vec<AllowOutcome>,
    /// The ruleset that decided it, which the allows' locations refer to.
    pub rules: Arc<Ruleset>,
    /// The stable hash of that ruleset's source.
    pub rules_hash: Arc<str>,
    /// Where the request entered.
    pub origin: DenialOrigin,
    /// Whether its context is retained, so it can be re-run for why.
    pub retained: bool,
}

impl RecordedDecision {
    /// [`path`](Self::path) relative to the database: `users/u_1`, `users`
    /// for a list, `**/orders` for a collection group.
    #[must_use]
    pub fn relative_path(&self) -> &str {
        self.path
            .split_once("/documents/")
            .map_or(self.path.as_str(), |(_, relative)| relative)
    }
}

/// The decisions channel, shared by every clone of a runtime and every
/// handle [`RulesRuntime::with_origin`] makes.
pub(crate) struct DecisionTap {
    sender: broadcast::Sender<Arc<RecordedDecision>>,
    /// Set by the first subscription in the runtime's life: until then a
    /// decision costs one atomic load and the channel is never touched.
    subscribed: AtomicBool,
    /// Decisions turned into a [`RecordedDecision`], so tests can prove
    /// nothing is built while nobody listens.
    #[cfg(test)]
    built: AtomicUsize,
}

impl Default for DecisionTap {
    fn default() -> Self {
        Self {
            sender: broadcast::channel(DECISION_CAPACITY).0,
            subscribed: AtomicBool::new(false),
            #[cfg(test)]
            built: AtomicUsize::new(0),
        }
    }
}

/// One evaluation the recorder recorded, as the tap is handed it.
pub(crate) struct Recorded<'a> {
    pub(crate) origin: DenialOrigin,
    pub(crate) database: &'a DatabaseName,
    pub(crate) installed: &'a Arc<InstalledRules>,
    pub(crate) request: &'a EvaluationRequest,
    pub(crate) result: &'a EvaluationResult,
    pub(crate) trace: &'a EvaluationTrace,
    pub(crate) request_id: &'a str,
    pub(crate) retained: bool,
}

impl DecisionTap {
    /// Hands one recorded decision to the subscribers.
    pub(crate) fn observe(&self, recorded: &Recorded<'_>) {
        if !self.subscribed.load(Ordering::Acquire) || self.sender.receiver_count() == 0 {
            return;
        }
        #[cfg(test)]
        self.built.fetch_add(1, Ordering::Relaxed);
        let request = recorded.request;
        let auth = request.auth.as_ref();
        let firebase = auth.and_then(|auth| match auth.token.get("firebase") {
            Some(Value::Map(fields)) => Some(fields),
            _ => None,
        });
        let claim = |name: &str| match firebase.and_then(|fields| fields.get(name)) {
            Some(Value::String(text)) => Some(text.clone()),
            _ => None,
        };
        let decision = RecordedDecision {
            request_id: Arc::from(recorded.request_id),
            database: recorded.database.clone(),
            operation: request.operation,
            path: denied_path(recorded.database, request),
            time: request.time,
            uid: auth.and_then(|auth| auth.uid.clone()),
            tenant: claim("tenant"),
            provider: claim("sign_in_provider"),
            anonymous: auth.is_none(),
            outcome: DecisionOutcome::of(recorded.result),
            error: recorded
                .result
                .error
                .as_ref()
                .map(|error| error.message.clone()),
            allows: recorded.trace.outcomes().to_vec(),
            rules: Arc::clone(&recorded.installed.rules),
            rules_hash: Arc::from(recorded.installed.source_hash.as_str()),
            origin: recorded.origin,
            retained: recorded.retained,
        };
        // A send fails only when the last subscriber left meanwhile.
        let _ = self.sender.send(Arc::new(decision));
    }

    fn subscribe(&self) -> broadcast::Receiver<Arc<RecordedDecision>> {
        let receiver = self.sender.subscribe();
        self.subscribed.store(true, Ordering::Release);
        receiver
    }
}

impl RulesRuntime {
    /// Every decision diagnostics record from now on, from this runtime,
    /// its clones and every handle [`with_origin`](Self::with_origin) made
    /// from them. Nothing arrives without diagnostics. Cheap when nobody
    /// listens: one atomic load per recorded decision until the first
    /// subscription. A receiver that falls more than [`DECISION_CAPACITY`]
    /// decisions behind is told it lagged.
    #[must_use]
    pub fn subscribe_decisions(&self) -> broadcast::Receiver<Arc<RecordedDecision>> {
        self.decisions.subscribe()
    }
}

#[cfg(test)]
#[path = "decision_tap_tests.rs"]
mod tests;
