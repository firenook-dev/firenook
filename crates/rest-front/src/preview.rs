//! Preview encoding: a reply shaped for a grid rather than for an
//! application.
//!
//! A grid cell shows one truncated line, but a plain `runQuery` serialises
//! every byte of every document it returns. A page of a hundred documents
//! whose fields carry large maps came to 30 MB of JSON to paint a screen
//! that displays a few hundred characters of it, and the console then threw
//! the rest away — it refetches the whole document anyway when a row is
//! opened.
//!
//! A request that opts in with the `x-firenook-preview` header gets values
//! cut down to what a preview can show, with the true sizes alongside so the
//! reader never has to guess a count and never shows one it invented.
//! Everything else is a normal read: the same query, the same rules
//! evaluation, the same documents. A request without the header is
//! byte-for-byte what it has always been, so no SDK and no other client can
//! see this.

use std::collections::BTreeMap;

use axum::http::HeaderMap;
use firenook_core_store::{Fields, Value};
use serde_json::{Map, Value as JsonValue, json};

use crate::RestError;

/// Opts a request into preview encoding, for example
/// `bytes=256; entries=24; keep=status,createdAt`.
pub(crate) const PREVIEW_HEADER: &str = "x-firenook-preview";

/// How much of a string survives when nothing says otherwise.
const DEFAULT_BYTES: usize = 256;
/// How many entries of a map or an array survive by default.
const DEFAULT_ENTRIES: usize = 24;
/// Strings nested inside a previewed container are cut much harder: they
/// only ever appear inside a one-line summary of their parent.
const NESTED_BYTES: usize = 64;
/// Beyond this depth a container is reported by size alone. The console
/// renders a map as its keys and an array as its items, so one level below
/// the field is all that is ever drawn.
const MAX_DEPTH: usize = 1;

/// The bytes not sent, on a value that was cut.
const ELIDED: &str = "firenookElided";
/// The true number of entries, on a container that was cut.
const COUNT: &str = "firenookCount";

/// What a previewing reader asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Preview {
    bytes: usize,
    entries: usize,
    keep: Vec<String>,
}

impl Default for Preview {
    fn default() -> Self {
        Self {
            bytes: DEFAULT_BYTES,
            entries: DEFAULT_ENTRIES,
            keep: Vec::new(),
        }
    }
}

impl Preview {
    /// The preview a request asks for, or `None` for an ordinary read. A
    /// header that does not parse is refused rather than ignored: silently
    /// serving whole documents would turn a typo into a performance bug
    /// nobody can see.
    pub(crate) fn from_headers(headers: &HeaderMap) -> Result<Option<Self>, RestError> {
        let Some(raw) = headers.get(PREVIEW_HEADER) else {
            return Ok(None);
        };
        let raw = raw
            .to_str()
            .map_err(|_| RestError::invalid(format!("{PREVIEW_HEADER} must be ASCII")))?;
        let mut preview = Self::default();
        for setting in raw
            .split(';')
            .map(str::trim)
            .filter(|part| !part.is_empty())
        {
            let (name, value) = setting.split_once('=').ok_or_else(|| {
                RestError::invalid(format!(
                    "{PREVIEW_HEADER}: expected name=value, got {setting}"
                ))
            })?;
            let value = value.trim();
            match name.trim() {
                "bytes" => preview.bytes = number(value, 16, 8_192)?,
                "entries" => preview.entries = number(value, 1, 200)?,
                "keep" => {
                    preview.keep = value
                        .split(',')
                        .map(str::trim)
                        .filter(|field| !field.is_empty())
                        // A dotted path names a field inside a map; keeping
                        // the whole map whole is what the cursor needs.
                        .map(|field| field.split('.').next().unwrap_or(field).to_owned())
                        .take(16)
                        .collect();
                }
                other => {
                    return Err(RestError::invalid(format!(
                        "{PREVIEW_HEADER}: unknown setting {other}"
                    )));
                }
            }
        }
        Ok(Some(preview))
    }

    /// Every field of a document, cut to preview size.
    pub(crate) fn encode_fields(
        &self,
        fields: &Fields,
        whole: impl Fn(&Value) -> Result<JsonValue, RestError>,
    ) -> Result<Map<String, JsonValue>, RestError> {
        fields
            .iter()
            .map(|(name, value)| {
                let encoded = if self.keep.iter().any(|kept| kept == name) {
                    whole(value)?
                } else {
                    self.encode(value, 0, &whole)?
                };
                Ok((name.clone(), encoded))
            })
            .collect()
    }

    fn encode(
        &self,
        value: &Value,
        depth: usize,
        whole: &impl Fn(&Value) -> Result<JsonValue, RestError>,
    ) -> Result<JsonValue, RestError> {
        let budget = if depth == 0 { self.bytes } else { NESTED_BYTES };
        Ok(match value {
            Value::String(text) => match cut(text, budget) {
                Some((kept, elided)) => json!({ "stringValue": kept, ELIDED: elided }),
                None => json!({ "stringValue": text }),
            },
            Value::Bytes(bytes) if bytes.len() > budget => {
                use base64::Engine as _;
                json!({
                    "bytesValue": base64::engine::general_purpose::STANDARD.encode(&bytes[..budget]),
                    ELIDED: bytes.len() - budget,
                })
            }
            Value::Map(fields) => {
                self.container("mapValue", "fields", fields.len(), depth, |kept| {
                    let entries: BTreeMap<String, JsonValue> = fields
                        .iter()
                        .take(kept)
                        .map(|(name, nested)| {
                            Ok((name.clone(), self.encode(nested, depth + 1, whole)?))
                        })
                        .collect::<Result<_, RestError>>()?;
                    Ok(JsonValue::Object(entries.into_iter().collect()))
                })?
            }
            Value::Array(values) => {
                self.container("arrayValue", "values", values.len(), depth, |kept| {
                    Ok(JsonValue::Array(
                        values
                            .iter()
                            .take(kept)
                            .map(|nested| self.encode(nested, depth + 1, whole))
                            .collect::<Result<Vec<_>, RestError>>()?,
                    ))
                })?
            }
            // Scalars are already small, and a vector is a fixed shape the
            // console reads as a whole.
            other => whole(other)?,
        })
    }

    /// A map or an array, cut to size and told how big it really was.
    fn container(
        &self,
        wrapper: &str,
        slot: &str,
        total: usize,
        depth: usize,
        children: impl FnOnce(usize) -> Result<JsonValue, RestError>,
    ) -> Result<JsonValue, RestError> {
        // Past the drawn depth a container is a size and nothing else.
        let kept = if depth >= MAX_DEPTH {
            0
        } else {
            self.entries.min(total)
        };
        let mut inner = Map::new();
        inner.insert(slot.to_owned(), children(kept)?);
        if kept < total {
            inner.insert(COUNT.to_owned(), json!(total));
        }
        Ok(json!({ wrapper: JsonValue::Object(inner) }))
    }
}

/// `text` cut to at most `budget` bytes on a character boundary, with the
/// bytes left behind, or `None` when it already fits.
fn cut(text: &str, budget: usize) -> Option<(&str, usize)> {
    if text.len() <= budget {
        return None;
    }
    let end = text
        .char_indices()
        .map(|(at, _)| at)
        .take_while(|at| *at <= budget)
        .last()
        .unwrap_or(0);
    Some((&text[..end], text.len() - end))
}

fn number(value: &str, low: usize, high: usize) -> Result<usize, RestError> {
    let parsed: usize = value
        .parse()
        .map_err(|_| RestError::invalid(format!("{PREVIEW_HEADER}: {value} is not a number")))?;
    Ok(parsed.clamp(low, high))
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;
    use crate::encode_value;

    fn header(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(PREVIEW_HEADER, HeaderValue::from_str(value).expect("value"));
        headers
    }

    fn preview(value: &str) -> Preview {
        Preview::from_headers(&header(value))
            .expect("parsed")
            .expect("present")
    }

    fn encoded(fields: &Fields, spec: &str) -> JsonValue {
        JsonValue::Object(
            preview(spec)
                .encode_fields(fields, encode_value)
                .expect("encoded"),
        )
    }

    fn field(name: &str, value: Value) -> Fields {
        let mut fields = Fields::new();
        fields.insert(name.to_owned(), value);
        fields
    }

    #[test]
    fn an_ordinary_request_is_not_a_preview() {
        assert_eq!(Preview::from_headers(&HeaderMap::new()).expect("ok"), None);
    }

    #[test]
    fn the_header_carries_its_sizes_and_the_fields_to_leave_alone() {
        let parsed = preview("bytes=32; entries=2; keep=status,shipping.method");
        assert_eq!(parsed.bytes, 32);
        assert_eq!(parsed.entries, 2);
        // A dotted path keeps the whole map it names: that is what the
        // reader's cursor compares against.
        assert_eq!(parsed.keep, ["status", "shipping"]);
    }

    #[test]
    fn sizes_are_clamped_and_nonsense_is_refused() {
        assert_eq!(preview("bytes=1").bytes, 16);
        assert_eq!(preview("bytes=999999").bytes, 8_192);
        assert_eq!(preview("entries=0").entries, 1);
        for bad in ["bytes", "bytes=many", "colour=puce"] {
            assert!(
                Preview::from_headers(&header(bad)).is_err(),
                "{bad} should be refused, not ignored"
            );
        }
    }

    #[test]
    fn a_long_string_is_cut_and_says_how_much_is_missing() {
        let fields = field("note", Value::String("x".repeat(100).into()));
        let json = encoded(&fields, "bytes=16");
        assert_eq!(json["note"]["stringValue"], "x".repeat(16));
        assert_eq!(json["note"][ELIDED], 84);
    }

    #[test]
    fn a_short_string_is_untouched_and_carries_no_marker() {
        let fields = field("note", Value::String("short".into()));
        let json = encoded(&fields, "bytes=16");
        assert_eq!(json["note"], json!({ "stringValue": "short" }));
    }

    #[test]
    fn a_cut_never_splits_a_character() {
        // Three-byte characters against a budget that falls mid-character.
        let fields = field("note", Value::String("日本語".repeat(10).into()));
        let json = encoded(&fields, "bytes=16");
        let kept = json["note"]["stringValue"].as_str().expect("string");
        assert!(kept.len() <= 16, "{kept:?} is {} bytes", kept.len());
        assert_eq!(kept, "日本語日本");
        assert_eq!(json["note"][ELIDED], 90 - kept.len());
    }

    #[test]
    fn a_map_keeps_its_first_entries_and_reports_its_real_size() {
        let mut map = Fields::new();
        for index in 0..10 {
            map.insert(format!("k{index}"), Value::Integer(i64::from(index)));
        }
        let json = encoded(&field("result", Value::Map(map)), "entries=3");
        let kept = json["result"]["mapValue"]["fields"]
            .as_object()
            .expect("fields");
        assert_eq!(kept.len(), 3);
        assert!(kept.contains_key("k0"), "entries come in key order");
        assert_eq!(json["result"]["mapValue"][COUNT], 10);
    }

    #[test]
    fn a_complete_container_reports_no_count_so_the_reader_counts_what_it_has() {
        let json = encoded(
            &field(
                "tags",
                Value::Array(vec![Value::Integer(1), Value::Integer(2)]),
            ),
            "entries=8",
        );
        assert_eq!(
            json["tags"]["arrayValue"]["values"]
                .as_array()
                .expect("values")
                .len(),
            2
        );
        assert_eq!(json["tags"]["arrayValue"].get(COUNT), None);
    }

    #[test]
    fn a_container_below_the_drawn_depth_is_a_size_and_nothing_else() {
        // `result.payload` is never drawn, so it costs its size alone.
        let mut payload = Fields::new();
        for index in 0..500 {
            payload.insert(format!("k{index}"), Value::String("x".repeat(5_000).into()));
        }
        let mut result = Fields::new();
        result.insert("payload".to_owned(), Value::Map(payload));
        result.insert("status".to_owned(), Value::String("done".into()));
        let json = encoded(
            &field("result", Value::Map(result)),
            "bytes=256; entries=24",
        );
        let inner = &json["result"]["mapValue"]["fields"];
        assert_eq!(inner["status"], json!({ "stringValue": "done" }));
        assert_eq!(inner["payload"]["mapValue"]["fields"], json!({}));
        assert_eq!(inner["payload"]["mapValue"][COUNT], 500);
        // The whole field is now small enough to draw a cell from.
        assert!(
            json["result"].to_string().len() < 1_000,
            "{} bytes",
            json["result"].to_string().len()
        );
    }

    #[test]
    fn a_kept_field_is_whole_however_large_it_is() {
        let mut fields = field("cursorField", Value::String("y".repeat(5_000).into()));
        fields.insert("other".to_owned(), Value::String("z".repeat(5_000).into()));
        let json = encoded(&fields, "bytes=16; keep=cursorField");
        assert_eq!(json["cursorField"]["stringValue"], "y".repeat(5_000));
        assert_eq!(json["cursorField"].get(ELIDED), None);
        assert_eq!(json["other"][ELIDED], 4_984);
    }

    #[test]
    fn scalars_and_vectors_pass_through_as_an_ordinary_read_writes_them() {
        let mut fields = Fields::new();
        fields.insert("flag".to_owned(), Value::Boolean(true));
        fields.insert("n".to_owned(), Value::Integer(7));
        fields.insert("embedding".to_owned(), Value::Vector(vec![1.0, 2.0]));
        let json = encoded(&fields, "bytes=16");
        for name in ["flag", "n", "embedding"] {
            assert_eq!(
                json[name],
                encode_value(&fields[name]).expect("whole"),
                "{name} must be what a normal read returns"
            );
        }
    }
}
