//! Project configuration (v2 and the emulator routes), code listings and
//! delete-all.

use serde_json::{Map as JsonMap, Value as JsonValue, json};

use super::Ctx;
use crate::Runtime;
use crate::error::{ApiError, ensure};
use crate::util::is_absolute_uri;

const BLOCKING_EVENTS: &[&str] = &["beforeCreate", "beforeSignIn"];

pub fn get_config(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(
            !scope.is_tenant(),
            "((Can only get top-level configurations on agent projects.))"
        );
        Ok(JsonValue::Object(scope.agent_ref().config.clone()))
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
    Ok(JsonValue::Object(
        scope.agent().update_config(body, update_mask),
    ))
}

pub fn update_config(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        update_config_impl(
            scope,
            &ctx.body,
            ctx.query_str("updateMask").filter(|mask| !mask.is_empty()),
        )
    })
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
