//! Resumable upload sessions an app started and has not finished.
//!
//! A session used to leave the service only when it was finalized, so one
//! the app abandoned kept its staged bytes for ever. Now every session
//! carries when it started and when it last moved; a console lists them
//! (newest activity first), may discard one, and a sweep removes those idle
//! for seven days with their bytes — the life of a production resumable
//! session URI, so nothing that works against production stops working.

use std::time::Duration;

use crate::console::ConsoleError;
use crate::rules::auth_from_authorization;
use crate::write::Pending;
use crate::{StorageData, StorageState, lock, now_millis};

/// How long a session may sit idle before it is swept.
pub const SESSION_IDLE: Duration = Duration::from_hours(24 * 7);
/// How often the sweep runs after the one at open.
const SWEEP_EVERY: Duration = Duration::from_hours(1);

/// Where a session stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionState {
    /// Receiving bytes, or waiting for more.
    Active,
    /// The rules refused its finalize.
    Denied,
    /// The client cancelled it.
    Cancelled,
}

/// One unfinished resumable upload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionView {
    pub id: String,
    pub bucket: String,
    pub name: String,
    pub received: u64,
    /// The size the client declared, when it did.
    pub total: Option<u64>,
    /// Unix milliseconds.
    pub started_at_ms: i64,
    pub updated_at_ms: i64,
    /// The uid of the session's Authorization; `None` for Admin or an
    /// unauthenticated client.
    pub uid: Option<String>,
    /// Started with owner credentials.
    pub admin: bool,
    pub state: SessionState,
}

/// Where a page of sessions continues: newest activity first, then by id.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SessionCursor {
    pub u: i64,
    pub i: String,
}

impl SessionCursor {
    /// The order of the list: later activity first.
    fn key(&self) -> (std::cmp::Reverse<i64>, &str) {
        (std::cmp::Reverse(self.u), self.i.as_str())
    }
}

/// One page of sessions.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SessionPage {
    pub sessions: Vec<(SessionView, SessionCursor)>,
    pub more_after: bool,
    pub more_before: bool,
}

/// Gives sessions an older engine recorded the time the service opened.
pub(crate) fn stamp_unknown(data: &mut StorageData, now_ms: i64) {
    for session in data.uploads.values_mut() {
        if session.updated_at_ms == 0 {
            session.updated_at_ms = now_ms;
        }
        if session.started_at_ms == 0 {
            session.started_at_ms = session.updated_at_ms;
        }
    }
}

/// The sessions of `bucket`, newest activity first, paged after `after` or
/// before `before`.
pub(crate) fn list(
    state: &StorageState,
    bucket: &str,
    after: Option<&SessionCursor>,
    before: Option<&SessionCursor>,
    limit: usize,
) -> SessionPage {
    let limit = limit.max(1);
    let mut sessions = {
        let data = lock(&state.inner);
        data.uploads
            .values()
            .filter(|session| session.bucket == bucket)
            .map(|session| {
                let auth = session
                    .authorization
                    .as_deref()
                    .filter(|value| !matches!(*value, "Bearer owner" | "Firebase owner"));
                (
                    SessionView {
                        id: session.id.clone(),
                        bucket: session.bucket.clone(),
                        name: session.name.clone(),
                        received: session.received,
                        total: session.total,
                        started_at_ms: session.started_at_ms,
                        updated_at_ms: session.updated_at_ms,
                        uid: auth
                            .and_then(|value| auth_from_authorization(Some(value)))
                            .and_then(|auth| auth.uid),
                        admin: matches!(
                            session.authorization.as_deref(),
                            Some("Bearer owner" | "Firebase owner")
                        ),
                        state: if session.denied {
                            SessionState::Denied
                        } else if session.cancelled {
                            SessionState::Cancelled
                        } else {
                            SessionState::Active
                        },
                    },
                    SessionCursor {
                        u: session.updated_at_ms,
                        i: session.id.clone(),
                    },
                )
            })
            .collect::<Vec<_>>()
    };
    sessions.sort_by(|left, right| left.1.key().cmp(&right.1.key()));
    let range = match (after, before) {
        (_, Some(before)) => {
            let end = sessions.partition_point(|(_, cursor)| cursor.key() < before.key());
            end.saturating_sub(limit)..end
        }
        (Some(after), None) => {
            let start = sessions.partition_point(|(_, cursor)| cursor.key() <= after.key());
            start..(start + limit).min(sessions.len())
        }
        (None, None) => 0..limit.min(sessions.len()),
    };
    let more_after = range.end < sessions.len();
    let more_before = range.start > 0;
    SessionPage {
        sessions: sessions.drain(range).collect(),
        more_after,
        more_before,
    }
}

/// Removes session `id` of `bucket` and its staged bytes; a later request on
/// it is 404, as after a sweep.
pub(crate) async fn discard(
    state: &StorageState,
    bucket: &str,
    id: &str,
) -> Result<(), ConsoleError> {
    let guard = state.mutation.lock().await;
    let mut pending = Pending::default();
    let removed = {
        let mut data = lock(&state.inner);
        if data
            .uploads
            .get(id)
            .is_none_or(|session| session.bucket != bucket)
        {
            return Err(ConsoleError::NotFound(format!(
                "No upload session {id} in gs://{bucket}."
            )));
        }
        data.remove_session(id)
    };
    if let Some(session) = removed {
        pending.upload(session.id);
        pending.unlink(state.config.data_dir.join(&session.staging_file));
    }
    pending
        .commit(state)
        .await
        .map_err(|error| ConsoleError::Internal(error.message))?;
    drop(guard);
    Ok(())
}

/// Removes every session idle since before `now_ms` less [`SESSION_IDLE`]
/// with its staged bytes, and says how many and how many bytes went.
pub(crate) async fn sweep(state: &StorageState, now_ms: i64) -> Result<(u64, u64), ConsoleError> {
    let idle_ms = i64::try_from(SESSION_IDLE.as_millis()).unwrap_or(i64::MAX);
    let guard = state.mutation.lock().await;
    let mut pending = Pending::default();
    let (count, bytes) = {
        let mut data = lock(&state.inner);
        let idle = data
            .uploads
            .values()
            .filter(|session| session.updated_at_ms.saturating_add(idle_ms) <= now_ms)
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();
        let mut bytes = 0_u64;
        for id in &idle {
            if let Some(session) = data.remove_session(id) {
                bytes = bytes.saturating_add(session.received);
                pending.upload(session.id);
                pending.unlink(state.config.data_dir.join(&session.staging_file));
            }
        }
        (u64::try_from(idle.len()).unwrap_or(u64::MAX), bytes)
    };
    pending
        .commit(state)
        .await
        .map_err(|error| ConsoleError::Internal(error.message))?;
    drop(guard);
    Ok((count, bytes))
}

/// Sweeps at open and then hourly, until the service stops.
pub(crate) fn spawn_sweep(state: &StorageState) {
    let sweeper = state.clone();
    let stopped = state.tasks.stopped();
    state.tasks.spawn(async move {
        tokio::pin!(stopped);
        loop {
            match sweep(&sweeper, now_millis()).await {
                Ok((count, bytes)) if count > 0 => println!(
                    "firenook storage: removed {count} upload {} idle for 7 days ({})",
                    if count == 1 { "session" } else { "sessions" },
                    crate::staging::format_bytes(bytes)
                ),
                Ok(_) => {}
                Err(error) => {
                    eprintln!("firenook storage: the upload session sweep failed: {error}");
                }
            }
            tokio::select! {
                () = &mut stopped => return,
                () = tokio::time::sleep(SWEEP_EVERY) => {}
            }
        }
    });
}
