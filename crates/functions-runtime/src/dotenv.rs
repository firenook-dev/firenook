//! The Functions dotenv dialect and file chain (firebase-tools 15.22.0
//! `lib/functions/env.js`): `.env`, `.env.<projectId>`, `.env.<alias>` and
//! `.env.local` in the emulator, later files winning; `export` prefixes,
//! trailing `#` comments, double quotes with escape sequences spanning lines,
//! single quotes kept verbatim.
use std::collections::BTreeMap;
use std::fmt::{self, Display};
use std::path::Path;

use regex::Regex;

const RESERVED_PREFIXES: [&str; 3] = ["X_GOOGLE_", "FIREBASE_", "EXT_"];
const RESERVED_KEYS: [&str; 19] = [
    "FIREBASE_CONFIG",
    "CLOUD_RUNTIME_CONFIG",
    "EVENTARC_CLOUD_EVENT_SOURCE",
    "ENTRY_POINT",
    "GCP_PROJECT",
    "GCLOUD_PROJECT",
    "GOOGLE_CLOUD_PROJECT",
    "FUNCTION_TRIGGER_TYPE",
    "FUNCTION_NAME",
    "FUNCTION_MEMORY_MB",
    "FUNCTION_TIMEOUT_SEC",
    "FUNCTION_IDENTITY",
    "FUNCTION_REGION",
    "FUNCTION_TARGET",
    "FUNCTION_SIGNATURE_TYPE",
    "K_SERVICE",
    "K_REVISION",
    "PORT",
    "K_CONFIGURATION",
];

/// A dotenv problem with the official wording.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DotenvError(pub String);

impl Display for DotenvError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for DotenvError {}

/// Parsed key/value pairs plus the lines that matched nothing.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub envs: BTreeMap<String, String>,
    pub errors: Vec<String>,
}

fn line_regex() -> &'static Regex {
    static LINE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    LINE.get_or_init(|| {
        // Mirrors LINE_RE (flags gms): key, optional value (single-quoted,
        // double-quoted, or up to a `#`), optional trailing comment.
        Regex::new(
            r#"(?ms)^[ \t\f\v]*(?:export)?[ \t\f\v]*([\w./]+)[ \t\f\v]*=[\f\t\v]*([ \t\f\v]*'(?:\\'|[^'])*'|[ \t\f\v]*"(?:\\"|[^"])*"|[^#\r\n]*)?[ \t\f\v]*(?:#[^\n]*)?$"#,
        )
        .expect("static regex")
    })
}

fn unescape_double_quoted(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\\' {
            match chars.peek() {
                Some('n') => {
                    chars.next();
                    out.push('\n');
                }
                Some('r') => {
                    chars.next();
                    out.push('\r');
                }
                Some('t') => {
                    chars.next();
                    out.push('\t');
                }
                Some('v') => {
                    chars.next();
                    out.push('\u{000b}');
                }
                Some('\\') => {
                    chars.next();
                    out.push('\\');
                }
                Some('\'') => {
                    chars.next();
                    out.push('\'');
                }
                Some('"') => {
                    chars.next();
                    out.push('"');
                }
                _ => out.push('\\'),
            }
        } else {
            out.push(character);
        }
    }
    out
}

/// Parses a dotenv document; matches the official `parse`.
#[must_use]
pub fn parse(data: &str) -> Parsed {
    let (entries, errors) = parse_ordered(data);
    Parsed {
        envs: entries.into_iter().collect(),
        errors,
    }
}

/// Parses a dotenv document keeping the file's key order (first appearance
/// wins the position, a later duplicate replaces the value, like assigning
/// into a JavaScript object).
#[must_use]
pub fn parse_ordered(data: &str) -> (Vec<(String, String)>, Vec<String>) {
    // The official implementation replaces only the first CR/CRLF (a
    // non-global regex); later lines keep their carriage returns, which the
    // line pattern tolerates.
    let data = data.replacen("\r\n", "\n", 1).replacen('\r', "\n", 1);
    let mut entries: Vec<(String, String)> = Vec::new();
    let mut errors = Vec::new();
    let regex = line_regex();
    for captures in regex.captures_iter(&data) {
        let key = captures[1].to_owned();
        let mut value = captures
            .get(2)
            .map_or("", |capture| capture.as_str())
            .trim()
            .to_owned();
        if value.len() >= 2 {
            let first = value.as_bytes()[0];
            let last = value.as_bytes()[value.len() - 1];
            if (first == b'"' || first == b'\'') && first == last {
                let inner = value[1..value.len() - 1].to_owned();
                value = if first == b'"' {
                    unescape_double_quoted(&inner)
                } else {
                    inner
                };
            }
        }
        if let Some(existing) = entries.iter_mut().find(|(existing, _)| *existing == key) {
            existing.1 = value;
        } else {
            entries.push((key, value));
        }
    }
    let remainder = regex.replace_all(&data, "");
    for line in remainder.split(['\r', '\n']) {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        errors.push(line.to_owned());
    }
    (entries, errors)
}

/// Validates a key the way the official `validateKey` does.
pub fn validate_key(key: &str) -> Result<(), DotenvError> {
    if RESERVED_KEYS.contains(&key) {
        return Err(DotenvError(format!(
            "Failed to validate key {key}: Key {key} is reserved for internal use."
        )));
    }
    let mut bytes = key.bytes();
    let valid = bytes
        .next()
        .is_some_and(|first| first.is_ascii_uppercase() || first == b'_')
        && key
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_');
    if !valid {
        return Err(DotenvError(format!(
            "Failed to validate key {key}: Key {key} must start with an uppercase ASCII letter or underscore, and then consist of uppercase ASCII letters, digits, and underscores."
        )));
    }
    if RESERVED_PREFIXES
        .iter()
        .any(|prefix| key.starts_with(prefix))
    {
        return Err(DotenvError(format!(
            "Failed to validate key {key}: Key {key} starts with a reserved prefix ({})",
            RESERVED_PREFIXES.join(" ")
        )));
    }
    Ok(())
}

/// Parses and validates every key; matches the official `parseStrict`.
pub fn parse_strict(data: &str) -> Result<BTreeMap<String, String>, DotenvError> {
    let parsed = parse(data);
    if !parsed.errors.is_empty() {
        return Err(DotenvError(format!(
            "Invalid dotenv file, error on lines: {}",
            parsed.errors.join(",")
        )));
    }
    let mut failures = Vec::new();
    for key in parsed.envs.keys() {
        if let Err(error) = validate_key(key) {
            failures.push(error.0);
        }
    }
    if !failures.is_empty() {
        return Err(DotenvError(format!(
            "Validation failed\n{}",
            failures.join("\n")
        )));
    }
    Ok(parsed.envs)
}

/// The user env files present for one codebase, in precedence order.
#[must_use]
pub fn find_env_files(
    config_dir: &Path,
    project_id: &str,
    project_alias: Option<&str>,
    is_emulator: bool,
) -> Vec<String> {
    let mut names = vec![".env".to_owned(), format!(".env.{project_id}")];
    if let Some(alias) = project_alias {
        names.push(format!(".env.{alias}"));
    }
    if is_emulator {
        names.push(".env.local".to_owned());
    }
    names
        .into_iter()
        .filter(|name| config_dir.join(name).is_file())
        .collect()
}

/// Loads the dotenv chain for one codebase; matches `loadUserEnvs`, whose
/// failure wording names the offending file.
pub fn load_user_envs(
    config_dir: &Path,
    project_id: &str,
    project_alias: Option<&str>,
    is_emulator: bool,
) -> Result<(BTreeMap<String, String>, Vec<String>), DotenvError> {
    let files = find_env_files(config_dir, project_id, project_alias, is_emulator);
    if files.is_empty() {
        return Ok((BTreeMap::new(), files));
    }
    if let Some(alias) = project_alias
        && files.contains(&format!(".env.{project_id}"))
        && files.contains(&format!(".env.{alias}"))
    {
        return Err(DotenvError(format!(
            "Can't have both dotenv files with projectId (env.{project_id}) and projectAlias (.env.{alias}) as extensions."
        )));
    }
    let mut envs = BTreeMap::new();
    for file in &files {
        let data = std::fs::read_to_string(config_dir.join(file)).map_err(|error| {
            DotenvError(format!(
                "Failed to load environment variables from {file}. {error}"
            ))
        })?;
        let parsed = parse_strict(&data).map_err(|error| {
            DotenvError(format!(
                "Failed to load environment variables from {file}.\n{}",
                error.0
            ))
        })?;
        envs.extend(parsed);
    }
    Ok((envs, files))
}

/// Reads a `.secret.local` file; every key is exposed to the codebase's
/// workers, declared or not (official `resolveSecretEnvs`).
pub fn load_local_secrets(path: &Path) -> Result<BTreeMap<String, String>, DotenvError> {
    match std::fs::read_to_string(path) {
        Ok(data) => parse_strict(&data),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(DotenvError(format!(
            "Failed to read local secrets file {}: {error}",
            path.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_recorded_dialect() {
        let data = "# base file\nSYNTHETIC_A=from-dotenv\nSYNTHETIC_QUOTED=\"double quoted\\nwith newline and \\\"escapes\\\"\"\nSYNTHETIC_SINGLE='single \\n keeps backslash'\nexport SYNTHETIC_EXPORTED=exported\nSYNTHETIC_TRAILING=value # trailing comment\nSYNTHETIC_EMPTY=\nSYNTHETIC_MULTILINE=\"line one\nline two\"\n";
        let parsed = parse(data);
        assert!(parsed.errors.is_empty(), "{:?}", parsed.errors);
        assert_eq!(parsed.envs["SYNTHETIC_A"], "from-dotenv");
        assert_eq!(
            parsed.envs["SYNTHETIC_QUOTED"],
            "double quoted\nwith newline and \"escapes\""
        );
        assert_eq!(
            parsed.envs["SYNTHETIC_SINGLE"],
            "single \\n keeps backslash"
        );
        assert_eq!(parsed.envs["SYNTHETIC_EXPORTED"], "exported");
        assert_eq!(parsed.envs["SYNTHETIC_TRAILING"], "value");
        assert_eq!(parsed.envs["SYNTHETIC_EMPTY"], "");
        assert_eq!(parsed.envs["SYNTHETIC_MULTILINE"], "line one\nline two");
    }

    #[test]
    fn rejects_reserved_and_lowercase_keys() {
        let error =
            parse_strict("lowercase_key=not-allowed\nFIREBASE_RESERVED=not-allowed\n").unwrap_err();
        assert!(error.0.starts_with("Validation failed"), "{error}");
        assert!(
            error
                .0
                .contains("lowercase_key must start with an uppercase")
        );
        assert!(
            error
                .0
                .contains("FIREBASE_RESERVED starts with a reserved prefix")
        );
        assert!(validate_key("PORT").is_err());
        assert!(validate_key("SYNTHETIC_OK").is_ok());
    }

    #[test]
    fn reports_unparseable_lines() {
        let parsed = parse("GOOD=1\nthis is not a pair\n");
        assert_eq!(parsed.envs["GOOD"], "1");
        assert_eq!(parsed.errors, vec!["this is not a pair".to_owned()]);
        assert!(parse_strict("GOOD=1\nthis is not a pair\n").is_err());
    }
}
