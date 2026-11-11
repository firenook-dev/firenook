//! The conformance ledger: which recorded answers under `conformance/fixtures`
//! a replay test actually compared with Firenook's own, and how much of each.
//!
//! A replay calls [`checked`] right after one case's comparison passes, or
//! [`differs`] where the test asserts that Firenook deliberately answers
//! otherwise. `set` and `case` are exactly the ids
//! `conformance/src/report/cases.mjs` lists (`sets[].id`, `cases[].id`), and
//! [`Compared`] says what the comparison covered.
//!
//! When [`ENV`] names a directory, each call appends one JSON line
//! `{"set":…,"case":…,"result":"checked"|"differs","compared":…,"reason":…}`
//! to `<directory>/<process id>.jsonl`. When it is unset or empty the calls
//! do nothing beyond one atomic load. `conformance/src/report/verify.mjs`
//! joins the lines with the case list.

use std::fmt::Write as _;
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock, PoisonError};

/// The environment variable that names the ledger directory.
pub const ENV: &str = "FIRENOOK_CONFORMANCE_LEDGER";

/// What a replay compared of one recorded answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Compared {
    /// The status or code and the body as recorded, modulo the replay's
    /// documented normalisations (times, generated ids, tokens).
    Answer,
    /// The status or code and the error message, for an answer that is an
    /// error; no success body.
    Error,
    /// The HTTP status or gRPC code only.
    Status,
    /// A rules allow/deny or a compile pass/fail only.
    Verdict,
    /// An observed effect: events delivered, a document or file written.
    Behaviour,
}

impl Compared {
    /// The name the ledger line carries.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Answer => "answer",
            Self::Error => "error",
            Self::Status => "status",
            Self::Verdict => "verdict",
            Self::Behaviour => "behaviour",
        }
    }
}

static LEDGER: OnceLock<Option<Mutex<File>>> = OnceLock::new();

/// A replay compared this recorded case with Firenook's answer, as far as
/// `compared` says, and they matched.
///
/// # Panics
///
/// When [`ENV`] names a directory that cannot be created or written: a
/// ledger that silently dropped lines would undercount.
pub fn checked(set: &str, case: &str, compared: Compared) {
    record(set, case, "checked", compared, None);
}

/// A replay checked this recorded case, as far as `compared` says, and
/// asserts that Firenook deliberately answers otherwise, for `reason`.
///
/// # Panics
///
/// When [`ENV`] names a directory that cannot be created or written.
pub fn differs(set: &str, case: &str, compared: Compared, reason: &str) {
    record(set, case, "differs", compared, Some(reason));
}

fn record(set: &str, case: &str, result: &str, compared: Compared, reason: Option<&str>) {
    let Some(file) = LEDGER.get_or_init(open) else {
        return;
    };
    let line = line(set, case, result, compared, reason);
    file.lock()
        .unwrap_or_else(PoisonError::into_inner)
        .write_all(line.as_bytes())
        .unwrap_or_else(|error| panic!("{ENV}: cannot append to the ledger: {error}"));
}

fn open() -> Option<Mutex<File>> {
    let directory = PathBuf::from(std::env::var_os(ENV).filter(|value| !value.is_empty())?);
    std::fs::create_dir_all(&directory)
        .unwrap_or_else(|error| panic!("{ENV}: cannot create {}: {error}", directory.display()));
    let path = directory.join(format!("{}.jsonl", std::process::id()));
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .unwrap_or_else(|error| panic!("{ENV}: cannot open {}: {error}", path.display()));
    Some(Mutex::new(file))
}

/// One ledger line, newline included.
fn line(set: &str, case: &str, result: &str, compared: Compared, reason: Option<&str>) -> String {
    let mut out = String::with_capacity(64 + set.len() + case.len());
    out.push_str("{\"set\":");
    push_string(&mut out, set);
    out.push_str(",\"case\":");
    push_string(&mut out, case);
    out.push_str(",\"result\":");
    push_string(&mut out, result);
    out.push_str(",\"compared\":");
    push_string(&mut out, compared.as_str());
    if let Some(reason) = reason {
        out.push_str(",\"reason\":");
        push_string(&mut out, reason);
    }
    out.push_str("}\n");
    out
}

/// Appends `value` as a JSON string literal.
fn push_string(out: &mut String, value: &str) {
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            control if control < ' ' => {
                write!(out, "\\u{:04x}", u32::from(control)).expect("writing to a String");
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::{Compared, line};

    #[test]
    fn a_checked_line_has_no_reason() {
        assert_eq!(
            line("auth-v1", "program/step", "checked", Compared::Answer, None),
            "{\"set\":\"auth-v1\",\"case\":\"program/step\",\"result\":\"checked\",\"compared\":\"answer\"}\n"
        );
    }

    #[test]
    fn strings_are_escaped_as_json() {
        assert_eq!(
            line(
                "s",
                "q\"b\\n\nt\tc\u{1}",
                "differs",
                Compared::Verdict,
                Some("火🔥 \u{1f}")
            ),
            "{\"set\":\"s\",\"case\":\"q\\\"b\\\\n\\nt\\tc\\u0001\",\"result\":\"differs\",\"compared\":\"verdict\",\"reason\":\"火🔥 \\u001f\"}\n"
        );
    }

    #[test]
    fn every_compared_value_has_its_name() {
        let names = [
            Compared::Answer,
            Compared::Error,
            Compared::Status,
            Compared::Verdict,
            Compared::Behaviour,
        ]
        .map(Compared::as_str);
        assert_eq!(names, ["answer", "error", "status", "verdict", "behaviour"]);
    }
}
