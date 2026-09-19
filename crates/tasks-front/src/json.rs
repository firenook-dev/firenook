//! JSON that keeps object key order, and the JavaScript coercions the official
//! emulator applies to request values (`${value}`, truthiness, `Number()`).
//!
//! The official app echoes request objects back through `JSON.stringify`, so
//! the wire order of keys is part of its contract; `serde_json`'s own map
//! sorts keys, and enabling `preserve_order` would change every other crate.

use indexmap::IndexMap;
use serde_json::Number;

/// A JSON value whose objects remember insertion order.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum OrderedJson {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Array(Vec<OrderedJson>),
    Object(IndexMap<String, OrderedJson>),
}

impl OrderedJson {
    /// Parses JSON text keeping object key order.
    pub fn parse(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }

    /// `JSON.stringify` of the value in its original key order.
    #[must_use]
    pub fn stringify(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// An empty object.
    #[must_use]
    pub fn object() -> Self {
        Self::Object(IndexMap::new())
    }

    /// The key of an object; `None` for other values (like `value?.key` on a
    /// primitive, which is `undefined`).
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(map) => map.get(key),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_object(&self) -> Option<&IndexMap<String, Self>> {
        match self {
            Self::Object(map) => Some(map),
            _ => None,
        }
    }

    pub fn as_object_mut(&mut self) -> Option<&mut IndexMap<String, Self>> {
        match self {
            Self::Object(map) => Some(map),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_array(&self) -> Option<&[Self]> {
        match self {
            Self::Array(items) => Some(items),
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

    #[must_use]
    pub fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }

    /// `value ?? fallback`: `null` (and a missing key) yields the fallback.
    #[must_use]
    pub fn or_default(value: Option<&Self>, fallback: Self) -> Self {
        match value {
            Some(value) if !value.is_null() => value.clone(),
            _ => fallback,
        }
    }

    /// JavaScript truthiness.
    #[must_use]
    pub fn truthy(&self) -> bool {
        match self {
            Self::Null => false,
            Self::Bool(flag) => *flag,
            Self::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
            Self::String(text) => !text.is_empty(),
            Self::Array(_) | Self::Object(_) => true,
        }
    }

    /// `${value}`: the template-literal string of a value.
    #[must_use]
    pub fn js_string(&self) -> String {
        match self {
            Self::Null => "null".to_owned(),
            Self::Bool(flag) => flag.to_string(),
            Self::Number(number) => number.as_f64().map_or_else(String::new, js_number_text),
            Self::String(text) => text.clone(),
            Self::Array(items) => items
                .iter()
                .map(|item| match item {
                    Self::Null => String::new(),
                    other => other.js_string(),
                })
                .collect::<Vec<_>>()
                .join(","),
            Self::Object(_) => "[object Object]".to_owned(),
        }
    }

    /// `Number(value)`, the coercion arithmetic and comparisons apply.
    #[must_use]
    pub fn js_number(&self) -> f64 {
        match self {
            Self::Null => 0.0,
            Self::Bool(flag) => f64::from(u8::from(*flag)),
            Self::Number(number) => number.as_f64().unwrap_or(f64::NAN),
            Self::String(text) => parse_js_number(text),
            Self::Array(items) => match items.as_slice() {
                [] => 0.0,
                [only] => parse_js_number(&only.js_string()),
                _ => f64::NAN,
            },
            Self::Object(_) => f64::NAN,
        }
    }

    /// The same value with sorted keys, for code that does not care.
    #[must_use]
    pub fn to_value(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }

    /// An ordered copy of a sorted-key value.
    #[must_use]
    pub fn from_value(value: &serde_json::Value) -> Self {
        match value {
            serde_json::Value::Null => Self::Null,
            serde_json::Value::Bool(flag) => Self::Bool(*flag),
            serde_json::Value::Number(number) => Self::Number(number.clone()),
            serde_json::Value::String(text) => Self::String(text.clone()),
            serde_json::Value::Array(items) => {
                Self::Array(items.iter().map(Self::from_value).collect())
            }
            serde_json::Value::Object(map) => Self::Object(
                map.iter()
                    .map(|(key, item)| (key.clone(), Self::from_value(item)))
                    .collect(),
            ),
        }
    }
}

/// `Number("text")`: trimmed decimal, hexadecimal, infinity, or `NaN`.
fn parse_js_number(text: &str) -> f64 {
    let trimmed = text.trim_matches(|c: char| c.is_whitespace());
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        #[allow(clippy::cast_precision_loss)]
        return u64::from_str_radix(hex, 16).map_or(f64::NAN, |value| value as f64);
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

/// `String(number)` for the values the emulator prints (integers stay
/// integral, other finite numbers use the shortest round-trip form).
#[must_use]
pub fn js_number_text(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    if value.fract() == 0.0 && value.abs() < 1e21 {
        return format!("{value:.0}");
    }
    value.to_string()
}

/// A JSON number as `JSON.stringify` prints the JavaScript value: integral
/// values without a fraction, non-finite values as `null`.
#[must_use]
pub fn js_number(value: f64) -> OrderedJson {
    if !value.is_finite() {
        return OrderedJson::Null;
    }
    // Values printed without a fraction by `JSON.stringify`.
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        #[allow(clippy::cast_possible_truncation)]
        return OrderedJson::Number(Number::from(value as i64));
    }
    Number::from_f64(value).map_or(OrderedJson::Null, OrderedJson::Number)
}

/// `Math.min` (`NaN` wins, unlike `f64::min`).
#[must_use]
pub fn js_min(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else {
        left.min(right)
    }
}

/// `Math.max` (`NaN` wins, unlike `f64::max`).
#[must_use]
pub fn js_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else {
        left.max(right)
    }
}

/// `parseInt(text)`: leading whitespace, an optional sign, then decimal
/// digits; `None` where JavaScript yields `NaN`.
#[must_use]
pub fn parse_int(text: &str) -> Option<i64> {
    let trimmed = text.trim_start_matches(|c: char| c.is_whitespace());
    let (negative, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    let magnitude = digits[..end].parse::<i64>().unwrap_or(i64::MAX);
    Some(if negative { -magnitude } else { magnitude })
}

/// Node's forgiving base64 decoder: whitespace and characters outside the
/// standard and URL-safe alphabets are skipped, padding is optional, and
/// decoding stops at the first `=`.
#[must_use]
pub fn decode_base64_forgiving(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            #[allow(clippy::cast_possible_truncation)]
            out.push(((buffer >> bits) & 0xff) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    out
}
