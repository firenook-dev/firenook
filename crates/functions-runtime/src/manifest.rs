//! The firebase-functions `v1alpha1` wire manifest and its conversion into
//! the emulated trigger definitions the official emulator serves under
//! `/backends` and keys its trigger table with (firebase-tools 15.22.0
//! `deploy/functions/runtimes/discovery/v1alpha1.js`, `deploy/functions/build.js`
//! and `emulator/functionsEmulatorShared.js`). The definitions are kept as
//! JSON objects so the inventory is reproduced field for field.
use std::collections::BTreeMap;
use std::fmt::{self, Display};

use serde_json::{Map, Value, json};

/// The official `backend.of` bucket for endpoints that declare no region.
const REGION_TBD: &str = "REGION_TBD";
/// Default region when an endpoint declares none.
pub const DEFAULT_REGION: &str = "us-central1";
const EVENTARC_SOURCE_LABEL: &str = "EVENTARC_CLOUD_EVENT_SOURCE";

/// v2 event types the official emulator can register (`V2_EVENTS`); other v2
/// event triggers without a channel are dropped from the definitions.
const V2_EVENTS: [&str; 14] = [
    "google.cloud.pubsub.topic.v1.messagePublished",
    "google.firebase.firebasealerts.alerts.v1.published",
    "google.cloud.storage.object.v1.archived",
    "google.cloud.storage.object.v1.finalized",
    "google.cloud.storage.object.v1.deleted",
    "google.cloud.storage.object.v1.metadataUpdated",
    "google.firebase.database.ref.v1.written",
    "google.firebase.database.ref.v1.created",
    "google.firebase.database.ref.v1.updated",
    "google.firebase.database.ref.v1.deleted",
    "google.cloud.firestore.document.v1.written",
    "google.cloud.firestore.document.v1.created",
    "google.cloud.firestore.document.v1.updated",
    "google.cloud.firestore.document.v1.deleted",
];
const V2_AUTH_CONTEXT_EVENTS: [&str; 4] = [
    "google.cloud.firestore.document.v1.written.withAuthContext",
    "google.cloud.firestore.document.v1.created.withAuthContext",
    "google.cloud.firestore.document.v1.updated.withAuthContext",
    "google.cloud.firestore.document.v1.deleted.withAuthContext",
];

/// A manifest or definition problem with the official wording where one exists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestError(pub String);

impl Display for ManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ManifestError {}

/// One emulated trigger definition (`EmulatedTriggerDefinition`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Definition {
    json: Map<String, Value>,
}

/// The signature the worker executes a definition with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signature {
    Http,
    Event,
    CloudEvent,
}

impl Signature {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Event => "event",
            Self::CloudEvent => "cloudevent",
        }
    }
}

impl Definition {
    /// Wraps a definition object (an extension's predefined trigger, for instance).
    #[must_use]
    pub fn from_json(json: Map<String, Value>) -> Self {
        Self { json }
    }

    /// The JSON object served under `/backends`.
    #[must_use]
    pub fn json(&self) -> &Map<String, Value> {
        &self.json
    }

    fn string(&self, key: &str) -> &str {
        self.json.get(key).and_then(Value::as_str).unwrap_or("")
    }

    #[must_use]
    pub fn name(&self) -> &str {
        self.string("name")
    }

    #[must_use]
    pub fn entry_point(&self) -> &str {
        self.string("entryPoint")
    }

    #[must_use]
    pub fn platform(&self) -> &str {
        self.string("platform")
    }

    /// `<region>-<name>`.
    #[must_use]
    pub fn id(&self) -> String {
        let id = self.string("id");
        if id.is_empty() {
            format!("{}-{}", self.region(), self.name())
        } else {
            id.to_owned()
        }
    }

    #[must_use]
    pub fn region(&self) -> &str {
        let region = self.string("region");
        if region.is_empty() {
            self.json
                .get("regions")
                .and_then(Value::as_array)
                .and_then(|regions| regions.first())
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_REGION)
        } else {
            region
        }
    }

    #[must_use]
    pub fn timeout_seconds(&self) -> u64 {
        self.json
            .get("timeoutSeconds")
            .and_then(Value::as_u64)
            .unwrap_or(60)
    }

    #[must_use]
    pub fn https_trigger(&self) -> Option<&Value> {
        self.json.get("httpsTrigger")
    }

    #[must_use]
    pub fn event_trigger(&self) -> Option<&Map<String, Value>> {
        self.json.get("eventTrigger").and_then(Value::as_object)
    }

    #[must_use]
    pub fn blocking_trigger(&self) -> Option<&Map<String, Value>> {
        self.json.get("blockingTrigger").and_then(Value::as_object)
    }

    #[must_use]
    pub fn schedule(&self) -> Option<&Map<String, Value>> {
        self.json.get("schedule").and_then(Value::as_object)
    }

    #[must_use]
    pub fn task_queue_trigger(&self) -> Option<&Value> {
        self.json.get("taskQueueTrigger")
    }

    #[must_use]
    pub fn secret_environment_variables(&self) -> Vec<(String, String)> {
        self.json
            .get("secretEnvironmentVariables")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| {
                        let key = entry.get("key")?.as_str()?;
                        let secret = entry.get("secret").and_then(Value::as_str).unwrap_or(key);
                        Some((key.to_owned(), secret.to_owned()))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// `getSignatureType`.
    #[must_use]
    pub fn signature(&self) -> Signature {
        if self.https_trigger().is_some() || self.blocking_trigger().is_some() {
            return Signature::Http;
        }
        if self.platform() == "gcfv2" && self.schedule().is_some() {
            return Signature::Http;
        }
        if self.platform() == "gcfv2" {
            Signature::CloudEvent
        } else {
            Signature::Event
        }
    }

    /// `getFunctionService`: the service an event trigger belongs to.
    #[must_use]
    pub fn service(&self) -> String {
        if let Some(event) = self.event_trigger() {
            if event.get("channel").and_then(Value::as_str).is_some() {
                return "eventarc.googleapis.com".to_owned();
            }
            if let Some(service) = event.get("service").and_then(Value::as_str) {
                return service.to_owned();
            }
            return service_from_event_type(
                event.get("eventType").and_then(Value::as_str).unwrap_or(""),
            )
            .to_owned();
        }
        if let Some(blocking) = self.blocking_trigger() {
            return blocking
                .get("eventType")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
        }
        if self.https_trigger().is_some() {
            return "https".to_owned();
        }
        if self.task_queue_trigger().is_some() {
            return "cloudtasks.googleapis.com".to_owned();
        }
        "unknown".to_owned()
    }

    /// Expands an extension's predefined definition into one definition per
    /// region (`emulatedFunctionsByRegion`).
    #[must_use]
    pub fn by_region(&self, secret_environment_variables: &[Value]) -> Vec<Self> {
        let regions: Vec<String> = self
            .json
            .get("regions")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .filter(|regions: &Vec<String>| !regions.is_empty())
            .unwrap_or_else(|| vec![DEFAULT_REGION.to_owned()]);
        regions
            .into_iter()
            .map(|region| {
                let mut copy = self.json.clone();
                copy.insert("regions".to_owned(), json!([region]));
                copy.insert("region".to_owned(), Value::String(region.clone()));
                copy.insert(
                    "id".to_owned(),
                    Value::String(format!("{region}-{}", self.name())),
                );
                if !copy.contains_key("platform") {
                    copy.insert("platform".to_owned(), Value::String("gcfv1".to_owned()));
                }
                copy.insert(
                    "secretEnvironmentVariables".to_owned(),
                    Value::Array(secret_environment_variables.to_vec()),
                );
                Self { json: copy }
            })
            .collect()
    }
}

/// `getServiceFromEventType`.
#[must_use]
pub fn service_from_event_type(event_type: &str) -> &'static str {
    const SERVICES: [(&str, &str); 10] = [
        ("firestore", "firestore.googleapis.com"),
        ("database", "firebasedatabase.googleapis.com"),
        ("pubsub", "pubsub.googleapis.com"),
        ("storage", "storage.googleapis.com"),
        ("firebasealerts", "firebasealerts.googleapis.com"),
        ("analytics", "analytics.googleapis.com"),
        ("auth", "firebaseauth.googleapis.com"),
        ("crashlytics", "crashlytics.googleapis.com"),
        ("remoteconfig", "firebaseremoteconfig.googleapis.com"),
        ("testing", "testing.googleapis.com"),
    ];
    SERVICES
        .iter()
        .find(|(needle, _)| event_type.contains(needle))
        .map_or("", |(_, service)| service)
}

/// Resolves `{{ params.NAME }}` references (standalone or embedded in a
/// string) against the user's dotenv values and the built-in project
/// parameters (`PROJECT_ID`, `GCLOUD_PROJECT`, `STORAGE_BUCKET`,
/// `DATABASE_URL`); anything the official CEL resolver would evaluate beyond
/// a plain reference is reported.
struct Resolver<'a> {
    values: &'a BTreeMap<String, String>,
    builtins: BTreeMap<String, String>,
}

impl Resolver<'_> {
    fn is_cel(value: &Value) -> bool {
        value
            .as_str()
            .is_some_and(|text| text.contains("{{") && text.contains("}}"))
    }

    fn lookup(&self, name: &str) -> Result<String, ManifestError> {
        self.values
            .get(name)
            .or_else(|| self.builtins.get(name))
            .cloned()
            .ok_or_else(|| ManifestError(format!("No value found for parameter {name}. Provide it in .env, .env.<project>, .env.local or .secret.local before starting the emulator.")))
    }

    fn interpolate(&self, text: &str) -> Result<String, ManifestError> {
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(start) = rest.find("{{") {
            out.push_str(&rest[..start]);
            let after = &rest[start + 2..];
            let Some(end) = after.find("}}") else {
                return Err(ManifestError(format!(
                    "Unterminated parameter expression in {text}"
                )));
            };
            let expression = after[..end].trim();
            let Some(name) = expression.strip_prefix("params.").map(str::trim) else {
                return Err(ManifestError(format!(
                    "Unsupported parameter expression {{{{ {expression} }}}} in {text}: the Firenook runtime resolves plain params.NAME references only"
                )));
            };
            if !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            {
                return Err(ManifestError(format!(
                    "Unsupported parameter expression {{{{ {expression} }}}} in {text}: the Firenook runtime resolves plain params.NAME references only"
                )));
            }
            out.push_str(&self.lookup(name)?);
            rest = &after[end + 2..];
        }
        out.push_str(rest);
        Ok(out)
    }

    fn resolve_string(&self, value: &Value) -> Result<Value, ManifestError> {
        if !Self::is_cel(value) {
            return Ok(value.clone());
        }
        Ok(Value::String(
            self.interpolate(value.as_str().unwrap_or(""))?,
        ))
    }

    fn resolve_int(&self, value: &Value) -> Result<Value, ManifestError> {
        if !Self::is_cel(value) {
            return Ok(value.clone());
        }
        let text = self.interpolate(value.as_str().unwrap_or(""))?;
        text.trim()
            .parse::<i64>()
            .map(Value::from)
            .map_err(|_| ManifestError(format!("Parameter value {text} is not an integer")))
    }

    fn resolve_boolean(&self, value: &Value) -> Result<Value, ManifestError> {
        if !Self::is_cel(value) {
            return Ok(value.clone());
        }
        let text = self.interpolate(value.as_str().unwrap_or(""))?;
        match text.trim() {
            "true" => Ok(Value::Bool(true)),
            "false" => Ok(Value::Bool(false)),
            other => Err(ManifestError(format!(
                "Parameter value {other:?} is not a boolean"
            ))),
        }
    }
}

/// Converts a `v1alpha1` manifest into emulated definitions for one codebase.
///
/// `values` are the user dotenv values (parameters resolve from them) and
/// `secret_values` the `.secret.local` keys; the returned definitions carry
/// the codebase id and are ordered as the manifest lists its endpoints, with
/// one entry per region.
pub fn definitions_from_manifest(
    manifest: &serde_norway::Value,
    project: &str,
    default_bucket: &str,
    codebase: &str,
    values: &BTreeMap<String, String>,
) -> Result<Vec<Definition>, ManifestError> {
    let spec_version = manifest
        .get("specVersion")
        .and_then(serde_norway::Value::as_str);
    match spec_version {
        None => {
            return Err(ManifestError(
                "Expect manifest yaml to specify a version number".to_owned(),
            ));
        }
        Some("v1alpha1") => {}
        Some(_) => {
            return Err(ManifestError(
                "It seems you are using a newer SDK than this version of the CLI can handle. Please update your CLI with `npm install -g firebase-tools`".to_owned(),
            ));
        }
    }
    // The YAML mapping keeps the manifest's endpoint order, which the official
    // emulator preserves in its inventory and trigger table.
    let endpoints = manifest
        .get("endpoints")
        .and_then(serde_norway::Value::as_mapping)
        .ok_or_else(|| ManifestError("Expected key endpoints".to_owned()))?;
    let resolver = Resolver {
        values,
        builtins: BTreeMap::from([
            ("PROJECT_ID".to_owned(), project.to_owned()),
            ("GCLOUD_PROJECT".to_owned(), project.to_owned()),
            ("STORAGE_BUCKET".to_owned(), default_bucket.to_owned()),
            (
                "DATABASE_URL".to_owned(),
                format!("https://{project}.firebaseio.com"),
            ),
        ]),
    };
    let mut grouped: Vec<(String, Definition)> = Vec::new();
    for (id, endpoint) in endpoints {
        let id = id
            .as_str()
            .ok_or_else(|| ManifestError("endpoint ids must be strings".to_owned()))?
            .to_owned();
        let endpoint: Value = serde_json::to_value(endpoint).map_err(|error| {
            ManifestError(format!("endpoints[{id}] is not JSON-compatible: {error}"))
        })?;
        let endpoint = endpoint
            .as_object()
            .ok_or_else(|| ManifestError(format!("endpoints[{id}] must be an object")))?;
        let id = &id;
        let trigger_keys = [
            "httpsTrigger",
            "dataConnectGraphqlTrigger",
            "callableTrigger",
            "eventTrigger",
            "scheduleTrigger",
            "taskQueueTrigger",
            "blockingTrigger",
        ];
        let trigger_count = trigger_keys
            .iter()
            .filter(|key| endpoint.contains_key(**key))
            .count();
        if trigger_count == 0 {
            return Err(ManifestError(format!("Expected trigger in endpoint {id}")));
        }
        if trigger_count > 1 {
            return Err(ManifestError(format!(
                "Multiple triggers defined for endpoint{id}"
            )));
        }
        if resolver
            .resolve_boolean(endpoint.get("omit").unwrap_or(&Value::Bool(false)))?
            .as_bool()
            .unwrap_or(false)
        {
            continue;
        }
        let entry_point = endpoint
            .get("entryPoint")
            .and_then(Value::as_str)
            .ok_or_else(|| ManifestError(format!("endpoints[{id}].entryPoint must be a string")))?;
        let platform = endpoint
            .get("platform")
            .and_then(Value::as_str)
            .unwrap_or("gcfv2");
        // `backend.of` groups endpoints by the declared region key (an
        // undeclared region is the `REGION_TBD` bucket) in first-appearance
        // order, and the inventory flattens those groups.
        let region_keys: Vec<String> = match endpoint.get("region") {
            None | Some(Value::Null) => vec![REGION_TBD.to_owned()],
            Some(Value::Array(values)) => values
                .iter()
                .map(|value| {
                    resolver
                        .resolve_string(value)
                        .map(|resolved| resolved.as_str().unwrap_or("").to_owned())
                })
                .collect::<Result<_, _>>()?,
            Some(value) => vec![
                resolver
                    .resolve_string(value)?
                    .as_str()
                    .unwrap_or("")
                    .to_owned(),
            ],
        };
        let regions: Vec<(String, String)> = region_keys
            .into_iter()
            .map(|key| {
                if key.is_empty() || key == REGION_TBD {
                    (key, DEFAULT_REGION.to_owned())
                } else {
                    (key.clone(), key)
                }
            })
            .collect();
        // Labels are one shared object across the region copies in the
        // official conversion; the source label is fixed after grouping (the
        // copy processed last in the flattened inventory wins for every copy).
        let labels: Map<String, Value> = endpoint
            .get("labels")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let secret_environment_variables = match endpoint.get("secretEnvironmentVariables") {
            Some(Value::Array(entries)) => Value::Array(
                entries
                    .iter()
                    .map(|entry| {
                        let key = entry.get("key").and_then(Value::as_str).unwrap_or("");
                        let secret = entry
                            .get("secret")
                            .and_then(Value::as_str)
                            .filter(|secret| !secret.is_empty())
                            .unwrap_or(key);
                        json!({"key": key, "secret": secret, "projectId": project})
                    })
                    .collect(),
            ),
            _ => Value::Array(Vec::new()),
        };
        let available_memory = match endpoint.get("availableMemoryMb") {
            None | Some(Value::Null) => 256,
            Some(value) => resolver.resolve_int(value)?.as_u64().unwrap_or(256),
        };
        let timeout = match endpoint.get("timeoutSeconds") {
            None | Some(Value::Null) => 60,
            Some(value) => resolver.resolve_int(value)?.as_u64().unwrap_or(60),
        };
        for (group_key, region) in regions {
            let mut definition = Map::new();
            definition.insert(
                "entryPoint".to_owned(),
                Value::String(entry_point.to_owned()),
            );
            definition.insert("platform".to_owned(), Value::String(platform.to_owned()));
            definition.insert("region".to_owned(), Value::String(region.clone()));
            definition.insert("name".to_owned(), Value::String((*id).clone()));
            definition.insert("id".to_owned(), Value::String(format!("{region}-{id}")));
            definition.insert("codebase".to_owned(), Value::String(codebase.to_owned()));
            definition.insert(
                "availableMemoryMb".to_owned(),
                Value::from(available_memory),
            );
            definition.insert("labels".to_owned(), Value::Object(labels.clone()));
            definition.insert("timeoutSeconds".to_owned(), Value::from(timeout));
            definition.insert(
                "secretEnvironmentVariables".to_owned(),
                secret_environment_variables.clone(),
            );
            let Some(trigger) =
                convert_trigger(endpoint, project, platform, &resolver, &mut definition)?
            else {
                // Unsupported v2 event service: dropped like the official
                // emulator (it never becomes a definition).
                continue;
            };
            if trigger
                && let Some(labels) = definition.get_mut("labels").and_then(Value::as_object_mut)
            {
                labels.insert(
                    "deployment-callable".to_owned(),
                    Value::String("true".to_owned()),
                );
            }
            grouped.push((group_key, Definition { json: definition }));
        }
    }
    let mut groups: Vec<(String, Vec<Definition>)> = Vec::new();
    for (key, definition) in grouped {
        match groups.iter_mut().find(|(existing, _)| *existing == key) {
            Some((_, members)) => members.push(definition),
            None => groups.push((key, vec![definition])),
        }
    }
    let mut definitions: Vec<Definition> = groups
        .into_iter()
        .flat_map(|(_, members)| members)
        .collect();
    let mut winning_region: BTreeMap<String, String> = BTreeMap::new();
    for definition in &definitions {
        winning_region.insert(definition.name().to_owned(), definition.region().to_owned());
    }
    for definition in &mut definitions {
        let region = winning_region
            .get(definition.name())
            .cloned()
            .unwrap_or_else(|| definition.region().to_owned());
        let name = definition.name().to_owned();
        let source_label = if definition.platform() == "gcfv1" {
            format!(
                "cloudfunctions-emulated.googleapis.com/projects/{project}/locations/{region}/functions/{name}"
            )
        } else {
            format!(
                "run-emulated.googleapis.com/projects/{project}/locations/{region}/services/{name}"
            )
        };
        if let Some(labels) = definition
            .json
            .get_mut("labels")
            .and_then(Value::as_object_mut)
        {
            labels.insert(
                EVENTARC_SOURCE_LABEL.to_owned(),
                Value::String(source_label),
            );
        }
    }
    Ok(definitions)
}

fn resolve_map(
    resolver: &Resolver<'_>,
    value: Option<&Value>,
) -> Result<Option<Value>, ManifestError> {
    match value {
        Some(Value::Object(map)) => {
            let mut out = Map::new();
            for (key, item) in map {
                out.insert(key.clone(), resolver.resolve_string(item)?);
            }
            Ok(Some(Value::Object(out)))
        }
        _ => Ok(None),
    }
}

fn resolve_ints(
    resolver: &Resolver<'_>,
    value: Option<&Value>,
    keys: &[&str],
) -> Result<Option<Value>, ManifestError> {
    match value {
        Some(Value::Object(map)) => {
            let mut out = Map::new();
            for key in keys {
                match map.get(*key) {
                    Some(Value::Null) => {
                        out.insert((*key).to_owned(), Value::Null);
                    }
                    Some(item) => {
                        out.insert((*key).to_owned(), resolver.resolve_int(item)?);
                    }
                    None => {}
                }
            }
            Ok(Some(Value::Object(out)))
        }
        Some(Value::Null) => Ok(Some(Value::Null)),
        _ => Ok(None),
    }
}

/// A JavaScript number as JSON: integral values print without a fraction.
fn number_value(number: f64) -> Value {
    if number.is_nan() {
        return Value::Null;
    }
    if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 {
        // Integral and below 2^53: the cast is exact.
        #[allow(clippy::cast_possible_truncation)]
        let integer = number as i64;
        json!(integer)
    } else {
        json!(number)
    }
}

/// Writes the trigger keys of one definition. Returns `Ok(None)` when the
/// endpoint must be dropped, `Ok(Some(is_callable))` otherwise.
fn convert_trigger(
    endpoint: &Map<String, Value>,
    project: &str,
    platform: &str,
    resolver: &Resolver<'_>,
    definition: &mut Map<String, Value>,
) -> Result<Option<bool>, ManifestError> {
    if let Some(https) = endpoint.get("httpsTrigger") {
        let mut trigger = Map::new();
        if let Some(invoker) = https.get("invoker") {
            trigger.insert("invoker".to_owned(), invoker.clone());
        }
        definition.insert("httpsTrigger".to_owned(), Value::Object(trigger));
        return Ok(Some(false));
    }
    if let Some(graphql) = endpoint.get("dataConnectGraphqlTrigger") {
        definition.insert("httpsTrigger".to_owned(), graphql.clone());
        return Ok(Some(false));
    }
    if endpoint.contains_key("callableTrigger") {
        definition.insert("httpsTrigger".to_owned(), Value::Object(Map::new()));
        return Ok(Some(true));
    }
    if let Some(event) = endpoint.get("eventTrigger").and_then(Value::as_object) {
        let event_type = event
            .get("eventType")
            .and_then(Value::as_str)
            .ok_or_else(|| ManifestError("Expected key eventTrigger.eventType".to_owned()))?;
        let mut filters = resolve_map(resolver, event.get("eventFilters"))?
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        if let Some(Value::String(topic)) = filters.get("topic").cloned()
            && !topic.starts_with("projects/")
        {
            filters.insert(
                "topic".to_owned(),
                Value::String(format!("projects/{project}/topics/{topic}")),
            );
        }
        let path_patterns = resolve_map(resolver, event.get("eventFilterPathPatterns"))?;
        let channel = match event.get("channel").and_then(Value::as_str) {
            Some(channel) => Some(resolve_channel_name(project, channel)?),
            None => None,
        };
        if platform == "gcfv1" {
            let resource = filters.get("resource").cloned().unwrap_or(Value::Null);
            let mut trigger = Map::new();
            trigger.insert("eventType".to_owned(), Value::String(event_type.to_owned()));
            trigger.insert("resource".to_owned(), resource);
            definition.insert("eventTrigger".to_owned(), Value::Object(trigger));
            return Ok(Some(false));
        }
        let implemented =
            V2_EVENTS.contains(&event_type) || V2_AUTH_CONTEXT_EVENTS.contains(&event_type);
        if !implemented && channel.is_none() {
            return Ok(None);
        }
        let resource = ["resource", "topic", "bucket"]
            .iter()
            .find_map(|key| filters.get(*key).cloned());
        let mut trigger = Map::new();
        trigger.insert("eventType".to_owned(), Value::String(event_type.to_owned()));
        if let Some(resource) = resource {
            trigger.insert("resource".to_owned(), resource);
        }
        if let Some(channel) = channel {
            trigger.insert("channel".to_owned(), Value::String(channel));
        }
        trigger.insert("eventFilters".to_owned(), Value::Object(filters));
        if let Some(patterns) = path_patterns {
            trigger.insert("eventFilterPathPatterns".to_owned(), patterns);
        }
        definition.insert("eventTrigger".to_owned(), Value::Object(trigger));
        return Ok(Some(false));
    }
    if let Some(schedule) = endpoint.get("scheduleTrigger").and_then(Value::as_object) {
        let mut trigger = Map::new();
        trigger.insert("eventType".to_owned(), Value::String("pubsub".to_owned()));
        trigger.insert("resource".to_owned(), Value::String(String::new()));
        definition.insert("eventTrigger".to_owned(), Value::Object(trigger));
        let mut out = Map::new();
        out.insert(
            "schedule".to_owned(),
            resolver.resolve_string(
                schedule
                    .get("schedule")
                    .unwrap_or(&Value::String(String::new())),
            )?,
        );
        match schedule.get("timeZone") {
            None => {
                out.insert("timeZone".to_owned(), Value::Null);
            }
            Some(value) => {
                out.insert("timeZone".to_owned(), resolver.resolve_string(value)?);
            }
        }
        // The v1alpha1 parser renames the v1 SDK's `*Duration` strings to
        // `*Seconds` numbers (null stays null) before the build resolves ints.
        let normalized_retry = schedule.get("retryConfig").map(|retry| match retry {
            Value::Object(map) => {
                let mut converted = Map::new();
                for (seconds, duration) in [
                    ("maxBackoffSeconds", "maxBackoffDuration"),
                    ("minBackoffSeconds", "minBackoffDuration"),
                    ("maxRetrySeconds", "maxRetryDuration"),
                ] {
                    match map.get(duration) {
                        Some(Value::Null) => {
                            converted.insert(seconds.to_owned(), Value::Null);
                        }
                        Some(Value::String(text)) => {
                            let number = text
                                .trim_end_matches('s')
                                .parse::<f64>()
                                .unwrap_or(f64::NAN);
                            converted.insert(seconds.to_owned(), number_value(number));
                        }
                        Some(other) => {
                            converted.insert(seconds.to_owned(), other.clone());
                        }
                        None => {}
                    }
                }
                for key in [
                    "retryCount",
                    "minBackoffSeconds",
                    "maxBackoffSeconds",
                    "maxRetrySeconds",
                    "maxDoublings",
                ] {
                    if let Some(value) = map.get(key) {
                        converted.insert(key.to_owned(), value.clone());
                    }
                }
                Value::Object(converted)
            }
            other => other.clone(),
        });
        if let Some(retry) = resolve_ints(
            resolver,
            normalized_retry.as_ref(),
            &[
                "maxBackoffSeconds",
                "minBackoffSeconds",
                "maxRetrySeconds",
                "retryCount",
                "maxDoublings",
            ],
        )? {
            out.insert("retryConfig".to_owned(), retry);
        }
        definition.insert("schedule".to_owned(), Value::Object(out));
        return Ok(Some(false));
    }
    if let Some(blocking) = endpoint.get("blockingTrigger").and_then(Value::as_object) {
        let event_type = blocking
            .get("eventType")
            .and_then(Value::as_str)
            .ok_or_else(|| ManifestError("Expected key blockingTrigger.eventType".to_owned()))?;
        let options = blocking
            .get("options")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));
        definition.insert(
            "blockingTrigger".to_owned(),
            json!({"eventType": event_type, "options": options}),
        );
        return Ok(Some(false));
    }
    if let Some(task_queue) = endpoint.get("taskQueueTrigger").and_then(Value::as_object) {
        definition.insert("httpsTrigger".to_owned(), Value::Object(Map::new()));
        let retry = resolve_ints(
            resolver,
            task_queue.get("retryConfig"),
            &[
                "maxAttempts",
                "maxRetrySeconds",
                "maxBackoffSeconds",
                "maxDoublings",
                "minBackoffSeconds",
            ],
        )?;
        let limits = resolve_ints(
            resolver,
            task_queue.get("rateLimits"),
            &["maxConcurrentDispatches", "maxDispatchesPerSecond"],
        )?;
        let mut trigger = Map::new();
        trigger.insert(
            "retryConfig".to_owned(),
            task_queue_block(
                retry,
                &[
                    "maxAttempts",
                    "maxRetrySeconds",
                    "maxBackoffSeconds",
                    "maxDoublings",
                    "minBackoffSeconds",
                ],
            ),
        );
        trigger.insert(
            "rateLimits".to_owned(),
            task_queue_block(
                limits,
                &["maxConcurrentDispatches", "maxDispatchesPerSecond"],
            ),
        );
        definition.insert("taskQueueTrigger".to_owned(), Value::Object(trigger));
        return Ok(Some(false));
    }
    Err(ManifestError(
        "Do not recognize trigger type for endpoint. Try upgrading firebase-tools with npm install -g firebase-tools@latest".to_owned(),
    ))
}

/// The official emulated task-queue block: every key present, `null` when
/// the manifest gave nothing (JSON drops `undefined`, keeps `null`).
fn task_queue_block(source: Option<Value>, keys: &[&str]) -> Value {
    let map = source
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let mut out = Map::new();
    for key in keys {
        if let Some(value) = map.get(*key) {
            out.insert((*key).to_owned(), value.clone());
        }
    }
    Value::Object(out)
}

fn resolve_channel_name(project: &str, channel: &str) -> Result<String, ManifestError> {
    if !channel.contains('/') {
        return Ok(format!(
            "projects/{project}/locations/{DEFAULT_REGION}/channels/{channel}"
        ));
    }
    let parts: Vec<&str> = channel.split('/').collect();
    match parts.as_slice() {
        [
            "projects",
            matched_project,
            "locations",
            location,
            "channels",
            channel_id,
        ] => Ok(format!(
            "projects/{matched_project}/locations/{location}/channels/{channel_id}"
        )),
        ["locations", location, "channels", channel_id] => Ok(format!(
            "projects/{project}/locations/{location}/channels/{channel_id}"
        )),
        _ => Err(ManifestError("Invalid channel name format.".to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(endpoint: &Value) -> serde_norway::Value {
        yaml(&json!({"specVersion": "v1alpha1", "endpoints": {"fn": endpoint}}))
    }

    fn yaml(value: &Value) -> serde_norway::Value {
        serde_norway::from_str(&value.to_string()).unwrap()
    }

    #[test]
    fn https_and_callable_definitions_match_the_recorded_shape() {
        let definitions = definitions_from_manifest(
            &manifest(&json!({"platform": "gcfv2", "entryPoint": "fn", "callableTrigger": {}, "availableMemoryMb": null, "timeoutSeconds": null})),
            "demo-p",
            "demo-p.appspot.com",
            "primary",
            &BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(definitions.len(), 1);
        let json = Value::Object(definitions[0].json().clone());
        assert_eq!(
            json,
            json!({"entryPoint":"fn","platform":"gcfv2","region":"us-central1","name":"fn","id":"us-central1-fn","codebase":"primary","availableMemoryMb":256,"labels":{"EVENTARC_CLOUD_EVENT_SOURCE":"run-emulated.googleapis.com/projects/demo-p/locations/us-central1/services/fn","deployment-callable":"true"},"timeoutSeconds":60,"secretEnvironmentVariables":[],"httpsTrigger":{}})
        );
        assert_eq!(definitions[0].signature(), Signature::Http);
    }

    #[test]
    fn multi_region_endpoints_share_the_last_region_source_label() {
        let definitions = definitions_from_manifest(
            &manifest(&json!({"platform": "gcfv2", "entryPoint": "fn", "region": ["europe-west1", "us-central1"], "httpsTrigger": {}})),
            "demo-p",
            "demo-p.appspot.com",
            "primary",
            &BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(definitions.len(), 2);
        assert_eq!(definitions[0].id(), "europe-west1-fn");
        assert_eq!(definitions[1].id(), "us-central1-fn");
        for definition in &definitions {
            assert!(
                definition.json()["labels"]["EVENTARC_CLOUD_EVENT_SOURCE"]
                    .as_str()
                    .unwrap()
                    .contains("/locations/us-central1/")
            );
        }
    }

    #[test]
    fn firestore_and_schedule_definitions() {
        // A JSON text keeps the endpoint order the SDK serves.
        let text = r#"{"specVersion": "v1alpha1", "endpoints": {
                "doc": {"platform": "gcfv2", "entryPoint": "doc", "eventTrigger": {"eventType": "google.cloud.firestore.document.v1.created", "eventFilters": {"database": "(default)", "namespace": "(default)"}, "eventFilterPathPatterns": {"document": "items/{itemId}"}, "retry": false}},
                "tick": {"platform": "gcfv2", "entryPoint": "tick", "scheduleTrigger": {"schedule": "every 5 minutes", "retryConfig": {"maxBackoffSeconds": null, "minBackoffSeconds": null, "maxRetrySeconds": null, "retryCount": null, "maxDoublings": null}}},
                "legacy": {"platform": "gcfv1", "entryPoint": "legacy", "eventTrigger": {"eventType": "providers/cloud.firestore/eventTypes/document.create", "eventFilters": {"resource": "projects/{{ params.PROJECT_ID }}/databases/(default)/documents/legacy/{id}"}, "retry": false}},
                "db": {"platform": "gcfv2", "entryPoint": "db", "eventTrigger": {"eventType": "google.firebase.database.ref.v1.written", "eventFilters": {}, "eventFilterPathPatterns": {"ref": "synthetic/{id}", "instance": "*"}, "retry": false}},
                "unsupported": {"platform": "gcfv2", "entryPoint": "u", "eventTrigger": {"eventType": "google.firebase.remoteconfig.v1.updated", "eventFilters": {}, "retry": false}}
            }}"#;
        let definitions = definitions_from_manifest(
            &serde_norway::from_str(text).unwrap(),
            "demo-p",
            "demo-p.appspot.com",
            "primary",
            &BTreeMap::new(),
        )
        .unwrap();
        let ids: Vec<String> = definitions.iter().map(Definition::id).collect();
        assert_eq!(
            ids,
            [
                "us-central1-doc",
                "us-central1-tick",
                "us-central1-legacy",
                "us-central1-db"
            ]
        );
        assert_eq!(
            definitions[0].json()["eventTrigger"],
            json!({"eventType": "google.cloud.firestore.document.v1.created", "eventFilters": {"database": "(default)", "namespace": "(default)"}, "eventFilterPathPatterns": {"document": "items/{itemId}"}})
        );
        assert_eq!(definitions[0].signature(), Signature::CloudEvent);
        assert_eq!(
            definitions[1].json()["eventTrigger"],
            json!({"eventType": "pubsub", "resource": ""})
        );
        assert_eq!(
            definitions[1].json()["schedule"],
            json!({"schedule": "every 5 minutes", "timeZone": null, "retryConfig": {"maxBackoffSeconds": null, "minBackoffSeconds": null, "maxRetrySeconds": null, "retryCount": null, "maxDoublings": null}})
        );
        assert_eq!(definitions[1].signature(), Signature::Http);
        assert_eq!(
            definitions[2].json()["eventTrigger"],
            json!({"eventType": "providers/cloud.firestore/eventTypes/document.create", "resource": "projects/demo-p/databases/(default)/documents/legacy/{id}"})
        );
        assert_eq!(definitions[2].signature(), Signature::Event);
        assert_eq!(
            definitions[3].json()["eventTrigger"],
            json!({"eventType": "google.firebase.database.ref.v1.written", "eventFilters": {}, "eventFilterPathPatterns": {"ref": "synthetic/{id}", "instance": "*"}})
        );
    }

    #[test]
    fn extension_definitions_expand_per_region() {
        let predefined = Definition::from_json(
            json!({"name": "ext-x-fn", "entryPoint": "fn", "platform": "gcfv1", "regions": ["us-central1"], "httpsTrigger": {}})
                .as_object()
                .cloned()
                .unwrap(),
        );
        let expanded = predefined.by_region(&[]);
        assert_eq!(expanded.len(), 1);
        assert_eq!(expanded[0].id(), "us-central1-ext-x-fn");
        assert_eq!(expanded[0].region(), "us-central1");
        assert_eq!(expanded[0].signature(), Signature::Http);
    }
}
