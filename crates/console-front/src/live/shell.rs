//! The `shell` topic: what the console's frame shows on every page.
//!
//! `status` → [`ConsoleStatus`] (every section's state, the engine, the
//! suite's switches) and `badges` → [`BadgeSet`] (the navigation's
//! numbers), both sent on open, then again whenever they change: a status
//! at most four times a second (a late service became ready, counts moved),
//! the badges at most every 250 ms. A subscriber that resumes is sent both
//! again, so no cursor is needed.
//!
//! [`ConsoleStatus`]: crate::ConsoleStatus

use std::collections::BTreeMap;
use std::time::Duration;

use futures_util::StreamExt as _;
use futures_util::stream::{self, BoxStream};
use serde::Deserialize;
use tokio::sync::watch;
use tokio::time::Instant;

use super::badges::{Badge, BadgeBoard, set_of};
use super::{LiveTopic, TopicEvent, TopicStream, topic_params};
use crate::StatusSource;
use crate::api_error::ApiError;

/// The shortest gap between two `status` events, and between two `badges`
/// events, to one subscriber.
pub(crate) const COALESCE: Duration = Duration::from_millis(250);

/// `shell` parameters: none.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ShellParams {}

/// The live channel's `shell` topic.
pub(crate) struct ShellTopic {
    status: StatusSource,
    badges: BadgeBoard,
}

impl ShellTopic {
    pub(crate) const fn new(status: StatusSource, badges: BadgeBoard) -> Self {
        Self { status, badges }
    }
}

impl LiveTopic for ShellTopic {
    fn name(&self) -> &'static str {
        "shell"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        _after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let ShellParams {} = topic_params(params)?;
        // Subscribe before reading, so nothing that changes in between is
        // missed.
        let state = Subscriber {
            changes: Some(self.status.changes()),
            board: Some(self.badges.subscribe()),
            status: self.status.clone(),
            status_pending: true,
            badges_pending: true,
            last_status: None,
            last_badges: None,
        };
        Ok(stream::unfold(state, Subscriber::next).boxed())
    }
}

/// One subscriber's state between events.
struct Subscriber {
    status: StatusSource,
    /// Ticks when the status may have changed; `None` once it ended.
    changes: Option<BoxStream<'static, ()>>,
    /// The badge board; `None` once it is gone.
    board: Option<watch::Receiver<BTreeMap<String, Badge>>>,
    status_pending: bool,
    badges_pending: bool,
    last_status: Option<Instant>,
    last_badges: Option<Instant>,
}

/// When something last sent at `last` may be sent again: at once (`now`)
/// when it was never sent. `now` is the caller's one reading of the clock;
/// reading it again here would put a first event a few nanoseconds after
/// the `now` it is compared with, for ever, wherever two readings differ
/// (always on Linux, on any slow core).
fn due(last: Option<Instant>, now: Instant) -> Instant {
    last.map_or(now, |last| last + COALESCE)
}

impl Subscriber {
    async fn next(mut self) -> Option<(TopicEvent, Self)> {
        loop {
            let now = Instant::now();
            if self.status_pending && due(self.last_status, now) <= now {
                self.status_pending = false;
                self.last_status = Some(now);
                let event = TopicEvent::json("status", None, &self.status.status());
                return Some((event, self));
            }
            if self.badges_pending && due(self.last_badges, now) <= now {
                self.badges_pending = false;
                self.last_badges = Some(now);
                let set = self.board.as_mut().map_or_else(
                    || set_of(&BTreeMap::new()),
                    |board| set_of(&board.borrow_and_update()),
                );
                return Some((TopicEvent::json("badges", None, &set), self));
            }
            let wake = [
                self.status_pending.then(|| due(self.last_status, now)),
                self.badges_pending.then(|| due(self.last_badges, now)),
            ]
            .into_iter()
            .flatten()
            .min();
            tokio::select! {
                tick = async {
                    match self.changes.as_mut() {
                        Some(changes) => changes.next().await,
                        None => std::future::pending().await,
                    }
                } => match tick {
                    Some(()) => self.status_pending = true,
                    None => self.changes = None,
                },
                changed = async {
                    match self.board.as_mut() {
                        Some(board) => board.changed().await,
                        None => std::future::pending().await,
                    }
                } => match changed {
                    Ok(()) => self.badges_pending = true,
                    Err(_) => self.board = None,
                },
                () = async {
                    match wake {
                        Some(wake) => tokio::time::sleep_until(wake).await,
                        None => std::future::pending().await,
                    }
                } => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::compute::{ComputeConsole, ComputeParts};
    use crate::live::badges::{BadgeKind, BadgeNoun, BadgeTone};
    use crate::tests::directory_services;
    use crate::{ConsoleServices, StatusSource};

    fn data(event: &TopicEvent) -> (&'static str, Value) {
        match event {
            TopicEvent::Event { name, data, .. } => {
                (*name, serde_json::from_str(data).expect("json"))
            }
            other => panic!("not an event: {other:?}"),
        }
    }

    async fn next(stream: &mut TopicStream) -> (&'static str, Value) {
        let event = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .expect("an event within 5 s")
            .expect("open");
        data(&event)
    }

    fn compute_state(status: &Value, id: &str) -> Value {
        status["sections"]
            .as_array()
            .expect("sections")
            .iter()
            .find(|section| section["id"] == id)
            .unwrap_or_else(|| panic!("{id} in {status}"))["state"]
            .clone()
    }

    /// Never sent means due at the very reading it is compared with, and
    /// on a clock that runs: the paused clock of the tests below reads the
    /// same twice, which hid a first event that never came on Linux.
    #[test]
    fn a_first_event_is_due_at_the_callers_reading() {
        let now = Instant::now();
        std::thread::sleep(Duration::from_millis(1));
        assert_eq!(due(None, now), now);
        assert_eq!(due(Some(now), now), now + COALESCE);
    }

    #[tokio::test]
    async fn status_and_badges_on_open_on_a_running_clock() {
        let source = StatusSource::for_tests(directory_services());
        let topic = ShellTopic::new(source, BadgeBoard::default());
        let mut stream = topic.open(&json!({}), None).expect("opened");
        assert_eq!(next(&mut stream).await.0, "status");
        assert_eq!(next(&mut stream).await.0, "badges");
    }

    #[tokio::test(start_paused = true)]
    async fn status_and_badges_on_open_then_each_change_coalesced() {
        let parts = ComputeParts::new();
        let services = ConsoleServices {
            compute: Some(parts.clone()),
            ..directory_services()
        };
        let badges = BadgeBoard::default();
        let source = StatusSource::for_tests(services);
        let topic = ShellTopic::new(source, badges.clone());
        let mut stream = topic.open(&json!({}), None).expect("opened");
        let (name, status) = next(&mut stream).await;
        assert_eq!(name, "status");
        assert_eq!(compute_state(&status, "functions"), "starting");
        let (name, set) = next(&mut stream).await;
        assert_eq!(name, "badges");
        assert_eq!(set, json!({ "badges": [] }));

        // Functions come up: a new status, which says so.
        parts.late.set(ComputeConsole {
            functions: axum::Router::new(),
            eventarc: axum::Router::new(),
        });
        let (name, status) = next(&mut stream).await;
        assert_eq!(name, "status");
        assert_eq!(compute_state(&status, "functions"), "ready");
        assert_eq!(compute_state(&status, "eventarc"), "ready");

        // A burst of badge writes is one `badges` event, and the next one
        // comes no sooner than 250 ms after it.
        let rules = badges.handle(
            "firestore.rules",
            BadgeKind::Gauge,
            BadgeNoun::new("rules file does not compile", "rules files do not compile"),
        );
        for count in 1..=50 {
            rules.set(count, BadgeTone::Danger);
        }
        let (name, set) = next(&mut stream).await;
        assert_eq!(name, "badges");
        assert_eq!(set["badges"][0]["count"], 50);
        let first_badges = Instant::now();
        rules.set(0, BadgeTone::Neutral);
        let (name, set) = next(&mut stream).await;
        assert_eq!(name, "badges");
        assert_eq!(set["badges"][0]["count"], 0);
        let gap = first_badges.elapsed();
        assert!(gap >= COALESCE, "{gap:?}");
        // Nothing else is pending.
        assert!(
            tokio::time::timeout(Duration::from_secs(2), stream.next())
                .await
                .is_err()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_burst_of_status_changes_is_at_most_four_events_a_second() {
        let parts = ComputeParts::new();
        let services = ConsoleServices {
            compute: Some(parts.clone()),
            ..directory_services()
        };
        let source = StatusSource::for_tests(services);
        let topic = ShellTopic::new(source, BadgeBoard::default());
        let mut stream = topic.open(&json!({}), None).expect("opened");
        next(&mut stream).await;
        next(&mut stream).await;
        let console = ComputeConsole {
            functions: axum::Router::new(),
            eventarc: axum::Router::new(),
        };
        let started = Instant::now();
        let setter = tokio::spawn(async move {
            // 100 reloads in one second.
            for _ in 0..100 {
                parts.late.set(console.clone());
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        });
        let mut statuses = 0;
        while started.elapsed() < Duration::from_millis(1_000) {
            if let Ok(Some(event)) =
                tokio::time::timeout(Duration::from_millis(1_100), stream.next()).await
                && data(&event).0 == "status"
                && started.elapsed() <= Duration::from_secs(1)
            {
                statuses += 1;
            }
        }
        setter.await.expect("joined");
        assert!(
            (1..=4).contains(&statuses),
            "{statuses} statuses in a second"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_new_foreign_project_and_a_background_flip_each_send_a_status() {
        let foreign = crate::ForeignProjects::default();
        let triggers = firenook_functions_bridge::TriggerRegistry::default();
        let (exporter, _exports) = tokio::sync::mpsc::channel(1);
        let suite = crate::SuiteControls::new(crate::SuiteSettings {
            triggers: triggers.clone(),
            background: None,
            exporter,
            data: crate::SuiteControls::detached().data(),
            destinations: Vec::new(),
        });
        let services = ConsoleServices {
            foreign: foreign.clone(),
            suite: suite.clone(),
            ..directory_services()
        };
        let topic = ShellTopic::new(StatusSource::for_tests(services), BadgeBoard::default());
        let mut stream = topic.open(&json!({}), None).expect("opened");
        next(&mut stream).await;
        next(&mut stream).await;
        foreign.record("my-prod", "auth");
        let (name, status) = next(&mut stream).await;
        assert_eq!(name, "status");
        assert_eq!(status["foreignProjects"][0]["projectId"], "my-prod");
        // Another request of the same project and service is not news.
        foreign.record("my-prod", "auth");
        assert!(
            tokio::time::timeout(Duration::from_secs(2), stream.next())
                .await
                .is_err()
        );
        // The console's switch: the status follows.
        let response = tower::ServiceExt::oneshot(
            suite.router(),
            axum::http::Request::post("/suite/background")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(r#"{"enabled":false}"#))
                .expect("request"),
        )
        .await
        .expect("response");
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let (name, status) = next(&mut stream).await;
        assert_eq!(name, "status");
        assert_eq!(status["backgroundTriggers"]["enabled"], false);
        // A dropped event while paused, and the hub's own switch, each
        // send a status too.
        triggers.note_dropped(firenook_functions_bridge::DroppedService::Pubsub);
        let (_, status) = next(&mut stream).await;
        assert_eq!(
            status["backgroundTriggers"]["dropped"],
            json!([{ "service": "pubsub", "count": 1 }])
        );
        triggers.set_background_enabled(true);
        let (_, status) = next(&mut stream).await;
        assert_eq!(status["backgroundTriggers"]["enabled"], true);
        assert_eq!(
            status["backgroundTriggers"]["since"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn unknown_parameters_are_refused() {
        let topic = ShellTopic::new(
            StatusSource::for_tests(directory_services()),
            BadgeBoard::default(),
        );
        let Err(error) = topic.open(&json!({ "section": "auth" }), None) else {
            panic!("refused");
        };
        assert!(
            error.detail().message.contains("unknown field"),
            "{error:?}"
        );
    }
}
