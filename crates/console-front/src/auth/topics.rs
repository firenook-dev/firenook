//! Auth's live topics, on the one live channel.
//!
//! - `auth.users` `{ project?, tenant? }`: the accounts of one scope that
//!   changed, coalesced by the engine in 100 ms windows with keys
//!   deduplicated and fields merged; a token refresh alone sends nothing; a
//!   window past 1,000 keys, or a queue that overflowed, is a reset. Resume
//!   compares the scope's index generation.
//! - `auth.activity` `{ project?, tenant?, q?, console? }` and `auth.inbox`
//!   `{ project?, tenant?, q? }`: feeds over the activity and inbox rings,
//!   filtered by the engine with the page's `q` (a bad `q` is refused in
//!   the subscription's answer), through the foundation's `replay_topic`.
//! - `auth.config` `{ project? }`: configuration changes; resume compares
//!   the configuration revision.
//! - `auth.hooks` `{ project? }`: the blocking functions may have changed;
//!   resume compares the runtime's change count.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use firenook_auth_front::Runtime;
use firenook_auth_front::observe::UserChange;
use futures_util::StreamExt as _;
use futures_util::stream::{self, BoxStream};
use tokio::sync::{broadcast, mpsc, watch};
use tokio::time::Instant;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tokio_stream::wrappers::{BroadcastStream, WatchStream};

use super::feed::{ActivityMeta, AuthFeed, InboxMeta, UserKey};
use super::filter::{ActivityFilter, MessageFilter, now_minute};
use super::wire::{
    AuthActivityParams, AuthConfigParams, AuthInboxParams, AuthUserChangeEntry, AuthUserChangeKind,
    AuthUsersChanged, AuthUsersCleared, AuthUsersParams,
};
use crate::api_error::ApiError;
use crate::live::replay::{ReplayOptions, replay_topic};
use crate::live::{LiveTopic, ResetReason, TopicEvent, TopicStream, topic_params};
use crate::sse::Shutdown;

/// How long the coalescer collects account changes into one window.
pub(crate) const WINDOW: Duration = Duration::from_millis(100);
/// Keys one window holds; more becomes a reset.
pub(crate) const MAX_WINDOW_KEYS: usize = 1_000;
/// Windows buffered for slow subscribers.
const WINDOW_BUFFER: usize = 512;
/// The shortest gap between two status ticks.
pub(crate) const STATUS_EVERY: Duration = Duration::from_millis(500);

/// One coalesced window of one scope (or every scope, for a reset).
#[derive(Clone, Debug)]
pub(crate) enum UsersWindow {
    Changed {
        project: Arc<str>,
        tenant: Option<String>,
        changes: Arc<str>,
        generation: u64,
    },
    Cleared {
        project: Arc<str>,
        tenant: Option<String>,
        generation: u64,
    },
    /// Too much changed to name: every subscriber reloads.
    Reset,
}

/// The windows the coalescer sends, shared by every `auth.users`
/// subscription.
#[derive(Clone)]
pub(crate) struct UsersWindows {
    sender: broadcast::Sender<UsersWindow>,
}

impl UsersWindows {
    pub(crate) fn new() -> Self {
        let (sender, _) = broadcast::channel(WINDOW_BUFFER);
        Self { sender }
    }
}

/// One account's merged change within a window.
struct Merged {
    change: UserChange,
    fields: Vec<String>,
}

/// Merges `change` into what the window holds for an account: created then
/// updated stays created, anything then deleted is deleted, updates merge
/// their fields.
fn merge(merged: &mut Merged, change: UserChange, fields: Vec<String>) {
    match (merged.change, change) {
        (UserChange::Created, UserChange::Updated) => {}
        (_, UserChange::Deleted) => {
            merged.change = UserChange::Deleted;
            merged.fields.clear();
        }
        (_, UserChange::Created) => {
            merged.change = UserChange::Created;
            merged.fields.clear();
        }
        (_, UserChange::Updated) => {
            for field in fields {
                if !merged.fields.contains(&field) {
                    merged.fields.push(field);
                }
            }
        }
    }
}

type Scope = (Arc<str>, Option<String>);

/// The coalescer: every 100 ms after the first queued change it drains the
/// queue, merges per account, drops refresh-only updates and broadcasts one
/// window per scope. A window with a created or deleted account (or moved
/// counts) ticks the section's status, at most every 500 ms. Ends when the
/// suite stops.
pub(crate) async fn coalesce(
    feed: AuthFeed,
    mut queue: mpsc::Receiver<UserKey>,
    runtime: Runtime,
    windows: UsersWindows,
    status: watch::Sender<u64>,
    shutdown: Shutdown,
) {
    let stopped = shutdown.stopped();
    tokio::pin!(stopped);
    let mut last_tick: Option<Instant> = None;
    let mut tick_pending = false;
    loop {
        let due =
            tick_pending.then(|| last_tick.map_or_else(Instant::now, |last| last + STATUS_EVERY));
        let never = Instant::now() + Duration::from_hours(24);
        tokio::select! {
            () = &mut stopped => return,
            () = tokio::time::sleep_until(due.unwrap_or(never)), if due.is_some() => {
                tick(&status, &mut last_tick, &mut tick_pending);
            }
            first = queue.recv() => {
                let Some(first) = first else { return };
                tokio::select! {
                    () = &mut stopped => return,
                    () = tokio::time::sleep(WINDOW) => {}
                }
                let mut keys = vec![first];
                while let Ok(key) = queue.try_recv() {
                    keys.push(key);
                }
                let moved = window(&feed, keys, &runtime, &windows);
                if moved {
                    tick_pending = true;
                    if last_tick.is_none_or(|last| last.elapsed() >= STATUS_EVERY) {
                        tick(&status, &mut last_tick, &mut tick_pending);
                    }
                }
            }
        }
    }
}

fn tick(status: &watch::Sender<u64>, last: &mut Option<Instant>, pending: &mut bool) {
    status.send_modify(|ticks| *ticks = ticks.wrapping_add(1));
    *last = Some(Instant::now());
    *pending = false;
}

/// Sends one window per scope from `keys`; answers whether counts moved.
fn window(feed: &AuthFeed, keys: Vec<UserKey>, runtime: &Runtime, windows: &UsersWindows) -> bool {
    let overflowed = feed.take_overflow();
    let mut moved = overflowed;
    let mut scopes: BTreeMap<Scope, BTreeMap<String, Merged>> = BTreeMap::new();
    let mut cleared: Vec<Scope> = Vec::new();
    for key in keys {
        match key {
            UserKey::Changed {
                project,
                tenant,
                uid,
                change,
                fields,
            } => {
                if change != UserChange::Updated {
                    moved = true;
                }
                let accounts = scopes.entry((project, tenant)).or_default();
                match accounts.get_mut(&uid) {
                    Some(merged) => merge(merged, change, fields),
                    None => {
                        accounts.insert(uid, Merged { change, fields });
                    }
                }
            }
            UserKey::Cleared { project, tenant } => {
                moved = true;
                let scope = (project, tenant);
                scopes.remove(&scope);
                if !cleared.contains(&scope) {
                    cleared.push(scope);
                }
            }
            UserKey::CountsMoved => moved = true,
        }
    }
    if overflowed {
        let _ = windows.sender.send(UsersWindow::Reset);
        return moved;
    }
    let generation = |project: &str, tenant: Option<&str>| {
        runtime
            .users(project, tenant)
            .map_or(0, |view| view.generation())
    };
    for (project, tenant) in cleared {
        let generation = generation(&project, tenant.as_deref());
        let _ = windows.sender.send(UsersWindow::Cleared {
            project,
            tenant,
            generation,
        });
    }
    for ((project, tenant), accounts) in scopes {
        // A token refresh changes only `lastRefreshAt`, which no column
        // shows: it is never sent.
        let changes: Vec<AuthUserChangeEntry> = accounts
            .into_iter()
            .filter(|(_, merged)| {
                !(merged.change == UserChange::Updated
                    && merged.fields.iter().all(|field| field == "lastRefreshAt"))
            })
            .map(|(uid, merged)| AuthUserChangeEntry {
                uid,
                change: AuthUserChangeKind::from(merged.change),
                fields: merged.fields,
            })
            .collect();
        if changes.is_empty() {
            continue;
        }
        if changes.len() > MAX_WINDOW_KEYS {
            let _ = windows.sender.send(UsersWindow::Reset);
            continue;
        }
        let generation = generation(&project, tenant.as_deref());
        let data = serde_json::to_string(&AuthUsersChanged {
            tenant: tenant.clone(),
            changes,
        })
        .unwrap_or_else(|_| "null".to_owned());
        let _ = windows.sender.send(UsersWindow::Changed {
            project,
            tenant,
            changes: Arc::from(data),
            generation,
        });
    }
    moved
}

/// The project a topic's params name: absent or empty is the configured
/// one.
fn project_of(param: Option<&String>, configured: &str) -> String {
    param
        .filter(|project| !project.is_empty())
        .cloned()
        .unwrap_or_else(|| configured.to_owned())
}

/// A stream that ends when the suite stops.
fn until_stopped(stream: TopicStream, shutdown: &Shutdown) -> TopicStream {
    stream.take_until(shutdown.clone().stopped()).boxed()
}

/// `auth.users`.
pub(crate) struct UsersTopic {
    pub(crate) runtime: Runtime,
    pub(crate) windows: UsersWindows,
    pub(crate) shutdown: Shutdown,
}

impl LiveTopic for UsersTopic {
    fn name(&self) -> &'static str {
        "auth.users"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: AuthUsersParams = topic_params(params)?;
        let project = project_of(params.project.as_ref(), self.runtime.default_project());
        let tenant = params.tenant.filter(|tenant| !tenant.is_empty());
        // Subscribe before reading the generation, so nothing in between is
        // missed.
        let receiver = self.windows.sender.subscribe();
        let current = self
            .runtime
            .users(&project, tenant.as_deref())
            .map_err(super::routes::console_error)?
            .generation();
        let first = after
            .filter(|after| *after != current.to_string())
            .map(|_| TopicEvent::Reset {
                reason: ResetReason::Gap,
                missed: None,
            });
        let project: Arc<str> = Arc::from(project);
        let events = BroadcastStream::new(receiver).filter_map(move |window| {
            let project = project.clone();
            let tenant = tenant.clone();
            async move {
                match window {
                    Ok(UsersWindow::Changed {
                        project: scope,
                        tenant: scope_tenant,
                        changes,
                        generation,
                    }) => (scope == project && scope_tenant == tenant).then(|| TopicEvent::Event {
                        name: "changed",
                        cursor: Some(Arc::from(generation.to_string())),
                        data: changes,
                    }),
                    Ok(UsersWindow::Cleared {
                        project: scope,
                        tenant: scope_tenant,
                        generation,
                    }) => (scope == project && scope_tenant == tenant).then(|| {
                        TopicEvent::json(
                            "cleared",
                            Some(generation.to_string()),
                            &AuthUsersCleared {
                                tenant: scope_tenant,
                            },
                        )
                    }),
                    Ok(UsersWindow::Reset) | Err(BroadcastStreamRecvError::Lagged(_)) => {
                        Some(TopicEvent::Reset {
                            reason: ResetReason::Lagged,
                            missed: None,
                        })
                    }
                }
            }
        });
        Ok(until_stopped(
            stream::iter(first).chain(events).boxed(),
            &self.shutdown,
        ))
    }
}

/// `auth.activity`.
pub(crate) struct ActivityTopic {
    pub(crate) feed: AuthFeed,
    pub(crate) project: Arc<str>,
    pub(crate) shutdown: Shutdown,
}

impl LiveTopic for ActivityTopic {
    fn name(&self) -> &'static str {
        "auth.activity"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: AuthActivityParams = topic_params(params)?;
        let project = project_of(params.project.as_ref(), &self.project);
        let filter = ActivityFilter::new(
            &project,
            params.tenant.as_deref().filter(|tenant| !tenant.is_empty()),
            params.q.as_deref().unwrap_or_default(),
            params.console,
            now_minute(),
        )?;
        let filter = Arc::new(filter);
        let stream = replay_topic(
            self.feed.activity_ring(),
            after,
            "calls",
            ReplayOptions {
                filter: Some(Arc::new(move |meta: &ActivityMeta| match meta {
                    ActivityMeta::Call(entry) => filter.matches(entry),
                    ActivityMeta::Cleared { project } => **project == *filter.project(),
                })),
                ..ReplayOptions::default()
            },
        );
        Ok(until_stopped(stream, &self.shutdown))
    }
}

/// `auth.inbox`.
pub(crate) struct InboxTopic {
    pub(crate) feed: AuthFeed,
    pub(crate) project: Arc<str>,
    pub(crate) shutdown: Shutdown,
}

impl LiveTopic for InboxTopic {
    fn name(&self) -> &'static str {
        "auth.inbox"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: AuthInboxParams = topic_params(params)?;
        let project = project_of(params.project.as_ref(), &self.project);
        let filter = Arc::new(MessageFilter::new(
            &project,
            params.tenant.as_deref().filter(|tenant| !tenant.is_empty()),
            params.q.as_deref().unwrap_or_default(),
            now_minute(),
        )?);
        let stream = replay_topic(
            self.feed.inbox_ring(),
            after,
            "messages",
            ReplayOptions {
                filter: Some(Arc::new(move |meta: &InboxMeta| match meta {
                    InboxMeta::Issued(entry) | InboxMeta::Used(entry) => filter.matches(entry),
                    InboxMeta::Cleared { project } => **project == *filter.project(),
                })),
                ..ReplayOptions::default()
            },
        );
        Ok(until_stopped(stream, &self.shutdown))
    }
}

/// `auth.config`.
pub(crate) struct ConfigTopic {
    pub(crate) feed: AuthFeed,
    pub(crate) project: Arc<str>,
    pub(crate) shutdown: Shutdown,
}

impl LiveTopic for ConfigTopic {
    fn name(&self) -> &'static str {
        "auth.config"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: AuthConfigParams = topic_params(params)?;
        let project: Arc<str> = Arc::from(project_of(params.project.as_ref(), &self.project));
        let receiver = self.feed.config_changes();
        let current = self.feed.config_revision();
        let first = after
            .filter(|after| *after != current.to_string())
            .map(|_| TopicEvent::Reset {
                reason: ResetReason::Gap,
                missed: None,
            });
        let events = BroadcastStream::new(receiver).filter_map(move |event| {
            let project = project.clone();
            async move {
                match event {
                    Ok(event) => (event.project == project).then(|| {
                        TopicEvent::json("changed", Some(event.revision.to_string()), &event.change)
                    }),
                    Err(BroadcastStreamRecvError::Lagged(_)) => Some(TopicEvent::Reset {
                        reason: ResetReason::Lagged,
                        missed: None,
                    }),
                }
            }
        });
        Ok(until_stopped(
            stream::iter(first).chain(events).boxed(),
            &self.shutdown,
        ))
    }
}

/// `auth.hooks`.
pub(crate) struct HooksTopic {
    pub(crate) runtime: Runtime,
    pub(crate) shutdown: Shutdown,
}

impl LiveTopic for HooksTopic {
    fn name(&self) -> &'static str {
        "auth.hooks"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let _params: AuthConfigParams = topic_params(params)?;
        let mut changes = self.runtime.blocking_changes();
        let current = *changes.borrow_and_update();
        let first = after
            .filter(|after| *after != current.to_string())
            .map(|_| TopicEvent::Reset {
                reason: ResetReason::Gap,
                missed: None,
            });
        let events: BoxStream<'static, TopicEvent> = WatchStream::from_changes(changes)
            .map(|value| {
                TopicEvent::json(
                    "changed",
                    Some(value.to_string()),
                    &serde_json::Map::<String, serde_json::Value>::new(),
                )
            })
            .boxed();
        Ok(until_stopped(
            stream::iter(first).chain(events).boxed(),
            &self.shutdown,
        ))
    }
}
