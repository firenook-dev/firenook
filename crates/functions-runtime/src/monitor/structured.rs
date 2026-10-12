//! The one parser of `firebase-functions/logger` lines.
//!
//! The SDK's logger prints each entry as one JSON object holding a
//! `severity`, a `message` and whatever structured fields the call passed.
//! The monitor calls [`parse`] when it routes a function's line, and the
//! console's log input calls the same function, so a line reads the same
//! everywhere. The worker never parses.

use serde_json::{Map, Value};

use super::types::FunctionLogLevel;

/// The longest line [`parse`] reads (64 KiB); a longer one stays plain text.
pub const MAX_STRUCTURED_LINE: usize = 64 * 1024;

/// A structured logger entry, split into what every reader needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StructuredLine {
    /// The entry's `severity` as written (`DEBUG`, `INFO`, `NOTICE`,
    /// `WARNING`, `ERROR`, `CRITICAL`, `ALERT`, `EMERGENCY`).
    pub severity: String,
    /// The entry's `message`: its text, or the JSON text of a non-string
    /// value; empty when the entry has none.
    pub message: String,
    /// Every other field of the entry, in the order it was written.
    pub fields: Map<String, Value>,
}

impl StructuredLine {
    /// The console level of the entry's severity: `DEBUG` is debug,
    /// `WARNING` is warn, `ERROR` and above are error, anything else info.
    #[must_use]
    pub fn level(&self) -> FunctionLogLevel {
        severity_level(&self.severity)
    }
}

/// The console level of a logger severity word (case-insensitive).
#[must_use]
pub fn severity_level(severity: &str) -> FunctionLogLevel {
    if severity.eq_ignore_ascii_case("DEBUG") {
        FunctionLogLevel::Debug
    } else if severity.eq_ignore_ascii_case("WARNING") || severity.eq_ignore_ascii_case("WARN") {
        FunctionLogLevel::Warn
    } else if ["ERROR", "CRITICAL", "ALERT", "EMERGENCY"]
        .iter()
        .any(|word| severity.eq_ignore_ascii_case(word))
    {
        FunctionLogLevel::Error
    } else {
        FunctionLogLevel::Info
    }
}

/// Reads a `firebase-functions/logger` entry: a line that starts with `{`,
/// is at most [`MAX_STRUCTURED_LINE`] bytes, is one JSON object and holds a
/// string `severity`. Anything else is a plain line (`None`). Never panics.
#[must_use]
pub fn parse(message: &str) -> Option<StructuredLine> {
    let line = message.trim_end_matches(['\r', '\n']);
    if !line.starts_with('{') || line.len() > MAX_STRUCTURED_LINE {
        return None;
    }
    let Value::Object(mut fields) = serde_json::from_str::<Value>(line).ok()? else {
        return None;
    };
    let Some(Value::String(severity)) = fields.remove("severity") else {
        return None;
    };
    let message = match fields.remove("message") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text,
        Some(other) => other.to_string(),
    };
    Some(StructuredLine {
        severity,
        message,
        fields,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_logger_entry_keeps_its_severity_message_and_fields() {
        let line = parse(
            r#"{"severity":"WARNING","message":"low stock","sku":"A-1","count":2,"logging.googleapis.com/labels":{"k":"v"}}"#,
        )
        .expect("a structured line");
        assert_eq!(line.severity, "WARNING");
        assert_eq!(line.level(), FunctionLogLevel::Warn);
        assert_eq!(line.message, "low stock");
        assert_eq!(
            Value::Object(line.fields),
            json!({"sku": "A-1", "count": 2, "logging.googleapis.com/labels": {"k": "v"}})
        );
    }

    #[test]
    fn severities_map_to_console_levels() {
        for (severity, level) in [
            ("DEBUG", FunctionLogLevel::Debug),
            ("INFO", FunctionLogLevel::Info),
            ("NOTICE", FunctionLogLevel::Info),
            ("WARNING", FunctionLogLevel::Warn),
            ("ERROR", FunctionLogLevel::Error),
            ("CRITICAL", FunctionLogLevel::Error),
            ("ALERT", FunctionLogLevel::Error),
            ("EMERGENCY", FunctionLogLevel::Error),
            ("error", FunctionLogLevel::Error),
            ("something-else", FunctionLogLevel::Info),
        ] {
            assert_eq!(severity_level(severity), level, "{severity}");
        }
    }

    #[test]
    fn a_missing_or_non_string_message_is_still_an_entry() {
        let line = parse(r#"{"severity":"INFO"}"#).expect("an entry");
        assert_eq!(line.message, "");
        assert_eq!(line.fields.len(), 0);
        let line = parse(r#"{"severity":"INFO","message":{"a":1}}"#).expect("an entry");
        assert_eq!(line.message, r#"{"a":1}"#);
        let line = parse("{\"severity\":\"INFO\",\"message\":\"x\"}\r\n").expect("an entry");
        assert_eq!(line.message, "x");
    }

    #[test]
    fn plain_text_and_other_json_are_refused() {
        assert_eq!(parse("hello world"), None);
        assert_eq!(parse(""), None);
        assert_eq!(parse(r#" {"severity":"INFO"}"#), None);
        assert_eq!(parse(r#"{"message":"no severity"}"#), None);
        assert_eq!(parse(r#"{"severity":3,"message":"number"}"#), None);
        assert_eq!(parse(r#"{"severity":"INFO","message":"x""#), None);
        assert_eq!(parse(r#"["severity","INFO"]"#), None);
        assert_eq!(parse("{not json at all}"), None);
    }

    #[test]
    fn a_line_over_the_limit_stays_plain() {
        let padding = "x".repeat(MAX_STRUCTURED_LINE);
        let line = format!(r#"{{"severity":"INFO","message":"{padding}"}}"#);
        assert!(line.len() > MAX_STRUCTURED_LINE);
        assert_eq!(parse(&line), None);
        let fits = format!(
            r#"{{"severity":"INFO","message":"{}"}}"#,
            "x".repeat(MAX_STRUCTURED_LINE - 64)
        );
        assert!(parse(&fits).is_some());
    }

    #[test]
    fn arbitrary_input_never_panics() {
        // A deterministic generator over JSON-ish alphabets and raw bytes:
        // the parser answers every input without panicking.
        let alphabet: Vec<char> = "{}[]\":,severitymessage0123456789.-eE \\u\n\t\u{0}\u{7f}é😀"
            .chars()
            .collect();
        let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for round in 0..4_000 {
            let length = usize::try_from(next() % 96).unwrap_or(0);
            let mut text = String::from(if round % 2 == 0 { "{" } else { "" });
            for _ in 0..length {
                let index = usize::try_from(next()).unwrap_or(0) % alphabet.len();
                text.push(alphabet[index]);
            }
            let _ = parse(&text);
            let bytes: Vec<u8> = (0..length)
                .map(|_| u8::try_from(next() & 0xff).unwrap_or(0))
                .collect();
            let _ = parse(&String::from_utf8_lossy(&bytes));
        }
        let _ = parse(r#"{"severity":"INFO","message":"\ud800"}"#);
    }
}
