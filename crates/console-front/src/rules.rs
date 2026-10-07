//! The security rules, as text you can change.
//!
//! The emulator exists so rules can be got right before they reach
//! production, and the loop that takes — edit the file, restart, try again —
//! is the slowest part of writing them. Here the rules are the text on
//! screen: a change compiles and takes effect on the next request, and the
//! Requests feed then shows the line that decided it.
//!
//! A change is installed for the database being edited, which is the level
//! `firebase.json` declares rules at and the level that takes precedence.
//! Saving writes the same text back to the file the project configures, so
//! what the console applied and what the repository holds do not drift; a
//! database with no file configured can still be edited, and says it was
//! not saved rather than implying it was.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use firenook_core_store::DatabaseName;
use firenook_rules_runtime::RulesRuntime;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The largest ruleset the console will accept, matching the engine's own
/// compiler limit closely enough to refuse early with a clear message.
const MAX_SOURCE_BYTES: usize = 256 * 1024;

/// One compiler complaint, placed in the text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RulesDiagnostic {
    /// `error` or `warning`.
    pub severity: String,
    pub message: String,
    /// One-based line.
    #[ts(type = "number")]
    pub line: usize,
    /// One-based column.
    #[ts(type = "number")]
    pub column: usize,
}

/// The rules a database is being served with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RulesDocument {
    pub database: String,
    /// The source now in force. Empty when the suite runs without rules,
    /// which is the explicit open-with-warning mode.
    pub source: String,
    /// Whether any ruleset is installed at all.
    pub enforced: bool,
    /// The file this database's rules are configured in, when
    /// `firebase.json` names one. Saving writes here.
    pub path: Option<String>,
}

/// What a change did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RulesInstalled {
    pub database: String,
    /// Whether the text was also written to the configured file.
    pub saved: bool,
    /// The file written, when one was.
    pub path: Option<String>,
}

/// Reads and replaces the rules of each database the console can reach.
#[derive(Clone)]
pub struct RulesEditor {
    rules: RulesRuntime,
    project: Arc<str>,
    /// The file each database declares its rules in, from `firebase.json`.
    files: Arc<BTreeMap<String, PathBuf>>,
}

impl RulesEditor {
    /// An editor over `project`'s rules. `files` maps a database id to the
    /// file `firebase.json` configures for it.
    #[must_use]
    pub fn new(rules: &RulesRuntime, project: &str, files: BTreeMap<String, PathBuf>) -> Self {
        Self {
            rules: rules.clone(),
            project: Arc::from(project),
            files: Arc::new(files),
        }
    }

    pub(crate) fn router(self) -> axum::Router {
        axum::Router::new()
            .route("/rules", axum::routing::get(read_rules).put(write_rules))
            .with_state(self)
    }

    fn database(&self, database_id: &str) -> Result<DatabaseName, RulesError> {
        DatabaseName::new(self.project.as_ref(), database_id)
            .map_err(|error| RulesError::invalid(error.to_string()))
    }

    fn read(&self, database_id: &str) -> Result<RulesDocument, RulesError> {
        let database = self.database(database_id)?;
        let installed = self.rules.rules_for(&database);
        Ok(RulesDocument {
            database: database_id.to_owned(),
            source: installed
                .as_ref()
                .map(|rules| rules.source().to_owned())
                .unwrap_or_default(),
            enforced: installed.is_some(),
            path: self.path(database_id),
        })
    }

    fn path(&self, database_id: &str) -> Option<String> {
        self.files
            .get(database_id)
            .map(|path| path.display().to_string())
    }

    fn write(&self, request: &WriteRules) -> Result<RulesInstalled, RulesError> {
        let database_id = request.database.as_deref().unwrap_or("(default)");
        let database = self.database(database_id)?;
        if request.source.len() > MAX_SOURCE_BYTES {
            return Err(RulesError::invalid(format!(
                "a ruleset is at most {MAX_SOURCE_BYTES} bytes"
            )));
        }
        // Compile and install first: a ruleset that does not compile must
        // not reach the file, and a failed compilation leaves the previous
        // one serving requests untouched.
        self.rules
            .install_database(&database, &request.source)
            .map_err(|error| RulesError::Diagnostics(diagnostics(&error)))?;
        let Some(path) = self.files.get(database_id) else {
            return Ok(RulesInstalled {
                database: database_id.to_owned(),
                saved: false,
                path: None,
            });
        };
        if !request.save {
            return Ok(RulesInstalled {
                database: database_id.to_owned(),
                saved: false,
                path: Some(path.display().to_string()),
            });
        }
        std::fs::write(path, &request.source).map_err(|error| {
            RulesError::NotSaved(format!(
                "the rules are in force but {} could not be written: {error}",
                path.display()
            ))
        })?;
        Ok(RulesInstalled {
            database: database_id.to_owned(),
            saved: true,
            path: Some(path.display().to_string()),
        })
    }
}

fn diagnostics(error: &firenook_rules_runtime::LoadError) -> Vec<RulesDiagnostic> {
    error
        .diagnostics
        .iter()
        .map(|diagnostic| RulesDiagnostic {
            severity: format!("{:?}", diagnostic.severity).to_lowercase(),
            message: diagnostic.message.clone(),
            line: diagnostic.line,
            column: diagnostic.column,
        })
        .collect()
}

/// Why a change was refused.
#[derive(Debug)]
pub enum RulesError {
    Invalid(String),
    /// The rules did not compile; nothing changed.
    Diagnostics(Vec<RulesDiagnostic>),
    /// The rules are in force, but the file could not be written.
    NotSaved(String),
}

impl RulesError {
    fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(message.into())
    }
}

impl IntoResponse for RulesError {
    fn into_response(self) -> Response {
        match self {
            Self::Invalid(message) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": { "message": message } })),
            )
                .into_response(),
            Self::Diagnostics(diagnostics) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": { "message": "these rules did not compile; nothing changed" },
                    "diagnostics": diagnostics,
                })),
            )
                .into_response(),
            Self::NotSaved(message) => (
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": { "message": message } })),
            )
                .into_response(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct ReadRules {
    database: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct WriteRules {
    database: Option<String>,
    source: String,
    /// Also write the configured file.
    #[serde(default)]
    save: bool,
}

/// `GET /rules?database=(default)`: the rules in force.
async fn read_rules(
    State(editor): State<RulesEditor>,
    Query(request): Query<ReadRules>,
) -> Result<Json<RulesDocument>, RulesError> {
    editor
        .read(request.database.as_deref().unwrap_or("(default)"))
        .map(Json)
}

/// `PUT /rules`: compile, install, and optionally save.
async fn write_rules(
    State(editor): State<RulesEditor>,
    Json(request): Json<WriteRules>,
) -> Result<Json<RulesInstalled>, RulesError> {
    // Compiling and writing a file are both blocking.
    tokio::task::spawn_blocking(move || editor.write(&request))
        .await
        .map_err(|_| RulesError::invalid("the rules task did not finish"))?
        .map(Json)
}

#[cfg(test)]
mod tests {
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use tower::ServiceExt as _;

    use super::*;

    const PROJECT: &str = "demo-rules";

    fn allow(everything: bool) -> String {
        format!(
            "rules_version = '2';\nservice cloud.firestore {{\n  match /databases/{{database}}/documents {{\n    match /{{document=**}} {{\n      allow read, write: if {everything};\n    }}\n  }}\n}}\n"
        )
    }

    fn database() -> DatabaseName {
        DatabaseName::new(PROJECT, "(default)").expect("database")
    }

    struct TempRules(PathBuf);

    impl TempRules {
        fn new(source: &str) -> Self {
            static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "firenook-rules-{}-{}.rules",
                std::process::id(),
                SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::write(&path, source).expect("write");
            Self(path)
        }
    }

    impl Drop for TempRules {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn editor(file: Option<&PathBuf>) -> (RulesRuntime, RulesEditor) {
        let runtime = RulesRuntime::default();
        runtime
            .install_database(&database(), &allow(false))
            .expect("install");
        let files = file.map_or_else(BTreeMap::new, |path| {
            BTreeMap::from([("(default)".to_owned(), path.clone())])
        });
        let editor = RulesEditor::new(&runtime, PROJECT, files);
        (runtime, editor)
    }

    async fn request(
        editor: RulesEditor,
        request: Request<Body>,
    ) -> (StatusCode, serde_json::Value) {
        let response = editor.router().oneshot(request).await.expect("response");
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        (
            status,
            serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null),
        )
    }

    fn put(source: &str, save: bool) -> Request<Body> {
        Request::put("/rules")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({ "source": source, "save": save }).to_string(),
            ))
            .expect("request")
    }

    #[tokio::test]
    async fn the_rules_in_force_are_what_is_read_back() {
        let (_runtime, editor) = editor(None);
        let (status, body) = request(
            editor,
            Request::get("/rules?database=(default)")
                .body(Body::empty())
                .expect("request"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["enforced"], true);
        assert!(
            body["source"]
                .as_str()
                .is_some_and(|source| source.contains("allow read, write")),
            "{body}"
        );
        assert!(body["path"].is_null(), "no file is configured: {body}");
    }

    #[tokio::test]
    async fn a_change_takes_effect_for_the_next_request() {
        let (runtime, editor) = editor(None);
        let (status, body) = request(editor, put(&allow(true), false)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["saved"], false);
        assert!(
            runtime
                .rules_for(&database())
                .expect("a ruleset")
                .source()
                .contains("if true"),
            "the runtime every front evaluates against now holds the new rules"
        );
    }

    #[tokio::test]
    async fn rules_that_do_not_compile_change_nothing_and_say_where() {
        let (runtime, editor) = editor(None);
        let (status, body) = request(editor, put("service cloud.firestore { match", false)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["error"]["message"],
            "these rules did not compile; nothing changed"
        );
        let first = &body["diagnostics"][0];
        assert!(
            first["line"].as_u64().is_some_and(|line| line >= 1),
            "{body}"
        );
        assert!(
            first["column"].as_u64().is_some_and(|column| column >= 1),
            "{body}"
        );
        assert!(
            first["message"].as_str().is_some_and(|m| !m.is_empty()),
            "{body}"
        );
        assert!(
            runtime
                .rules_for(&database())
                .expect("a ruleset")
                .source()
                .contains("if false"),
            "the previous rules keep serving requests"
        );
    }

    #[tokio::test]
    async fn saving_writes_the_file_the_project_configures() {
        let file = TempRules::new(&allow(false));
        let (_runtime, editor) = editor(Some(&file.0));
        let (status, body) = request(editor.clone(), put(&allow(true), true)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["saved"], true);
        assert_eq!(body["path"], file.0.display().to_string());
        assert!(
            std::fs::read_to_string(&file.0)
                .expect("read back")
                .contains("if true"),
            "the file holds what was applied"
        );
        // Reading names the file, so the console can say where it saves.
        let (_, read) = request(
            editor,
            Request::get("/rules").body(Body::empty()).expect("request"),
        )
        .await;
        assert_eq!(read["path"], file.0.display().to_string());
    }

    #[tokio::test]
    async fn applying_without_saving_leaves_the_file_alone() {
        let file = TempRules::new(&allow(false));
        let (runtime, editor) = editor(Some(&file.0));
        let (status, body) = request(editor, put(&allow(true), false)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["saved"], false);
        assert_eq!(body["path"], file.0.display().to_string());
        assert!(
            std::fs::read_to_string(&file.0)
                .expect("read")
                .contains("if false"),
            "the repository's copy is untouched until it is saved"
        );
        assert!(
            runtime
                .rules_for(&database())
                .expect("rules")
                .source()
                .contains("if true"),
            "but the change is in force"
        );
    }

    #[tokio::test]
    async fn rules_that_do_not_compile_never_reach_the_file() {
        let file = TempRules::new(&allow(false));
        let (_runtime, editor) = editor(Some(&file.0));
        let (status, _) = request(editor, put("not rules at all", true)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            std::fs::read_to_string(&file.0)
                .expect("read")
                .contains("if false"),
            "a ruleset that does not compile must not be written"
        );
    }

    #[tokio::test]
    async fn an_invalid_database_is_refused() {
        let (_runtime, editor) = editor(None);
        let (status, _) = request(
            editor,
            Request::get("/rules?database=has/a/slash")
                .body(Body::empty())
                .expect("request"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn a_ruleset_beyond_the_limit_is_refused_before_it_is_compiled() {
        let (_runtime, editor) = editor(None);
        let huge = "/".repeat(MAX_SOURCE_BYTES + 1);
        let (status, body) = request(editor, put(&huge, false)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("at most")),
            "{body}"
        );
    }
}
