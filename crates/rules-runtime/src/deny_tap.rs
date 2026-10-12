//! A tap on refused requests, for the console's log.
//!
//! Every verdict the runtime hands a front passes [`DenyTap::observe`], so a
//! client request the rules refused — denied outright or failed while
//! evaluating — reaches whoever subscribed through
//! [`RulesRuntime::subscribe_denials`], with the decision's Requests id when
//! diagnostics keep it.
//!
//! Each refusal says where it entered: the origin of the handle that
//! evaluated it. A front built with a handle from
//! [`RulesRuntime::with_origin`]`(`[`DenialOrigin::Console`]`)` — the
//! console's own REST mount — reports its refusals as the console's, so a
//! "View as" read is told apart from an app's request by where it entered,
//! never by a header an app could send.
//!
//! The tap costs an allowed request nothing beyond the verdict it already
//! has, and a refused one a single atomic load until something subscribes in
//! the engine's life (a run without the console never does). Rate limits and
//! wording are the subscriber's: the tap only hands refusals over, bounded by
//! [`DENIAL_CAPACITY`].

use std::sync::Arc;
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, Ordering};

use firenook_core_store::DatabaseName;
use firenook_rules_engine::{EvaluationRequest, EvaluationResult, QueryScope, RequestOperation};
use tokio::sync::broadcast;

use crate::RulesRuntime;

/// Refusals kept for a slow subscriber before it is told it lagged.
pub const DENIAL_CAPACITY: usize = 256;

/// Where a request entered the emulator.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum DenialOrigin {
    /// An app, an SDK or a test, through a service port.
    #[default]
    App,
    /// The console's own REST mount, such as a "View as" read.
    Console,
}

impl DenialOrigin {
    /// `app` or `console`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Console => "console",
        }
    }
}

/// One client request the rules refused, for the console's log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Denial {
    /// The database the request addressed.
    pub database: DatabaseName,
    /// What was asked: get, list, create, update or delete.
    pub operation: RequestOperation,
    /// The canonical rules path, `/databases/{database}/documents/…`: the
    /// document, or for a list the collection
    /// (`…/documents/users/u_1/orders`) or the collection group
    /// (`…/documents/**/orders`, `…/documents/users/u_1/**/orders` below an
    /// ancestor).
    pub path: String,
    /// The signed-in user, `None` for an unauthenticated client.
    pub uid: Option<String>,
    /// Why evaluating the rules failed, when they failed rather than denied.
    pub error: Option<String>,
    /// The id diagnostics keep this decision under (the Requests feed's
    /// `requestId` and the retained decision's id); `None` when diagnostics
    /// are off or kept neither.
    pub request_id: Option<Arc<str>>,
    /// Where the request entered.
    pub origin: DenialOrigin,
}

impl Denial {
    /// [`path`](Self::path) relative to the database: `users/u_1`, `users`
    /// for a list, `**/orders` for a collection group.
    #[must_use]
    pub fn relative_path(&self) -> &str {
        self.path
            .split_once("/documents/")
            .map_or(self.path.as_str(), |(_, relative)| relative)
    }
}

/// The refusal channel, shared by every clone of a runtime and by every
/// handle [`RulesRuntime::with_origin`] makes.
pub(crate) struct DenyTap {
    sender: broadcast::Sender<Arc<Denial>>,
    /// Set by the first subscription in the runtime's life: until then a
    /// refusal costs one atomic load and the channel is never touched.
    subscribed: AtomicBool,
    /// Refusals turned into a [`Denial`], so tests can prove nothing is
    /// built while nobody listens.
    #[cfg(test)]
    built: AtomicUsize,
}

impl Default for DenyTap {
    fn default() -> Self {
        Self {
            sender: broadcast::channel(DENIAL_CAPACITY).0,
            subscribed: AtomicBool::new(false),
            #[cfg(test)]
            built: AtomicUsize::new(0),
        }
    }
}

impl DenyTap {
    /// Hands one verdict to the subscribers when it is a refusal. `request`
    /// is the request as evaluated, its `auth` included.
    pub(crate) fn observe(
        &self,
        origin: DenialOrigin,
        database: &DatabaseName,
        request: &EvaluationRequest,
        result: &EvaluationResult,
        request_id: Option<&str>,
    ) {
        if result.allowed || !self.subscribed.load(Ordering::Acquire) {
            return;
        }
        // Every subscriber may have gone since; nothing is built for nobody.
        if self.sender.receiver_count() == 0 {
            return;
        }
        #[cfg(test)]
        self.built.fetch_add(1, Ordering::Relaxed);
        let denial = Denial {
            database: database.clone(),
            operation: request.operation,
            path: denied_path(database, request),
            uid: request.auth.as_ref().and_then(|auth| auth.uid.clone()),
            error: result.error.as_ref().map(|error| error.message.clone()),
            request_id: request_id.map(Arc::from),
            origin,
        };
        // A send fails only when the last subscriber left meanwhile.
        let _ = self.sender.send(Arc::new(denial));
    }

    fn subscribe(&self) -> broadcast::Receiver<Arc<Denial>> {
        let receiver = self.sender.subscribe();
        self.subscribed.store(true, Ordering::Release);
        receiver
    }
}

/// The document a refused request addressed, or for a list its collection
/// or collection group: a list's evaluator path names a synthetic candidate
/// document, so the query's scope says what was listed.
fn denied_path(database: &DatabaseName, request: &EvaluationRequest) -> String {
    if request.operation != RequestOperation::List {
        return request.path.clone();
    }
    let root = format!("/databases/{}/documents", database.database_id());
    match &request.query.scope {
        Some(QueryScope::Collection(collection)) => format!("{root}/{collection}"),
        Some(QueryScope::CollectionGroup {
            collection_id,
            ancestor: Some(ancestor),
        }) => format!("{root}/{ancestor}/**/{collection_id}"),
        Some(QueryScope::CollectionGroup {
            collection_id,
            ancestor: None,
        }) => format!("{root}/**/{collection_id}"),
        None => request.path.rsplit_once('/').map_or_else(
            || request.path.clone(),
            |(collection, _)| collection.to_owned(),
        ),
    }
}

impl RulesRuntime {
    /// Every refusal from now on, from this runtime, its clones and every
    /// handle [`with_origin`](Self::with_origin) made from them. Cheap when
    /// nobody listens: one atomic load per refused request until the first
    /// subscription. A receiver that falls more than [`DENIAL_CAPACITY`]
    /// refusals behind is told it lagged.
    #[must_use]
    pub fn subscribe_denials(&self) -> broadcast::Receiver<Arc<Denial>> {
        self.tap.subscribe()
    }

    /// A handle sharing every part of this runtime — installed rules, their
    /// history, the Requests feed, retained decisions, coverage and the
    /// refusal channel — whose evaluations report `origin`.
    #[must_use]
    pub fn with_origin(&self, origin: DenialOrigin) -> Self {
        Self {
            origin,
            ..self.clone()
        }
    }

    /// Where the requests this handle evaluates entered.
    #[must_use]
    pub const fn origin(&self) -> DenialOrigin {
        self.origin
    }
}

#[cfg(test)]
#[path = "deny_tap_tests.rs"]
mod tests;
