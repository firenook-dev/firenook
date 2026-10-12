//! Avro schema handling: definitions parse with `apache-avro`, JSON-encoded
//! messages are checked against the Avro JSON encoding (unions as
//! `{"type": value}`, every record field present) and binary messages decode
//! as a single datum, the way the official emulator's Java Avro does.
//!
//! The console's diagnostics stand on the same code: [`explain_json`] is the
//! check the wire runs, reporting the first mismatch with its JSON path, so
//! the path the console shows and the engine's answer cannot disagree;
//! [`definition_problem`] gives the parser's own reason for a definition the
//! wire refuses; [`encode_json`] writes checked JSON as Avro binary, and
//! [`example_json`] makes a message a definition accepts.

use std::collections::{BTreeSet, HashMap};

use apache_avro::Schema;
use apache_avro::schema::{Name, ResolvedSchema, UuidSchema};
use apache_avro::types::Value as AvroValue;
use serde_json::Value as JsonValue;

use crate::error::PubsubError;

/// Parses an Avro definition or fails with the official message.
pub fn parse_definition(definition: &str) -> Result<Schema, PubsubError> {
    if definition.trim().is_empty() {
        return Err(PubsubError::invalid_argument(
            "Could not parse schema definition",
        ));
    }
    Schema::parse_str(definition)
        .map_err(|_| PubsubError::invalid_argument("Could not parse schema definition"))
}

/// Why a definition does not parse, in the parser's words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefinitionProblem {
    pub reason: String,
    /// One-based, for a JSON syntax error.
    pub line: Option<u32>,
    pub column: Option<u32>,
}

/// The reason [`parse_definition`] refuses `definition`, or `None` when it
/// parses: the JSON parser's (with its line and column) for text that is not
/// JSON, else apache-avro's.
#[must_use]
pub fn definition_problem(definition: &str) -> Option<DefinitionProblem> {
    if definition.trim().is_empty() {
        return Some(DefinitionProblem {
            reason: "The definition is empty.".to_owned(),
            line: None,
            column: None,
        });
    }
    if let Err(error) = serde_json::from_str::<JsonValue>(definition) {
        return Some(DefinitionProblem {
            reason: syntax_reason(&error),
            line: u32::try_from(error.line()).ok(),
            column: u32::try_from(error.column()).ok(),
        });
    }
    Schema::parse_str(definition)
        .err()
        .map(|error| DefinitionProblem {
            reason: error.to_string(),
            line: None,
            column: None,
        })
}

/// `serde_json`'s message without its trailing position (given apart).
fn syntax_reason(error: &serde_json::Error) -> String {
    let text = error.to_string();
    match text.rfind(" at line ") {
        Some(position) => text[..position].to_owned(),
        None => text,
    }
}

/// Where and how a JSON message misses its schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonProblem {
    /// A JSON path into the message, `$.items[2].price`.
    pub path: String,
    /// What the schema wants there.
    pub expected: String,
    /// What the message has there.
    pub found: String,
}

/// Checks a JSON-encoded datum against the schema.
pub fn validate_json(schema: &Schema, message: &[u8]) -> Result<(), PubsubError> {
    explain_json(schema, message)
        .map_err(|_| PubsubError::invalid_argument("Could not parse JSON Avro message"))
}

/// The check [`validate_json`] makes, with the first mismatch and its path.
pub fn explain_json(schema: &Schema, message: &[u8]) -> Result<(), JsonProblem> {
    let value: JsonValue = serde_json::from_slice(message).map_err(|error| JsonProblem {
        path: "$".to_owned(),
        expected: "JSON".to_owned(),
        found: format!("text that does not parse ({})", syntax_reason(&error)),
    })?;
    let resolved = ResolvedSchema::try_from(schema).map_err(|error| JsonProblem {
        path: "$".to_owned(),
        expected: "a schema whose named types resolve".to_owned(),
        found: error.to_string(),
    })?;
    check(schema, &value, &resolved, None, &mut String::from("$"))
}

/// Checks a binary-encoded datum against the schema.
pub fn validate_binary(schema: &Schema, message: &[u8]) -> Result<(), PubsubError> {
    let failure = || PubsubError::invalid_argument("Could not parse binary Avro message");
    let mut reader = std::io::Cursor::new(message);
    apache_avro::reader::datum::GenericDatumReader::builder(schema)
        .build()
        .map_err(|_| failure())?
        .read_value(&mut reader)
        .map_err(|_| failure())?;
    // A trailing byte means the datum did not consume the whole message.
    if usize::try_from(reader.position()).unwrap_or(usize::MAX) != message.len() {
        return Err(failure());
    }
    Ok(())
}

fn problem(path: &str, expected: impl Into<String>, found: &JsonValue) -> JsonProblem {
    JsonProblem {
        path: path.to_owned(),
        expected: expected.into(),
        found: describe(found),
    }
}

/// A JSON value in a few words.
fn describe(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "null".to_owned(),
        JsonValue::Bool(flag) => format!("boolean {flag}"),
        JsonValue::Number(number) => format!("number {number}"),
        JsonValue::String(text) => {
            let shown: String = text.chars().take(40).collect();
            if shown.len() < text.len() {
                format!("string \"{shown}…\"")
            } else {
                format!("string \"{shown}\"")
            }
        }
        JsonValue::Array(items) => format!("an array of {}", items.len()),
        JsonValue::Object(entries) => match entries.len() {
            0 => "an empty object".to_owned(),
            1 => format!(
                "an object with key \"{}\"",
                entries.keys().next().map_or("", String::as_str)
            ),
            count => format!("an object with {count} keys"),
        },
    }
}

/// `path` with an array index added.
fn push_index(path: &mut String, index: usize) {
    path.push('[');
    path.push_str(&index.to_string());
    path.push(']');
}

/// `path` with an object key added.
fn push_key(path: &mut String, key: &str) -> usize {
    let length = path.len();
    if !key.is_empty()
        && key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        path.push('.');
        path.push_str(key);
    } else {
        path.push('[');
        path.push_str(&serde_json::to_string(key).unwrap_or_default());
        path.push(']');
    }
    length
}

#[allow(clippy::too_many_lines)]
fn check(
    schema: &Schema,
    value: &JsonValue,
    resolved: &ResolvedSchema<'_>,
    namespace: Option<&str>,
    path: &mut String,
) -> Result<(), JsonProblem> {
    let mismatch = |expected: &str| Err(problem(path, expected, value));
    match schema {
        Schema::Null => {
            if value.is_null() {
                Ok(())
            } else {
                mismatch("null")
            }
        }
        Schema::Boolean => {
            if value.is_boolean() {
                Ok(())
            } else {
                mismatch("a boolean")
            }
        }
        Schema::Int | Schema::Date | Schema::TimeMillis => {
            if value
                .as_i64()
                .is_some_and(|number| i32::try_from(number).is_ok())
            {
                Ok(())
            } else {
                mismatch("an int (a whole number that fits in 32 bits)")
            }
        }
        Schema::Long
        | Schema::TimeMicros
        | Schema::TimestampMillis
        | Schema::TimestampMicros
        | Schema::TimestampNanos
        | Schema::LocalTimestampMillis
        | Schema::LocalTimestampMicros
        | Schema::LocalTimestampNanos => {
            if value.as_i64().is_some() {
                Ok(())
            } else {
                mismatch("a long (a whole number that fits in 64 bits)")
            }
        }
        Schema::Float | Schema::Double => {
            if value.is_number() {
                Ok(())
            } else {
                mismatch("a number")
            }
        }
        Schema::Bytes
        | Schema::String
        | Schema::BigDecimal
        | Schema::Uuid(_)
        | Schema::Decimal(_) => {
            if value.is_string() {
                Ok(())
            } else {
                mismatch(&format!("{} (a string)", type_word(schema)))
            }
        }
        Schema::Duration(fixed) | Schema::Fixed(fixed) => {
            if value
                .as_str()
                .is_some_and(|text| text.chars().count() == fixed.size)
            {
                Ok(())
            } else {
                mismatch(&format!(
                    "fixed {} (a string of exactly {} characters)",
                    fixed.name.fullname(namespace),
                    fixed.size
                ))
            }
        }
        Schema::Array(array) => {
            let Some(items) = value.as_array() else {
                return mismatch("an array");
            };
            for (index, item) in items.iter().enumerate() {
                let length = path.len();
                push_index(path, index);
                check(&array.items, item, resolved, namespace, path)?;
                path.truncate(length);
            }
            Ok(())
        }
        Schema::Map(map) => {
            let Some(entries) = value.as_object() else {
                return mismatch("a map (an object)");
            };
            for (key, item) in entries {
                let length = push_key(path, key);
                check(&map.types, item, resolved, namespace, path)?;
                path.truncate(length);
            }
            Ok(())
        }
        Schema::Union(union) => {
            let branches = || {
                union
                    .variants()
                    .iter()
                    .filter_map(|variant| json_type_name(variant, resolved, namespace))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            if value.is_null() {
                return if union
                    .variants()
                    .iter()
                    .any(|variant| matches!(variant, Schema::Null))
                {
                    Ok(())
                } else {
                    mismatch(&format!(
                        "one of {} (written as {{\"type\": value}})",
                        branches()
                    ))
                };
            }
            let Some(object) = value.as_object().filter(|object| object.len() == 1) else {
                return mismatch(&format!(
                    "one of {} written as {{\"type\": value}}",
                    branches()
                ));
            };
            let (branch, inner) = object.iter().next().expect("one entry");
            let Some(variant) = union.variants().iter().find(|variant| {
                json_type_name(variant, resolved, namespace).is_some_and(|name| name == *branch)
            }) else {
                return Err(JsonProblem {
                    path: path.clone(),
                    expected: format!("one of {}", branches()),
                    found: format!("branch \"{branch}\""),
                });
            };
            let length = push_key(path, branch);
            check(variant, inner, resolved, namespace, path)?;
            path.truncate(length);
            Ok(())
        }
        Schema::Record(record) => {
            let Some(object) = value.as_object() else {
                return mismatch(&format!(
                    "record {} (an object)",
                    record.name.fullname(namespace)
                ));
            };
            let record_namespace = record
                .name
                .namespace()
                .map(str::to_owned)
                .or_else(|| namespace.map(str::to_owned));
            let scope = record_namespace.as_deref();
            for field in &record.fields {
                let length = push_key(path, &field.name);
                match object.get(&field.name) {
                    Some(item) => check(&field.schema, item, resolved, scope, path)?,
                    None => {
                        return Err(JsonProblem {
                            path: path.clone(),
                            expected: format!(
                                "field {} ({})",
                                field.name,
                                type_word(&field.schema)
                            ),
                            found: "nothing (every field must be present, even with a default)"
                                .to_owned(),
                        });
                    }
                }
                path.truncate(length);
            }
            let known: BTreeSet<&str> = record
                .fields
                .iter()
                .map(|field| field.name.as_str())
                .collect();
            if let Some((extra, item)) =
                object.iter().find(|(key, _)| !known.contains(key.as_str()))
            {
                let length = push_key(path, extra);
                let found = problem(path, "", item);
                path.truncate(length);
                let mut extra_path = path.clone();
                push_key(&mut extra_path, extra);
                return Err(JsonProblem {
                    path: extra_path,
                    expected: format!(
                        "no field {extra} (record {} has {})",
                        record.name.fullname(namespace),
                        known.into_iter().collect::<Vec<_>>().join(", ")
                    ),
                    found: found.found,
                });
            }
            Ok(())
        }
        Schema::Enum(symbols) => {
            if value
                .as_str()
                .is_some_and(|text| symbols.symbols.iter().any(|symbol| symbol == text))
            {
                Ok(())
            } else {
                mismatch(&format!("one of {}", symbols.symbols.join(", ")))
            }
        }
        Schema::Ref { name } => {
            let Some(target) = lookup(name, resolved, namespace) else {
                return mismatch(&format!(
                    "type {}, which the schema does not define",
                    name.fullname(namespace)
                ));
            };
            check(target, value, resolved, namespace, path)
        }
    }
}

/// A schema type in a few words.
fn type_word(schema: &Schema) -> String {
    match schema {
        Schema::Null => "null".to_owned(),
        Schema::Boolean => "boolean".to_owned(),
        Schema::Int => "int".to_owned(),
        Schema::Long => "long".to_owned(),
        Schema::Float => "float".to_owned(),
        Schema::Double => "double".to_owned(),
        Schema::Bytes => "bytes".to_owned(),
        Schema::String => "string".to_owned(),
        Schema::Array(_) => "array".to_owned(),
        Schema::Map(_) => "map".to_owned(),
        Schema::Union(_) => "union".to_owned(),
        Schema::Record(record) => format!("record {}", record.name.name()),
        Schema::Enum(symbols) => format!("enum {}", symbols.name.name()),
        Schema::Fixed(fixed) => format!("fixed {}", fixed.name.name()),
        Schema::Decimal(_) => "decimal".to_owned(),
        Schema::BigDecimal => "big-decimal".to_owned(),
        Schema::Uuid(_) => "uuid".to_owned(),
        Schema::Date => "date".to_owned(),
        Schema::TimeMillis => "time-millis".to_owned(),
        Schema::TimeMicros => "time-micros".to_owned(),
        Schema::TimestampMillis => "timestamp-millis".to_owned(),
        Schema::TimestampMicros => "timestamp-micros".to_owned(),
        Schema::TimestampNanos => "timestamp-nanos".to_owned(),
        Schema::LocalTimestampMillis => "local-timestamp-millis".to_owned(),
        Schema::LocalTimestampMicros => "local-timestamp-micros".to_owned(),
        Schema::LocalTimestampNanos => "local-timestamp-nanos".to_owned(),
        Schema::Duration(_) => "duration".to_owned(),
        Schema::Ref { name } => name.name().to_owned(),
    }
}

fn lookup<'s>(
    name: &Name,
    resolved: &ResolvedSchema<'s>,
    namespace: Option<&str>,
) -> Option<&'s Schema> {
    let full = name.fullname(namespace);
    resolved
        .get_names()
        .iter()
        .find(|(candidate, _)| candidate.fullname(None) == full || candidate.name() == name.name())
        .map(|(_, schema)| *schema)
}

/// The union branch label a JSON value carries for `schema`.
fn json_type_name(
    schema: &Schema,
    resolved: &ResolvedSchema<'_>,
    namespace: Option<&str>,
) -> Option<String> {
    Some(match schema {
        Schema::Null => "null".to_owned(),
        Schema::Boolean => "boolean".to_owned(),
        Schema::Int | Schema::Date | Schema::TimeMillis => "int".to_owned(),
        Schema::Long
        | Schema::TimeMicros
        | Schema::TimestampMillis
        | Schema::TimestampMicros
        | Schema::TimestampNanos
        | Schema::LocalTimestampMillis
        | Schema::LocalTimestampMicros
        | Schema::LocalTimestampNanos => "long".to_owned(),
        Schema::Float => "float".to_owned(),
        Schema::Double => "double".to_owned(),
        Schema::Bytes | Schema::BigDecimal | Schema::Decimal(_) => "bytes".to_owned(),
        Schema::String | Schema::Uuid(_) => "string".to_owned(),
        Schema::Array(_) => "array".to_owned(),
        Schema::Map(_) => "map".to_owned(),
        Schema::Union(_) => return None,
        Schema::Record(record) => record.name.fullname(namespace),
        Schema::Enum(symbols) => symbols.name.fullname(namespace),
        Schema::Fixed(fixed) | Schema::Duration(fixed) => fixed.name.fullname(namespace),
        Schema::Ref { name } => {
            let target = lookup(name, resolved, namespace)?;
            return json_type_name(target, resolved, namespace);
        }
    })
}

// ---------------------------------------------------------------- JSON to Avro binary

/// Writes a JSON-encoded datum as Avro binary: checked by [`explain_json`]
/// first, then converted against the schema (a union from its
/// `{"type": value}` form, bytes and fixed from their one-character-per-byte
/// strings) and written as one datum.
pub fn encode_json(schema: &Schema, message: &[u8]) -> Result<Vec<u8>, JsonProblem> {
    explain_json(schema, message)?;
    let value: JsonValue = serde_json::from_slice(message).map_err(|error| JsonProblem {
        path: "$".to_owned(),
        expected: "JSON".to_owned(),
        found: error.to_string(),
    })?;
    let resolved = ResolvedSchema::try_from(schema).map_err(|error| JsonProblem {
        path: "$".to_owned(),
        expected: "a schema whose named types resolve".to_owned(),
        found: error.to_string(),
    })?;
    let datum = to_avro(schema, &value, &resolved, None, &mut String::from("$"))?;
    apache_avro::writer::datum::GenericDatumWriter::builder(schema)
        .build()
        .and_then(|writer| writer.write_value_to_vec(datum))
        .map_err(|error| JsonProblem {
            path: "$".to_owned(),
            expected: "a value the Avro writer accepts".to_owned(),
            found: error.to_string(),
        })
}

/// A JSON string whose characters are bytes (code points up to 255), as the
/// Avro JSON encoding writes `bytes` and `fixed`.
fn latin1(value: &JsonValue, path: &str) -> Result<Vec<u8>, JsonProblem> {
    let text = value.as_str().unwrap_or_default();
    text.chars()
        .map(|character| u8::try_from(u32::from(character)).ok())
        .collect::<Option<Vec<u8>>>()
        .ok_or_else(|| JsonProblem {
            path: path.to_owned(),
            expected: "bytes written one character per byte (code points up to 255)".to_owned(),
            found: describe(value),
        })
}

#[allow(clippy::too_many_lines)]
fn to_avro(
    schema: &Schema,
    value: &JsonValue,
    resolved: &ResolvedSchema<'_>,
    namespace: Option<&str>,
    path: &mut String,
) -> Result<AvroValue, JsonProblem> {
    let int = || i32::try_from(value.as_i64().unwrap_or_default()).unwrap_or_default();
    let long = || value.as_i64().unwrap_or_default();
    Ok(match schema {
        Schema::Null => AvroValue::Null,
        Schema::Boolean => AvroValue::Boolean(value.as_bool().unwrap_or_default()),
        Schema::Int => AvroValue::Int(int()),
        Schema::Date => AvroValue::Date(int()),
        Schema::TimeMillis => AvroValue::TimeMillis(int()),
        Schema::Long => AvroValue::Long(long()),
        Schema::TimeMicros => AvroValue::TimeMicros(long()),
        Schema::TimestampMillis => AvroValue::TimestampMillis(long()),
        Schema::TimestampMicros => AvroValue::TimestampMicros(long()),
        Schema::TimestampNanos => AvroValue::TimestampNanos(long()),
        Schema::LocalTimestampMillis => AvroValue::LocalTimestampMillis(long()),
        Schema::LocalTimestampMicros => AvroValue::LocalTimestampMicros(long()),
        Schema::LocalTimestampNanos => AvroValue::LocalTimestampNanos(long()),
        #[allow(clippy::cast_possible_truncation)]
        Schema::Float => AvroValue::Float(value.as_f64().unwrap_or_default() as f32),
        Schema::Double => AvroValue::Double(value.as_f64().unwrap_or_default()),
        Schema::String | Schema::Uuid(UuidSchema::String) => {
            AvroValue::String(value.as_str().unwrap_or_default().to_owned())
        }
        Schema::Bytes | Schema::Uuid(UuidSchema::Bytes) => AvroValue::Bytes(latin1(value, path)?),
        Schema::Uuid(UuidSchema::Fixed(fixed)) => {
            AvroValue::Fixed(fixed.size, latin1(value, path)?)
        }
        Schema::Decimal(_) => AvroValue::Decimal(apache_avro::Decimal::from(latin1(value, path)?)),
        Schema::BigDecimal => big_decimal(&latin1(value, path)?, path)?,
        Schema::Fixed(fixed) => AvroValue::Fixed(fixed.size, latin1(value, path)?),
        Schema::Duration(_) => {
            let bytes = latin1(value, path)?;
            let mut twelve = [0_u8; 12];
            twelve.copy_from_slice(&bytes[..12.min(bytes.len())]);
            AvroValue::Duration(apache_avro::Duration::from(twelve))
        }
        Schema::Array(array) => {
            let mut items = Vec::new();
            for (index, item) in value.as_array().into_iter().flatten().enumerate() {
                let length = path.len();
                push_index(path, index);
                items.push(to_avro(&array.items, item, resolved, namespace, path)?);
                path.truncate(length);
            }
            AvroValue::Array(items)
        }
        Schema::Map(map) => {
            let mut entries = HashMap::new();
            for (key, item) in value.as_object().into_iter().flatten() {
                let length = push_key(path, key);
                entries.insert(
                    key.clone(),
                    to_avro(&map.types, item, resolved, namespace, path)?,
                );
                path.truncate(length);
            }
            AvroValue::Map(entries)
        }
        Schema::Union(union) => {
            if value.is_null() {
                let index = union
                    .variants()
                    .iter()
                    .position(|variant| matches!(variant, Schema::Null))
                    .unwrap_or_default();
                return Ok(AvroValue::Union(
                    u32::try_from(index).unwrap_or_default(),
                    Box::new(AvroValue::Null),
                ));
            }
            let (branch, inner) = value
                .as_object()
                .and_then(|object| object.iter().next())
                .ok_or_else(|| problem(path, "a union value", value))?;
            let (index, variant) = union
                .variants()
                .iter()
                .enumerate()
                .find(|(_, variant)| {
                    json_type_name(variant, resolved, namespace).is_some_and(|name| name == *branch)
                })
                .ok_or_else(|| problem(path, "a union branch", value))?;
            let length = push_key(path, branch);
            let converted = to_avro(variant, inner, resolved, namespace, path)?;
            path.truncate(length);
            AvroValue::Union(
                u32::try_from(index).unwrap_or_default(),
                Box::new(converted),
            )
        }
        Schema::Record(record) => {
            let record_namespace = record
                .name
                .namespace()
                .map(str::to_owned)
                .or_else(|| namespace.map(str::to_owned));
            let mut fields = Vec::with_capacity(record.fields.len());
            for field in &record.fields {
                let item = value.get(&field.name).unwrap_or(&JsonValue::Null);
                let length = push_key(path, &field.name);
                fields.push((
                    field.name.clone(),
                    to_avro(
                        &field.schema,
                        item,
                        resolved,
                        record_namespace.as_deref(),
                        path,
                    )?,
                ));
                path.truncate(length);
            }
            AvroValue::Record(fields)
        }
        Schema::Enum(symbols) => {
            let text = value.as_str().unwrap_or_default();
            let index = symbols
                .symbols
                .iter()
                .position(|symbol| symbol == text)
                .unwrap_or_default();
            AvroValue::Enum(u32::try_from(index).unwrap_or_default(), text.to_owned())
        }
        Schema::Ref { name } => {
            let target = lookup(name, resolved, namespace)
                .ok_or_else(|| problem(path, "a type the schema defines", value))?;
            return to_avro(target, value, resolved, namespace, path);
        }
    })
}

/// A big-decimal from the bytes its Avro value holds, read by apache-avro.
fn big_decimal(bytes: &[u8], path: &str) -> Result<AvroValue, JsonProblem> {
    let mut encoded = Vec::with_capacity(bytes.len() + 10);
    // The bytes value as the binary encoding frames it: zig-zag length first.
    let length = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
    let mut zigzag = u64::from_ne_bytes(((length << 1) ^ (length >> 63)).to_ne_bytes());
    loop {
        let low = u8::try_from(zigzag & 0x7f).unwrap_or_default();
        zigzag >>= 7;
        if zigzag == 0 {
            encoded.push(low);
            break;
        }
        encoded.push(low | 0x80);
    }
    encoded.extend_from_slice(bytes);
    apache_avro::reader::datum::GenericDatumReader::builder(&Schema::BigDecimal)
        .build()
        .and_then(|reader| reader.read_value(&mut std::io::Cursor::new(encoded)))
        .map_err(|error| JsonProblem {
            path: path.to_owned(),
            expected: "the bytes of a big-decimal".to_owned(),
            found: error.to_string(),
        })
}

// ---------------------------------------------------------------- examples

/// A JSON message `schema` accepts: every record field, an enum's first
/// symbol, a union's first branch that is not null (written
/// `{"type": value}`), one element in arrays and maps, strings of the right
/// length for fixed types, and plausible values for logical types. Checked
/// with [`explain_json`] before it is returned.
pub fn example_json(schema: &Schema) -> Result<String, String> {
    let resolved = ResolvedSchema::try_from(schema).map_err(|error| error.to_string())?;
    let mut active = Vec::new();
    let value = example(schema, &resolved, None, None, &mut active)
        .ok_or_else(|| "The schema has no finite value: a record contains itself without a null branch to stop at.".to_owned())?;
    let text = serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?;
    explain_json(schema, text.as_bytes()).map_err(|problem| {
        format!(
            "The example does not match at {}: expected {}, found {}.",
            problem.path, problem.expected, problem.found
        )
    })?;
    Ok(text)
}

#[allow(clippy::too_many_lines)]
fn example(
    schema: &Schema,
    resolved: &ResolvedSchema<'_>,
    namespace: Option<&str>,
    field: Option<&str>,
    active: &mut Vec<String>,
) -> Option<JsonValue> {
    let latin = |size: usize| JsonValue::String("a".repeat(size));
    Some(match schema {
        Schema::Null => JsonValue::Null,
        Schema::Boolean => JsonValue::Bool(true),
        Schema::Int | Schema::Long => JsonValue::from(1),
        Schema::Float | Schema::Double => JsonValue::from(1.5),
        Schema::String => JsonValue::String(field.unwrap_or("text").to_owned()),
        Schema::Bytes => JsonValue::String("bytes".to_owned()),
        Schema::Uuid(UuidSchema::String) => {
            JsonValue::String("00000000-0000-4000-8000-000000000000".to_owned())
        }
        Schema::Uuid(UuidSchema::Bytes | UuidSchema::Fixed(_)) => latin(16),
        Schema::Decimal(_) | Schema::BigDecimal => JsonValue::String("\u{1}".to_owned()),
        Schema::Fixed(fixed) => latin(fixed.size),
        Schema::Duration(_) => latin(12),
        // 2024-10-04, and an instant on that day.
        Schema::Date => JsonValue::from(20_000),
        Schema::TimeMillis => JsonValue::from(43_200_000),
        Schema::TimeMicros => JsonValue::from(43_200_000_000_i64),
        Schema::TimestampMillis | Schema::LocalTimestampMillis => {
            JsonValue::from(1_728_000_000_000_i64)
        }
        Schema::TimestampMicros | Schema::LocalTimestampMicros => {
            JsonValue::from(1_728_000_000_000_000_i64)
        }
        Schema::TimestampNanos | Schema::LocalTimestampNanos => {
            JsonValue::from(1_728_000_000_000_000_000_i64)
        }
        Schema::Array(array) => JsonValue::Array(vec![example(
            &array.items,
            resolved,
            namespace,
            field,
            active,
        )?]),
        Schema::Map(map) => {
            let mut entries = serde_json::Map::new();
            entries.insert(
                "key".to_owned(),
                example(&map.types, resolved, namespace, field, active)?,
            );
            JsonValue::Object(entries)
        }
        Schema::Union(union) => {
            let null = union
                .variants()
                .iter()
                .any(|variant| matches!(variant, Schema::Null));
            for variant in union.variants() {
                if matches!(variant, Schema::Null) {
                    continue;
                }
                let Some(name) = json_type_name(variant, resolved, namespace) else {
                    continue;
                };
                // Inside a record that is already being written, stop at null.
                if null && active.contains(&name) {
                    continue;
                }
                if let Some(inner) = example(variant, resolved, namespace, field, active) {
                    let mut entries = serde_json::Map::new();
                    entries.insert(name, inner);
                    return Some(JsonValue::Object(entries));
                }
            }
            if null {
                JsonValue::Null
            } else {
                return None;
            }
        }
        Schema::Record(record) => {
            let full = record.name.fullname(namespace);
            if active.contains(&full) {
                return None;
            }
            active.push(full);
            let record_namespace = record
                .name
                .namespace()
                .map(str::to_owned)
                .or_else(|| namespace.map(str::to_owned));
            let mut entries = serde_json::Map::new();
            for item in &record.fields {
                let value = example(
                    &item.schema,
                    resolved,
                    record_namespace.as_deref(),
                    Some(&item.name),
                    active,
                );
                let Some(value) = value else {
                    active.pop();
                    return None;
                };
                entries.insert(item.name.clone(), value);
            }
            active.pop();
            JsonValue::Object(entries)
        }
        Schema::Enum(symbols) => JsonValue::String(symbols.symbols.first()?.clone()),
        Schema::Ref { name } => {
            let target = lookup(name, resolved, namespace)?;
            return example(target, resolved, namespace, field, active);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const READING: &str = r#"{"type":"record","name":"Reading","fields":[{"name":"sensor","type":"string"},{"name":"value","type":"double"}]}"#;

    #[test]
    fn definitions_and_messages_follow_the_recorded_answers() {
        assert!(parse_definition("{not avro").is_err());
        assert!(parse_definition(r#"{"type":"record","name":"X"}"#).is_err());
        assert!(parse_definition("").is_err());
        let schema = parse_definition(READING).unwrap();
        assert!(validate_json(&schema, br#"{"sensor":"s1","value":1.5}"#).is_ok());
        assert!(validate_json(&schema, br#"{"sensor":1}"#).is_err());
        assert!(validate_json(&schema, b"not json").is_err());
        assert!(validate_json(&schema, b"{}").is_err());
        let text = parse_definition(r#""string""#).unwrap();
        assert!(validate_json(&text, br#""x""#).is_ok());
        assert!(validate_binary(&text, &[2, 120]).is_ok());
        assert!(validate_binary(&text, &[255, 255, 255]).is_err());
        let mut binary = vec![4];
        binary.extend_from_slice(b"s1");
        binary.extend_from_slice(&[0, 0, 0, 0, 0, 0, 248, 63]);
        assert!(validate_binary(&schema, &binary).is_ok());
        assert!(validate_binary(&schema, b"{}").is_err());
    }
}
