//! Firestore in the console: the same-origin REST surface the workbench
//! reads and writes through, a live change feed fed by the store's commit
//! observers, and the Requests diagnostics feed.
//!
//! Everything here is reachable under the console's own origin, so the
//! workbench works wherever the console page itself loads from (a plain
//! port, a reverse proxy, an HTTPS alias); nothing in the browser needs the
//! Firestore port.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::{Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use firenook_core_store::{CommitObservation, CommitObserver, Store, Timestamp};
use futures_util::Stream;
use futures_util::stream::{self, StreamExt as _};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::{broadcast, watch};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use ts_rs::TS;

use crate::schema::SchemaIndex;

/// Commits retained for a slow console before it is told to resync.
const FEED_CAPACITY: usize = 512;

/// The Firestore services the console mounts.
pub struct FirestoreConsole {
    /// A REST front sharing the engine's service, nested under
    /// `/api/v1/firestore` so the Firestore REST protocol is same-origin.
    pub rest: Router,
    /// The live change feed, already registered with the store.
    pub changes: ChangeFeed,
    /// The schema index, already registered with the store.
    pub schema: SchemaIndex,
    /// The Requests diagnostics feed (`/requests` upgrades to a websocket),
    /// when the Firestore front records evaluations.
    pub requests: Option<Router>,
    /// Flips to `true` when the suite stops. Every open change stream ends
    /// then; a stream that stayed open would hold the UI listener's graceful
    /// shutdown for as long as a console tab was open.
    pub shutdown: watch::Receiver<bool>,
}

/// One atomic commit as the console sees it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChangeBatch {
    /// Store revision the commit installed.
    #[ts(type = "number")]
    pub revision: u64,
    /// Commit time, RFC 3339.
    pub commit_time: String,
    /// Every document the commit changed, in write order.
    pub changes: Vec<DocumentChange>,
}

/// One document transition inside a commit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentChange {
    /// Database id, for example `(default)`.
    pub database: String,
    /// Relative document path, for example `users/u_9f3k2`.
    pub path: String,
    /// What happened to the document.
    pub kind: ChangeKind,
}

/// The transition a change describes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Created,
    Updated,
    Deleted,
}

/// The first event on a change stream: where the store is now, so the
/// console knows which revision its data corresponds to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChangeHello {
    /// Current store revision.
    #[ts(type = "number")]
    pub revision: u64,
}

/// Fans store commits out to every open change stream.
#[derive(Clone)]
pub struct ChangeFeed {
    sender: broadcast::Sender<Arc<ChangeBatch>>,
    store: Store,
}

/// What the change stream handler needs: the feed and the suite's stop flag.
#[derive(Clone)]
struct ChangeStreams {
    feed: ChangeFeed,
    shutdown: watch::Receiver<bool>,
}

impl ChangeFeed {
    /// Creates the feed and registers it with `store`.
    #[must_use]
    pub fn attach(store: &Store) -> Self {
        let (sender, _) = broadcast::channel(FEED_CAPACITY);
        let feed = Self {
            sender,
            store: store.clone(),
        };
        store.add_commit_observer(Arc::new(feed.clone()));
        feed
    }

    fn router(self, shutdown: watch::Receiver<bool>) -> Router {
        Router::new()
            .route("/changes", axum::routing::get(changes))
            .with_state(ChangeStreams {
                feed: self,
                shutdown,
            })
    }
}

impl CommitObserver for ChangeFeed {
    fn committed(&self, observation: &CommitObservation) {
        if self.sender.receiver_count() == 0 {
            return;
        }
        let batch = ChangeBatch {
            revision: observation.result.revision.get(),
            commit_time: rfc3339(observation.result.commit_time),
            changes: observation
                .changes
                .iter()
                .map(|change| DocumentChange {
                    database: change.key.database().database_id().to_owned(),
                    path: change.key.path().to_owned(),
                    kind: match (&change.before, &change.after) {
                        (None, Some(_)) => ChangeKind::Created,
                        (Some(_), None) => ChangeKind::Deleted,
                        _ => ChangeKind::Updated,
                    },
                })
                .collect(),
        };
        // A send only fails when no stream is open; nothing to retain then.
        let _ = self.sender.send(Arc::new(batch));
    }
}

fn rfc3339(value: Timestamp) -> String {
    OffsetDateTime::from_unix_timestamp(value.seconds())
        .and_then(|timestamp| timestamp.replace_nanosecond(value.nanos()))
        .ok()
        .and_then(|timestamp| timestamp.format(&Rfc3339).ok())
        .unwrap_or_default()
}

/// Which changes one stream wants.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct ChangeScope {
    /// Database id; every database when absent.
    database: Option<String>,
    /// A document or collection path; a change matches when its path is the
    /// scope or lies under it. Empty means everything.
    #[serde(default)]
    scope: String,
}

impl ChangeScope {
    fn matches(&self, change: &DocumentChange) -> bool {
        if self
            .database
            .as_deref()
            .is_some_and(|database| database != change.database)
        {
            return false;
        }
        if self.scope.is_empty() {
            return true;
        }
        change.path == self.scope
            || change
                .path
                .strip_prefix(self.scope.as_str())
                .is_some_and(|rest| rest.starts_with('/'))
    }
}

/// `GET /changes?database=(default)&scope=users`: a server-sent event stream.
/// `hello` carries the current revision, `change` one commit, and `reset`
/// tells a console that fell behind to reload what it shows. The stream
/// ends when the suite stops, so shutdown never waits on a console tab.
async fn changes(
    State(streams): State<ChangeStreams>,
    Query(scope): Query<ChangeScope>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let receiver = streams.feed.sender.subscribe();
    let hello = ChangeHello {
        revision: streams.feed.store.revision().get(),
    };
    let first = stream::once(async move { Ok(json_event("hello", &hello)) });
    let rest = BroadcastStream::new(receiver).filter_map(move |item| {
        let event = match item {
            Ok(batch) => {
                let changes = batch
                    .changes
                    .iter()
                    .filter(|change| scope.matches(change))
                    .cloned()
                    .collect::<Vec<_>>();
                if changes.is_empty() {
                    None
                } else {
                    Some(json_event(
                        "change",
                        &ChangeBatch {
                            revision: batch.revision,
                            commit_time: batch.commit_time.clone(),
                            changes,
                        },
                    ))
                }
            }
            Err(BroadcastStreamRecvError::Lagged(_)) => Some(Event::default().event("reset")),
        };
        async move { event.map(Ok) }
    });
    let mut shutdown = streams.shutdown;
    let stopped = async move {
        // A dropped sender means the suite is gone too.
        while !*shutdown.borrow() && shutdown.changed().await.is_ok() {}
    };
    Sse::new(first.chain(rest).take_until(stopped)).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    )
}

fn json_event(name: &str, data: &impl Serialize) -> Event {
    Event::default()
        .event(name)
        .json_data(data)
        .unwrap_or_else(|_| Event::default().event(name))
}

/// The console's Firestore routes: the change feed, the schema index, the
/// Requests feed and the REST front, mounted together under
/// `/api/v1/firestore`.
pub(crate) fn firestore_router(console: FirestoreConsole) -> Router {
    let mut router = console
        .changes
        .router(console.shutdown)
        .merge(console.schema.router());
    if let Some(requests) = console.requests {
        router = router.merge(requests);
    }
    router.merge(console.rest)
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt as _;

    use super::*;

    fn change(database: &str, path: &str) -> DocumentChange {
        DocumentChange {
            database: database.to_owned(),
            path: path.to_owned(),
            kind: ChangeKind::Updated,
        }
    }

    #[test]
    fn scope_matches_the_path_itself_and_everything_under_it() {
        let scope = ChangeScope {
            database: Some("(default)".to_owned()),
            scope: "users".to_owned(),
        };
        assert!(scope.matches(&change("(default)", "users/u1")));
        assert!(scope.matches(&change("(default)", "users/u1/orders/o1")));
        assert!(!scope.matches(&change("(default)", "users-archive/u1")));
        assert!(!scope.matches(&change("analytics", "users/u1")));
    }

    #[test]
    fn an_empty_scope_matches_every_change() {
        let scope = ChangeScope::default();
        assert!(scope.matches(&change("(default)", "anything/at/all/here")));
    }

    #[tokio::test]
    async fn a_change_stream_ends_when_the_suite_stops() {
        let store = Store::default();
        let (stop, shutdown) = watch::channel(false);
        let router = ChangeFeed::attach(&store).router(shutdown);
        let response = router
            .oneshot(
                Request::get("/changes?database=(default)")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        // The greeting arrives while the suite runs; the body then only
        // ends because the suite stopped, not because a tab closed.
        let mut body = response.into_body().into_data_stream();
        let greeting = tokio::time::timeout(Duration::from_secs(5), body.next())
            .await
            .expect("the greeting arrives")
            .expect("a chunk")
            .expect("bytes");
        stop.send(true).expect("a subscriber is listening");
        let remainder = tokio::time::timeout(Duration::from_secs(5), async {
            let mut collected = Vec::new();
            while let Some(chunk) = body.next().await {
                collected.extend_from_slice(&chunk.expect("bytes"));
            }
            collected
        })
        .await
        .expect("the stream ended after shutdown");
        let body = [greeting.to_vec(), remainder].concat();
        let text = String::from_utf8(body).expect("utf-8");
        assert!(text.contains("event: hello"), "{text}");
    }
}
