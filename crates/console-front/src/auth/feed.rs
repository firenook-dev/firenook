//! What the Auth emulator tells the console, kept for the Activity and
//! Inbox pages and handed on to the live topics.
//!
//! [`AuthFeed`] is the runtime's observer. For each finished call it keeps
//! the call's summary (with its bodies, under their own budget) for `GET
//! /activity` and pushes it on the activity ring the `auth.activity` topic
//! replays; turns the codes the call sent or used into inbox messages and
//! events on the inbox ring; queues the accounts the call changed for the
//! `auth.users` coalescer; tells `auth.config` of configuration changes and
//! writes them to the log; and counts each new code on the `auth.inbox`
//! badge. Every push is O(1) under a short lock and nothing waits: the
//! coalescer's queue is filled with `try_send`, and a full queue makes its
//! next window a reset.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use axum::body::Bytes;
use firenook_auth_front::Runtime;
use firenook_auth_front::observe::{
    self, AuthObserver, Body, CallRecord, ConfigChange, MessageRecord, Step, UserChange,
};
use firenook_suite_front::{
    LogInput, LogLevel, LoggingRuntime, ReplayRing, RingBudget, RingLimits, kinds,
};
use tokio::sync::{broadcast, mpsc};

use super::wire::{
    self, AuthActivityItem, AuthActivitySummary, AuthConfigChange, AuthConfigChanged,
    AuthInboxItem, AuthMessage,
};
use crate::live::badges::{BadgeHandle, BadgeTone};

/// Calls the Activity list keeps.
pub(crate) const ACTIVITY_CAPACITY: usize = 10_000;
/// Bytes of summary JSON the Activity list keeps.
const ACTIVITY_BYTES: usize = 8 * 1024 * 1024;
/// Bytes of request and response bodies kept across every call.
const BODY_BUDGET: usize = 8 * 1024 * 1024;
/// Steps one kept call lists; the rest are counted.
pub(crate) const MAX_STEPS: usize = 50;
/// Messages the Inbox keeps.
pub(crate) const MESSAGE_CAPACITY: usize = 2_000;
/// Inbox events (issued, used, cleared) the inbox ring keeps.
const INBOX_EVENTS: usize = 4_000;
/// Account changes queued for the coalescer before it reads them.
pub(crate) const USER_QUEUE: usize = 4_096;
/// Configuration changes buffered for slow subscribers.
const CONFIG_BUFFER: usize = 512;

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What the `has:` filter of Activity tests.
pub(crate) mod has {
    pub(crate) const BLOCKING: u8 = 1;
    pub(crate) const TRIGGER: u8 = 1 << 1;
    pub(crate) const MESSAGE: u8 = 1 << 2;
    pub(crate) const CHANGE: u8 = 1 << 3;
    pub(crate) const CONFIG: u8 = 1 << 4;
}

/// One kept call.
pub(crate) struct ActivityEntry {
    /// The order the list keeps, from 1; restarts with the engine.
    pub(crate) seq: u64,
    pub(crate) summary: AuthActivitySummary,
    /// `{"kind":"call","summary":…}`, serialized once.
    pub(crate) json: Arc<str>,
    /// `has:` flags.
    pub(crate) has: u8,
    pub(crate) error_code: Option<String>,
    pub(crate) bodies: Mutex<Bodies>,
    pub(crate) request_bytes: u64,
    pub(crate) response_bytes: u64,
    pub(crate) query: Vec<(String, String)>,
    pub(crate) headers: Vec<(String, String)>,
}

/// A call's bodies as far as they are still kept.
#[derive(Default)]
pub(crate) struct Bodies {
    pub(crate) request: Option<Bytes>,
    pub(crate) response: Option<Bytes>,
    /// Both were kept when the call finished.
    pub(crate) kept: bool,
    /// Dropped since, for newer calls.
    pub(crate) dropped: bool,
}

impl Bodies {
    fn weight(&self) -> usize {
        self.request.as_ref().map_or(0, Bytes::len) + self.response.as_ref().map_or(0, Bytes::len)
    }
}

/// What the activity ring holds: a call, or the list being cleared.
#[derive(Clone)]
pub(crate) enum ActivityMeta {
    Call(Arc<ActivityEntry>),
    Cleared { project: Arc<str> },
}

/// One kept message.
pub(crate) struct MessageEntry {
    pub(crate) record: MessageRecord,
    /// The call that created it.
    pub(crate) activity: Option<u64>,
    /// When it was used (epoch ms) and by which call.
    pub(crate) used: Mutex<Option<(i64, Option<u64>)>>,
}

impl MessageEntry {
    pub(crate) fn wire(&self) -> AuthMessage {
        wire::message(&self.record, self.activity, *guard(&self.used))
    }
}

/// What the inbox ring holds.
#[derive(Clone)]
pub(crate) enum InboxMeta {
    Issued(Arc<MessageEntry>),
    Used(Arc<MessageEntry>),
    Cleared { project: Arc<str> },
}

/// An account change, or a scope cleared, for the coalescer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum UserKey {
    Changed {
        project: Arc<str>,
        tenant: Option<String>,
        uid: String,
        change: UserChange,
        fields: Vec<String>,
    },
    Cleared {
        project: Arc<str>,
        tenant: Option<String>,
    },
    /// User or tenant counts moved without an account change (a tenant was
    /// created or deleted).
    CountsMoved,
}

/// A configuration change, as `auth.config` sends it.
#[derive(Clone, Debug)]
pub(crate) struct ConfigEvent {
    pub(crate) project: Arc<str>,
    pub(crate) revision: u64,
    pub(crate) change: AuthConfigChanged,
}

struct ActivityStore {
    entries: VecDeque<Arc<ActivityEntry>>,
    by_id: HashMap<u64, Arc<ActivityEntry>>,
    bytes: usize,
    /// Entries holding bodies, oldest first, for the body budget.
    with_bodies: VecDeque<Arc<ActivityEntry>>,
    body_bytes: usize,
    next_seq: u64,
}

struct MessageStore {
    entries: VecDeque<Arc<MessageEntry>>,
    by_id: HashMap<u64, Arc<MessageEntry>>,
    /// The oobCode or sessionInfo a use names, to the message id.
    by_key: HashMap<String, u64>,
}

struct FeedInner {
    keep_bodies: bool,
    activity: Mutex<ActivityStore>,
    activity_ring: ReplayRing<ActivityMeta>,
    inbox: Mutex<MessageStore>,
    inbox_ring: ReplayRing<InboxMeta>,
    users: mpsc::Sender<UserKey>,
    users_queue: Mutex<Option<mpsc::Receiver<UserKey>>>,
    overflow: AtomicBool,
    config: broadcast::Sender<ConfigEvent>,
    config_revision: AtomicU64,
    badge: OnceLock<BadgeHandle>,
    logging: LoggingRuntime,
}

/// The Auth runtime's observer and what it keeps. Cheap to clone.
#[derive(Clone)]
pub struct AuthFeed {
    inner: Arc<FeedInner>,
}

impl std::fmt::Debug for AuthFeed {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuthFeed")
            .field("keep_bodies", &self.inner.keep_bodies)
            .finish_non_exhaustive()
    }
}

impl AuthFeed {
    /// An empty feed; `keep_bodies` keeps request and response bodies
    /// (diagnostics on). Its rings count against the process's ring budget.
    pub(crate) fn new(keep_bodies: bool, logging: LoggingRuntime) -> Self {
        let budget = RingBudget::shared();
        let epoch = firenook_suite_front::replay::random_epoch();
        let (users, queue) = mpsc::channel(USER_QUEUE);
        let (config, _) = broadcast::channel(CONFIG_BUFFER);
        Self {
            inner: Arc::new(FeedInner {
                keep_bodies,
                activity: Mutex::new(ActivityStore {
                    entries: VecDeque::new(),
                    by_id: HashMap::new(),
                    bytes: 0,
                    with_bodies: VecDeque::new(),
                    body_bytes: 0,
                    next_seq: 1,
                }),
                activity_ring: ReplayRing::new(
                    "auth.activity",
                    RingLimits {
                        entries: ACTIVITY_CAPACITY,
                        bytes: ACTIVITY_BYTES,
                        floor: 256,
                    },
                    epoch,
                    &budget,
                ),
                inbox: Mutex::new(MessageStore {
                    entries: VecDeque::new(),
                    by_id: HashMap::new(),
                    by_key: HashMap::new(),
                }),
                inbox_ring: ReplayRing::new(
                    "auth.inbox",
                    RingLimits {
                        entries: INBOX_EVENTS,
                        bytes: 4 * 1024 * 1024,
                        floor: 256,
                    },
                    epoch.wrapping_add(1),
                    &budget,
                ),
                users,
                users_queue: Mutex::new(Some(queue)),
                overflow: AtomicBool::new(false),
                config,
                config_revision: AtomicU64::new(0),
                badge: OnceLock::new(),
                logging,
            }),
        }
    }

    /// Whether bodies are kept.
    pub(crate) fn keeps_bodies(&self) -> bool {
        self.inner.keep_bodies
    }

    /// The codes found in saved state, first in the inbox, not counted on
    /// the badge.
    pub(crate) fn seed(&self, messages: Vec<MessageRecord>) {
        let mut inbox = guard(&self.inner.inbox);
        for record in messages {
            let entry = Self::keep_message(&mut inbox, record, None);
            self.push_inbox(
                InboxMeta::Issued(entry.clone()),
                &AuthInboxItem::Issued {
                    message: Box::new(entry.wire()),
                },
            );
        }
    }

    /// The badge new codes are counted on (the section hands it over when
    /// the console starts).
    pub(crate) fn set_badge(&self, badge: BadgeHandle) {
        let _ = self.inner.badge.set(badge);
    }

    /// The coalescer's queue, taken once by the section.
    pub(crate) fn take_users_queue(&self) -> Option<mpsc::Receiver<UserKey>> {
        guard(&self.inner.users_queue).take()
    }

    /// Whether the queue overflowed since the last call (and resets it).
    pub(crate) fn take_overflow(&self) -> bool {
        self.inner.overflow.swap(false, Ordering::AcqRel)
    }

    pub(crate) fn activity_ring(&self) -> &ReplayRing<ActivityMeta> {
        &self.inner.activity_ring
    }

    pub(crate) fn inbox_ring(&self) -> &ReplayRing<InboxMeta> {
        &self.inner.inbox_ring
    }

    pub(crate) fn config_changes(&self) -> broadcast::Receiver<ConfigEvent> {
        self.inner.config.subscribe()
    }

    pub(crate) fn config_revision(&self) -> u64 {
        self.inner.config_revision.load(Ordering::Acquire)
    }

    /// The kept calls, oldest first, and the ring position they reach.
    pub(crate) fn activity(&self) -> (Vec<Arc<ActivityEntry>>, String) {
        let store = guard(&self.inner.activity);
        (
            store.entries.iter().cloned().collect(),
            self.inner.activity_ring.position().to_string(),
        )
    }

    /// One kept call.
    pub(crate) fn call_entry(&self, id: u64) -> Option<Arc<ActivityEntry>> {
        guard(&self.inner.activity).by_id.get(&id).cloned()
    }

    /// The kept messages, oldest first, and the ring position they reach.
    pub(crate) fn messages(&self) -> (Vec<Arc<MessageEntry>>, String) {
        let store = guard(&self.inner.inbox);
        (
            store.entries.iter().cloned().collect(),
            self.inner.inbox_ring.position().to_string(),
        )
    }

    /// One kept message.
    pub(crate) fn message(&self, id: u64) -> Option<Arc<MessageEntry>> {
        guard(&self.inner.inbox).by_id.get(&id).cloned()
    }

    /// Empties the Activity list (call ids keep counting) and tells the
    /// feed's subscribers of `project`.
    pub(crate) fn clear_activity(&self, project: &str) {
        let mut store = guard(&self.inner.activity);
        store.entries.clear();
        store.by_id.clear();
        store.with_bodies.clear();
        store.bytes = 0;
        store.body_bytes = 0;
        let json = json_of(&AuthActivityItem::Cleared);
        self.inner.activity_ring.push(
            ActivityMeta::Cleared {
                project: Arc::from(project),
            },
            json,
        );
    }

    /// Empties the Inbox (message ids keep counting; codes still work in
    /// the engine) and tells the feed's subscribers of `project`.
    pub(crate) fn clear_messages(&self, project: &str) {
        let mut store = guard(&self.inner.inbox);
        store.entries.clear();
        store.by_id.clear();
        store.by_key.clear();
        drop(store);
        self.push_inbox(
            InboxMeta::Cleared {
                project: Arc::from(project),
            },
            &AuthInboxItem::Cleared,
        );
    }

    fn keep_message(
        inbox: &mut MessageStore,
        record: MessageRecord,
        activity: Option<u64>,
    ) -> Arc<MessageEntry> {
        let entry = Arc::new(MessageEntry {
            record,
            activity,
            used: Mutex::new(None),
        });
        inbox
            .by_key
            .insert(entry.record.key.clone(), entry.record.id);
        inbox.by_id.insert(entry.record.id, entry.clone());
        inbox.entries.push_back(entry.clone());
        while inbox.entries.len() > MESSAGE_CAPACITY {
            if let Some(old) = inbox.entries.pop_front() {
                inbox.by_id.remove(&old.record.id);
                if inbox.by_key.get(&old.record.key) == Some(&old.record.id) {
                    inbox.by_key.remove(&old.record.key);
                }
            }
        }
        entry
    }

    fn push_inbox(&self, meta: InboxMeta, item: &AuthInboxItem) {
        self.inner.inbox_ring.push(meta, json_of(item));
    }

    fn log_config(&self, project: &str, tenant: Option<&str>, what: ConfigChange) {
        let message = match (what, tenant) {
            (ConfigChange::Project, _) => {
                format!("The Auth configuration of project {project} changed.")
            }
            (ConfigChange::TenantCreated, Some(tenant)) => format!("Tenant {tenant} was created."),
            (ConfigChange::TenantUpdated, Some(tenant)) => format!("Tenant {tenant} was changed."),
            (ConfigChange::TenantDeleted, Some(tenant)) => format!("Tenant {tenant} was deleted."),
            (_, None) => format!("A tenant of project {project} changed."),
        };
        let change: AuthConfigChange = what.into();
        self.inner.logging.emit(LogInput {
            level: LogLevel::Info,
            service: "auth".to_owned(),
            kind: Some(kinds::AUTH_CONFIG),
            message,
            payload: Some(serde_json::json!({ "tenant": tenant, "what": change })),
            audience: firenook_suite_front::Audience::Console,
            ..LogInput::default()
        });
    }
}

/// An item serialized once.
fn json_of(item: &impl serde::Serialize) -> Arc<str> {
    // The console's own types always serialize.
    Arc::from(serde_json::to_string(item).unwrap_or_else(|_| "null".to_owned()))
}

impl AuthObserver for AuthFeed {
    fn call(&self, record: CallRecord) {
        // Codes first, so a code used in this very call resolves.
        let keys = self.note_messages(&record);
        let flags = self.note_steps(&record);
        self.keep_call(record, flags, &keys);
    }
}

impl AuthFeed {
    /// Keeps the messages a call sent and marks the ones it used; answers
    /// the message id of every key it named.
    fn note_messages(&self, record: &CallRecord) -> HashMap<String, u64> {
        let mut keys: HashMap<String, u64> = HashMap::new();
        let mut inbox = guard(&self.inner.inbox);
        for step in &record.steps {
            match step {
                Step::MessageSent(message) => {
                    let restored = message.delivery == observe::Delivery::Restored;
                    let entry = Self::keep_message(&mut inbox, message.clone(), Some(record.id));
                    keys.insert(message.key.clone(), message.id);
                    self.push_inbox(
                        InboxMeta::Issued(entry.clone()),
                        &AuthInboxItem::Issued {
                            message: Box::new(entry.wire()),
                        },
                    );
                    if !restored && let Some(badge) = self.inner.badge.get() {
                        badge.add(1, BadgeTone::Neutral);
                    }
                }
                Step::MessageUsed { key } => {
                    let Some(id) = inbox.by_key.get(key).copied() else {
                        continue;
                    };
                    keys.insert(key.clone(), id);
                    let Some(entry) = inbox.by_id.get(&id).cloned() else {
                        continue;
                    };
                    let at = record.at_millis;
                    *guard(&entry.used) = Some((at, Some(record.id)));
                    self.push_inbox(
                        InboxMeta::Used(entry),
                        &AuthInboxItem::Used {
                            id,
                            used_at: wire::at_millis(at),
                            used_by: Some(record.id),
                        },
                    );
                }
                _ => {}
            }
        }
        keys
    }

    /// Queues the accounts a call changed, sends its configuration changes,
    /// and answers its `has:` flags.
    fn note_steps(&self, record: &CallRecord) -> u8 {
        let project: Arc<str> = Arc::from(record.project.as_str());
        let mut flags = 0_u8;
        for step in &record.steps {
            match step {
                Step::Blocking { .. } => flags |= has::BLOCKING,
                Step::Trigger { .. } => flags |= has::TRIGGER,
                Step::MessageSent(_) | Step::MessageUsed { .. } => flags |= has::MESSAGE,
                Step::User {
                    tenant,
                    uid,
                    change,
                    fields,
                } => {
                    flags |= has::CHANGE;
                    self.queue(UserKey::Changed {
                        project: project.clone(),
                        tenant: tenant.clone(),
                        uid: uid.clone(),
                        change: *change,
                        fields: fields.clone(),
                    });
                }
                Step::UsersCleared { tenant } => {
                    flags |= has::CHANGE;
                    self.queue(UserKey::Cleared {
                        project: project.clone(),
                        tenant: tenant.clone(),
                    });
                }
                Step::Config { tenant, what } => {
                    flags |= has::CONFIG;
                    let revision = self.inner.config_revision.fetch_add(1, Ordering::AcqRel) + 1;
                    let _ = self.inner.config.send(ConfigEvent {
                        project: project.clone(),
                        revision,
                        change: AuthConfigChanged {
                            tenant: tenant.clone(),
                            what: (*what).into(),
                        },
                    });
                    self.log_config(&project, tenant.as_deref(), *what);
                    if matches!(
                        what,
                        ConfigChange::TenantCreated | ConfigChange::TenantDeleted
                    ) {
                        self.queue(UserKey::CountsMoved);
                    }
                }
            }
        }
        flags
    }

    /// The call's summary, for the Activity list and its ring.
    fn summary_of(record: &CallRecord, keys: &HashMap<String, u64>) -> AuthActivitySummary {
        let message_of = |key: &str| keys.get(key).copied();
        let more_steps = record.steps.len().saturating_sub(MAX_STEPS);
        AuthActivitySummary {
            id: record.id,
            at: wire::at_millis(record.at_millis),
            duration_micros: u64::try_from(record.duration.as_micros()).unwrap_or(u64::MAX),
            project: record.project.clone(),
            tenant: record.tenant.clone(),
            caller: record.caller.into(),
            origin: record.origin.map(Into::into),
            credential: record.credential.into(),
            client: record.client.clone(),
            method: record.method.clone(),
            path: record.path.clone(),
            operation: record.operation.clone(),
            kind: record.kind.into(),
            identifier: record.identifier.clone(),
            provider: record.provider.clone(),
            uid: record.uid.clone(),
            new_user: record.new_user,
            status: record.status,
            error: record.error.as_ref().map(|error| wire::AuthCallError {
                code: error.code.clone(),
                message: error.message.clone(),
            }),
            steps: record
                .steps
                .iter()
                .take(MAX_STEPS)
                .map(|step| wire::step(step, &message_of))
                .collect(),
            more_steps: u32::try_from(more_steps).unwrap_or(u32::MAX),
        }
    }

    /// Keeps the call (its bodies under their budget) and pushes it on the
    /// activity ring.
    fn keep_call(&self, record: CallRecord, flags: u8, keys: &HashMap<String, u64>) {
        let summary = Self::summary_of(&record, keys);
        let json = json_of(&AuthActivityItem::Call {
            summary: Box::new(summary.clone()),
        });
        let (request, request_bytes) = body(&record.request);
        let (response, response_bytes) = body(&record.response);
        let kept = request.is_some() || response.is_some();
        let bodies = Bodies {
            kept: matches!(record.request, Body::Kept(_))
                && matches!(record.response, Body::Kept(_)),
            request,
            response,
            dropped: false,
        };
        let mut store = guard(&self.inner.activity);
        let entry = Arc::new(ActivityEntry {
            seq: store.next_seq,
            error_code: record.error.as_ref().map(|error| error.code.clone()),
            has: flags,
            summary,
            json: json.clone(),
            bodies: Mutex::new(bodies),
            request_bytes,
            response_bytes,
            query: record.query,
            headers: record.headers,
        });
        store.next_seq += 1;
        store.bytes += json.len();
        store.by_id.insert(entry.summary.id, entry.clone());
        store.entries.push_back(entry.clone());
        if kept {
            store.body_bytes += guard(&entry.bodies).weight();
            store.with_bodies.push_back(entry.clone());
        }
        while store.entries.len() > ACTIVITY_CAPACITY
            || (store.bytes > ACTIVITY_BYTES && store.entries.len() > 1)
        {
            let Some(old) = store.entries.pop_front() else {
                break;
            };
            store.bytes -= old.json.len();
            store.by_id.remove(&old.summary.id);
        }
        while store.body_bytes > BODY_BUDGET {
            let Some(old) = store.with_bodies.pop_front() else {
                break;
            };
            let mut bodies = guard(&old.bodies);
            store.body_bytes -= bodies.weight();
            bodies.request = None;
            bodies.response = None;
            bodies.dropped = true;
        }
        // Pushed under the store's lock, so a page read under it and the
        // ring position read with it agree.
        self.inner
            .activity_ring
            .push(ActivityMeta::Call(entry), json);
    }
}

impl AuthFeed {
    fn queue(&self, key: UserKey) {
        if self.inner.users.try_send(key).is_err() {
            self.inner.overflow.store(true, Ordering::Release);
        }
    }
}

/// A recorded body as kept, and its length.
fn body(body: &Body) -> (Option<Bytes>, u64) {
    match body {
        Body::Kept(bytes) => (
            Some(bytes.clone()),
            u64::try_from(bytes.len()).unwrap_or(u64::MAX),
        ),
        Body::Dropped { bytes } => (None, *bytes),
        Body::NotKept => (None, 0),
    }
}

/// The runtime a feed listens to, for the section's readers.
pub(crate) fn attach(runtime: &firenook_auth_front::AuthRuntime, feed: &AuthFeed) {
    runtime.set_observer(Arc::new(feed.clone()), feed.keeps_bodies());
}

/// Saved codes, for the inbox's first entries.
pub(crate) fn saved(runtime: &Runtime) -> Vec<MessageRecord> {
    runtime.saved_messages()
}
