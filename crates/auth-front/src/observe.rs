//! What the console learns from the Auth emulator: one record per finished
//! call, with everything the call caused — the blocking functions it ran,
//! the triggers it queued, the codes it sent or used, the accounts and the
//! configuration it changed.
//!
//! The emulator works the same with or without an observer. Without one a
//! call still draws its id (blocking functions receive it) and the state's
//! notices are still drained, but no step is kept and no record is built.
//! With one, the record is handed over after the state lock is released and
//! before the response is returned, so whatever a caller reads with the call
//! id it got back is already recorded. Bodies are kept as the `Bytes` the
//! call already held — never copied or re-serialized on the request path.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::body::Bytes;
use axum::http::HeaderMap;
use serde_json::{Map as JsonMap, Value as JsonValue};

use crate::util::{decode_jwt, str_field};

/// Bodies larger than this are kept as their length only.
pub const BODY_LIMIT: usize = 16 * 1024;
/// Characters of the client string kept.
pub const CLIENT_CHARS: usize = 160;
/// The request header the console sends on its own requests.
pub const CONSOLE_HEADER: &str = "x-firenook-console";
/// The response header naming the call, answered only to a request that
/// carried [`CONSOLE_HEADER`].
pub const ACTIVITY_HEADER: &str = "x-firenook-activity";
/// The response header the Functions runtime answers a caused invocation
/// with: its invocation id.
pub const EXECUTION_HEADER: &str = "x-firenook-execution";

/// Receives one record per finished call. Called after the state lock is
/// released and before the response is returned. Implementations must not
/// block: no I/O, no await, short locks only.
pub trait AuthObserver: Send + Sync {
    fn call(&self, record: CallRecord);
}

/// The value of the `x-firenook-console` request header: `write`, `try` or
/// `replay` set the origin; the console's default `1` and any other token
/// count as `write`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsoleOrigin {
    /// An edit, a send or a bulk change from the console (hidden in
    /// Activity by default).
    Write,
    /// Try a sign-in, or a mint with beforeSignIn: the developer asked to
    /// see it.
    Try,
    /// Replay of a recorded call.
    Replay,
}

impl ConsoleOrigin {
    /// The origin a request's console header names; `None` without one.
    #[must_use]
    pub fn of(headers: &HeaderMap) -> Option<Self> {
        let value = headers.get(CONSOLE_HEADER)?.to_str().ok()?.trim();
        Some(match value {
            "try" => Self::Try,
            "replay" => Self::Replay,
            _ => Self::Write,
        })
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Write => "write",
            Self::Try => "try",
            Self::Replay => "replay",
        }
    }
}

/// One finished call to the Auth emulator.
#[derive(Clone, Debug)]
pub struct CallRecord {
    /// Drawn when the request arrives, so it exists before the call does
    /// anything (blocking functions receive it).
    pub id: u64,
    /// When the request arrived, epoch milliseconds.
    pub at_millis: i64,
    pub duration: Duration,
    pub project: String,
    pub tenant: Option<String>,
    pub caller: Caller,
    pub origin: Option<ConsoleOrigin>,
    pub credential: Credential,
    /// `x-client-version`, else `x-firebase-client`, else
    /// `x-goog-api-client`, else `user-agent`, first 160 characters.
    pub client: Option<String>,
    pub method: String,
    /// The path without its query, as the Auth application saw it (the
    /// console mount's prefix stripped).
    pub path: String,
    /// The `OpenAPI` operation id, or `emulator.action.<mode>`,
    /// `emulator.accountPicker`, `firenook.console.<action>`.
    pub operation: String,
    /// What the call is, by its operation (the `kind:` filter values).
    pub kind: CallKind,
    pub identifier: Option<String>,
    pub provider: Option<String>,
    pub uid: Option<String>,
    pub new_user: Option<bool>,
    pub status: u16,
    pub error: Option<CallError>,
    /// The bodies as received and as sent, when kept and at most 16 KiB
    /// each; otherwise only their length.
    pub request: Body,
    pub response: Body,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub steps: Vec<Step>,
}

/// A request or response body, as far as it was kept.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Body {
    /// The bytes themselves (a handle on the call's own buffer).
    Kept(Bytes),
    /// Larger than [`BODY_LIMIT`]: only its length.
    Dropped { bytes: u64 },
    /// Bodies are not kept (diagnostics off).
    NotKept,
}

impl Body {
    /// `bytes` kept when `keep` and small enough, else its length.
    #[must_use]
    pub fn of(bytes: &Bytes, keep: bool) -> Self {
        if !keep {
            Self::NotKept
        } else if bytes.len() <= BODY_LIMIT {
            Self::Kept(bytes.clone())
        } else {
            Self::Dropped {
                bytes: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            }
        }
    }

    /// The body's length, whether or not it was kept.
    #[must_use]
    pub fn len(&self) -> u64 {
        match self {
            Self::Kept(bytes) => u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            Self::Dropped { bytes } => *bytes,
            Self::NotKept => 0,
        }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Who made the call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Caller {
    /// An app, with an API key.
    Client,
    /// The Admin SDK or the CLI (owner or service-account credentials).
    Admin,
    /// The console (`x-firenook-console`).
    Console,
    /// A browser following an action link (`/emulator/action`).
    ActionLink,
    /// The account picker of a federated sign-in (`/emulator/auth/handler`).
    AccountPicker,
    /// The emulator's own API (`/emulator/v1/...`).
    EmulatorApi,
}

/// The credential the call carried.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Credential {
    ApiKey,
    /// `Authorization: Bearer owner`.
    Owner,
    /// A `ya29.` access token.
    ServiceAccount,
    None,
}

/// What the call failed with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallError {
    /// The part of the message before " : " (`WEAK_PASSWORD`), or the
    /// status (`INVALID_ARGUMENT`) when the message is prose.
    pub code: String,
    pub message: String,
}

impl CallError {
    /// The error of a response body, when the call failed (`status` 400 or
    /// more): the emulator's `{ "error": { message, status } }`, or a
    /// top-level `message` (the router's 405).
    #[must_use]
    pub fn of_response(status: u16, body: &[u8]) -> Option<Self> {
        if status < 400 {
            return None;
        }
        let parsed = serde_json::from_slice::<JsonValue>(body).ok();
        let error = parsed.as_ref().and_then(|value| value.get("error"));
        let message = error
            .and_then(|error| error.get("message"))
            .or_else(|| parsed.as_ref().and_then(|value| value.get("message")))
            .and_then(JsonValue::as_str)
            .map(str::to_owned)
            .unwrap_or_default();
        let declared = error
            .and_then(|error| error.get("status"))
            .and_then(JsonValue::as_str);
        Some(Self {
            code: error_code(&message, declared, status),
            message,
        })
    }
}

/// The code a message leads with (`WEAK_PASSWORD : …`, `USER_DISABLED`,
/// `TENANT_ID_MISMATCH: ((…))`), else the declared status, else the HTTP
/// status's name.
#[must_use]
pub fn error_code(message: &str, status: Option<&str>, http: u16) -> String {
    let lead = message.split([' ', ':']).next().unwrap_or_default();
    let code_like = lead.len() >= 3
        && lead
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        && lead.bytes().any(|byte| byte.is_ascii_uppercase());
    if code_like {
        return lead.to_owned();
    }
    if let Some(status) = status.filter(|status| !status.is_empty()) {
        return status.to_owned();
    }
    match http {
        400 => "BAD_REQUEST",
        401 => "UNAUTHENTICATED",
        403 => "PERMISSION_DENIED",
        404 => "NOT_FOUND",
        405 => "METHOD_NOT_ALLOWED",
        409 => "ALREADY_EXISTS",
        501 => "NOT_IMPLEMENTED",
        503 => "UNAVAILABLE",
        _ => "INTERNAL",
    }
    .to_owned()
}

/// What a call is, by its operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CallKind {
    SignIn,
    SignUp,
    Refresh,
    Code,
    Account,
    Config,
    Lookup,
    Other,
}

impl CallKind {
    pub const ALL: [Self; 8] = [
        Self::SignIn,
        Self::SignUp,
        Self::Refresh,
        Self::Code,
        Self::Account,
        Self::Config,
        Self::Lookup,
        Self::Other,
    ];

    /// The `kind:` filter value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SignIn => "sign-in",
            Self::SignUp => "sign-up",
            Self::Refresh => "refresh",
            Self::Code => "code",
            Self::Account => "account",
            Self::Config => "config",
            Self::Lookup => "lookup",
            Self::Other => "other",
        }
    }
}

/// One thing a call caused.
#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    /// A blocking function ran (or refused, or failed).
    Blocking {
        event: &'static str,
        uri: String,
        /// The last path segment of the uri.
        function: Option<String>,
        duration: Duration,
        /// The invocation id, from the response header
        /// `x-firenook-execution` (the Functions runtime adds it because the
        /// request carried the cause header); the `functions.invocation` key.
        invocation: Option<String>,
        /// Fields the function changed, `customAttributes` excepted.
        changed: Vec<String>,
        /// Top-level keys of the custom claims it set.
        custom_claims: Vec<String>,
        /// Top-level keys of the session claims it returned (beforeSignIn).
        session_claims: Vec<String>,
        failure: Option<BlockingFailure>,
    },
    /// A lifecycle event for Functions.
    Trigger {
        event: &'static str,
        uid: String,
        outcome: TriggerOutcome,
    },
    /// A code or link was created.
    MessageSent(MessageRecord),
    /// A code was consumed; `key` is the oobCode or the sessionInfo.
    MessageUsed { key: String },
    /// An account was created, updated or deleted.
    User {
        tenant: Option<String>,
        uid: String,
        change: UserChange,
        /// The record fields an update set.
        fields: Vec<String>,
    },
    /// Every account of a tenant (or the project) was deleted.
    UsersCleared { tenant: Option<String> },
    /// Configuration changed.
    Config {
        tenant: Option<String>,
        what: ConfigChange,
    },
}

/// Why a blocking function refused or failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockingFailure {
    /// The function's own message: `error.message` of the JSON body it sent
    /// (the Functions SDK's `HttpsError` shape), else the body's text, else
    /// the transport sentence ("Deadline exceeded…").
    pub message: String,
    /// The HTTP status the function answered, when it answered.
    pub status: Option<u16>,
    /// The engine's line exactly as the caller saw it.
    pub raw: String,
}

/// A code or a link the emulator would have sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageRecord {
    /// Drawn when the code is created; the `auth.message` key.
    pub id: u64,
    pub project: String,
    pub tenant: Option<String>,
    pub kind: MessageKind,
    /// The email address or phone number.
    pub to: String,
    pub new_email: Option<String>,
    pub uid: Option<String>,
    /// The `oobCode`, or the six-digit SMS code.
    pub code: String,
    /// The link exactly as the emulator generated it.
    pub link: Option<String>,
    pub continue_url: Option<String>,
    pub delivery: Delivery,
    /// Set when a console call created it.
    pub origin: Option<ConsoleOrigin>,
    /// The oobCode for links, the sessionInfo for SMS: what consumption names.
    pub key: String,
    /// The line the emulator printed (empty when the link was returned).
    pub text: String,
    /// Absent for a code found in saved state.
    pub at_millis: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MessageKind {
    VerifyEmail,
    PasswordReset,
    EmailSignIn,
    VerifyAndChangeEmail,
    RecoverEmail,
    SmsSignIn,
    SmsMfaEnrollment,
    SmsMfaSignIn,
}

impl MessageKind {
    pub const ALL: [Self; 8] = [
        Self::VerifyEmail,
        Self::PasswordReset,
        Self::EmailSignIn,
        Self::VerifyAndChangeEmail,
        Self::RecoverEmail,
        Self::SmsSignIn,
        Self::SmsMfaEnrollment,
        Self::SmsMfaSignIn,
    ];

    /// The kind of an out-of-band code's request type.
    #[must_use]
    pub fn of_request_type(request_type: &str) -> Self {
        match request_type {
            "PASSWORD_RESET" => Self::PasswordReset,
            "EMAIL_SIGNIN" => Self::EmailSignIn,
            "VERIFY_AND_CHANGE_EMAIL" => Self::VerifyAndChangeEmail,
            "RECOVER_EMAIL" => Self::RecoverEmail,
            _ => Self::VerifyEmail,
        }
    }

    /// Whether the message is an SMS (else an email).
    #[must_use]
    pub const fn is_sms(self) -> bool {
        matches!(
            self,
            Self::SmsSignIn | Self::SmsMfaEnrollment | Self::SmsMfaSignIn
        )
    }
}

/// How a message left the emulator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// Logged, as an email or SMS would have been sent.
    Sent,
    /// Handed to the caller (an Admin SDK `generate…Link` call); nothing
    /// was logged.
    Returned,
    /// Found in saved state when the engine started.
    Restored,
}

/// What became of a lifecycle event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TriggerOutcome {
    Queued,
    /// Background triggers are paused; the event was counted and dropped.
    DeliveryOff,
    Failed(String),
}

impl TriggerOutcome {
    /// `queued`, `deliveryOff` or `failed: <reason>`.
    #[must_use]
    pub fn describe(&self) -> String {
        match self {
            Self::Queued => "queued".to_owned(),
            Self::DeliveryOff => "deliveryOff".to_owned(),
            Self::Failed(reason) => format!("failed: {reason}"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserChange {
    Created,
    Updated,
    Deleted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigChange {
    Project,
    TenantCreated,
    TenantUpdated,
    TenantDeleted,
}

/// What a code creation site knows besides the code itself.
#[derive(Clone, Debug)]
pub struct MessageMeta {
    pub id: u64,
    pub delivery: Delivery,
    pub continue_url: Option<String>,
    /// The account the message is for, when the site knows it better than
    /// the state's indexes (a second factor's owner).
    pub uid: Option<String>,
}

/// What an SMS code is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SmsPurpose {
    SignIn,
    MfaEnrollment,
    MfaSignIn,
}

impl SmsPurpose {
    #[must_use]
    pub const fn kind(self) -> MessageKind {
        match self {
            Self::SignIn => MessageKind::SmsSignIn,
            Self::MfaEnrollment => MessageKind::SmsMfaEnrollment,
            Self::MfaSignIn => MessageKind::SmsMfaSignIn,
        }
    }
}

/// The line the official emulator prints for an SMS code.
#[must_use]
pub fn sms_message_text(purpose: SmsPurpose, phone: &str, code: &str) -> String {
    match purpose {
        SmsPurpose::SignIn => format!("To verify the phone number {phone}, use the code {code}."),
        SmsPurpose::MfaEnrollment => format!("To enroll MFA with {phone}, use the code {code}."),
        SmsPurpose::MfaSignIn => format!("To sign in with MFA using {phone}, use the code {code}."),
    }
}

/// A state change the console wants to know of, pushed by the state as it
/// changes and drained with the scope it happened in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Notice {
    User {
        uid: String,
        change: UserChange,
        fields: Vec<String>,
    },
    Cleared,
    /// A code was created; the project, tenant and origin are filled in
    /// when it is drained.
    Message(Box<MessageRecord>),
    Used {
        key: String,
    },
    Config {
        tenant: Option<String>,
        what: ConfigChange,
    },
}

/// The call one operation runs for: its id, its console origin, and the
/// steps it caused (kept only while an observer listens).
#[derive(Clone, Debug, Default)]
pub struct Trace {
    id: u64,
    origin: Option<ConsoleOrigin>,
    steps: Option<Arc<Mutex<Vec<Step>>>>,
}

impl Trace {
    /// A trace for call `id`; `recording` keeps its steps.
    #[must_use]
    pub fn new(id: u64, origin: Option<ConsoleOrigin>, recording: bool) -> Self {
        Self {
            id,
            origin,
            steps: recording.then(|| Arc::new(Mutex::new(Vec::new()))),
        }
    }

    /// The call id; 0 for work no call started.
    #[must_use]
    pub const fn id(&self) -> u64 {
        self.id
    }

    #[must_use]
    pub const fn origin(&self) -> Option<ConsoleOrigin> {
        self.origin
    }

    /// Whether steps are kept.
    #[must_use]
    pub const fn recording(&self) -> bool {
        self.steps.is_some()
    }

    /// Keeps `step`; nothing happens unless recording. Changes to one
    /// account within a call become one step, as the console reads them:
    /// created then updated is created, anything then deleted is deleted,
    /// updates merge their fields.
    pub fn push(&self, step: Step) {
        let Some(steps) = &self.steps else {
            return;
        };
        let mut steps = steps.lock().unwrap_or_else(PoisonError::into_inner);
        if let Step::User {
            tenant,
            uid,
            change,
            fields,
        } = &step
            && let Some(Step::User {
                change: earlier,
                fields: merged,
                ..
            }) = steps.iter_mut().find(|kept| {
                matches!(kept, Step::User { tenant: kept_tenant, uid: kept_uid, .. }
                    if kept_tenant == tenant && kept_uid == uid)
            })
        {
            match (*earlier, *change) {
                (UserChange::Created, UserChange::Updated) => {}
                (_, UserChange::Deleted) => {
                    *earlier = UserChange::Deleted;
                    merged.clear();
                }
                (_, UserChange::Created) => {
                    *earlier = UserChange::Created;
                    merged.clear();
                }
                (_, UserChange::Updated) => {
                    for field in fields {
                        if !merged.contains(field) {
                            merged.push(field.clone());
                        }
                    }
                }
            }
            return;
        }
        steps.push(step);
    }

    /// The steps kept so far, in order, emptied.
    #[must_use]
    pub fn take(&self) -> Vec<Step> {
        self.steps.as_ref().map_or_else(Vec::new, |steps| {
            std::mem::take(&mut *steps.lock().unwrap_or_else(PoisonError::into_inner))
        })
    }
}

/// Who called and with what credential, from the path and the headers.
#[must_use]
pub fn caller_of(path: &str, headers: &HeaderMap, query_key: bool) -> (Caller, Credential) {
    let credential = match headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .get(..7)
                .filter(|scheme| scheme.eq_ignore_ascii_case("bearer "))
                .map(|_| value[7..].trim())
        }) {
        Some(token) if token.eq_ignore_ascii_case("owner") => Credential::Owner,
        Some(token) if token.starts_with("ya29.") => Credential::ServiceAccount,
        _ if query_key || headers.contains_key("x-goog-api-key") => Credential::ApiKey,
        _ => Credential::None,
    };
    let caller = if headers.contains_key(CONSOLE_HEADER) {
        Caller::Console
    } else if path == "/emulator/action" {
        Caller::ActionLink
    } else if path == "/emulator/auth/handler" {
        Caller::AccountPicker
    } else if path.starts_with("/emulator/") {
        Caller::EmulatorApi
    } else if matches!(credential, Credential::Owner | Credential::ServiceAccount) {
        Caller::Admin
    } else {
        Caller::Client
    };
    (caller, credential)
}

/// The client a call names: `x-client-version`, else `x-firebase-client`,
/// else `x-goog-api-client`, else `user-agent`, first 160 characters.
#[must_use]
pub fn client_of(headers: &HeaderMap) -> Option<String> {
    [
        "x-client-version",
        "x-firebase-client",
        "x-goog-api-client",
        "user-agent",
    ]
    .iter()
    .find_map(|name| {
        headers
            .get(*name)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
    .map(|value| value.chars().take(CLIENT_CHARS).collect())
}

/// The headers a record keeps: the client's, the content type, the origin,
/// and the authorization reduced to its scheme and what it carries.
#[must_use]
pub fn kept_headers(headers: &HeaderMap) -> Vec<(String, String)> {
    let mut kept = Vec::new();
    for name in [
        "x-client-version",
        "x-firebase-client",
        "x-goog-api-client",
        "user-agent",
        "content-type",
        "origin",
    ] {
        if let Some(value) = headers.get(name).and_then(|value| value.to_str().ok()) {
            kept.push((name.to_owned(), value.to_owned()));
        }
    }
    if let Some(value) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        kept.push(("authorization".to_owned(), reduce_authorization(value)));
    }
    kept
}

/// `Bearer owner`, `Bearer ya29.…`, `Bearer <id token, 812 bytes>`: never
/// the token itself.
#[must_use]
pub fn reduce_authorization(value: &str) -> String {
    let (scheme, token) = value.split_once(' ').unwrap_or((value, ""));
    let token = token.trim();
    let shown = if token.eq_ignore_ascii_case("owner") {
        "owner".to_owned()
    } else if token.starts_with("ya29.") {
        "ya29.…".to_owned()
    } else if token.is_empty() {
        String::new()
    } else if decode_jwt(token).is_some() {
        format!("<id token, {} bytes>", token.len())
    } else {
        format!("<{} bytes>", token.len())
    };
    if shown.is_empty() {
        scheme.to_owned()
    } else {
        format!("{scheme} {shown}")
    }
}

/// What [`describe`] reads of one call.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Description {
    pub identifier: Option<String>,
    pub provider: Option<String>,
    pub uid: Option<String>,
    pub new_user: Option<bool>,
}

/// The kind of a call, by its operation id.
#[must_use]
pub fn kind_of(operation: &str) -> CallKind {
    let name = operation
        .strip_prefix("identitytoolkit.")
        .unwrap_or(operation);
    match name {
        "accounts.signUp" => CallKind::SignUp,
        "accounts.signInWithPassword"
        | "accounts.signInWithCustomToken"
        | "accounts.signInWithEmailLink"
        | "accounts.signInWithIdp"
        | "accounts.signInWithPhoneNumber"
        | "accounts.mfaSignIn.finalize"
        | "accounts.passkeySignIn.finalize"
        | "projects.createSessionCookie"
        | "projects.tenants.createSessionCookie"
        | "emulator.accountPicker"
        | "firenook.console.mint" => CallKind::SignIn,
        "securetoken.token" => CallKind::Refresh,
        "accounts.sendOobCode"
        | "projects.accounts.sendOobCode"
        | "projects.tenants.accounts.sendOobCode"
        | "accounts.sendVerificationCode"
        | "accounts.mfaEnrollment.start"
        | "accounts.mfaSignIn.start" => CallKind::Code,
        "accounts.lookup"
        | "projects.accounts.lookup"
        | "projects.tenants.accounts.lookup"
        | "accounts.createAuthUri"
        | "getProjects"
        | "getRecaptchaParams"
        | "projects.queryAccounts"
        | "projects.accounts.query"
        | "projects.tenants.accounts.query"
        | "projects.accounts.batchGet"
        | "projects.tenants.accounts.batchGet"
        | "projects.getConfig"
        | "projects.tenants.get"
        | "projects.tenants.list"
        | "accounts.passkeySignIn.start"
        | "emulator.projects.config.get"
        | "emulator.projects.oobCodes.list"
        | "emulator.projects.verificationCodes.list" => CallKind::Lookup,
        "projects.updateConfig"
        | "projects.tenants.create"
        | "projects.tenants.delete"
        | "projects.tenants.patch"
        | "emulator.projects.config.update"
        | "firenook.console.createTenant" => CallKind::Config,
        "accounts.update"
        | "projects.accounts.update"
        | "projects.tenants.accounts.update"
        | "accounts.delete"
        | "projects.accounts.delete"
        | "projects.tenants.accounts.delete"
        | "projects.accounts"
        | "projects.tenants.accounts"
        | "accounts.resetPassword"
        | "accounts.mfaEnrollment.finalize"
        | "accounts.mfaEnrollment.withdraw"
        | "accounts.passkeyEnrollment.start"
        | "accounts.passkeyEnrollment.finalize"
        | "projects.accounts.batchCreate"
        | "projects.tenants.accounts.batchCreate"
        | "projects.accounts.batchDelete"
        | "projects.tenants.accounts.batchDelete"
        | "emulator.projects.accounts.delete" => CallKind::Account,
        other if other.starts_with("emulator.action.") => CallKind::Account,
        other if other.starts_with("firenook.console.users.") => CallKind::Account,
        "firenook.console.clear" => CallKind::Account,
        _ => CallKind::Other,
    }
}

fn text(value: Option<&JsonValue>) -> Option<String> {
    value
        .and_then(JsonValue::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// The uid and sign-in provider an unsigned ID token names.
fn token_subject(token: Option<&str>) -> (Option<String>, Option<String>, Option<String>) {
    let Some((_, payload)) = token.and_then(decode_jwt) else {
        return (None, None, None);
    };
    (
        text(payload.get("user_id")).or_else(|| text(payload.get("sub"))),
        text(
            payload
                .get("firebase")
                .and_then(|firebase| firebase.get("sign_in_provider")),
        ),
        text(payload.get("email")).or_else(|| text(payload.get("phone_number"))),
    )
}

/// The uid a custom token names: the strict JSON form, or an unsigned JWT.
fn custom_token_uid(token: Option<&str>) -> Option<String> {
    let token = token?;
    if let Ok(JsonValue::Object(object)) = serde_json::from_str::<JsonValue>(token) {
        return text(object.get("uid"));
    }
    decode_jwt(token).and_then(|(_, payload)| text(payload.get("uid")))
}

/// Identifier, provider, uid and whether a user was created, for one call:
/// read from the request's parsed body and query and the answer it gave
/// (`None` when it failed).
#[must_use]
pub fn describe(
    operation: &str,
    body: &JsonMap<String, JsonValue>,
    query: &[(String, String)],
    response: Option<&JsonValue>,
) -> Description {
    let name = operation
        .strip_prefix("identitytoolkit.")
        .unwrap_or(operation);
    let answer = |field: &str| text(response.and_then(|response| response.get(field)));
    let asked = |field: &str| text(body.get(field));
    let new_user = response
        .and_then(|response| response.get("isNewUser"))
        .and_then(JsonValue::as_bool);
    let mut description = Description::default();
    match name {
        "accounts.signUp" | "projects.accounts" | "projects.tenants.accounts" => {
            description.identifier = asked("email")
                .or_else(|| asked("phoneNumber"))
                .or_else(|| answer("email"));
            description.provider = Some(
                if asked("email").is_some() && asked("password").is_some() {
                    "password"
                } else if asked("phoneNumber").is_some() {
                    "phone"
                } else if name == "accounts.signUp" {
                    "anonymous"
                } else {
                    "admin"
                }
                .to_owned(),
            );
            description.uid = answer("localId").or_else(|| asked("localId"));
            description.new_user = response.map(|_| true);
        }
        "accounts.signInWithPassword" => {
            description.identifier = asked("email").or_else(|| answer("email"));
            description.provider = Some("password".to_owned());
            description.uid = answer("localId");
            description.new_user = response.map(|_| false);
        }
        "accounts.signInWithCustomToken" => {
            description.provider = Some("custom".to_owned());
            description.uid = custom_token_uid(body.get("token").and_then(JsonValue::as_str));
            description.identifier = description.uid.clone();
            description.new_user = new_user;
        }
        "accounts.signInWithEmailLink" => {
            description.identifier = asked("email").or_else(|| answer("email"));
            description.provider = Some("emailLink".to_owned());
            description.uid = answer("localId");
            description.new_user = new_user;
        }
        "accounts.signInWithIdp" => {
            description.identifier = answer("email").or_else(|| answer("federatedId"));
            description.provider = answer("providerId");
            description.uid = answer("localId");
            description.new_user = new_user;
        }
        "accounts.signInWithPhoneNumber" => {
            description.identifier = answer("phoneNumber").or_else(|| asked("phoneNumber"));
            description.provider = Some("phone".to_owned());
            description.uid = answer("localId");
            description.new_user = new_user;
        }
        "securetoken.token" => {
            let refresh = text(body.get("refreshToken")).or_else(|| {
                query
                    .iter()
                    .find(|(key, _)| key == "refresh_token")
                    .map(|(_, value)| value.clone())
            });
            if let Some(record) = refresh
                .as_deref()
                .and_then(|token| crate::token::decode_refresh_token(token).ok())
            {
                description.uid = Some(record.local_id);
                description.provider = Some(record.provider).filter(|value| !value.is_empty());
            }
            description.uid = answer("user_id").or(description.uid);
        }
        "accounts.sendOobCode"
        | "projects.accounts.sendOobCode"
        | "projects.tenants.accounts.sendOobCode" => {
            description.identifier = answer("email").or_else(|| asked("email"));
            if let (None, (uid, _, email)) = (
                &description.identifier,
                token_subject(body.get("idToken").and_then(JsonValue::as_str)),
            ) {
                description.identifier = email;
                description.uid = uid;
            }
        }
        "accounts.sendVerificationCode" => {
            description.identifier = asked("phoneNumber");
            description.provider = Some("phone".to_owned());
        }
        "accounts.resetPassword" => {
            description.identifier = answer("email");
        }
        "accounts.createAuthUri" => {
            description.identifier = asked("identifier").or_else(|| asked("email"));
        }
        "accounts.mfaEnrollment.start"
        | "accounts.mfaEnrollment.finalize"
        | "accounts.mfaEnrollment.withdraw"
        | "accounts.passkeyEnrollment.start"
        | "accounts.passkeyEnrollment.finalize" => {
            let (uid, provider, identifier) =
                token_subject(body.get("idToken").and_then(JsonValue::as_str));
            description.uid = uid;
            description.provider = provider;
            description.identifier = body
                .get("phoneEnrollmentInfo")
                .and_then(|info| text(info.get("phoneNumber")))
                .or(identifier);
        }
        "accounts.mfaSignIn.start" | "accounts.mfaSignIn.finalize" => {
            description.provider = Some("phone".to_owned());
            if let Some((_, payload)) = response
                .and_then(|response| text(response.get("idToken")))
                .as_deref()
                .and_then(decode_jwt)
            {
                description.uid = text(payload.get("user_id"));
                description.identifier =
                    text(payload.get("email")).or_else(|| text(payload.get("phone_number")));
            }
        }
        "accounts.update"
        | "projects.accounts.update"
        | "projects.tenants.accounts.update"
        | "accounts.lookup"
        | "projects.accounts.lookup"
        | "projects.tenants.accounts.lookup"
        | "accounts.delete"
        | "projects.accounts.delete"
        | "projects.tenants.accounts.delete"
        | "projects.createSessionCookie"
        | "projects.tenants.createSessionCookie" => {
            let (uid, provider, identifier) =
                token_subject(body.get("idToken").and_then(JsonValue::as_str));
            let listed = body.get("localId").and_then(|value| match value {
                JsonValue::Array(items) => text(items.first()),
                other => text(Some(other)),
            });
            description.uid = answer("localId").or(listed).or(uid);
            description.provider = provider;
            description.identifier = answer("email")
                .or_else(|| asked("email"))
                .or(identifier)
                .or_else(|| {
                    response
                        .and_then(|response| response.get("users"))
                        .and_then(|users| users.get(0))
                        .and_then(|user| text(user.get("email")))
                });
        }
        "projects.accounts.batchCreate" | "projects.tenants.accounts.batchCreate" => {
            let users = body
                .get("users")
                .and_then(JsonValue::as_array)
                .map_or(0, Vec::len);
            description.identifier = Some(if users == 1 {
                "1 user".to_owned()
            } else {
                format!("{users} users")
            });
        }
        "projects.accounts.batchDelete" | "projects.tenants.accounts.batchDelete" => {
            let users = body
                .get("localIds")
                .and_then(JsonValue::as_array)
                .map_or(0, Vec::len);
            description.identifier = Some(if users == 1 {
                "1 user".to_owned()
            } else {
                format!("{users} users")
            });
        }
        "projects.tenants.create"
        | "projects.tenants.patch"
        | "projects.tenants.get"
        | "projects.tenants.delete" => {
            description.identifier = answer("displayName")
                .or_else(|| asked("displayName"))
                .or_else(|| answer("tenantId"));
        }
        _ => {}
    }
    if description.identifier.is_none()
        && let Some(uid) = &description.uid
    {
        description.identifier = Some(uid.clone());
    }
    description
}

/// The function name of a blocking function's uri: its last path segment.
#[must_use]
pub fn function_of(uri: &str) -> Option<String> {
    url::Url::parse(uri)
        .ok()
        .and_then(|url| {
            url.path_segments()
                .and_then(|mut segments| segments.rfind(|segment| !segment.is_empty()))
                .map(str::to_owned)
        })
        .filter(|name| !name.is_empty())
}

/// Top-level keys of a JSON object held as text (`customAttributes`).
#[must_use]
pub fn object_keys_of_text(text: Option<&str>) -> Vec<String> {
    text.and_then(|text| serde_json::from_str::<JsonValue>(text).ok())
        .and_then(|value| match value {
            JsonValue::Object(object) => Some(object.keys().cloned().collect()),
            _ => None,
        })
        .unwrap_or_default()
}

/// The function's own message in a refusal body: `error.message` of the
/// Functions SDK's `HttpsError` JSON, else the body's text.
#[must_use]
pub fn function_message(body: &str) -> String {
    serde_json::from_str::<JsonValue>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(JsonValue::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| body.trim().to_owned())
}

/// A message's uid, read from a user record.
pub(crate) fn uid_of(user: &JsonMap<String, JsonValue>) -> Option<String> {
    str_field(user, "localId")
        .filter(|uid| !uid.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
#[path = "observe_tests.rs"]
mod tests;
