//! Extension references (`publisher/extension@version`, or the registry
//! resource names), parsed and printed like `extensions/refs.ts`.
use regex::Regex;

use crate::ExtensionsError;

/// A parsed extension reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionRef {
    pub publisher_id: String,
    pub extension_id: String,
    /// A version, a semver range, `latest` or `latest-approved`.
    pub version: Option<String>,
}

impl ExtensionRef {
    /// Parses `publisher/extension[@version]` or
    /// `publishers/<p>/extensions/<e>[/versions/<v>]`.
    pub fn parse(text: &str) -> Result<Self, ExtensionsError> {
        let parsed = parse_ref(text).or_else(|| parse_name(text));
        let Some(parsed) =
            parsed.filter(|r| !r.publisher_id.is_empty() && !r.extension_id.is_empty())
        else {
            return Err(ExtensionsError(format!(
                "Unable to parse {text} as an extension ref.\nExpected format is either publisherId/extensionId@version or publishers/publisherId/extensions/extensionId/versions/version. If you are referring to a local extension directory, please ensure the directory exists."
            )));
        };
        if let Some(version) = &parsed.version
            && semver::Version::parse(version).is_err()
            && semver::VersionReq::parse(version).is_err()
            && !matches!(version.as_str(), "latest" | "latest-approved")
        {
            return Err(ExtensionsError(format!(
                "Extension reference {} contains an invalid version {version}.",
                serde_json::to_string_pretty(&serde_json::json!({
                    "publisherId": parsed.publisher_id,
                    "extensionId": parsed.extension_id,
                    "version": version,
                }))
                .unwrap_or_default()
            )));
        }
        Ok(parsed)
    }

    /// `publisher/extension`.
    #[must_use]
    pub fn extension_ref(&self) -> String {
        format!("{}/{}", self.publisher_id, self.extension_id)
    }

    /// `publisher/extension@version`; the version must be present.
    pub fn version_ref(&self) -> Result<String, ExtensionsError> {
        let version = self
            .version
            .as_deref()
            .ok_or_else(|| ExtensionsError("Ref does not have a version".to_owned()))?;
        Ok(format!(
            "{}/{}@{version}",
            self.publisher_id, self.extension_id
        ))
    }

    /// `publishers/<p>/extensions/<e>`.
    #[must_use]
    pub fn extension_name(&self) -> String {
        format!(
            "publishers/{}/extensions/{}",
            self.publisher_id, self.extension_id
        )
    }

    /// `publishers/<p>/extensions/<e>/versions/<v>`; the version must be present.
    pub fn version_name(&self) -> Result<String, ExtensionsError> {
        let version = self
            .version
            .as_deref()
            .ok_or_else(|| ExtensionsError("Ref does not have a version".to_owned()))?;
        Ok(format!(
            "publishers/{}/extensions/{}/versions/{version}",
            self.publisher_id, self.extension_id
        ))
    }
}

fn parse_ref(text: &str) -> Option<ExtensionRef> {
    static PATTERN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let regex = PATTERN.get_or_init(|| {
        Regex::new(r"^([^/@\n]+)/([^/@\n]+)(@([^\n]+)|)$").expect("valid ref regex")
    });
    let captures = regex.captures(text)?;
    Some(ExtensionRef {
        publisher_id: captures[1].to_owned(),
        extension_id: captures[2].to_owned(),
        version: captures.get(4).map(|capture| capture.as_str().to_owned()),
    })
}

fn parse_name(text: &str) -> Option<ExtensionRef> {
    let parts: Vec<&str> = text.split('/').collect();
    if parts.first() != Some(&"publishers") || parts.get(2) != Some(&"extensions") {
        return None;
    }
    match parts.len() {
        4 => Some(ExtensionRef {
            publisher_id: parts[1].to_owned(),
            extension_id: parts[3].to_owned(),
            version: None,
        }),
        6 if parts[4] == "versions" => Some(ExtensionRef {
            publisher_id: parts[1].to_owned(),
            extension_id: parts[3].to_owned(),
            version: Some(parts[5].to_owned()),
        }),
        _ => None,
    }
}

/// Whether a `firebase.json` extensions value names a local directory
/// (`isLocalPath`).
#[must_use]
pub fn is_local_path(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with("~/")
        || trimmed.starts_with("./")
        || trimmed.starts_with("../")
        || trimmed.starts_with('/')
        || trimmed.starts_with("~\\")
        || trimmed.starts_with(".\\")
        || trimmed.starts_with("..\\")
        || trimmed.starts_with('\\')
        || trimmed == "."
        || trimmed == ".."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_refs_and_names() {
        let parsed = ExtensionRef::parse("invertase/firestore-stripe-payments@0.3.12").unwrap();
        assert_eq!(parsed.publisher_id, "invertase");
        assert_eq!(parsed.extension_id, "firestore-stripe-payments");
        assert_eq!(parsed.version.as_deref(), Some("0.3.12"));
        assert_eq!(
            parsed.version_name().unwrap(),
            "publishers/invertase/extensions/firestore-stripe-payments/versions/0.3.12"
        );
        let named =
            ExtensionRef::parse("publishers/algolia/extensions/firestore-algolia-search").unwrap();
        assert_eq!(named.version, None);
        assert_eq!(named.extension_ref(), "algolia/firestore-algolia-search");
        assert!(ExtensionRef::parse("stripe/x@not a version").is_err());
        assert!(ExtensionRef::parse("stripe/x@^0.3").is_ok());
        assert!(ExtensionRef::parse("nope").is_err());
    }

    #[test]
    fn local_paths_are_recognised() {
        assert!(is_local_path("./extensions-local/synthetic"));
        assert!(is_local_path("../shared"));
        assert!(is_local_path("/abs"));
        assert!(!is_local_path("stripe/firestore-stripe-payments@0.3.4"));
    }
}
