//! One way to change an object, and what every change announces.
//!
//! Every create, replace, metadata or token change and delete goes through
//! [`StorageData::put`] or [`StorageData::remove`] (a reset through
//! [`StorageData::clear`]), inside the service's `inner` lock. Each bumps the
//! storage revision, records an [`ObjectChangeRecord`] in the activity ring
//! and sends one [`ChangeEvent`], so whoever observes the service sees the
//! changes in exactly the order the object map took them, and a console
//! never has to poll. Resumable upload sessions change through
//! [`StorageData::put_session`] and [`StorageData::remove_session`] for the
//! same reason.

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

use axum::http::HeaderMap;
use time::OffsetDateTime;
use tokio::sync::broadcast;

use crate::folder_index::{FolderIndex, Shape};
use crate::rules::auth_from_authorization;
use crate::{StorageData, StoredObject, UploadSession, object_key};

/// Changes the broadcast holds for a subscriber that falls behind; past it
/// the subscriber sees `Lagged` and must treat everything as changed.
const FEED_CAPACITY: usize = 4_096;
/// Change records the activity ring keeps.
const ACTIVITY_RECORDS: usize = 10_000;
/// Estimated bytes the activity ring keeps.
const ACTIVITY_BYTES: usize = 4 * 1024 * 1024;
/// Metadata keys one record names.
const CHANGED_KEYS: usize = 16;

/// What a change did to an object.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum ObjectChangeKind {
    /// The object did not exist.
    Created,
    /// New bytes over an existing object: a new generation.
    Replaced,
    /// Same generation, metadata changed (the metageneration moved).
    Metadata,
    /// Same generation, the download tokens changed.
    Tokens,
    /// The object is gone.
    Deleted,
}

/// Who made a change, as the request's `Authorization` said.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Actor {
    /// Owner credentials: the Admin SDK, or the console acting as Admin.
    Admin,
    /// A decodable Firebase token with a user id.
    User {
        /// The token's `user_id`.
        uid: String,
        /// The token's `firebase.tenant`; `None` for project users.
        tenant: Option<String>,
    },
    /// No credentials, or none that decode to a user.
    Anonymous,
    /// The service itself: an import or a reset.
    System,
}

/// Who changed an object and from where, supplied by each write path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChangeContext {
    pub actor: Actor,
    /// The request carried `x-firenook-console`: the console made it.
    pub via_console: bool,
}

impl ChangeContext {
    /// An import or a reset.
    #[must_use]
    pub const fn system() -> Self {
        Self {
            actor: Actor::System,
            via_console: false,
        }
    }

    /// The actor `authorization` names (the header the rules judge, which
    /// for a resumable finalize is the session's), and whether the console
    /// sent the request.
    pub(crate) fn from_authorization(authorization: Option<&str>, via_console: bool) -> Self {
        let actor = match authorization {
            Some("Bearer owner" | "Firebase owner") => Actor::Admin,
            value => auth_from_authorization(value)
                .and_then(|auth| {
                    let tenant = match auth.token.get("firebase") {
                        Some(firenook_rules_engine::Value::Map(firebase)) => {
                            match firebase.get("tenant") {
                                Some(firenook_rules_engine::Value::String(tenant)) => {
                                    Some(tenant.clone())
                                }
                                _ => None,
                            }
                        }
                        _ => None,
                    };
                    auth.uid.map(|uid| Actor::User { uid, tenant })
                })
                .unwrap_or(Actor::Anonymous),
        };
        Self { actor, via_console }
    }
}

/// Whether a request came from the console: it carried
/// `x-firenook-console` (any value the console guard accepts).
pub(crate) fn via_console(headers: &HeaderMap) -> bool {
    headers.contains_key("x-firenook-console")
}

/// What happened to the Storage event a change produced.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EventDelivery {
    /// Not settled yet: the event is dispatched after the change commits.
    Pending,
    /// Queued for the Functions emulator, the v1 and the v2 request.
    Sent,
    /// The Emulator Hub's background-trigger switch is off.
    Paused,
    /// Enqueueing failed: the delivery runtime was stopping.
    Failed,
    /// Functions is not part of this suite, so nothing was queued, as the
    /// official emulator sends nothing then.
    NoFunctions,
    /// The change sends no Storage event at all (an import).
    NoEvent,
}

/// One object change, as an Activity list shows it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObjectChangeRecord {
    /// The storage revision the change committed at.
    pub revision: u64,
    pub at: OffsetDateTime,
    pub bucket: String,
    pub name: String,
    pub kind: ObjectChangeKind,
    /// The object's size after the change (before it, for a delete).
    pub size: u64,
    pub content_type: Option<String>,
    /// A metadata change: the fields and custom keys set, changed or removed
    /// (at most sixteen).
    pub metadata_keys: Vec<String>,
    pub actor: Actor,
    pub via_console: bool,
    pub delivery: EventDelivery,
}

impl ObjectChangeRecord {
    /// A conservative estimate of what the record holds, for the ring's
    /// byte budget.
    fn estimated_bytes(&self) -> usize {
        let actor = match &self.actor {
            Actor::User { uid, tenant } => uid.len() + tenant.as_ref().map_or(0, String::len),
            Actor::Admin | Actor::Anonymous | Actor::System => 0,
        };
        192 + self.bucket.len()
            + self.name.len()
            + self.content_type.as_ref().map_or(0, String::len)
            + self
                .metadata_keys
                .iter()
                .map(|key| key.len() + 24)
                .sum::<usize>()
            + actor
    }
}

/// What storage-front announces, in commit order. Sent inside the `inner`
/// section, so subscribers see changes in exactly the map's order; sending
/// never blocks, and with no subscriber it costs nothing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChangeEvent {
    /// One committed mutation: a protocol write (one name), or an upload
    /// session that started, advanced, finished or was discarded.
    Committed {
        bucket: Arc<str>,
        /// The storage revision after the mutation.
        revision: u64,
        touches: Arc<[(Arc<str>, ObjectChangeKind)]>,
        /// Upload sessions the mutation changed.
        sessions: Arc<[String]>,
    },
    /// The folder index finished building: counts that were unknown are
    /// known now.
    IndexReady,
    /// Every object and session of every bucket is gone (a reset).
    Reset,
}

/// What a batch changed, per bucket, until it is announced.
#[derive(Debug, Default)]
pub(crate) struct Batch {
    buckets: std::collections::BTreeMap<String, Touched>,
}

#[derive(Debug, Default)]
struct Touched {
    revision: u64,
    touches: Vec<(Arc<str>, ObjectChangeKind)>,
    sessions: Vec<String>,
}

impl Batch {
    fn touch(
        &mut self,
        bucket: &str,
        revision: u64,
        object: Option<(&str, ObjectChangeKind)>,
        session: Option<String>,
    ) {
        if !self.buckets.contains_key(bucket) {
            self.buckets.insert(bucket.to_owned(), Touched::default());
        }
        let touched = self.buckets.get_mut(bucket).expect("bucket present");
        touched.revision = revision;
        if let Some((name, kind)) = object {
            touched.touches.push((Arc::from(name), kind));
        }
        if let Some(id) = session {
            touched.sessions.push(id);
        }
    }
}

/// The change broadcast and the activity ring, shared by the object map
/// (which writes them under its lock) and the console handle (which reads
/// them without it).
pub(crate) struct ChangeFeed {
    sender: broadcast::Sender<ChangeEvent>,
    activity: Mutex<ActivityRing>,
}

impl Default for ChangeFeed {
    fn default() -> Self {
        Self {
            sender: broadcast::channel(FEED_CAPACITY).0,
            activity: Mutex::new(ActivityRing::default()),
        }
    }
}

impl fmt::Debug for ChangeFeed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChangeFeed")
            .field("subscribers", &self.sender.receiver_count())
            .finish_non_exhaustive()
    }
}

impl ChangeFeed {
    /// Every change from now on, in commit order.
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<ChangeEvent> {
        self.sender.subscribe()
    }

    pub(crate) fn announce(&self, event: ChangeEvent) {
        // No subscriber is the common case and an error here; nothing is lost
        // that anyone was waiting for.
        let _ = self.sender.send(event);
    }

    fn ring(&self) -> MutexGuard<'_, ActivityRing> {
        self.activity
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Records what happened to the event of the change at `revision`, once
    /// it was dispatched after the commit.
    pub(crate) fn settle(&self, revision: u64, delivery: EventDelivery) {
        self.ring().settle(revision, delivery);
    }

    /// The changes of one object, newest first, and when the ring's window
    /// starts (its oldest record's time).
    pub(crate) fn activity(
        &self,
        bucket: &str,
        name: &str,
    ) -> (Vec<ObjectChangeRecord>, Option<OffsetDateTime>) {
        self.ring().activity(&object_key(bucket, name))
    }
}

/// The newest object changes, with an index by name so one object's
/// changes cost O(its changes), not O(ring).
#[derive(Default)]
struct ActivityRing {
    /// Ordered by revision, oldest first.
    records: VecDeque<ObjectChangeRecord>,
    bytes: usize,
    /// `bucket\0name` -> the revisions of its records, oldest first.
    by_name: HashMap<String, VecDeque<u64>>,
}

impl ActivityRing {
    fn push(&mut self, record: ObjectChangeRecord) {
        self.bytes += record.estimated_bytes();
        self.by_name
            .entry(object_key(&record.bucket, &record.name))
            .or_default()
            .push_back(record.revision);
        self.records.push_back(record);
        while self.records.len() > ACTIVITY_RECORDS
            || (self.bytes > ACTIVITY_BYTES && self.records.len() > 1)
        {
            let Some(oldest) = self.records.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(oldest.estimated_bytes());
            let key = object_key(&oldest.bucket, &oldest.name);
            if let Some(revisions) = self.by_name.get_mut(&key) {
                revisions.pop_front();
                if revisions.is_empty() {
                    self.by_name.remove(&key);
                }
            }
        }
    }

    fn position(&self, revision: u64) -> Option<usize> {
        self.records
            .binary_search_by_key(&revision, |record| record.revision)
            .ok()
    }

    fn settle(&mut self, revision: u64, delivery: EventDelivery) {
        if let Some(index) = self.position(revision) {
            self.records[index].delivery = delivery;
        }
    }

    fn activity(&self, key: &str) -> (Vec<ObjectChangeRecord>, Option<OffsetDateTime>) {
        let records = self.by_name.get(key).map_or_else(Vec::new, |revisions| {
            revisions
                .iter()
                .rev()
                .filter_map(|revision| self.position(*revision))
                .map(|index| self.records[index].clone())
                .collect()
        });
        (records, self.records.front().map(|record| record.at))
    }
}

fn unix_millis(at: OffsetDateTime) -> i64 {
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX)
}

/// Created, replaced (a new generation), tokens or metadata.
fn classify(before: Option<&StoredObject>, after: &StoredObject) -> ObjectChangeKind {
    match before {
        None => ObjectChangeKind::Created,
        Some(before) if before.generation != after.generation => ObjectChangeKind::Replaced,
        Some(before) if before.download_tokens != after.download_tokens => ObjectChangeKind::Tokens,
        Some(_) => ObjectChangeKind::Metadata,
    }
}

/// The standard fields and custom keys a metadata change set, changed or
/// removed, standard fields first, at most sixteen.
fn changed_keys(before: &StoredObject, after: &StoredObject) -> Vec<String> {
    let mut keys = Vec::new();
    for (field, old, new) in [
        (
            "contentType",
            before.content_type.as_ref(),
            after.content_type.as_ref(),
        ),
        (
            "cacheControl",
            before.cache_control.as_ref(),
            after.cache_control.as_ref(),
        ),
        (
            "contentDisposition",
            before.content_disposition.as_ref(),
            after.content_disposition.as_ref(),
        ),
        (
            "contentEncoding",
            before.content_encoding.as_ref(),
            after.content_encoding.as_ref(),
        ),
        (
            "contentLanguage",
            before.content_language.as_ref(),
            after.content_language.as_ref(),
        ),
        (
            "storageClass",
            Some(&before.storage_class),
            Some(&after.storage_class),
        ),
    ] {
        if old != new {
            keys.push(field.to_owned());
        }
    }
    let (old, new) = (&before.custom_metadata, &after.custom_metadata);
    let custom_keys = old
        .keys()
        .chain(new.keys())
        .filter(|key| old.get(*key) != new.get(*key))
        .collect::<BTreeSet<_>>();
    keys.extend(custom_keys.into_iter().cloned());
    keys.truncate(CHANGED_KEYS);
    keys
}

impl StorageData {
    /// The one way to create or replace an object (new bytes, metadata,
    /// tokens), which keeps the folder index exact. Returns the object it
    /// replaced.
    pub(crate) fn put(&mut self, object: StoredObject, cx: &ChangeContext) -> Option<StoredObject> {
        let key = object_key(&object.bucket, &object.name);
        self.revision += 1;
        let before = self.objects.get(&key);
        let kind = classify(before, &object);
        let metadata_keys = match (kind, before) {
            (ObjectChangeKind::Metadata, Some(before)) => changed_keys(before, &object),
            _ => Vec::new(),
        };
        let at = OffsetDateTime::now_utc();
        if let Some(index) = &mut self.folders {
            index.observe(
                &key,
                (&object.bucket, &object.name),
                before.map(Shape::of),
                Some(Shape::of(&object)),
                (self.revision, unix_millis(at)),
            );
        }
        let record = ObjectChangeRecord {
            revision: self.revision,
            at,
            bucket: object.bucket.clone(),
            name: object.name.clone(),
            kind,
            size: object.size,
            content_type: object.content_type.clone(),
            metadata_keys,
            actor: cx.actor.clone(),
            via_console: cx.via_console,
            delivery: if cx.actor == Actor::System {
                EventDelivery::NoEvent
            } else {
                EventDelivery::Pending
            },
        };
        let before = self.objects.insert(key, object);
        self.committed(record);
        before
    }

    /// The one way to delete an object. Returns it when it existed.
    pub(crate) fn remove(&mut self, key: &str, cx: &ChangeContext) -> Option<StoredObject> {
        let before = self.objects.remove(key)?;
        self.revision += 1;
        let at = OffsetDateTime::now_utc();
        if let Some(index) = &mut self.folders {
            index.observe(
                key,
                (&before.bucket, &before.name),
                Some(Shape::of(&before)),
                None,
                (self.revision, unix_millis(at)),
            );
        }
        let record = ObjectChangeRecord {
            revision: self.revision,
            at,
            bucket: before.bucket.clone(),
            name: before.name.clone(),
            kind: ObjectChangeKind::Deleted,
            size: before.size,
            content_type: before.content_type.clone(),
            metadata_keys: Vec::new(),
            actor: cx.actor.clone(),
            via_console: cx.via_console,
            delivery: if cx.actor == Actor::System {
                EventDelivery::NoEvent
            } else {
                EventDelivery::Pending
            },
        };
        self.committed(record);
        Some(before)
    }

    /// Records and announces one committed object change; inside a batch
    /// the announcement waits for the batch's end.
    fn committed(&mut self, record: ObjectChangeRecord) {
        if let Some(batch) = &mut self.batch {
            batch.touch(
                &record.bucket,
                record.revision,
                Some((&record.name, record.kind)),
                None,
            );
            self.feed.ring().push(record);
            return;
        }
        let event = ChangeEvent::Committed {
            bucket: Arc::from(record.bucket.as_str()),
            revision: record.revision,
            touches: Arc::from([(Arc::from(record.name.as_str()), record.kind)]),
            sessions: Arc::from([]),
        };
        self.feed.ring().push(record);
        self.feed.announce(event);
    }

    /// Starts a batch: until [`Self::end_batch`], changes are recorded at
    /// once but announced together, one [`ChangeEvent::Committed`] per
    /// bucket, so a bulk batch of 200 names is one live event, not 200.
    /// Upload sessions that change meanwhile join the batch's event, so the
    /// announced revisions keep their order.
    pub(crate) fn begin_batch(&mut self) {
        self.batch.get_or_insert_with(Batch::default);
    }

    /// Ends a batch, announcing what it changed.
    pub(crate) fn end_batch(&mut self) {
        let Some(batch) = self.batch.take() else {
            return;
        };
        for (bucket, touched) in batch.buckets {
            self.feed.announce(ChangeEvent::Committed {
                bucket: Arc::from(bucket.as_str()),
                revision: touched.revision,
                touches: Arc::from(touched.touches),
                sessions: Arc::from(touched.sessions),
            });
        }
    }

    /// Every object and upload session of every bucket goes, as
    /// `/internal/reset` asks. The revision never goes back: it moves on
    /// once, so a client's "nothing newer than what I hold" stays true across
    /// a reset. No per-object record is made and no Storage event is sent;
    /// one [`ChangeEvent::Reset`] says everything changed.
    pub(crate) fn clear(&mut self) {
        self.batch = None;
        self.objects.clear();
        self.uploads.clear();
        self.next_id = 0;
        self.revision += 1;
        // Nothing left to count: the index is complete at once.
        self.folders = Some(FolderIndex::built());
        self.feed.announce(ChangeEvent::Reset);
    }

    /// The one way to record an upload session's new state (started,
    /// advanced, refused, cancelled).
    pub(crate) fn put_session(&mut self, mut session: UploadSession) {
        let now = unix_millis(OffsetDateTime::now_utc());
        if session.started_at_ms == 0 {
            session.started_at_ms = now;
        }
        session.updated_at_ms = now;
        let (bucket, id) = (session.bucket.clone(), session.id.clone());
        self.uploads.insert(id.clone(), session);
        self.session_committed(&bucket, id);
    }

    /// The one way to forget an upload session (finished or discarded).
    pub(crate) fn remove_session(&mut self, id: &str) -> Option<UploadSession> {
        let session = self.uploads.remove(id)?;
        self.session_committed(&session.bucket, id.to_owned());
        Some(session)
    }

    fn session_committed(&mut self, bucket: &str, id: String) {
        self.revision += 1;
        if let Some(batch) = &mut self.batch {
            batch.touch(bucket, self.revision, None, Some(id));
            return;
        }
        self.feed.announce(ChangeEvent::Committed {
            bucket: Arc::from(bucket),
            revision: self.revision,
            touches: Arc::from([]),
            sessions: Arc::from([id]),
        });
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn no_direct_object_writes() {
        // Whitespace removed, so a call split over lines by the formatter
        // is found too; the test module at the end is left out.
        let source = include_str!("lib.rs");
        let source = source
            .split("#[cfg(test)]\nmod tests {")
            .next()
            .expect("source");
        let compact = source
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>();
        for call in [
            ".objects.insert(",
            ".objects.remove(",
            ".objects.clear(",
            ".uploads.insert(",
            ".uploads.remove(",
            "StorageData::default()",
        ] {
            let found = compact.matches(call).count();
            let allowed = usize::from(call == "StorageData::default()");
            assert!(
                found <= allowed,
                "lib.rs changes objects or sessions outside StorageData: {call} ({found})"
            );
        }
    }

    fn object(generation: u64) -> StoredObject {
        StoredObject {
            name: "users/u1/a.png".to_owned(),
            bucket: "b".to_owned(),
            generation,
            metageneration: 1,
            content_type: Some("image/png".to_owned()),
            storage_class: "STANDARD".to_owned(),
            content_disposition: None,
            content_encoding: None,
            content_language: None,
            cache_control: None,
            download_tokens: vec!["t1".to_owned()],
            custom_metadata: BTreeMap::from([("ownerUid".to_owned(), "u1".to_owned())]),
            time_created: String::new(),
            updated: String::new(),
            size: 10,
            md5_hash: String::new(),
            crc32c: 0,
            etag: String::new(),
            data_file: String::new(),
        }
    }

    #[test]
    fn kinds_are_classified_by_what_changed() {
        let first = object(1);
        assert_eq!(classify(None, &first), ObjectChangeKind::Created);
        assert_eq!(
            classify(Some(&first), &object(2)),
            ObjectChangeKind::Replaced
        );
        let mut tokens = first.clone();
        tokens.download_tokens.push("t2".to_owned());
        assert_eq!(classify(Some(&first), &tokens), ObjectChangeKind::Tokens);
        let mut metadata = first.clone();
        metadata.cache_control = Some("no-store".to_owned());
        metadata.custom_metadata.remove("ownerUid");
        metadata
            .custom_metadata
            .insert("source".to_owned(), "camera".to_owned());
        assert_eq!(
            classify(Some(&first), &metadata),
            ObjectChangeKind::Metadata
        );
        assert_eq!(
            changed_keys(&first, &metadata),
            ["cacheControl", "ownerUid", "source"]
        );
    }

    fn token(claims: &serde_json::Value) -> String {
        use base64::Engine as _;
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!(
            "Bearer {}.{}.",
            URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#),
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).expect("claims"))
        )
    }

    #[test]
    fn actors_come_from_the_authorization() {
        assert_eq!(
            ChangeContext::from_authorization(Some("Bearer owner"), false).actor,
            Actor::Admin
        );
        assert_eq!(
            ChangeContext::from_authorization(Some("Firebase owner"), true),
            ChangeContext {
                actor: Actor::Admin,
                via_console: true
            }
        );
        assert_eq!(
            ChangeContext::from_authorization(
                Some(&token(&serde_json::json!({ "user_id": "u_ada" }))),
                false
            )
            .actor,
            Actor::User {
                uid: "u_ada".to_owned(),
                tenant: None
            }
        );
        assert_eq!(
            ChangeContext::from_authorization(
                Some(&token(&serde_json::json!({
                    "user_id": "u_t", "firebase": { "tenant": "tenant-a" }
                }))),
                false
            )
            .actor,
            Actor::User {
                uid: "u_t".to_owned(),
                tenant: Some("tenant-a".to_owned())
            }
        );
        for anonymous in [
            None,
            Some("Bearer not-a-token"),
            Some(token(&serde_json::json!({ "sub": "no-user-id" })).as_str()),
        ] {
            assert_eq!(
                ChangeContext::from_authorization(anonymous, false).actor,
                Actor::Anonymous,
                "{anonymous:?}"
            );
        }
    }

    #[test]
    fn the_ring_keeps_the_newest_and_indexes_by_name() {
        let mut ring = ActivityRing::default();
        for revision in 1..=(ACTIVITY_RECORDS as u64 + 5) {
            let mut record = ObjectChangeRecord {
                revision,
                at: OffsetDateTime::now_utc(),
                bucket: "b".to_owned(),
                name: format!("f{}", revision % 3),
                kind: ObjectChangeKind::Created,
                size: 1,
                content_type: None,
                metadata_keys: Vec::new(),
                actor: Actor::Anonymous,
                via_console: false,
                delivery: EventDelivery::Pending,
            };
            if revision == 3 {
                record.name = "evicted".to_owned();
            }
            ring.push(record);
        }
        assert_eq!(ring.records.len(), ACTIVITY_RECORDS);
        assert_eq!(ring.records[0].revision, 6);
        assert!(!ring.by_name.contains_key(&object_key("b", "evicted")));
        let (records, since) = ring.activity(&object_key("b", "f1"));
        assert_eq!(since, Some(ring.records[0].at));
        assert!(
            records
                .windows(2)
                .all(|pair| pair[0].revision > pair[1].revision)
        );
        assert!(records.iter().all(|record| record.name == "f1"));
        let total = ["f0", "f1", "f2"]
            .iter()
            .map(|name| ring.activity(&object_key("b", name)).0.len())
            .sum::<usize>();
        assert_eq!(total, ACTIVITY_RECORDS);
        ring.settle(ACTIVITY_RECORDS as u64, EventDelivery::Sent);
        assert_eq!(
            ring.records[ring.position(ACTIVITY_RECORDS as u64).expect("kept")].delivery,
            EventDelivery::Sent
        );
    }
}
