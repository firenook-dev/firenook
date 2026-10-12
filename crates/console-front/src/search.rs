//! ⌘K across the console: `GET /search?q=&limit=`.
//!
//! Every section that has things to find contributes a [`SearchSource`]
//! (`Section::search`), answered from an index the section keeps anyway:
//! exact keys and prefixes are range reads, substrings scan within a budget.
//! The handler asks every source at once on the blocking pool and gives each
//! 50 ms. A wait abandoned at the deadline does not stop blocking work, so
//! each source also gets a cancel flag the handler sets at the deadline and
//! the source checks between items; and each source runs one call at a
//! time: a request that finds the previous call still running skips that
//! source, so fast typing never piles up blocking tasks. A source skipped or
//! over budget is left out and the answer says `partial`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::section::section_rank;

/// What ⌘K found across the console.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
pub struct SearchResults {
    /// One group per section with hits, in sidebar order.
    pub groups: Vec<SearchGroup>,
    /// A section ran out of its time budget, or was still answering the
    /// previous search, and is missing or incomplete.
    pub partial: bool,
}

/// One section's hits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
pub struct SearchGroup {
    /// The section id.
    pub section: String,
    pub hits: Vec<SearchHit>,
}

/// One thing ⌘K can open.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
pub struct SearchHit {
    /// `<section>.<thing>`, one of the pinned entity kinds
    /// (`firestore.collection`, `firestore.document`, `auth.user`), which the
    /// console maps to a page through the section registry's `routes`.
    pub kind: String,
    /// What that page opens it by, in the kind's key format.
    pub key: String,
    /// The line ⌘K shows.
    pub title: String,
    /// The quieter line beside it.
    pub detail: Option<String>,
}

/// One section's contribution to ⌘K. Exact keys and prefixes come from an
/// index the section keeps anyway (a range read); substrings scan, within
/// [`SEARCH_BUDGET`] items.
pub(crate) trait SearchSource: Send + Sync + 'static {
    /// The section id the hits belong to.
    fn section(&self) -> &'static str;
    /// At most `limit` hits for `text` (trimmed, 1 to 200 characters), best
    /// first: exact key, then prefix, then substring. Stops when `cancel` is
    /// set or the budget is spent, and says so with `partial`.
    fn search(&self, text: &str, limit: usize, cancel: &AtomicBool) -> SourceHits;
}

/// What one source found.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SourceHits {
    pub(crate) hits: Vec<SearchHit>,
    /// The source stopped early (cancelled or out of budget).
    pub(crate) partial: bool,
}

/// Items one source examines at most for one search.
pub(crate) const SEARCH_BUDGET: usize = 20_000;
/// How long the handler waits for one source.
const SOURCE_BUDGET: Duration = Duration::from_millis(50);
/// The longest search text, in characters.
const MAX_TEXT: usize = 200;
/// Hits per section: default and maximum.
const DEFAULT_LIMIT: usize = 5;
const MAX_LIMIT: usize = 20;

/// A source and whether a call of it is still running.
struct Entry {
    source: Arc<dyn SearchSource>,
    busy: Arc<AtomicBool>,
}

/// Every section's source, for the `/search` route.
#[derive(Clone)]
pub(crate) struct Search {
    entries: Arc<[Entry]>,
    budget: Duration,
}

impl Search {
    /// The search over `sources`.
    pub(crate) fn new(sources: Vec<Arc<dyn SearchSource>>) -> Self {
        Self::with_budget(sources, SOURCE_BUDGET)
    }

    fn with_budget(sources: Vec<Arc<dyn SearchSource>>, budget: Duration) -> Self {
        Self {
            entries: sources
                .into_iter()
                .map(|source| Entry {
                    source,
                    busy: Arc::new(AtomicBool::new(false)),
                })
                .collect(),
            budget,
        }
    }

    /// `GET /search`.
    pub(crate) fn router(self) -> Router {
        Router::new().route("/search", get(search)).with_state(self)
    }

    /// Asks every source for `text` at once and gathers what came back in
    /// time, in sidebar order.
    pub(crate) async fn run(&self, text: &str, limit: usize) -> SearchResults {
        let asks = self
            .entries
            .iter()
            .map(|entry| self.ask(entry, text, limit));
        let answers = futures_util::future::join_all(asks).await;
        let mut partial = false;
        let mut groups = Vec::new();
        for (entry, answer) in self.entries.iter().zip(answers) {
            match answer {
                Some(found) => {
                    partial |= found.partial;
                    if !found.hits.is_empty() {
                        groups.push(SearchGroup {
                            section: entry.source.section().to_owned(),
                            hits: found.hits.into_iter().take(limit).collect(),
                        });
                    }
                }
                None => partial = true,
            }
        }
        groups.sort_by_key(|group| section_rank(&group.section));
        SearchResults { groups, partial }
    }

    /// One source's answer, or `None` when it was still busy, panicked or
    /// missed the deadline.
    async fn ask(&self, entry: &Entry, text: &str, limit: usize) -> Option<SourceHits> {
        if entry.busy.swap(true, Ordering::AcqRel) {
            return None;
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let source = Arc::clone(&entry.source);
        let busy = BusyGuard(Arc::clone(&entry.busy));
        let flag = Arc::clone(&cancel);
        let text = text.to_owned();
        let work = tokio::task::spawn_blocking(move || {
            // Released when the call ends, panics included, whether or not
            // anyone still waits for it.
            let _busy = busy;
            source.search(&text, limit, &flag)
        });
        match tokio::time::timeout(self.budget, work).await {
            Ok(Ok(found)) => Some(found),
            Ok(Err(_)) => None,
            Err(_) => {
                cancel.store(true, Ordering::Release);
                None
            }
        }
    }
}

/// Marks a source idle again when its call ends.
struct BusyGuard(Arc<AtomicBool>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Debug, Deserialize)]
struct SearchParams {
    #[serde(default)]
    q: String,
    #[serde(default)]
    limit: Option<usize>,
}

async fn search(
    State(search): State<Search>,
    Query(params): Query<SearchParams>,
) -> Result<Json<SearchResults>, ApiError> {
    let text = params.q.trim();
    if text.is_empty() {
        return Err(ApiError::invalid("Search needs some text."));
    }
    let length = text.chars().count();
    if length > MAX_TEXT {
        return Err(ApiError::invalid(format!(
            "Search text is at most {MAX_TEXT} characters; this is {length}."
        )));
    }
    let limit = params.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    Ok(Json(search.run(text, limit).await))
}

/// How well `candidate` matches `text`, case-insensitively: 0 for equal, 1
/// for a prefix, 2 for a substring; `None` for no match. `text` is
/// lowercased already.
pub(crate) fn match_rank(candidate: &str, text: &str) -> Option<u8> {
    let candidate = candidate.to_lowercase();
    if candidate == text {
        Some(0)
    } else if candidate.starts_with(text) {
        Some(1)
    } else if candidate.contains(text) {
        Some(2)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt as _;

    use super::*;

    /// A source answering one hit per call after `delay`, counting calls and
    /// whether it saw its cancel flag set.
    struct Fake {
        section: &'static str,
        delay: Duration,
        hits: usize,
        calls: AtomicUsize,
        cancelled: Arc<AtomicBool>,
    }

    impl Fake {
        fn new(section: &'static str, delay: Duration, hits: usize) -> Arc<Self> {
            Arc::new(Self {
                section,
                delay,
                hits,
                calls: AtomicUsize::new(0),
                cancelled: Arc::new(AtomicBool::new(false)),
            })
        }
    }

    impl SearchSource for Fake {
        fn section(&self) -> &'static str {
            self.section
        }

        fn search(&self, text: &str, limit: usize, cancel: &AtomicBool) -> SourceHits {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let started = std::time::Instant::now();
            while started.elapsed() < self.delay {
                if cancel.load(Ordering::Acquire) {
                    self.cancelled.store(true, Ordering::SeqCst);
                    return SourceHits {
                        hits: Vec::new(),
                        partial: true,
                    };
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            SourceHits {
                hits: (0..self.hits.min(limit))
                    .map(|index| SearchHit {
                        kind: format!("{}.thing", self.section),
                        key: format!("{text}-{index}"),
                        title: format!("{text} {index}"),
                        detail: None,
                    })
                    .collect(),
                partial: false,
            }
        }
    }

    #[tokio::test]
    async fn groups_come_in_sidebar_order_and_empty_ones_are_left_out() {
        let search = Search::new(vec![
            Fake::new("logs", Duration::ZERO, 1),
            Fake::new("auth", Duration::ZERO, 0),
            Fake::new("storage", Duration::ZERO, 2),
            Fake::new("firestore", Duration::ZERO, 9),
        ]);
        let results = search.run("ada", 5).await;
        let sections: Vec<&str> = results
            .groups
            .iter()
            .map(|group| group.section.as_str())
            .collect();
        assert_eq!(sections, ["firestore", "storage", "logs"]);
        assert_eq!(results.groups[0].hits.len(), 5, "at most limit hits");
        assert!(!results.partial);
    }

    #[tokio::test]
    async fn a_slow_source_is_dropped_and_its_cancel_flag_set() {
        let slow = Fake::new("storage", Duration::from_millis(400), 1);
        let fast = Fake::new("firestore", Duration::ZERO, 1);
        let search = Search::with_budget(
            vec![
                Arc::clone(&slow) as Arc<dyn SearchSource>,
                Arc::clone(&fast) as Arc<dyn SearchSource>,
            ],
            Duration::from_millis(50),
        );
        let first = search.run("ada", 5).await;
        assert!(first.partial);
        assert_eq!(first.groups.len(), 1);
        assert_eq!(first.groups[0].section, "firestore");
        // The deadline set the flag; the source sees it at its next check.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !slow.cancelled.load(Ordering::SeqCst) {
            assert!(
                std::time::Instant::now() < deadline,
                "the cancel flag was never set"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        // The cancelled call ended; the source answers again.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while search.entries[0].busy.load(Ordering::SeqCst) {
            assert!(
                std::time::Instant::now() < deadline,
                "the busy flag was never released"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test]
    async fn a_source_still_answering_is_skipped_not_queued() {
        let slow = Fake::new("auth", Duration::from_millis(300), 1);
        let search = Search::with_budget(
            vec![Arc::clone(&slow) as Arc<dyn SearchSource>],
            Duration::from_secs(5),
        );
        let running = {
            let search = search.clone();
            tokio::spawn(async move { search.run("ada", 5).await })
        };
        // Wait until the first call is inside the source.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while slow.calls.load(Ordering::SeqCst) == 0 {
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        let second = search.run("adb", 5).await;
        assert!(second.partial, "skipped while the first call ran");
        assert_eq!(second.groups, []);
        assert_eq!(slow.calls.load(Ordering::SeqCst), 1);
        let first = running.await.expect("joined");
        assert!(!first.partial);
        assert_eq!(first.groups[0].hits[0].key, "ada-0");
        // Idle again: the next call runs.
        let third = search.run("adc", 5).await;
        assert!(!third.partial);
        assert_eq!(slow.calls.load(Ordering::SeqCst), 2);
    }

    async fn get(search: &Search, uri: &str) -> (StatusCode, serde_json::Value) {
        let response = search
            .clone()
            .router()
            .oneshot(Request::get(uri).body(Body::empty()).expect("request"))
            .await
            .expect("response");
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        (status, serde_json::from_slice(&body).expect("json"))
    }

    #[tokio::test]
    async fn the_route_refuses_empty_and_long_text_and_clamps_the_limit() {
        let search = Search::new(vec![Fake::new("firestore", Duration::ZERO, 50)]);
        for uri in ["/search", "/search?q=", "/search?q=%20%20"] {
            let (status, body) = get(&search, uri).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
            assert_eq!(body["error"]["code"], "invalid-argument");
        }
        let long = "a".repeat(201);
        let (status, body) = get(&search, &format!("/search?q={long}")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["error"]["message"],
            "Search text is at most 200 characters; this is 201."
        );
        let exact = "a".repeat(200);
        let (status, _) = get(&search, &format!("/search?q={exact}")).await;
        assert_eq!(status, StatusCode::OK);
        let (_, body) = get(&search, "/search?q=ada").await;
        assert_eq!(body["groups"][0]["hits"].as_array().expect("hits").len(), 5);
        let (_, body) = get(&search, "/search?q=ada&limit=100").await;
        assert_eq!(
            body["groups"][0]["hits"].as_array().expect("hits").len(),
            20
        );
        assert_eq!(body["partial"], false);
        assert_eq!(
            body["groups"][0]["hits"][0]["detail"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn matches_rank_exact_then_prefix_then_substring() {
        assert_eq!(match_rank("Users", "users"), Some(0));
        assert_eq!(match_rank("usersArchive", "users"), Some(1));
        assert_eq!(match_rank("oldUsers", "users"), Some(2));
        assert_eq!(match_rank("orders", "users"), None);
    }
}
