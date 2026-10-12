//! Console drafts and their templates: `{{i}}`, `{{uuid}}`, `{{now}}` and
//! `{{ts}}` in a message's data and attribute values, expanded by the engine
//! only, so the console's preview of message 1 is exactly what the publish
//! sends; then the draft becomes bytes the way it says (text, JSON checked,
//! base64 decoded, or JSON written as Avro binary for the topic's schema).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use apache_avro::Schema;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use sha2::{Digest as _, Sha256};

use crate::avro::{self, JsonProblem};
use crate::broker::rfc3339_millis;
use crate::runtime::OutgoingMessage;

/// The placeholders a template may use.
const PLACEHOLDERS: &str = "{{i}}, {{uuid}}, {{now}} or {{ts}}";
/// Lowercase hexadecimal digits.
const DIGITS: &[u8; 16] = b"0123456789abcdef";

/// A message's data as the console wrote it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DraftData {
    /// UTF-8 text, sent as its bytes.
    Text(String),
    /// JSON text: checked, then sent as its UTF-8 bytes.
    Json(String),
    /// Bytes, base64 (never expanded).
    Base64(String),
    /// JSON sent as Avro binary for the topic's bound schema.
    AvroJson(String),
}

/// A message as the console wrote it, before templates and encoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draft {
    pub data: DraftData,
    pub attributes: BTreeMap<String, String>,
    pub ordering_key: String,
}

/// Why a draft could not become a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemplateError {
    /// A `{{…}}` that is not one of the four placeholders.
    UnknownPlaceholder { message: u64, placeholder: String },
    /// JSON data that does not parse (after expansion, when it was a template).
    InvalidJson {
        message: u64,
        expanded: bool,
        reason: String,
    },
    /// Base64 data that does not decode.
    InvalidBase64 { message: u64 },
    /// JSON the topic's Avro schema refuses, with where.
    Schema { message: u64, problem: JsonProblem },
    /// Avro JSON for a topic that has no schema bound.
    NoSchema,
}

impl std::fmt::Display for TemplateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownPlaceholder {
                message,
                placeholder,
            } => write!(
                formatter,
                "Message {message} uses {placeholder}, which is not a template; use {PLACEHOLDERS}."
            ),
            Self::InvalidJson {
                message,
                expanded: true,
                reason,
            } => write!(
                formatter,
                "Message {message} is not valid JSON after expansion: {reason}"
            ),
            Self::InvalidJson {
                message, reason, ..
            } => write!(formatter, "Message {message} is not valid JSON: {reason}"),
            Self::InvalidBase64 { message } => {
                write!(formatter, "Message {message} is not valid base64.")
            }
            Self::Schema { message, problem } => write!(
                formatter,
                "Message {message} does not match the topic's schema at {}: expected {}, found {}.",
                problem.path, problem.expected, problem.found
            ),
            Self::NoSchema => formatter.write_str(
                "The topic has no schema bound, so there is nothing to write Avro for; send the JSON as JSON.",
            ),
        }
    }
}

impl std::error::Error for TemplateError {}

/// Expands the placeholders of `draft` for message `index` (1-based) at
/// `now`: `{{i}}` the index, `{{uuid}}` a fresh random-format UUID,
/// `{{now}}` the time in RFC 3339 with milliseconds, `{{ts}}` the time in
/// milliseconds since the epoch. Data and attribute values are expanded;
/// base64 data and the ordering key are not.
pub fn expand(draft: &Draft, index: u64, now: SystemTime) -> Result<Draft, TemplateError> {
    let fill = |text: &str| fill(text, index, now);
    let data = match &draft.data {
        DraftData::Text(text) => DraftData::Text(fill(text)?),
        DraftData::Json(text) => DraftData::Json(fill(text)?),
        DraftData::AvroJson(text) => DraftData::AvroJson(fill(text)?),
        DraftData::Base64(text) => DraftData::Base64(text.clone()),
    };
    let attributes = draft
        .attributes
        .iter()
        .map(|(key, value)| Ok((key.clone(), fill(value)?)))
        .collect::<Result<_, TemplateError>>()?;
    Ok(Draft {
        data,
        attributes,
        ordering_key: draft.ordering_key.clone(),
    })
}

/// Turns draft `index` (1-based) into the message the publish sends:
/// expanded when `template` is set, then encoded as its data says. `schema`
/// is the topic's bound revision, for Avro JSON.
pub fn prepare(
    draft: &Draft,
    index: u64,
    now: SystemTime,
    template: bool,
    schema: Option<&Schema>,
) -> Result<OutgoingMessage, TemplateError> {
    let expanded = if template {
        expand(draft, index, now)?
    } else {
        draft.clone()
    };
    let data = match &expanded.data {
        DraftData::Text(text) => text.as_bytes().to_vec(),
        DraftData::Json(text) => {
            serde_json::from_str::<serde::de::IgnoredAny>(text).map_err(|error| {
                TemplateError::InvalidJson {
                    message: index,
                    expanded: template && text_of(&draft.data) != text.as_str(),
                    reason: error.to_string(),
                }
            })?;
            text.as_bytes().to_vec()
        }
        DraftData::Base64(text) => BASE64
            .decode(text.trim())
            .map_err(|_| TemplateError::InvalidBase64 { message: index })?,
        DraftData::AvroJson(text) => {
            let schema = schema.ok_or(TemplateError::NoSchema)?;
            avro::encode_json(schema, text.as_bytes()).map_err(|problem| TemplateError::Schema {
                message: index,
                problem,
            })?
        }
    };
    Ok(OutgoingMessage {
        data,
        attributes: expanded.attributes,
        ordering_key: expanded.ordering_key,
    })
}

/// Every draft as the publish sends it, numbered from 1.
pub fn prepare_all(
    drafts: &[Draft],
    now: SystemTime,
    template: bool,
    schema: Option<&Schema>,
) -> Result<Vec<OutgoingMessage>, TemplateError> {
    drafts
        .iter()
        .zip(1_u64..)
        .map(|(draft, index)| prepare(draft, index, now, template, schema))
        .collect()
}

fn text_of(data: &DraftData) -> &str {
    match data {
        DraftData::Text(text)
        | DraftData::Json(text)
        | DraftData::AvroJson(text)
        | DraftData::Base64(text) => text,
    }
}

/// Replaces every placeholder in `text`.
fn fill(text: &str, index: u64, now: SystemTime) -> Result<String, TemplateError> {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        output.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            output.push_str(&rest[start..]);
            return Ok(output);
        };
        let name = after[..end].trim();
        match name {
            "i" => output.push_str(&index.to_string()),
            "uuid" => output.push_str(&fresh_uuid(index, now)),
            "now" => output.push_str(&rfc3339_millis(now)),
            "ts" => output.push_str(
                &now.duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
                    .to_string(),
            ),
            _ => {
                return Err(TemplateError::UnknownPlaceholder {
                    message: index,
                    placeholder: format!("{{{{{name}}}}}"),
                });
            }
        }
        rest = &after[end + 2..];
    }
    output.push_str(rest);
    Ok(output)
}

/// A UUID in the version 4 format, distinct for every call in the process.
fn fresh_uuid(index: u64, now: SystemTime) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut digest = Sha256::new();
    digest.update(COUNTER.fetch_add(1, Ordering::Relaxed).to_le_bytes());
    digest.update(index.to_le_bytes());
    digest.update(
        now.duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_le_bytes(),
    );
    digest.update(std::process::id().to_le_bytes());
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest.finalize()[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes
        .iter()
        .flat_map(|byte| {
            [
                DIGITS[usize::from(byte >> 4)],
                DIGITS[usize::from(byte & 0x0f)],
            ]
        })
        .map(char::from)
        .collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}
