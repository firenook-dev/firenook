//! What governed each database over time, and who is told when it changes.
//!
//! A ruleset now arrives from four places — the startup configuration, the
//! console, the watched rules file and the emulator's hot-reload route — so
//! "which rules decided that request" needs an answer with a past. Each
//! database keeps the versions that governed it, bounded, with where each
//! came from. Consecutive versions with the same source collapse: the
//! console saving its text to the file, which the file watcher then sees,
//! adds nothing.
//!
//! Resolution has three levels (database, project, default), so a version
//! installed at one level changes what governs databases that were never
//! named: a project-wide hot reload governs every database of the project
//! from then on. The histories are therefore kept eagerly for each database
//! installed by name, and every other database reads the history of the
//! level that governs it, project then default — which is exactly what
//! governed it all along. Recording happens under the same lock as the
//! install, so the newest version of a history is always the ruleset in
//! force.

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

use firenook_core_store::DatabaseName;
use firenook_rules_engine::{Diagnostic, DiagnosticSeverity};
use time::OffsetDateTime;
use tokio::sync::broadcast;

use crate::{InstalledRules, LoadError, RulesRuntime, RuntimeState, read_lock, write_lock};

/// Versions kept per database, project and default level.
pub const MAXIMUM_VERSIONS: usize = 50;

/// Change notifications retained for a slow subscriber before it is told it
/// lagged (and re-reads the current state).
const EVENT_CAPACITY: usize = 64;

/// Where an installed ruleset came from.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RulesOrigin {
    /// The configuration the suite started with.
    Startup,
    /// The console's editor.
    Console,
    /// The rules file watcher, after the file changed on disk.
    File,
    /// The emulator's project-wide hot-reload route (rules unit testing).
    Reload,
}

/// One ruleset that governed a database.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstalledVersion {
    /// Stable hash of `source`, as [`source_hash`] computes it.
    pub hash: String,
    /// The source text, shared with the ruleset that was installed.
    pub source: Arc<str>,
    /// Where it came from.
    pub origin: RulesOrigin,
    /// When it was installed.
    pub installed_at: OffsetDateTime,
}

/// Something that may change what a subscriber shows.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RulesEvent {
    /// A ruleset was installed at some level. What governs a given database
    /// may or may not have changed; a subscriber compares
    /// [`RulesRuntime::current_version`] with what it last saw.
    Installed {
        /// Where the installed ruleset came from.
        origin: RulesOrigin,
    },
    /// The rules file watcher finished a pass for this database; its
    /// problems, if any, are in [`RulesRuntime::file_problems`].
    FileChecked {
        /// The database whose file was checked.
        database: DatabaseName,
    },
}

/// The stable hash identifying a ruleset source: unpadded URL-safe base64 of
/// its SHA-256. Equal hashes mean identical text.
#[must_use]
pub fn source_hash(source: &str) -> String {
    use base64::Engine as _;
    use sha2::Digest as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(source.as_bytes()))
}

/// The change channel, created with the runtime so every clone shares it.
#[derive(Clone)]
pub(crate) struct Events(broadcast::Sender<RulesEvent>);

impl Default for Events {
    fn default() -> Self {
        Self(broadcast::channel(EVENT_CAPACITY).0)
    }
}

impl Events {
    pub(crate) fn installed(&self, origin: RulesOrigin) {
        // A send only fails when nobody listens, which is the usual case.
        let _ = self.0.send(RulesEvent::Installed { origin });
    }
}

/// The version histories and the rules files' last problems.
#[derive(Default)]
pub(crate) struct Versions {
    default: History,
    projects: BTreeMap<String, History>,
    databases: BTreeMap<DatabaseName, History>,
    file_problems: BTreeMap<DatabaseName, LoadError>,
}

impl RuntimeState {
    /// The history of the level governing `database`, the same resolution
    /// as the rulesets'.
    fn governing(&self, database: &DatabaseName) -> &History {
        self.versions
            .databases
            .get(database)
            .or_else(|| self.versions.projects.get(database.project_id()))
            .or_else(|| self.versions.databases.get(self.governed_as(database)))
            .unwrap_or(&self.versions.default)
    }
}

/// Oldest first, bounded, consecutive identical sources collapsed.
#[derive(Clone, Default)]
struct History(VecDeque<Arc<InstalledVersion>>);

impl History {
    fn push(&mut self, version: &Arc<InstalledVersion>) {
        if self.0.back().is_some_and(|last| last.hash == version.hash) {
            return;
        }
        if self.0.len() == MAXIMUM_VERSIONS {
            self.0.pop_front();
        }
        self.0.push_back(Arc::clone(version));
    }
}

pub(crate) fn version(rules: &InstalledRules, origin: RulesOrigin) -> Arc<InstalledVersion> {
    Arc::new(InstalledVersion {
        hash: rules.source_hash.clone(),
        source: rules.rules.shared_source(),
        origin,
        installed_at: OffsetDateTime::now_utc(),
    })
}

impl RuntimeState {
    /// A new startup default governs each named database that has neither
    /// its own ruleset nor a project-wide one.
    pub(crate) fn record_default(&mut self, version: &Arc<InstalledVersion>) {
        self.versions.default.push(version);
        for (database, history) in &mut self.versions.databases {
            if !self.databases.contains_key(database)
                && !self.projects.contains_key(database.project_id())
            {
                history.push(version);
            }
        }
    }

    /// A project-wide reload governs every database of the project, named or
    /// not, because it displaces their own rulesets.
    pub(crate) fn record_project(&mut self, project: &str, version: &Arc<InstalledVersion>) {
        let default = &self.versions.default;
        self.versions
            .projects
            .entry(project.to_owned())
            // Until now the project's databases followed the default.
            .or_insert_with(|| default.clone())
            .push(version);
        for (database, history) in &mut self.versions.databases {
            if database.project_id() == project {
                history.push(version);
            }
        }
    }

    /// A database's own ruleset governs it; its history starts from what
    /// governed it before it was named.
    pub(crate) fn record_database(
        &mut self,
        database: &DatabaseName,
        version: &Arc<InstalledVersion>,
    ) {
        if !self.versions.databases.contains_key(database) {
            let before = self.governing(database).clone();
            self.versions.databases.insert(database.clone(), before);
        }
        if let Some(history) = self.versions.databases.get_mut(database) {
            history.push(version);
        }
    }
}

impl RulesRuntime {
    /// The rulesets that governed `database`, newest first, at most
    /// [`MAXIMUM_VERSIONS`]. Empty when none ever did (the
    /// open-with-warning mode).
    #[must_use]
    pub fn rules_history(&self, database: &DatabaseName) -> Vec<InstalledVersion> {
        let state = read_lock(&self.state);
        state
            .governing(database)
            .0
            .iter()
            .rev()
            .map(|version| (**version).clone())
            .collect()
    }

    /// The ruleset governing `database` now, with where it came from.
    #[must_use]
    pub fn current_version(&self, database: &DatabaseName) -> Option<InstalledVersion> {
        let state = read_lock(&self.state);
        state
            .governing(database)
            .0
            .back()
            .map(|version| (**version).clone())
    }

    /// Change notifications for every database: installs at any level and
    /// finished rules file checks. A lagging receiver should re-read.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<RulesEvent> {
        self.events.0.subscribe()
    }

    /// Records the outcome of one rules file check for `database`: why the
    /// file on disk is not what is in force, or `None` when it is fine.
    /// Subscribers are told either way, since a check that found nothing
    /// wrong clears what an earlier one reported.
    pub fn set_file_problems(&self, database: &DatabaseName, problems: Option<LoadError>) {
        {
            let mut state = write_lock(&self.state);
            match problems {
                Some(problems) => {
                    state
                        .versions
                        .file_problems
                        .insert(database.clone(), problems);
                }
                None => {
                    state.versions.file_problems.remove(database);
                }
            }
        }
        let _ = self.events.0.send(RulesEvent::FileChecked {
            database: database.clone(),
        });
    }

    /// Why the last rules file check for `database` did not install it.
    #[must_use]
    pub fn file_problems(&self, database: &DatabaseName) -> Option<LoadError> {
        read_lock(&self.state)
            .versions
            .file_problems
            .get(database)
            .cloned()
    }
}

impl LoadError {
    /// A rules file that could not be read at all, as one diagnostic at the
    /// start of the file, so it reports like a compilation failure.
    #[must_use]
    pub fn unreadable(message: impl Into<String>) -> Self {
        Self::new(vec![Diagnostic {
            severity: DiagnosticSeverity::Error,
            message: message.into(),
            line: 1,
            column: 1,
            byte_offset: 0,
            from: 0,
            to: 0,
            code: None,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROJECT: &str = "demo-versions";

    fn database(id: &str) -> DatabaseName {
        DatabaseName::new(PROJECT, id).expect("database")
    }

    fn rules(condition: &str) -> String {
        format!(
            "rules_version = '2'; service cloud.firestore {{ match /databases/{{database}}/documents {{ match /{{document=**}} {{ allow read: if {condition}; }} }} }}"
        )
    }

    fn origins(history: &[InstalledVersion]) -> Vec<RulesOrigin> {
        history.iter().map(|version| version.origin).collect()
    }

    #[test]
    fn history_records_startup_console_and_file_collapsing_identical_sources() {
        let runtime = RulesRuntime::default();
        let default = database("(default)");
        runtime
            .install_database(&default, &rules("false"))
            .expect("startup");
        runtime
            .install_database_from(&default, &rules("true"), RulesOrigin::Console)
            .expect("console");
        // The console's save, seen by the file watcher: the same text.
        runtime
            .install_database_from(&default, &rules("true"), RulesOrigin::File)
            .expect("file, unchanged");
        runtime
            .install_database_from(&default, &rules("1 == 1"), RulesOrigin::File)
            .expect("file, changed");
        let history = runtime.rules_history(&default);
        assert_eq!(
            origins(&history),
            [
                RulesOrigin::File,
                RulesOrigin::Console,
                RulesOrigin::Startup
            ]
        );
        assert!(history[0].source.contains("1 == 1"));
        assert_eq!(history[0].hash, source_hash(&rules("1 == 1")));
        assert!(history[0].installed_at >= history[2].installed_at);
        assert_eq!(runtime.current_version(&default), Some(history[0].clone()));
        // A failed install changes nothing.
        assert!(
            runtime
                .install_database_from(&default, "broken", RulesOrigin::File)
                .is_err()
        );
        assert_eq!(runtime.rules_history(&default).len(), 3);
    }

    #[test]
    fn a_hot_reload_counts_for_every_database_it_now_governs() {
        let runtime = RulesRuntime::default();
        let named = database("named");
        let never_named = database("elsewhere");
        let foreign = DatabaseName::new("demo-other", "(default)").expect("database");
        runtime.install_default(&rules("false")).expect("default");
        runtime
            .install_database(&named, &rules("true"))
            .expect("named");
        assert_eq!(
            origins(&runtime.rules_history(&named)),
            [RulesOrigin::Startup, RulesOrigin::Startup],
            "a named database's history starts from what governed it before"
        );
        runtime
            .install_project(PROJECT, &rules("1 == 1"))
            .expect("reload");
        for database in [&named, &never_named] {
            let history = runtime.rules_history(database);
            assert_eq!(history[0].origin, RulesOrigin::Reload, "{database}");
            assert_eq!(history[0].hash, source_hash(&rules("1 == 1")), "{database}");
            assert_eq!(
                runtime
                    .current_version(database)
                    .map(|version| version.hash),
                runtime
                    .rules_for(database)
                    .map(|rules| source_hash(rules.source())),
                "the newest version is the ruleset in force for {database}"
            );
        }
        assert_eq!(
            origins(&runtime.rules_history(&never_named)),
            [RulesOrigin::Reload, RulesOrigin::Startup]
        );
        assert_eq!(
            origins(&runtime.rules_history(&foreign)),
            [RulesOrigin::Startup],
            "another project still follows the default"
        );
        // A later default no longer governs the reloaded project.
        runtime.install_default(&rules("2 == 2")).expect("default");
        assert_eq!(runtime.rules_history(&named)[0].origin, RulesOrigin::Reload);
        assert_eq!(runtime.rules_history(&foreign).len(), 2);
    }

    #[test]
    fn history_is_bounded() {
        let runtime = RulesRuntime::default();
        let default = database("(default)");
        for index in 0..(MAXIMUM_VERSIONS + 7) {
            runtime
                .install_database_from(
                    &default,
                    &rules(&format!("{index} == {index}")),
                    RulesOrigin::Console,
                )
                .expect("install");
        }
        let history = runtime.rules_history(&default);
        assert_eq!(history.len(), MAXIMUM_VERSIONS);
        let newest = MAXIMUM_VERSIONS + 6;
        assert!(history[0].source.contains(&format!("{newest} == {newest}")));
    }

    #[test]
    fn subscribers_hear_installs_and_file_checks() {
        let runtime = RulesRuntime::default();
        let default = database("(default)");
        let mut events = runtime.subscribe();
        runtime
            .install_database_from(&default, &rules("true"), RulesOrigin::Console)
            .expect("install");
        assert_eq!(
            events.try_recv(),
            Ok(RulesEvent::Installed {
                origin: RulesOrigin::Console
            })
        );
        assert!(runtime.install_project(PROJECT, "broken").is_err());
        assert!(events.try_recv().is_err(), "a failed install is silent");

        runtime.set_file_problems(&default, Some(LoadError::unreadable("gone")));
        assert_eq!(
            events.try_recv(),
            Ok(RulesEvent::FileChecked {
                database: default.clone()
            })
        );
        let problems = runtime.file_problems(&default).expect("problems");
        assert_eq!(problems.diagnostics[0].message, "gone");
        runtime.set_file_problems(&default, None);
        assert!(runtime.file_problems(&default).is_none());
        assert!(events.try_recv().is_ok());
    }

    /// A database `firebase.json` does not list is governed by its stand-in's
    /// ruleset, as the official emulator's one rules file governs every
    /// database, and follows it as it changes.
    #[test]
    fn an_unlisted_database_follows_its_stand_in() {
        let runtime = RulesRuntime::default();
        let default = database("(default)");
        let named = database("named");
        let unlisted = database("unlisted");
        let in_force = |database: &DatabaseName| {
            runtime
                .rules_for(database)
                .map(|rules| source_hash(rules.source()))
        };
        runtime
            .install_database(&default, &rules("false"))
            .expect("default");
        runtime
            .install_database(&named, &rules("true"))
            .expect("named");
        assert_eq!(in_force(&unlisted), None, "without a stand-in it is open");
        runtime.govern_unlisted_with(&default);
        assert_eq!(in_force(&unlisted), Some(source_hash(&rules("false"))));
        assert_eq!(in_force(&named), Some(source_hash(&rules("true"))));
        assert_eq!(
            runtime
                .current_version(&unlisted)
                .map(|version| version.hash),
            Some(source_hash(&rules("false")))
        );

        runtime
            .install_database_from(&default, &rules("1 == 1"), RulesOrigin::File)
            .expect("file reload");
        let current = runtime.current_version(&unlisted).expect("governed");
        assert_eq!(current.origin, RulesOrigin::File);
        assert_eq!(in_force(&unlisted), Some(current.hash));
        assert_eq!(
            origins(&runtime.rules_history(&unlisted)),
            [RulesOrigin::File, RulesOrigin::Startup]
        );

        runtime
            .install_project(PROJECT, &rules("2 == 2"))
            .expect("reload");
        for database in [&default, &named, &unlisted] {
            assert_eq!(
                in_force(database),
                Some(source_hash(&rules("2 == 2"))),
                "{database}"
            );
        }
    }
}
