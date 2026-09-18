//! Helpers mirroring the official emulator's `utils.ts`: validation,
//! canonicalization, random identifiers and timestamps.

use std::fmt::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Map as JsonMap, Value as JsonValue};
use sha2::{Digest as _, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

const ALNUM: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const BASE64URL: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// `isValidEmailAddress`: anything with exactly one `@` between non-empty parts.
#[must_use]
pub fn is_valid_email(email: &str) -> bool {
    let mut parts = email.splitn(2, '@');
    let local = parts.next().unwrap_or("");
    let Some(domain) = parts.next() else {
        return false;
    };
    !local.is_empty() && !domain.is_empty() && !local.contains('@') && !domain.contains('@')
}

/// `isValidPhoneNumber`: starts with `+`.
#[must_use]
pub fn is_valid_phone(phone: &str) -> bool {
    phone.starts_with('+')
}

/// `canonicalizeEmailAddress`: lower-cased.
#[must_use]
pub fn canonicalize_email(email: &str) -> String {
    email.to_lowercase()
}

/// `parseAbsoluteUri`: WHATWG URL parsing succeeds.
#[must_use]
pub fn is_absolute_uri(uri: &str) -> bool {
    url::Url::parse(uri).is_ok()
}

fn random_bytes(length: usize) -> Vec<u8> {
    // Not a security primitive: identifiers only need to be unique per
    // process, like the emulator's Math.random-based ids.
    let mut bytes = Vec::with_capacity(length);
    while bytes.len() < length {
        let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut digest = Sha256::new();
        digest.update(counter.to_le_bytes());
        digest.update(std::process::id().to_le_bytes());
        digest.update(
            OffsetDateTime::now_utc()
                .unix_timestamp_nanos()
                .to_le_bytes(),
        );
        bytes.extend_from_slice(&digest.finalize());
    }
    bytes.truncate(length);
    bytes
}

fn random_from(alphabet: &[u8], length: usize) -> String {
    random_bytes(length)
        .into_iter()
        .map(|byte| char::from(alphabet[usize::from(byte) % alphabet.len()]))
        .collect()
}

/// `randomId(len)`: alphanumeric.
#[must_use]
pub fn random_id(length: usize) -> String {
    random_from(ALNUM, length)
}

/// `randomBase64UrlStr(len)`: base64url alphabet.
#[must_use]
pub fn random_base64url(length: usize) -> String {
    random_from(BASE64URL, length)
}

/// `randomDigits(len)`.
#[must_use]
pub fn random_digits(length: usize) -> String {
    random_bytes(length)
        .into_iter()
        .map(|byte| char::from(b'0' + byte % 10))
        .collect()
}

/// A UUID-shaped random event id (`crypto.randomUUID`).
#[must_use]
pub fn random_uuid() -> String {
    let bytes = random_bytes(16);
    let mut hex = String::with_capacity(32);
    for byte in &bytes {
        let _ = write!(hex, "{byte:02x}");
    }
    format!(
        "{}-{}-4{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Milliseconds since the epoch.
#[must_use]
pub fn now_millis() -> i64 {
    i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(0)
}

/// `toUnixTimestamp(new Date())`: whole seconds.
#[must_use]
pub fn now_seconds() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

/// `new Date().toISOString()`.
#[must_use]
pub fn now_iso() -> String {
    iso_from_millis(now_millis())
}

/// `new Date(millis).toISOString()` with millisecond precision.
#[must_use]
pub fn iso_from_millis(millis: i64) -> String {
    let seconds = millis.div_euclid(1000);
    let sub_millis = millis.rem_euclid(1000);
    let datetime =
        OffsetDateTime::from_unix_timestamp(seconds).unwrap_or(OffsetDateTime::UNIX_EPOCH);
    let base = datetime.format(&Rfc3339).unwrap_or_default();
    // `Rfc3339` renders `2026-09-18T11:10:17Z`; JavaScript renders milliseconds.
    let trimmed = base.trim_end_matches('Z');
    format!("{trimmed}.{sub_millis:03}Z")
}

/// A JSON value that keeps object key order, for the strings the official
/// emulator builds with `JSON.stringify` on request-ordered objects.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum OrderedJson {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<OrderedJson>),
    Object(indexmap::IndexMap<String, OrderedJson>),
}

impl OrderedJson {
    /// Parses JSON text keeping object key order.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        serde_json::from_str(text).ok()
    }

    /// `JSON.stringify` of the value with its original key order.
    #[must_use]
    pub fn stringify(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(map) => map.get(key),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(text) => Some(text),
            _ => None,
        }
    }

    /// The same value with sorted keys, for the code that does not care.
    #[must_use]
    pub fn to_value(&self) -> JsonValue {
        serde_json::to_value(self).unwrap_or(JsonValue::Null)
    }
}

/// `JSON.stringify` of an object literal written in `pairs` order; `None`
/// values are `undefined` and dropped.
#[must_use]
pub fn stringify_ordered(pairs: &[(&str, Option<JsonValue>)]) -> String {
    let mut object = indexmap::IndexMap::new();
    for (key, value) in pairs {
        if let Some(value) = value.clone().filter(|value| !value.is_null()) {
            object.insert((*key).to_owned(), ordered_from_value(&value));
        }
    }
    OrderedJson::Object(object).stringify()
}

fn ordered_from_value(value: &JsonValue) -> OrderedJson {
    match value {
        JsonValue::Null => OrderedJson::Null,
        JsonValue::Bool(flag) => OrderedJson::Bool(*flag),
        JsonValue::Number(number) => OrderedJson::Number(number.clone()),
        JsonValue::String(text) => OrderedJson::String(text.clone()),
        JsonValue::Array(items) => {
            OrderedJson::Array(items.iter().map(ordered_from_value).collect())
        }
        JsonValue::Object(map) => OrderedJson::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), ordered_from_value(item)))
                .collect(),
        ),
    }
}

/// `mirrorFieldTo(dest, field, source)`: copy or delete when `undefined`.
pub fn mirror_field(
    dest: &mut JsonMap<String, JsonValue>,
    field: &str,
    source: &JsonMap<String, JsonValue>,
) {
    match source.get(field) {
        Some(value) => {
            dest.insert(field.to_owned(), value.clone());
        }
        None => {
            dest.remove(field);
        }
    }
}

/// Unsigned JWT (`alg: none`) as `jsonwebtoken.sign(payload, secret, { algorithm: "none" })`.
#[must_use]
pub fn unsigned_jwt(payload: &JsonValue) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(payload).unwrap_or_default());
    format!("{header}.{body}.")
}

/// `jsonwebtoken.decode(token, { complete: true })`: header and payload, or
/// `None` when the token is not a JWT.
#[must_use]
pub fn decode_jwt(token: &str) -> Option<(JsonValue, JsonValue)> {
    let mut parts = token.split('.');
    let header = parts.next()?;
    let payload = parts.next()?;
    parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let header: JsonValue =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header.trim_end_matches('=')).ok()?).ok()?;
    let payload: JsonValue =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?)
            .ok()?;
    if !header.is_object() {
        return None;
    }
    Some((header, payload))
}

/// `coercePrimitiveToString`.
#[must_use]
pub fn coerce_primitive_to_string(value: Option<&JsonValue>) -> Option<String> {
    match value {
        Some(JsonValue::String(text)) => Some(text.clone()),
        Some(JsonValue::Number(number)) => Some(number.to_string()),
        Some(JsonValue::Bool(flag)) => Some(flag.to_string()),
        _ => None,
    }
}

/// `str(value)` for string fields; `None` for absent, null or non-strings.
#[must_use]
pub fn str_field<'a>(object: &'a JsonMap<String, JsonValue>, field: &str) -> Option<&'a str> {
    object.get(field).and_then(JsonValue::as_str)
}

/// A string field that is present and non-empty (JavaScript truthiness).
#[must_use]
pub fn truthy_str<'a>(object: &'a JsonMap<String, JsonValue>, field: &str) -> Option<&'a str> {
    str_field(object, field).filter(|value| !value.is_empty())
}

/// JavaScript truthiness of a JSON value.
#[must_use]
pub fn truthy(value: Option<&JsonValue>) -> bool {
    match value {
        None | Some(JsonValue::Null) => false,
        Some(JsonValue::Bool(flag)) => *flag,
        Some(JsonValue::Number(number)) => number.as_f64().is_some_and(|value| value != 0.0),
        Some(JsonValue::String(text)) => !text.is_empty(),
        Some(JsonValue::Array(_) | JsonValue::Object(_)) => true,
    }
}
