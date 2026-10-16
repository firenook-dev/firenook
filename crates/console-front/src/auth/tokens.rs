//! `POST /auth/tokens`: the tokens a sign-in of an existing Auth user would
//! produce, minted by the Auth emulator itself (auth-front's
//! `Runtime::mint`, over its own token code), so the ID token is exactly
//! what the app would hold. No sign-in is recorded and the account is not
//! changed. A draft of custom claims, the provider, the second factor, and
//! whether beforeSignIn runs may be chosen; the answer says how the token
//! differs from a real sign-in's.
//!
//! The foundation's identity pickers send `{uid, tenant?}` and read
//! `idToken` and `expiresAt`, which keep their meaning.

use axum::Json;
use axum::extract::{Query, State};
use firenook_auth_front::console::ConsoleErrorKind;
use firenook_auth_front::console::mint::MintRequest;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::routes::{AuthRoutes, console_error};
use super::wire::{AuthMintFactor, AuthMintedToken};
use crate::api_error::ApiError;
use crate::json::ConsoleJson;

/// Who to mint a token for, and how.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "auth/")]
pub struct AuthTokenRequest {
    pub uid: String,
    /// The account's tenant; absent for the project's users.
    #[serde(default)]
    #[ts(optional)]
    pub tenant: Option<String>,
    /// The provider the token says was used; the account's own when absent.
    #[serde(default)]
    #[ts(optional)]
    pub provider: Option<String>,
    /// Custom claims to mint with instead of the stored ones: a draft, in
    /// this token only. `{}` mints with none.
    #[serde(default)]
    #[ts(optional, type = "Record<string, unknown>")]
    pub claims: Option<serde_json::Map<String, serde_json::Value>>,
    /// The second factor; absent: the account's first enrolled one.
    #[serde(default)]
    #[ts(optional)]
    pub second_factor: Option<AuthMintFactor>,
    /// Call beforeSignIn as a sign-in would and put what it returns in the
    /// token. The account is not changed; the function's own side effects
    /// happen.
    #[serde(default)]
    #[ts(optional)]
    pub run_before_sign_in: Option<bool>,
}

/// An ID token the Auth emulator issued: what an identity picker reads of
/// [`AuthMintedToken`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthToken {
    pub id_token: String,
    /// When the token stops being accepted, RFC 3339.
    pub expires_at: String,
}

/// `?project=`.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TokenParams {
    #[serde(default)]
    project: Option<String>,
}

pub(crate) async fn mint(
    State(state): State<AuthRoutes>,
    Query(params): Query<TokenParams>,
    ConsoleJson(request): ConsoleJson<AuthTokenRequest>,
) -> Result<Json<AuthMintedToken>, ApiError> {
    let runtime = state.console.runtime.clone();
    let project = params
        .project
        .filter(|project| !project.is_empty())
        .unwrap_or_else(|| runtime.default_project().to_owned());
    let tenant = request.tenant.filter(|tenant| !tenant.is_empty());
    // An unknown tenant is said as such (and nothing is created).
    if let Some(tenant) = tenant.as_deref() {
        let known = runtime.read(|data| {
            data.projects
                .get(&project)
                .is_some_and(|agent| agent.tenants.contains_key(tenant))
        });
        if !known {
            return Err(ApiError::not_found(format!(
                "This project has no tenant named {tenant}."
            )));
        }
    }
    let uid = request.uid.clone();
    let minted = runtime
        .mint(
            &project,
            tenant.as_deref(),
            MintRequest {
                uid: request.uid,
                provider: request.provider,
                claims: request.claims,
                second_factor: request.second_factor.map(Into::into),
                run_before_sign_in: request.run_before_sign_in.unwrap_or(false),
            },
        )
        .await;
    match minted {
        Ok(token) => Ok(Json(token.into())),
        Err(error)
            if error.kind == ConsoleErrorKind::NotFound
                && !error.message.contains("second factor") =>
        {
            let place = tenant.as_deref().map_or_else(
                || "this project".to_owned(),
                |tenant| format!("tenant {tenant}"),
            );
            Err(ApiError::not_found(format!(
                "The Auth emulator has no user {uid} in {place}."
            )))
        }
        Err(error) => Err(console_error(error)),
    }
}
