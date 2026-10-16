//! ⌘K over Storage: objects by name across buckets and folders from the
//! built folder index, answered by storage-front within its budget.

use std::sync::atomic::AtomicBool;

use firenook_storage_front::{SearchKind, StorageConsoleApi};

use super::bulk::{count, size};
use crate::entity::EntityRef;
use crate::search::{SearchHit, SearchSource, SourceHits};

/// Storage's contribution to ⌘K.
pub(crate) struct StorageSearch(pub(crate) StorageConsoleApi);

impl SearchSource for StorageSearch {
    fn section(&self) -> &'static str {
        "storage"
    }

    fn search(&self, text: &str, limit: usize, cancel: &AtomicBool) -> SourceHits {
        let outcome = self.0.search(text, limit, cancel);
        SourceHits {
            hits: outcome
                .hits
                .into_iter()
                .map(|found| match found.kind {
                    SearchKind::Object => {
                        let entity = EntityRef::storage_object(&found.bucket, &found.key);
                        let mut detail = vec![size(found.bytes)];
                        detail.extend(found.content_type.clone());
                        detail.push(format!("gs://{}", found.bucket));
                        SearchHit {
                            kind: entity.kind,
                            key: entity.key,
                            title: found.key,
                            detail: Some(detail.join(" · ")),
                        }
                    }
                    SearchKind::Folder => {
                        let entity = EntityRef::storage_folder(&found.bucket, &found.key);
                        SearchHit {
                            kind: entity.kind,
                            key: entity.key,
                            title: found.key,
                            detail: Some(format!(
                                "{} {} · gs://{}",
                                count(found.objects),
                                if found.objects == 1 { "file" } else { "files" },
                                found.bucket
                            )),
                        }
                    }
                })
                .collect(),
            partial: outcome.partial,
        }
    }
}
