//! Project configuration (v2 and the emulator routes), code listings and
//! delete-all.

use serde_json::{Map as JsonMap, Value as JsonValue, json};

use super::Ctx;
use crate::Runtime;
use crate::error::{ApiError, ensure};
use crate::util::is_absolute_uri;

const BLOCKING_EVENTS: &[&str] = &["beforeCreate", "beforeSignIn"];

pub async fn get_config(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    let (config, set) = rt.scope(ctx, |scope| {
        ensure!(
            !scope.is_tenant(),
            "((Can only get top-level configurations on agent projects.))"
        );
        let agent = scope.agent_ref();
        Ok((agent.config.clone(), agent.blocking_set))
    })?;
    Ok(JsonValue::Object(
        with_registered(rt, ctx, config, set).await,
    ))
}

/// The configuration as the official emulator holds it: its Functions
/// emulator writes the blocking functions it found into `blockingFunctions`
/// whenever it loads them. Here they are looked up instead, so until an
/// `updateConfig` sets `blockingFunctions` the answer carries the ones Auth
/// would call now, each as `{functionUri}`, with `forwardInboundCredentials`
/// (#175).
async fn with_registered(
    rt: &Runtime,
    ctx: &Ctx,
    mut config: JsonMap<String, JsonValue>,
    set: bool,
) -> JsonMap<String, JsonValue> {
    if set {
        return config;
    }
    let targets = rt.blocking_targets(&ctx.project_id).await;
    let mut triggers = JsonMap::new();
    for (event, target) in [
        ("beforeCreate", &targets.before_create),
        ("beforeSignIn", &targets.before_sign_in),
    ] {
        if let Some(target) = target {
            triggers.insert(event.to_owned(), json!({ "functionUri": target.uri }));
        }
    }
    if !triggers.is_empty() {
        config.insert(
            "blockingFunctions".to_owned(),
            json!({
                "triggers": triggers,
                "forwardInboundCredentials": {
                    "accessToken": targets.forward_access_token,
                    "idToken": targets.forward_id_token,
                    "refreshToken": targets.forward_refresh_token,
                },
            }),
        );
    }
    config
}

/// Whether an `updateConfig` with this mask sets `blockingFunctions`: no mask
/// replaces the whole configuration, `blockingFunctions` itself, or a field
/// under it.
fn sets_blocking(update_mask: Option<&str>) -> bool {
    update_mask.is_none_or(|mask| {
        mask.split(',')
            .map(str::trim)
            .any(|field| field == "blockingFunctions" || field.starts_with("blockingFunctions."))
    })
}

fn update_config_impl(
    scope: &mut crate::state::Scope<'_>,
    body: &JsonMap<String, JsonValue>,
    update_mask: Option<&str>,
) -> Result<JsonValue, ApiError> {
    ensure!(
        !scope.is_tenant(),
        "((Can only update top-level configurations on agent projects.))"
    );
    let triggers = body
        .get("blockingFunctions")
        .and_then(|value| value.get("triggers"))
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    for (event, trigger) in &triggers {
        ensure!(
            BLOCKING_EVENTS.contains(&event.as_str()),
            "INVALID_BLOCKING_FUNCTION : ((Event type is invalid.))"
        );
        let uri = trigger
            .get("functionUri")
            .and_then(JsonValue::as_str)
            .unwrap_or_default();
        ensure!(
            is_absolute_uri(uri),
            "INVALID_BLOCKING_FUNCTION : ((Expected an absolute URI with valid scheme and host.))"
        );
    }
    let agent = scope.agent();
    if sets_blocking(update_mask) {
        agent.blocking_set = true;
    }
    Ok(JsonValue::Object(agent.update_config(body, update_mask)))
}

pub async fn update_config(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    let mask = ctx.query_str("updateMask").filter(|mask| !mask.is_empty());
    let (config, set) = rt.scope(ctx, |scope| {
        let updated = update_config_impl(scope, &ctx.body, mask)?;
        let config = match updated {
            JsonValue::Object(config) => config,
            _ => JsonMap::new(),
        };
        Ok((config, scope.agent_ref().blocking_set))
    })?;
    // A change to the blocking functions changes what sign-up and sign-in
    // call: the console's Settings follows it.
    if sets_blocking(mask) {
        rt.blocking_changed();
    }
    Ok(JsonValue::Object(
        with_registered(rt, ctx, config, set).await,
    ))
}

fn emulator_config(scope: &crate::state::Scope<'_>) -> JsonValue {
    json!({
        "signIn": { "allowDuplicateEmails": !scope.one_account_per_email() },
        "emailPrivacyConfig": { "enableImprovedEmailPrivacy": scope.improved_email_privacy() },
    })
}

pub fn get_emulator_config(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| Ok(emulator_config(scope)))
}

pub fn update_emulator_config(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        let mut mask = Vec::new();
        if ctx
            .body
            .get("signIn")
            .and_then(|sign_in| sign_in.get("allowDuplicateEmails"))
            .is_some_and(|value| !value.is_null())
        {
            mask.push("signIn.allowDuplicateEmails");
        }
        if ctx
            .body
            .get("emailPrivacyConfig")
            .and_then(|config| config.get("enableImprovedEmailPrivacy"))
            .is_some_and(|value| !value.is_null())
        {
            mask.push("emailPrivacyConfig.enableImprovedEmailPrivacy");
        }
        let joined = mask.join(",");
        update_config_impl(
            scope,
            &ctx.body,
            if joined.is_empty() {
                None
            } else {
                Some(&joined)
            },
        )?;
        Ok(emulator_config(scope))
    })
}

pub fn list_oob_codes(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        let codes = scope.project().list_oob_codes();
        Ok(json!({ "oobCodes": codes }))
    })
}

pub fn list_verification_codes(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        let codes = scope.project().list_verification_codes();
        Ok(json!({ "verificationCodes": codes }))
    })
}

pub fn delete_all_accounts(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        scope.project().delete_all_accounts();
        Ok(json!({}))
    })
}
