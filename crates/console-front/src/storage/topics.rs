//! Storage's live topics: `storage.objects` (which objects changed, resumed
//! by replay) and `storage.rules` (what governs a bucket, resumed by
//! comparing hashes). `storage.decisions` lives with its feed in
//! `decision_feed.rs`.
//!
//! The storage revision is global across buckets, so "same revision,
//! nothing to do" would reset a subscriber after any write to another
//! bucket, and nothing written while a tab was away could be recovered.
//! So `storage.objects` reads a ring of committed mutations (names only),
//! filtered by bucket: a reconnect replays what it missed, and while the
//! filter drops another bucket's entries the hub's cursor-only ticks keep
//! the cursor current. Each 100 ms window folds into one event of names
//! and kinds; past 1,000 names it names the touched folders instead.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use firenook_storage_front::{
    ChangeEvent, ObjectChangeKind, RulesScope, StorageConsoleApi, StorageRulesEvent,
    StorageRulesHandle,
};
use firenook_suite_front::replay::random_epoch;
use firenook_suite_front::{Entry, ReplayRing, RingBudget, RingLimits};
use futures_util::stream::{self, StreamExt as _};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::error::RecvError;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use ts_rs::TS;

use super::files::StorageObjectChangeKind;
use crate::api_error::ApiError;
use crate::live::replay::{ReplayOptions, replay_topic};
use crate::live::{LiveTopic, TopicEvent, TopicStream, topic_params};
use crate::rules::{RulesDiagnostic, RulesOrigin, diagnostic, origin};
use crate::sse::Shutdown;

/// The ring of committed mutations: 10,000 entries, 4 MiB of names.
const OBJECTS_RING: RingLimits = RingLimits {
    entries: 10_000,
    bytes: 4 * 1024 * 1024,
    floor: 1_000,
};
/// Names one window carries before it names folders instead.
const WINDOW_NAMES: usize = 1_000;

/// `storage.objects` params.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "storage/")]
pub(crate) struct StorageObjectsParams {
    /// Any bucket name: a bucket may come into being by being written to.
    pub bucket: String,
}

/// `storage.objects` `changed`: keys only, one per subscriber per 100 ms
/// window.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageObjectsChanged {
    /// The window's last storage revision (a fact, not the cursor: the
    /// cursor is the ring's).
    #[ts(type = "number")]
    pub revision: u64,
    /// Names deduplicated, kinds folded; empty when `truncated`.
    pub changes: Vec<StorageObjectTouch>,
    /// When `truncated`: the touched parent prefixes (at most 1,000); an
    /// empty string means the whole bucket.
    pub folders: Vec<String>,
    /// More than 1,000 names in the window, or a clear: reset what is under
    /// `folders`.
    pub truncated: bool,
    /// Ids of upload sessions that started, advanced, finished or were
    /// discarded.
    pub sessions: Vec<String>,
    /// The folder index finished building in this window: counts that were
    /// null are known now.
    pub index_ready: bool,
}

/// One object a window touched, and what became of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageObjectTouch {
    pub name: String,
    pub kind: StorageObjectChangeKind,
}

/// What one ring entry is.
#[derive(Clone, Debug)]
enum Marker {
    /// One committed mutation of one bucket.
    Names,
    /// The folder index finished building.
    IndexReady,
    /// Everything may have changed: a clear, or a forwarder that fell
    /// behind the service's broadcast.
    Everything,
}

/// What a ring entry carries beside its (accounting-only) JSON.
#[derive(Clone, Debug)]
pub(crate) struct ObjectsMeta {
    /// `None`: every bucket.
    bucket: Option<Arc<str>>,
    revision: u64,
    touches: Arc<[(Arc<str>, ObjectChangeKind)]>,
    sessions: Arc<[String]>,
    marker: Marker,
}

/// The ring of committed mutations, fed from the service's change
/// broadcast by a task started with the first subscription and ending on
/// the suite's stop.
#[derive(Clone)]
pub(crate) struct ObjectsFeed {
    ring: ReplayRing<ObjectsMeta>,
    started: Arc<AtomicBool>,
    api: StorageConsoleApi,
    shutdown: Shutdown,
}

impl ObjectsFeed {
    pub(crate) fn new(api: StorageConsoleApi, budget: &RingBudget, shutdown: Shutdown) -> Self {
        Self {
            ring: ReplayRing::new("storage.objects", OBJECTS_RING, random_epoch(), budget),
            started: Arc::new(AtomicBool::new(false)),
            api,
            shutdown,
        }
    }

    fn push(&self, meta: ObjectsMeta) {
        let names = meta
            .touches
            .iter()
            .map(|(name, _)| name.len() + 8)
            .sum::<usize>()
            + meta.sessions.iter().map(|id| id.len() + 4).sum::<usize>();
        self.ring.push_weighted(meta, Arc::from(""), names + 48);
    }

    fn everything(&self, revision: u64) {
        self.push(ObjectsMeta {
            bucket: None,
            revision,
            touches: Arc::from([]),
            sessions: Arc::from([]),
            marker: Marker::Everything,
        });
    }

    /// Starts recording, once: from the first subscription of the engine's
    /// life, whether or not anyone is subscribed later.
    fn ensure_started(&self) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let mut changes = self.api.subscribe();
        let feed = self.clone();
        let stopped = self.shutdown.clone().stopped();
        tokio::spawn(async move {
            tokio::pin!(stopped);
            loop {
                let received = tokio::select! {
                    biased;
                    () = &mut stopped => return,
                    received = changes.recv() => received,
                };
                match received {
                    Ok(ChangeEvent::Committed {
                        bucket,
                        revision,
                        touches,
                        sessions,
                    }) => feed.push(ObjectsMeta {
                        bucket: Some(bucket),
                        revision,
                        touches,
                        sessions,
                        marker: Marker::Names,
                    }),
                    Ok(ChangeEvent::IndexReady) => feed.push(ObjectsMeta {
                        bucket: None,
                        revision: feed.api.revision(),
                        touches: Arc::from([]),
                        sessions: Arc::from([]),
                        marker: Marker::IndexReady,
                    }),
                    // A lost window becomes a reset of what it touched,
                    // never a silent miss.
                    Ok(ChangeEvent::Reset) | Err(RecvError::Lagged(_)) => {
                        feed.everything(feed.api.revision());
                    }
                    Err(RecvError::Closed) => return,
                }
            }
        });
    }
}

/// The folder holding `name`: everything up to its last `/` (empty at the
/// bucket root).
fn parent(name: &str) -> &str {
    &name[..name.rfind('/').map_or(0, |slash| slash + 1)]
}

/// Folds what a window holds into one event: names deduplicated and their
/// kinds folded (a deletion wins; a creation stays a creation; otherwise
/// the last kind), sessions united, the last revision; past 1,000 names, or
/// for a clear, the touched folders instead.
fn fold(entries: &[Entry<ObjectsMeta>]) -> StorageObjectsChanged {
    let mut names: BTreeMap<&str, ObjectChangeKind> = BTreeMap::new();
    let mut folders: BTreeSet<&str> = BTreeSet::new();
    let mut sessions: BTreeSet<&str> = BTreeSet::new();
    let mut revision = 0;
    let mut everything = false;
    let mut index_ready = false;
    let mut overflow = false;
    for entry in entries {
        let meta = &entry.meta;
        revision = revision.max(meta.revision);
        match meta.marker {
            Marker::Everything => everything = true,
            Marker::IndexReady => index_ready = true,
            Marker::Names => {}
        }
        for (name, kind) in meta.touches.iter() {
            if !overflow {
                let folded = match names.get(name.as_ref()) {
                    _ if *kind == ObjectChangeKind::Deleted => ObjectChangeKind::Deleted,
                    Some(ObjectChangeKind::Created) => ObjectChangeKind::Created,
                    _ => *kind,
                };
                names.insert(name, folded);
            }
            if folders.len() <= WINDOW_NAMES {
                folders.insert(parent(name));
            }
            if names.len() > WINDOW_NAMES {
                overflow = true;
            }
        }
        sessions.extend(meta.sessions.iter().map(String::as_str));
    }
    let truncated = everything || overflow;
    StorageObjectsChanged {
        revision,
        changes: if truncated {
            Vec::new()
        } else {
            names
                .into_iter()
                .map(|(name, kind)| StorageObjectTouch {
                    name: name.to_owned(),
                    kind: kind.into(),
                })
                .collect()
        },
        folders: if !truncated {
            Vec::new()
        } else if everything || folders.len() > WINDOW_NAMES {
            vec![String::new()]
        } else {
            folders.into_iter().map(str::to_owned).collect()
        },
        truncated,
        sessions: sessions.into_iter().map(str::to_owned).collect(),
        index_ready,
    }
}

/// The live channel's `storage.objects` topic: `changed` →
/// [`StorageObjectsChanged`], replayed from the ring's cursor.
pub(crate) struct ObjectsTopic(pub(crate) ObjectsFeed);

impl LiveTopic for ObjectsTopic {
    fn name(&self) -> &'static str {
        "storage.objects"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: StorageObjectsParams = topic_params(params)?;
        if params.bucket.is_empty() {
            return Err(ApiError::invalid("storage.objects needs a bucket."));
        }
        self.0.ensure_started();
        let bucket: Arc<str> = Arc::from(params.bucket);
        Ok(replay_topic(
            &self.0.ring,
            after,
            "changed",
            ReplayOptions {
                filter: Some(Arc::new(move |meta: &ObjectsMeta| {
                    meta.bucket.as_ref().is_none_or(|of| *of == bucket)
                })),
                shape: Some(Box::new(|entries: &[Entry<ObjectsMeta>]| {
                    Some(Arc::from(
                        serde_json::to_string(&fold(entries)).unwrap_or_else(|_| "null".to_owned()),
                    ))
                })),
                ..ReplayOptions::default()
            },
        ))
    }
}

/// `storage.rules` params.
#[derive(Clone, Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "storage/")]
pub(crate) struct StorageRulesParams {
    /// The bucket whose rules to follow; the default bucket when absent.
    #[ts(optional)]
    pub bucket: Option<String>,
}

/// What governs a bucket changed (`event: rules`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageRulesChanged {
    /// The scope's bucket; null when one ruleset governs every bucket.
    pub bucket: Option<String>,
    /// The hash in force; empty when no ruleset is (a failed reload dropped
    /// it, so every client request is refused).
    pub hash: String,
    pub origin: RulesOrigin,
}

/// The rules file watcher finished a pass (`event: file`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageRulesFileStatus {
    pub bucket: Option<String>,
    /// Why the file is not in force; empty when the pass succeeded.
    pub problems: Vec<RulesDiagnostic>,
}

/// What one `storage.rules` subscriber has been told.
struct RulesNews {
    rules: StorageRulesHandle,
    scope: RulesScope,
    /// The hash in force it was last told of (empty: none in force).
    seen: String,
}

impl RulesNews {
    fn hash(&self) -> String {
        self.rules
            .current(&self.scope)
            .map(|installed| installed.hash.clone())
            .unwrap_or_default()
    }

    fn changed(&mut self) -> Option<TopicEvent> {
        let current = self.rules.current(&self.scope);
        let hash = current
            .as_ref()
            .map(|installed| installed.hash.clone())
            .unwrap_or_default();
        if hash == self.seen {
            return None;
        }
        self.seen.clone_from(&hash);
        Some(TopicEvent::json(
            "rules",
            Some(self.seen.clone()),
            &StorageRulesChanged {
                bucket: self.scope.bucket().map(str::to_owned),
                hash,
                origin: current.map_or(RulesOrigin::Reload, |installed| origin(installed.origin)),
            },
        ))
    }

    fn file(&self) -> TopicEvent {
        TopicEvent::json(
            "file",
            Some(self.seen.clone()),
            &StorageRulesFileStatus {
                bucket: self.scope.bucket().map(str::to_owned),
                problems: self
                    .rules
                    .file_problems(&self.scope)
                    .iter()
                    .map(diagnostic)
                    .collect(),
            },
        )
    }

    fn after(
        &mut self,
        item: &Result<StorageRulesEvent, BroadcastStreamRecvError>,
    ) -> Vec<TopicEvent> {
        let (recheck, file) = match item {
            Ok(
                StorageRulesEvent::Installed { scope, .. } | StorageRulesEvent::Dropped { scope },
            ) => (*scope == self.scope, false),
            Ok(StorageRulesEvent::FileChecked { scope }) => (false, *scope == self.scope),
            // A lagging stream may have missed either kind; re-read both.
            Err(BroadcastStreamRecvError::Lagged(_)) => (true, true),
        };
        let mut told = Vec::new();
        if recheck && let Some(event) = self.changed() {
            told.push(event);
        }
        if file {
            told.push(self.file());
        }
        told
    }
}

/// The live channel's `storage.rules` topic: `rules` →
/// [`StorageRulesChanged`] when what governs the bucket changes, `file` →
/// [`StorageRulesFileStatus`] after every check of its file and on every
/// open (a file that broke while the subscriber was away moves no hash).
/// The cursor is the hash in force.
pub(crate) struct RulesTopic {
    pub(crate) rules: StorageRulesHandle,
    pub(crate) default_bucket: String,
}

impl LiveTopic for RulesTopic {
    fn name(&self) -> &'static str {
        "storage.rules"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: StorageRulesParams = topic_params(params)?;
        let bucket = params.bucket.unwrap_or_else(|| self.default_bucket.clone());
        let scope = self.rules.scope_of(&bucket);
        // Subscribe before reading what is in force, so no change falls
        // between the two.
        let receiver = self.rules.subscribe();
        let mut news = RulesNews {
            rules: self.rules.clone(),
            scope,
            seen: after.map(str::to_owned).unwrap_or_default(),
        };
        let mut first = Vec::new();
        if after.is_some() {
            first.extend(news.changed());
        } else {
            news.seen = news.hash();
        }
        first.push(news.file());
        let rest =
            BroadcastStream::new(receiver).flat_map(move |item| stream::iter(news.after(&item)));
        Ok(stream::iter(first).chain(rest).boxed())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(
        bucket: Option<&str>,
        revision: u64,
        touches: &[(&str, ObjectChangeKind)],
        marker: Marker,
    ) -> Entry<ObjectsMeta> {
        Entry {
            cursor: firenook_suite_front::Cursor {
                epoch: 1,
                seq: revision,
            },
            meta: ObjectsMeta {
                bucket: bucket.map(Arc::from),
                revision,
                touches: touches
                    .iter()
                    .map(|(name, kind)| (Arc::from(*name), *kind))
                    .collect(),
                sessions: Arc::from([]),
                marker,
            },
            json: Arc::from(""),
        }
    }

    #[test]
    fn windows_fold_names_and_kinds() {
        let folded = fold(&[
            entry(
                Some("b"),
                1,
                &[("a/x.png", ObjectChangeKind::Created)],
                Marker::Names,
            ),
            entry(
                Some("b"),
                2,
                &[("a/x.png", ObjectChangeKind::Metadata)],
                Marker::Names,
            ),
            entry(
                Some("b"),
                3,
                &[
                    ("a/y.png", ObjectChangeKind::Created),
                    ("a/y.png", ObjectChangeKind::Deleted),
                ],
                Marker::Names,
            ),
            entry(
                Some("b"),
                4,
                &[
                    ("z.png", ObjectChangeKind::Replaced),
                    ("z.png", ObjectChangeKind::Tokens),
                ],
                Marker::Names,
            ),
        ]);
        assert_eq!(folded.revision, 4);
        assert!(!folded.truncated);
        let changes = folded
            .changes
            .iter()
            .map(|touch| (touch.name.as_str(), touch.kind))
            .collect::<Vec<_>>();
        assert_eq!(
            changes,
            [
                ("a/x.png", StorageObjectChangeKind::Created),
                ("a/y.png", StorageObjectChangeKind::Deleted),
                ("z.png", StorageObjectChangeKind::Tokens),
            ]
        );
        // Past 1,000 names: the parents instead.
        let many = (0..1_200)
            .map(|index| {
                (
                    format!("d{}/f{index}", index % 3),
                    ObjectChangeKind::Created,
                )
            })
            .collect::<Vec<_>>();
        let touches = many
            .iter()
            .map(|(name, kind)| (name.as_str(), *kind))
            .collect::<Vec<_>>();
        let truncated = fold(&[entry(Some("b"), 9, &touches, Marker::Names)]);
        assert!(truncated.truncated);
        assert_eq!(truncated.changes, []);
        assert_eq!(truncated.folders, ["d0/", "d1/", "d2/"]);
        // A clear names the whole bucket.
        let cleared = fold(&[entry(None, 10, &[], Marker::Everything)]);
        assert!(cleared.truncated);
        assert_eq!(cleared.folders, [""]);
        let ready = fold(&[entry(None, 11, &[], Marker::IndexReady)]);
        assert!(ready.index_ready);
        assert!(!ready.truncated);
    }
}
