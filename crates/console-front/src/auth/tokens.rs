//! `POST /auth/tokens {uid, tenant?}`: an ID token for an existing Auth
//! user, minted by the Auth emulator itself (its own `issue_tokens`, with
//! the account's first provider), so the token is exactly what the app
//! would hold. No sign-in is recorded and no blocking function runs; like a
//! token refresh, it updates the account's `lastRefreshAt`. The auth stream
//! extends the request and the answer.

use axum::Json;
use axum::extract::State;
use firenook_auth_front::Runtime;
use firenook_auth_front::state::{Scope, provider_infos};
use firenook_auth_front::token::{IssueOptions, issue_tokens};
use firenook_auth_front::util::{decode_jwt, str_field};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::blocking::blocking;
use crate::json::ConsoleJson;

/// Who to mint a token for.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "auth/")]
pub struct AuthTokenRequest {
    pub uid: String,
    /// The account's tenant; absent for the project's users.
    #[serde(default)]
    #[ts(optional)]
    pub tenant: Option<String>,
}

/// An ID token the Auth emulator issued.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthToken {
    pub id_token: String,
    /// When the token stops being accepted, RFC 3339.
    pub expires_at: String,
}

pub(crate) async fn mint(
    State(runtime): State<Runtime>,
    ConsoleJson(request): ConsoleJson<AuthTokenRequest>,
) -> Result<Json<AuthToken>, ApiError> {
    blocking("minting the token", move || mint_now(&runtime, &request))
        .await
        .map(Json)
}

fn mint_now(runtime: &Runtime, request: &AuthTokenRequest) -> Result<AuthToken, ApiError> {
    let project = runtime.default_project().to_owned();
    let tenant = request
        .tenant
        .as_deref()
        .filter(|tenant| !tenant.is_empty());
    let unknown = || {
        let place = tenant.map_or_else(
            || "this project".to_owned(),
            |tenant| format!("tenant {tenant}"),
        );
        ApiError::not_found(format!(
            "The Auth emulator has no user {} in {place}.",
            request.uid
        ))
    };
    let issued = runtime
        .update(|data| {
            let Some(agent) = data.projects.get_mut(&project) else {
                return Err(unknown());
            };
            if let Some(tenant) = tenant
                && !agent.tenants.contains_key(tenant)
            {
                return Err(ApiError::not_found(format!(
                    "This project has no tenant named {tenant}."
                )));
            }
            let mut scope = Scope::new_in(agent, &project, tenant);
            let Some(user) = scope.project_ref().get_user_by_local_id(&request.uid) else {
                return Err(unknown());
            };
            let provider = provider_infos(&user)
                .first()
                .and_then(|info| str_field(info, "providerId").map(str::to_owned))
                .unwrap_or_else(|| "anonymous".to_owned());
            issue_tokens(&mut scope, &user, &provider, &IssueOptions::default()).map_err(|error| {
                ApiError::internal(format!(
                    "The Auth emulator could not issue a token: {}",
                    error.message
                ))
            })
        })
        .map_err(|error| {
            ApiError::internal(format!("The Auth state could not be saved: {error}"))
        })??;
    let expires_at = decode_jwt(&issued.id_token)
        .and_then(|(_, payload)| payload.get("exp").and_then(serde_json::Value::as_i64))
        .and_then(|exp| OffsetDateTime::from_unix_timestamp(exp).ok())
        .and_then(|exp| exp.format(&Rfc3339).ok())
        .ok_or_else(|| ApiError::internal("The Auth emulator issued a token without an expiry."))?;
    Ok(AuthToken {
        id_token: issued.id_token,
        expires_at,
    })
}
