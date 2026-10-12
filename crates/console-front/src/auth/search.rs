//! What ⌘K finds in Authentication: users of the configured project, in
//! every tenant, from auth-front's user index (exact uid and email first,
//! then prefixes, then a substring scan within the foundation's budget).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use firenook_auth_front::Runtime;
use firenook_auth_front::console::UserRow;
use firenook_auth_front::console::search::SearchScope;

use crate::entity::EntityRef;
use crate::search::{SEARCH_BUDGET, SearchHit, SearchSource, SourceHits};

/// How long one ⌘K search scans before it answers what it has.
const SCAN_TIME: Duration = Duration::from_millis(40);

/// The Authentication source.
pub(crate) struct UserSource {
    pub(crate) runtime: Runtime,
    pub(crate) project: Arc<str>,
}

/// The line ⌘K shows: email, else phone, else name, else "Anonymous user".
pub(crate) fn title(row: &UserRow) -> String {
    row.email
        .clone()
        .or_else(|| row.phone_number.clone())
        .or_else(|| row.display_name.clone())
        .unwrap_or_else(|| "Anonymous user".to_owned())
}

/// The quieter line: "uid · tenant acme · password, google.com".
pub(crate) fn detail(row: &UserRow) -> String {
    let mut parts = vec![row.uid.clone()];
    if let Some(tenant) = &row.tenant {
        parts.push(format!("tenant {tenant}"));
    }
    if !row.providers.is_empty() {
        parts.push(row.providers.join(", "));
    }
    if row.disabled {
        parts.push("disabled".to_owned());
    }
    parts.join(" · ")
}

impl SearchSource for UserSource {
    fn section(&self) -> &'static str {
        "auth"
    }

    fn search(&self, text: &str, limit: usize, cancel: &AtomicBool) -> SourceHits {
        let started = Instant::now();
        let stop = || cancel.load(Ordering::Relaxed) || started.elapsed() > SCAN_TIME;
        let Ok(found) = self.runtime.search_users(
            &self.project,
            &SearchScope::Every,
            text,
            limit,
            SEARCH_BUDGET,
            &stop,
        ) else {
            return SourceHits::default();
        };
        SourceHits {
            hits: found
                .users
                .iter()
                .map(|user| {
                    let entity = EntityRef::auth_user(user.row.tenant.as_deref(), &user.row.uid);
                    SearchHit {
                        kind: entity.kind,
                        key: entity.key,
                        title: title(&user.row),
                        detail: Some(detail(&user.row)),
                    }
                })
                .collect(),
            partial: found.exhausted,
        }
    }
}
