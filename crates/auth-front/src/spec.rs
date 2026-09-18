//! The Identity Toolkit `OpenAPI` document the official emulator routes and
//! validates requests with (its `apiSpec.ts`, bundled verbatim), and the
//! routing, security and validation behaviour it derives from it.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde_json::{Map as JsonMap, Value as JsonValue, json};

use crate::error::ApiError;

const OPENAPI: &str = include_str!("../spec/openapi.json");

/// The parsed document.
pub static SPEC: LazyLock<Spec> = LazyLock::new(Spec::load);

#[derive(Debug, Clone, PartialEq, Eq)]
enum Segment {
    Literal(String),
    /// `{name}` optionally followed by a literal suffix such as `:createSessionCookie`.
    Parameter {
        name: String,
        suffix: String,
    },
}

#[derive(Debug, Clone)]
pub struct Parameter {
    pub name: String,
    pub schema: JsonValue,
}

#[derive(Debug, Clone)]
pub struct Operation {
    pub operation_id: String,
    pub method: String,
    /// Names of the security schemes any of which authenticates the call.
    pub security: Vec<String>,
    pub body_schema: Option<JsonValue>,
    pub body_content_types: Vec<String>,
    pub query_parameters: Vec<Parameter>,
}

#[derive(Debug, Clone)]
struct Route {
    /// The mounted path, e.g. `/identitytoolkit.googleapis.com/v1/accounts:signUp`.
    mounted: String,
    /// The unmounted template as it appears in the document.
    template: String,
    segments: Vec<Segment>,
    operations: BTreeMap<String, Operation>,
}

pub struct Spec {
    document: JsonValue,
    routes: Vec<Route>,
}

/// The `paths` object in document order.
#[derive(serde::Deserialize)]
struct PathOrder {
    paths: indexmap::IndexMap<String, JsonValue>,
}

/// A matched route with its path parameters.
pub struct Matched<'a> {
    pub operation: Option<&'a Operation>,
    pub allowed_methods: Vec<String>,
    pub path_parameters: BTreeMap<String, String>,
    pub template: &'a str,
}

impl Spec {
    fn load() -> Self {
        let document: JsonValue =
            serde_json::from_str(OPENAPI).expect("bundled OpenAPI document parses");
        let default_server = document["servers"][0]["url"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        // Exegesis registers dynamic paths in document order and lets the
        // last match win, so keep that order rather than the sorted map's.
        let ordered: PathOrder =
            serde_json::from_str(OPENAPI).expect("bundled OpenAPI document parses");
        let mut routes = Vec::new();
        for (path, item) in &ordered.paths {
            let server = item["servers"][0]["url"]
                .as_str()
                .map_or(default_server.clone(), str::to_owned);
            let mounted = format!("{}{}", server.replace("https://", "/"), path);
            let mut operations = BTreeMap::new();
            for (method, op) in item.as_object().into_iter().flatten() {
                let Some(operation_id) = op["operationId"].as_str() else {
                    continue;
                };
                let security = op["security"]
                    .as_array()
                    .map(|entries| {
                        entries
                            .iter()
                            .filter_map(|entry| entry.as_object())
                            .flat_map(|entry| entry.keys().cloned())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let (body_schema, body_content_types) = resolve_body(&document, &op["requestBody"]);
                let query_parameters = op["parameters"]
                    .as_array()
                    .map(|parameters| {
                        parameters
                            .iter()
                            .filter(|parameter| parameter["in"] == "query")
                            .map(|parameter| Parameter {
                                name: parameter["name"].as_str().unwrap_or_default().to_owned(),
                                schema: parameter["schema"].clone(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                operations.insert(
                    method.to_uppercase(),
                    Operation {
                        operation_id: operation_id.to_owned(),
                        method: method.to_uppercase(),
                        security,
                        body_schema,
                        body_content_types,
                        query_parameters,
                    },
                );
            }
            routes.push(Route {
                segments: parse_segments(&mounted),
                mounted,
                template: path.clone(),
                operations,
            });
        }
        Self { document, routes }
    }

    /// Finds the route for `path` (no query string) and the operation for `method`.
    #[must_use]
    pub fn match_route(&self, method: &str, path: &str) -> Option<Matched<'_>> {
        // Exegesis: a static path matches exactly; otherwise every template is
        // tried with `([^/]*)` per parameter and the last match wins.
        let request_segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        let mut best: Option<(&Route, BTreeMap<String, String>)> = None;
        for route in &self.routes {
            if route.segments.len() != request_segments.len() {
                continue;
            }
            let mut parameters = BTreeMap::new();
            let mut matched = true;
            for (segment, actual) in route.segments.iter().zip(&request_segments) {
                match segment {
                    Segment::Literal(literal) => {
                        if literal != actual {
                            matched = false;
                            break;
                        }
                    }
                    Segment::Parameter { name, suffix } => {
                        let Some(value) = actual.strip_suffix(suffix.as_str()) else {
                            matched = false;
                            break;
                        };
                        parameters.insert(name.clone(), percent_decode(value));
                    }
                }
            }
            if !matched {
                continue;
            }
            if parameters.is_empty() {
                best = Some((route, parameters));
                break;
            }
            best = Some((route, parameters));
        }
        best.map(|(route, parameters)| Matched {
            operation: route.operations.get(method),
            allowed_methods: route.operations.keys().cloned().collect(),
            path_parameters: parameters,
            template: &route.template,
        })
    }

    /// The document as `GET /emulator/openapi.json` serves it: every server
    /// URL gains the `{EMULATOR}` variable pointing at this emulator.
    #[must_use]
    pub fn served_document(&self, protocol: &str, host: Option<&str>) -> JsonValue {
        let mut document = self.document.clone();
        let default_host = host
            .map(|host| format!("{protocol}://{host}"))
            .unwrap_or_default();
        let servers_with_emulators = |servers: &JsonValue| -> JsonValue {
            let mut result = Vec::new();
            for server in servers.as_array().into_iter().flatten() {
                let url = server["url"].as_str().unwrap_or_default();
                let rewritten = if url.is_empty() {
                    "{EMULATOR}".to_owned()
                } else {
                    url.replace("https://", "{EMULATOR}/")
                };
                result.push(json!({
                    "url": rewritten,
                    "variables": {
                        "EMULATOR": {
                            "default": default_host,
                            "description": "The protocol, hostname, and port of Firebase Auth Emulator.",
                        }
                    }
                }));
                if !url.is_empty() {
                    result.push(server.clone());
                }
            }
            JsonValue::Array(result)
        };
        if let Some(paths) = document["paths"].as_object_mut() {
            for item in paths.values_mut() {
                if let Some(servers) = item.get("servers").cloned() {
                    item["servers"] = servers_with_emulators(&servers);
                }
            }
        }
        let servers = document["servers"].clone();
        document["servers"] = servers_with_emulators(&servers);
        document
    }

    pub fn mounted_paths(&self) -> impl Iterator<Item = &str> {
        self.routes.iter().map(|route| route.mounted.as_str())
    }
}

fn resolve_body(document: &JsonValue, body: &JsonValue) -> (Option<JsonValue>, Vec<String>) {
    let body = if let Some(reference) = body["$ref"].as_str() {
        resolve_reference(document, reference)
    } else {
        body.clone()
    };
    let Some(content) = body["content"].as_object() else {
        return (None, Vec::new());
    };
    let content_types: Vec<String> = content.keys().cloned().collect();
    let schema = content
        .get("application/json")
        .map(|entry| resolve_schema(document, &entry["schema"]));
    (schema, content_types)
}

fn resolve_reference(document: &JsonValue, reference: &str) -> JsonValue {
    let mut current = document;
    for part in reference.trim_start_matches("#/").split('/') {
        current = &current[part];
    }
    current.clone()
}

/// Resolves `$ref`s recursively into a self-contained schema.
fn resolve_schema(document: &JsonValue, schema: &JsonValue) -> JsonValue {
    if let Some(reference) = schema["$ref"].as_str() {
        return resolve_schema(document, &resolve_reference(document, reference));
    }
    let mut resolved = schema.clone();
    if let Some(properties) = resolved["properties"].as_object().cloned() {
        let mut out = JsonMap::new();
        for (name, property) in properties {
            out.insert(name, resolve_schema(document, &property));
        }
        resolved["properties"] = JsonValue::Object(out);
    }
    if resolved.get("items").is_some() {
        let items = resolve_schema(document, &resolved["items"]);
        resolved["items"] = items;
    }
    if resolved
        .get("additionalProperties")
        .is_some_and(JsonValue::is_object)
    {
        let additional = resolve_schema(document, &resolved["additionalProperties"]);
        resolved["additionalProperties"] = additional;
    }
    resolved
}

fn parse_segments(mounted: &str) -> Vec<Segment> {
    mounted
        .trim_start_matches('/')
        .split('/')
        .map(|segment| {
            if let Some(rest) = segment.strip_prefix('{')
                && let Some(end) = rest.find('}')
            {
                Segment::Parameter {
                    name: rest[..end].to_owned(),
                    suffix: rest[end + 1..].to_owned(),
                }
            } else {
                Segment::Literal(segment.to_owned())
            }
        })
        .collect()
}

fn percent_decode(value: &str) -> String {
    url::form_urlencoded::parse(value.replace('+', "%2B").as_bytes())
        .next()
        .map_or_else(|| value.to_owned(), |(key, _)| key.into_owned())
}

/// `convertKeysToCamelCase` with lodash's `camelCase` on every key.
#[must_use]
pub fn camel_case_keys(value: JsonValue) -> JsonValue {
    match value {
        JsonValue::Array(items) => {
            JsonValue::Array(items.into_iter().map(camel_case_keys).collect())
        }
        JsonValue::Object(object) => JsonValue::Object(
            object
                .into_iter()
                .map(|(key, item)| (camel_case(&key), camel_case_keys(item)))
                .collect(),
        ),
        other => other,
    }
}

/// lodash `camelCase`: words split on non-alphanumerics and case changes,
/// first word lower-cased, the rest capitalized.
#[must_use]
pub fn camel_case(text: &str) -> String {
    let words = split_words(text);
    let mut output = String::new();
    for (index, word) in words.iter().enumerate() {
        let lower = word.to_lowercase();
        if index == 0 {
            output.push_str(&lower);
        } else {
            let mut chars = lower.chars();
            if let Some(first) = chars.next() {
                output.extend(first.to_uppercase());
                output.push_str(chars.as_str());
            }
        }
    }
    output
}

fn split_words(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = text.chars().collect();
    for (index, character) in chars.iter().enumerate() {
        if !character.is_alphanumeric() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            continue;
        }
        if !current.is_empty() {
            let previous = chars[index - 1];
            let boundary = (previous.is_lowercase() && character.is_uppercase())
                || (previous.is_ascii_digit() != character.is_ascii_digit())
                || (previous.is_uppercase()
                    && character.is_uppercase()
                    && chars.get(index + 1).is_some_and(|next| next.is_lowercase()));
            if boundary {
                words.push(std::mem::take(&mut current));
            }
        }
        current.push(*character);
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

/// `validateAndFixRestMappingRequestBody`: coerces what the REST mapping
/// allows (numbers to strings, enum indexes to names), then validates the
/// body against the operation's schema and returns the first ajv-style error.
pub fn validate_body(schema: &JsonValue, body: &mut JsonValue) -> Result<(), ApiError> {
    loop {
        let mut errors = Vec::new();
        validate_value(schema, body, "", &mut errors);
        if errors.is_empty() {
            return Ok(());
        }
        let mut fixed = false;
        for error in &errors {
            if let Some(fix) = &error.fix
                && let Some(target) = pointer_mut(body, &error.path)
            {
                *target = fix.clone();
                fixed = true;
            }
        }
        if !fixed {
            let first = &errors[0];
            return Err(ApiError::invalid_argument(format!(
                "Invalid JSON payload received. {} {}",
                first.path, first.message
            )));
        }
    }
}

/// Validates one query parameter as exegesis coerces and validates it.
pub fn validate_query_parameter(schema: &JsonValue, raw: &str) -> Result<JsonValue, ApiError> {
    match schema["type"].as_str() {
        Some("integer") => raw.parse::<i64>().map(|value| json!(value)).map_err(|_| {
            ApiError::invalid_argument("Invalid JSON payload received.  must be integer")
        }),
        Some("boolean") => match raw {
            "true" => Ok(json!(true)),
            "false" => Ok(json!(false)),
            _ => Err(ApiError::invalid_argument(
                "Invalid JSON payload received.  must be boolean",
            )),
        },
        _ => {
            if let Some(allowed) = schema["enum"].as_array()
                && !allowed.iter().any(|value| value.as_str() == Some(raw))
            {
                return Err(ApiError::invalid_argument(
                    "Invalid JSON payload received.  must be equal to one of the allowed values",
                ));
            }
            Ok(json!(raw))
        }
    }
}

struct ValidationError {
    path: String,
    message: String,
    fix: Option<JsonValue>,
}

fn validate_value(
    schema: &JsonValue,
    value: &JsonValue,
    path: &str,
    errors: &mut Vec<ValidationError>,
) {
    let expected = schema["type"].as_str();
    match expected {
        Some("string") => match value {
            JsonValue::String(text) => {
                if let Some(allowed) = schema["enum"].as_array()
                    && !allowed.iter().any(|candidate| candidate == value)
                {
                    errors.push(ValidationError {
                        path: path.to_owned(),
                        message: "must be equal to one of the allowed values".to_owned(),
                        fix: None,
                    });
                }
                let _ = text;
            }
            JsonValue::Number(number) => {
                // Numbers coerce to strings; enum members may be addressed by index.
                let fix = if let Some(allowed) = schema["enum"].as_array() {
                    number
                        .as_u64()
                        .and_then(|index| allowed.get(usize::try_from(index).unwrap_or(usize::MAX)))
                        .cloned()
                } else {
                    Some(json!(number.to_string()))
                };
                errors.push(ValidationError {
                    path: path.to_owned(),
                    message: if schema["enum"].is_array() {
                        "must be equal to one of the allowed values".to_owned()
                    } else {
                        "must be string".to_owned()
                    },
                    fix,
                });
            }
            _ => errors.push(ValidationError {
                path: path.to_owned(),
                message: "must be string".to_owned(),
                fix: None,
            }),
        },
        Some("boolean") => {
            if !value.is_boolean() {
                errors.push(ValidationError {
                    path: path.to_owned(),
                    message: "must be boolean".to_owned(),
                    fix: None,
                });
            }
        }
        Some("integer") => {
            if value.as_i64().is_none()
                && !value.as_f64().is_some_and(|number| number.fract() == 0.0)
            {
                errors.push(ValidationError {
                    path: path.to_owned(),
                    message: "must be integer".to_owned(),
                    fix: None,
                });
            }
        }
        Some("number") => {
            if !value.is_number() {
                errors.push(ValidationError {
                    path: path.to_owned(),
                    message: "must be number".to_owned(),
                    fix: None,
                });
            }
        }
        Some("array") => match value.as_array() {
            Some(items) => {
                for (index, item) in items.iter().enumerate() {
                    validate_value(&schema["items"], item, &format!("{path}/{index}"), errors);
                }
            }
            None => errors.push(ValidationError {
                path: path.to_owned(),
                message: "must be array".to_owned(),
                fix: None,
            }),
        },
        Some("object") => match value.as_object() {
            Some(object) => {
                if let Some(properties) = schema["properties"].as_object() {
                    for (name, property) in properties {
                        if let Some(child) = object.get(name) {
                            validate_value(property, child, &format!("{path}/{name}"), errors);
                        }
                    }
                }
                if let Some(additional) = schema
                    .get("additionalProperties")
                    .filter(|value| value.is_object())
                {
                    let known: Vec<&String> = schema["properties"]
                        .as_object()
                        .map(|properties| properties.keys().collect())
                        .unwrap_or_default();
                    for (name, child) in object {
                        if !known.contains(&name) {
                            validate_value(additional, child, &format!("{path}/{name}"), errors);
                        }
                    }
                }
            }
            None => errors.push(ValidationError {
                path: path.to_owned(),
                message: "must be object".to_owned(),
                fix: None,
            }),
        },
        _ => {}
    }
}

fn pointer_mut<'a>(value: &'a mut JsonValue, pointer: &str) -> Option<&'a mut JsonValue> {
    if pointer.is_empty() {
        return Some(value);
    }
    value.pointer_mut(pointer)
}
