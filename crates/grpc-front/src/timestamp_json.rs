//! Protobuf JSON writes a UTC timestamp as `…+00:00`; Google's Firestore
//! writes `…Z`.
//!
//! Any response this server builds by serializing a protobuf message carries
//! the offset form, while every response it hand-encodes carries `Z`. A
//! client that compares an `updateTime` it listed with one it read — or
//! stores it and sends it back as a precondition — must not see the same
//! instant spelled two ways depending on which endpoint answered.

use serde_json::Value as JsonValue;

/// The fields of a Firestore document or response that hold a timestamp.
/// Matching by name rather than by shape keeps a document field whose own
/// string happens to end in `+00:00` untouched.
const TIMESTAMP_FIELDS: [&str; 5] = [
    "timestampValue",
    "createTime",
    "updateTime",
    "readTime",
    "commitTime",
];

/// Rewrites every UTC timestamp in `value` to the `Z` form, in place.
pub fn utc_as_z(value: &mut JsonValue) {
    match value {
        JsonValue::Array(values) => values.iter_mut().for_each(utc_as_z),
        JsonValue::Object(fields) => {
            for (name, field) in fields {
                if TIMESTAMP_FIELDS.contains(&name.as_str())
                    && let Some(text) = field.as_str()
                    && let Some(instant) = text.strip_suffix("+00:00")
                {
                    *field = JsonValue::String(format!("{instant}Z"));
                } else {
                    utc_as_z(field);
                }
            }
        }
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) | JsonValue::String(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_timestamp_in_a_listing_takes_the_z_form() {
        let mut value = serde_json::json!({
            "documents": [{
                "name": "projects/p/databases/(default)/documents/things/one",
                "fields": {
                    "when": { "timestampValue": "2026-03-04T05:06:07+00:00" },
                    "nested": { "mapValue": { "fields": {
                        "deep": { "timestampValue": "2026-03-04T05:06:07.5+00:00" }
                    }}},
                },
                "createTime": "2026-01-01T00:00:00+00:00",
                "updateTime": "2026-01-02T00:00:00+00:00",
            }],
        });
        utc_as_z(&mut value);
        let document = &value["documents"][0];
        assert_eq!(
            document["fields"]["when"]["timestampValue"],
            "2026-03-04T05:06:07Z"
        );
        assert_eq!(
            document["fields"]["nested"]["mapValue"]["fields"]["deep"]["timestampValue"],
            "2026-03-04T05:06:07.5Z"
        );
        assert_eq!(document["createTime"], "2026-01-01T00:00:00Z");
        assert_eq!(document["updateTime"], "2026-01-02T00:00:00Z");
    }

    #[test]
    fn a_timestamp_that_is_not_utc_keeps_its_offset() {
        let mut value = serde_json::json!({ "updateTime": "2026-03-04T05:06:07+08:00" });
        utc_as_z(&mut value);
        assert_eq!(value["updateTime"], "2026-03-04T05:06:07+08:00");
    }

    #[test]
    fn a_document_field_that_merely_ends_that_way_is_left_alone() {
        // Matching by field name is what makes this safe: a person's own
        // string is not a timestamp however it ends.
        let mut value = serde_json::json!({
            "fields": { "note": { "stringValue": "meeting at 10+00:00" } },
            "name": "things/one+00:00",
        });
        utc_as_z(&mut value);
        assert_eq!(
            value["fields"]["note"]["stringValue"],
            "meeting at 10+00:00"
        );
        assert_eq!(value["name"], "things/one+00:00");
    }
}
