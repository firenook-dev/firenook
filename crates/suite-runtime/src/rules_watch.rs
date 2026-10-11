//! The Firestore rules files, watched.
//!
//! Saving `firestore.rules` in an editor should take effect the way a save
//! in the console does, without restarting the emulator: the official CLI
//! watches each configured rules file and reloads it on change, and so does
//! this. A file is checked one second after the last change in a burst,
//! because editors write a file in several steps. One that compiles and
//! differs from what is in force is installed for its database, recorded
//! with origin `file`; one identical to what is in force — the console's
//! own save landing on disk — is left alone, so a save records one version,
//! not two; one that does not compile leaves the rules in force serving
//! requests and records why, so the console shows the file's problems next
//! to the rules that still govern. Every pass is announced on the rules
//! runtime's channel, success or not.
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

use firenook_core_store::DatabaseName;
use firenook_rules_runtime::{LoadError, RulesOrigin, RulesRuntime, source_hash};
use firenook_suite_front::LoggingRuntime;
use notify::{EventKind, RecursiveMode, Watcher as _};
use tokio::sync::watch;

/// Quiet time after the last change before a file is read, as the official
/// CLI's chokidar watcher and the Functions source watcher wait.
const DEBOUNCE: Duration = Duration::from_secs(1);

/// How often the watch thread looks at its stop flag while idle.
const IDLE_POLL: Duration = Duration::from_millis(250);

/// One database's configured rules file.
#[derive(Clone, Debug)]
pub(crate) struct WatchedRules {
    pub(crate) database: DatabaseName,
    pub(crate) path: PathBuf,
}

/// Whether a reported line is routine or a problem.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Level {
    Info,
    Warn,
}

/// Where the watcher's log lines go: stdout/stderr and the Emulator UI log
/// in the suite, a list in tests.
pub(crate) type Report = Arc<dyn Fn(Level, String) + Send + Sync>;

/// A running watcher; stopping it (or dropping it) ends the notifications.
pub(crate) struct RulesWatcher {
    _watcher: notify::RecommendedWatcher,
    stopped: Arc<AtomicBool>,
}

/// A watched file as the notification callback matches it: by name inside
/// its directory, resolved once because platforms report resolved paths
/// (macOS gives `/private/var/…` for a file configured under `/var/…`).
struct Target {
    rules: WatchedRules,
    name: OsString,
    directory: PathBuf,
}

/// Starts watching every configured rules file for the life of the suite:
/// the watcher stops when `shutdown` flips. A directory that cannot be
/// watched is reported and the suite carries on without reloads, as it ran
/// before files were watched at all.
pub(crate) fn spawn(
    files: Vec<WatchedRules>,
    runtime: RulesRuntime,
    logging: &LoggingRuntime,
    mut shutdown: watch::Receiver<bool>,
) {
    if files.is_empty() {
        return;
    }
    let sink = logging.clone();
    let report: Report = Arc::new(move |level, message| {
        let line = format!("firenook firestore: {message}");
        match level {
            Level::Info => {
                println!("{line}");
                sink.record("INFO", Some("firestore"), message);
            }
            Level::Warn => {
                eprintln!("{line}");
                sink.record("WARN", Some("firestore"), message);
            }
        }
    });
    match RulesWatcher::start(files, runtime, Arc::clone(&report)) {
        Ok(watcher) => {
            tokio::spawn(async move {
                // A dropped sender means the suite is gone too.
                while !*shutdown.borrow() && shutdown.changed().await.is_ok() {}
                watcher.stop();
            });
        }
        Err(message) => report(
            Level::Warn,
            format!("rules files are not watched, so a change needs a restart: {message}"),
        ),
    }
}

impl RulesWatcher {
    /// Watches the directory of every file in `files`; each debounced burst
    /// of changes to a file checks it once.
    pub(crate) fn start(
        files: Vec<WatchedRules>,
        runtime: RulesRuntime,
        report: Report,
    ) -> Result<Self, String> {
        let targets = Arc::new(
            files
                .into_iter()
                .map(Target::new)
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
                        check(&targets[index].rules, &runtime, &report);
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

impl Target {
    fn new(rules: WatchedRules) -> Result<Self, String> {
        let name = rules
            .path
            .file_name()
            .ok_or_else(|| format!("{} names no file", rules.path.display()))?
            .to_owned();
        let parent = rules
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let directory = parent
            .canonicalize()
            .map_err(|error| format!("{}: {error}", parent.display()))?;
        Ok(Self {
            rules,
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

/// One pass over one database's file.
fn check(rules: &WatchedRules, runtime: &RulesRuntime, report: &Report) {
    let database = &rules.database;
    let id = database.database_id();
    let path = rules.path.display();
    let source = match std::fs::read_to_string(&rules.path) {
        Ok(source) => source,
        Err(error) => {
            report(
                Level::Warn,
                format!(
                    "database \"{id}\" rules file {path} could not be read; the rules in force are unchanged: {error}"
                ),
            );
            runtime.set_file_problems(
                database,
                Some(LoadError::unreadable(format!(
                    "{path} could not be read: {error}"
                ))),
            );
            return;
        }
    };
    if runtime
        .current_version(database)
        .is_some_and(|version| version.hash == source_hash(&source))
    {
        // Already in force: the console's save, or a touch.
        runtime.set_file_problems(database, None);
        return;
    }
    match runtime.install_database_from(database, &source, RulesOrigin::File) {
        Ok(()) => {
            report(
                Level::Info,
                format!("database \"{id}\" rules reloaded from {path}"),
            );
            runtime.set_file_problems(database, None);
        }
        Err(error) => {
            report(
                Level::Warn,
                format!(
                    "database \"{id}\" rules in {path} did not compile; the rules in force are unchanged: {error}"
                ),
            );
            runtime.set_file_problems(database, Some(error));
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
                vec![WatchedRules {
                    database: database.clone(),
                    path: file.clone(),
                }],
                runtime.clone(),
                Arc::new(move |level, line| lock(&collected).push((level, line))),
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
}
