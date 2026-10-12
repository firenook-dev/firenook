//! Authentication in the console (the auth stream's module). Owns
//! `/api/v1/auth/...`.
//!
//! The Auth emulator's own HTTP application (Identity Toolkit, Secure
//! Token, the emulator routes) is the fallback under `/auth`, so the
//! console reaches it same-origin at its usual paths
//! (`/auth/identitytoolkit.googleapis.com/v1/...`). The console's own
//! routes (`routes.rs`) are added beside it and take precedence: users,
//! tokens and their inspection, bulk jobs, imports and exports, the Inbox
//! and Activity, tenants, hooks and the summary.
//!
//! [`AuthConsole::attach`] installs [`AuthFeed`] as the runtime's observer:
//! what the emulator does reaches the Activity and Inbox pages, the five
//! live topics (`topics.rs`), the `auth.inbox` badge and the log.

mod feed;
mod filter;
mod identities;
mod routes;
mod search;
mod tokens;
mod topics;
mod uploads;
#[allow(
    unreachable_pub,
    reason = "the wire types reach the browser through ts-rs; the crate root re-exports only the foundation's four"
)]
mod wire;

use std::sync::{Arc, OnceLock};

use axum::Router;
use firenook_auth_front::{AuthRuntime, Runtime};
use firenook_suite_front::LoggingRuntime;
use futures_util::StreamExt as _;
use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use tokio::sync::watch;
use tokio_stream::wrappers::WatchStream;

use feed::AuthFeed;

use crate::api_error::ApiError;
use crate::http::forwarded;
use crate::jobs::JobHandle;
use crate::live::LiveTopic;
use crate::live::badges::{BadgeKind, BadgeNoun};
use crate::search::SearchSource;
use crate::section::{
    ClearOptions, ClearReport, Section, SectionContext, SectionStatus, SectionSummary,
    SummaryFigure, SummaryUnit,
};

pub use identities::IdentityUser;
pub use tokens::{AuthToken, AuthTokenRequest};

/// Where the Auth emulator's application is mounted, as the browser sees it.
pub(crate) const NATIVE_PREFIX: &str = "/console/api/v1/auth";

/// The Auth emulator's own paths under `/api/v1/auth`: its readiness page
/// at the root is a GET, and everything else it serves is under these. The
/// request guard treats only these as the emulator's (its own semantics);
/// every other path under `/auth` is a console route.
pub(crate) const NATIVE_PATHS: [&str; 4] = [
    "/identitytoolkit.googleapis.com",
    "/securetoken.googleapis.com",
    "/www.googleapis.com",
    "/emulator",
];

/// What the section starts once, when the console is built.
struct Live {
    windows: topics::UsersWindows,
    /// Ticks when the summary's counts moved.
    status: watch::Sender<u64>,
    uploads: OnceLock<uploads::Uploads>,
}

/// Authentication's part of the console.
#[derive(Clone)]
pub struct AuthConsole {
    /// The Auth emulator's own HTTP application (Identity Toolkit, the
    /// emulator routes), reachable same-origin as the fallback under `/auth`.
    pub native: Router,
    /// The emulator's state, for console-own reads and writes.
    pub runtime: Runtime,
    /// The rings, the message store, the users coalescer's queue, the badge
    /// handle and the log handle; installed as the runtime's observer.
    pub feed: AuthFeed,
    live: Arc<Live>,
}

impl std::fmt::Debug for AuthConsole {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuthConsole")
            .field("project", &self.runtime.default_project())
            .field("feed", &self.feed)
            .finish_non_exhaustive()
    }
}

impl AuthConsole {
    /// Installs the feed as the runtime's observer (bodies kept when
    /// `keep_bodies`), seeds the inbox from saved codes, and keeps `logging`
    /// for the `auth.config` lines.
    #[must_use]
    pub fn attach(auth: &AuthRuntime, keep_bodies: bool, logging: LoggingRuntime) -> Self {
        let runtime = auth.runtime();
        let feed = AuthFeed::new(keep_bodies, logging);
        feed.seed(feed::saved(&runtime));
        feed::attach(auth, &feed);
        let (status, _) = watch::channel(0);
        Self {
            native: auth.application(),
            runtime,
            feed,
            live: Arc::new(Live {
                windows: topics::UsersWindows::new(),
                status,
                uploads: OnceLock::new(),
            }),
        }
    }

    /// Starts what the section runs in the background, once: the users
    /// coalescer, the badge and the uploads' sweeper, each ending on the
    /// stop signal. Answers the uploads.
    fn start(&self, context: &SectionContext) -> uploads::Uploads {
        self.live
            .uploads
            .get_or_init(|| {
                self.feed.set_badge(context.badges.handle(
                    "auth.inbox",
                    BadgeKind::Counter,
                    BadgeNoun::new("new code or link", "new codes and links"),
                ));
                if let Some(queue) = self.feed.take_users_queue() {
                    tokio::spawn(topics::coalesce(
                        self.feed.clone(),
                        queue,
                        self.runtime.clone(),
                        self.live.windows.clone(),
                        self.live.status.clone(),
                        context.shutdown.clone(),
                    ));
                }
                uploads::Uploads::start(&context.instance.id, context.shutdown.clone())
            })
            .clone()
    }
}

/// The Authentication section.
pub(crate) struct AuthSection(pub(crate) AuthConsole);

/// "1 user", "1,204 users".
fn counted(count: u64, one: &str, other: &str) -> String {
    let text =
        firenook_auth_front::console::bulk::thousands(usize::try_from(count).unwrap_or(usize::MAX));
    format!("{text} {}", if count == 1 { one } else { other })
}

impl Section for AuthSection {
    fn statuses(&self) -> Vec<SectionStatus> {
        vec![SectionStatus::ready("auth")]
    }

    fn status_changes(&self) -> Option<BoxStream<'static, ()>> {
        Some(
            WatchStream::from_changes(self.0.live.status.subscribe())
                .map(|_| ())
                .boxed(),
        )
    }

    fn router(&self, context: &SectionContext) -> Router {
        let uploads = self.0.start(context);
        // Mounted as one service, so every path under `/auth` arrives with
        // the prefix stripped: the console's own routes first, and the
        // native application (one fallback handler) for everything else.
        Router::new().nest_service(
            "/auth",
            routes::router(routes::AuthRoutes {
                console: self.0.clone(),
                context: context.clone(),
                uploads,
            })
            .fallback_service(forwarded(self.0.native.clone(), NATIVE_PREFIX)),
        )
    }

    fn topics(&self, context: &SectionContext) -> Vec<Arc<dyn LiveTopic>> {
        self.0.start(context);
        let console = &self.0;
        vec![
            Arc::new(topics::UsersTopic {
                runtime: console.runtime.clone(),
                windows: console.live.windows.clone(),
                shutdown: context.shutdown.clone(),
            }),
            Arc::new(topics::ActivityTopic {
                feed: console.feed.clone(),
                project: context.project.clone(),
                shutdown: context.shutdown.clone(),
            }),
            Arc::new(topics::InboxTopic {
                feed: console.feed.clone(),
                project: context.project.clone(),
                shutdown: context.shutdown.clone(),
            }),
            Arc::new(topics::ConfigTopic {
                feed: console.feed.clone(),
                project: context.project.clone(),
                shutdown: context.shutdown.clone(),
            }),
            Arc::new(topics::HooksTopic {
                runtime: console.runtime.clone(),
                shutdown: context.shutdown.clone(),
            }),
        ]
    }

    fn search(&self, context: &SectionContext) -> Option<Arc<dyn SearchSource>> {
        Some(Arc::new(search::UserSource {
            runtime: self.0.runtime.clone(),
            project: context.project.clone(),
        }))
    }

    fn summary(&self, _id: &str) -> Option<SectionSummary> {
        let counts = self
            .0
            .runtime
            .summary_counts(self.0.runtime.default_project());
        let mut headline = counted(counts.users, "user", "users");
        if counts.tenants > 0 {
            headline.push_str(" · ");
            headline.push_str(&counted(counts.tenants, "tenant", "tenants"));
        }
        let figure = |label: &str, value: u64| SummaryFigure {
            label: label.to_owned(),
            value: Some(value),
            unit: SummaryUnit::Count,
        };
        Some(SectionSummary {
            headline,
            figures: vec![
                figure("users", counts.users),
                figure("tenants", counts.tenants),
                figure("tenant users", counts.tenant_users),
            ],
        })
    }

    fn clear(
        &self,
        _id: &str,
        job: JobHandle,
        _options: ClearOptions,
    ) -> Option<BoxFuture<'static, Result<ClearReport, ApiError>>> {
        // Every user of every tenant, without triggers (the emulator's own
        // delete-all semantics: codes kept, no `user.delete`).
        let runtime = self.0.runtime.clone();
        Some(Box::pin(async move {
            crate::blocking::blocking("clearing Authentication", move || {
                let project = runtime.default_project().to_owned();
                runtime
                    .clear_users(&project, &routes::JobProgress(job))
                    .map(|removed| ClearReport {
                        section: "auth".to_owned(),
                        removed,
                    })
                    .map_err(routes::console_error)
            })
            .await
        }))
    }
}

/// The auth stream's TypeScript bindings, into `generated/auth/` (and the
/// foundation's identity types).
#[cfg(test)]
pub(crate) fn export_bindings(config: &ts_rs::Config) {
    use ts_rs::TS as _;
    IdentityUser::export_all(config).expect("TypeScript bindings written");
    AuthTokenRequest::export_all(config).expect("TypeScript bindings written");
    AuthToken::export_all(config).expect("TypeScript bindings written");
    wire::export_bindings(config);
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

#[cfg(test)]
#[path = "api_tests.rs"]
mod api_tests;

#[cfg(test)]
#[path = "live_tests.rs"]
mod live_tests;
