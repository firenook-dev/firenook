//! Persistence that scales: the state is snapshotted under the data lock in
//! O(1) and encoded and written outside it, off the request path.
//!
//! A request that changed the state only marks it dirty and wakes the
//! writer, a thread of its own (the runtime is used without tokio in tests,
//! and `scope` is synchronous). The writer waits `max(250 ms, 4 × the last
//! encode)` so a burst of changes becomes one write, takes the data lock
//! only to clone a [`PersistSnapshot`] — `im` maps, so reference counts, not
//! accounts — then encodes compact JSON from it and publishes the file
//! atomically. A sign-in therefore never waits for an encode, whatever the
//! number of users.
//!
//! [`Persister::flush`] writes synchronously when dirty: the native
//! checkpoint, imports and the suite's shutdown call it, and so does the last
//! runtime handle when it drops.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufWriter, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use im::OrdMap;
use serde::Serialize;
use serde_json::{Map as JsonMap, Value as JsonValue};

use crate::AuthError;
use crate::state::{AuthData, OobRecord, TemporaryProof, UserRecord, VerificationRecord};

/// The shortest wait between the first change and its write.
pub(crate) const WRITE_DELAY: Duration = Duration::from_millis(250);
/// The wait is at least this many times the last encode, so a very large
/// state is not re-encoded back to back.
const ENCODE_FACTOR: u32 = 4;

/// What one write encodes: every project and tenant's persisted maps,
/// cloned in O(1) each, and their small configuration maps. Serializes to
/// exactly the JSON of [`AuthData`].
#[derive(Serialize)]
pub(crate) struct PersistSnapshot {
    version: u32,
    projects: BTreeMap<String, AgentSnapshot>,
}

#[derive(Serialize)]
struct AgentSnapshot {
    #[serde(flatten)]
    project: ProjectSnapshot,
    config: JsonMap<String, JsonValue>,
    tenants: BTreeMap<String, TenantSnapshot>,
}

#[derive(Serialize)]
struct TenantSnapshot {
    #[serde(flatten)]
    project: ProjectSnapshot,
    config: JsonMap<String, JsonValue>,
}

#[derive(Serialize)]
struct ProjectSnapshot {
    users: OrdMap<String, Arc<UserRecord>>,
    oobs: OrdMap<String, OobRecord>,
    #[serde(rename = "verificationCodes")]
    verification_codes: OrdMap<String, VerificationRecord>,
    #[serde(rename = "temporaryProofs")]
    temporary_proofs: OrdMap<String, TemporaryProof>,
}

impl ProjectSnapshot {
    fn of(project: &crate::state::ProjectState) -> Self {
        Self {
            users: project.users.clone(),
            oobs: project.oobs.clone(),
            verification_codes: project.verification_codes.clone(),
            temporary_proofs: project.temporary_proofs.clone(),
        }
    }
}

impl AuthData {
    /// The persisted state, for an encode outside the lock: O(1) per project
    /// and tenant (the maps are `im`), plus their configuration maps.
    pub(crate) fn persist_snapshot(&self) -> PersistSnapshot {
        PersistSnapshot {
            version: self.version,
            projects: self
                .projects
                .iter()
                .map(|(id, agent)| {
                    (
                        id.clone(),
                        AgentSnapshot {
                            project: ProjectSnapshot::of(&agent.project),
                            config: agent.config.clone(),
                            tenants: agent
                                .tenants
                                .iter()
                                .map(|(id, tenant)| {
                                    (
                                        id.clone(),
                                        TenantSnapshot {
                                            project: ProjectSnapshot::of(&tenant.project),
                                            config: tenant.config.clone(),
                                        },
                                    )
                                })
                                .collect(),
                        },
                    )
                })
                .collect(),
        }
    }
}

/// Whether the state needs writing, and whether the writer should stop.
#[derive(Default)]
struct Signal {
    dirty: bool,
    stopping: bool,
}

/// What the runtime and its writer thread share.
struct Shared {
    file: PathBuf,
    signal: Mutex<Signal>,
    wake: Condvar,
    /// Held across snapshot, encode and write, so files are published in
    /// the order their snapshots were taken.
    write: Mutex<()>,
    /// Encodes so far.
    encodes: AtomicU64,
    /// The last encode and write, microseconds.
    last_encode: AtomicU64,
    /// The longest the data lock was held to take a snapshot, nanoseconds.
    longest_hold: AtomicU64,
    /// The last write that failed, kept for the next flush to report.
    failure: Mutex<Option<String>>,
}

/// Figures about the writer, for the tests and the bench.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PersistStats {
    /// Encodes since the runtime started.
    pub encodes: u64,
    /// The last encode and write.
    pub last_encode: Duration,
    /// The longest the writer held the data lock to snapshot the state.
    pub longest_hold: Duration,
}

/// The state file's writer.
pub(crate) struct Persister {
    shared: Arc<Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn nanos(duration: Duration) -> u64 {
    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
}

impl Persister {
    /// A writer for `file`, reading the state from `data`.
    pub(crate) fn start(file: PathBuf, data: Arc<Mutex<AuthData>>) -> Result<Self, AuthError> {
        let shared = Arc::new(Shared {
            file,
            signal: Mutex::new(Signal::default()),
            wake: Condvar::new(),
            write: Mutex::new(()),
            encodes: AtomicU64::new(0),
            last_encode: AtomicU64::new(0),
            longest_hold: AtomicU64::new(0),
            failure: Mutex::new(None),
        });
        let writer = shared.clone();
        let thread = std::thread::Builder::new()
            .name("auth-state-writer".to_owned())
            .spawn(move || writer.run(&data))
            .map_err(|error| {
                AuthError(format!("failed to start the Auth state writer: {error}"))
            })?;
        Ok(Self {
            shared,
            thread: Mutex::new(Some(thread)),
        })
    }

    /// The state changed: it is written within [`WRITE_DELAY`] (more on very
    /// large states).
    pub(crate) fn mark_dirty(&self) {
        let mut signal = guard(&self.shared.signal);
        if !signal.dirty {
            signal.dirty = true;
            self.shared.wake.notify_all();
        }
    }

    /// Writes the state now when it changed since the last write (or always
    /// with `force`), and reports a background write that failed since.
    pub(crate) fn flush(&self, data: &Mutex<AuthData>, force: bool) -> Result<(), AuthError> {
        // A failed background write left the state dirty, so this retries
        // it; once a write succeeds the earlier failure no longer matters.
        let written = self.shared.write_now(data, force);
        if written.is_ok() {
            guard(&self.shared.failure).take();
        }
        written
    }

    /// Stops the writer and writes what is left.
    pub(crate) fn stop(&self, data: &Mutex<AuthData>) {
        guard(&self.shared.signal).stopping = true;
        self.shared.wake.notify_all();
        if let Some(thread) = guard(&self.thread).take() {
            let _ = thread.join();
        }
        let _ = self.shared.write_now(data, false);
    }

    pub(crate) fn stats(&self) -> PersistStats {
        PersistStats {
            encodes: self.shared.encodes.load(Ordering::Relaxed),
            last_encode: Duration::from_micros(self.shared.last_encode.load(Ordering::Relaxed)),
            longest_hold: Duration::from_nanos(self.shared.longest_hold.load(Ordering::Relaxed)),
        }
    }
}

impl Shared {
    /// The writer thread: waits for a change, lets a burst gather, writes.
    fn run(&self, data: &Mutex<AuthData>) {
        loop {
            {
                let mut signal = guard(&self.signal);
                while !signal.dirty && !signal.stopping {
                    signal = self
                        .wake
                        .wait(signal)
                        .unwrap_or_else(PoisonError::into_inner);
                }
                if signal.stopping {
                    return;
                }
                let encode = Duration::from_micros(self.last_encode.load(Ordering::Relaxed));
                let deadline = Instant::now() + WRITE_DELAY.max(encode * ENCODE_FACTOR);
                loop {
                    let now = Instant::now();
                    if signal.stopping {
                        return;
                    }
                    if now >= deadline || !signal.dirty {
                        break;
                    }
                    signal = self
                        .wake
                        .wait_timeout(signal, deadline - now)
                        .unwrap_or_else(PoisonError::into_inner)
                        .0;
                }
            }
            if let Err(error) = self.write_now(data, false) {
                *guard(&self.failure) = Some(error.0);
            }
        }
    }

    /// Snapshot under the data lock, encode and publish outside it.
    fn write_now(&self, data: &Mutex<AuthData>, force: bool) -> Result<(), AuthError> {
        let _publishing = guard(&self.write);
        {
            let mut signal = guard(&self.signal);
            if !signal.dirty && !force {
                return Ok(());
            }
            // Cleared before the snapshot: a change made after this point
            // marks the state dirty again and is written next time.
            signal.dirty = false;
        }
        let started = Instant::now();
        let snapshot = {
            let data = guard(data);
            let held = Instant::now();
            let snapshot = data.persist_snapshot();
            self.longest_hold
                .fetch_max(nanos(held.elapsed()), Ordering::Relaxed);
            snapshot
        };
        let written = write_compact(&self.file, &snapshot);
        drop(snapshot);
        self.encodes.fetch_add(1, Ordering::Relaxed);
        self.last_encode.store(
            u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX),
            Ordering::Relaxed,
        );
        if written.is_err() {
            // Try again with the next change or flush.
            guard(&self.signal).dirty = true;
        }
        written
    }
}

/// Compact JSON of `value`, written to a temporary file beside `path` and
/// renamed over it, so a reader never sees half a file.
fn write_compact(path: &Path, value: &impl Serialize) -> Result<(), AuthError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            AuthError(format!("failed to create Auth state directory: {error}"))
        })?;
    }
    let temporary = path.with_extension("tmp");
    let file = File::create(&temporary)
        .map_err(|error| AuthError(format!("failed to write Auth state: {error}")))?;
    let mut writer = BufWriter::with_capacity(256 * 1024, file);
    serde_json::to_writer(&mut writer, value)
        .map_err(|error| AuthError(format!("failed to serialize Auth state: {error}")))?;
    writer
        .flush()
        .map_err(|error| AuthError(format!("failed to write Auth state: {error}")))?;
    drop(writer);
    std::fs::rename(&temporary, path)
        .map_err(|error| AuthError(format!("failed to publish Auth state: {error}")))?;
    Ok(())
}

#[cfg(test)]
#[path = "persist_tests.rs"]
mod tests;
