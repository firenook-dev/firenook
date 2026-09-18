//! Tenant lifecycle (`projects.tenants.*`).

use serde_json::{Map as JsonMap, Value as JsonValue, json};

use super::Ctx;
use crate::Runtime;
use crate::error::{ApiError, ensure};
use crate::state::apply_mask;
use crate::util::truthy;

fn tenant_from_request(body: &JsonMap<String, JsonValue>) -> JsonMap<String, JsonValue> {
    let mut mfa = body
        .get("mfaConfig")
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    if !mfa.contains_key("state") {
        mfa.insert("state".to_owned(), json!("DISABLED"));
    }
    if !mfa.contains_key("enabledProviders") {
        mfa.insert("enabledProviders".to_owned(), json!([]));
    }
    let mut tenant = JsonMap::new();
    if let Some(name) = body.get("displayName").filter(|value| !value.is_null()) {
        tenant.insert("displayName".to_owned(), name.clone());
    }
    tenant.insert(
        "allowPasswordSignup".to_owned(),
        json!(truthy(body.get("allowPasswordSignup"))),
    );
    tenant.insert(
        "enableEmailLinkSignin".to_owned(),
        json!(truthy(body.get("enableEmailLinkSignin"))),
    );
    tenant.insert(
        "enableAnonymousUser".to_owned(),
        json!(truthy(body.get("enableAnonymousUser"))),
    );
    tenant.insert(
        "disableAuth".to_owned(),
        json!(truthy(body.get("disableAuth"))),
    );
    tenant.insert("mfaConfig".to_owned(), JsonValue::Object(mfa));
    tenant.insert("tenantId".to_owned(), json!(""));
    tenant
}

pub fn create_tenant(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        if scope.is_tenant() {
            return Err(ApiError::internal(
                "INTERNAL_ERROR : Can only create tenant in agent project",
                "INTERNAL",
            ));
        }
        let config = tenant_from_request(&ctx.body);
        let project_id = scope.project_id.clone();
        Ok(JsonValue::Object(
            scope.agent().create_tenant(&config, &project_id),
        ))
    })
}

pub fn list_tenants(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(
            !scope.is_tenant(),
            "((Can only list tenants in agent project.))"
        );
        let page_size = ctx
            .query
            .get("pageSize")
            .and_then(JsonValue::as_i64)
            .filter(|value| *value != 0)
            .unwrap_or(20)
            .min(1000);
        let mut tenants = scope.agent().list_tenants(ctx.query_str("pageToken"));
        let mut next_page_token = None;
        if page_size > 0 && i64::try_from(tenants.len()).unwrap_or(i64::MAX) >= page_size {
            tenants.truncate(usize::try_from(page_size).unwrap_or(0));
            next_page_token = tenants
                .last()
                .and_then(|tenant| tenant.get("tenantId").cloned());
        }
        let mut response = JsonMap::new();
        if let Some(token) = next_page_token {
            response.insert("nextPageToken".to_owned(), token);
        }
        response.insert(
            "tenants".to_owned(),
            JsonValue::Array(tenants.into_iter().map(JsonValue::Object).collect()),
        );
        Ok(JsonValue::Object(response))
    })
}

pub fn delete_tenant(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(
            scope.is_tenant(),
            "((Can only delete tenant on tenant projects.))"
        );
        scope.delete_tenant();
        Ok(json!({}))
    })
}

pub fn get_tenant(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(
            scope.is_tenant(),
            "((Can only get tenant on tenant projects.))"
        );
        Ok(JsonValue::Object(
            scope.tenant_config_value().unwrap_or_default(),
        ))
    })
}

pub fn update_tenant(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(
            scope.is_tenant(),
            "((Can only update tenant on tenant projects.))"
        );
        let current = scope.tenant_config_value().unwrap_or_default();
        let updated = match ctx.query_str("updateMask").filter(|mask| !mask.is_empty()) {
            None => {
                let mut replaced = tenant_from_request(&ctx.body);
                replaced.insert(
                    "tenantId".to_owned(),
                    current.get("tenantId").cloned().unwrap_or(JsonValue::Null),
                );
                replaced.insert(
                    "name".to_owned(),
                    current.get("name").cloned().unwrap_or(JsonValue::Null),
                );
                // The official object literal orders tenantId and name first.
                let mut ordered = JsonMap::new();
                ordered.insert(
                    "tenantId".to_owned(),
                    replaced.get("tenantId").cloned().unwrap_or(JsonValue::Null),
                );
                ordered.insert(
                    "name".to_owned(),
                    replaced.get("name").cloned().unwrap_or(JsonValue::Null),
                );
                for key in [
                    "allowPasswordSignup",
                    "disableAuth",
                    "mfaConfig",
                    "enableAnonymousUser",
                    "enableEmailLinkSignin",
                    "displayName",
                ] {
                    if let Some(value) = replaced.get(key) {
                        ordered.insert(key.to_owned(), value.clone());
                    }
                }
                ordered
            }
            Some(mask) => {
                let mut config = current;
                apply_mask(mask, &mut config, &ctx.body);
                config
            }
        };
        scope.set_tenant_config(updated.clone());
        Ok(JsonValue::Object(updated))
    })
}
