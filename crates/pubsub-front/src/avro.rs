//! Avro schema handling: definitions parse with `apache-avro`, JSON-encoded
//! messages are checked against the Avro JSON encoding (unions as
//! `{"type": value}`, every record field present) and binary messages decode
//! as a single datum, the way the official emulator's Java Avro does.

use apache_avro::Schema;
use apache_avro::schema::{Name, ResolvedSchema};
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

/// Checks a JSON-encoded datum against the schema.
pub fn validate_json(schema: &Schema, message: &[u8]) -> Result<(), PubsubError> {
    let failure = || PubsubError::invalid_argument("Could not parse JSON Avro message");
    let value: JsonValue = serde_json::from_slice(message).map_err(|_| failure())?;
    let resolved = ResolvedSchema::try_from(schema).map_err(|_| failure())?;
    if matches_json(schema, &value, &resolved, None) {
        Ok(())
    } else {
        Err(failure())
    }
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

fn matches_json(
    schema: &Schema,
    value: &JsonValue,
    resolved: &ResolvedSchema<'_>,
    namespace: Option<&str>,
) -> bool {
    match schema {
        Schema::Null => value.is_null(),
        Schema::Boolean => value.is_boolean(),
        Schema::Int | Schema::Date | Schema::TimeMillis => value
            .as_i64()
            .is_some_and(|number| i32::try_from(number).is_ok()),
        Schema::Long
        | Schema::TimeMicros
        | Schema::TimestampMillis
        | Schema::TimestampMicros
        | Schema::TimestampNanos
        | Schema::LocalTimestampMillis
        | Schema::LocalTimestampMicros
        | Schema::LocalTimestampNanos => value.as_i64().is_some(),
        Schema::Float | Schema::Double => value.is_number(),
        Schema::Bytes
        | Schema::String
        | Schema::BigDecimal
        | Schema::Uuid(_)
        | Schema::Decimal(_) => value.is_string(),
        Schema::Duration(fixed) | Schema::Fixed(fixed) => value
            .as_str()
            .is_some_and(|text| text.chars().count() == fixed.size),
        Schema::Array(array) => value.as_array().is_some_and(|items| {
            items
                .iter()
                .all(|item| matches_json(&array.items, item, resolved, namespace))
        }),
        Schema::Map(map) => value.as_object().is_some_and(|entries| {
            entries
                .values()
                .all(|item| matches_json(&map.types, item, resolved, namespace))
        }),
        Schema::Union(union) => {
            if value.is_null() {
                return union
                    .variants()
                    .iter()
                    .any(|variant| matches!(variant, Schema::Null));
            }
            let Some(object) = value.as_object() else {
                return false;
            };
            if object.len() != 1 {
                return false;
            }
            let (branch, inner) = object.iter().next().expect("one entry");
            union.variants().iter().any(|variant| {
                json_type_name(variant, resolved, namespace).is_some_and(|name| name == *branch)
                    && matches_json(variant, inner, resolved, namespace)
            })
        }
        Schema::Record(record) => {
            let Some(object) = value.as_object() else {
                return false;
            };
            let record_namespace = record
                .name
                .namespace()
                .map(str::to_owned)
                .or_else(|| namespace.map(str::to_owned));
            let scope = record_namespace.as_deref();
            if object.len() != record.fields.len() {
                return false;
            }
            record.fields.iter().all(|field| {
                object
                    .get(&field.name)
                    .is_some_and(|item| matches_json(&field.schema, item, resolved, scope))
            })
        }
        Schema::Enum(symbols) => value
            .as_str()
            .is_some_and(|text| symbols.symbols.iter().any(|symbol| symbol == text)),
        Schema::Ref { name } => {
            let Some(target) = lookup(name, resolved, namespace) else {
                return false;
            };
            matches_json(target, value, resolved, namespace)
        }
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
