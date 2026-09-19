//! `extension.yaml` reading and the conversion of its function resources
//! into emulated trigger definitions (`extensions/emulator/specHelper.ts`,
//! `triggerHelper.ts`).
use std::path::Path;

use firenook_functions_runtime::LogSink;
use firenook_functions_runtime::manifest::service_from_event_type;
use serde_json::{Map, Value, json};

use crate::ExtensionsError;
use crate::params::{Params, substitute_params};

pub const SPEC_FILE: &str = "extension.yaml";
pub const POSTINSTALL_FILE: &str = "POSTINSTALL.md";
pub const FUNCTIONS_RESOURCE_TYPE: &str = "firebaseextensions.v1beta.function";
pub const FUNCTIONS_V2_RESOURCE_TYPE: &str = "firebaseextensions.v1beta.v2function";
const VALID_FUNCTION_TYPES: [&str; 3] = [
    FUNCTIONS_RESOURCE_TYPE,
    FUNCTIONS_V2_RESOURCE_TYPE,
    "firebaseextensions.v1beta.scheduledFunction",
];
/// `supported.latest("nodejs")` in the pinned firebase-tools.
pub const DEFAULT_RUNTIME: &str = "nodejs22";
const ARRAY_DEFAULTS: [&str; 9] = [
    "params",
    "systemParams",
    "resources",
    "apis",
    "roles",
    "externalServices",
    "events",
    "lifecycleEvents",
    "contributors",
];

/// Parses YAML text into JSON (the `js-yaml` load the CLI uses).
pub fn yaml_to_json(text: &str) -> Result<Value, ExtensionsError> {
    let yaml: serde_norway::Value = serde_norway::from_str(text)
        .map_err(|error| ExtensionsError(format!("invalid YAML: {error}")))?;
    serde_json::to_value(yaml)
        .map_err(|error| ExtensionsError(format!("YAML is not JSON-compatible: {error}")))
}

/// `readExtensionYaml` + `readPostinstall`: the spec of a local extension
/// directory with the official defaults applied.
pub fn read_local_spec(directory: &Path) -> Result<Value, ExtensionsError> {
    let path = directory.join(SPEC_FILE);
    let text = std::fs::read_to_string(&path).map_err(|error| {
        ExtensionsError(format!("Could not read file {}: {error}", path.display()))
    })?;
    let mut spec = yaml_to_json(&text)?;
    let Some(object) = spec.as_object_mut() else {
        return Err(ExtensionsError(format!(
            "{} must contain a YAML mapping",
            path.display()
        )));
    };
    for key in ARRAY_DEFAULTS {
        if object.get(key).is_none_or(Value::is_null) {
            object.insert(key.to_owned(), Value::Array(Vec::new()));
        }
    }
    let postinstall = directory.join(POSTINSTALL_FILE);
    let content = std::fs::read_to_string(&postinstall).map_err(|error| {
        ExtensionsError(format!(
            "Could not read file {}: {error}",
            postinstall.display()
        ))
    })?;
    object.insert("postinstallContent".to_owned(), Value::String(content));
    Ok(spec)
}

/// `populateSpec` on a registry spec: `propertiesYaml` parsed into
/// `properties`, params and systemParams defaulted.
pub fn populate_registry_spec(spec: &mut Value) -> Result<(), ExtensionsError> {
    let Some(object) = spec.as_object_mut() else {
        return Ok(());
    };
    if let Some(resources) = object.get_mut("resources").and_then(Value::as_array_mut) {
        for resource in resources {
            let Some(yaml) = resource.get("propertiesYaml").and_then(Value::as_str) else {
                continue;
            };
            match yaml_to_json(yaml) {
                Ok(properties) => {
                    if let Some(map) = resource.as_object_mut() {
                        map.insert("properties".to_owned(), properties);
                    }
                }
                Err(error) => {
                    // The official client logs and keeps the resource.
                    eprintln!(
                        "firenook extensions: failed to parse resource properties yaml: {}",
                        error.0
                    );
                }
            }
        }
    }
    for key in ["params", "systemParams"] {
        if object.get(key).is_none_or(Value::is_null) {
            object.insert(key.to_owned(), Value::Array(Vec::new()));
        }
    }
    Ok(())
}

/// `getFunctionResourcesWithParamSubstitution`.
pub fn function_resources(spec: &Value, params: &Params) -> Result<Vec<Value>, ExtensionsError> {
    let resources: Vec<Value> = spec
        .get("resources")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|resource| {
                    resource
                        .get("type")
                        .and_then(Value::as_str)
                        .is_some_and(|kind| VALID_FUNCTION_TYPES.contains(&kind))
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let substituted = substitute_params(&Value::Array(resources), params)?;
    Ok(substituted.as_array().cloned().unwrap_or_default())
}

/// `getRuntime`: the highest Node runtime the resources declare.
pub fn runtime(resources: &[Value]) -> Result<String, ExtensionsError> {
    if resources.is_empty() {
        return Ok(DEFAULT_RUNTIME.to_owned());
    }
    let mut invalid = Vec::new();
    let mut best: Option<(u32, String)> = None;
    for resource in resources {
        let declared = resource_runtime(resource);
        let Some(declared) = declared else {
            consider(&mut best, DEFAULT_RUNTIME);
            continue;
        };
        if let Some(version) = declared
            .strip_prefix("nodejs")
            .and_then(|rest| rest.parse::<u32>().ok())
        {
            if best.as_ref().is_none_or(|(current, _)| version > *current) {
                best = Some((version, declared.to_owned()));
            }
        } else {
            invalid.push(declared.to_owned());
            consider(&mut best, DEFAULT_RUNTIME);
        }
    }
    if !invalid.is_empty() {
        return Err(ExtensionsError(format!(
            "The following runtimes are not supported by the Emulator Suite: {}. \n Only Node runtimes are supported.",
            invalid.join(", ")
        )));
    }
    Ok(best.map_or_else(|| DEFAULT_RUNTIME.to_owned(), |(_, name)| name))
}

fn consider(best: &mut Option<(u32, String)>, runtime: &str) {
    let version = runtime
        .strip_prefix("nodejs")
        .and_then(|rest| rest.parse::<u32>().ok())
        .unwrap_or(0);
    if best.as_ref().is_none_or(|(current, _)| version > *current) {
        *best = Some((version, runtime.to_owned()));
    }
}

/// `getResourceRuntime`: `properties.runtime` for v1, `buildConfig.runtime` for v2.
fn resource_runtime(resource: &Value) -> Option<&str> {
    let properties = resource.get("properties")?;
    match resource.get("type").and_then(Value::as_str)? {
        FUNCTIONS_RESOURCE_TYPE => properties.get("runtime").and_then(Value::as_str),
        FUNCTIONS_V2_RESOURCE_TYPE => properties
            .get("buildConfig")
            .and_then(|build| build.get("runtime"))
            .and_then(Value::as_str),
        _ => None,
    }
}

/// `functionResourceToEmulatedTriggerDefintion`, followed by the
/// `ext-<instance>-` prefix the emulator adds. Resources without a trigger
/// keep their definition (they are admitted as "ignored" later) and log the
/// official warning.
pub fn trigger_definition(
    resource: &Value,
    system_params: &Params,
    instance_id: &str,
    log: &LogSink,
) -> Result<Map<String, Value>, ExtensionsError> {
    let name = resource
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| ExtensionsError("extension resource is missing a name".to_owned()))?;
    let kind = resource.get("type").and_then(Value::as_str).unwrap_or("");
    let properties = resource
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut definition = Map::new();
    definition.insert(
        "name".to_owned(),
        Value::String(format!("ext-{instance_id}-{name}")),
    );
    definition.insert("entryPoint".to_owned(), Value::String(name.to_owned()));
    match kind {
        FUNCTIONS_RESOURCE_TYPE => {
            v1_definition(&mut definition, name, &properties, system_params, log);
        }
        FUNCTIONS_V2_RESOURCE_TYPE => v2_definition(&mut definition, name, &properties, log),
        other => {
            return Err(ExtensionsError(format!("Unexpected resource type {other}")));
        }
    }
    Ok(definition)
}

/// The `firebaseextensions.v1beta.function` conversion.
fn v1_definition(
    definition: &mut Map<String, Value>,
    name: &str,
    properties: &Map<String, Value>,
    system_params: &Params,
    log: &LogSink,
) {
    definition.insert("platform".to_owned(), Value::String("gcfv1".to_owned()));
    if let Some(location) = system_params.get("firebaseextensions.v1beta.function/location") {
        definition.insert("regions".to_owned(), json!([location]));
    }
    if let Some(timeout) = system_params
        .get("firebaseextensions.v1beta.function/timeoutSeconds")
        .and_then(|value| value.parse::<f64>().ok())
    {
        definition.insert("timeoutSeconds".to_owned(), number_value(timeout));
    }
    if let Some(memory) = system_params
        .get("firebaseextensions.v1beta.function/memory")
        .and_then(|value| value.parse::<f64>().ok())
    {
        definition.insert("availableMemoryMb".to_owned(), number_value(memory));
    }
    if let Some(labels) = system_params.get("firebaseextensions.v1beta.function/labels") {
        let mut map = Map::new();
        for label in labels.split(',') {
            let mut parts = label.splitn(2, ':');
            let key = parts.next().unwrap_or_default();
            let value = parts
                .next()
                .map_or(Value::Null, |value| Value::String(value.to_owned()));
            map.insert(key.to_owned(), value);
        }
        definition.insert("labels".to_owned(), Value::Object(map));
    }
    if let Some(timeout) = properties.get("timeout") {
        definition.insert("timeoutSeconds".to_owned(), seconds_from_duration(timeout));
    }
    if let Some(location) = properties.get("location") {
        definition.insert("regions".to_owned(), json!([location]));
    }
    if let Some(memory) = properties.get("availableMemoryMb") {
        definition.insert("availableMemoryMb".to_owned(), memory.clone());
    }
    if let Some(https) = properties.get("httpsTrigger") {
        definition.insert("httpsTrigger".to_owned(), https.clone());
    }
    if let Some(event) = properties.get("eventTrigger").filter(|value| truthy(value)) {
        let event_type = event.get("eventType").cloned().unwrap_or(Value::Null);
        let mut trigger = Map::new();
        trigger.insert("eventType".to_owned(), event_type.clone());
        trigger.insert(
            "resource".to_owned(),
            event.get("resource").cloned().unwrap_or(Value::Null),
        );
        trigger.insert(
            "service".to_owned(),
            Value::String(service_from_event_type(event_type.as_str().unwrap_or("")).to_owned()),
        );
        definition.insert("eventTrigger".to_owned(), Value::Object(trigger));
    } else if let Some(schedule) = properties
        .get("scheduleTrigger")
        .filter(|value| truthy(value))
    {
        definition.insert(
            "schedule".to_owned(),
            json!({ "schedule": schedule.get("schedule").cloned().unwrap_or(Value::Null) }),
        );
        definition.insert(
            "eventTrigger".to_owned(),
            json!({ "eventType": "google.pubsub.topic.publish", "resource": "" }),
        );
    } else {
        log.warn(format!(
            "Function '{name}' is missing a trigger in extension.yaml. Please add one, as triggers defined in code are ignored."
        ));
    }
}

/// The `firebaseextensions.v1beta.v2function` conversion.
fn v2_definition(
    definition: &mut Map<String, Value>,
    name: &str,
    properties: &Map<String, Value>,
    log: &LogSink,
) {
    definition.insert("platform".to_owned(), Value::String("gcfv2".to_owned()));
    if let Some(location) = properties.get("location") {
        definition.insert("regions".to_owned(), json!([location]));
    }
    if let Some(service_config) = properties.get("serviceConfig") {
        if let Some(timeout) = service_config.get("timeoutSeconds") {
            definition.insert("timeoutSeconds".to_owned(), timeout.clone());
        }
        if let Some(memory) = service_config.get("availableMemory") {
            definition.insert("availableMemoryMb".to_owned(), parse_int(memory));
        }
    }
    if let Some(event) = properties.get("eventTrigger").filter(|value| truthy(value)) {
        let event_type = event
            .get("eventType")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let mut trigger = Map::new();
        trigger.insert("eventType".to_owned(), Value::String(event_type.clone()));
        trigger.insert(
            "service".to_owned(),
            Value::String(service_from_event_type(&event_type).to_owned()),
        );
        if let Some(channel) = event.get("channel") {
            trigger.insert("channel".to_owned(), channel.clone());
        }
        if let Some(filters) = event.get("eventFilters").and_then(Value::as_array) {
            let mut exact = Map::new();
            let mut patterns = Map::new();
            for filter in filters {
                let attribute = filter
                    .get("attribute")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let value = filter.get("value").cloned().unwrap_or(Value::Null);
                match filter.get("operator").and_then(Value::as_str) {
                    None => {
                        exact.insert(attribute, value);
                    }
                    Some("match-path-pattern") => {
                        patterns.insert(attribute, value);
                    }
                    Some(_) => {}
                }
            }
            if event_type.contains("google.cloud.firestore") {
                exact
                    .entry("database".to_owned())
                    .or_insert_with(|| Value::String("(default)".to_owned()));
                exact
                    .entry("namespace".to_owned())
                    .or_insert_with(|| Value::String("(default)".to_owned()));
            }
            trigger.insert("eventFilters".to_owned(), Value::Object(exact));
            trigger.insert(
                "eventFilterPathPatterns".to_owned(),
                Value::Object(patterns),
            );
        }
        definition.insert("eventTrigger".to_owned(), Value::Object(trigger));
    } else {
        log.warn(format!(
            "Function '{name} is missing a trigger in extension.yaml. Please add one, as triggers defined in code are ignored."
        ));
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `proto.secondsFromDuration`: `"120s"` → 120.
fn seconds_from_duration(value: &Value) -> Value {
    match value {
        Value::String(text) => {
            let digits = text.trim_end_matches('s');
            digits.parse::<f64>().map_or(Value::Null, number_value)
        }
        other => other.clone(),
    }
}

/// A JavaScript number as JSON: integral values print without a fraction.
fn number_value(number: f64) -> Value {
    if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 {
        // Integral and below 2^53: the cast is exact.
        #[allow(clippy::cast_possible_truncation)]
        let integer = number as i64;
        json!(integer)
    } else {
        json!(number)
    }
}

/// `parseInt`: leading integer of a string such as `256M`.
fn parse_int(value: &Value) -> Value {
    match value {
        Value::String(text) => {
            let digits: String = text
                .trim_start()
                .chars()
                .take_while(|character| character.is_ascii_digit() || *character == '-')
                .collect();
            digits
                .parse::<i64>()
                .map_or(Value::Null, |number| json!(number))
        }
        Value::Number(number) => number
            .as_f64()
            .map_or(Value::Null, |n| number_value(n.trunc())),
        _ => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(entries: &[(&str, &str)]) -> Params {
        let mut params = Params::new();
        for (key, value) in entries {
            params.set(*key, *value);
        }
        params
    }

    #[test]
    fn v1_resources_convert_like_the_recorded_backend() {
        let spec = yaml_to_json(
            "resources:\n  - name: firestoreFn\n    type: firebaseextensions.v1beta.function\n    properties:\n      location: ${param:LOCATION}\n      runtime: nodejs22\n      timeout: 120s\n      availableMemoryMb: 512\n      eventTrigger:\n        eventType: providers/cloud.firestore/eventTypes/document.write\n        resource: projects/${param:PROJECT_ID}/databases/(default)/documents/${param:COLLECTION}/{docId}\n  - name: httpFn\n    type: firebaseextensions.v1beta.function\n    properties:\n      location: ${param:LOCATION}\n      httpsTrigger: {}\n  - name: queueFn\n    type: firebaseextensions.v1beta.function\n    properties:\n      location: ${param:LOCATION}\n      taskQueueTrigger: {}\n",
        )
        .unwrap();
        let params = params(&[
            ("LOCATION", "us-central1"),
            ("PROJECT_ID", "demo-x"),
            ("COLLECTION", "synthetic-items"),
        ]);
        let resources = function_resources(&spec, &params).unwrap();
        let (log, events) = LogSink::recording();
        let firestore =
            trigger_definition(&resources[0], &Params::new(), "synthetic", &log).unwrap();
        assert_eq!(
            Value::Object(firestore),
            json!({
                "name": "ext-synthetic-firestoreFn",
                "entryPoint": "firestoreFn",
                "platform": "gcfv1",
                "timeoutSeconds": 120,
                "regions": ["us-central1"],
                "availableMemoryMb": 512,
                "eventTrigger": {
                    "eventType": "providers/cloud.firestore/eventTypes/document.write",
                    "resource": "projects/demo-x/databases/(default)/documents/synthetic-items/{docId}",
                    "service": "firestore.googleapis.com"
                }
            })
        );
        let https = trigger_definition(&resources[1], &Params::new(), "synthetic", &log).unwrap();
        assert_eq!(https["httpsTrigger"], json!({}));
        let queue = trigger_definition(&resources[2], &Params::new(), "synthetic", &log).unwrap();
        assert!(queue.get("eventTrigger").is_none());
        assert!(queue.get("taskQueueTrigger").is_none());
        // HTTPS and task-queue resources both log the official warning.
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| event.message.contains("missing a trigger"))
                .count(),
            2
        );
        assert_eq!(runtime(&resources).unwrap(), "nodejs22");
    }

    #[test]
    fn v2_resources_convert_with_filters() {
        let spec = yaml_to_json(
            "resources:\n  - name: v2Fn\n    type: firebaseextensions.v1beta.v2function\n    properties:\n      location: us-central1\n      buildConfig:\n        runtime: nodejs22\n      serviceConfig:\n        timeoutSeconds: 90\n        availableMemory: 256M\n      eventTrigger:\n        eventType: google.cloud.firestore.document.v1.written\n        triggerRegion: us-central1\n        eventFilters:\n          - attribute: document\n            value: items-v2/{docId}\n            operator: match-path-pattern\n",
        )
        .unwrap();
        let resources = function_resources(&spec, &Params::new()).unwrap();
        let (log, _events) = LogSink::recording();
        let definition =
            trigger_definition(&resources[0], &Params::new(), "synthetic", &log).unwrap();
        assert_eq!(
            Value::Object(definition),
            json!({
                "name": "ext-synthetic-v2Fn",
                "entryPoint": "v2Fn",
                "platform": "gcfv2",
                "regions": ["us-central1"],
                "timeoutSeconds": 90,
                "availableMemoryMb": 256,
                "eventTrigger": {
                    "eventType": "google.cloud.firestore.document.v1.written",
                    "service": "firestore.googleapis.com",
                    "eventFilters": { "database": "(default)", "namespace": "(default)" },
                    "eventFilterPathPatterns": { "document": "items-v2/{docId}" }
                }
            })
        );
    }

    #[test]
    fn local_spec_applies_defaults() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join(SPEC_FILE),
            "name: synthetic\nversion: 0.1.0\nspecVersion: v1beta\n",
        )
        .unwrap();
        std::fs::write(directory.path().join(POSTINSTALL_FILE), "# Done\n").unwrap();
        let spec = read_local_spec(directory.path()).unwrap();
        assert_eq!(spec["version"], "0.1.0");
        assert_eq!(spec["params"], json!([]));
        assert_eq!(spec["contributors"], json!([]));
        assert_eq!(spec["postinstallContent"], "# Done\n");
    }
}
