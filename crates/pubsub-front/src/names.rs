//! Resource name validation as the official emulator applies it:
//! `projects/{project}/{collection}/{id}` where the id is 3–255 characters,
//! starts with a letter, uses `[A-Za-z0-9-_.~+%]` and does not start with
//! `goog`. The project segment may be anything, even empty.

use crate::error::PubsubError;

/// A validated resource name split into its parts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceName {
    pub project: String,
    pub id: String,
}

fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() < 3 || bytes.len() > 255 {
        return false;
    }
    if !bytes[0].is_ascii_alphabetic() {
        return false;
    }
    if id.starts_with("goog") {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || b"-_.~+%".contains(byte))
}

/// Parses `projects/{project}/{collection}/{id}`.
pub fn parse(collection: &str, name: &str) -> Result<ResourceName, PubsubError> {
    let invalid = || PubsubError::invalid_name(collection, name);
    let rest = name.strip_prefix("projects/").ok_or_else(invalid)?;
    let (project, rest) = rest.split_once('/').ok_or_else(invalid)?;
    let (found, id) = rest.split_once('/').ok_or_else(invalid)?;
    if found != collection || !valid_id(id) {
        return Err(invalid());
    }
    Ok(ResourceName {
        project: project.to_owned(),
        id: id.to_owned(),
    })
}

/// Parses `projects/{project}`, as list requests name their parent.
pub fn parse_project(collection: &str, parent: &str) -> Result<String, PubsubError> {
    parent
        .strip_prefix("projects/")
        .filter(|project| !project.contains('/'))
        .map(str::to_owned)
        .ok_or_else(|| PubsubError::invalid_name(collection, parent))
}

/// Splits `name@revision` into its parts.
#[must_use]
pub fn split_revision(name: &str) -> (&str, Option<&str>) {
    match name.split_once('@') {
        Some((base, revision)) => (base, Some(revision)),
        None => (name, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_follow_the_recorded_rules() {
        assert!(parse("topics", "projects/p/topics/abc").is_ok());
        assert!(parse("topics", "projects//topics/abc").is_ok());
        assert!(parse("topics", "projects/p/topics/GoogTopic").is_ok());
        assert!(
            parse(
                "topics",
                "projects/p/topics/Topic_1.two~three+four%five-six"
            )
            .is_ok()
        );
        assert!(parse("topics", "projects/p/topics/ab").is_err());
        assert!(parse("topics", "projects/p/topics/1abc").is_err());
        assert!(parse("topics", "projects/p/topics/goog-topic").is_err());
        assert!(parse("topics", "projects/p/topics/topic with space").is_err());
        assert!(parse("topics", "projects/p/topics/topic/extra").is_err());
        assert!(parse("topics", "projects/p/subscriptions/abc").is_err());
        assert!(parse("topics", "abc").is_err());
        assert!(parse("topics", "").is_err());
        assert_eq!(
            parse("topics", "abc").unwrap_err().message,
            "Invalid [topics] name: (name=abc)"
        );
    }
}
