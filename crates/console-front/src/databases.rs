//! The project's Firestore databases as the console lists them. Two sources
//! meet here: `firebase.json`, which may declare named databases with rules
//! and indexes of their own, and the store, because a client that opens
//! `getFirestore(app, 'analytics')` and writes brings a database into being
//! with no configuration at all. `(default)` is always listed: it is the
//! database every client addresses unless told otherwise.

use std::collections::BTreeSet;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::State;
use firenook_core_store::Store;
use serde::Serialize;
use ts_rs::TS;

/// The database a client addresses when it names none.
const DEFAULT_DATABASE: &str = "(default)";

/// The project's databases: `(default)` first, the rest in id order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseList {
    pub databases: Vec<DatabaseInfo>,
}

/// One Firestore database of the project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    /// Database id, for example `(default)` or `analytics`.
    pub id: String,
    /// Whether `firebase.json` declares it, with rules and indexes of its
    /// own. A database nothing declares exists because a client wrote to
    /// it, and is served with the project's rules.
    pub declared: bool,
}

/// Lists the databases of one project from what is declared and what is
/// stored.
#[derive(Clone)]
pub struct DatabaseCatalog {
    store: Store,
    project: Arc<str>,
    declared: Arc<[String]>,
}

impl DatabaseCatalog {
    /// A catalog over `project`'s store; `declared` are the ids
    /// `firebase.json` names.
    #[must_use]
    pub fn new(store: &Store, project: &str, declared: impl IntoIterator<Item = String>) -> Self {
        Self {
            store: store.clone(),
            project: Arc::from(project),
            declared: declared.into_iter().collect(),
        }
    }

    /// The databases now: every declared one and every one holding a
    /// document, `(default)` first and the rest in id order.
    #[must_use]
    pub fn list(&self) -> DatabaseList {
        let mut ids: BTreeSet<String> = self.declared.iter().cloned().collect();
        ids.insert(DEFAULT_DATABASE.to_owned());
        ids.extend(
            self.store
                .snapshot()
                .databases(&self.project)
                .into_iter()
                .map(|database| database.database_id().to_owned()),
        );
        let mut databases: Vec<DatabaseInfo> = ids
            .into_iter()
            .map(|id| DatabaseInfo {
                declared: self.declared.contains(&id),
                id,
            })
            .collect();
        // The set is in id order; a stable sort only moves `(default)` up.
        databases.sort_by_key(|database| database.id != DEFAULT_DATABASE);
        DatabaseList { databases }
    }

    pub(crate) fn router(self) -> Router {
        Router::new()
            .route("/databases", axum::routing::get(databases))
            .with_state(self)
    }
}

/// `GET /databases`: the project's databases.
async fn databases(State(catalog): State<DatabaseCatalog>) -> Json<DatabaseList> {
    // The disk store seeks once per database inside a read transaction,
    // which is I/O the async runtime should not wait on.
    let listed = tokio::task::spawn_blocking(move || catalog.list())
        .await
        .unwrap_or_else(|_| DatabaseList {
            databases: vec![DatabaseInfo {
                id: DEFAULT_DATABASE.to_owned(),
                declared: false,
            }],
        });
    Json(listed)
}

#[cfg(test)]
mod tests {
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use firenook_core_store::{DatabaseName, DocumentKey, Fields, Write};
    use tower::ServiceExt as _;

    use super::*;

    const PROJECT: &str = "demo-databases";

    fn create(database: &str, path: &str) -> Write {
        Write::Create {
            key: DocumentKey::new(DatabaseName::new(PROJECT, database).expect("name"), path)
                .expect("path"),
            fields: Fields::new(),
        }
    }

    fn ids(list: &DatabaseList) -> Vec<(&str, bool)> {
        list.databases
            .iter()
            .map(|database| (database.id.as_str(), database.declared))
            .collect()
    }

    #[test]
    fn the_default_database_is_listed_before_anything_exists() {
        let store = Store::default();
        let catalog = DatabaseCatalog::new(&store, PROJECT, []);
        assert_eq!(ids(&catalog.list()), vec![("(default)", false)]);
    }

    #[test]
    fn declared_and_written_databases_meet_with_the_default_first() {
        let store = Store::default();
        store
            .commit(&[
                create("zeta", "items/i1"),
                create("(default)", "users/u1"),
                create("analytics", "events/e1"),
            ])
            .expect("commit");
        let catalog = DatabaseCatalog::new(
            &store,
            PROJECT,
            ["eu-data".to_owned(), "(default)".to_owned()],
        );
        assert_eq!(
            ids(&catalog.list()),
            vec![
                ("(default)", true),
                ("analytics", false),
                ("eu-data", true),
                ("zeta", false),
            ]
        );
    }

    #[test]
    fn another_project_s_databases_stay_out() {
        let store = Store::default();
        store
            .commit(&[Write::Create {
                key: DocumentKey::new(
                    DatabaseName::new("someone-else", "theirs").expect("name"),
                    "items/i1",
                )
                .expect("path"),
                fields: Fields::new(),
            }])
            .expect("commit");
        let catalog = DatabaseCatalog::new(&store, PROJECT, []);
        assert_eq!(ids(&catalog.list()), vec![("(default)", false)]);
    }

    #[tokio::test]
    async fn the_route_answers_the_list_as_json() {
        let store = Store::default();
        store
            .commit(&[create("analytics", "events/e1")])
            .expect("commit");
        let router = DatabaseCatalog::new(&store, PROJECT, []).router();
        let response = router
            .oneshot(
                Request::get("/databases")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let listed: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(
            listed,
            serde_json::json!({
                "databases": [
                    { "id": "(default)", "declared": false },
                    { "id": "analytics", "declared": false },
                ]
            })
        );
    }
}
