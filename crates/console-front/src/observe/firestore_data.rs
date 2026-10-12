//! Firestore's Overview figures and its reset: the Firestore section's
//! [`Section::summary`], [`Section::status_changes`] and [`Section::clear`]
//! delegate here, so the finished Firestore files carry only the hooks.
//!
//! The figures are O(1) to read on every status tick: the document count is
//! the store snapshot's logical entry count, and the database count is a
//! set kept up to date from the commits the change feed already observes.
//! The set is seeded once, on the blocking pool, the first time the
//! Overview asks; a commit that creates the first document of a database
//! adds it at once, and one that deletes a document marks its database as
//! possibly empty, which a check on the blocking pool confirms at most once
//! every 5 seconds with [`Snapshot::has_documents`] (one seek), never a walk
//! of every key.
//!
//! [`Section::summary`]: crate::section::Section::summary
//! [`Section::status_changes`]: crate::section::Section::status_changes
//! [`Section::clear`]: crate::section::Section::clear
//! [`Snapshot::has_documents`]: firenook_core_store::Snapshot::has_documents

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use firenook_core_store::{CommitObservation, DatabaseName, Store};
use futures_util::future::BoxFuture;
use futures_util::stream::{self, BoxStream, StreamExt as _};
use tokio::sync::watch;
use tokio::time::Instant;

use crate::api_error::ApiError;
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
    store: Store,
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
}

impl Counting {
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
        let snapshot = self.store.snapshot();
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
        for change in &observation.changes {
            let database = change.key.database();
            if database.project_id() != counting.project.as_ref() {
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
                store: console.changes.store().clone(),
                project: Arc::from(console.schema.project()),
                databases: AtomicU64::new(u64::try_from(fixed.len()).unwrap_or(u64::MAX)),
                fixed,
                written: Mutex::new(BTreeSet::new()),
                seeded: AtomicBool::new(false),
                maybe_empty: Mutex::new(BTreeSet::new()),
                checking: AtomicBool::new(false),
                checked: Mutex::new(None),
            }
        });
        if started {
            self.seed(counting);
        }
        counting
    }

    /// The store's databases when counting began, joined with what commits
    /// added meanwhile.
    fn seed(&self, counting: &Counting) {
        let store = counting.store.clone();
        let project = counting.project.clone();
        let data = self.clone();
        let seed = move || {
            let databases: Vec<String> = store
                .snapshot()
                .databases(&project)
                .into_iter()
                .map(|database| database.database_id().to_owned())
                .collect();
            if let Some(counting) = data.counting.get() {
                counting.add(databases.iter().map(String::as_str));
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
pub(crate) fn summary(firestore: &FirestoreConsole) -> SectionSummary {
    let data = firestore.changes.data();
    let counting = data.counting(firestore);
    data.schedule_check(counting);
    let documents = counting.store.snapshot().logical_memory_usage().entries;
    let databases = counting
        .seeded
        .load(Ordering::Acquire)
        .then(|| counting.databases.load(Ordering::Acquire));
    firestore_summary(documents, databases)
}

/// The Firestore summary from its two figures; `databases` is `None` while
/// the seed is not in.
pub(crate) fn firestore_summary(documents: u64, databases: Option<u64>) -> SectionSummary {
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
        ],
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

/// Removes every document of every database, for `POST /suite/clear`;
/// `None` until the observe stream implements it.
pub(crate) fn clear(
    _firestore: &FirestoreConsole,
    _job: JobHandle,
    _options: ClearOptions,
) -> Option<BoxFuture<'static, Result<ClearReport, ApiError>>> {
    None
}

#[cfg(test)]
#[path = "firestore_data_tests.rs"]
mod tests;
