//! Project ids requests named that are not the configured one.
//!
//! "The console is empty" is usually an app configured with another project
//! id (often production): the emulators keep serving it, since the data
//! plane is multi-project, and the console shows the configured project's
//! data, which is not where the app's went. The suite records every foreign
//! id its services see (Auth, Firestore REST, gRPC and `WebChannel`, Pub/Sub,
//! Cloud Tasks); the console shows them in its status, as the `shell.foreign`
//! badge and as the shell's banner. This is the only list of them.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tokio::sync::watch;
use ts_rs::TS;

use crate::time::rfc3339_now;

/// Distinct ids kept, so a client inventing ids cannot grow the list.
const MAX_PROJECTS: usize = 64;
/// Ids the status lists.
const LISTED: usize = 8;
/// The longest id recorded; a real project id has at most 30 characters.
const MAX_ID_CHARS: usize = 128;

/// A project id requests named that is not this emulator's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ForeignProject {
    pub project_id: String,
    /// The services that saw it: `auth`, `firestore`, `pubsub`, `tasks`.
    pub services: Vec<String>,
    /// First seen, RFC 3339.
    pub first_seen: String,
    #[ts(type = "number")]
    pub requests: u64,
}

struct Seen {
    services: BTreeSet<&'static str>,
    /// RFC 3339.
    since: String,
    /// The order ids were first seen in, for "newest first".
    order: u64,
    requests: u64,
}

struct Inner {
    seen: Mutex<BTreeMap<String, Seen>>,
    /// Bumped when an id or a service is new (not on every request).
    changes: watch::Sender<u64>,
}

/// Project ids requests named that are not the configured one. Cheap to
/// clone; the suite records into it and the console reads it.
#[derive(Clone)]
pub struct ForeignProjects {
    inner: Arc<Inner>,
}

impl Default for ForeignProjects {
    fn default() -> Self {
        Self {
            inner: Arc::new(Inner {
                seen: Mutex::new(BTreeMap::new()),
                changes: watch::Sender::new(0),
            }),
        }
    }
}

impl ForeignProjects {
    fn seen(&self) -> MutexGuard<'_, BTreeMap<String, Seen>> {
        self.inner
            .seen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Records one request of `service` naming `project`. O(log n) under a
    /// short lock and never blocks on I/O: it is called on request paths.
    /// The caller has checked that `project` is not the configured id.
    pub fn record(&self, project: &str, service: &'static str) {
        if project.is_empty() || project.chars().count() > MAX_ID_CHARS {
            return;
        }
        let changed = {
            let mut seen = self.seen();
            let next = u64::try_from(seen.len()).unwrap_or(u64::MAX);
            if let Some(entry) = seen.get_mut(project) {
                entry.requests = entry.requests.saturating_add(1);
                entry.services.insert(service)
            } else if seen.len() < MAX_PROJECTS {
                seen.insert(
                    project.to_owned(),
                    Seen {
                        services: BTreeSet::from([service]),
                        since: rfc3339_now(),
                        order: next,
                        requests: 1,
                    },
                );
                true
            } else {
                false
            }
        };
        if changed {
            self.inner.changes.send_modify(|version| *version += 1);
        }
    }

    /// The newest eight ids first seen, newest first.
    #[must_use]
    pub fn snapshot(&self) -> Vec<ForeignProject> {
        let seen = self.seen();
        let mut listed: Vec<(&String, &Seen)> = seen.iter().collect();
        listed.sort_by_key(|(_, entry)| std::cmp::Reverse(entry.order));
        listed
            .into_iter()
            .take(LISTED)
            .map(|(project, entry)| ForeignProject {
                project_id: project.clone(),
                services: entry
                    .services
                    .iter()
                    .map(|service| (*service).to_owned())
                    .collect(),
                first_seen: entry.since.clone(),
                requests: entry.requests,
            })
            .collect()
    }

    /// How many distinct foreign ids were seen (at most 64).
    #[must_use]
    pub fn count(&self) -> usize {
        self.seen().len()
    }

    /// Ticks when an id or a service is new.
    #[must_use]
    pub fn changes(&self) -> watch::Receiver<u64> {
        self.inner.changes.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_recorded_per_service_newest_first_and_bounded() {
        let foreign = ForeignProjects::default();
        let mut changes = foreign.changes();
        foreign.record("my-prod", "firestore");
        assert!(changes.has_changed().expect("open"));
        changes.mark_unchanged();
        foreign.record("my-prod", "firestore");
        assert!(
            !changes.has_changed().expect("open"),
            "another request of a known id and service is not a change"
        );
        foreign.record("my-prod", "auth");
        assert!(changes.has_changed().expect("open"));
        foreign.record("staging-app", "pubsub");
        let listed = foreign.snapshot();
        assert_eq!(listed[0].project_id, "staging-app");
        assert_eq!(listed[1].project_id, "my-prod");
        assert_eq!(listed[1].services, ["auth", "firestore"]);
        assert_eq!(listed[1].requests, 3);
        assert!(
            time::OffsetDateTime::parse(
                &listed[1].first_seen,
                &time::format_description::well_known::Rfc3339
            )
            .is_ok()
        );
        for index in 0..100 {
            foreign.record(&format!("invented-{index}"), "tasks");
        }
        assert_eq!(foreign.count(), MAX_PROJECTS);
        let listed = foreign.snapshot();
        assert_eq!(listed.len(), LISTED);
        assert_eq!(listed[0].project_id, "invented-61");
        // An empty or absurd id is not a project.
        foreign.record("", "auth");
        foreign.record(&"x".repeat(200), "auth");
        assert_eq!(foreign.count(), MAX_PROJECTS);
    }
}
