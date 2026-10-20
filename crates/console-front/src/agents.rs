//! When a coding agent last called: the beacon `firenook mcp` posts after
//! each tool call, and what the Connect dialog's "Coding agent" tab reads.
//!
//! - `POST /agents/calls` with `{"client": "firenook-mcp/0.2.0-next.7",
//!   "tool": "firestore_query"}` records one call and answers 204. The MCP
//!   server sends it fire-and-forget from Node: JSON, no `Origin`, no
//!   `Sec-Fetch-Site`, which the request guard lets through like any other
//!   JSON change. Fields other than these two are ignored, so a newer
//!   server can say more to an older engine.
//! - `GET /agents` answers the last call (`null` before the first) and how
//!   many calls arrived since the engine started.
//!
//! Held in memory only, one value and one counter: a restart forgets it,
//! and nothing a client sends can make it grow.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::json::ConsoleJson;

/// The longest `client` or `tool`, in characters.
const MAX_CHARS: usize = 64;

/// One call a coding agent made through the MCP server.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCall {
    /// When the beacon arrived: RFC 3339, UTC, to the millisecond.
    pub(crate) at: String,
    /// The MCP server that called, with its version: `firenook-mcp/0.2.0-next.7`.
    pub(crate) client: String,
    /// The tool the agent called: `firestore_query`.
    pub(crate) tool: String,
}

/// `GET /agents`: the last call and how many there were.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentActivity {
    /// The newest call; `null` until an agent has called.
    pub(crate) last_call: Option<AgentCall>,
    /// Calls since the engine started.
    #[ts(type = "number")]
    pub(crate) calls: u64,
}

/// `POST /agents/calls`: what the MCP server says after a tool call. Each
/// field is 1 to 64 characters from `A-Z a-z 0-9 . _ / @ : + -` and space.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCallBody {
    pub(crate) client: String,
    pub(crate) tool: String,
}

/// The beacon's state: cheap to clone, shared by both routes.
#[derive(Clone, Default)]
pub(crate) struct AgentBeacon {
    inner: Arc<Mutex<AgentActivity>>,
}

impl AgentBeacon {
    fn activity(&self) -> MutexGuard<'_, AgentActivity> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Records one call, stamped now.
    fn record(&self, client: String, tool: String) {
        let at = millis(OffsetDateTime::now_utc());
        let mut activity = self.activity();
        activity.calls = activity.calls.saturating_add(1);
        activity.last_call = Some(AgentCall { at, client, tool });
    }

    /// The last call and the count, as they are now.
    fn snapshot(&self) -> AgentActivity {
        self.activity().clone()
    }

    /// `GET /agents` and `POST /agents/calls`.
    pub(crate) fn router(&self) -> Router {
        Router::new()
            .route("/agents", get(activity_route))
            .route("/agents/calls", post(call_route))
            .with_state(self.clone())
    }
}

async fn activity_route(State(beacon): State<AgentBeacon>) -> Json<AgentActivity> {
    Json(beacon.snapshot())
}

async fn call_route(
    State(beacon): State<AgentBeacon>,
    ConsoleJson(body): ConsoleJson<AgentCallBody>,
) -> Result<StatusCode, ApiError> {
    let client = checked("client", body.client)?;
    let tool = checked("tool", body.tool)?;
    beacon.record(client, tool);
    Ok(StatusCode::NO_CONTENT)
}

/// `value` when it is 1 to 64 characters of the allowed set; otherwise the
/// 400 that names the field and what it may hold.
fn checked(field: &str, value: String) -> Result<String, ApiError> {
    let allowed =
        |character: char| character.is_ascii_alphanumeric() || "._/@:+- ".contains(character);
    let length = value.chars().count();
    if (1..=MAX_CHARS).contains(&length) && value.chars().all(allowed) {
        return Ok(value);
    }
    let problem = if length == 0 {
        "is empty".to_owned()
    } else if length > MAX_CHARS {
        format!("is {length} characters long")
    } else {
        "holds a character outside A-Z, a-z, 0-9, space and . _ / @ : + -".to_owned()
    };
    Err(ApiError::invalid(format!("The call's {field} {problem}.")).with_fix(format!(
        "Send a {field} of 1 to {MAX_CHARS} characters from A-Z, a-z, 0-9, space and . _ / @ : + -."
    )))
}

/// RFC 3339 in UTC to the millisecond: `2026-10-20T09:41:07.031Z`.
fn millis(at: OffsetDateTime) -> String {
    let at = at.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond()
    )
}

/// Writes the beacon's TypeScript bindings.
#[cfg(test)]
pub(crate) fn export_bindings(config: &ts_rs::Config) {
    AgentActivity::export_all(config).expect("TypeScript bindings written");
    AgentCallBody::export_all(config).expect("TypeScript bindings written");
}

#[cfg(test)]
mod tests {
    use time::format_description::well_known::Rfc3339;

    use super::*;

    #[test]
    fn a_call_is_stamped_to_the_millisecond_in_utc() {
        let at =
            OffsetDateTime::parse("2026-10-20T17:41:07.031999+08:00", &Rfc3339).expect("a time");
        assert_eq!(millis(at), "2026-10-20T09:41:07.031Z");
        let whole = OffsetDateTime::parse("2026-01-02T03:04:05Z", &Rfc3339).expect("a time");
        assert_eq!(millis(whole), "2026-01-02T03:04:05.000Z");
        let now = millis(OffsetDateTime::now_utc());
        assert!(OffsetDateTime::parse(&now, &Rfc3339).is_ok(), "{now}");
        assert_eq!(now.len(), "2026-10-20T09:41:07.031Z".len(), "{now}");
    }

    #[test]
    fn a_field_is_one_to_sixty_four_characters_of_the_allowed_set() {
        let longest = "a".repeat(64);
        for good in [
            "firenook-mcp/0.2.0-next.7",
            "firestore_query",
            "a",
            "agent@2.1 via npx",
            "x:y+z",
            longest.as_str(),
        ] {
            assert_eq!(checked("tool", good.to_owned()).ok().as_deref(), Some(good));
        }
        let too_long = "a".repeat(65);
        for bad in [
            "",
            "tab\there",
            "naïve",
            "semi;colon",
            "quote\"",
            too_long.as_str(),
        ] {
            assert!(checked("tool", bad.to_owned()).is_err(), "{bad:?}");
        }
        let long = checked("client", "b".repeat(70)).expect_err("too long");
        assert_eq!(
            long.detail().message,
            "The call's client is 70 characters long."
        );
        assert_eq!(long.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn the_beacon_keeps_the_newest_call_and_counts_them_all() {
        let beacon = AgentBeacon::default();
        assert_eq!(beacon.snapshot(), AgentActivity::default());
        beacon.record("firenook-mcp/0.2.0-next.7".to_owned(), "status".to_owned());
        beacon.record(
            "firenook-mcp/0.2.0-next.7".to_owned(),
            "firestore_query".to_owned(),
        );
        let activity = beacon.snapshot();
        assert_eq!(activity.calls, 2);
        let last = activity.last_call.expect("a call");
        assert_eq!(last.tool, "firestore_query");
        assert_eq!(last.client, "firenook-mcp/0.2.0-next.7");
    }
}
