//! The rules files, watched.
//!
//! Saving `firestore.rules` in an editor should take effect the way a save
//! in the console does, without restarting the emulator: the official CLI
//! watches each configured rules file and reloads it on change, and so does
//! this. A file is checked one second after the last change in a burst,
//! because editors write a file in several steps. One that compiles and
//! differs from what is in force is installed for its target, recorded
//! with origin `file`; one identical to what is in force — the console's
//! own save landing on disk — is left alone, so a save records one version,
//! not two; one that does not compile leaves the rules in force serving
//! requests and records why, so the console shows the file's problems next
//! to the rules that still govern. Every pass is announced on the target's
//! channel, success or not.
//!
//! Each watched file is a [`RulesTarget`]: a Firestore database's rules
//! ([`FirestoreTarget`]) or the Storage rules of a bucket, or of every
//! bucket ([`StorageTarget`]). One watcher serves every target of every
//! service, so a suite started with only Storage watches its rules file as
//! well.
//!
//! The directory holding a file is watched rather than the file itself:
//! editors commonly save by writing a new file and renaming it over the old
//! one, which a watch on the old file would never see.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use firenook_console_front::FirestoreIndexes;
use firenook_core_store::DatabaseName;
use firenook_rules_runtime::{LoadError, RulesOrigin, RulesRuntime, source_hash};
use firenook_storage_front::{RulesScope, StorageRulesHandle, StorageRuntime};
use firenook_suite_front::{LogInput, LoggingRuntime};
use notify::{EventKind, RecursiveMode, Watcher as _};
use tokio::sync::watch;

use crate::{ConsoleFirestoreParts, SuiteConfig, SuiteRuntimeError, failure};

/// Quiet time after the last change before a file is read, as the official
/// CLI's chokidar watcher and the Functions source watcher wait.
const DEBOUNCE: Duration = Duration::from_secs(1);

/// How often the watch thread looks at its stop flag while idle.
const IDLE_POLL: Duration = Duration::from_millis(250);

/// Why a rules file is not what is in force: the compiler's diagnostics, or
/// one saying the file could not be read.
pub(crate) type FileProblem = LoadError;

/// One configured rules file and the rules it feeds.
pub(crate) trait RulesTarget: Send + Sync {
    /// The service whose rules these are, as its log lines name it:
    /// `firestore`, `storage`.
    fn service(&self) -> &'static str;
    /// What the log lines call these rules, such as `database "(default)"
    /// rules`.
    fn label(&self) -> String;
    /// The file, as configured.
    fn path(&self) -> &Path;
    /// The hash ([`source_hash`]) of the source in force, when there is one.
    fn in_force_hash(&self) -> Option<String>;
    /// Compiles `source` and puts it in force, recorded with origin `file`;
    /// on a compile error the rules in force stay.
    fn install(&self, source: &str) -> Result<(), FileProblem>;
    /// Records what is wrong with the file (`None` once it is fine again)
    /// and announces the pass.
    fn set_file_problems(&self, problems: Option<FileProblem>);
    /// What the file puts in force, as the log lines say: `rules`.
    fn holds(&self) -> &'static str {
        "rules"
    }
    /// What a file that cannot be put in force did, as the log lines say.
    fn refused(&self) -> &'static str {
        "did not compile"
    }
    /// Why the file cannot be put in force, as the log lines say it.
    fn describe(&self, problem: &FileProblem) -> String {
        problem.to_string()
    }
    /// The console's record of one check: reloaded (`problem` false) or
    /// not.
    fn log_input(&self, problem: bool, message: String) -> LogInput {
        crate::console_wiring::observe::rules_file_input(self.service(), problem, message)
    }
}

/// A Firestore database's rules file.
pub(crate) struct FirestoreTarget {
    pub(crate) database: DatabaseName,
    pub(crate) path: PathBuf,
    pub(crate) runtime: RulesRuntime,
}

impl RulesTarget for FirestoreTarget {
    fn service(&self) -> &'static str {
        "firestore"
    }

    fn label(&self) -> String {
        format!("database \"{}\" rules", self.database.database_id())
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn in_force_hash(&self) -> Option<String> {
        self.runtime
            .current_version(&self.database)
            .map(|version| version.hash)
    }

    fn install(&self, source: &str) -> Result<(), FileProblem> {
        self.runtime
            .install_database_from(&self.database, source, RulesOrigin::File)
    }

    fn set_file_problems(&self, problems: Option<FileProblem>) {
        self.runtime.set_file_problems(&self.database, problems);
    }
}

/// The Storage rules of one scope: a bucket's own file (`firebase.json`
/// Storage targets), or the one file that governs every bucket.
pub(crate) struct StorageTarget {
    pub(crate) scope: RulesScope,
    pub(crate) path: PathBuf,
    pub(crate) rules: StorageRulesHandle,
}

impl RulesTarget for StorageTarget {
    fn service(&self) -> &'static str {
        "storage"
    }

    fn label(&self) -> String {
        match &self.scope {
            RulesScope::AllBuckets => "rules for every bucket".to_owned(),
            RulesScope::Bucket(bucket) => format!("rules for gs://{bucket}"),
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn in_force_hash(&self) -> Option<String> {
        self.rules
            .current(&self.scope)
            .map(|installed| installed.hash.clone())
    }

    fn install(&self, source: &str) -> Result<(), FileProblem> {
        self.rules
            .install(&self.scope, source, RulesOrigin::File)
            .map_err(|diagnostics| LoadError { diagnostics })
    }

    fn set_file_problems(&self, problems: Option<FileProblem>) {
        self.rules.set_file_problems(&self.scope, problems);
    }
}

/// A Firestore database's index file: saved, it is put in force for the
/// database's queries and explanations, and every index the console lists
/// as missing is asked whether it is declared now.
pub(crate) struct IndexesTarget {
    pub(crate) database_id: String,
    pub(crate) path: PathBuf,
    pub(crate) indexes: FirestoreIndexes,
    /// The hash ([`source_hash`]) of the source in force, when the file was
    /// put in force at all.
    pub(crate) in_force: Mutex<Option<String>>,
}

impl RulesTarget for IndexesTarget {
    fn service(&self) -> &'static str {
        "firestore"
    }

    fn label(&self) -> String {
        format!("database \"{}\" indexes", self.database_id)
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn in_force_hash(&self) -> Option<String> {
        lock(&self.in_force).clone()
    }

    fn install(&self, source: &str) -> Result<(), FileProblem> {
        self.indexes
            .install(&self.database_id, source)
            .map_err(LoadError::unreadable)?;
        *lock(&self.in_force) = Some(source_hash(source));
        Ok(())
    }

    fn set_file_problems(&self, problems: Option<FileProblem>) {
        let problem = problems.map(|problem| self.describe(&problem));
        self.indexes.set_file_problem(&self.database_id, problem);
    }

    fn holds(&self) -> &'static str {
        "indexes"
    }

    fn refused(&self) -> &'static str {
        "are not valid"
    }

    /// The parser's own words, which name the line and column themselves.
    fn describe(&self, problem: &FileProblem) -> String {
        problem
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.message.as_str())
            .collect::<Vec<_>>()
            .join("; ")
    }

    fn log_input(&self, problem: bool, message: String) -> LogInput {
        crate::console_wiring::observe::indexes_file_input(&self.database_id, problem, message)
    }
}

/// Every configured file the suite watches: each Firestore database's rules
/// file (its runtime is the console's Firestore runtime, the one every
/// Firestore front evaluates against) and index file, and each Storage scope
/// `firebase.json` names a rules file for (none for a demo project's open
/// default rules).
pub(crate) fn rules_watch_targets(
    config: &SuiteConfig,
    firestore: Option<&ConsoleFirestoreParts>,
    storage: Option<&StorageRuntime>,
) -> Result<Vec<Arc<dyn RulesTarget>>, SuiteRuntimeError> {
    let mut targets: Vec<Arc<dyn RulesTarget>> = Vec::new();
    if let Some(parts) = firestore {
        for entry in &config.firestore_databases {
            let Some(path) = &entry.rules else {
                continue;
            };
            let database =
                DatabaseName::new(config.project_id.as_str(), entry.database_id.as_str()).map_err(
                    |error| {
                        failure(format!(
                            "firebase.json names an invalid Firestore database: {error}"
                        ))
                    },
                )?;
            targets.push(Arc::new(FirestoreTarget {
                database,
                path: path.clone(),
                runtime: parts.rules_runtime.clone(),
            }));
        }
        for entry in &config.firestore_databases {
            let Some(path) = &entry.indexes else {
                continue;
            };
            targets.push(Arc::new(IndexesTarget {
                database_id: entry.database_id.clone(),
                path: path.clone(),
                indexes: parts.indexes.clone(),
                in_force: Mutex::new(parts.index_hashes.get(&entry.database_id).cloned()),
            }));
        }
    }
    if let Some(rules) = storage.and_then(|storage| storage.console().rules()) {
        for scope in rules.scopes() {
            if let Some(path) = rules.file(&scope) {
                targets.push(Arc::new(StorageTarget {
                    scope,
                    path,
                    rules: rules.clone(),
                }));
            }
        }
    }
    Ok(targets)
}

/// Whether a reported line is routine or a problem.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Level {
    Info,
    Warn,
}

/// Where the watcher's log lines go, with the file they are about:
/// stdout/stderr and the Emulator UI log in the suite, a list in tests.
pub(crate) type Report = Arc<dyn Fn(&dyn RulesTarget, Level, String) + Send + Sync>;

/// A running watcher; stopping it (or dropping it) ends the notifications.
pub(crate) struct RulesWatcher {
    _watcher: notify::RecommendedWatcher,
    stopped: Arc<AtomicBool>,
}

/// A watched file as the notification callback matches it: by name inside
/// its directory, resolved once because platforms report resolved paths
/// (macOS gives `/private/var/…` for a file configured under `/var/…`).
struct Watched {
    target: Arc<dyn RulesTarget>,
    name: OsString,
    directory: PathBuf,
}

/// Starts watching every configured rules file for the life of the suite:
/// the watcher stops when `shutdown` flips. A directory that cannot be
/// watched is reported and the suite carries on without reloads, as it ran
/// before files were watched at all.
pub(crate) fn spawn(
    targets: Vec<Arc<dyn RulesTarget>>,
    logging: &LoggingRuntime,
    mut shutdown: watch::Receiver<bool>,
) {
    let Some(first) = targets.first().cloned() else {
        return;
    };
    let sink = logging.clone();
    let report: Report = Arc::new(move |target, level, message| {
        let service = target.service();
        let line = format!("firenook {service}: {message}");
        let level_name = match level {
            Level::Info => "INFO",
            Level::Warn => "WARN",
        };
        crate::terminal::print(level_name, service, &message, &line);
        // The same record as always, with its kind for the console.
        sink.emit(target.log_input(level == Level::Warn, message));
    });
    match RulesWatcher::start(targets, Arc::clone(&report)) {
        Ok(watcher) => {
            tokio::spawn(async move {
                // A dropped sender means the suite is gone too.
                while !*shutdown.borrow() && shutdown.changed().await.is_ok() {}
                watcher.stop();
            });
        }
        Err(message) => report(
            first.as_ref(),
            Level::Warn,
            format!(
                "rules and index files are not watched, so a change needs a restart: {message}"
            ),
        ),
    }
}

impl RulesWatcher {
    /// Watches the directory of every target's file, each directory once;
    /// each debounced burst of changes to a file checks it once.
    pub(crate) fn start(
        targets: Vec<Arc<dyn RulesTarget>>,
        report: Report,
    ) -> Result<Self, String> {
        let targets = Arc::new(
            targets
                .into_iter()
                .map(Watched::new)
                .collect::<Result<Vec<_>, String>>()?,
        );
        // Indices of the targets changed since the last check.
        let dirty = Arc::new(Mutex::new(BTreeSet::new()));
        let (wake, woken) = mpsc::channel::<()>();
        let matched = Arc::clone(&targets);
        let marked = Arc::clone(&dirty);
        let mut watcher =
            notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
                let Ok(event) = event else {
                    return;
                };
                if !matches!(
                    event.kind,
                    EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
                ) {
                    return;
                }
                let mut hit = false;
                for path in &event.paths {
                    let (Some(name), Some(parent)) = (path.file_name(), path.parent()) else {
                        continue;
                    };
                    let parent = parent
                        .canonicalize()
                        .unwrap_or_else(|_| parent.to_path_buf());
                    for (index, target) in matched.iter().enumerate() {
                        if target.name == name && target.directory == parent {
                            lock(&marked).insert(index);
                            hit = true;
                        }
                    }
                }
                if hit {
                    let _ = wake.send(());
                }
            })
            .map_err(|error| format!("cannot create a file watcher: {error}"))?;
        let directories = targets
            .iter()
            .map(|target| target.directory.clone())
            .collect::<BTreeSet<_>>();
        for directory in &directories {
            watcher
                .watch(directory, RecursiveMode::NonRecursive)
                .map_err(|error| format!("cannot watch {}: {error}", directory.display()))?;
        }
        let stopped = Arc::new(AtomicBool::new(false));
        let stop_flag = Arc::clone(&stopped);
        std::thread::Builder::new()
            .name("firenook-rules-watch".to_owned())
            .spawn(move || {
                while wait_for_quiet(&woken, &stop_flag) {
                    let changed = std::mem::take(&mut *lock(&dirty));
                    for index in changed {
                        check(targets[index].target.as_ref(), &report);
                    }
                }
            })
            .map_err(|error| format!("cannot start the watch thread: {error}"))?;
        Ok(Self {
            _watcher: watcher,
            stopped,
        })
    }

    /// Ends the watch; a check already under way finishes.
    pub(crate) fn stop(self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}

impl Watched {
    fn new(target: Arc<dyn RulesTarget>) -> Result<Self, String> {
        let path = target.path();
        let name = path
            .file_name()
            .ok_or_else(|| format!("{} names no file", path.display()))?
            .to_owned();
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let directory = parent
            .canonicalize()
            .map_err(|error| format!("{}: {error}", parent.display()))?;
        Ok(Self {
            target,
            name,
            directory,
        })
    }
}

/// Waits for a change, then for the rest of its burst: returns once the
/// files have been quiet for the debounce interval, or `false` when the
/// watcher stopped.
fn wait_for_quiet(woken: &mpsc::Receiver<()>, stopped: &AtomicBool) -> bool {
    loop {
        if stopped.load(Ordering::SeqCst) {
            return false;
        }
        match woken.recv_timeout(IDLE_POLL) {
            Ok(()) => break,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return false,
        }
    }
    let mut quiet_from = Instant::now();
    loop {
        let remaining = DEBOUNCE.saturating_sub(quiet_from.elapsed());
        if remaining.is_zero() {
            break;
        }
        match woken.recv_timeout(remaining) {
            Ok(()) => quiet_from = Instant::now(),
            Err(_) => break,
        }
    }
    !stopped.load(Ordering::SeqCst)
}

/// One pass over one target's file.
fn check(target: &dyn RulesTarget, report: &Report) {
    let label = target.label();
    let holds = target.holds();
    let path = target.path().display();
    let source = match std::fs::read_to_string(target.path()) {
        Ok(source) => source,
        Err(error) => {
            report(
                target,
                Level::Warn,
                format!(
                    "{label} file {path} could not be read; the {holds} in force are unchanged: {error}"
                ),
            );
            target.set_file_problems(Some(LoadError::unreadable(format!(
                "{path} could not be read: {error}"
            ))));
            return;
        }
    };
    if target
        .in_force_hash()
        .is_some_and(|hash| hash == source_hash(&source))
    {
        // Already in force: the console's save, or a touch.
        target.set_file_problems(None);
        return;
    }
    match target.install(&source) {
        Ok(()) => {
            report(target, Level::Info, format!("{label} reloaded from {path}"));
            target.set_file_problems(None);
        }
        Err(error) => {
            report(
                target,
                Level::Warn,
                format!(
                    "{label} in {path} {}; the {holds} in force are unchanged: {}",
                    target.refused(),
                    target.describe(&error)
                ),
            );
            target.set_file_problems(Some(error));
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use firenook_rules_runtime::RulesEvent;

    fn rules(condition: &str) -> String {
        format!(
            "rules_version = '2';\nservice cloud.firestore {{\n  match /databases/{{database}}/documents {{\n    match /{{document=**}} {{\n      allow read: if {condition};\n    }}\n  }}\n}}\n"
        )
    }

    /// A rules file in a directory of its own, removed afterwards.
    struct Fixture {
        directory: PathBuf,
        file: PathBuf,
        database: DatabaseName,
        runtime: RulesRuntime,
        lines: Arc<Mutex<Vec<(Level, String)>>>,
        watcher: Option<RulesWatcher>,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let directory = std::env::temp_dir().join(format!(
                "firenook-rules-watch-{name}-{}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&directory);
            std::fs::create_dir_all(&directory).expect("directory");
            let file = directory.join("firestore.rules");
            std::fs::write(&file, rules("false")).expect("write");
            let database = DatabaseName::new("demo-watch", "(default)").expect("database");
            let runtime = RulesRuntime::default();
            runtime
                .install_database(&database, &rules("false"))
                .expect("startup rules");
            let lines = Arc::new(Mutex::new(Vec::new()));
            let collected = Arc::clone(&lines);
            let watcher = RulesWatcher::start(
                vec![Arc::new(FirestoreTarget {
                    database: database.clone(),
                    path: file.clone(),
                    runtime: runtime.clone(),
                })],
                Arc::new(move |target: &dyn RulesTarget, level, line| {
                    assert_eq!(target.service(), "firestore");
                    lock(&collected).push((level, line));
                }),
            )
            .expect("watching starts");
            Self {
                directory,
                file,
                database,
                runtime,
                lines,
                watcher: Some(watcher),
            }
        }

        /// Writes `source` and waits until `done` holds, writing again now
        /// and then: a platform may coalesce or drop an event that lands
        /// right after the watch starts, and a repeated write is exactly
        /// what an editor's next save would be.
        fn write_until(&self, source: &str, mut done: impl FnMut() -> bool) {
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut next_write = Instant::now();
            while !done() {
                assert!(
                    Instant::now() < deadline,
                    "the watcher never acted on the file; lines: {:?}",
                    lock(&self.lines)
                );
                if Instant::now() >= next_write {
                    std::fs::write(&self.file, source).expect("write");
                    next_write = Instant::now() + Duration::from_secs(4);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }

        fn hash(&self) -> Option<String> {
            self.runtime
                .current_version(&self.database)
                .map(|version| version.hash)
        }

        fn lines(&self) -> Vec<(Level, String)> {
            lock(&self.lines).clone()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Some(watcher) = self.watcher.take() {
                watcher.stop();
            }
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn a_changed_file_is_installed_for_its_database() {
        let fixture = Fixture::new("changed");
        let changed = rules("request.auth != null");
        fixture.write_until(&changed, || fixture.hash() == Some(source_hash(&changed)));
        let history = fixture.runtime.rules_history(&fixture.database);
        assert_eq!(history[0].origin, RulesOrigin::File);
        assert_eq!(history[1].origin, RulesOrigin::Startup);
        assert!(fixture.runtime.file_problems(&fixture.database).is_none());
        let expected = format!(
            "database \"(default)\" rules reloaded from {}",
            fixture.file.display()
        );
        assert!(
            fixture
                .lines()
                .iter()
                .any(|(level, line)| *level == Level::Info && *line == expected),
            "{:?}",
            fixture.lines()
        );
    }

    #[test]
    fn a_write_of_what_is_in_force_installs_nothing() {
        let fixture = Fixture::new("identical");
        let mut events = fixture.runtime.subscribe();
        let checked = || {
            std::iter::from_fn(|| events.try_recv().ok()).any(|event| {
                event
                    == RulesEvent::FileChecked {
                        database: fixture.database.clone(),
                    }
            })
        };
        // The console's save: the file now holds the rules in force.
        fixture.write_until(&rules("false"), checked);
        assert_eq!(
            fixture.runtime.rules_history(&fixture.database).len(),
            1,
            "only the startup version"
        );
        assert!(fixture.lines().is_empty(), "{:?}", fixture.lines());
    }

    #[test]
    fn a_broken_file_keeps_the_rules_in_force_and_says_why() {
        let fixture = Fixture::new("broken");
        let before = fixture.hash();
        fixture.write_until("rules_version = '2';\nservice cloud.firestore {", || {
            fixture.runtime.file_problems(&fixture.database).is_some()
        });
        assert_eq!(fixture.hash(), before, "the previous rules keep serving");
        let problems = fixture
            .runtime
            .file_problems(&fixture.database)
            .expect("problems");
        assert_eq!(problems.diagnostics[0].line, 2);
        assert!(
            fixture
                .lines()
                .iter()
                .any(|(level, line)| *level == Level::Warn
                    && line.contains("did not compile; the rules in force are unchanged")),
            "{:?}",
            fixture.lines()
        );
        // Fixing the file installs it and clears the problems.
        let fixed = rules("true");
        fixture.write_until(&fixed, || fixture.hash() == Some(source_hash(&fixed)));
        assert!(fixture.runtime.file_problems(&fixture.database).is_none());
    }

    /// A target of another service, recording what the watcher asked of it.
    struct Recording {
        path: PathBuf,
        installed: Mutex<Vec<String>>,
        problems: Mutex<Vec<Option<String>>>,
    }

    impl RulesTarget for Recording {
        fn service(&self) -> &'static str {
            "storage"
        }

        fn label(&self) -> String {
            "rules for gs://demo-bucket".to_owned()
        }

        fn path(&self) -> &Path {
            &self.path
        }

        fn in_force_hash(&self) -> Option<String> {
            lock(&self.installed)
                .last()
                .map(|source| source_hash(source))
        }

        fn install(&self, source: &str) -> Result<(), FileProblem> {
            lock(&self.installed).push(source.to_owned());
            Ok(())
        }

        fn set_file_problems(&self, problems: Option<FileProblem>) {
            lock(&self.problems).push(problems.map(|problems| problems.to_string()));
        }
    }

    #[test]
    fn one_watcher_serves_targets_of_several_services_in_one_directory() {
        let directory = std::env::temp_dir().join(format!(
            "firenook-rules-watch-services-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("directory");
        let firestore_file = directory.join("firestore.rules");
        let storage_file = directory.join("storage.rules");
        std::fs::write(&firestore_file, rules("false")).expect("write");
        std::fs::write(&storage_file, "rules_version = '2';").expect("write");
        let database = DatabaseName::new("demo-watch", "(default)").expect("database");
        let runtime = RulesRuntime::default();
        runtime
            .install_database(&database, &rules("false"))
            .expect("startup rules");
        let storage = Arc::new(Recording {
            path: storage_file.clone(),
            installed: Mutex::new(vec!["rules_version = '2';".to_owned()]),
            problems: Mutex::new(Vec::new()),
        });
        let lines = Arc::new(Mutex::new(Vec::new()));
        let collected = Arc::clone(&lines);
        let watcher = RulesWatcher::start(
            vec![
                Arc::new(FirestoreTarget {
                    database: database.clone(),
                    path: firestore_file.clone(),
                    runtime: runtime.clone(),
                }),
                storage.clone(),
            ],
            Arc::new(move |target: &dyn RulesTarget, level, line| {
                lock(&collected).push((target.service(), level, line));
            }),
        )
        .expect("watching starts");
        let changed = "rules_version = '2';\nservice firebase.storage {}\n";
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut next_write = Instant::now();
        while lock(&storage.installed).last().map(String::as_str) != Some(changed) {
            assert!(
                Instant::now() < deadline,
                "the watcher never acted on the storage file; lines: {:?}",
                lock(&lines)
            );
            if Instant::now() >= next_write {
                std::fs::write(&storage_file, changed).expect("write");
                next_write = Instant::now() + Duration::from_secs(4);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        watcher.stop();
        let expected = format!(
            "rules for gs://demo-bucket reloaded from {}",
            storage_file.display()
        );
        assert!(
            lock(&lines)
                .iter()
                .any(|(service, level, line)| *service == "storage"
                    && *level == Level::Info
                    && *line == expected),
            "{:?}",
            lock(&lines)
        );
        assert_eq!(lock(&storage.problems).last(), Some(&None));
        // The Firestore file in the same directory was not touched, so its
        // rules are only the startup version.
        assert_eq!(runtime.rules_history(&database).len(), 1);
        assert!(
            lock(&lines)
                .iter()
                .all(|(service, _, _)| *service == "storage"),
            "{:?}",
            lock(&lines)
        );
        let _ = std::fs::remove_dir_all(&directory);
    }

    /// `orders` where `status ==` ordered by `total` descending, and a
    /// `--strict-indexes` policy over `indexes`' catalogs.
    fn strict_orders(
        indexes: &FirestoreIndexes,
        missing: Arc<firenook_query_engine::MissingIndexes>,
    ) -> (
        firenook_query_engine::QueryPolicy,
        firenook_query_engine::Query,
    ) {
        use firenook_query_engine::{
            DatabaseEdition, Direction, FieldFilter, FieldOperator, FieldPath, Filter, Query,
            QueryPolicy, QueryScope,
        };
        let policy = QueryPolicy::new(DatabaseEdition::Standard).with_indexes(
            Arc::clone(indexes.catalogs()),
            true,
            Some(missing),
        );
        let query = Query::new(QueryScope::collection("orders").expect("scope"))
            .filter(Filter::Field(FieldFilter {
                path: FieldPath::field(["status"]).expect("field"),
                operator: FieldOperator::Equal,
                value: firenook_core_store::Value::Integer(1),
            }))
            .order_by(
                FieldPath::field(["total"]).expect("field"),
                Direction::Descending,
            );
        (policy, query)
    }

    /// Writes `source` to `file` until `done` holds, writing again now and
    /// then, as [`Fixture::write_until`] does.
    fn write_index_until(file: &Path, source: &str, lines: &Lines, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut next_write = Instant::now();
        while !done() {
            assert!(
                Instant::now() < deadline,
                "the watcher never acted on the index file; lines: {:?}",
                lock(lines)
            );
            if Instant::now() >= next_write {
                std::fs::write(file, source).expect("write");
                next_write = Instant::now() + Duration::from_secs(4);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// A saved index file is put in force: a query it declares the index
    /// for passes `--strict-indexes` with no restart, and a file that is not
    /// valid keeps the indexes in force and says why, without a position of
    /// its own in front of the parser's.
    #[test]
    fn a_saved_index_file_takes_effect_and_a_broken_one_keeps_the_indexes() {
        let directory =
            std::env::temp_dir().join(format!("firenook-index-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("directory");
        let file = directory.join("firestore.indexes.json");
        let empty = r#"{"indexes":[],"fieldOverrides":[]}"#;
        std::fs::write(&file, empty).expect("write");
        let missing = Arc::new(firenook_query_engine::MissingIndexes::new(None));
        let indexes = FirestoreIndexes::new(
            Arc::default(),
            Arc::clone(&missing),
            true,
            [("(default)".to_owned(), file.clone(), None)],
        );
        let (policy, query) = strict_orders(&indexes, missing);
        policy
            .validate("(default)", &query)
            .expect_err("refused: the file declares nothing");

        let lines: Lines = Arc::new(Mutex::new(Vec::new()));
        let collected = Arc::clone(&lines);
        let watcher = RulesWatcher::start(
            vec![Arc::new(IndexesTarget {
                database_id: "(default)".to_owned(),
                path: file.clone(),
                indexes: indexes.clone(),
                in_force: Mutex::new(Some(source_hash(empty))),
            })],
            Arc::new(move |target: &dyn RulesTarget, level, line| {
                lock(&collected).push((target.service(), level, line));
            }),
        )
        .expect("watching starts");
        let declared = r#"{"indexes":[{"collectionGroup":"orders","queryScope":"COLLECTION","fields":[
            {"fieldPath":"status","order":"ASCENDING"},{"fieldPath":"total","order":"DESCENDING"}]}]}"#;
        write_index_until(&file, declared, &lines, || {
            policy.validate("(default)", &query).is_ok()
        });
        assert!(indexes.list().indexes[0].declared);
        let reloaded = format!(
            "database \"(default)\" indexes reloaded from {}",
            file.display()
        );
        assert!(
            lock(&lines)
                .iter()
                .any(|(service, level, line)| *service == "firestore"
                    && *level == Level::Info
                    && *line == reloaded),
            "{:?}",
            lock(&lines)
        );

        write_index_until(&file, r#"{"indexes": ["#, &lines, || {
            indexes.list().files[0].problem.is_some()
        });
        watcher.stop();
        let problem = indexes.list().files[0].problem.clone().expect("a problem");
        assert!(problem.starts_with("invalid index JSON"), "{problem}");
        let said = lock(&lines).last().cloned().expect("a line");
        assert_eq!(said.1, Level::Warn);
        assert!(
            said.2.starts_with(&format!(
                "database \"(default)\" indexes in {} are not valid; the indexes in force are unchanged: invalid index JSON",
                file.display()
            )),
            "{}",
            said.2
        );
        policy
            .validate("(default)", &query)
            .expect("the indexes in force are unchanged");
        let _ = std::fs::remove_dir_all(&directory);
    }

    fn storage_rules(condition: &str) -> String {
        format!(
            "rules_version = '2';\nservice firebase.storage {{\n  match /b/{{bucket}}/o {{\n    match /{{allPaths=**}} {{\n      allow read: if {condition};\n    }}\n  }}\n}}\n"
        )
    }

    /// What the watcher reported, by service.
    type Lines = Arc<Mutex<Vec<(&'static str, Level, String)>>>;

    /// A Storage runtime whose one rules file governs every bucket, in a
    /// directory of its own, watched like the suite watches it.
    struct StorageFixture {
        directory: PathBuf,
        file: PathBuf,
        rules: StorageRulesHandle,
        runtime: Option<StorageRuntime>,
        lines: Lines,
        watcher: Option<RulesWatcher>,
    }

    impl StorageFixture {
        /// Started from `config` as `--only storage` starts it: no Firestore
        /// parts, the targets from [`rules_watch_targets`].
        async fn new(name: &str) -> Self {
            let directory = std::env::temp_dir().join(format!(
                "firenook-rules-watch-storage-{name}-{}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&directory);
            std::fs::create_dir_all(&directory).expect("directory");
            let file = directory.join("storage.rules");
            std::fs::write(&file, storage_rules("false")).expect("write");
            let registry = firenook_functions_bridge::TriggerRegistry::default();
            let (observer, _deliveries) =
                firenook_functions_bridge::TriggerObserver::channel(registry.clone());
            let runtime = StorageRuntime::start_with(
                firenook_storage_front::StorageConfig {
                    project: "demo-watch".to_owned(),
                    origin: "http://127.0.0.1:9199".to_owned(),
                    data_dir: directory.join("state"),
                    rules: Some(firenook_storage_front::NativeRulesConfig {
                        source: firenook_storage_front::RulesSource::Single(
                            firenook_storage_front::RulesFile {
                                name: file.display().to_string(),
                                content: storage_rules("false"),
                            },
                        ),
                        documents: Arc::new(firenook_storage_front::NoFirestoreDocuments),
                    }),
                    durability: firenook_storage_front::StorageDurability::PerCommit,
                },
                firenook_storage_front::StorageOptions {
                    functions: false,
                    default_bucket: None,
                    rules_files: Some(firenook_storage_front::RulesFiles::Single(file.clone())),
                    diagnostics: false,
                    log: None,
                },
                observer.queue(),
                registry,
            )
            .await
            .expect("Storage runtime");
            let mut config = crate::diagnostics_tests::test_config();
            config.services = crate::ServiceSelection::parse("storage").expect("selection");
            config.storage_rules = crate::StorageRulesConfig::Single(file.clone());
            let targets = rules_watch_targets(&config, None, Some(&runtime)).expect("targets");
            assert_eq!(targets.len(), 1, "the one Storage rules file is watched");
            assert_eq!(targets[0].service(), "storage");
            assert_eq!(targets[0].label(), "rules for every bucket");
            let rules = runtime.console().rules().expect("native rules");
            let lines = Arc::new(Mutex::new(Vec::new()));
            let collected = Arc::clone(&lines);
            let watcher = RulesWatcher::start(
                targets,
                Arc::new(move |target: &dyn RulesTarget, level, line| {
                    lock(&collected).push((target.service(), level, line));
                }),
            )
            .expect("watching starts");
            Self {
                directory,
                file,
                rules,
                runtime: Some(runtime),
                lines,
                watcher: Some(watcher),
            }
        }

        fn hash(&self) -> Option<String> {
            self.rules
                .current(&RulesScope::AllBuckets)
                .map(|installed| installed.hash.clone())
        }

        fn problems(&self) -> Vec<firenook_rules_engine::Diagnostic> {
            self.rules.file_problems(&RulesScope::AllBuckets)
        }

        /// Writes `source` until `done` holds, as [`Fixture::write_until`].
        fn write_until(&self, source: &str, mut done: impl FnMut() -> bool) {
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut next_write = Instant::now();
            while !done() {
                assert!(
                    Instant::now() < deadline,
                    "the watcher never acted on the file; lines: {:?}",
                    lock(&self.lines)
                );
                if Instant::now() >= next_write {
                    std::fs::write(&self.file, source).expect("write");
                    next_write = Instant::now() + Duration::from_secs(4);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }

        fn lines(&self) -> Vec<(&'static str, Level, String)> {
            lock(&self.lines).clone()
        }

        async fn finish(mut self) {
            if let Some(watcher) = self.watcher.take() {
                watcher.stop();
            }
            if let Some(runtime) = self.runtime.take() {
                runtime.shutdown().await.expect("shutdown");
            }
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn only_storage_watches_its_rules_file() {
        let fixture = StorageFixture::new("only").await;
        let mut events = fixture.rules.subscribe();
        let changed = storage_rules("request.auth != null");
        fixture.write_until(&changed, || fixture.hash() == Some(source_hash(&changed)));
        let history = fixture.rules.history(&RulesScope::AllBuckets);
        assert_eq!(history[0].origin, RulesOrigin::File);
        assert_eq!(history[1].origin, RulesOrigin::Startup);
        assert_eq!(fixture.problems(), []);
        let mut seen = Vec::new();
        while let Ok(event) = events.try_recv() {
            seen.push(event);
        }
        assert!(
            seen.contains(&firenook_storage_front::StorageRulesEvent::Installed {
                scope: RulesScope::AllBuckets,
                origin: RulesOrigin::File,
            }),
            "{seen:?}"
        );
        let expected = format!(
            "rules for every bucket reloaded from {}",
            fixture.file.display()
        );
        assert!(
            fixture
                .lines()
                .iter()
                .any(|(service, level, line)| *service == "storage"
                    && *level == Level::Info
                    && *line == expected),
            "{:?}",
            fixture.lines()
        );
        fixture.finish().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_broken_storage_file_keeps_the_rules_and_a_save_lands_once() {
        let fixture = StorageFixture::new("broken").await;
        let before = fixture.hash();
        fixture.write_until("rules_version = '2';\nservice firebase.storage {", || {
            !fixture.problems().is_empty()
        });
        assert_eq!(fixture.hash(), before, "the previous rules keep serving");
        assert_eq!(fixture.problems()[0].line, 2);
        assert!(
            fixture
                .lines()
                .iter()
                .any(|(_, level, line)| *level == Level::Warn
                    && line.contains("did not compile; the rules in force are unchanged")),
            "{:?}",
            fixture.lines()
        );
        // The console's save: installed first, then written to the file,
        // which the watcher finds already in force.
        let saved = storage_rules("true");
        fixture
            .rules
            .install(&RulesScope::AllBuckets, &saved, RulesOrigin::Console)
            .expect("installed");
        fixture.write_until(&saved, || fixture.problems().is_empty());
        let history = fixture.rules.history(&RulesScope::AllBuckets);
        assert_eq!(history[0].origin, RulesOrigin::Console);
        assert_eq!(
            history
                .iter()
                .filter(|version| version.hash == source_hash(&saved))
                .count(),
            1,
            "one version per save"
        );
        fixture.finish().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_unreadable_storage_file_sets_problems() {
        let fixture = StorageFixture::new("unreadable").await;
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut next = Instant::now();
        while fixture.problems().is_empty() {
            assert!(Instant::now() < deadline, "{:?}", fixture.lines());
            if Instant::now() >= next {
                // The file goes away (an editor's rename gone wrong); a
                // repeated write-and-remove is another event if the first
                // was missed.
                let _ = std::fs::write(&fixture.file, storage_rules("false"));
                let _ = std::fs::remove_file(&fixture.file);
                next = Instant::now() + Duration::from_secs(4);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            fixture.problems()[0].message.contains("could not be read"),
            "{:?}",
            fixture.problems()
        );
        assert!(fixture.hash().is_some(), "the rules in force stay");
        fixture.finish().await;
    }
}
