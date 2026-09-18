//! The Extensions registry API (`firebaseextensions.googleapis.com/v1beta`)
//! and the OAuth refresh-token exchange the Firebase CLI performs for it.
use std::path::PathBuf;

use serde_json::Value;

use crate::ExtensionsError;
use crate::refs::ExtensionRef;
use crate::spec::populate_registry_spec;

const API_VERSION: &str = "v1beta";
const DEFAULT_REGISTRY_ORIGIN: &str = "https://firebaseextensions.googleapis.com";
const DEFAULT_TOKEN_ORIGIN: &str = "https://www.googleapis.com";
/// The Firebase CLI's public OAuth client (firebase-tools `api.ts`).
const CLI_CLIENT_ID: &str =
    "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const CLI_CLIENT_SECRET: &str = "j9iVZfS8kkCEFUPaAeJV0sAi";
const PAGE_SIZE_MAX: u32 = 100;

/// Where the registry and the token endpoint live (env overrides mirror the
/// CLI's `FIREBASE_EXT_URL` and `FIREBASE_TOKEN_URL`).
#[derive(Debug, Clone)]
pub struct Endpoints {
    pub registry_origin: String,
    pub token_origin: String,
    pub client_id: String,
    pub client_secret: String,
}

impl Endpoints {
    #[must_use]
    pub fn from_env() -> Self {
        let env = |name: &str, default: &str| {
            std::env::var(name)
                .ok()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| default.to_owned())
        };
        Self {
            registry_origin: env("FIREBASE_EXT_URL", DEFAULT_REGISTRY_ORIGIN),
            token_origin: env(
                "FIREBASE_TOKEN_URL",
                &env("FIREBASE_GOOGLE_URL", DEFAULT_TOKEN_ORIGIN),
            ),
            client_id: env("FIREBASE_CLIENT_ID", CLI_CLIENT_ID),
            client_secret: env("FIREBASE_CLIENT_SECRET", CLI_CLIENT_SECRET),
        }
    }
}

/// How the registry call is authenticated.
#[derive(Debug, Clone)]
pub enum Credential {
    /// A refresh token (`FIREBASE_TOKEN`, or the CLI's stored login).
    RefreshToken { token: String, source: &'static str },
    /// A ready access token (`FIREBASE_ACCESS_TOKEN` style overrides).
    AccessToken(String),
}

/// Finds the credential the Firebase CLI itself would use: `FIREBASE_TOKEN`,
/// then the default account in the CLI's configstore.
#[must_use]
pub fn discover_credential() -> Option<Credential> {
    if let Ok(token) = std::env::var("FIREBASE_TOKEN")
        && !token.trim().is_empty()
    {
        return Some(Credential::RefreshToken {
            token: token.trim().to_owned(),
            source: "FIREBASE_TOKEN",
        });
    }
    let store = configstore_path()?;
    let text = std::fs::read_to_string(store).ok()?;
    let config: Value = serde_json::from_str(&text).ok()?;
    let token = config
        .get("tokens")
        .and_then(|tokens| tokens.get("refresh_token"))
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())?;
    Some(Credential::RefreshToken {
        token: token.to_owned(),
        source: "the Firebase CLI login (~/.config/configstore/firebase-tools.json)",
    })
}

fn configstore_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
    Some(base.join("configstore").join("firebase-tools.json"))
}

/// A registry client bound to one credential.
pub struct RegistryClient {
    endpoints: Endpoints,
    credential: Option<Credential>,
    client: reqwest::Client,
    access_token: tokio::sync::Mutex<Option<String>>,
}

impl RegistryClient {
    #[must_use]
    pub fn new(endpoints: Endpoints, credential: Option<Credential>) -> Self {
        Self {
            endpoints,
            credential,
            client: reqwest::Client::new(),
            access_token: tokio::sync::Mutex::new(None),
        }
    }

    /// `GET /v1beta/publishers/{p}/extensions/{e}`.
    pub async fn get_extension(&self, reference: &ExtensionRef) -> Result<Value, ExtensionsError> {
        let path = format!("/{}", reference.extension_name());
        match self.get(&path, &[]).await {
            Ok(body) => Ok(body),
            Err(RegistryError::NotFound) => Err(ref_not_found(reference, false)),
            Err(RegistryError::Other(message)) => Err(ExtensionsError(format!(
                "Failed to query the extension '{}': {message}",
                reference.extension_ref()
            ))),
        }
    }

    /// `GET /v1beta/publishers/{p}/extensions/{e}/versions/{v}`, with the
    /// spec's `propertiesYaml` parsed like `populateSpec`.
    pub async fn get_extension_version(
        &self,
        reference: &ExtensionRef,
    ) -> Result<Value, ExtensionsError> {
        if reference.version.is_none() {
            return Err(ExtensionsError(format!(
                "ExtensionVersion ref \"{}\" must supply a version.",
                reference.extension_ref()
            )));
        }
        let path = format!("/{}", reference.version_name()?);
        match self.get(&path, &[]).await {
            Ok(mut body) => {
                if let Some(spec) = body.get_mut("spec") {
                    populate_registry_spec(spec)?;
                }
                Ok(body)
            }
            Err(RegistryError::NotFound) => Err(ref_not_found(reference, true)),
            Err(RegistryError::Other(message)) => Err(ExtensionsError(format!(
                "Failed to query the extension version '{}': {message}",
                reference.version_ref().unwrap_or_default()
            ))),
        }
    }

    /// `listExtensionVersions(ref, "", showPrereleases)`: every page.
    pub async fn list_extension_versions(
        &self,
        reference: &ExtensionRef,
        show_prereleases: bool,
    ) -> Result<Vec<Value>, ExtensionsError> {
        let path = format!(
            "/publishers/{}/extensions/{}/versions",
            reference.publisher_id, reference.extension_id
        );
        let mut versions = Vec::new();
        let mut page_token = String::new();
        loop {
            let page_size = PAGE_SIZE_MAX.to_string();
            let show = show_prereleases.to_string();
            let body = self
                .get(
                    &path,
                    &[
                        ("filter", ""),
                        ("showPrereleases", &show),
                        ("pageSize", &page_size),
                        ("pageToken", &page_token),
                    ],
                )
                .await
                .map_err(|error| match error {
                    RegistryError::NotFound => ref_not_found(reference, false),
                    RegistryError::Other(message) => ExtensionsError(format!(
                        "Failed to list versions of '{}': {message}",
                        reference.extension_ref()
                    )),
                })?;
            if let Some(list) = body.get("extensionVersions").and_then(Value::as_array) {
                versions.extend(list.iter().cloned());
            }
            match body.get("nextPageToken").and_then(Value::as_str) {
                Some(next) if !next.is_empty() => page_token.clone_from(&next.to_owned()),
                _ => break,
            }
        }
        Ok(versions)
    }

    /// `resolveVersion`: `latest`, `latest-approved`, an exact version or a
    /// semver range against the published versions.
    pub async fn resolve_version(
        &self,
        reference: &ExtensionRef,
    ) -> Result<String, ExtensionsError> {
        let requested = reference.version.as_deref();
        if requested.is_none_or(|version| version == "latest" || version == "latest-approved") {
            let extension = self.get_extension(reference).await?;
            let key = if requested == Some("latest-approved") {
                "latestApprovedVersion"
            } else {
                "latestVersion"
            };
            return extension
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| {
                    if key == "latestApprovedVersion" {
                        ExtensionsError(format!(
                            "{} has not been published to Extensions Hub (https://extensions.dev). To install it, you must specify the version you want to install.",
                            reference.extension_ref()
                        ))
                    } else {
                        ExtensionsError(format!(
                            "{} has no stable non-deprecated versions. If you wish to install a prerelease version, you must specify the version you want to install.",
                            reference.extension_ref()
                        ))
                    }
                });
        }
        let requested = requested.unwrap_or_default();
        if semver::Version::parse(requested).is_ok() {
            return Ok(requested.to_owned());
        }
        let range = semver::VersionReq::parse(requested).map_err(|error| {
            ExtensionsError(format!(
                "Extension reference {} contains an invalid version {requested}: {error}",
                reference.extension_ref()
            ))
        })?;
        let versions = self.list_extension_versions(reference, true).await?;
        if versions.is_empty() {
            return Err(ExtensionsError(format!(
                "No versions found for {}",
                reference.extension_ref()
            )));
        }
        let best = versions
            .iter()
            .filter_map(|version| version.get("spec")?.get("version")?.as_str())
            .filter_map(|text| semver::Version::parse(text).ok())
            .filter(|version| range.matches(version))
            .max();
        best.map(|version| version.to_string()).ok_or_else(|| {
            ExtensionsError(format!(
                "No version of {} matches requested version {requested}",
                reference.extension_ref()
            ))
        })
    }

    async fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value, RegistryError> {
        let token = self
            .access_token()
            .await
            .map_err(|error| RegistryError::Other(error.0))?;
        let url = format!("{}/{API_VERSION}{path}", self.endpoints.registry_origin);
        let mut request = self.client.get(&url).query(query);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let response = request
            .send()
            .await
            .map_err(|error| RegistryError::Other(error.to_string()))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| RegistryError::Other(error.to_string()))?;
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(RegistryError::NotFound);
        }
        if !status.is_success() {
            let message = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|body| {
                    body.get("error")?
                        .get("message")?
                        .as_str()
                        .map(str::to_owned)
                })
                .unwrap_or(text);
            return Err(RegistryError::Other(format!(
                "HTTP Error: {}, {message}",
                status.as_u16()
            )));
        }
        serde_json::from_str(&text)
            .map_err(|error| RegistryError::Other(format!("invalid JSON body: {error}")))
    }

    /// The bearer token for registry calls: exchanged once per client from
    /// the refresh token, or `None` when no credential is configured (public
    /// registry reads are attempted unauthenticated and fail with the API's
    /// own message).
    async fn access_token(&self) -> Result<Option<String>, ExtensionsError> {
        let mut cached = self.access_token.lock().await;
        if let Some(token) = cached.as_ref() {
            return Ok(Some(token.clone()));
        }
        let token = match &self.credential {
            None => return Ok(None),
            Some(Credential::AccessToken(token)) => token.clone(),
            Some(Credential::RefreshToken { token, source }) => {
                self.exchange(token, source).await?
            }
        };
        *cached = Some(token.clone());
        Ok(Some(token))
    }

    async fn exchange(&self, refresh_token: &str, source: &str) -> Result<String, ExtensionsError> {
        let url = format!("{}/oauth2/v3/token", self.endpoints.token_origin);
        let response = self
            .client
            .post(&url)
            .form(&[
                ("refresh_token", refresh_token),
                ("client_id", self.endpoints.client_id.as_str()),
                ("client_secret", self.endpoints.client_secret.as_str()),
                ("grant_type", "refresh_token"),
                ("scope", ""),
            ])
            .send()
            .await
            .map_err(|error| {
                ExtensionsError(format!(
                    "failed to refresh the access token from {source}: {error}"
                ))
            })?;
        let body: Value = response.json().await.map_err(|error| {
            ExtensionsError(format!("failed to read the token response: {error}"))
        })?;
        body.get("access_token")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| {
                let reason = body
                    .get("error_description")
                    .or_else(|| body.get("error"))
                    .and_then(Value::as_str)
                    .unwrap_or("no access_token in the response");
                ExtensionsError(format!(
                    "the refresh token from {source} was rejected ({reason}); run `firebase login` again or set FIREBASE_TOKEN"
                ))
            })
    }
}

enum RegistryError {
    NotFound,
    Other(String),
}

/// `refNotFoundError` without the terminal styling.
fn ref_not_found(reference: &ExtensionRef, versioned: bool) -> ExtensionsError {
    let shown = if versioned {
        reference
            .version_ref()
            .unwrap_or_else(|_| reference.extension_ref())
    } else {
        reference.extension_ref()
    };
    let what = if versioned {
        "extension version"
    } else {
        "extension"
    };
    let name = if versioned {
        format!(
            "{}@{}",
            reference.extension_id,
            reference.version.clone().unwrap_or_default()
        )
    } else {
        reference.extension_id.clone()
    };
    ExtensionsError(format!(
        "The extension reference '{shown}' doesn't exist. This could happen for two reasons:\n  -The publisher ID '{}' doesn't exist or could be misspelled\n  -The name of the {what} '{name}' doesn't exist or could be misspelled\n\nPlease correct the extension reference and try again. If you meant to reference an extension from a local source, please provide a relative path prefixed with './', '../', or '~/'.}}",
        reference.publisher_id
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use serde_json::json;

    async fn mock_server() -> String {
        let app = Router::new()
            .route(
                "/oauth2/v3/token",
                post(|body: String| async move {
                    assert!(body.contains("grant_type=refresh_token"));
                    assert!(body.contains("refresh_token=rt-synthetic"));
                    Json(json!({ "access_token": "at-synthetic", "expires_in": 3599 }))
                }),
            )
            .route(
                "/v1beta/publishers/pub/extensions/ext",
                get(|headers: axum::http::HeaderMap| async move {
                    assert_eq!(headers.get("authorization").unwrap(), "Bearer at-synthetic");
                    Json(json!({ "name": "publishers/pub/extensions/ext", "ref": "pub/ext", "latestVersion": "1.2.3", "latestApprovedVersion": "1.2.0" }))
                }),
            )
            .route(
                "/v1beta/publishers/pub/extensions/ext/versions/1.2.3",
                get(|| async {
                    Json(json!({
                        "name": "publishers/pub/extensions/ext/versions/1.2.3",
                        "ref": "pub/ext@1.2.3",
                        "sourceDownloadUri": "https://example.test/src.zip",
                        "spec": { "name": "ext", "version": "1.2.3", "resources": [
                            { "name": "fn", "type": "firebaseextensions.v1beta.function", "propertiesYaml": "location: ${param:LOCATION}\nhttpsTrigger: {}\n" }
                        ] }
                    }))
                }),
            )
            .route(
                "/v1beta/publishers/pub/extensions/ext/versions",
                get(|| async {
                    Json(json!({ "extensionVersions": [
                        { "spec": { "version": "1.2.3" } },
                        { "spec": { "version": "1.3.0-rc.1" } },
                        { "spec": { "version": "1.1.0" } }
                    ] }))
                }),
            )
            .route("/v1beta/publishers/pub/extensions/missing", get(|| async { (axum::http::StatusCode::NOT_FOUND, "{}") }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        origin
    }

    fn client(origin: &str) -> RegistryClient {
        RegistryClient::new(
            Endpoints {
                registry_origin: origin.to_owned(),
                token_origin: origin.to_owned(),
                client_id: "cid".to_owned(),
                client_secret: "secret".to_owned(),
            },
            Some(Credential::RefreshToken {
                token: "rt-synthetic".to_owned(),
                source: "test",
            }),
        )
    }

    #[tokio::test]
    async fn exchanges_the_refresh_token_and_reads_the_registry() {
        let origin = mock_server().await;
        let client = client(&origin);
        let reference = ExtensionRef::parse("pub/ext@1.2.3").unwrap();
        let version = client.get_extension_version(&reference).await.unwrap();
        assert_eq!(
            version["spec"]["resources"][0]["properties"]["location"],
            "${param:LOCATION}"
        );
        assert_eq!(version["spec"]["params"], json!([]));
        let extension = client.get_extension(&reference).await.unwrap();
        assert_eq!(extension["latestVersion"], "1.2.3");
        assert_eq!(
            client
                .resolve_version(&ExtensionRef::parse("pub/ext").unwrap())
                .await
                .unwrap(),
            "1.2.3"
        );
        assert_eq!(
            client
                .resolve_version(&ExtensionRef::parse("pub/ext@latest-approved").unwrap())
                .await
                .unwrap(),
            "1.2.0"
        );
        assert_eq!(
            client
                .resolve_version(&ExtensionRef::parse("pub/ext@^1.0.0").unwrap())
                .await
                .unwrap(),
            "1.2.3"
        );
        let missing = client
            .get_extension(&ExtensionRef::parse("pub/missing").unwrap())
            .await
            .unwrap_err();
        assert!(
            missing
                .0
                .starts_with("The extension reference 'pub/missing' doesn't exist."),
            "{}",
            missing.0
        );
    }
}
