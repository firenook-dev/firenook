//! Edits to a database's `firestore.indexes.json`, made as a person makes
//! them in an editor: an entry added at the end of its list, or taken out of
//! it, and every other byte of the file left as it was. The file is checked
//! in beside the app, so a change made here reads in a diff as the lines it
//! is, not as the whole file written out again.
//!
//! The file is read twice: once by `serde_json`, which says whether it is
//! JSON at all, and once by a small reader that keeps where each value
//! starts and ends, which is what an edit splices at. An added entry is
//! indented as the entries beside it are and laid out as the Firebase CLI
//! writes one, and a file with none yet gets the CLI's two spaces.

use std::fmt::Write as _;

use firenook_query_engine::{FieldOverrideEntry, IndexCatalog, IndexRequirement, SingleFieldIndex};
use serde_json::Value;

/// The file a database gets when the console adds its first index and
/// `firebase.json` names a file that is not there yet.
const NEW_FILE: &str = "{\n  \"indexes\": [],\n  \"fieldOverrides\": []\n}\n";

/// Where an entry goes in the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Section {
    /// `indexes`: composite indexes.
    Indexes,
    /// `fieldOverrides`: one field's own indexes.
    FieldOverrides,
}

impl Section {
    /// The section as the file names it.
    pub(crate) const fn key(self) -> &'static str {
        match self {
            Self::Indexes => "indexes",
            Self::FieldOverrides => "fieldOverrides",
        }
    }

    /// The section a request names: `indexes` or `fieldOverrides`.
    pub(crate) fn named(name: &str) -> Option<Self> {
        match name {
            "indexes" => Some(Self::Indexes),
            "fieldOverrides" => Some(Self::FieldOverrides),
            _ => None,
        }
    }
}

/// What an edit did, entry by entry.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Outcome {
    /// Entries added, and indexes added to an override already there.
    pub(crate) added: usize,
    pub(crate) removed: usize,
    /// Entries asked for that changed nothing: already declared, or not
    /// there to take out.
    pub(crate) unchanged: usize,
}

impl Outcome {
    pub(crate) const fn changed(self) -> bool {
        self.added + self.removed > 0
    }
}

/// `source` (`None`: there is no file yet) with every entry of `remove`
/// taken out, then every entry of `add` added, and what that did. An entry
/// to add that the file already declares, by the rules the queries are
/// checked by, is left alone; an override for a field the file overrides
/// already adds its indexes to that override. Nothing is written here: the
/// new text comes back, and is a valid index file.
pub(crate) fn edit(
    source: Option<&str>,
    add: &[(Section, Value)],
    remove: &[(Section, Value)],
) -> Result<(String, Outcome), String> {
    let mut text = source.unwrap_or(NEW_FILE).to_owned();
    serde_json::from_str::<Value>(&text).map_err(|error| format!("it is not JSON: {error}"))?;
    IndexCatalog::from_json(&text).map_err(|error| error.to_string())?;
    if !matches!(read(&text)?.kind, Kind::Object(_)) {
        return Err("it is not a JSON object".to_owned());
    }
    let mut outcome = Outcome::default();
    for (section, entry) in remove {
        match remove_entry(&text, *section, entry)? {
            Some(next) => {
                text = next;
                outcome.removed += 1;
            }
            None => outcome.unchanged += 1,
        }
    }
    for (section, entry) in add {
        let next = match section {
            Section::Indexes => add_index(&text, entry)?,
            Section::FieldOverrides => add_override(&text, entry)?,
        };
        match next {
            Some((next, added)) => {
                text = next;
                outcome.added += added;
            }
            None => outcome.unchanged += 1,
        }
    }
    // A last look, so a fault here can never leave a file the next start
    // refuses.
    IndexCatalog::from_json(&text)
        .map_err(|error| format!("the edit would leave the file invalid: {error}"))?;
    Ok((text, outcome))
}

/// The text with the first entry of `section` equal to `entry` taken out,
/// with the comma that joined it; `None` when there is none.
fn remove_entry(text: &str, section: Section, entry: &Value) -> Result<Option<String>, String> {
    let root = read(text)?;
    let Some(list) = root.member(section.key()) else {
        return Ok(None);
    };
    let Kind::Array(entries) = &list.kind else {
        return Err(format!("its \"{}\" is not a list", section.key()));
    };
    let Some(at) = entries.iter().position(|node| node.value(text) == *entry) else {
        return Ok(None);
    };
    let cut = match (at.checked_sub(1), entries.get(at + 1)) {
        // The only entry: the list is left empty, on one line.
        (None, None) => return Ok(Some(splice(text, list.start..list.end, "[]"))),
        // Up to the next entry, taking the comma after it.
        (_, Some(next)) => entries[at].start..next.start,
        // The last one: from the end of the entry before, taking the comma
        // before it.
        (Some(before), None) => entries[before].end..entries[at].end,
    };
    Ok(Some(splice(text, cut, "")))
}

/// The text with `entry` added to `indexes`, unless an index there serves
/// the same queries; the number added comes beside it.
fn add_index(text: &str, entry: &Value) -> Result<Option<(String, usize)>, String> {
    let wanted = IndexRequirement::from_entry(entry).map_err(|error| error.to_string())?;
    if wanted.fields.is_empty() {
        return Err("an index names at least one field".to_owned());
    }
    let root = read(text)?;
    let Some(list) = root.member("indexes") else {
        return Ok(Some((
            add_member(text, &root, "indexes", std::slice::from_ref(entry)),
            1,
        )));
    };
    let Kind::Array(entries) = &list.kind else {
        return Err("its \"indexes\" is not a list".to_owned());
    };
    let declared = entries.iter().any(|node| {
        IndexRequirement::from_entry(&node.value(text)).is_ok_and(|index| index == wanted)
    });
    Ok((!declared).then(|| (append(text, list, std::slice::from_ref(entry)), 1)))
}

/// The text with the override `entry` added to `fieldOverrides`, or, when
/// the field has an override there already, with the indexes of `entry` it
/// lacks added to it; the number added comes beside it.
fn add_override(text: &str, entry: &Value) -> Result<Option<(String, usize)>, String> {
    let wanted = FieldOverrideEntry::from_entry(entry).map_err(|error| error.to_string())?;
    let root = read(text)?;
    let Some(list) = root.member("fieldOverrides") else {
        return Ok(Some((
            add_member(text, &root, "fieldOverrides", std::slice::from_ref(entry)),
            1,
        )));
    };
    let Kind::Array(entries) = &list.kind else {
        return Err("its \"fieldOverrides\" is not a list".to_owned());
    };
    let existing = entries.iter().find_map(|node| {
        let read = FieldOverrideEntry::from_entry(&node.value(text)).ok()?;
        (read.collection_group == wanted.collection_group && read.field_path == wanted.field_path)
            .then_some((node, read))
    });
    let Some((node, existing)) = existing else {
        return Ok(Some((append(text, list, std::slice::from_ref(entry)), 1)));
    };
    let missing = entry
        .get("indexes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|index| {
            SingleFieldIndex::from_entry(index)
                .is_ok_and(|index| !existing.indexes.contains(&index))
        })
        .cloned()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(None);
    }
    let added = missing.len();
    Ok(Some(match node.member("indexes") {
        Some(
            indexes @ Node {
                kind: Kind::Array(_),
                ..
            },
        ) => (append(text, indexes, &missing), added),
        Some(_) => return Err("an override's \"indexes\" is not a list".to_owned()),
        None => (add_member(text, node, "indexes", &missing), added),
    }))
}

/// The text with `items` after the last entry of the list `list`, one per
/// line at its entries' indentation, or on its line when the list is on
/// one.
fn append(text: &str, array: &Node, items: &[Value]) -> String {
    let Kind::Array(entries) = &array.kind else {
        unreachable!("a list")
    };
    let style = Style::of(text);
    if let (Some(first), Some(end)) = (entries.first(), entries.last()) {
        let mut added = String::new();
        if text[array.start..first.start].contains('\n') {
            let indent = indent_before(text, first.start);
            for item in items {
                let _ = write!(
                    added,
                    ",{}{indent}{}",
                    style.newline,
                    style.render(item, indent)
                );
            }
        } else {
            for item in items {
                let _ = write!(added, ", {}", compact(item));
            }
        }
        return splice(text, end.end..end.end, &added);
    }
    let array_text = if style.pretty {
        let outer = line_indent(text, array.start);
        let inner = format!("{outer}{}", style.unit);
        let lines = items
            .iter()
            .map(|item| format!("{inner}{}", style.render(item, &inner)))
            .collect::<Vec<_>>()
            .join(&format!(",{}", style.newline));
        format!("[{nl}{lines}{nl}{outer}]", nl = style.newline)
    } else {
        format!(
            "[{}]",
            items.iter().map(compact).collect::<Vec<_>>().join(",")
        )
    };
    splice(text, array.start..array.end, &array_text)
}

/// The text with `key` set to a list of `items` at the end of the object
/// `object`.
fn add_member(text: &str, object: &Node, key: &str, items: &[Value]) -> String {
    let Kind::Object(members) = &object.kind else {
        unreachable!("an object")
    };
    let style = Style::of(text);
    let value = Value::Array(items.to_vec());
    if let (Some(first), Some(end)) = (members.first(), members.last()) {
        let added = if text[object.start..first.key_start].contains('\n') {
            let indent = indent_before(text, first.key_start);
            format!(
                ",{}{indent}\"{key}\": {}",
                style.newline,
                style.render(&value, indent)
            )
        } else {
            format!(",\"{key}\":{}", compact(&value))
        };
        return splice(text, end.value.end..end.value.end, &added);
    }
    let outer = line_indent(text, object.start);
    let inner = format!("{outer}{}", style.unit);
    let object_text = format!(
        "{{{nl}{inner}\"{key}\": {}{nl}{outer}}}",
        style.render(&value, &inner),
        nl = style.newline
    );
    splice(text, object.start..object.end, &object_text)
}

fn splice(text: &str, range: std::ops::Range<usize>, with: &str) -> String {
    let mut out = String::with_capacity(text.len() + with.len());
    out.push_str(&text[..range.start]);
    out.push_str(with);
    out.push_str(&text[range.end..]);
    out
}

/// The whitespace between the start of `at`'s line and `at`.
fn indent_before(text: &str, at: usize) -> &str {
    let start = text[..at].rfind('\n').map_or(0, |newline| newline + 1);
    let before = &text[start..at];
    if before.chars().all(|c| c == ' ' || c == '\t') {
        before
    } else {
        line_indent(text, at)
    }
}

/// The whitespace `at`'s line starts with.
fn line_indent(text: &str, at: usize) -> &str {
    let start = text[..at].rfind('\n').map_or(0, |newline| newline + 1);
    let line = &text[start..];
    let end = line
        .find(|c: char| c != ' ' && c != '\t')
        .unwrap_or(line.len());
    &line[..end]
}

/// How the file is laid out, as far as an addition needs to know.
struct Style {
    /// Whether it is spread over lines at all, rather than written on one.
    pretty: bool,
    /// One level of indentation: the first indented line's.
    unit: String,
    newline: &'static str,
}

impl Style {
    fn of(text: &str) -> Self {
        let unit = text
            .lines()
            .find_map(|line| {
                let indent = line_indent(line, 0);
                (!indent.is_empty() && indent.len() < line.trim_end().len())
                    .then(|| indent.to_owned())
            })
            .unwrap_or_else(|| "  ".to_owned());
        Self {
            pretty: text.trim_end().contains('\n'),
            unit,
            newline: if text.contains("\r\n") { "\r\n" } else { "\n" },
        }
    }

    /// `value` spread over lines, its first line where the caller puts it
    /// and the rest at `indent` and below.
    fn render(&self, value: &Value, indent: &str) -> String {
        match value {
            Value::Array(items) if !items.is_empty() => {
                let inner = format!("{indent}{}", self.unit);
                let lines = items
                    .iter()
                    .map(|item| format!("{inner}{}", self.render(item, &inner)))
                    .collect::<Vec<_>>()
                    .join(&format!(",{}", self.newline));
                format!("[{nl}{lines}{nl}{indent}]", nl = self.newline)
            }
            Value::Object(map) if !map.is_empty() => {
                let inner = format!("{indent}{}", self.unit);
                let lines = ordered(map)
                    .into_iter()
                    .map(|(key, item)| {
                        format!("{inner}{}: {}", quoted(key), self.render(item, &inner))
                    })
                    .collect::<Vec<_>>()
                    .join(&format!(",{}", self.newline));
                format!("{{{nl}{lines}{nl}{indent}}}", nl = self.newline)
            }
            _ => compact(value),
        }
    }
}

/// `value` on one line, its keys in the CLI's order.
fn compact(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(compact).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => format!(
            "{{{}}}",
            ordered(map)
                .into_iter()
                .map(|(key, item)| format!("{}:{}", quoted(key), compact(item)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => value.to_string(),
    }
}

fn quoted(key: &str) -> String {
    Value::String(key.to_owned()).to_string()
}

/// An object's members in the order the Firebase CLI writes that kind of
/// object, any others after them by name.
fn ordered(map: &serde_json::Map<String, Value>) -> Vec<(&str, &Value)> {
    let order: &[&str] = if map.contains_key("fields") {
        &["collectionGroup", "queryScope", "fields"]
    } else if map.contains_key("indexes") {
        &["collectionGroup", "fieldPath", "ttl", "indexes"]
    } else if map.contains_key("fieldPath") {
        &["fieldPath", "order", "arrayConfig", "vectorConfig"]
    } else {
        &[
            "order",
            "arrayConfig",
            "vectorConfig",
            "queryScope",
            "dimension",
            "flat",
        ]
    };
    let mut members = map
        .iter()
        .map(|(key, value)| (key.as_str(), value))
        .collect::<Vec<_>>();
    members.sort_by_key(|(key, _)| {
        (
            order
                .iter()
                .position(|known| known == key)
                .unwrap_or(order.len()),
            *key,
        )
    });
    members
}

/// A value of the file and where it is.
#[derive(Debug)]
struct Node {
    start: usize,
    end: usize,
    kind: Kind,
}

#[derive(Debug)]
enum Kind {
    Object(Vec<Member>),
    Array(Vec<Node>),
    Scalar,
}

#[derive(Debug)]
struct Member {
    key: String,
    key_start: usize,
    value: Node,
}

impl Node {
    /// The value of `key`, when this is an object that has it (the last one
    /// written, as `serde_json` reads a key written twice).
    fn member(&self, key: &str) -> Option<&Self> {
        let Kind::Object(members) = &self.kind else {
            return None;
        };
        members
            .iter()
            .rev()
            .find(|member| member.key == key)
            .map(|member| &member.value)
    }

    fn value(&self, text: &str) -> Value {
        serde_json::from_str(&text[self.start..self.end]).unwrap_or(Value::Null)
    }
}

/// Reads `text`, which `serde_json` has already found to be JSON, keeping
/// where each value is.
fn read(text: &str) -> Result<Node, String> {
    let mut reader = Reader {
        text: text.as_bytes(),
        at: 0,
    };
    reader.value()
}

struct Reader<'a> {
    text: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn space(&mut self) {
        while self
            .text
            .get(self.at)
            .is_some_and(|byte| matches!(byte, b' ' | b'\t' | b'\n' | b'\r'))
        {
            self.at += 1;
        }
    }

    fn next(&mut self) -> Result<u8, String> {
        let byte = *self.text.get(self.at).ok_or("the file ends too soon")?;
        self.at += 1;
        Ok(byte)
    }

    fn value(&mut self) -> Result<Node, String> {
        self.space();
        let start = self.at;
        let kind = match self.text.get(self.at) {
            Some(b'{') => {
                self.at += 1;
                let mut members = Vec::new();
                self.space();
                if self.text.get(self.at) == Some(&b'}') {
                    self.at += 1;
                } else {
                    loop {
                        self.space();
                        let key_start = self.at;
                        let key = self.string()?;
                        self.space();
                        if self.next()? != b':' {
                            return Err("a key without a value".to_owned());
                        }
                        let value = self.value()?;
                        members.push(Member {
                            key,
                            key_start,
                            value,
                        });
                        self.space();
                        match self.next()? {
                            b',' => {}
                            b'}' => break,
                            _ => return Err("an object not closed".to_owned()),
                        }
                    }
                }
                Kind::Object(members)
            }
            Some(b'[') => {
                self.at += 1;
                let mut items = Vec::new();
                self.space();
                if self.text.get(self.at) == Some(&b']') {
                    self.at += 1;
                } else {
                    loop {
                        items.push(self.value()?);
                        self.space();
                        match self.next()? {
                            b',' => {}
                            b']' => break,
                            _ => return Err("a list not closed".to_owned()),
                        }
                    }
                }
                Kind::Array(items)
            }
            Some(b'"') => {
                self.string()?;
                Kind::Scalar
            }
            Some(_) => {
                while self.text.get(self.at).is_some_and(|byte| {
                    !matches!(byte, b',' | b']' | b'}' | b' ' | b'\t' | b'\n' | b'\r')
                }) {
                    self.at += 1;
                }
                Kind::Scalar
            }
            None => return Err("the file ends too soon".to_owned()),
        };
        Ok(Node {
            start,
            end: self.at,
            kind,
        })
    }

    fn string(&mut self) -> Result<String, String> {
        let start = self.at;
        if self.next()? != b'"' {
            return Err("a key that is not a string".to_owned());
        }
        loop {
            match self.next()? {
                b'\\' => {
                    self.next()?;
                }
                b'"' => break,
                _ => {}
            }
        }
        let quoted =
            std::str::from_utf8(&self.text[start..self.at]).map_err(|error| error.to_string())?;
        serde_json::from_str(quoted).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
#[path = "index_file_tests.rs"]
mod tests;
