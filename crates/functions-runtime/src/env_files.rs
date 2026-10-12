//! Editing dotenv files in place, and writing several files so a failed
//! reload can put every byte back.
//!
//! Shared by Functions codebases (`.env*` and `.secret.local`) and Extension
//! instances (`extensions/<id>.env*` and `.secret.local`), whose files use
//! the same dialect ([`crate::dotenv::parse_ordered`]).

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::dotenv::content_hash;

/// One change to a dotenv file: set (or add) `key`, or remove it (`None`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyChange {
    pub key: String,
    pub value: Option<String>,
}

/// Applies `changes` to a dotenv document: a key's line is replaced in place
/// (its last definition, the one that wins), a removed key loses every line
/// that defines it, and new keys are appended. Comments, blank lines, order
/// and line endings are kept; a value that needs it is double-quoted with
/// escapes the dialect reads back exactly.
#[must_use]
pub fn edit_env_file(text: &str, changes: &[KeyChange]) -> String {
    let ending = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut entries = split_entries(text);
    let mut appended: Vec<String> = Vec::new();
    for change in changes {
        let positions: Vec<usize> = entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| entry.key.as_deref() == Some(change.key.as_str()))
            .map(|(index, _)| index)
            .collect();
        if let Some(value) = &change.value {
            let line = format!("{}={}", change.key, quote_value(value));
            let prefix = format!("{}=", change.key);
            if let Some(last) = positions.last() {
                let entry = &mut entries[*last];
                entry.text = format!("{}{line}", entry.prefix);
            } else if let Some(existing) =
                appended.iter_mut().find(|added| added.starts_with(&prefix))
            {
                *existing = line;
            } else {
                appended.push(line);
            }
        } else {
            for index in positions.iter().rev() {
                entries.remove(*index);
            }
            appended.retain(|line| !line.starts_with(&format!("{}=", change.key)));
        }
    }
    let mut out = entries.iter().fold(String::new(), |mut out, entry| {
        out.push_str(&entry.text);
        out.push_str(&entry.ending);
        out
    });
    if !appended.is_empty() {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push_str(ending);
        }
        for line in appended {
            out.push_str(&line);
            out.push_str(ending);
        }
    }
    out
}

/// A dotenv value as the dialect writes it: bare when it reads back as is,
/// double-quoted with escapes otherwise.
#[must_use]
pub fn quote_value(value: &str) -> String {
    let needs_quotes = value
        .chars()
        .any(|character| character.is_whitespace() || matches!(character, '#' | '"' | '\'' | '\\'));
    if !needs_quotes {
        return value.to_owned();
    }
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{000b}' => out.push_str("\\v"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// One logical entry of a dotenv document: a definition (which may span
/// lines inside quotes), a comment or a blank line.
struct Entry {
    /// The defined key, for a definition.
    key: Option<String>,
    /// `export ` and indentation kept when the line is replaced.
    prefix: String,
    /// The entry's text without its final line ending.
    text: String,
    ending: String,
}

/// Splits a document into entries, keeping each one's exact text.
fn split_entries(text: &str) -> Vec<Entry> {
    let mut lines: Vec<(String, String)> = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let (line, ending, next) = match rest.find('\n') {
            Some(index) => {
                let line = &rest[..index];
                let (line, ending) = match line.strip_suffix('\r') {
                    Some(stripped) => (stripped, "\r\n"),
                    None => (line, "\n"),
                };
                (line, ending, &rest[index + 1..])
            }
            None => (rest, "", ""),
        };
        lines.push((line.to_owned(), ending.to_owned()));
        rest = next;
    }
    let mut entries = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let (line, ending) = &lines[index];
        let Some((prefix, key, value)) = definition(line) else {
            entries.push(Entry {
                key: None,
                prefix: String::new(),
                text: line.clone(),
                ending: ending.clone(),
            });
            index += 1;
            continue;
        };
        let mut text = line.clone();
        let mut last_ending = ending.clone();
        // A quoted value that does not close on its line runs on.
        if let Some(quote) = open_quote(value) {
            while index + 1 < lines.len() {
                index += 1;
                let (next, next_ending) = &lines[index];
                text.push_str(&last_ending);
                text.push_str(next);
                last_ending.clone_from(next_ending);
                if closes(next, quote) {
                    break;
                }
            }
        }
        entries.push(Entry {
            key: Some(key),
            prefix,
            text,
            ending: last_ending,
        });
        index += 1;
    }
    entries
}

/// `(prefix, key, value)` of a `KEY=value` line (with optional indentation
/// and `export`), as the dialect's line pattern reads keys.
fn definition(line: &str) -> Option<(String, String, &str)> {
    let trimmed = line.trim_start_matches([' ', '\t', '\u{000c}', '\u{000b}']);
    let indent = &line[..line.len() - trimmed.len()];
    let (export, body) = match trimmed.strip_prefix("export") {
        Some(after) if after.starts_with([' ', '\t']) => {
            let spaced = after.trim_start_matches([' ', '\t']);
            (&trimmed[..trimmed.len() - spaced.len()], spaced)
        }
        _ => ("", trimmed),
    };
    let key_end = body
        .find(|character: char| {
            !(character.is_alphanumeric() || matches!(character, '_' | '.' | '/'))
        })
        .unwrap_or(body.len());
    if key_end == 0 {
        return None;
    }
    let key = &body[..key_end];
    let after_key = body[key_end..].trim_start_matches([' ', '\t']);
    let value = after_key.strip_prefix('=')?;
    Some((format!("{indent}{export}"), key.to_owned(), value))
}

/// The quote a value opens without closing on its own line, if any.
fn open_quote(value: &str) -> Option<char> {
    let value = value.trim_start();
    let quote = value
        .chars()
        .next()
        .filter(|first| matches!(first, '"' | '\''))?;
    let body = &value[1..];
    (!closes(body, quote)).then_some(quote)
}

/// Whether `text` holds an unescaped `quote`.
fn closes(text: &str, quote: char) -> bool {
    let mut escaped = false;
    for character in text.chars() {
        if escaped {
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == quote {
            return true;
        }
    }
    false
}

/// Files written by [`write_files_atomically`], with what they held before.
#[derive(Debug, Clone, Default)]
pub struct WrittenFiles {
    files: Vec<WrittenFile>,
}

#[derive(Debug, Clone)]
struct WrittenFile {
    path: PathBuf,
    previous: Option<Vec<u8>>,
    written: [u8; 32],
}

impl WrittenFiles {
    /// The written paths, in order.
    #[must_use]
    pub fn paths(&self) -> Vec<PathBuf> {
        self.files.iter().map(|file| file.path.clone()).collect()
    }

    /// Each written file's content hash (to recognise one's own write when a
    /// watcher reports it).
    #[must_use]
    pub fn hashes(&self) -> Vec<(PathBuf, [u8; 32])> {
        self.files
            .iter()
            .map(|file| (file.path.clone(), file.written))
            .collect()
    }

    /// Puts every file's previous bytes back (atomically), or removes a file
    /// that did not exist. Returns each path with the hash it holds after
    /// the restore (`None` for a removed file).
    pub fn restore(&self) -> io::Result<Vec<(PathBuf, Option<[u8; 32]>)>> {
        let mut restored = Vec::with_capacity(self.files.len());
        let mut failure = None;
        for file in self.files.iter().rev() {
            let result = match &file.previous {
                Some(bytes) => {
                    write_atomically(&file.path, bytes).map(|()| Some(content_hash(bytes)))
                }
                None => match std::fs::remove_file(&file.path) {
                    Ok(()) => Ok(None),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
                    Err(error) => Err(error),
                },
            };
            match result {
                Ok(hash) => restored.push((file.path.clone(), hash)),
                Err(error) => failure = Some(error),
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(restored),
        }
    }
}

/// Writes each `(path, text)` through a temporary file and a rename, keeping
/// every file's previous bytes for [`WrittenFiles::restore`]. Creates
/// missing parent directories. When one write fails, the ones already made
/// are put back and the error is returned.
pub fn write_files_atomically(changes: Vec<(PathBuf, String)>) -> io::Result<WrittenFiles> {
    let mut written = WrittenFiles::default();
    for (path, text) in changes {
        let previous = match std::fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => {
                let _ = written.restore();
                return Err(error);
            }
        };
        if let Err(error) = write_atomically(&path, text.as_bytes()) {
            let _ = written.restore();
            return Err(error);
        }
        written.files.push(WrittenFile {
            path,
            previous,
            written: content_hash(text.as_bytes()),
        });
    }
    Ok(written)
}

fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let directory = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(directory)?;
    let name = path
        .file_name()
        .map_or_else(|| "file".into(), |name| name.to_string_lossy().into_owned());
    let temporary = directory.join(format!(
        ".{name}.firenook-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dotenv::parse_ordered;

    fn set(key: &str, value: &str) -> KeyChange {
        KeyChange {
            key: key.to_owned(),
            value: Some(value.to_owned()),
        }
    }

    fn remove(key: &str) -> KeyChange {
        KeyChange {
            key: key.to_owned(),
            value: None,
        }
    }

    fn values(text: &str) -> Vec<(String, String)> {
        parse_ordered(text).0
    }

    #[test]
    fn a_key_is_replaced_in_place_keeping_everything_else() {
        let text = "# settings\nexport GREETING=hi # inline\n\nCOUNT=1\n";
        let edited = edit_env_file(text, &[set("GREETING", "hello")]);
        assert_eq!(edited, "# settings\nexport GREETING=hello\n\nCOUNT=1\n");
        assert_eq!(
            values(&edited),
            [
                ("GREETING".to_owned(), "hello".to_owned()),
                ("COUNT".to_owned(), "1".to_owned())
            ]
        );
    }

    #[test]
    fn crlf_and_a_missing_final_newline_are_kept() {
        let text = "A=1\r\nB=2";
        assert_eq!(edit_env_file(text, &[set("B", "3")]), "A=1\r\nB=3");
        assert_eq!(
            edit_env_file(text, &[set("C", "4")]),
            "A=1\r\nB=2\r\nC=4\r\n"
        );
        assert_eq!(edit_env_file("", &[set("A", "1")]), "A=1\n");
    }

    #[test]
    fn removing_a_key_drops_every_line_that_defines_it() {
        let text = "A=1\nB=2\nA=3\n";
        assert_eq!(edit_env_file(text, &[remove("A")]), "B=2\n");
        assert_eq!(edit_env_file(text, &[set("A", "9")]), "A=1\nB=2\nA=9\n");
        assert_eq!(edit_env_file(text, &[remove("MISSING")]), text);
        assert_eq!(edit_env_file("", &[set("X", "1"), remove("X")]), "");
    }

    #[test]
    fn values_that_need_it_are_quoted_and_read_back_exactly() {
        for value in [
            "two words",
            " leading",
            "has # hash",
            "say \"hi\"",
            "it's",
            "line one\nline two",
            "tab\there",
            "back\\slash and space",
            "plain",
            "",
            "https://example.com/a?b=c&d=e",
        ] {
            let edited = edit_env_file("A=1\n", &[set("KEY", value)]);
            let parsed = values(&edited);
            assert_eq!(
                parsed[1],
                ("KEY".to_owned(), value.to_owned()),
                "{edited:?}"
            );
        }
        assert_eq!(quote_value("plain"), "plain");
        assert_eq!(quote_value("a b"), "\"a b\"");
    }

    #[test]
    fn a_multi_line_value_is_replaced_whole() {
        let text = "A=\"first\nsecond\"\nB=2\n";
        assert_eq!(values(text)[0].1, "first\nsecond");
        let edited = edit_env_file(text, &[set("A", "one")]);
        assert_eq!(edited, "A=one\nB=2\n");
        let removed = edit_env_file(text, &[remove("A")]);
        assert_eq!(removed, "B=2\n");
    }

    #[test]
    fn written_files_restore_their_previous_bytes_or_go_away() {
        let directory = tempfile::tempdir().expect("a directory");
        let existing = directory.path().join(".env");
        let created = directory.path().join("nested/.env.local");
        std::fs::write(&existing, "A=1\n").expect("written");
        let written = write_files_atomically(vec![
            (existing.clone(), "A=2\n".to_owned()),
            (created.clone(), "B=1\n".to_owned()),
        ])
        .expect("written");
        assert_eq!(std::fs::read_to_string(&existing).expect("read"), "A=2\n");
        assert_eq!(std::fs::read_to_string(&created).expect("read"), "B=1\n");
        assert_eq!(
            written.hashes()[0],
            (existing.clone(), content_hash(b"A=2\n"))
        );
        let restored = written.restore().expect("restored");
        assert_eq!(std::fs::read_to_string(&existing).expect("read"), "A=1\n");
        assert!(!created.exists());
        assert!(restored.contains(&(existing, Some(content_hash(b"A=1\n")))));
        assert!(restored.contains(&(created, None)));
        let leftovers: Vec<_> = std::fs::read_dir(directory.path())
            .expect("listed")
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains("firenook-"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }
}
