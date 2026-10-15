//! Resumable upload sessions an app started and has not finished.
//!
//! A session used to leave the service only when it was finalized, so one
//! the app abandoned kept its staged bytes for ever. Now every session
//! carries when it started and when it last moved, and a sweep removes
//! those idle for seven days with their bytes — the life of a production
//! resumable session URI, so nothing that works against production stops
//! working.

use std::time::Duration;

use crate::console::ConsoleError;
use crate::write::Pending;
use crate::{StorageData, StorageState, lock, now_millis};

/// How long a session may sit idle before it is swept.
pub(crate) const SESSION_IDLE: Duration = Duration::from_hours(24 * 7);
/// How often the sweep runs after the one at open.
const SWEEP_EVERY: Duration = Duration::from_hours(1);

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
