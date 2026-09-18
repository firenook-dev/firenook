//! Instance parameters: the `extensions/<instance>.env*` files, the
//! project-derived auto parameters, `${param:X}` substitution and defaults,
//! following `extensions/manifest.ts`, `extensionsHelper.ts` and
//! `paramHelper.ts`.
use std::path::Path;

use fireside_functions_runtime::dotenv;
use regex::Regex;
use serde_json::Value;

use crate::ExtensionsError;

/// The directory under the project holding instance parameter files.
pub const ENV_DIRECTORY: &str = "extensions";
/// The project number the official emulator uses for demo projects.
pub const FAKE_PROJECT_NUMBER: &str = "0";

/// An ordered parameter map (JavaScript object semantics: first insertion
/// fixes the position, later assignments replace the value).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Params(Vec<(String, String)>);

impl Params {
    #[must_use]
    pub fn new() -> Self {
        Self(Vec::new())
    }

    pub fn set(&mut self, key: impl Into<String>, value: impl Into<String>) {
        let key = key.into();
        let value = value.into();
        if let Some(entry) = self.0.iter_mut().find(|(existing, _)| *existing == key) {
            entry.1 = value;
        } else {
            self.0.push((key, value));
        }
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value.as_str())
    }

    pub fn remove(&mut self, key: &str) -> Option<String> {
        let index = self.0.iter().position(|(existing, _)| existing == key)?;
        Some(self.0.remove(index).1)
    }

    #[must_use]
    pub fn contains(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// `Object.assign(self, other)`.
    pub fn extend(&mut self, other: &Self) {
        for (key, value) in &other.0 {
            self.set(key.clone(), value.clone());
        }
    }

    #[must_use]
    pub fn into_map(self) -> std::collections::BTreeMap<String, String> {
        self.0.into_iter().collect()
    }
}

/// Reads and merges the instance's parameter files in the official order:
/// `<id>.env`, `<id>.env.<alias>`..., `<id>.env.<projectNumber>`,
/// `<id>.env.<projectId>`, then `<id>.env.local` (`readInstanceParam`).
pub fn read_instance_params(
    project_dir: &Path,
    instance_id: &str,
    project_id: &str,
    project_number: Option<&str>,
    aliases: &[String],
    check_local: bool,
) -> Result<Params, ExtensionsError> {
    let mut files = vec![format!("{instance_id}.env")];
    files.extend(
        aliases
            .iter()
            .map(|alias| format!("{instance_id}.env.{alias}")),
    );
    if let Some(number) = project_number {
        files.push(format!("{instance_id}.env.{number}"));
    }
    files.push(format!("{instance_id}.env.{project_id}"));
    if check_local {
        files.push(format!("{instance_id}.env.local"));
    }
    let mut found = false;
    let mut combined = Params::new();
    for file in files {
        let path = project_dir.join(ENV_DIRECTORY).join(&file);
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let params = parse_env_file(&path, &text)?;
        found = true;
        combined.extend(&params);
    }
    if !found {
        return Err(ExtensionsError(format!(
            "No params file found for {instance_id}"
        )));
    }
    Ok(combined)
}

/// `readEnvFile`: the official dotenv dialect on the trimmed file.
pub fn parse_env_file(path: &Path, text: &str) -> Result<Params, ExtensionsError> {
    let (entries, errors) = dotenv::parse_ordered(text.trim());
    if !errors.is_empty() {
        return Err(ExtensionsError(format!(
            "Error while parsing {} - unable to parse following lines:\n{}",
            path.display(),
            errors.join("\n")
        )));
    }
    let mut params = Params::new();
    for (key, value) in entries {
        params.set(key, value);
    }
    Ok(params)
}

/// `getFirebaseProjectParams` for the emulator: the values `${X}` and
/// `${param:X}` references inside parameter files resolve to.
#[must_use]
pub fn project_params(project_id: &str, database_url: &str, storage_bucket: &str) -> Params {
    let mut params = Params::new();
    params.set("PROJECT_ID", project_id);
    params.set("PROJECT_NUMBER", FAKE_PROJECT_NUMBER);
    params.set("DATABASE_URL", database_url);
    params.set("STORAGE_BUCKET", storage_bucket);
    // `JSON.stringify` key order: projectId, databaseURL, storageBucket.
    params.set(
        "FIREBASE_CONFIG",
        format!(
            "{{\"projectId\":{},\"databaseURL\":{},\"storageBucket\":{}}}",
            Value::String(project_id.to_owned()),
            Value::String(database_url.to_owned()),
            Value::String(storage_bucket.to_owned()),
        ),
    );
    params.set("DATABASE_INSTANCE", database_instance(database_url));
    params
}

fn database_instance(database_url: &str) -> String {
    database_url
        .strip_prefix("https://")
        .and_then(|rest| {
            rest.find(".firebaseio.com")
                .map(|end| rest[..end].to_owned())
        })
        .unwrap_or_default()
}

/// `substituteParams`: textual replacement of `${KEY}` and `${param:KEY}`
/// inside the JSON encoding of `original`, one parameter at a time in
/// parameter order, then re-parsed.
pub fn substitute_params(original: &Value, params: &Params) -> Result<Value, ExtensionsError> {
    let mut text = original.to_string();
    for (key, value) in params.iter() {
        let escaped = regex::escape(key);
        for pattern in [
            format!(r"\$\{{{escaped}\}}"),
            format!(r"\$\{{param:{escaped}\}}"),
        ] {
            let regex = Regex::new(&pattern).map_err(|error| {
                ExtensionsError(format!("invalid parameter name {key}: {error}"))
            })?;
            text = regex
                .replace_all(&text, regex::NoExpand(value))
                .into_owned();
        }
    }
    serde_json::from_str(&text).map_err(|error| {
        ExtensionsError(format!(
            "parameter substitution produced invalid JSON: {error}"
        ))
    })
}

/// `substituteParams` over a parameter map (values only, keys untouched).
pub fn substitute_param_values(
    original: &Params,
    params: &Params,
) -> Result<Params, ExtensionsError> {
    let object: serde_json::Map<String, Value> = original
        .iter()
        .map(|(key, value)| (key.to_owned(), Value::String(value.to_owned())))
        .collect();
    let substituted = substitute_params(&Value::Object(object), params)?;
    let mut result = Params::new();
    for (key, _) in original.iter() {
        let value = substituted
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        result.set(key.to_owned(), value);
    }
    Ok(result)
}

/// `isSystemParam`: `firebaseextensions.<...>/<name>` keys.
#[must_use]
pub fn is_system_param(name: &str) -> bool {
    static PATTERN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    PATTERN
        .get_or_init(|| {
            Regex::new(r"^firebaseextensions\.[a-zA-Z0-9.]*/").unwrap_or_else(|_| unreachable!())
        })
        .is_match(name)
}

/// Splits parameters into (system, user) like `partitionRecord(..., isSystemParam)`.
#[must_use]
pub fn partition_system_params(params: &Params) -> (Params, Params) {
    let mut system = Params::new();
    let mut user = Params::new();
    for (key, value) in params.iter() {
        if is_system_param(key) {
            system.set(key, value);
        } else {
            user.set(key, value);
        }
    }
    (system, user)
}

/// `paramHelper.populateDefaultParams`: every spec param missing from the
/// map takes its (unsubstituted) default; a param without a default stays
/// absent.
#[must_use]
pub fn populate_default_params(params: &Params, spec_params: &[Value]) -> Params {
    let mut result = params.clone();
    for param in spec_params {
        let Some(name) = param.get("param").and_then(Value::as_str) else {
            continue;
        };
        if result.contains(name) {
            continue;
        }
        if let Some(default) = param.get("default") {
            let text = match default {
                Value::String(text) => text.clone(),
                Value::Null => continue,
                other => other.to_string(),
            };
            result.set(name, text);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitution_follows_parameter_order_and_both_syntaxes() {
        let mut params = Params::new();
        params.set("COLLECTION", "items");
        params.set("DERIVED", "${param:COLLECTION}-derived");
        let original = serde_json::json!({
            "a": "projects/${PROJECT_ID}/x/${param:COLLECTION}",
            "b": "${param:DERIVED}",
        });
        let substituted = substitute_params(&original, &params).unwrap();
        assert_eq!(substituted["a"], "projects/${PROJECT_ID}/x/items");
        // DERIVED's own reference is replaced only when COLLECTION comes later.
        assert_eq!(substituted["b"], "${param:COLLECTION}-derived");
    }

    #[test]
    fn defaults_fill_missing_params_only() {
        let mut params = Params::new();
        params.set("MODE", "slow");
        let spec = vec![
            serde_json::json!({"param": "MODE", "default": "fast"}),
            serde_json::json!({"param": "BUCKET", "default": "${STORAGE_BUCKET}"}),
            serde_json::json!({"param": "API_KEY", "type": "secret"}),
        ];
        let filled = populate_default_params(&params, &spec);
        assert_eq!(filled.get("MODE"), Some("slow"));
        assert_eq!(filled.get("BUCKET"), Some("${STORAGE_BUCKET}"));
        assert!(!filled.contains("API_KEY"));
    }

    #[test]
    fn system_params_are_partitioned() {
        let mut params = Params::new();
        params.set(
            "firebaseextensions.v1beta.function/location",
            "europe-west1",
        );
        params.set("LOCATION", "us-central1");
        let (system, user) = partition_system_params(&params);
        assert_eq!(
            system.get("firebaseextensions.v1beta.function/location"),
            Some("europe-west1")
        );
        assert_eq!(user.get("LOCATION"), Some("us-central1"));
        assert!(!user.contains("firebaseextensions.v1beta.function/location"));
    }

    #[test]
    fn project_params_match_the_official_shape() {
        let params = project_params(
            "demo-x",
            "https://demo-x.firebaseio.com",
            "demo-x.appspot.com",
        );
        assert_eq!(params.get("DATABASE_INSTANCE"), Some("demo-x"));
        assert_eq!(params.get("PROJECT_NUMBER"), Some("0"));
        assert_eq!(
            params.get("FIREBASE_CONFIG"),
            Some(
                r#"{"projectId":"demo-x","databaseURL":"https://demo-x.firebaseio.com","storageBucket":"demo-x.appspot.com"}"#
            )
        );
    }
}
