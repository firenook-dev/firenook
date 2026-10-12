//! One filter language for every section's filter field, parsed the same
//! way in the browser (`console/src/lib/filter.ts`) and here, so the URL's
//! `q` means the same thing on both sides. GitHub's search grammar, which
//! developers already type:
//!
//! ```text
//! query   = *WS [ item *( 1*WS item ) ] *WS
//! item    = [ "-" ] ( term / phrase / regex / word )  ; "-" negates
//! term    = key ( ":" / "=" ) [ op ] value
//! key     = ALPHA *( ALPHA / DIGIT / "_" / "." / "-" ) ; case-insensitive, except a Path key's suffix
//! regex   = "/" 1*( any but "/" and "\" / "\" any ) "/" [ "i" ]  ; only in a field set that opts in
//! op      = ">=" / "<=" / ">" / "<"
//! value   = phrase / bare
//! phrase  = DQUOTE *( any but DQUOTE and "\" / "\" ( DQUOTE / "\" ) ) DQUOTE
//! bare    = 1*( any but WS and DQUOTE )
//! word    = bare                                        ; a bare token that is not a term
//! WS      = space, tab, line feed, carriage return, form feed or vertical tab
//! ```
//!
//! Every term and word must match; a key repeated with `:` on an enum or
//! exact field matches any of its values; two ranges on one key must both
//! hold; every negated term excludes on its own. An unknown key is an error, never text: `foo:bar`
//! silently searching for "foo:bar" is the failure this prevents, and a
//! quoted phrase is how to search for it. A backslash inside a phrase
//! escapes only a quote or a backslash; before anything else it is kept.
//!
//! The golden file `console/src/lib/filter-cases.json` pins every case both
//! sides must agree on, messages and UTF-16 spans included; a grammar change
//! edits it first. Each section keeps its own cases file in the same format
//! and runs it with [`golden::run`] (and `runGoldenCases` in Vitest).

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::json;
use time::format_description::well_known::Rfc3339;
use time::{Date, Month, OffsetDateTime};
use ts_rs::TS;

use crate::api_error::ApiError;

/// A parsed filter, before a section checks it against its fields (and,
/// after [`validate`], with keys and enum values canonical).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub(crate) struct FilterQuery {
    pub(crate) terms: Vec<FilterTerm>,
    pub(crate) words: Vec<FilterWord>,
    pub(crate) regexes: Vec<FilterRegex>,
}

/// A `/pattern/` item, passed through for the section to compile.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilterRegex {
    /// What stood between the slashes, backslashes kept.
    pub(crate) pattern: String,
    pub(crate) case_insensitive: bool,
    pub(crate) negated: bool,
    pub(crate) from: usize,
    pub(crate) to: usize,
}

/// One `key:value` item.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct FilterTerm {
    /// As typed until [`validate`]; then the field's key (lowercase), or a
    /// `Path` prefix as declared followed by the suffix as typed.
    pub(crate) key: String,
    pub(crate) op: FilterOp,
    /// Unquoted; after [`validate`] an enum's canonical value or `true` /
    /// `false` for a boolean, and as typed otherwise.
    pub(crate) value: String,
    pub(crate) negated: bool,
    /// UTF-16 offsets of the whole item in the text.
    pub(crate) from: usize,
    pub(crate) to: usize,
}

/// A word or quoted phrase, matched against the section's text fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct FilterWord {
    pub(crate) text: String,
    pub(crate) negated: bool,
    pub(crate) from: usize,
    pub(crate) to: usize,
}

/// How a term compares.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FilterOp {
    Eq,
    Gt,
    Ge,
    Lt,
    Le,
}

impl FilterOp {
    const fn spelling(self) -> &'static str {
        match self {
            Self::Eq => ":",
            Self::Gt => ">",
            Self::Ge => ">=",
            Self::Lt => "<",
            Self::Le => "<=",
        }
    }
}

/// One field a section accepts.
#[derive(Debug)]
pub(crate) struct FieldSpec {
    pub(crate) key: &'static str,
    pub(crate) aliases: &'static [&'static str],
    pub(crate) kind: FieldKind,
    /// One line for the completion list: "Sign-in provider".
    pub(crate) help: &'static str,
}

/// What a field's values are.
#[derive(Debug)]
#[allow(
    dead_code,
    reason = "the section streams declare their fields with these; the golden harness builds every kind"
)]
pub(crate) enum FieldKind {
    /// Substring, case-insensitive.
    Text,
    /// Equality, case-sensitive; a trailing `*` means "starts with".
    Exact,
    /// One of these values, case-insensitive; `aliases` maps a short
    /// spelling to a value (`("google", "google.com")`).
    Enum {
        values: &'static [&'static str],
        aliases: &'static [(&'static str, &'static str)],
    },
    /// Any dotted key under one of these prefixes (`data.`, `labels.`): the
    /// spec's `key` is the help entry and the term keeps the full path,
    /// prefix as declared and suffix as typed. Matched as `Exact`; `<` `>`
    /// compare numerically when both sides are numbers, else as strings.
    Path {
        prefixes: &'static [&'static str],
    },
    /// `true`, `false`, `yes`, `no`.
    Bool,
    /// RFC 3339, `YYYY-MM-DD`, `now`, `today`, or relative `-15m`, `-2h`,
    /// `-7d` (`s`, `m`, `h`, `d`, `w`).
    Time,
    Number,
    /// `512`, `10KB`, `2MB` (powers of 1024, as the console writes sizes).
    Bytes,
    /// `250ms`, `2s`, `1.5m`, `1h`.
    Duration,
}

impl FieldKind {
    const fn name(&self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Exact => "exact",
            Self::Enum { .. } => "enum",
            Self::Path { .. } => "path",
            Self::Bool => "bool",
            Self::Time => "time",
            Self::Number => "number",
            Self::Bytes => "bytes",
            Self::Duration => "duration",
        }
    }

    /// Whether `<` and `>` mean something for this kind.
    const fn ordered(&self) -> bool {
        matches!(
            self,
            Self::Path { .. } | Self::Time | Self::Number | Self::Bytes | Self::Duration
        )
    }
}

/// A section's fields, and whether `/regex/` items are items (Logs) or
/// words (everywhere else: paths start with a slash).
#[derive(Debug)]
pub(crate) struct FieldSet {
    pub(crate) fields: &'static [FieldSpec],
    pub(crate) regex: bool,
}

#[allow(
    dead_code,
    reason = "the section streams parse their filters and describe their fields with it"
)]
impl FieldSet {
    /// Parses and validates `text` against these fields.
    pub(crate) fn parse(&self, text: &str) -> Result<FilterQuery, FilterError> {
        validate(parse_filter(text, self.regex)?, self)
    }

    /// The fields as the console's completions read them (`ListMeta`).
    pub(crate) fn infos(&self) -> Vec<FieldSpecInfo> {
        self.fields.iter().map(FieldSpec::info).collect()
    }
}

impl FieldSpec {
    /// This field as the console's completions read it.
    pub(crate) fn info(&self) -> FieldSpecInfo {
        let (values, value_aliases, prefixes) = match &self.kind {
            FieldKind::Enum { values, aliases } => (
                values.iter().map(|value| (*value).to_owned()).collect(),
                aliases
                    .iter()
                    .map(|(alias, value)| ((*alias).to_owned(), (*value).to_owned()))
                    .collect(),
                Vec::new(),
            ),
            FieldKind::Path { prefixes } => (
                Vec::new(),
                BTreeMap::new(),
                prefixes.iter().map(|prefix| (*prefix).to_owned()).collect(),
            ),
            _ => (Vec::new(), BTreeMap::new(), Vec::new()),
        };
        FieldSpecInfo {
            key: self.key.to_owned(),
            aliases: self
                .aliases
                .iter()
                .map(|alias| (*alias).to_owned())
                .collect(),
            kind: self.kind.name().to_owned(),
            help: self.help.to_owned(),
            values,
            value_aliases,
            prefixes,
        }
    }
}

/// One filter field as the console's completions read it: the same spec
/// the engine validates with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FieldSpecInfo {
    /// The key, as written in a filter: `provider`.
    pub key: String,
    /// Other spellings of the key: `p`.
    pub aliases: Vec<String>,
    #[ts(
        type = "\"text\" | \"exact\" | \"enum\" | \"path\" | \"bool\" | \"time\" | \"number\" | \"bytes\" | \"duration\""
    )]
    pub kind: String,
    /// One line for the completion list: "Sign-in provider".
    pub help: String,
    /// An enum's values, canonical spellings.
    pub values: Vec<String>,
    /// An enum's short spellings, each with the value it means.
    pub value_aliases: BTreeMap<String, String>,
    /// A path field's prefixes: `data.`, `labels.`.
    pub prefixes: Vec<String>,
}

/// Why a filter cannot be used, and the UTF-16 span to underline.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct FilterError {
    pub(crate) message: String,
    pub(crate) from: usize,
    pub(crate) to: usize,
}

impl From<FilterError> for ApiError {
    fn from(error: FilterError) -> Self {
        Self::invalid(error.message)
            .with_extra("span", json!({ "from": error.from, "to": error.to }))
    }
}

const fn is_ws(character: char) -> bool {
    matches!(character, ' ' | '\t' | '\n' | '\r' | '\u{c}' | '\u{b}')
}

const fn is_key_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
}

/// The message for a `/` that does not make a regex item.
const REGEX_MESSAGE: &str = "A \"/\" starts a regex in this filter; quote the text to search for a path, like \"/api/users\".";
const QUOTE_NOT_CLOSED: &str = "This quote is not closed.";
const SPACE_AFTER_QUOTE: &str = "Put a space after the closing quote.";
const QUOTE_IN_WORD: &str = "Put a space before this quote, or quote the whole text.";

struct Parser {
    chars: Vec<char>,
    /// The UTF-16 offset of each char, and of the end.
    utf16: Vec<usize>,
    regex: bool,
}

/// Parses `text`; `regex` says whether `/…/` is a regex item or a word.
/// `Err` carries the message and the UTF-16 span to underline.
pub(crate) fn parse_filter(text: &str, regex: bool) -> Result<FilterQuery, FilterError> {
    let chars: Vec<char> = text.chars().collect();
    let mut utf16 = Vec::with_capacity(chars.len() + 1);
    let mut offset = 0;
    for character in &chars {
        utf16.push(offset);
        offset += character.len_utf16();
    }
    utf16.push(offset);
    Parser {
        chars,
        utf16,
        regex,
    }
    .parse()
}

impl Parser {
    fn error(&self, message: &str, from: usize, to: usize) -> FilterError {
        FilterError {
            message: message.to_owned(),
            from: self.utf16[from],
            to: self.utf16[to],
        }
    }

    /// The end of the run of non-whitespace starting at `at`.
    fn run_end(&self, at: usize) -> usize {
        let mut end = at;
        while end < self.chars.len() && !is_ws(self.chars[end]) {
            end += 1;
        }
        end
    }

    fn parse(&self) -> Result<FilterQuery, FilterError> {
        let mut query = FilterQuery::default();
        let length = self.chars.len();
        let mut at = 0;
        loop {
            while at < length && is_ws(self.chars[at]) {
                at += 1;
            }
            if at == length {
                return Ok(query);
            }
            let start = at;
            let mut negated = false;
            if self.chars[at] == '-' && at + 1 < length && !is_ws(self.chars[at + 1]) {
                negated = true;
                at += 1;
            }
            at = match self.chars[at] {
                '"' => {
                    let (text, end) = self.phrase(at)?;
                    self.boundary(start, end)?;
                    query.words.push(FilterWord {
                        text,
                        negated,
                        from: self.utf16[start],
                        to: self.utf16[end],
                    });
                    end
                }
                '/' if self.regex => {
                    let (pattern, case_insensitive, end) = self.regex_item(start, at)?;
                    query.regexes.push(FilterRegex {
                        pattern,
                        case_insensitive,
                        negated,
                        from: self.utf16[start],
                        to: self.utf16[end],
                    });
                    end
                }
                _ => {
                    if let Some(separator) = self.key_end(at) {
                        let (term, end) = self.term(start, at, separator, negated)?;
                        query.terms.push(term);
                        end
                    } else {
                        let (text, end) = self.bare(at)?;
                        query.words.push(FilterWord {
                            text,
                            negated,
                            from: self.utf16[start],
                            to: self.utf16[end],
                        });
                        end
                    }
                }
            };
        }
    }

    /// After a quoted phrase or a regex: the item must end there.
    fn boundary(&self, start: usize, end: usize) -> Result<(), FilterError> {
        if end < self.chars.len() && !is_ws(self.chars[end]) {
            return Err(self.error(SPACE_AFTER_QUOTE, start, self.run_end(end)));
        }
        Ok(())
    }

    /// A quoted phrase starting at `at`: its text and where it ends.
    fn phrase(&self, at: usize) -> Result<(String, usize), FilterError> {
        let mut text = String::new();
        let mut index = at + 1;
        while index < self.chars.len() {
            let character = self.chars[index];
            if character == '\\'
                && index + 1 < self.chars.len()
                && matches!(self.chars[index + 1], '"' | '\\')
            {
                text.push(self.chars[index + 1]);
                index += 2;
            } else if character == '"' {
                return Ok((text, index + 1));
            } else {
                text.push(character);
                index += 1;
            }
        }
        Err(self.error(QUOTE_NOT_CLOSED, at, self.chars.len()))
    }

    /// A `/pattern/` or `/pattern/i` item whose slash is at `at`.
    fn regex_item(&self, start: usize, at: usize) -> Result<(String, bool, usize), FilterError> {
        let mut pattern = String::new();
        let mut index = at + 1;
        let refused = || self.error(REGEX_MESSAGE, start, self.run_end(at));
        loop {
            let Some(&character) = self.chars.get(index) else {
                return Err(refused());
            };
            if character == '\\' && index + 1 < self.chars.len() {
                pattern.push(character);
                pattern.push(self.chars[index + 1]);
                index += 2;
            } else if character == '/' {
                break;
            } else {
                pattern.push(character);
                index += 1;
            }
        }
        if pattern.is_empty() {
            return Err(refused());
        }
        let mut end = index + 1;
        let case_insensitive = self.chars.get(end) == Some(&'i');
        if case_insensitive {
            end += 1;
        }
        if end < self.chars.len() && !is_ws(self.chars[end]) {
            return Err(refused());
        }
        Ok((pattern, case_insensitive, end))
    }

    /// Where the `:` or `=` of a term starting at `at` is, when it is one.
    fn key_end(&self, at: usize) -> Option<usize> {
        if !self.chars[at].is_ascii_alphabetic() {
            return None;
        }
        let mut end = at + 1;
        while end < self.chars.len() && is_key_char(self.chars[end]) {
            end += 1;
        }
        matches!(self.chars.get(end), Some(':' | '=')).then_some(end)
    }

    /// A term whose item starts at `start`, key at `at`, separator at
    /// `separator`.
    fn term(
        &self,
        start: usize,
        at: usize,
        separator: usize,
        negated: bool,
    ) -> Result<(FilterTerm, usize), FilterError> {
        let key: String = self.chars[at..separator].iter().collect();
        let mut index = separator + 1;
        let next = |offset: usize| self.chars.get(index + offset).copied();
        let op = match (next(0), next(1)) {
            (Some('>'), Some('=')) => {
                index += 2;
                FilterOp::Ge
            }
            (Some('<'), Some('=')) => {
                index += 2;
                FilterOp::Le
            }
            (Some('>'), _) => {
                index += 1;
                FilterOp::Gt
            }
            (Some('<'), _) => {
                index += 1;
                FilterOp::Lt
            }
            _ => FilterOp::Eq,
        };
        let (value, end) = if self.chars.get(index) == Some(&'"') {
            let (value, end) = self.phrase(index)?;
            self.boundary(start, end)?;
            (value, end)
        } else {
            self.bare(index)?
        };
        Ok((
            FilterTerm {
                key,
                op,
                value,
                negated,
                from: self.utf16[start],
                to: self.utf16[end],
            },
            end,
        ))
    }

    /// Bare text from `at` to the next whitespace; a quote inside it is an
    /// error (a quote starts a phrase only at the start of a word or value).
    fn bare(&self, at: usize) -> Result<(String, usize), FilterError> {
        let end = self.run_end(at);
        if let Some(quote) = (at..end).find(|index| self.chars[*index] == '"') {
            return Err(self.error(QUOTE_IN_WORD, quote, quote + 1));
        }
        Ok((self.chars[at..end].iter().collect(), end))
    }
}

/// Checks every term against `set`: resolves key aliases and `Path`
/// prefixes, enum values and their aliases, each kind's value syntax, and
/// that `<` and `>` are used only on ordered kinds.
pub(crate) fn validate(query: FilterQuery, set: &FieldSet) -> Result<FilterQuery, FilterError> {
    let FilterQuery {
        terms,
        words,
        regexes,
    } = query;
    let terms = terms
        .into_iter()
        .map(|term| validate_term(&term, set))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(FilterQuery {
        terms,
        words,
        regexes,
    })
}

fn validate_term(term: &FilterTerm, set: &FieldSet) -> Result<FilterTerm, FilterError> {
    let refuse = |message: String| FilterError {
        message,
        from: term.from,
        to: term.to,
    };
    let typed = format!("\"{}:\"", term.key);
    let lower = term.key.to_ascii_lowercase();
    let (key, kind) = resolve_key(&term.key, &lower, set).map_err(refuse)?;
    if term.op != FilterOp::Eq && !kind.ordered() {
        return Err(refuse(format!(
            "\"{}\" works on times, numbers, sizes and durations only.",
            term.op.spelling()
        )));
    }
    let value = match kind {
        FieldKind::Text | FieldKind::Exact | FieldKind::Path { .. } => {
            if term.value.is_empty() {
                return Err(refuse(format!("{typed} needs a value.")));
            }
            term.value.clone()
        }
        FieldKind::Enum { values, aliases } => enum_value(&term.value, values, aliases)
            .ok_or_else(|| {
                refuse(format!(
                    "{typed} is one of {}.",
                    describe_enum(values, aliases)
                ))
            })?,
        FieldKind::Bool => match term.value.to_ascii_lowercase().as_str() {
            "true" | "yes" => "true".to_owned(),
            "false" | "no" => "false".to_owned(),
            _ => return Err(refuse(format!("{typed} is true or false."))),
        },
        FieldKind::Time => {
            if parse_time(&term.value, OffsetDateTime::UNIX_EPOCH).is_none() {
                return Err(refuse(format!(
                    "{typed} needs a time, like 2026-10-01, -2h or today."
                )));
            }
            term.value.clone()
        }
        FieldKind::Number => {
            if parse_number(&term.value).is_none() {
                return Err(refuse(format!("{typed} needs a number, like 42 or 2.5.")));
            }
            term.value.clone()
        }
        FieldKind::Bytes => {
            if parse_bytes(&term.value).is_none() {
                return Err(refuse(format!(
                    "{typed} needs a size, like 512, 10KB or 2MB."
                )));
            }
            term.value.clone()
        }
        FieldKind::Duration => {
            if parse_duration(&term.value).is_none() {
                return Err(refuse(format!(
                    "{typed} needs a duration, like 250ms, 2s or 1.5m."
                )));
            }
            term.value.clone()
        }
    };
    Ok(FilterTerm {
        key,
        op: term.op,
        value,
        negated: term.negated,
        from: term.from,
        to: term.to,
    })
}

/// The canonical key of a term typed as `typed` (`lower` lowercased), with
/// its field's kind; the message for a key the set does not have.
fn resolve_key<'s>(
    typed: &str,
    lower: &str,
    set: &'s FieldSet,
) -> Result<(String, &'s FieldKind), String> {
    for field in set.fields {
        let FieldKind::Path { prefixes } = &field.kind else {
            continue;
        };
        let needs_name = |prefix: &str| {
            format!("\"{prefix}\" needs a field name after it, like {prefix}userId:u_1.")
        };
        for prefix in *prefixes {
            if lower.starts_with(&prefix.to_ascii_lowercase()) {
                let suffix = &typed[prefix.len()..];
                if suffix.is_empty() {
                    return Err(needs_name(prefix));
                }
                return Ok((format!("{prefix}{suffix}"), &field.kind));
            }
        }
        // The help entry's key, an alias, or a prefix without its dot names
        // no field yet.
        if let Some(prefix) = prefixes
            .iter()
            .find(|prefix| prefix.trim_end_matches('.').eq_ignore_ascii_case(lower))
        {
            return Err(needs_name(prefix));
        }
        if field.key.eq_ignore_ascii_case(lower)
            || field
                .aliases
                .iter()
                .any(|alias| alias.eq_ignore_ascii_case(lower))
        {
            return Err(needs_name(prefixes.first().copied().unwrap_or(field.key)));
        }
    }
    for field in set.fields {
        if matches!(field.kind, FieldKind::Path { .. }) {
            continue;
        }
        if field.key.eq_ignore_ascii_case(lower)
            || field
                .aliases
                .iter()
                .any(|alias| alias.eq_ignore_ascii_case(lower))
        {
            return Ok((field.key.to_owned(), &field.kind));
        }
    }
    Err(unknown_key(typed, set))
}

fn unknown_key(typed: &str, set: &FieldSet) -> String {
    let mut names: Vec<String> = set
        .fields
        .iter()
        .filter(|field| !matches!(field.kind, FieldKind::Path { .. }))
        .map(|field| field.key.to_owned())
        .collect();
    names.extend(set.fields.iter().filter_map(|field| match &field.kind {
        FieldKind::Path { prefixes } => Some(format!(
            "{}…",
            prefixes.first().copied().unwrap_or(field.key)
        )),
        _ => None,
    }));
    if names.is_empty() {
        return format!(
            "Unknown filter \"{typed}:\". This list has no filters; quote it to search for the text."
        );
    }
    format!(
        "Unknown filter \"{typed}:\". Use {}; quote it to search for the text.",
        join_or(&names)
    )
}

/// `a`, `a or b`, `a, b or c`.
fn join_or(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [only] => only.clone(),
        [rest @ .., last] => format!("{} or {last}", rest.join(", ")),
    }
}

/// The canonical value `typed` names, case-insensitively, directly or
/// through an alias.
fn enum_value(typed: &str, values: &[&str], aliases: &[(&str, &str)]) -> Option<String> {
    values
        .iter()
        .find(|value| value.eq_ignore_ascii_case(typed))
        .or_else(|| {
            aliases
                .iter()
                .find(|(alias, _)| alias.eq_ignore_ascii_case(typed))
                .map(|(_, value)| value)
        })
        .map(|value| (*value).to_owned())
}

/// `password, google.com (google), phone, anonymous`.
fn describe_enum(values: &[&str], aliases: &[(&str, &str)]) -> String {
    values
        .iter()
        .map(|value| {
            let spellings: Vec<&str> = aliases
                .iter()
                .filter(|(_, target)| target == value)
                .map(|(alias, _)| *alias)
                .collect();
            if spellings.is_empty() {
                (*value).to_owned()
            } else {
                format!("{value} ({})", spellings.join(", "))
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// A decimal number: digits, an optional fraction, an optional leading
/// minus.
pub(crate) fn parse_number(text: &str) -> Option<f64> {
    let digits = text.strip_prefix('-').unwrap_or(text);
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    let fraction_ok = !digits.contains('.') || !fraction.is_empty();
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction_ok
    {
        return None;
    }
    text.parse().ok()
}

/// A non-negative decimal followed by a unit, the unit split off
/// lowercased.
fn number_and_unit(text: &str) -> Option<(f64, String)> {
    let split = text
        .find(|character: char| !(character.is_ascii_digit() || character == '.'))
        .unwrap_or(text.len());
    let (number, unit) = text.split_at(split);
    if number.starts_with('-') || number.is_empty() {
        return None;
    }
    Some((parse_number(number)?, unit.to_ascii_lowercase()))
}

/// A size: `512`, `10KB`, `2MB`, `1.5GB` (units `B`, `KB`, `MB`, `GB`, `TB`,
/// any case, powers of 1024).
pub(crate) fn parse_bytes(text: &str) -> Option<u64> {
    let (number, unit) = number_and_unit(text)?;
    let power = match unit.as_str() {
        "" | "b" => 0,
        "kb" => 1,
        "mb" => 2,
        "gb" => 3,
        "tb" => 4,
        _ => return None,
    };
    let bytes = number * 1024_f64.powi(power);
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a non-negative size well below 2^63, rounded to whole bytes"
    )]
    let rounded = bytes.round() as u64;
    bytes.is_finite().then_some(rounded)
}

/// A duration: `250ms`, `2s`, `1.5m`, `1h` (any case).
pub(crate) fn parse_duration(text: &str) -> Option<std::time::Duration> {
    let (number, unit) = number_and_unit(text)?;
    let seconds = match unit.as_str() {
        "ms" => number / 1000.0,
        "s" => number,
        "m" => number * 60.0,
        "h" => number * 3600.0,
        _ => return None,
    };
    std::time::Duration::try_from_secs_f64(seconds).ok()
}

/// A time relative to `now`: RFC 3339, `YYYY-MM-DD` (UTC midnight), `now`,
/// `today` (UTC midnight), or `-<n><unit>` with `s`, `m`, `h`, `d` or `w`
/// (any case).
pub(crate) fn parse_time(text: &str, now: OffsetDateTime) -> Option<OffsetDateTime> {
    let lower = text.to_ascii_lowercase();
    match lower.as_str() {
        "now" => return Some(now),
        "today" => return Some(now.replace_time(time::Time::MIDNIGHT)),
        _ => {}
    }
    if let Some(relative) = lower.strip_prefix('-') {
        // The unit is the last character, which is not always the last
        // byte: `-2é` split one byte from the end panicked mid-character.
        let (amount, unit) = relative.split_at(relative.char_indices().next_back()?.0);
        if amount.is_empty() || !amount.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let amount: i64 = amount.parse().ok()?;
        let seconds = match unit {
            "s" => amount,
            "m" => amount.checked_mul(60)?,
            "h" => amount.checked_mul(3_600)?,
            "d" => amount.checked_mul(86_400)?,
            "w" => amount.checked_mul(604_800)?,
            _ => return None,
        };
        return now.checked_sub(time::Duration::seconds(seconds));
    }
    if text.len() == 10 {
        return parse_date(text).map(|date| date.midnight().assume_utc());
    }
    OffsetDateTime::parse(text, &Rfc3339).ok()
}

/// `YYYY-MM-DD`, a real calendar day.
fn parse_date(text: &str) -> Option<Date> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        let part = &text[range];
        part.bytes()
            .all(|byte| byte.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    let year = i32::try_from(digits(0..4)?).ok()?;
    let month = Month::try_from(u8::try_from(digits(5..7)?).ok()?).ok()?;
    let day = u8::try_from(digits(8..10)?).ok()?;
    Date::from_calendar_date(year, month, day).ok()
}

/// The golden-case harness every section's cases file runs through.
#[cfg(test)]
pub(crate) mod golden {
    use std::collections::BTreeMap;

    use serde::Deserialize;
    use serde_json::Value;

    use super::{FieldKind, FieldSet, FieldSpec, FilterError, parse_filter, validate};

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct File {
        /// What the file is, for people.
        #[serde(default)]
        #[allow(dead_code, reason = "read by people")]
        note: Option<String>,
        #[serde(default)]
        regex: bool,
        fields: Vec<Field>,
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct Field {
        key: String,
        #[serde(default)]
        aliases: Vec<String>,
        kind: String,
        #[serde(default)]
        help: String,
        #[serde(default)]
        values: Vec<String>,
        #[serde(default)]
        value_aliases: BTreeMap<String, String>,
        #[serde(default)]
        prefixes: Vec<String>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Case {
        #[serde(default)]
        name: Option<String>,
        text: String,
        /// Overrides the file's `regex` for this case.
        #[serde(default)]
        regex: Option<bool>,
        #[serde(default)]
        ok: Option<Value>,
        #[serde(default)]
        error: Option<ExpectedError>,
        #[serde(default)]
        #[allow(dead_code, reason = "read by people")]
        note: Option<String>,
    }

    #[derive(Deserialize, PartialEq, Eq, Debug)]
    #[serde(deny_unknown_fields)]
    struct ExpectedError {
        from: usize,
        to: usize,
        message: String,
    }

    /// A file's fields live for the test process: the specs borrow
    /// `'static` strings, as a section's constant field set does.
    fn leak(text: String) -> &'static str {
        Box::leak(text.into_boxed_str())
    }

    fn leak_all(texts: Vec<String>) -> &'static [&'static str] {
        Box::leak(
            texts
                .into_iter()
                .map(leak)
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        )
    }

    fn spec(field: Field) -> FieldSpec {
        let kind = match field.kind.as_str() {
            "text" => FieldKind::Text,
            "exact" => FieldKind::Exact,
            "enum" => FieldKind::Enum {
                values: leak_all(field.values),
                aliases: Box::leak(
                    field
                        .value_aliases
                        .into_iter()
                        .map(|(alias, value)| (leak(alias), leak(value)))
                        .collect::<Vec<_>>()
                        .into_boxed_slice(),
                ),
            },
            "path" => FieldKind::Path {
                prefixes: leak_all(field.prefixes),
            },
            "bool" => FieldKind::Bool,
            "time" => FieldKind::Time,
            "number" => FieldKind::Number,
            "bytes" => FieldKind::Bytes,
            "duration" => FieldKind::Duration,
            other => panic!("field {}: unknown kind {other}", field.key),
        };
        FieldSpec {
            key: leak(field.key),
            aliases: leak_all(field.aliases),
            kind,
            help: leak(field.help),
        }
    }

    /// The query as the golden file writes an `ok`: missing lists are empty.
    fn expected(ok: &Value) -> Value {
        let list = |name: &str| {
            ok.get(name)
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new()))
        };
        serde_json::json!({
            "terms": list("terms"),
            "words": list("words"),
            "regexes": list("regexes"),
        })
    }

    /// Runs every case of a cases file (the format of
    /// `console/src/lib/filter-cases.json`): parse, validate, and compare
    /// the result or the error (message and span) exactly. Fails once,
    /// naming each failing case and what differed. Returns how many cases
    /// ran.
    pub(crate) fn run(cases_json: &str) -> usize {
        let file: File = serde_json::from_str(cases_json).expect("a valid cases file");
        let fields: &'static [FieldSpec] = Box::leak(
            file.fields
                .into_iter()
                .map(spec)
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        );
        let mut failures = Vec::new();
        let count = file.cases.len();
        for case in file.cases {
            let label = case.name.clone().unwrap_or_else(|| case.text.clone());
            let set = FieldSet {
                fields,
                regex: case.regex.unwrap_or(file.regex),
            };
            let outcome =
                parse_filter(&case.text, set.regex).and_then(|query| validate(query, &set));
            match (&case.ok, &case.error, outcome) {
                (Some(ok), None, Ok(query)) => {
                    let actual = serde_json::to_value(&query).expect("serializable");
                    let wanted = expected(ok);
                    if actual != wanted {
                        failures.push(format!("{label}: expected {wanted}, got {actual}"));
                    }
                }
                (None, Some(wanted), Err(FilterError { message, from, to })) => {
                    let actual = ExpectedError { from, to, message };
                    if &actual != wanted {
                        failures.push(format!(
                            "{label}: expected error {wanted:?}, got {actual:?}"
                        ));
                    }
                }
                (Some(_), None, Err(error)) => {
                    failures.push(format!("{label}: expected a query, got error {error:?}"));
                }
                (None, Some(_), Ok(query)) => {
                    failures.push(format!("{label}: expected an error, got {query:?}"));
                }
                _ => failures.push(format!("{label}: a case has exactly one of ok and error")),
            }
        }
        assert!(
            failures.is_empty(),
            "{} of {count} filter cases failed:\n{}",
            failures.len(),
            failures.join("\n")
        );
        count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The grammar's own cases, shared with the console's Vitest.
    const CASES: &str = include_str!("../../../console/src/lib/filter-cases.json");

    #[test]
    fn every_golden_case_holds() {
        let count = golden::run(CASES);
        assert!(
            count >= 70,
            "the golden file holds {count} cases, fewer than 70"
        );
        let file: serde_json::Value = serde_json::from_str(CASES).expect("json");
        let roadmap = file["cases"]
            .as_array()
            .expect("cases")
            .iter()
            .find(|case| case["name"] == "roadmap-example")
            .expect("a case named roadmap-example");
        assert_eq!(roadmap["text"], "provider:google -is:disabled ada");
    }

    const FIELDS: &[FieldSpec] = &[
        FieldSpec {
            key: "provider",
            aliases: &["p"],
            kind: FieldKind::Enum {
                values: &["password", "google.com"],
                aliases: &[("google", "google.com")],
            },
            help: "Sign-in provider",
        },
        FieldSpec {
            key: "data",
            aliases: &[],
            kind: FieldKind::Path {
                prefixes: &["data."],
            },
            help: "A field of the payload",
        },
    ];

    #[test]
    fn a_filter_error_is_an_invalid_argument_with_its_span() {
        let set = FieldSet {
            fields: FIELDS,
            regex: false,
        };
        let error = set.parse("ada foo:bar").expect_err("unknown key");
        assert_eq!(error.from, 4);
        assert_eq!(error.to, 11);
        let api = ApiError::from(error);
        assert_eq!(api.status(), axum::http::StatusCode::BAD_REQUEST);
        let body = serde_json::to_value(api.detail()).expect("json");
        assert_eq!(
            body["message"],
            "Unknown filter \"foo:\". Use provider or data.…; quote it to search for the text."
        );
    }

    #[test]
    fn the_completions_describe_each_field() {
        let set = FieldSet {
            fields: FIELDS,
            regex: false,
        };
        let infos = set.infos();
        assert_eq!(infos[0].kind, "enum");
        assert_eq!(infos[0].aliases, ["p"]);
        assert_eq!(infos[0].value_aliases["google"], "google.com");
        assert_eq!(infos[1].kind, "path");
        assert_eq!(infos[1].prefixes, ["data."]);
        assert_eq!(
            serde_json::to_value(&infos[1]).expect("json")["valueAliases"],
            serde_json::json!({})
        );
    }

    #[test]
    fn values_parse_into_what_a_section_compares() {
        let now = OffsetDateTime::parse("2026-10-12T15:30:00Z", &Rfc3339).expect("now");
        let at = |text: &str| parse_time(text, now).map(|time| time.format(&Rfc3339).expect("fmt"));
        assert_eq!(at("now").as_deref(), Some("2026-10-12T15:30:00Z"));
        assert_eq!(at("Today").as_deref(), Some("2026-10-12T00:00:00Z"));
        assert_eq!(at("-2h").as_deref(), Some("2026-10-12T13:30:00Z"));
        assert_eq!(at("-1w").as_deref(), Some("2026-10-05T15:30:00Z"));
        assert_eq!(at("2026-10-01").as_deref(), Some("2026-10-01T00:00:00Z"));
        assert_eq!(
            at("2026-10-01T08:00:00+08:00").as_deref(),
            Some("2026-10-01T08:00:00+08:00")
        );
        for bad in ["2026-02-30", "-2", "-h", "yesterday", "2026-10-1", "-1.5h"] {
            assert_eq!(at(bad), None, "{bad}");
        }
        assert_eq!(parse_bytes("512"), Some(512));
        assert_eq!(parse_bytes("10KB"), Some(10_240));
        assert_eq!(parse_bytes("1.5mb"), Some(1_572_864));
        assert_eq!(parse_bytes("2GB"), Some(2 * 1024 * 1024 * 1024));
        assert_eq!(parse_bytes("10 KB"), None);
        assert_eq!(parse_bytes("-1KB"), None);
        assert_eq!(parse_bytes("KB"), None);
        assert_eq!(
            parse_duration("250ms"),
            Some(std::time::Duration::from_millis(250))
        );
        assert_eq!(
            parse_duration("1.5m"),
            Some(std::time::Duration::from_secs(90))
        );
        assert_eq!(parse_duration("2"), None);
        assert_eq!(parse_number("-2.5"), Some(-2.5));
        assert_eq!(parse_number("2."), None);
        assert_eq!(parse_number(".5"), None);
        assert_eq!(parse_number("1e3"), None);
    }
}
