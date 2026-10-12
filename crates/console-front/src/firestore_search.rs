//! Firestore's part of ⌘K: collections and documents.
//!
//! Collections come from the schema index when a console has already built
//! it for a database (patterns such as `users/*/orders`, with their document
//! counts). While it is not built — a fresh engine nobody has opened
//! Firestore on; the index walks every key the first time a console asks —
//! the root collections come from the store by one skip-scan seek per
//! collection, without counts: a search never starts that walk. A text that
//! is a document path (an even number of segments) is also read exactly in
//! each database.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};

use firenook_core_store::{DatabaseName, DocumentKey, Snapshot};

use crate::databases::DatabaseCatalog;
use crate::schema::{SchemaIndex, SchemaNode};
use crate::search::{SEARCH_BUDGET, SearchHit, SearchSource, SourceHits, match_rank};

/// The database a client addresses when it names none.
const DEFAULT_DATABASE: &str = "(default)";
/// How often a walk looks at its cancel flag.
const CANCEL_EVERY: usize = 256;

/// Firestore's search source.
pub(crate) struct FirestoreSearch {
    schema: SchemaIndex,
    databases: DatabaseCatalog,
}

impl FirestoreSearch {
    pub(crate) const fn new(schema: SchemaIndex, databases: DatabaseCatalog) -> Self {
        Self { schema, databases }
    }

    /// The databases searched: `(default)`, every declared one and every one
    /// the schema index holds. Listing every database the store holds
    /// would read every key in memory mode, which a keystroke must not cost.
    fn databases(&self) -> Vec<String> {
        let mut ids: BTreeSet<String> = self.databases.declared().iter().cloned().collect();
        ids.extend(self.schema.indexed_databases());
        ids.remove(DEFAULT_DATABASE);
        std::iter::once(DEFAULT_DATABASE.to_owned())
            .chain(ids)
            .collect()
    }
}

/// One candidate hit with what orders it: kind (documents first), match
/// rank, depth, then the database's place and the text.
struct Ranked {
    order: (u8, u8, usize, usize, String),
    hit: SearchHit,
}

/// `<database>|<path or pattern>`: a database id never contains `|`.
fn entity_key(database: &str, path: &str) -> String {
    format!("{database}|{path}")
}

/// "1 document", "1,234 documents".
fn documents(count: u64) -> String {
    let digits = count.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    if count == 1 {
        "1 document".to_owned()
    } else {
        format!("{grouped} documents")
    }
}

/// The detail line, naming the database when it is not the default one.
fn in_database(detail: Option<String>, database: &str) -> Option<String> {
    if database == DEFAULT_DATABASE {
        return detail;
    }
    Some(match detail {
        Some(detail) => format!("{detail} · {database}"),
        None => database.to_owned(),
    })
}

/// A path of collection and document ids, alternating, ending on a
/// document.
fn is_document_path(path: &str) -> bool {
    let segments = path.split('/').count();
    segments >= 2
        && segments.is_multiple_of(2)
        && path.split('/').all(|segment| !segment.is_empty())
}

impl FirestoreSearch {
    /// The document at `path` in each database where it exists.
    fn documents_at(
        &self,
        path: &str,
        databases: &[String],
        snapshot: &Snapshot,
        cancel: &AtomicBool,
        found: &mut Vec<Ranked>,
    ) -> bool {
        for (place, database) in databases.iter().enumerate() {
            if cancel.load(Ordering::Acquire) {
                return false;
            }
            let Ok(name) = DatabaseName::new(self.schema.project(), database.as_str()) else {
                continue;
            };
            let Ok(key) = DocumentKey::new(name, path) else {
                continue;
            };
            if let Some(document) = snapshot.get(&key) {
                let fields = document.fields().len();
                let detail = if fields == 1 {
                    "Document · 1 field".to_owned()
                } else {
                    format!("Document · {fields} fields")
                };
                found.push(Ranked {
                    order: (0, 0, 0, place, path.to_owned()),
                    hit: SearchHit {
                        kind: "firestore.document".to_owned(),
                        key: entity_key(database, path),
                        title: path.to_owned(),
                        detail: in_database(Some(detail), database),
                    },
                });
            }
        }
        true
    }

    /// The collections matching `lower` in each database: the index's
    /// patterns when it is built, else the root collections by skip-scan.
    /// `false` when the budget or the cancel flag stopped it.
    fn collections(
        &self,
        lower: &str,
        databases: &[String],
        snapshot: &Snapshot,
        cancel: &AtomicBool,
        found: &mut Vec<Ranked>,
    ) -> bool {
        let by_pattern = lower.contains('/');
        let mut examined = 0_usize;
        for (place, database) in databases.iter().enumerate() {
            if cancel.load(Ordering::Acquire) {
                return false;
            }
            if let Some(tree) = self.schema.snapshot_if_ready(database) {
                let mut stack: Vec<(&SchemaNode, usize)> = tree
                    .collections
                    .iter()
                    .rev()
                    .map(|node| (node, 0))
                    .collect();
                while let Some((node, depth)) = stack.pop() {
                    examined += 1;
                    if examined > SEARCH_BUDGET
                        || (examined.is_multiple_of(CANCEL_EVERY) && cancel.load(Ordering::Acquire))
                    {
                        return false;
                    }
                    let rank = match_rank(&node.id, lower).or_else(|| {
                        by_pattern
                            .then(|| match_rank(&node.pattern, lower))
                            .flatten()
                    });
                    if let Some(rank) = rank {
                        found.push(Ranked {
                            order: (1, rank, depth, place, node.pattern.clone()),
                            hit: SearchHit {
                                kind: "firestore.collection".to_owned(),
                                key: entity_key(database, &node.pattern),
                                title: node.pattern.clone(),
                                detail: in_database(Some(documents(node.documents)), database),
                            },
                        });
                    }
                    stack.extend(node.children.iter().rev().map(|child| (child, depth + 1)));
                }
                continue;
            }
            let Ok(name) = DatabaseName::new(self.schema.project(), database.as_str()) else {
                continue;
            };
            for id in snapshot.direct_collection_ids(&name, None) {
                examined += 1;
                if examined > SEARCH_BUDGET {
                    return false;
                }
                if let Some(rank) = match_rank(&id, lower) {
                    found.push(Ranked {
                        order: (1, rank, 0, place, id.clone()),
                        hit: SearchHit {
                            kind: "firestore.collection".to_owned(),
                            key: entity_key(database, &id),
                            detail: in_database(None, database),
                            title: id,
                        },
                    });
                }
            }
        }
        true
    }
}

impl SearchSource for FirestoreSearch {
    fn section(&self) -> &'static str {
        "firestore"
    }

    fn search(&self, text: &str, limit: usize, cancel: &AtomicBool) -> SourceHits {
        let lower = text.to_lowercase();
        let databases = self.databases();
        let snapshot = self.schema.store().snapshot();
        let mut found: Vec<Ranked> = Vec::new();
        let path = text.trim_matches('/');
        let mut complete = true;
        if is_document_path(path) {
            complete = self.documents_at(path, &databases, &snapshot, cancel, &mut found);
        }
        if complete {
            complete = self.collections(&lower, &databases, &snapshot, cancel, &mut found);
        }
        found.sort_by(|left, right| left.order.cmp(&right.order));
        SourceHits {
            hits: found
                .into_iter()
                .take(limit)
                .map(|ranked| ranked.hit)
                .collect(),
            partial: !complete,
        }
    }
}

#[cfg(test)]
mod tests {
    use firenook_core_store::{Store, Value, Write};

    use super::*;

    const PROJECT: &str = "demo-search";

    fn put(store: &Store, database: &str, path: &str) {
        let key =
            DocumentKey::new(DatabaseName::new(PROJECT, database).expect("db"), path).expect("key");
        store
            .commit(&[Write::Create {
                key,
                fields: [("n".to_owned(), Value::Integer(1))].into_iter().collect(),
            }])
            .expect("committed");
    }

    fn search(source: &FirestoreSearch, text: &str) -> SourceHits {
        source.search(text, 10, &AtomicBool::new(false))
    }

    fn titles(found: &SourceHits) -> Vec<(&str, &str, Option<&str>)> {
        found
            .hits
            .iter()
            .map(|hit| (hit.kind.as_str(), hit.key.as_str(), hit.detail.as_deref()))
            .collect()
    }

    #[tokio::test]
    async fn before_the_index_exists_root_collections_come_from_the_store_and_no_walk_starts() {
        let store = Store::default();
        put(&store, "(default)", "users/u_1");
        put(&store, "(default)", "users/u_1/orders/o_1");
        put(&store, "(default)", "userGroups/g_1");
        put(&store, "(default)", "products/p_1");
        let schema = SchemaIndex::attach(&store, PROJECT);
        let source = FirestoreSearch::new(
            schema.clone(),
            DatabaseCatalog::new(&store, PROJECT, Vec::new()),
        );
        let found = search(&source, "user");
        assert_eq!(
            titles(&found),
            [
                ("firestore.collection", "(default)|userGroups", None),
                ("firestore.collection", "(default)|users", None),
            ]
        );
        assert!(!found.partial);
        // Nested collections are not listed without the index, and the
        // search did not start its walk.
        assert_eq!(search(&source, "orders").hits, []);
        assert!(schema.snapshot_if_ready("(default)").is_none());
        assert_eq!(schema.indexed_databases(), Vec::<String>::new());
        // Once a console built the index, patterns come with their counts.
        let _ = schema.snapshot("(default)").await.expect("built");
        let found = search(&source, "orders");
        assert_eq!(
            titles(&found),
            [(
                "firestore.collection",
                "(default)|users/*/orders",
                Some("1 document")
            )]
        );
        assert_eq!(found.hits[0].title, "users/*/orders");
        // Exact before prefix before substring.
        let found = search(&source, "users");
        assert_eq!(found.hits[0].key, "(default)|users");
        let found = search(&source, "users/*/o");
        assert_eq!(found.hits[0].key, "(default)|users/*/orders");
    }

    #[tokio::test]
    async fn a_document_path_is_read_exactly_in_each_database() {
        let store = Store::default();
        put(&store, "(default)", "users/u_1");
        put(&store, "analytics", "users/u_1");
        let schema = SchemaIndex::attach(&store, PROJECT);
        let _ = schema.snapshot("analytics").await.expect("built");
        let source =
            FirestoreSearch::new(schema, DatabaseCatalog::new(&store, PROJECT, Vec::new()));
        let found = search(&source, "/users/u_1");
        assert_eq!(
            titles(&found)[..2],
            [
                (
                    "firestore.document",
                    "(default)|users/u_1",
                    Some("Document · 1 field")
                ),
                (
                    "firestore.document",
                    "analytics|users/u_1",
                    Some("Document · 1 field · analytics")
                ),
            ]
        );
        assert_eq!(search(&source, "users/u_2").hits, []);
    }

    #[test]
    fn a_cancelled_search_says_partial() {
        let store = Store::default();
        put(&store, "(default)", "users/u_1");
        let source = FirestoreSearch::new(
            SchemaIndex::attach(&store, PROJECT),
            DatabaseCatalog::new(&store, PROJECT, Vec::new()),
        );
        let found = source.search("users", 10, &AtomicBool::new(true));
        assert!(found.partial);
        assert_eq!(found.hits, []);
    }

    #[test]
    fn counts_are_grouped() {
        assert_eq!(documents(1), "1 document");
        assert_eq!(documents(0), "0 documents");
        assert_eq!(documents(1_234), "1,234 documents");
        assert_eq!(documents(1_234_567), "1,234,567 documents");
        assert!(is_document_path("users/u_1"));
        assert!(!is_document_path("users"));
        assert!(!is_document_path("users//x/y"));
    }
}
