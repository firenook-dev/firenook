//! Exporting users as a point in time.
//!
//! [`Runtime::export`] takes one snapshot of a scope's accounts and index
//! under the lock — O(1), the maps are `im` — and the file is then written
//! from it outside the lock, chunk by chunk, so the export is a consistent
//! point in time and never holds the lock while it streams. JSON is the
//! emulator's own export shape (`{"kind":
//! "identitytoolkit#DownloadAccountResponse","users":[…]}`); CSV has one row
//! per user.

use std::sync::Arc;

use im::OrdMap;
use serde_json::Value as JsonValue;

use super::filter::UserFilter;
use super::index::IndexSnapshot;
use super::{ConsoleError, find_scope, millis_field};
use crate::state::{UserRecord, provider_infos};
use crate::util::{iso_from_millis, str_field, truthy};
use crate::{Runtime, lock};

/// Users one written chunk holds.
pub const EXPORT_CHUNK: usize = 2_000;
/// The CSV header.
pub const CSV_HEADER: &str = "uid,email,emailVerified,phoneNumber,displayName,photoUrl,providers,disabled,createdAt,lastSignInAt,customClaims";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExportFormat {
    Json,
    Csv,
}

impl ExportFormat {
    /// The file extension.
    #[must_use]
    pub const fn extension(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Csv => "csv",
        }
    }
}

/// Which users an export holds.
#[derive(Clone, Debug, PartialEq)]
pub enum ExportSelection {
    /// Every user the filter matches (every user for an empty filter), in
    /// uid order.
    Filter(Box<UserFilter>),
    /// These users, in this order (those that exist).
    Uids(Vec<String>),
}

/// An export being written: the snapshot and how far it got.
pub struct ExportStream {
    users: OrdMap<String, Arc<UserRecord>>,
    uids: Vec<Arc<str>>,
    format: ExportFormat,
    position: usize,
    started: bool,
    finished: bool,
}

impl std::fmt::Debug for ExportStream {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExportStream")
            .field("users", &self.uids.len())
            .field("position", &self.position)
            .finish_non_exhaustive()
    }
}

impl Runtime {
    /// An export of `project`'s users (or its `tenant`'s), as they are now.
    /// The lock is held only to clone the snapshot.
    pub fn export(
        &self,
        project: &str,
        tenant: Option<&str>,
        selection: &ExportSelection,
        format: ExportFormat,
    ) -> Result<ExportStream, ConsoleError> {
        let tenant = tenant.filter(|tenant| !tenant.is_empty());
        let (users, index) = {
            let data = lock(&self.inner.data);
            match find_scope(&data, project, tenant)? {
                Some(scope) => (scope.users.clone(), scope.user_index().snapshot()),
                None => (OrdMap::new(), IndexSnapshot::empty()),
            }
        };
        let uids = match selection {
            ExportSelection::Filter(filter) => index.matching_uids(filter),
            ExportSelection::Uids(uids) => uids
                .iter()
                .filter(|uid| users.contains_key(uid.as_str()))
                .map(|uid| Arc::from(uid.as_str()))
                .collect(),
        };
        Ok(ExportStream {
            users,
            uids,
            format,
            position: 0,
            started: false,
            finished: false,
        })
    }
}

impl ExportStream {
    /// Users the file holds.
    #[must_use]
    pub fn len(&self) -> usize {
        self.uids.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.uids.is_empty()
    }

    /// The next part of the file, holding at most `users` users; `None`
    /// once the file is complete.
    pub fn next_chunk(&mut self, users: usize) -> Option<Vec<u8>> {
        if self.finished {
            return None;
        }
        let mut out = Vec::with_capacity(users.max(1) * 256);
        if !self.started {
            self.started = true;
            match self.format {
                ExportFormat::Json => out.extend_from_slice(
                    br#"{"kind":"identitytoolkit#DownloadAccountResponse","users":["#,
                ),
                ExportFormat::Csv => {
                    out.extend_from_slice(CSV_HEADER.as_bytes());
                    out.extend_from_slice(b"\r\n");
                }
            }
        }
        let end = (self.position + users.max(1)).min(self.uids.len());
        for index in self.position..end {
            let Some(user) = self.users.get(&*self.uids[index]) else {
                continue;
            };
            match self.format {
                ExportFormat::Json => {
                    if index > 0 {
                        out.push(b',');
                    }
                    // The stored record serializes; a map of JSON values cannot fail.
                    if let Ok(bytes) = serde_json::to_vec(&**user) {
                        out.extend_from_slice(&bytes);
                    }
                }
                ExportFormat::Csv => {
                    csv_row(&mut out, user);
                }
            }
        }
        self.position = end;
        if self.position >= self.uids.len() {
            self.finished = true;
            if self.format == ExportFormat::Json {
                out.extend_from_slice(b"]}");
            }
        }
        Some(out)
    }
}

/// One CSV row: times ISO 8601, providers `;`-joined, claims compact JSON,
/// RFC 4180 quoting.
fn csv_row(out: &mut Vec<u8>, user: &UserRecord) {
    let text = |field: &str| str_field(user, field).unwrap_or_default().to_owned();
    let time = |field: &str| {
        millis_field(user, field)
            .map(iso_from_millis)
            .unwrap_or_default()
    };
    let providers: Vec<String> = provider_infos(user)
        .iter()
        .filter_map(|info| str_field(info, "providerId").map(str::to_owned))
        .collect();
    let claims = str_field(user, "customAttributes")
        .and_then(|claims| serde_json::from_str::<JsonValue>(claims).ok())
        .map(|claims| claims.to_string())
        .unwrap_or_default();
    let cells = [
        text("localId"),
        text("email"),
        truthy(user.get("emailVerified")).to_string(),
        text("phoneNumber"),
        text("displayName"),
        text("photoUrl"),
        providers.join(";"),
        truthy(user.get("disabled")).to_string(),
        time("createdAt"),
        time("lastLoginAt"),
        claims,
    ];
    for (index, cell) in cells.iter().enumerate() {
        if index > 0 {
            out.push(b',');
        }
        if cell.contains([',', '"', '\r', '\n']) {
            out.push(b'"');
            out.extend_from_slice(cell.replace('"', "\"\"").as_bytes());
            out.push(b'"');
        } else {
            out.extend_from_slice(cell.as_bytes());
        }
    }
    out.extend_from_slice(b"\r\n");
}

#[cfg(test)]
#[path = "export_tests.rs"]
mod tests;
