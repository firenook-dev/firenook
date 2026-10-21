//! The Auth Console API under `/console/api/v1/auth` (the Auth emulator's
//! own application answers every other path, as the fallback).
//!
//! Every read takes the data lock only to find its scope and take an O(1)
//! snapshot (auth-front's `console` module), and runs the work on the
//! blocking pool. Bulk changes and imports are jobs. Every route takes
//! `?project=` (absent: the configured project) and creates nothing.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Body as HttpBody;
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use firenook_auth_front::console::bulk::{
    BulkAction, BulkProgress, BulkUsers, MAX_TRIGGERED_DELETES, thousands,
    triggered_delete_refusal, users_phrase,
};
use firenook_auth_front::console::export::{EXPORT_CHUNK, ExportSelection};
use firenook_auth_front::console::import::ImportOptions;
use firenook_auth_front::console::{
    ConsoleError, ConsoleErrorKind, UserColumn, UserCursor, UserSort, UsersBatchQuery, UsersQuery,
};
use firenook_auth_front::observe::CallKind;
use serde::{Deserialize, Serialize};

use super::AuthConsole;
use super::feed::{ACTIVITY_CAPACITY, ActivityEntry, MESSAGE_CAPACITY, MessageEntry};
use super::filter::{ActivityFilter, MessageFilter, USER_FIELDS, now_minute, user_filter};
use super::uploads::Uploads;
use super::wire::{
    self, AuthActivityDetail, AuthActivityFacets, AuthActivityPage, AuthBulkPreview,
    AuthBulkRequest, AuthCallKindCount, AuthCaller, AuthCallerCount, AuthClaimKeys,
    AuthDeleteUsersRequest, AuthHeader, AuthHooks, AuthImportPreview, AuthImportRequest,
    AuthMessage, AuthMessageFacets, AuthMessageKind, AuthMessageKindCount, AuthMessagePage,
    AuthRemoveClaimsRequest, AuthSetClaimsRequest, AuthSummary, AuthTenant, AuthTenantCreate,
    AuthTenantList, AuthTokenCheck, AuthTokenConsumer, AuthTokenInspectRequest,
    AuthTokenInspection, AuthUserDetail, AuthUserFacets, AuthUserRow, AuthUsersBatchGet,
    AuthUsersPage,
};
use crate::api_error::ApiError;
use crate::blocking::blocking;
use crate::http::attachment;
use crate::jobs::{BulkTarget, JobHandle, accepted};
use crate::json::ConsoleJson;
use crate::paging::{
    BatchGetItem, BatchGetRequest, BatchGetResponse, ListMeta, Page, PageQuery, decode_cursor,
    encode_cursor,
};
use crate::section::SectionContext;

/// The section's routes' state.
#[derive(Clone)]
pub(crate) struct AuthRoutes {
    pub(crate) console: AuthConsole,
    pub(crate) context: SectionContext,
    pub(crate) uploads: Uploads,
}

/// Every Auth console route; the caller adds the native fallback.
pub(crate) fn router(state: AuthRoutes) -> Router {
    Router::new()
        .route("/users", get(users))
        .route("/users/meta", get(users_meta))
        .route("/users:batchGet", post(users_batch))
        .route("/user", get(user))
        .route("/tokens", post(super::tokens::mint))
        .route("/token/inspect", post(inspect))
        .route("/claims", get(claims))
        .route("/identities", get(super::identities::search))
        .route("/users:disable", post(disable))
        .route("/users:enable", post(enable))
        .route("/users:verify", post(verify))
        .route("/users:revoke", post(revoke))
        .route("/users:setClaims", post(set_claims))
        .route("/users:removeClaims", post(remove_claims))
        .route("/users:delete", post(delete_users))
        .route("/imports", post(upload))
        .route("/imports/{import_id}", delete(discard_upload))
        .route("/users:import", post(import_users))
        .route("/users:export", get(export_users))
        .route("/messages", get(messages).delete(clear_messages))
        .route("/messages/{id}", get(message))
        .route("/activity", get(activity).delete(clear_activity))
        .route("/activity/{id}", get(activity_entry))
        .route("/tenants", get(tenants).post(create_tenant))
        .route("/tenants:batchGet", post(tenants_batch))
        .route("/hooks", get(hooks))
        .route("/summary", get(summary))
        .with_state(state)
}

// ---------------------------------------------------------------- shared

/// An engine refusal as the console's error.
pub(crate) fn console_error(error: ConsoleError) -> ApiError {
    let base = match error.kind {
        ConsoleErrorKind::NotFound => ApiError::not_found(error.message),
        ConsoleErrorKind::InvalidArgument => ApiError::invalid(error.message),
        ConsoleErrorKind::AlreadyExists => ApiError::already_exists(error.message),
        ConsoleErrorKind::FailedPrecondition => ApiError::precondition(error.message),
        ConsoleErrorKind::Internal => ApiError::internal(error.message),
    };
    match error.fix {
        Some(fix) => base.with_fix(fix),
        None => base,
    }
}

/// The project a request names: absent or empty is the configured one.
fn project_of(state: &AuthRoutes, project: Option<&String>) -> String {
    project
        .filter(|project| !project.is_empty())
        .cloned()
        .unwrap_or_else(|| state.console.runtime.default_project().to_owned())
}

/// A users scope: a tenant id; absent, empty, `(all)` or `(none)` is the
/// project's own users.
fn users_tenant(tenant: Option<&String>) -> Option<String> {
    tenant
        .filter(|tenant| !tenant.is_empty() && !matches!(tenant.as_str(), "(all)" | "(none)"))
        .cloned()
}

/// A body of no arguments: `{}`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

/// The project alone.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectParams {
    #[serde(default)]
    project: Option<String>,
}

/// The project and a users scope.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScopeParams {
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    tenant: Option<String>,
}

const fn sortable() -> [&'static str; 6] {
    [
        UserColumn::Created.as_str(),
        UserColumn::SignedIn.as_str(),
        UserColumn::Email.as_str(),
        UserColumn::Name.as_str(),
        UserColumn::Phone.as_str(),
        UserColumn::Uid.as_str(),
    ]
}

fn users_list_meta() -> ListMeta {
    ListMeta {
        sortable: sortable()
            .iter()
            .map(|column| (*column).to_owned())
            .collect(),
        default_sort: UserSort::default().to_string(),
        fields: USER_FIELDS.infos(),
    }
}

/// `sort` checked against the sortable columns, as every list checks it.
fn user_sort(sort: Option<&str>) -> Result<UserSort, ApiError> {
    let query = PageQuery {
        sort: sort.map(str::to_owned),
        ..PageQuery::default()
    };
    match query.sort(&users_list_meta())? {
        None => Ok(UserSort::default()),
        Some((column, direction)) => {
            let direction = match direction {
                crate::paging::Direction::Asc => "asc",
                crate::paging::Direction::Desc => "desc",
            };
            UserSort::parse(&format!("{column}:{direction}")).ok_or_else(|| {
                ApiError::invalid(format!("This list cannot be sorted by {column}."))
            })
        }
    }
}

fn limit_of(limit: Option<u32>) -> usize {
    usize::try_from(limit.unwrap_or(100).clamp(1, 500)).unwrap_or(100)
}

// ---------------------------------------------------------------- users

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct UsersParams {
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    tenant: Option<String>,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    sort: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

/// `GET /users`.
async fn users(
    State(state): State<AuthRoutes>,
    Query(params): Query<UsersParams>,
) -> Result<Json<AuthUsersPage>, ApiError> {
    let project = project_of(&state, params.project.as_ref());
    let tenant = users_tenant(params.tenant.as_ref());
    let filter = user_filter(params.q.as_deref().unwrap_or_default(), now_minute())?;
    let sort = user_sort(params.sort.as_deref())?;
    if params.cursor.is_some() && params.before.is_some() {
        return Err(ApiError::invalid(
            "A page is read after `cursor` or before `before`, not both.",
        ));
    }
    let cursor = params
        .cursor
        .as_deref()
        .map(decode_cursor::<UserCursor>)
        .transpose()?;
    let before = params
        .before
        .as_deref()
        .map(decode_cursor::<UserCursor>)
        .transpose()?;
    let view = state
        .console
        .runtime
        .users(&project, tenant.as_deref())
        .map_err(console_error)?;
    let query = UsersQuery {
        filter,
        sort,
        cursor,
        before,
        limit: limit_of(params.limit),
    };
    let page = blocking("the users query", move || {
        view.page(&query).map_err(console_error)
    })
    .await?;
    Ok(Json(AuthUsersPage {
        page: Page {
            items: page.rows.into_iter().map(AuthUserRow::from).collect(),
            next_cursor: page.next.as_ref().map(encode_cursor),
            prev_cursor: page.prev.as_ref().map(encode_cursor),
            total: page.total.map(wire::exact),
            scanned: None,
        },
        facets: page.facets.map(AuthUserFacets::from),
        scope_total: page.scope_total,
        took_micros: u64::try_from(page.took.as_micros()).unwrap_or(u64::MAX),
    }))
}

/// `GET /users/meta`.
async fn users_meta() -> Json<ListMeta> {
    Json(users_list_meta())
}

/// `POST /users:batchGet?tenant=`.
async fn users_batch(
    State(state): State<AuthRoutes>,
    Query(params): Query<ScopeParams>,
    ConsoleJson(request): ConsoleJson<BatchGetRequest>,
) -> Result<Json<AuthUsersBatchGet>, ApiError> {
    request.check()?;
    let project = project_of(&state, params.project.as_ref());
    let tenant = users_tenant(params.tenant.as_ref());
    let filter = user_filter(request.q.as_deref().unwrap_or_default(), now_minute())?;
    let sort = user_sort(request.sort.as_deref())?;
    let (page_starts, window_end) = request.window::<UserCursor>()?;
    let view = state
        .console
        .runtime
        .users(&project, tenant.as_deref())
        .map_err(console_error)?;
    let query = UsersBatchQuery {
        uids: request.keys,
        filter,
        sort,
        page_starts,
        window_end,
    };
    let batch = blocking("the users batch read", move || {
        view.batch(&query).map_err(console_error)
    })
    .await?;
    Ok(Json(AuthUsersBatchGet {
        rows: BatchGetResponse {
            items: batch
                .items
                .into_iter()
                .map(|item| BatchGetItem {
                    key: item.uid,
                    row: item.row.map(AuthUserRow::from),
                    page: item.page,
                })
                .collect(),
        },
        total: wire::exact(batch.total),
        facets: batch.facets.into(),
        scope_total: batch.scope_total,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UserParams {
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    tenant: Option<String>,
    uid: String,
}

/// `GET /user?tenant=&uid=`.
async fn user(
    State(state): State<AuthRoutes>,
    Query(params): Query<UserParams>,
) -> Result<Json<AuthUserDetail>, ApiError> {
    let project = project_of(&state, params.project.as_ref());
    let tenant = users_tenant(params.tenant.as_ref());
    let runtime = state.console.runtime.clone();
    blocking("reading the user", move || {
        runtime
            .user(&project, tenant.as_deref(), &params.uid)
            .map(AuthUserDetail::from)
            .map_err(console_error)
    })
    .await
    .map(Json)
}

/// `GET /claims?tenant=`.
async fn claims(
    State(state): State<AuthRoutes>,
    Query(params): Query<ScopeParams>,
) -> Result<Json<AuthClaimKeys>, ApiError> {
    let project = project_of(&state, params.project.as_ref());
    let tenant = users_tenant(params.tenant.as_ref());
    let view = state
        .console
        .runtime
        .users(&project, tenant.as_deref())
        .map_err(console_error)?;
    blocking("the claim keys", move || {
        Ok(AuthClaimKeys::from(view.claim_keys()))
    })
    .await
    .map(Json)
}

// ---------------------------------------------------------------- inspection

/// `POST /token/inspect`: judges a pasted token; changes nothing.
async fn inspect(
    State(state): State<AuthRoutes>,
    Query(params): Query<ProjectParams>,
    ConsoleJson(request): ConsoleJson<AuthTokenInspectRequest>,
) -> Result<Json<AuthTokenInspection>, ApiError> {
    let project = project_of(&state, params.project.as_ref());
    let runtime = state.console.runtime.clone();
    blocking("the token inspection", move || {
        let inspection = runtime.inspect_token(&project, &request.token);
        let mut answer = AuthTokenInspection::from(inspection);
        answer
            .checks
            .insert(0, rules_check(&project, &request.token, &answer));
        Ok(answer)
    })
    .await
    .map(Json)
}

fn span(seconds: i64) -> String {
    let seconds = seconds.unsigned_abs();
    match seconds {
        0..60 => format!("{seconds} s"),
        60..3_600 => format!("{} min", seconds / 60),
        3_600..86_400 => format!("{} h", seconds / 3_600),
        _ => format!("{} days", seconds / 86_400),
    }
}

fn clock(seconds: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp(seconds).map_or_else(
        |_| seconds.to_string(),
        |at| format!("{:02}:{:02}:{:02} UTC", at.hour(), at.minute(), at.second()),
    )
}

fn rules_fail(reason: String, fix: &str) -> AuthTokenCheck {
    AuthTokenCheck {
        consumer: AuthTokenConsumer::Rules,
        ok: false,
        reason: Some(reason),
        fix: Some(fix.to_owned()),
    }
}

/// What the rules make of a token before reading it: not an ID token.
fn rules_refusal(inspection: &AuthTokenInspection) -> Option<AuthTokenCheck> {
    match inspection.kind {
        wire::AuthTokenKind::CustomToken => Some(rules_fail(
            "The rules take an ID token; this is a custom token.".to_owned(),
            "Exchange it for an ID token with signInWithCustomToken first.",
        )),
        wire::AuthTokenKind::RefreshToken => Some(rules_fail(
            "The rules take an ID token; this is a refresh token.".to_owned(),
            "Exchange it for an ID token with the refresh grant first.",
        )),
        wire::AuthTokenKind::SessionCookie => Some(rules_fail(
            "A session cookie is not an ID token: the client never sends one to Firestore."
                .to_owned(),
            "Send the ID token from the client instead.",
        )),
        wire::AuthTokenKind::Unknown if inspection.payload.is_none() => Some(rules_fail(
            "This is not a token the rules can read.".to_owned(),
            "Paste the ID token the app sends (user.getIdToken()).",
        )),
        _ => None,
    }
}

/// What Firestore and Storage rules make of the token: the rules runtime's
/// own reading, in words. The rules read a token's claims and check none of
/// them, as the official emulator does, so a token they can read is
/// accepted; the reason adds when production would refuse it anyway.
fn rules_check(project: &str, token: &str, inspection: &AuthTokenInspection) -> AuthTokenCheck {
    use firenook_rules_runtime::Authorization;
    if let Some(refusal) = rules_refusal(inspection) {
        return refusal;
    }
    let token = token.trim();
    let token = token
        .strip_prefix("Bearer ")
        .or_else(|| token.strip_prefix("bearer "))
        .unwrap_or(token)
        .trim();
    let Ok(Authorization::Client(Some(auth))) =
        Authorization::parse(Some(&format!("Bearer {token}")))
    else {
        return rules_fail(
            "This is not a token the rules can read: Firestore answers 400 (invalid jwt)."
                .to_owned(),
            "Paste the ID token the app sends (user.getIdToken()).",
        );
    };
    let sees = auth.uid.as_ref().map_or_else(
        || "The rules see request.auth with a null uid (the token has no string `sub`) and the token's claims.".to_owned(),
        |uid| format!("The rules see request.auth with uid `{uid}` and the token's claims."),
    );
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let payload = inspection.payload.as_ref();
    let number = |key: &str| {
        payload
            .and_then(|payload| payload.get(key))
            .and_then(serde_json::Value::as_i64)
    };
    let audience = payload
        .and_then(|payload| payload.get("aud"))
        .and_then(serde_json::Value::as_str)
        .filter(|audience| *audience != project);
    let refused = match (number("exp"), number("iat")) {
        (Some(exp), _) if exp <= now => Some(format!(
            "It expired {} ago (exp {})",
            span(now - exp),
            clock(exp)
        )),
        (_, Some(iat)) if iat > now => Some(format!(
            "It is issued {} in the future (iat {})",
            span(iat - now),
            clock(iat)
        )),
        _ => audience.map(|audience| {
            format!("It is for project `{audience}`; the emulator runs `{project}`")
        }),
    };
    let reason = match refused {
        Some(refused) => format!(
            "{sees} {refused}: the rules read it anyway, as the official emulator does; production refuses it."
        ),
        None if inspection.signed => format!(
            "{sees} It is signed by production Firebase: the rules read its claims without checking the signature, as the official emulator does."
        ),
        None => sees,
    };
    AuthTokenCheck {
        consumer: AuthTokenConsumer::Rules,
        ok: true,
        reason: Some(reason),
        fix: None,
    }
}

// ---------------------------------------------------------------- bulk

/// Reports bulk work to its job.
pub(crate) struct JobProgress(pub(crate) JobHandle);

impl BulkProgress for JobProgress {
    fn total(&self, total: u64) {
        self.0.set_total(total);
    }

    fn progress(&self, done: u64) {
        self.0.progress(done);
    }

    fn skipped(&self, by: u64) {
        self.0.skipped(by);
    }

    fn failed(&self, key: &str, message: &str) {
        self.0.failed_item(key, message);
    }

    fn cancelled(&self) -> bool {
        self.0.cancelled()
    }
}

/// A query target's scope: the users list's own params.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryScope {
    #[serde(default)]
    tenant: Option<String>,
}

/// The users a bulk target names.
fn bulk_users(target: &BulkTarget) -> Result<BulkUsers, ApiError> {
    target.check()?;
    match target {
        BulkTarget::Keys { keys } => keys
            .iter()
            .map(|key| {
                key.split_once('|')
                    .map(|(tenant, uid)| {
                        (
                            Some(tenant.to_owned()).filter(|tenant| !tenant.is_empty()),
                            uid.to_owned(),
                        )
                    })
                    .filter(|(_, uid)| !uid.is_empty())
                    .ok_or_else(|| {
                        ApiError::invalid(format!(
                            "`{key}` is not a user key; a key is <tenant>|<uid>, the tenant empty for the project's users."
                        ))
                    })
            })
            .collect::<Result<Vec<_>, _>>()
            .map(BulkUsers::Keys),
        BulkTarget::Query { q, scope } => {
            let scope: QueryScope = match scope {
                serde_json::Value::Null => QueryScope::default(),
                other => serde_json::from_value(other.clone()).map_err(|error| {
                    ApiError::invalid(format!("This scope is not the users list's: {error}."))
                })?,
            };
            Ok(BulkUsers::Query {
                tenant: users_tenant(scope.tenant.as_ref()),
                filter: Box::new(user_filter(q, now_minute())?),
            })
        }
    }
}

/// A dry run, or a job doing `action` to `target`.
async fn bulk(
    state: AuthRoutes,
    project: String,
    target: &BulkTarget,
    action: BulkAction,
    kind: &'static str,
    dry_run: bool,
) -> Result<Response, ApiError> {
    let users = Arc::new(bulk_users(target)?);
    let runtime = state.console.runtime.clone();
    if dry_run {
        let (users, action) = (users.clone(), action.clone());
        let preview = blocking("the bulk preview", move || {
            runtime
                .bulk_preview(&project, &users, &action)
                .map_err(console_error)
        })
        .await?;
        return Ok(Json(AuthBulkPreview::from(preview)).into_response());
    }
    let total = {
        let (runtime, users, project) = (runtime.clone(), users.clone(), project.clone());
        blocking("counting the users", move || {
            runtime.bulk_count(&project, &users).map_err(console_error)
        })
        .await?
    };
    if matches!(action, BulkAction::Delete { triggers: true })
        && total > u64::try_from(MAX_TRIGGERED_DELETES).unwrap_or(u64::MAX)
    {
        return Err(console_error(triggered_delete_refusal()));
    }
    let title = format!(
        "{} {}",
        action.title(),
        users_phrase(usize::try_from(total).unwrap_or(usize::MAX))
    );
    let job = state
        .context
        .jobs
        .start("auth", kind, title, Some(total), move |handle| {
            Box::pin(async move {
                blocking("the bulk action", move || {
                    runtime
                        .bulk_apply(&project, &users, &action, &JobProgress(handle))
                        .map(|_| ())
                        .map_err(console_error)
                })
                .await
            })
        })?;
    Ok(accepted(job))
}

async fn disable(
    State(state): State<AuthRoutes>,
    Query(params): Query<ProjectParams>,
    ConsoleJson(request): ConsoleJson<AuthBulkRequest>,
) -> Result<Response, ApiError> {
    let project = project_of(&state, params.project.as_ref());
    bulk(
        state,
        project,
        &request.target,
        BulkAction::Disable,
        "auth.disable",
        request.dry_run,
    )
    .await
}

async fn enable(
    State(state): State<AuthRoutes>,
    Query(params): Query<ProjectParams>,
    ConsoleJson(request): ConsoleJson<AuthBulkRequest>,
) -> Result<Response, ApiError> {
    let project = project_of(&state, params.project.as_ref());
    bulk(
        state,
        project,
        &request.target,
        BulkAction::Enable,
        "auth.enable",
        request.dry_run,
    )
    .await
}

async fn verify(
    State(state): State<AuthRoutes>,
    Query(params): Query<ProjectParams>,
    ConsoleJson(request): ConsoleJson<AuthBulkRequest>,
) -> Result<Response, ApiError> {
    let project = project_of(&state, params.project.as_ref());
    bulk(
        state,
        project,
        &request.target,
        BulkAction::Verify,
        "auth.verify",
        request.dry_run,
    )
    .await
}

async fn revoke(
    State(state): State<AuthRoutes>,
    Query(params): Query<ProjectParams>,
    ConsoleJson(request): ConsoleJson<AuthBulkRequest>,
) -> Result<Response, ApiError> {
    let project = project_of(&state, params.project.as_ref());
    bulk(
        state,
        project,
        &request.target,
        BulkAction::Revoke,
        "auth.revoke",
        request.dry_run,
    )
    .await
}

async fn set_claims(
    State(state): State<AuthRoutes>,
    Query(params): Query<ProjectParams>,
    ConsoleJson(request): ConsoleJson<AuthSetClaimsRequest>,
) -> Result<Response, ApiError> {
    let project = project_of(&state, params.project.as_ref());
    let action = BulkAction::SetClaims {
        claims: request.claims,
        mode: request.mode.into(),
    };
    bulk(
        state,
        project,
        &request.target,
        action,
        "auth.set-claims",
        request.dry_run,
    )
    .await
}

async fn remove_claims(
    State(state): State<AuthRoutes>,
    Query(params): Query<ProjectParams>,
    ConsoleJson(request): ConsoleJson<AuthRemoveClaimsRequest>,
) -> Result<Response, ApiError> {
    let project = project_of(&state, params.project.as_ref());
    if request.keys.is_empty() {
        return Err(ApiError::invalid("Name at least one claim key to remove."));
    }
    let action = BulkAction::RemoveClaims { keys: request.keys };
    bulk(
        state,
        project,
        &request.target,
        action,
        "auth.remove-claims",
        request.dry_run,
    )
    .await
}

async fn delete_users(
    State(state): State<AuthRoutes>,
    Query(params): Query<ProjectParams>,
    ConsoleJson(request): ConsoleJson<AuthDeleteUsersRequest>,
) -> Result<Response, ApiError> {
    let project = project_of(&state, params.project.as_ref());
    let action = BulkAction::Delete {
        triggers: request.triggers,
    };
    bulk(
        state,
        project,
        &request.target,
        action,
        "auth.delete",
        request.dry_run,
    )
    .await
}

// ---------------------------------------------------------------- import

/// `POST /imports?tenant=`: the file as the body (`application/json`),
/// streamed to disk and read once for the preview.
async fn upload(
    State(state): State<AuthRoutes>,
    Query(params): Query<ScopeParams>,
    request: Request,
) -> Result<Json<AuthImportPreview>, ApiError> {
    let is_json = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/json"));
    if !is_json {
        return Err(ApiError::media_type("Upload the file as application/json.")
            .with_fix("Send the file with content-type: application/json."));
    }
    let project = project_of(&state, params.project.as_ref());
    let tenant = users_tenant(params.tenant.as_ref());
    // An unknown tenant is refused before the file is read.
    state
        .console
        .runtime
        .users(&project, tenant.as_deref())
        .map_err(console_error)?;
    let upload = state
        .uploads
        .receive(request.into_body(), &project, tenant.as_deref())
        .await?;
    let runtime = state.console.runtime.clone();
    let path = upload.path.clone();
    let options = ImportOptions {
        mode: firenook_auth_front::console::import::ImportMode::Skip,
        replace_password: None,
    };
    let preview = blocking("reading the upload", move || {
        runtime
            .import_preview(&project, tenant.as_deref(), &path, &options)
            .map_err(console_error)
    })
    .await;
    match preview {
        Ok(preview) => {
            state.uploads.set_total(&upload.id, preview.total);
            Ok(Json(AuthImportPreview::of(upload.id, preview)))
        }
        Err(error) => {
            state.uploads.discard(&upload.id);
            Err(error)
        }
    }
}

/// `DELETE /imports/{importId}`.
async fn discard_upload(
    State(state): State<AuthRoutes>,
    Path(import_id): Path<String>,
    ConsoleJson(Empty {}): ConsoleJson<Empty>,
) -> StatusCode {
    state.uploads.discard(&import_id);
    StatusCode::NO_CONTENT
}

/// `POST /users:import`: a kept upload, previewed with the options, or
/// imported as a job.
async fn import_users(
    State(state): State<AuthRoutes>,
    ConsoleJson(request): ConsoleJson<AuthImportRequest>,
) -> Result<Response, ApiError> {
    let upload = state.uploads.get(&request.import_id)?;
    let options = ImportOptions {
        mode: request.mode.into(),
        replace_password: request
            .replace_password
            .filter(|password| !password.is_empty()),
    };
    let runtime = state.console.runtime.clone();
    if request.dry_run {
        let (project, tenant, path) = (
            upload.project.clone(),
            upload.tenant.clone(),
            upload.path.clone(),
        );
        let preview = blocking("reading the upload", move || {
            runtime
                .import_preview(&project, tenant.as_deref(), &path, &options)
                .map_err(console_error)
        })
        .await?;
        return Ok(Json(AuthImportPreview::of(upload.id, preview)).into_response());
    }
    let total = upload.total;
    let title = format!(
        "Import {}",
        users_phrase(usize::try_from(total.unwrap_or_default()).unwrap_or(usize::MAX))
    );
    let uploads = state.uploads.clone();
    let job = state
        .context
        .jobs
        .start("auth", "auth.import", title, total, move |handle| {
            Box::pin(async move {
                // Out of the kept list, so the sweeper leaves the file alone
                // while the import reads it.
                let upload = uploads.claim(&upload.id).unwrap_or(upload);
                blocking("the import", move || {
                    let imported = runtime
                        .import_commit(
                            &upload.project,
                            upload.tenant.as_deref(),
                            &upload.path,
                            &options,
                            &JobProgress(handle),
                        )
                        .map(|_| ())
                        .map_err(console_error);
                    Uploads::finished(&upload);
                    imported
                })
                .await
            })
        })?;
    Ok(accepted(job))
}

// ---------------------------------------------------------------- export

/// `GET /users:export?tenant=&format=json|csv&q=` or with repeated `uid=`
/// (at most 500): one snapshot, streamed in chunks of 2,000 users; the body
/// stops between chunks when the suite stops.
async fn export_users(
    State(state): State<AuthRoutes>,
    Query(pairs): Query<Vec<(String, String)>>,
) -> Result<Response, ApiError> {
    let mut project = None;
    let mut tenant = None;
    let mut format = None;
    let mut q = None;
    let mut uids = Vec::new();
    for (key, value) in pairs {
        match key.as_str() {
            "project" => project = Some(value),
            "tenant" => tenant = Some(value),
            "format" => format = Some(value),
            "q" => q = Some(value),
            "uid" => uids.push(value),
            other => {
                return Err(ApiError::invalid(format!(
                    "`{other}` is not an export parameter; use tenant, format, q or uid."
                )));
            }
        }
    }
    let project = project_of(&state, project.as_ref());
    let tenant = users_tenant(tenant.as_ref());
    let format = wire::export_format(format.as_deref())
        .ok_or_else(|| ApiError::invalid("An export is format=json or format=csv."))?;
    if uids.len() > 500 {
        return Err(ApiError::invalid(format!(
            "An export names at most 500 users; this one names {}.",
            thousands(uids.len())
        ))
        .with_fix("Export by filter instead."));
    }
    let selection = if uids.is_empty() {
        ExportSelection::Filter(Box::new(user_filter(
            q.as_deref().unwrap_or_default(),
            now_minute(),
        )?))
    } else {
        ExportSelection::Uids(uids)
    };
    let runtime = state.console.runtime.clone();
    let (stream_project, stream_tenant) = (project.clone(), tenant.clone());
    let mut export = blocking("preparing the export", move || {
        runtime
            .export(
                &stream_project,
                stream_tenant.as_deref(),
                &selection,
                format,
            )
            .map_err(console_error)
    })
    .await?;
    let stamp = time::OffsetDateTime::now_utc();
    let filename = format!(
        "auth-users-{project}{}-{:04}{:02}{:02}-{:02}{:02}.{}",
        tenant
            .as_ref()
            .map(|tenant| format!("-{tenant}"))
            .unwrap_or_default(),
        stamp.year(),
        u8::from(stamp.month()),
        stamp.day(),
        stamp.hour(),
        stamp.minute(),
        format.extension()
    );
    let shutdown = state.context.shutdown.clone();
    let chunks = futures_util::stream::poll_fn(move |_| {
        if shutdown.is_stopping() {
            return std::task::Poll::Ready(None);
        }
        std::task::Poll::Ready(
            export
                .next_chunk(EXPORT_CHUNK)
                .map(|chunk| Ok::<_, std::io::Error>(axum::body::Bytes::from(chunk))),
        )
    });
    let content_type = match format {
        firenook_auth_front::console::export::ExportFormat::Json => "application/json",
        firenook_auth_front::console::export::ExportFormat::Csv => "text/csv; charset=utf-8",
    };
    let mut response = (attachment(&filename), HttpBody::from_stream(chunks)).into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    Ok(response)
}

// ---------------------------------------------------------------- messages

/// Where a page of messages or calls ends: the newest-first position, in
/// this engine run.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FeedCursor {
    epoch: u32,
    at: u64,
}

fn feed_cursor(state: &AuthRoutes, cursor: Option<&str>) -> Result<Option<u64>, ApiError> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    let decoded: FeedCursor = decode_cursor(cursor)?;
    if decoded.epoch != state.context.instance.epoch {
        return Err(
            ApiError::invalid("This cursor is from before the engine restarted.")
                .with_fix("Load the list again from its first page."),
        );
    }
    Ok(Some(decoded.at))
}

/// A newest-first page over `entries` (oldest first), by a position that
/// grows with each entry: after `cursor` (older), or above `before`
/// (newer). Answers the page and the positions of its first and last item.
fn feed_page<T>(
    entries: &[T],
    position: impl Fn(&T) -> u64,
    matches: impl Fn(&T) -> bool,
    cursor: Option<u64>,
    before: Option<u64>,
    limit: usize,
) -> (Vec<&T>, bool, bool) {
    if let Some(before) = before {
        let mut page: Vec<&T> = entries
            .iter()
            .filter(|entry| position(entry) > before && matches(entry))
            .take(limit + 1)
            .collect();
        let more_above = page.len() > limit;
        page.truncate(limit);
        page.reverse();
        return (page, more_above, true);
    }
    let mut page: Vec<&T> = entries
        .iter()
        .rev()
        .filter(|entry| cursor.is_none_or(|cursor| position(entry) < cursor) && matches(entry))
        .take(limit + 1)
        .collect();
    let more_below = page.len() > limit;
    page.truncate(limit);
    (page, cursor.is_some(), more_below)
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct MessagesParams {
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    tenant: Option<String>,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    activity: Option<u64>,
}

/// `GET /messages`.
async fn messages(
    State(state): State<AuthRoutes>,
    Query(params): Query<MessagesParams>,
) -> Result<Json<AuthMessagePage>, ApiError> {
    let project = project_of(&state, params.project.as_ref());
    let (entries, live_after) = state.console.feed.messages();
    if let Some(call) = params.activity {
        let items: Vec<AuthMessage> = entries
            .iter()
            .filter(|entry| entry.activity == Some(call) && entry.record.project == project)
            .map(|entry| entry.wire())
            .collect();
        let count = wire::len(items.len());
        return Ok(Json(AuthMessagePage {
            page: Page {
                items,
                next_cursor: None,
                prev_cursor: None,
                total: Some(wire::exact(count)),
                scanned: None,
            },
            facets: None,
            live_after,
        }));
    }
    let filter = MessageFilter::new(
        &project,
        params.tenant.as_deref().filter(|tenant| !tenant.is_empty()),
        params.q.as_deref().unwrap_or_default(),
        now_minute(),
    )?;
    let cursor = feed_cursor(&state, params.cursor.as_deref())?;
    let before = feed_cursor(&state, params.before.as_deref())?;
    if cursor.is_some() && before.is_some() {
        return Err(ApiError::invalid(
            "A page is read after `cursor` or before `before`, not both.",
        ));
    }
    let limit = limit_of(params.limit);
    let (page, above, below) = feed_page(
        &entries,
        |entry: &Arc<MessageEntry>| entry.record.id,
        |entry| filter.matches(entry),
        cursor,
        before,
        limit,
    );
    let epoch = state.context.instance.epoch;
    let at = |entry: &Arc<MessageEntry>| {
        encode_cursor(&FeedCursor {
            epoch,
            at: entry.record.id,
        })
    };
    let first_page = cursor.is_none() && before.is_none();
    let facets = first_page.then(|| message_facets(&entries, &filter));
    let total = first_page.then(|| {
        wire::exact(wire::len(
            entries.iter().filter(|entry| filter.matches(entry)).count(),
        ))
    });
    Ok(Json(AuthMessagePage {
        page: Page {
            next_cursor: page.last().filter(|_| below).map(|entry| at(entry)),
            prev_cursor: page.first().filter(|_| above).map(|entry| at(entry)),
            items: page.iter().map(|entry| entry.wire()).collect(),
            total,
            scanned: None,
        },
        facets,
        live_after,
    }))
}

fn message_facets(entries: &[Arc<MessageEntry>], filter: &MessageFilter) -> AuthMessageFacets {
    let mut facets = AuthMessageFacets::default();
    let mut kinds: Vec<(AuthMessageKind, u64)> = Vec::new();
    for entry in entries.iter().filter(|entry| filter.base_matches(entry)) {
        let message = entry.wire();
        if !message.used {
            facets.unused += 1;
        }
        match message.delivery {
            wire::AuthMessageDelivery::Returned => facets.returned += 1,
            wire::AuthMessageDelivery::Restored => facets.restored += 1,
            wire::AuthMessageDelivery::Sent => {}
        }
        match kinds.iter_mut().find(|(kind, _)| *kind == message.kind) {
            Some((_, count)) => *count += 1,
            None => kinds.push((message.kind, 1)),
        }
    }
    kinds.sort_by_key(|kind| std::cmp::Reverse(kind.1));
    facets.kinds = kinds
        .into_iter()
        .map(|(kind, messages)| AuthMessageKindCount { kind, messages })
        .collect();
    facets
}

/// `GET /messages/{id}`.
async fn message(
    State(state): State<AuthRoutes>,
    Path(id): Path<u64>,
) -> Result<Json<AuthMessage>, ApiError> {
    state
        .console
        .feed
        .message(id)
        .map(|entry| Json(entry.wire()))
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "The engine no longer keeps message #{}; it keeps the newest {}.",
                thousands(usize::try_from(id).unwrap_or(usize::MAX)),
                thousands(MESSAGE_CAPACITY)
            ))
            .with_fix("Codes already sent still work until used.")
        })
}

/// `DELETE /messages`: "Clear history".
async fn clear_messages(
    State(state): State<AuthRoutes>,
    Query(params): Query<ProjectParams>,
    ConsoleJson(Empty {}): ConsoleJson<Empty>,
) -> StatusCode {
    let project = project_of(&state, params.project.as_ref());
    state.console.feed.clear_messages(&project);
    StatusCode::NO_CONTENT
}

// ---------------------------------------------------------------- activity

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ActivityParams {
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    tenant: Option<String>,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    console: Option<bool>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

/// `GET /activity`.
async fn activity(
    State(state): State<AuthRoutes>,
    Query(params): Query<ActivityParams>,
) -> Result<Json<AuthActivityPage>, ApiError> {
    let project = project_of(&state, params.project.as_ref());
    let filter = ActivityFilter::new(
        &project,
        params.tenant.as_deref().filter(|tenant| !tenant.is_empty()),
        params.q.as_deref().unwrap_or_default(),
        params.console.unwrap_or(false),
        now_minute(),
    )?;
    let cursor = feed_cursor(&state, params.cursor.as_deref())?;
    let before = feed_cursor(&state, params.before.as_deref())?;
    if cursor.is_some() && before.is_some() {
        return Err(ApiError::invalid(
            "A page is read after `cursor` or before `before`, not both.",
        ));
    }
    let (entries, live_after) = state.console.feed.activity();
    let limit = limit_of(params.limit);
    let (page, above, below) = feed_page(
        &entries,
        |entry: &Arc<ActivityEntry>| entry.seq,
        |entry| filter.matches(entry),
        cursor,
        before,
        limit,
    );
    let epoch = state.context.instance.epoch;
    let at = |entry: &Arc<ActivityEntry>| {
        encode_cursor(&FeedCursor {
            epoch,
            at: entry.seq,
        })
    };
    let first_page = cursor.is_none() && before.is_none();
    Ok(Json(AuthActivityPage {
        page: Page {
            next_cursor: page.last().filter(|_| below).map(|entry| at(entry)),
            prev_cursor: page.first().filter(|_| above).map(|entry| at(entry)),
            items: page.iter().map(|entry| entry.summary.clone()).collect(),
            total: first_page.then(|| {
                wire::exact(wire::len(
                    entries.iter().filter(|entry| filter.matches(entry)).count(),
                ))
            }),
            scanned: None,
        },
        facets: first_page.then(|| activity_facets(&entries, &filter)),
        bodies_retained: state.console.feed.keeps_bodies(),
        live_after,
    }))
}

fn activity_facets(entries: &[Arc<ActivityEntry>], filter: &ActivityFilter) -> AuthActivityFacets {
    let callers = [
        AuthCaller::Client,
        AuthCaller::Admin,
        AuthCaller::Console,
        AuthCaller::ActionLink,
        AuthCaller::AccountPicker,
        AuthCaller::EmulatorApi,
    ];
    let mut facets = AuthActivityFacets {
        kinds: CallKind::ALL
            .iter()
            .map(|kind| AuthCallKindCount {
                kind: (*kind).into(),
                calls: 0,
            })
            .collect(),
        callers: callers
            .iter()
            .map(|caller| AuthCallerCount {
                caller: *caller,
                calls: 0,
            })
            .collect(),
        ..AuthActivityFacets::default()
    };
    for entry in entries.iter().filter(|entry| filter.base_matches(entry)) {
        if entry.summary.status >= 400 {
            facets.errors += 1;
        }
        if entry.summary.new_user == Some(true) {
            facets.new_users += 1;
        }
        if let Some(count) = facets
            .kinds
            .iter_mut()
            .find(|count| count.kind == entry.summary.kind)
        {
            count.calls += 1;
        }
        if let Some(count) = facets
            .callers
            .iter_mut()
            .find(|count| count.caller == entry.summary.caller)
        {
            count.calls += 1;
        }
    }
    facets
}

/// What a replay of `operation` repeats, when it is not idempotent.
fn replay_effect(entry: &ActivityEntry) -> Option<String> {
    let summary = &entry.summary;
    let name = summary
        .operation
        .strip_prefix("identitytoolkit.")
        .unwrap_or(&summary.operation);
    let who = summary
        .identifier
        .clone()
        .or_else(|| summary.uid.clone())
        .unwrap_or_else(|| "the same recipient".to_owned());
    Some(match name {
        "accounts.signUp" | "projects.accounts" | "projects.tenants.accounts" => {
            "Replay creates another user.".to_owned()
        }
        "accounts.sendOobCode"
        | "projects.accounts.sendOobCode"
        | "projects.tenants.accounts.sendOobCode"
        | "accounts.sendVerificationCode"
        | "accounts.mfaEnrollment.start"
        | "accounts.mfaSignIn.start" => format!("Replay sends another code to {who}."),
        "projects.accounts.batchCreate" | "projects.tenants.accounts.batchCreate" => {
            "Replay imports these users again.".to_owned()
        }
        "accounts.delete" | "projects.accounts.delete" | "projects.tenants.accounts.delete" => {
            format!(
                "Replay deletes {} again.",
                summary.uid.as_deref().unwrap_or("the user")
            )
        }
        "projects.accounts.batchDelete" | "projects.tenants.accounts.batchDelete" => {
            "Replay deletes these users again.".to_owned()
        }
        "projects.createSessionCookie" | "projects.tenants.createSessionCookie" => {
            "Replay mints another session cookie.".to_owned()
        }
        "projects.tenants.create" => "Replay creates another tenant.".to_owned(),
        "projects.tenants.delete" => "Replay deletes the tenant again.".to_owned(),
        "emulator.projects.accounts.delete" => "Replay deletes every user again.".to_owned(),
        _ => return None,
    })
}

/// `GET /activity/{id}`.
async fn activity_entry(
    State(state): State<AuthRoutes>,
    Path(id): Path<u64>,
) -> Result<Json<AuthActivityDetail>, ApiError> {
    let entry = state.console.feed.call_entry(id).ok_or_else(|| {
        ApiError::not_found(format!(
            "The engine no longer keeps call #{}; it keeps the newest {}.",
            thousands(usize::try_from(id).unwrap_or(usize::MAX)),
            thousands(ACTIVITY_CAPACITY)
        ))
    })?;
    let (request, response, kept, dropped) = {
        let bodies = entry
            .bodies
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (
            bodies.request.clone(),
            bodies.response.clone(),
            bodies.kept,
            bodies.dropped,
        )
    };
    let text = |bytes: Option<axum::body::Bytes>| {
        bytes.map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    };
    let operation = entry.summary.operation.as_str();
    let replayable = kept
        && !dropped
        && request.is_some()
        && operation != "emulator.accountPicker"
        && !operation.starts_with("firenook.console.");
    let pairs = |pairs: &[(String, String)]| {
        pairs
            .iter()
            .map(|(name, value)| AuthHeader {
                name: name.clone(),
                value: value.clone(),
            })
            .collect()
    };
    Ok(Json(AuthActivityDetail {
        replay_effect: replay_effect(&entry),
        summary: entry.summary.clone(),
        request: text(request),
        response: text(response),
        request_bytes: entry.request_bytes,
        response_bytes: entry.response_bytes,
        query: pairs(&entry.query),
        headers: pairs(&entry.headers),
        bodies_dropped: dropped,
        replayable,
    }))
}

/// `DELETE /activity`: "Clear history".
async fn clear_activity(
    State(state): State<AuthRoutes>,
    Query(params): Query<ProjectParams>,
    ConsoleJson(Empty {}): ConsoleJson<Empty>,
) -> StatusCode {
    let project = project_of(&state, params.project.as_ref());
    state.console.feed.clear_activity(&project);
    StatusCode::NO_CONTENT
}

// ---------------------------------------------------------------- tenants

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct TenantsParams {
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

/// `GET /tenants`: the tenants `q` matches, the first 500 at most in id
/// order (the picker asks for fewer), with how many it matches. Never
/// creates. Live changes are `auth.config` events, which the page answers by
/// reading the list again.
async fn tenants(
    State(state): State<AuthRoutes>,
    Query(params): Query<TenantsParams>,
) -> Json<AuthTenantList> {
    let project = project_of(&state, params.project.as_ref());
    let limit = params
        .limit
        .map_or(0, |limit| usize::try_from(limit).unwrap_or(usize::MAX));
    let list =
        state
            .console
            .runtime
            .tenant_list(&project, params.q.as_deref().unwrap_or_default(), limit);
    Json(AuthTenantList {
        items: list.tenants.into_iter().map(AuthTenant::from).collect(),
        total: list.total,
        project_users: list.project_users,
    })
}

/// `POST /tenants:batchGet`: tenants by id, `null` for one that does not
/// exist (the tenant a page is scoped to, read without creating it).
async fn tenants_batch(
    State(state): State<AuthRoutes>,
    Query(params): Query<ProjectParams>,
    ConsoleJson(request): ConsoleJson<BatchGetRequest>,
) -> Result<Json<BatchGetResponse<AuthTenant>>, ApiError> {
    request.check()?;
    let project = project_of(&state, params.project.as_ref());
    let found = state.console.runtime.tenants_by_id(&project, &request.keys);
    Ok(Json(BatchGetResponse {
        items: request
            .keys
            .into_iter()
            .zip(found)
            .map(|(key, tenant)| BatchGetItem {
                key,
                page: tenant.as_ref().map(|_| 0),
                row: tenant.map(AuthTenant::from),
            })
            .collect(),
    }))
}

/// `POST /tenants`: a tenant with the id asked for.
async fn create_tenant(
    State(state): State<AuthRoutes>,
    Query(params): Query<ProjectParams>,
    ConsoleJson(request): ConsoleJson<AuthTenantCreate>,
) -> Result<Json<AuthTenant>, ApiError> {
    let project = project_of(&state, params.project.as_ref());
    let runtime = state.console.runtime.clone();
    blocking("creating the tenant", move || {
        runtime
            .create_tenant(&project, &request.into())
            .map(AuthTenant::from)
            .map_err(console_error)
    })
    .await
    .map(Json)
}

/// `GET /hooks`.
async fn hooks(
    State(state): State<AuthRoutes>,
    Query(params): Query<ProjectParams>,
) -> Json<AuthHooks> {
    let project = project_of(&state, params.project.as_ref());
    Json(
        state
            .console
            .runtime
            .blocking_targets(&project)
            .await
            .into(),
    )
}

/// `GET /summary`.
async fn summary(
    State(state): State<AuthRoutes>,
    Query(params): Query<ProjectParams>,
) -> Json<AuthSummary> {
    let project = project_of(&state, params.project.as_ref());
    let counts = state.console.runtime.summary_counts(&project);
    Json(AuthSummary {
        project_id: project,
        users: counts.users,
        tenants: counts.tenants,
        tenant_users: counts.tenant_users,
        bodies_retained: state.console.feed.keeps_bodies(),
        activity_capacity: u32::try_from(ACTIVITY_CAPACITY).unwrap_or(u32::MAX),
        message_capacity: u32::try_from(MESSAGE_CAPACITY).unwrap_or(u32::MAX),
    })
}
