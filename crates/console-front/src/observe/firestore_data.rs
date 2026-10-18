//! Firestore's Overview figures and its reset: the Firestore section's
//! [`Section::summary`], [`Section::status_changes`] and [`Section::clear`]
//! delegate here, so the finished Firestore files carry only the hooks.
//!
//! The figures are O(1) to read on every status tick: the document count is
//! the store snapshot's logical entry count less the documents of other
//! projects (an app that names another project id writes there), and the
//! database count is a set kept up to date from the commits the change feed
//! already observes. Both are seeded once, on the blocking pool, the first
//! time the Overview asks: one key-only pass over this project's documents
//! tells its own from the rest; from then on each commit's changes to other
//! projects move their count. A commit that creates the first document of a
//! database adds it at once, and one that deletes a document marks its
//! database as possibly empty, which a check on the blocking pool confirms
//! at most once every 5 seconds with [`Snapshot::has_documents`] (one seek),
//! never a walk of every key.
//!
//! [`Section::summary`]: crate::section::Section::summary
//! [`Section::status_changes`]: crate::section::Section::status_changes
//! [`Section::clear`]: crate::section::Section::clear
//! [`Snapshot::has_documents`]: firenook_core_store::Snapshot::has_documents

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use firenook_core_store::{
    CommitObservation, DatabaseName, Precondition, Revision, Store, WeakStore, Write,
};
use futures_util::FutureExt as _;
use futures_util::future::BoxFuture;
use futures_util::stream::{self, BoxStream, StreamExt as _};
use tokio::sync::watch;
use tokio::time::Instant;

use crate::api_error::ApiError;
use crate::blocking::blocking;
use crate::firestore::FirestoreConsole;
use crate::jobs::JobHandle;
use crate::section::{ClearOptions, ClearReport, SectionSummary, SummaryFigure, SummaryUnit};

/// The database a client addresses when it names none: always listed.
const DEFAULT_DATABASE: &str = "(default)";
/// How often a database that may have been emptied is checked, at most.
const EMPTINESS_CHECK: Duration = Duration::from_secs(5);
/// How often the section's summary may tick while its counts move.
const STATUS_TICK: Duration = Duration::from_millis(500);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Firestore's figures for the Overview, kept from the change feed's
/// commits. Cheap to clone; every clone shares the counts.
#[derive(Clone)]
pub(crate) struct FirestoreData {
    counting: Arc<OnceLock<Counting>>,
    /// Bumped when a commit creates or deletes a document, or a database
    /// check changes the count: the section's status ticks from it.
    ticks: Arc<watch::Sender<u64>>,
}

impl Default for FirestoreData {
    fn default() -> Self {
        Self {
            counting: Arc::new(OnceLock::new()),
            ticks: Arc::new(watch::Sender::new(0)),
        }
    }
}

/// The databases of one project, counted as commits land.
struct Counting {
    /// Weak: the commit observer holds this, and a [`Store`] here would keep
    /// the store open for good.
    store: WeakStore,
    project: Arc<str>,
    /// Listed whether or not they hold a document: `(default)` and the
    /// databases firebase.json declares.
    fixed: BTreeSet<String>,
    /// Databases known to hold a document.
    written: Mutex<BTreeSet<String>>,
    /// `fixed` ∪ `written`, read without a lock.
    databases: AtomicU64,
    /// Whether the seed (the store's databases when counting began) is in.
    seeded: AtomicBool,
    /// Databases a deletion may have emptied, for the next check.
    maybe_empty: Mutex<BTreeSet<String>>,
    /// A check is scheduled or running.
    checking: AtomicBool,
    /// When the last check ran.
    checked: Mutex<Option<Instant>>,
    /// The documents of other projects, which the store's entry count
    /// includes.
    foreign: Mutex<Foreign>,
    /// `foreign.count`, read without a lock once the seed is in.
    foreign_documents: AtomicU64,
}

/// Other projects' documents: counted by the seed, then moved by every
/// commit after the seed's snapshot.
#[derive(Default)]
struct Foreign {
    /// The revision of the seed's snapshot, once the seed is in.
    since: Option<Revision>,
    count: u64,
    /// What commits did to them before the seed was in, by revision: the
    /// seed's snapshot holds some of them already.
    early: Vec<(Revision, i64)>,
}

/// `count` moved by `delta`, never below zero.
fn moved_by(count: u64, delta: i64) -> u64 {
    if delta < 0 {
        count.saturating_sub(delta.unsigned_abs())
    } else {
        count.saturating_add(delta.unsigned_abs())
    }
}

impl Counting {
    /// One commit's creations (positive) and deletions (negative) of other
    /// projects' documents.
    fn foreign_moved(&self, revision: Revision, delta: i64) {
        let mut foreign = lock(&self.foreign);
        match foreign.since {
            Some(since) if revision > since => {
                foreign.count = moved_by(foreign.count, delta);
                self.foreign_documents
                    .store(foreign.count, Ordering::Release);
            }
            // The seed's snapshot holds it already.
            Some(_) => {}
            None => foreign.early.push((revision, delta)),
        }
    }

    /// Other projects' documents in the seed's snapshot at `revision`, with
    /// what commits after it did meanwhile.
    fn foreign_seeded(&self, revision: Revision, count: u64) {
        let mut foreign = lock(&self.foreign);
        let later = std::mem::take(&mut foreign.early)
            .into_iter()
            .filter(|(at, _)| *at > revision)
            .fold(count, |count, (_, delta)| moved_by(count, delta));
        foreign.since = Some(revision);
        foreign.count = later;
        self.foreign_documents.store(later, Ordering::Release);
    }

    fn count(&self, written: &BTreeSet<String>) {
        let total = self.fixed.len() + written.difference(&self.fixed).count();
        self.databases
            .store(u64::try_from(total).unwrap_or(u64::MAX), Ordering::Release);
    }

    /// Adds databases known to hold documents; whether the count moved.
    fn add<'a>(&self, databases: impl IntoIterator<Item = &'a str>) -> bool {
        let mut written = lock(&self.written);
        let mut grew = false;
        for database in databases {
            if !written.contains(database) {
                written.insert(database.to_owned());
                grew = true;
            }
        }
        if grew {
            self.count(&written);
        }
        grew
    }

    /// Confirms each possibly emptied database against the store: one seek
    /// each. Runs on the blocking pool.
    fn check(&self) -> bool {
        let candidates = std::mem::take(&mut *lock(&self.maybe_empty));
        if candidates.is_empty() {
            return false;
        }
        let Some(store) = self.store.upgrade() else {
            return false;
        };
        let snapshot = store.snapshot();
        let empty: Vec<String> = candidates
            .into_iter()
            .filter(|database| {
                DatabaseName::new(self.project.as_ref(), database.as_str())
                    .is_ok_and(|name| !snapshot.has_documents(&name))
            })
            .collect();
        if empty.is_empty() {
            return false;
        }
        let mut written = lock(&self.written);
        let before = written.len();
        for database in &empty {
            written.remove(database);
        }
        let shrank = written.len() != before;
        if shrank {
            self.count(&written);
        }
        shrank
    }
}

impl FirestoreData {
    /// One commit, from the change feed: O(1) per change. Housekeeping
    /// commits count too (a reset empties databases).
    pub(crate) fn committed(&self, observation: &CommitObservation) {
        let Some(counting) = self.counting.get() else {
            return;
        };
        let mut moved = false;
        let mut created: Vec<&str> = Vec::new();
        let mut foreign: Option<(Revision, i64)> = None;
        for change in &observation.changes {
            let database = change.key.database();
            if database.project_id() != counting.project.as_ref() {
                let delta = match (&change.before, &change.after) {
                    (None, Some(_)) => 1,
                    (Some(_), None) => -1,
                    _ => 0,
                };
                let (_, sum) = foreign.get_or_insert((change.revision, 0));
                *sum += delta;
                continue;
            }
            match (&change.before, &change.after) {
                (None, Some(_)) => {
                    moved = true;
                    if !created.contains(&database.database_id()) {
                        created.push(database.database_id());
                    }
                }
                (Some(_), None) => {
                    moved = true;
                    lock(&counting.maybe_empty).insert(database.database_id().to_owned());
                }
                _ => {}
            }
        }
        if !created.is_empty() {
            counting.add(created);
        }
        if let Some((revision, delta)) = foreign.filter(|(_, delta)| *delta != 0) {
            counting.foreign_moved(revision, delta);
            moved = true;
        }
        if moved {
            self.tick();
        }
    }

    fn tick(&self) {
        self.ticks
            .send_modify(|ticks| *ticks = ticks.wrapping_add(1));
    }

    /// The counting for `console`'s project, started on first use: the
    /// seed walks the store's databases once, on the blocking pool.
    fn counting(&self, console: &FirestoreConsole) -> &Counting {
        let mut started = false;
        let counting = self.counting.get_or_init(|| {
            started = true;
            let mut fixed: BTreeSet<String> =
                console.databases.declared().iter().cloned().collect();
            fixed.insert(DEFAULT_DATABASE.to_owned());
            Counting {
                store: console.changes.store().downgrade(),
                project: Arc::from(console.schema.project()),
                databases: AtomicU64::new(u64::try_from(fixed.len()).unwrap_or(u64::MAX)),
                fixed,
                written: Mutex::new(BTreeSet::new()),
                seeded: AtomicBool::new(false),
                maybe_empty: Mutex::new(BTreeSet::new()),
                checking: AtomicBool::new(false),
                checked: Mutex::new(None),
                foreign: Mutex::new(Foreign::default()),
                foreign_documents: AtomicU64::new(0),
            }
        });
        if started {
            self.seed(counting);
        }
        counting
    }

    /// The store's databases when counting began, joined with what commits
    /// added meanwhile, and the documents of other projects: the store's
    /// entries less this project's, counted key by key once.
    fn seed(&self, counting: &Counting) {
        let store = counting.store.clone();
        let project = counting.project.clone();
        let data = self.clone();
        let seed = move || {
            let Some(store) = store.upgrade() else {
                return;
            };
            let snapshot = store.snapshot();
            let databases = snapshot.databases(&project);
            let mut own: u64 = 0;
            for database in &databases {
                let mut keys = snapshot.key_cursor(database, "");
                while keys.next().is_some() {
                    own += 1;
                    // A close waits for this walk; it ends here instead.
                    if own.is_multiple_of(4096) && store.is_closing() {
                        return;
                    }
                }
            }
            let foreign = snapshot.logical_memory_usage().entries.saturating_sub(own);
            if let Some(counting) = data.counting.get() {
                counting.foreign_seeded(snapshot.revision(), foreign);
                counting.add(databases.iter().map(DatabaseName::database_id));
                counting.seeded.store(true, Ordering::Release);
            }
            data.tick();
        };
        match tokio::runtime::Handle::try_current() {
            // The walk (a seek per database on disk) stays off the runtime.
            Ok(runtime) => {
                runtime.spawn_blocking(seed);
            }
            Err(_) => seed(),
        }
    }

    /// Checks the databases a deletion may have emptied, at most once every
    /// 5 seconds, on the blocking pool.
    fn schedule_check(&self, counting: &Counting) {
        if lock(&counting.maybe_empty).is_empty() || counting.checking.swap(true, Ordering::AcqRel)
        {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            counting.checking.store(false, Ordering::Release);
            return;
        };
        let last = *lock(&counting.checked);
        let data = self.clone();
        runtime.spawn(async move {
            if let Some(last) = last {
                tokio::time::sleep_until(last + EMPTINESS_CHECK).await;
            }
            let checker = data.clone();
            let shrank = tokio::task::spawn_blocking(move || {
                checker.counting.get().is_some_and(Counting::check)
            })
            .await
            .unwrap_or(false);
            if let Some(counting) = data.counting.get() {
                *lock(&counting.checked) = Some(Instant::now());
                counting.checking.store(false, Ordering::Release);
                // A deletion that came in during the check waits for the
                // next one.
                if !lock(&counting.maybe_empty).is_empty() || shrank {
                    data.tick();
                }
            }
        });
    }
}

/// "211,260 documents · 3 databases", for the Overview's card and the nav
/// tooltip: lock-free reads, plus at most a scheduled emptiness check.
/// Until the seed is in, the documents are every project's (almost always
/// this one's alone) and the databases are not known yet.
pub(crate) fn summary(firestore: &FirestoreConsole) -> SectionSummary {
    let data = firestore.changes.data();
    let counting = data.counting(firestore);
    data.schedule_check(counting);
    let entries = firestore
        .changes
        .store()
        .snapshot()
        .logical_memory_usage()
        .entries;
    let seeded = counting.seeded.load(Ordering::Acquire);
    let documents = if seeded {
        entries.saturating_sub(counting.foreign_documents.load(Ordering::Acquire))
    } else {
        entries
    };
    let databases = seeded.then(|| counting.databases.load(Ordering::Acquire));
    firestore_summary(documents, databases, firestore.changes.store().file_bytes())
}

/// The Firestore summary from its figures; `databases` is `None` while the
/// seed is not in, and `on_disk` (the store file's size, beside which the
/// documents' count shows how much of it is theirs) for a store in memory.
pub(crate) fn firestore_summary(
    documents: u64,
    databases: Option<u64>,
    on_disk: Option<u64>,
) -> SectionSummary {
    let count = |count: u64, one: &str, many: &str| {
        format!(
            "{} {}",
            crate::observe::logs::grouped(usize::try_from(count).unwrap_or(usize::MAX)),
            if count == 1 { one } else { many }
        )
    };
    let headline = match databases {
        Some(databases) => format!(
            "{} · {}",
            count(documents, "document", "documents"),
            count(databases, "database", "databases")
        ),
        None => count(documents, "document", "documents"),
    };
    SectionSummary {
        headline,
        figures: vec![
            SummaryFigure {
                label: "Documents".to_owned(),
                value: Some(documents),
                unit: SummaryUnit::Count,
            },
            SummaryFigure {
                label: "Databases".to_owned(),
                value: databases,
                unit: SummaryUnit::Count,
            },
        ]
        .into_iter()
        .chain(on_disk.map(|bytes| SummaryFigure {
            label: "On disk".to_owned(),
            value: Some(bytes),
            unit: SummaryUnit::Bytes,
        }))
        .collect(),
    }
}

/// Ticks when documents are created or deleted, at most every 500 ms.
pub(crate) fn status_changes(firestore: &FirestoreConsole) -> BoxStream<'static, ()> {
    let ticks = firestore.changes.data().ticks.subscribe();
    stream::unfold((ticks, false), |(mut ticks, waited)| async move {
        if waited {
            tokio::time::sleep(STATUS_TICK).await;
        }
        ticks.changed().await.ok()?;
        Some(((), (ticks, true)))
    })
    .boxed()
}

/// Documents one reset batch deletes, as the official clear route does.
const CLEAR_BATCH: usize = 500;

/// Removes every document of every database of the project, for `POST
/// /suite/clear`: key-only batches of 500 on the blocking pool, progress
/// after each, the cancel checked between them. Committed as housekeeping,
/// so no Functions trigger fires and open pages reload twice (when the
/// reset starts and when it ends) instead of once per batch; with
/// `run_triggers`, committed as a client would, and every listener and
/// trigger sees each deletion as it always has.
#[allow(
    clippy::unnecessary_wraps,
    reason = "the shape of the Firestore section's clear hook, which answers None for a section that cannot be cleared"
)]
pub(crate) fn clear(
    firestore: &FirestoreConsole,
    job: JobHandle,
    options: ClearOptions,
) -> Option<BoxFuture<'static, Result<ClearReport, ApiError>>> {
    let store = firestore.changes.store().clone();
    let changes = firestore.changes.clone();
    let project = firestore.schema.project().to_owned();
    Some(
        async move {
            // Which databases hold documents, and how many: one key-only
            // pass, so the progress has a total.
            let (databases, total) = {
                let store = store.clone();
                blocking("the Firestore reset", move || {
                    let snapshot = store.snapshot();
                    let databases = snapshot.databases(&project);
                    let mut total: usize = 0;
                    for database in &databases {
                        let mut keys = snapshot.key_cursor(database, "");
                        while keys.next().is_some() {
                            total += 1;
                        }
                    }
                    Ok((databases, u64::try_from(total).unwrap_or(u64::MAX)))
                })
                .await?
            };
            job.set_total(job.done().saturating_add(total));
            let announce = !options.run_triggers;
            if announce {
                for database in &databases {
                    changes.announce_rebuilt(database.database_id());
                }
            }
            let mut removed: u64 = 0;
            let mut outcome = Ok(());
            'databases: for database in &databases {
                loop {
                    if job.cancelled() {
                        break 'databases;
                    }
                    let batch = {
                        let store = store.clone();
                        let database = database.clone();
                        blocking("the Firestore reset", move || {
                            delete_batch(&store, &database, options.run_triggers)
                        })
                        .await
                    };
                    match batch {
                        Ok(0) => break,
                        Ok(count) => {
                            removed += count;
                            job.progress(removed);
                        }
                        Err(error) => {
                            outcome = Err(error);
                            break 'databases;
                        }
                    }
                }
            }
            if announce {
                for database in &databases {
                    changes.announce_rebuilt(database.database_id());
                }
            }
            outcome.map(|()| ClearReport {
                section: "firestore".to_owned(),
                removed,
            })
        }
        .boxed(),
    )
}

/// Deletes up to [`CLEAR_BATCH`] documents of `database` in one commit;
/// how many.
fn delete_batch(store: &Store, database: &DatabaseName, as_client: bool) -> Result<u64, ApiError> {
    let snapshot = store.snapshot();
    let mut keys = snapshot.key_cursor(database, "");
    let mut writes: Vec<Write> = Vec::with_capacity(CLEAR_BATCH);
    while writes.len() < CLEAR_BATCH {
        let Some(key) = keys.next() else {
            break;
        };
        writes.push(Write::Delete {
            key,
            precondition: Precondition::None,
        });
    }
    if writes.is_empty() {
        return Ok(0);
    }
    let committed = if as_client {
        store.commit(&writes)
    } else {
        store.commit_maintenance(&writes)
    };
    committed.map_err(|error| {
        ApiError::internal(format!(
            "The reset could not delete documents of {}: {error}",
            database.database_id()
        ))
    })?;
    Ok(u64::try_from(writes.len()).unwrap_or(u64::MAX))
}

#[cfg(test)]
#[path = "firestore_data_tests.rs"]
mod tests;
