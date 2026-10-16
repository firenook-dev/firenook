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
//!
//! The text can change under the console too: the rules file is watched,
//! another tab saves, a test reloads the project's rules. So the editor also
//! answers what governed a database over time (`/rules/history`), tells of
//! every change (the live channel's `firestore.rules` topic), says why the
//! file on disk is not what is in force when it did not compile, and checks
//! a draft without installing it
//! (`/rules/check`): compiler errors, lints, an outline, and which match
//! blocks govern each collection the data holds.
//!
//! Every position in a response is a UTF-16 offset into the exact source
//! that response is about, because the editor is a browser text component
//! and that is how it counts.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use firenook_core_store::DatabaseName;
use firenook_rules_engine::{
    Diagnostic, DiagnosticSeverity, GoverningMap, LintCode, RequestOperation,
};
use firenook_rules_runtime::{InstalledVersion, LoadError, RulesEvent, RulesRuntime};
use futures_util::stream::{self, StreamExt as _};
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::blocking::blocking;
use crate::live::badges::{BadgeHandle, BadgeTone};
use crate::live::{LiveTopic, TopicEvent, TopicStream, topic_params};
use crate::schema::{SchemaIndex, SchemaNode};
use crate::sse::Shutdown;

/// The largest ruleset the console will accept, matching the engine's own
/// compiler limit closely enough to refuse early with a clear message.
const MAX_SOURCE_BYTES: usize = 256 * 1024;

/// How serious a diagnostic is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum RulesSeverity {
    /// The rules do not compile.
    Error,
    /// The rules compile but a lint objects.
    Warning,
}

/// The lint behind a warning.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
pub enum RulesLintCode {
    /// An unconditional allow on a match that reaches arbitrary collections.
    #[serde(rename = "open-access")]
    OpenAccess,
    /// A condition that only asks whether the caller is signed in.
    #[serde(rename = "auth-only")]
    AuthOnly,
    /// A create or update allowed without looking at the written data.
    #[serde(rename = "unvalidated-write")]
    UnvalidatedWrite,
    /// A recursive wildcard below `rules_version = '2'`.
    #[serde(rename = "collection-group-v1")]
    CollectionGroupV1,
    /// Storage: an upload allowed with no check on its size.
    #[serde(rename = "unbounded-upload")]
    UnboundedUpload,
    /// Storage: a list allowed below `rules_version = '2'`, where lists are refused.
    #[serde(rename = "list-v1")]
    ListV1,
}

/// One compiler complaint or lint warning, placed in the text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RulesDiagnostic {
    pub severity: RulesSeverity,
    pub message: String,
    /// One-based line.
    #[ts(type = "number")]
    pub line: usize,
    /// One-based column.
    #[ts(type = "number")]
    pub column: usize,
    /// Zero-based UTF-16 offset of the start, into the source this
    /// diagnostic is about.
    #[ts(type = "number")]
    pub from: usize,
    /// Exclusive UTF-16 end; equal to `from` when only a position is known,
    /// as for compiler errors.
    #[ts(type = "number")]
    pub to: usize,
    /// The lint that raised a warning; `null` for a compiler error.
    pub code: Option<RulesLintCode>,
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
    /// Stable hash of `source`, the one versions and live events carry;
    /// empty when no ruleset is in force.
    pub hash: String,
    /// The configured file's current text, when `path` is set and readable.
    /// It differs from `source` while the file holds a change that did not
    /// compile, or one applied in the console without saving.
    pub file_source: Option<String>,
    /// Why the file on disk is not what is in force: the watcher's last pass
    /// found it did not compile, or could not read it. Empty otherwise.
    /// Positions refer to `fileSource`.
    pub file_problems: Vec<RulesDiagnostic>,
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

/// A draft, compiled and read but not installed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RulesCheck {
    /// Compiler errors (then `outline` and `map` are null), or the lints'
    /// warnings for a draft that compiles.
    pub diagnostics: Vec<RulesDiagnostic>,
    pub outline: Option<RulesOutline>,
    /// Which match blocks govern each collection of the database's data,
    /// the console's schema tree. Null when the draft does not compile or
    /// the schema could not be read.
    pub map: Option<RulesMap>,
}

/// The match blocks of a draft, depth first in source order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RulesOutline {
    /// Declared `rules_version`.
    pub rules_version: u8,
    pub matches: Vec<OutlineMatch>,
}

/// One match block.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OutlineMatch {
    /// The full pattern below the documents root, such as
    /// `/users/{uid}/orders/{orderId}` or `/{document=**}`.
    pub path: String,
    /// Line of the `match …` header.
    #[ts(type = "number")]
    pub line: usize,
    /// UTF-16 offset of the `match …` header's start.
    #[ts(type = "number")]
    pub from: usize,
    /// Exclusive UTF-16 end of the header (the end of its path).
    #[ts(type = "number")]
    pub to: usize,
    /// Nesting below `match /databases/{database}/documents`: its direct
    /// children are 0.
    #[ts(type = "number")]
    pub depth: usize,
    pub allows: Vec<OutlineAllow>,
}

/// One allow statement.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OutlineAllow {
    /// Line of the statement.
    #[ts(type = "number")]
    pub line: usize,
    /// UTF-16 offset of the whole `allow …;` statement's start.
    #[ts(type = "number")]
    pub from: usize,
    /// Exclusive UTF-16 end of the statement, its semicolon included.
    #[ts(type = "number")]
    pub to: usize,
    /// `read` and `write` expanded, in the order get, list, create, update,
    /// delete.
    pub operations: Vec<RulesOperation>,
    /// The condition's source text; `true` for `allow read;`.
    pub condition: String,
    /// Set when the condition is the literal `true` or `false`.
    pub always: Option<bool>,
}

/// One concrete operation an allow statement can grant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum RulesOperation {
    Get,
    List,
    Create,
    Update,
    Delete,
}

/// Which match blocks govern which collections.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RulesMap {
    /// Every collection pattern of the schema tree, depth first.
    pub collections: Vec<CollectionRules>,
    /// Match blocks no collection in the data reaches, nor any block nested
    /// in them — often a typo in the path. Empty while the database holds no
    /// data.
    pub unused_matches: Vec<UnusedMatch>,
}

/// What governs one collection pattern.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRules {
    /// Schema pattern: collection ids with `*` standing for each document
    /// id between them, as the schema tree writes them (the orders of every
    /// user, for example). Spelt out because the pattern itself would close
    /// the generated TypeScript doc comment.
    pub pattern: String,
    /// Match blocks matching its documents, in source order. A block naming
    /// one document (`/config/global`) is included.
    pub governed_by: Vec<GoverningMatch>,
    /// No match block matches its documents, so every client request for
    /// them is denied.
    pub uncovered: bool,
}

/// A match block governing a collection, with what its allows can grant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GoverningMatch {
    /// Line of the block's header.
    #[ts(type = "number")]
    pub line: usize,
    /// The block's outline path.
    pub path: String,
    /// Operations its allow statements grant under some condition; an
    /// `if false` grants nothing and is left out.
    pub operations: Vec<RulesOperation>,
}

/// A match block nothing in the data reaches.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UnusedMatch {
    /// Line of the block's header.
    #[ts(type = "number")]
    pub line: usize,
    /// The block's outline path.
    pub path: String,
}

/// Where a ruleset came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum RulesOrigin {
    /// The configuration the suite started with.
    Startup,
    /// The console (`PUT /rules`).
    Console,
    /// The rules file watcher, after the file changed on disk.
    File,
    /// The emulator's project-wide hot-reload route (rules unit testing).
    Reload,
}

/// One ruleset that governed a database.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RulesVersion {
    pub hash: String,
    pub source: String,
    pub origin: RulesOrigin,
    /// When it was installed, RFC 3339.
    pub installed_at: String,
}

/// What governs a database changed (`rules` on the `firestore.rules` topic).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RulesChanged {
    pub database: String,
    /// Hash of the ruleset now in force.
    pub hash: String,
    /// Where it came from.
    pub origin: RulesOrigin,
}

/// The rules file watcher finished a pass (`file` on the `firestore.rules`
/// topic).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RulesFileStatus {
    pub database: String,
    /// Why the file is not in force; empty when the pass succeeded.
    pub problems: Vec<RulesDiagnostic>,
}

/// Reads and replaces the rules of each database the console can reach.
#[derive(Clone)]
pub struct RulesEditor {
    rules: RulesRuntime,
    project: Arc<str>,
    /// The file each database declares its rules in, from `firebase.json`.
    files: Arc<BTreeMap<String, PathBuf>>,
    /// The console's schema index, which a check maps the rules against.
    schema: Option<SchemaIndex>,
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
            schema: None,
        }
    }

    /// Maps checked drafts against `schema`, the tree the console shows.
    #[must_use]
    pub fn with_schema(mut self, schema: &SchemaIndex) -> Self {
        self.schema = Some(schema.clone());
        self
    }

    /// The live channel's `firestore.rules` topic over this editor.
    pub(crate) fn topic(&self) -> RulesTopic {
        RulesTopic {
            editor: self.clone(),
        }
    }

    /// How many configured databases' rules files the watcher last found
    /// broken: those `firebase.json` names a file for whose latest check
    /// failed.
    fn broken_files(&self) -> u64 {
        let broken = self
            .files
            .keys()
            .filter_map(|database_id| self.database(database_id).ok())
            .filter(|database| self.rules.file_problems(database).is_some())
            .count();
        u64::try_from(broken).unwrap_or(u64::MAX)
    }

    /// Keeps the `firestore.rules` badge (`badge`) at the number of
    /// configured databases whose rules file does not compile: set now, and
    /// again after every file check, until the suite stops.
    pub(crate) fn spawn_badge(&self, badge: BadgeHandle, shutdown: Shutdown) {
        fn publish(editor: &RulesEditor, badge: &BadgeHandle) {
            let broken = editor.broken_files();
            let tone = if broken == 0 {
                BadgeTone::Neutral
            } else {
                BadgeTone::Danger
            };
            badge.set(broken, tone);
        }
        // Subscribe first, so a check that lands while the count is read is
        // still seen.
        let mut events = self.rules.subscribe();
        publish(self, &badge);
        let editor = self.clone();
        tokio::spawn(async move {
            let stopped = shutdown.stopped();
            tokio::pin!(stopped);
            loop {
                tokio::select! {
                    biased;
                    () = &mut stopped => break,
                    event = events.recv() => match event {
                        Ok(RulesEvent::FileChecked { .. })
                        | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            publish(&editor, &badge);
                        }
                        Ok(RulesEvent::Installed { .. }) => {}
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    },
                }
            }
        });
    }

    /// The editor's routes. None of them streams: what changes is told on
    /// the live channel's `firestore.rules` topic ([`Self::topic`]).
    pub(crate) fn router(self) -> axum::Router {
        axum::Router::new()
            .route("/rules", axum::routing::get(read_rules).put(write_rules))
            .route("/rules/check", axum::routing::post(check_rules))
            .route("/rules/history", axum::routing::get(rules_history))
            .with_state(self)
    }

    fn database(&self, database_id: &str) -> Result<DatabaseName, ApiError> {
        DatabaseName::new(self.project.as_ref(), database_id)
            .map_err(|error| ApiError::invalid(error.to_string()))
    }

    async fn read(&self, database_id: &str) -> Result<RulesDocument, ApiError> {
        let database = self.database(database_id)?;
        // One read gives source and hash from the same install.
        let current = self.rules.current_version(&database);
        let file_source = match self.files.get(database_id).cloned() {
            Some(path) => tokio::task::spawn_blocking(move || std::fs::read_to_string(path).ok())
                .await
                .ok()
                .flatten(),
            None => None,
        };
        let hash = current
            .as_ref()
            .map(|version| version.hash.clone())
            .unwrap_or_default();
        let source = current
            .as_ref()
            .map(|version| version.source.to_string())
            .unwrap_or_default();
        Ok(RulesDocument {
            database: database_id.to_owned(),
            enforced: current.is_some(),
            hash,
            source,
            path: self.path(database_id),
            file_source,
            file_problems: self
                .rules
                .file_problems(&database)
                .map(|problems| diagnostics(&problems))
                .unwrap_or_default(),
        })
    }

    fn path(&self, database_id: &str) -> Option<String> {
        self.files
            .get(database_id)
            .map(|path| path.display().to_string())
    }

    fn write(&self, request: &WriteRules) -> Result<RulesInstalled, ApiError> {
        let database_id = request.database.as_deref().unwrap_or("(default)");
        let database = self.database(database_id)?;
        if request.source.len() > MAX_SOURCE_BYTES {
            return Err(ApiError::invalid(format!(
                "a ruleset is at most {MAX_SOURCE_BYTES} bytes"
            )));
        }
        // Compile and install first: a ruleset that does not compile must
        // not reach the file, and a failed compilation leaves the previous
        // one serving requests untouched.
        self.rules
            .install_database_from(
                &database,
                &request.source,
                firenook_rules_runtime::RulesOrigin::Console,
            )
            .map_err(|error| not_compiled(&diagnostics(&error)))?;
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
        // The file watcher sees this write, finds the text already in force
        // and installs nothing, so a save records one version, not two.
        std::fs::write(path, &request.source).map_err(|error| {
            ApiError::conflict(format!(
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

    async fn check(&self, request: CheckRules) -> Result<RulesCheck, ApiError> {
        let database_id = request.database.unwrap_or_else(|| "(default)".to_owned());
        self.database(&database_id)?;
        if request.source.len() > MAX_SOURCE_BYTES {
            return Err(ApiError::invalid(format!(
                "a ruleset is at most {MAX_SOURCE_BYTES} bytes"
            )));
        }
        // Compiling and reading a large ruleset is CPU work; keep it off
        // the request workers.
        let source = request.source;
        let compiled = blocking("the rules task", move || {
            Ok(firenook_rules_engine::compile(&source).map(|ruleset| {
                let lints = ruleset.lints();
                let outline = ruleset.outline();
                (ruleset, lints, outline)
            }))
        })
        .await?;
        let (ruleset, lints, outline) = match compiled {
            Ok(compiled) => compiled,
            Err(errors) => {
                return Ok(RulesCheck {
                    diagnostics: errors.iter().map(diagnostic).collect(),
                    outline: None,
                    map: None,
                });
            }
        };
        let map = match &self.schema {
            // A schema that cannot be read leaves the map out rather than
            // failing a check whose compiler answer is still good.
            Some(schema) => schema.snapshot(&database_id).await.ok().map(|snapshot| {
                let mut patterns = Vec::new();
                for node in &snapshot.collections {
                    collect_patterns(node, &mut patterns);
                }
                rules_map(&ruleset.governing(&database_id, &patterns))
            }),
            None => None,
        };
        Ok(RulesCheck {
            diagnostics: lints.iter().map(diagnostic).collect(),
            outline: Some(outline_view(&outline)),
            map,
        })
    }
}

/// THE way to turn a failed compilation into what the console shows.
pub(crate) fn diagnostics(error: &LoadError) -> Vec<RulesDiagnostic> {
    error.diagnostics.iter().map(diagnostic).collect()
}

pub(crate) fn diagnostic(diagnostic: &Diagnostic) -> RulesDiagnostic {
    RulesDiagnostic {
        severity: match diagnostic.severity {
            DiagnosticSeverity::Error => RulesSeverity::Error,
            DiagnosticSeverity::Warning => RulesSeverity::Warning,
        },
        message: diagnostic.message.clone(),
        line: diagnostic.line,
        column: diagnostic.column,
        from: diagnostic.from,
        to: diagnostic.to,
        code: diagnostic.code.map(|code| match code {
            LintCode::OpenAccess => RulesLintCode::OpenAccess,
            LintCode::AuthOnly => RulesLintCode::AuthOnly,
            LintCode::UnvalidatedWrite => RulesLintCode::UnvalidatedWrite,
            LintCode::CollectionGroupV1 => RulesLintCode::CollectionGroupV1,
            LintCode::UnboundedUpload => RulesLintCode::UnboundedUpload,
            LintCode::ListV1 => RulesLintCode::ListV1,
        }),
    }
}

const fn operation(operation: RequestOperation) -> RulesOperation {
    match operation {
        RequestOperation::Get => RulesOperation::Get,
        RequestOperation::List => RulesOperation::List,
        RequestOperation::Create => RulesOperation::Create,
        RequestOperation::Update => RulesOperation::Update,
        RequestOperation::Delete => RulesOperation::Delete,
    }
}

pub(crate) fn operations(operations: &[RequestOperation]) -> Vec<RulesOperation> {
    operations.iter().copied().map(operation).collect()
}

pub(crate) fn outline_view(outline: &firenook_rules_engine::RulesOutline) -> RulesOutline {
    RulesOutline {
        rules_version: outline.rules_version,
        matches: outline
            .matches
            .iter()
            .map(|block| OutlineMatch {
                path: block.path.clone(),
                line: block.header.line,
                from: block.header.from,
                to: block.header.to,
                depth: block.depth,
                allows: block
                    .allows
                    .iter()
                    .map(|allow| OutlineAllow {
                        line: allow.statement.line,
                        from: allow.statement.from,
                        to: allow.statement.to,
                        operations: operations(&allow.operations),
                        condition: allow.condition.clone(),
                        always: allow.always,
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn rules_map(map: &GoverningMap) -> RulesMap {
    RulesMap {
        collections: map
            .collections
            .iter()
            .map(|collection| CollectionRules {
                pattern: collection.pattern.clone(),
                uncovered: collection.uncovered(),
                governed_by: collection
                    .governed_by
                    .iter()
                    .map(|block| GoverningMatch {
                        line: block.line,
                        path: block.path.clone(),
                        operations: operations(&block.operations),
                    })
                    .collect(),
            })
            .collect(),
        unused_matches: map
            .unused_matches
            .iter()
            .map(|block| UnusedMatch {
                line: block.line,
                path: block.path.clone(),
            })
            .collect(),
    }
}

/// The schema tree's patterns, depth first, as the console draws them.
fn collect_patterns(node: &SchemaNode, patterns: &mut Vec<String>) {
    patterns.push(node.pattern.clone());
    for child in &node.children {
        collect_patterns(child, patterns);
    }
}

pub(crate) fn version(version: InstalledVersion) -> RulesVersion {
    RulesVersion {
        hash: version.hash,
        source: version.source.to_string(),
        origin: origin(version.origin),
        installed_at: version.installed_at.format(&Rfc3339).unwrap_or_default(),
    }
}

pub(crate) const fn origin(origin: firenook_rules_runtime::RulesOrigin) -> RulesOrigin {
    match origin {
        firenook_rules_runtime::RulesOrigin::Startup => RulesOrigin::Startup,
        firenook_rules_runtime::RulesOrigin::Console => RulesOrigin::Console,
        firenook_rules_runtime::RulesOrigin::File => RulesOrigin::File,
        firenook_rules_runtime::RulesOrigin::Reload => RulesOrigin::Reload,
    }
}

/// A change refused because the rules did not compile: nothing changed, and
/// the compiler's diagnostics ride beside the error.
pub(crate) fn not_compiled(diagnostics: &[RulesDiagnostic]) -> ApiError {
    ApiError::invalid("these rules did not compile; nothing changed").with_extra(
        "diagnostics",
        serde_json::to_value(diagnostics).unwrap_or_default(),
    )
}

#[derive(Debug, Deserialize)]
pub(crate) struct ReadRules {
    database: Option<String>,
}

/// `PUT /rules`.
#[derive(Debug, Deserialize, TS)]
#[ts(rename = "RulesWriteBody")]
pub(crate) struct WriteRules {
    #[ts(optional = nullable)]
    database: Option<String>,
    source: String,
    /// Also write the configured file.
    #[serde(default)]
    #[ts(optional, as = "Option<bool>")]
    save: bool,
}

/// `POST /rules/check`.
#[derive(Debug, Deserialize, TS)]
#[ts(rename = "RulesCheckBody")]
pub(crate) struct CheckRules {
    #[ts(optional = nullable)]
    database: Option<String>,
    source: String,
}

/// `GET /rules?database=(default)`: the rules in force, and the file.
async fn read_rules(
    State(editor): State<RulesEditor>,
    Query(request): Query<ReadRules>,
) -> Result<Json<RulesDocument>, ApiError> {
    editor
        .read(request.database.as_deref().unwrap_or("(default)"))
        .await
        .map(Json)
}

/// `PUT /rules`: compile, install, and optionally save.
async fn write_rules(
    State(editor): State<RulesEditor>,
    Json(request): Json<WriteRules>,
) -> Result<Json<RulesInstalled>, ApiError> {
    // Compiling and writing a file are both blocking.
    blocking("the rules task", move || editor.write(&request))
        .await
        .map(Json)
}

/// `POST /rules/check`: compile and read a draft, installing nothing. Rules
/// that do not compile are an answer here, not a failure: their errors come
/// back as diagnostics with a 200.
async fn check_rules(
    State(editor): State<RulesEditor>,
    Json(request): Json<CheckRules>,
) -> Result<Json<RulesCheck>, ApiError> {
    editor.check(request).await.map(Json)
}

/// `GET /rules/history?database=(default)`: what governed the database,
/// newest first.
async fn rules_history(
    State(editor): State<RulesEditor>,
    Query(request): Query<ReadRules>,
) -> Result<Json<Vec<RulesVersion>>, ApiError> {
    let database = editor.database(request.database.as_deref().unwrap_or("(default)"))?;
    Ok(Json(
        editor
            .rules
            .rules_history(&database)
            .into_iter()
            .map(version)
            .collect(),
    ))
}

/// What a rules subscriber is told.
enum Told {
    Rules(RulesChanged),
    File(RulesFileStatus),
}

/// Turns the rules runtime's events into what one database's subscriber
/// is told: `rules` when the ruleset in force changed from any origin (a
/// hash it has not seen), `file` after every check of the database's file.
struct RulesNews {
    rules: RulesRuntime,
    database: DatabaseName,
    database_id: String,
    /// The hash in force the subscriber was last told of.
    seen: Option<String>,
}

impl RulesNews {
    const fn new(
        rules: RulesRuntime,
        database: DatabaseName,
        database_id: String,
        seen: Option<String>,
    ) -> Self {
        Self {
            rules,
            database,
            database_id,
            seen,
        }
    }

    fn after(&mut self, item: &Result<RulesEvent, BroadcastStreamRecvError>) -> Vec<Told> {
        let (recheck, file) = match item {
            Ok(RulesEvent::Installed { .. }) => (true, false),
            Ok(RulesEvent::FileChecked { database: checked }) => (false, *checked == self.database),
            // A lagging stream may have missed either kind; re-read both.
            Err(BroadcastStreamRecvError::Lagged(_)) => (true, true),
        };
        let mut told = Vec::new();
        if recheck && let Some(changed) = self.changed() {
            told.push(Told::Rules(changed));
        }
        if file {
            told.push(Told::File(self.file()));
        }
        told
    }

    /// The ruleset in force, when the subscriber has not been told of it.
    fn changed(&mut self) -> Option<RulesChanged> {
        let current = self.rules.current_version(&self.database)?;
        if self.seen.as_deref() == Some(current.hash.as_str()) {
            return None;
        }
        self.seen = Some(current.hash.clone());
        Some(RulesChanged {
            database: self.database_id.clone(),
            hash: current.hash,
            origin: origin(current.origin),
        })
    }

    fn file(&self) -> RulesFileStatus {
        RulesFileStatus {
            database: self.database_id.clone(),
            problems: self
                .rules
                .file_problems(&self.database)
                .map(|problems| diagnostics(&problems))
                .unwrap_or_default(),
        }
    }

    /// The cursor: the hash in force, empty while no ruleset is.
    fn cursor(&self) -> String {
        self.seen.clone().unwrap_or_default()
    }

    fn event(&self, told: Told) -> TopicEvent {
        match told {
            Told::Rules(changed) => TopicEvent::json("rules", Some(self.cursor()), &changed),
            Told::File(status) => TopicEvent::json("file", Some(self.cursor()), &status),
        }
    }
}

/// `firestore.rules` parameters.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RulesTopicParams {
    /// Database id; `(default)` when absent.
    database: Option<String>,
}

/// The live channel's `firestore.rules` topic: `rules` → [`RulesChanged`]
/// when what governs the database changes, `file` → [`RulesFileStatus`]
/// after every check of its file. The cursor is the hash in force: a
/// subscriber that comes back with another hash is told `rules` at once.
/// The file's status is sent on every open, resume or not, because a file
/// that broke while the subscriber was away installs nothing and so moves
/// no hash.
pub(crate) struct RulesTopic {
    editor: RulesEditor,
}

impl LiveTopic for RulesTopic {
    fn name(&self) -> &'static str {
        "firestore.rules"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: RulesTopicParams = topic_params(params)?;
        let database_id = params.database.unwrap_or_else(|| "(default)".to_owned());
        let database = self.editor.database(&database_id)?;
        // Subscribe before reading what is in force, so no change falls
        // between the two.
        let receiver = self.editor.rules.subscribe();
        let mut news = RulesNews::new(
            self.editor.rules.clone(),
            database,
            database_id,
            after.map(str::to_owned),
        );
        let mut first = Vec::new();
        match after {
            // A returning subscriber holding another hash is told at once.
            Some(_) => {
                if let Some(changed) = news.changed() {
                    first.push(news.event(Told::Rules(changed)));
                }
            }
            // A new one has just read the rules: it needs only the cursor.
            None => {
                news.seen = self
                    .editor
                    .rules
                    .current_version(&news.database)
                    .map(|version| version.hash);
            }
        }
        let file = news.file();
        first.push(news.event(Told::File(file)));
        let rest = BroadcastStream::new(receiver).flat_map(move |item| {
            let told = news.after(&item);
            stream::iter(
                told.into_iter()
                    .map(|told| news.event(told))
                    .collect::<Vec<_>>(),
            )
        });
        Ok(stream::iter(first).chain(rest).boxed())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode};
    use firenook_core_store::{DocumentKey, Fields, Store, Write};
    use tokio::sync::watch;
    use tower::ServiceExt as _;

    use super::*;

    const PROJECT: &str = "demo-rules";

    /// The bodies the console builds by hand are checked against these.
    #[test]
    fn export_rules_body_bindings() {
        let config = ts_rs::Config::new().with_out_dir(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../console/src/api/generated"
        ));
        WriteRules::export_all(&config).expect("TypeScript bindings written");
        CheckRules::export_all(&config).expect("TypeScript bindings written");
    }

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

    fn check(body: &serde_json::Value) -> Request<Body> {
        Request::post("/rules/check")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .expect("request")
    }

    fn get(uri: &str) -> Request<Body> {
        Request::get(uri).body(Body::empty()).expect("request")
    }

    /// The text between two UTF-16 offsets, as the browser editor slices it.
    fn utf16_slice(source: &str, from: &serde_json::Value, to: &serde_json::Value) -> String {
        let units = source.encode_utf16().collect::<Vec<_>>();
        let from = usize::try_from(from.as_u64().expect("from")).expect("fits");
        let to = usize::try_from(to.as_u64().expect("to")).expect("fits");
        String::from_utf16(&units[from..to]).expect("whole characters")
    }

    #[tokio::test]
    async fn the_rules_in_force_are_what_is_read_back() {
        let (_runtime, editor) = editor(None);
        let (status, body) = request(editor, get("/rules?database=(default)")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["enforced"], true);
        assert!(
            body["source"]
                .as_str()
                .is_some_and(|source| source.contains("allow read, write")),
            "{body}"
        );
        assert!(body["path"].is_null(), "no file is configured: {body}");
        assert_eq!(
            body["hash"],
            firenook_rules_runtime::source_hash(&allow(false))
        );
        assert!(body["fileSource"].is_null(), "{body}");
        assert_eq!(body["fileProblems"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn reading_shows_the_file_and_why_it_is_not_in_force() {
        let broken = "rules_version = '2';\n// é\nservice cloud.firestore { match";
        let file = TempRules::new(broken);
        let (runtime, editor) = editor(Some(&file.0));
        let error = firenook_rules_engine::compile(broken).expect_err("broken");
        runtime.set_file_problems(&database(), Some(LoadError { diagnostics: error }));
        let (status, body) = request(editor, get("/rules")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["fileSource"], broken);
        assert!(
            body["source"]
                .as_str()
                .is_some_and(|source| source.contains("if false")),
            "the rules in force are unchanged: {body}"
        );
        let problem = &body["fileProblems"][0];
        assert_eq!(problem["severity"], "error");
        assert!(problem["code"].is_null(), "{body}");
        assert_eq!(problem["line"], 3);
        // The é before it is two bytes but one UTF-16 unit, and positions
        // refer to `fileSource`.
        let expected = firenook_rules_engine::compile(broken).expect_err("broken")[0].byte_offset;
        assert_eq!(problem["from"], expected - 1);
        assert_eq!(problem["from"], problem["to"]);
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
        assert!(first["from"].is_u64(), "{body}");
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
        let (_, read) = request(editor, get("/rules")).await;
        assert_eq!(read["path"], file.0.display().to_string());
        assert_eq!(read["fileSource"], allow(true));
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
        for request_to in [
            get("/rules?database=has/a/slash"),
            get("/rules/history?database=has/a/slash"),
            check(&serde_json::json!({ "database": "has/a/slash", "source": allow(true) })),
        ] {
            let (status, _) = request(editor.clone(), request_to).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
        }
    }

    #[tokio::test]
    async fn a_ruleset_beyond_the_limit_is_refused_before_it_is_compiled() {
        let (_runtime, editor) = editor(None);
        let huge = "/".repeat(MAX_SOURCE_BYTES + 1);
        let (status, body) = request(editor.clone(), put(&huge, false)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("at most")),
            "{body}"
        );
        let (status, _) = request(editor, check(&serde_json::json!({ "source": huge }))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn a_check_of_broken_rules_answers_with_diagnostics_and_installs_nothing() {
        let (runtime, editor) = editor(None);
        let broken = "rules_version = '2';\n// 🔥\nservice cloud.firestore { match }";
        let (status, body) = request(editor, check(&serde_json::json!({ "source": broken }))).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["outline"].is_null(), "{body}");
        assert!(body["map"].is_null(), "{body}");
        let error = &body["diagnostics"][0];
        assert_eq!(error["severity"], "error");
        assert!(error["code"].is_null());
        // The 🔥 is four bytes but two UTF-16 units.
        let byte = broken.find('}').expect("the brace the error points at");
        assert_eq!(error["from"], byte - 2);
        assert_eq!(error["to"], error["from"]);
        assert!(
            runtime
                .rules_for(&database())
                .expect("rules")
                .source()
                .contains("if false"),
            "a check installs nothing"
        );
    }

    #[tokio::test]
    async fn a_check_returns_lints_an_outline_and_the_map_of_the_data() {
        let store = Store::default();
        let key = |path: &str| DocumentKey::new(database(), path).expect("key");
        store
            .commit(&[
                Write::Create {
                    key: key("users/u1"),
                    fields: Fields::new(),
                },
                Write::Create {
                    key: key("users/u1/orders/o1"),
                    fields: Fields::new(),
                },
                Write::Create {
                    key: key("products/p1"),
                    fields: Fields::new(),
                },
            ])
            .expect("seed");
        let schema = SchemaIndex::attach(&store, PROJECT);
        let (runtime, editor) = editor(None);
        let editor = editor.with_schema(&schema);
        let source = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    // Règles\n    match /users/{uid} {\n      allow read: if request.auth != null;\n      match /orders/{orderId} {\n        allow write: if request.auth.uid == uid;\n      }\n    }\n    match /usres/{uid} {\n      allow get: if false;\n    }\n  }\n}\n";
        let (status, body) = request(editor, check(&serde_json::json!({ "source": source }))).await;
        assert_eq!(status, StatusCode::OK, "{body}");

        let codes = body["diagnostics"]
            .as_array()
            .expect("diagnostics")
            .iter()
            .map(|lint| lint["code"].as_str().expect("a lint code"))
            .collect::<Vec<_>>();
        assert_eq!(codes, ["auth-only", "unvalidated-write"], "{body}");
        let auth_only = &body["diagnostics"][0];
        assert_eq!(auth_only["severity"], "warning");
        assert_eq!(
            utf16_slice(source, &auth_only["from"], &auth_only["to"]),
            "request.auth != null"
        );

        let outline = &body["outline"];
        assert_eq!(outline["rulesVersion"], 2);
        let users = &outline["matches"][0];
        assert_eq!(users["path"], "/users/{uid}");
        assert_eq!(users["depth"], 0);
        assert_eq!(
            utf16_slice(source, &users["from"], &users["to"]),
            "match /users/{uid}"
        );
        assert_eq!(
            users["allows"][0]["operations"],
            serde_json::json!(["get", "list"])
        );
        assert_eq!(users["allows"][0]["condition"], "request.auth != null");
        assert!(users["allows"][0]["always"].is_null());
        let orders = &outline["matches"][1];
        assert_eq!(orders["path"], "/users/{uid}/orders/{orderId}");
        assert_eq!(orders["depth"], 1);
        assert_eq!(
            orders["allows"][0]["operations"],
            serde_json::json!(["create", "update", "delete"])
        );
        assert_eq!(outline["matches"][2]["allows"][0]["always"], false);

        let map = &body["map"];
        let collections = map["collections"].as_array().expect("collections");
        let patterns = collections
            .iter()
            .map(|collection| collection["pattern"].as_str().expect("pattern"))
            .collect::<Vec<_>>();
        assert_eq!(patterns, ["products", "users", "users/*/orders"]);
        assert_eq!(collections[0]["uncovered"], true);
        assert_eq!(collections[0]["governedBy"], serde_json::json!([]));
        assert_eq!(collections[1]["uncovered"], false);
        assert_eq!(
            collections[1]["governedBy"],
            serde_json::json!([{ "line": 5, "path": "/users/{uid}", "operations": ["get", "list"] }])
        );
        assert_eq!(
            collections[2]["governedBy"][0]["path"],
            "/users/{uid}/orders/{orderId}"
        );
        assert_eq!(
            map["unusedMatches"],
            serde_json::json!([{ "line": 11, "path": "/usres/{uid}" }])
        );
        assert!(
            runtime
                .rules_for(&database())
                .expect("rules")
                .source()
                .contains("if false"),
            "a check installs nothing"
        );
    }

    #[tokio::test]
    async fn history_lists_what_governed_the_database_newest_first() {
        let (_runtime, editor) = editor(None);
        let (status, _) = request(editor.clone(), put(&allow(true), false)).await;
        assert_eq!(status, StatusCode::OK);
        // The same text again governs nothing new.
        let (status, _) = request(editor.clone(), put(&allow(true), false)).await;
        assert_eq!(status, StatusCode::OK);
        let (status, body) = request(editor, get("/rules/history?database=(default)")).await;
        assert_eq!(status, StatusCode::OK);
        let versions = body.as_array().expect("versions");
        let origins = versions
            .iter()
            .map(|version| version["origin"].as_str().expect("origin"))
            .collect::<Vec<_>>();
        assert_eq!(origins, ["console", "startup"], "{body}");
        assert_eq!(
            versions[0]["hash"],
            firenook_rules_runtime::source_hash(&allow(true))
        );
        assert_eq!(versions[0]["source"], allow(true));
        assert!(
            versions[0]["installedAt"]
                .as_str()
                .is_some_and(|at| time::OffsetDateTime::parse(at, &Rfc3339).is_ok()),
            "{body}"
        );
    }

    /// What the `firestore.rules` topic says next: name, cursor, data.
    async fn told(stream: &mut TopicStream) -> (&'static str, String, serde_json::Value) {
        match tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .expect("told something")
            .expect("the topic goes on")
        {
            TopicEvent::Event { name, cursor, data } => (
                name,
                cursor
                    .expect("every rules event carries the hash in force")
                    .to_string(),
                serde_json::from_str(&data).expect("json"),
            ),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_new_subscriber_is_told_the_files_status_with_the_hash_in_force() {
        let (_runtime, editor) = editor(None);
        let mut stream = editor
            .topic()
            .open(&serde_json::json!({}), None)
            .expect("opened");
        let (name, cursor, data) = told(&mut stream).await;
        assert_eq!(name, "file");
        assert_eq!(cursor, firenook_rules_runtime::source_hash(&allow(false)));
        assert_eq!(
            data,
            serde_json::json!({ "database": "(default)", "problems": [] })
        );
    }

    #[tokio::test]
    async fn a_returning_subscriber_with_another_hash_is_told_the_rules_changed_at_once() {
        let (runtime, editor) = editor(None);
        let old = firenook_rules_runtime::source_hash(&allow(false));
        runtime
            .install_database(&database(), &allow(true))
            .expect("install");
        let mut stream = editor
            .topic()
            .open(&serde_json::json!({ "database": "(default)" }), Some(&old))
            .expect("opened");
        let new = firenook_rules_runtime::source_hash(&allow(true));
        let (name, cursor, data) = told(&mut stream).await;
        assert_eq!(name, "rules");
        assert_eq!(cursor, new);
        assert_eq!(data["hash"], new);
        assert_eq!(data["database"], "(default)");
        let (name, cursor, _) = told(&mut stream).await;
        assert_eq!((name, cursor.as_str()), ("file", new.as_str()));
    }

    #[tokio::test]
    async fn a_file_that_broke_while_nobody_listened_is_told_on_resume() {
        let (runtime, editor) = editor(None);
        let hash = firenook_rules_runtime::source_hash(&allow(false));
        // The file stops compiling while the channel is down: nothing is
        // installed, so the hash a subscriber holds does not move.
        runtime.set_file_problems(&database(), Some(LoadError::unreadable("gone")));
        let mut stream = editor
            .topic()
            .open(&serde_json::json!({}), Some(&hash))
            .expect("opened");
        let (name, cursor, data) = told(&mut stream).await;
        assert_eq!(name, "file", "no rules event: the hash did not move");
        assert_eq!(cursor, hash);
        assert!(
            data["problems"][0]["message"]
                .as_str()
                .is_some_and(|message| message.contains("gone")),
            "{data}"
        );
    }

    #[tokio::test]
    async fn the_topic_tells_of_every_change_to_its_database_only() {
        let (runtime, editor) = editor(None);
        let mut stream = editor
            .topic()
            .open(&serde_json::json!({}), None)
            .expect("opened");
        assert_eq!(told(&mut stream).await.0, "file");
        let (status, _) = request(editor.clone(), put(&allow(true), false)).await;
        assert_eq!(status, StatusCode::OK);
        let (name, cursor, data) = told(&mut stream).await;
        assert_eq!(name, "rules");
        assert_eq!(cursor, firenook_rules_runtime::source_hash(&allow(true)));
        assert_eq!(data["origin"], "console");
        let other = DatabaseName::new(PROJECT, "other").expect("database");
        runtime
            .install_database(&other, &allow(false))
            .expect("other");
        runtime.set_file_problems(&database(), Some(LoadError::unreadable("broken")));
        let (name, _, data) = told(&mut stream).await;
        assert_eq!(name, "file", "another database's install says nothing here");
        assert!(data["problems"].to_string().contains("broken"));
    }

    #[test]
    fn the_topic_refuses_a_bad_database_or_parameter() {
        let (_runtime, editor) = editor(None);
        for params in [
            serde_json::json!({ "database": "has/a/slash" }),
            serde_json::json!({ "databse": "(default)" }),
        ] {
            let error = editor.topic().open(&params, None).err().expect("refused");
            assert_eq!(
                error.detail().code,
                crate::ErrorCode::InvalidArgument,
                "{params}"
            );
        }
    }

    #[tokio::test]
    async fn a_reload_that_now_governs_the_database_is_told_with_its_origin() {
        let (runtime, editor) = editor(None);
        let mut stream = editor
            .topic()
            .open(&serde_json::json!({ "database": "(default)" }), None)
            .expect("opened");
        assert_eq!(told(&mut stream).await.0, "file");
        let reloaded = allow(false).replace("false", "1 == 1");
        runtime.install_project(PROJECT, &reloaded).expect("reload");
        let (name, cursor, data) = told(&mut stream).await;
        assert_eq!(name, "rules");
        assert_eq!(cursor, firenook_rules_runtime::source_hash(&reloaded));
        assert_eq!(data["origin"], "reload");
        // Installing the same text again moves no hash: nothing to tell.
        runtime
            .install_project(PROJECT, &reloaded)
            .expect("reload again");
        runtime.set_file_problems(&database(), Some(LoadError::unreadable("gone")));
        let (name, _, data) = told(&mut stream).await;
        assert_eq!(name, "file", "{data}");
    }

    #[tokio::test]
    async fn the_rules_badge_counts_configured_databases_whose_file_does_not_compile() {
        let runtime = RulesRuntime::default();
        let orders = DatabaseName::new(PROJECT, "orders").expect("database");
        let editor = RulesEditor::new(
            &runtime,
            PROJECT,
            BTreeMap::from([
                ("(default)".to_owned(), PathBuf::from("firestore.rules")),
                ("orders".to_owned(), PathBuf::from("orders.rules")),
            ]),
        );
        let board = crate::live::badges::BadgeBoard::default();
        let mut changes = board.subscribe();
        let (stop, shutdown) = watch::channel(false);
        editor.spawn_badge(
            board.handle(
                "firestore.rules",
                crate::live::badges::BadgeKind::Gauge,
                crate::live::badges::BadgeNoun::new(
                    "rules file does not compile",
                    "rules files do not compile",
                ),
            ),
            Shutdown::new(shutdown),
        );
        let badge = |board: &crate::live::badges::BadgeBoard| {
            let set = board.snapshot();
            (set.badges[0].count, set.badges[0].tone)
        };
        assert_eq!(badge(&board), (0, BadgeTone::Neutral));
        let mut wait_for = async |expected: (u64, BadgeTone)| {
            tokio::time::timeout(Duration::from_secs(5), async {
                while badge(&board) != expected {
                    changes.changed().await.expect("board open");
                }
            })
            .await
            .unwrap_or_else(|_| panic!("the badge never read {expected:?}: {:?}", badge(&board)));
        };
        runtime.set_file_problems(&database(), Some(LoadError::unreadable("broken")));
        wait_for((1, BadgeTone::Danger)).await;
        runtime.set_file_problems(&orders, Some(LoadError::unreadable("broken")));
        wait_for((2, BadgeTone::Danger)).await;
        // A database the configuration names no file for is not counted.
        let other = DatabaseName::new(PROJECT, "other").expect("database");
        runtime.set_file_problems(&other, Some(LoadError::unreadable("broken")));
        runtime.set_file_problems(&database(), None);
        runtime.set_file_problems(&orders, None);
        wait_for((0, BadgeTone::Neutral)).await;
        stop.send(true).expect("stopped");
    }
}
