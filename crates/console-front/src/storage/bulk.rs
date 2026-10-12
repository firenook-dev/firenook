//! `POST /storage/objects:delete | :move | :copy | :metadata`: bulk work as
//! the console's jobs. A dry run answers the counts the dialog shows; a run
//! starts a job whose work is storage-front's batches, reporting progress,
//! skips and each refused item's explanation through the job.

use std::sync::atomic::{AtomicU64, Ordering};

use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use firenook_storage_front::{
    BulkPreview, BulkProgress, BulkRequest, BulkSource, BulkVerb, ConflictPolicy, ConsoleRefusal,
    Destination,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::StorageRoutes;
use super::files::{StorageMetadataPatch, identity, via_console};
use super::filter_fields::{STORAGE_FILTER_FIELDS, storage_filter};
use super::rules::{
    StorageEvaluateRequest, StorageEvaluateResult, evaluate_request, evaluate_result,
};
use crate::api_error::ApiError;
use crate::blocking::blocking;
use crate::jobs::{BulkTarget, JobHandle, accepted};
use crate::json::ConsoleJson;

/// `POST /storage/objects:<verb>`. The verb is the route.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "storage/")]
pub(crate) struct StorageBulkBody {
    /// The bucket the keys name objects in.
    pub bucket: String,
    /// Object names, one ending in `/` meaning everything under that folder
    /// (at most 10,000); or everything a listing matches, its scope the
    /// listing's own params as JSON (bucket, prefix, flat).
    pub target: BulkTarget,
    /// Move and copy: where to.
    #[serde(default)]
    #[ts(optional)]
    pub destination: Option<StorageDestination>,
    /// Move or copy one file (or one folder) to this exact name.
    #[serde(default)]
    #[ts(optional)]
    pub rename_to: Option<String>,
    /// Metadata: the patch applied to every item.
    #[serde(default)]
    #[ts(optional)]
    pub metadata: Option<StorageMetadataPatch>,
    #[serde(default)]
    pub on_conflict: StorageConflictPolicy,
    /// Answer with a preview and change nothing.
    #[serde(default)]
    pub dry_run: bool,
}

/// A move's or copy's destination folder.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "storage/")]
pub(crate) struct StorageDestination {
    pub bucket: String,
    /// Empty for the bucket root, else ending in `/`.
    pub prefix: String,
}

/// What a taken destination name does.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "storage/")]
pub(crate) enum StorageConflictPolicy {
    /// Leave it; the item counts as skipped.
    #[default]
    Skip,
    Replace,
    /// The item counts as failed.
    Fail,
}

/// What a bulk action would touch: the counts the dialogs show.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageBulkPreview {
    #[ts(type = "number")]
    pub objects: u64,
    #[ts(type = "number")]
    pub bytes: u64,
    /// Folders the target spans.
    #[ts(type = "number")]
    pub folders: u64,
    /// Move and copy: destination names already taken.
    #[ts(type = "number")]
    pub conflicts: u64,
    /// The first twelve taken names.
    pub conflict_sample: Vec<String>,
}

/// What a refused or failed item puts in the job error's `detail`, so "See
/// why" never needs the decision ring.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageBulkItemError {
    /// The decision id, when the log kept it.
    pub decision: Option<String>,
    /// The explained re-run of a refusal.
    pub evaluation: Option<StorageEvaluateResult>,
    /// The request, replayable in the playground.
    pub request: Option<StorageEvaluateRequest>,
}

/// A listing's scope as a bulk target names it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryScope {
    bucket: String,
    #[serde(default)]
    prefix: String,
    #[serde(default)]
    flat: bool,
}

/// What a target names, as storage-front reads it.
pub(crate) fn source(bucket: &str, target: &BulkTarget) -> Result<BulkSource, ApiError> {
    match target {
        BulkTarget::Keys { keys } => {
            if keys.is_empty() {
                return Err(ApiError::invalid("This action names no objects."));
            }
            Ok(BulkSource::Keys(keys.clone()))
        }
        BulkTarget::Query { q, scope } => {
            let scope: QueryScope = serde_json::from_value(scope.clone()).map_err(|error| {
                ApiError::invalid(format!(
                    "A query target's scope is the listing's params (bucket, prefix, flat): {error}."
                ))
            })?;
            if scope.bucket != bucket {
                return Err(ApiError::invalid(
                    "A query target's scope names another bucket than the action.",
                ));
            }
            if !(scope.prefix.is_empty() || scope.prefix.ends_with('/')) {
                return Err(ApiError::invalid("prefix must be empty or end with `/`."));
            }
            let filter = match q.trim() {
                "" => None,
                text => Some(storage_filter(
                    &STORAGE_FILTER_FIELDS.parse(text)?,
                    time::OffsetDateTime::now_utc(),
                )),
            };
            Ok(BulkSource::Query {
                prefix: scope.prefix,
                flat: scope.flat,
                filter,
            })
        }
    }
}

/// A job's handle as storage-front's progress.
struct JobProgress {
    handle: JobHandle,
    done: AtomicU64,
}

impl BulkProgress for JobProgress {
    fn done(&self, by: u64) {
        let done = self.done.fetch_add(by, Ordering::AcqRel) + by;
        self.handle.progress(done);
    }

    fn skipped(&self, by: u64) {
        if by > 0 {
            self.handle.skipped(by);
        }
    }

    fn failed(&self, name: &str, message: &str, refusal: Option<&ConsoleRefusal>) {
        match refusal {
            Some(refusal) => self.handle.failed_item_with(
                name,
                message,
                serde_json::to_value(StorageBulkItemError {
                    decision: refusal.decision.clone(),
                    evaluation: refusal.evaluation.as_ref().map(evaluate_result),
                    request: refusal.request.as_ref().map(evaluate_request),
                })
                .unwrap_or_default(),
            ),
            None => self.handle.failed_item(name, message),
        }
    }

    fn cancelled(&self) -> bool {
        self.handle.cancelled()
    }
}

/// `1,204`.
pub(crate) fn count(value: u64) -> String {
    let digits = value.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// `20 MB`.
pub(crate) fn size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    #[allow(
        clippy::cast_precision_loss,
        reason = "a size shown to one decimal place"
    )]
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else if value >= 10.0 {
        format!("{value:.0} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

fn files(count_of: u64) -> String {
    format!(
        "{} {}",
        count(count_of),
        if count_of == 1 { "file" } else { "files" }
    )
}

/// What the job is called: "Delete users/ · 900 files · 20 MB".
fn title(request: &BulkRequest, preview: &BulkPreview) -> String {
    let what = match &request.source {
        BulkSource::Keys(keys) if keys.len() == 1 => keys[0].clone(),
        BulkSource::Keys(_) => files(preview.objects),
        BulkSource::Query { prefix, .. } if prefix.is_empty() => format!("gs://{}", request.bucket),
        BulkSource::Query { prefix, .. } => prefix.clone(),
    };
    let figures = format!("{} · {}", files(preview.objects), size(preview.bytes));
    let target = request
        .rename_to
        .clone()
        .or_else(|| {
            request.destination.as_ref().map(|destination| {
                if destination.prefix.is_empty() {
                    format!("gs://{}", destination.bucket)
                } else {
                    destination.prefix.clone()
                }
            })
        })
        .unwrap_or_default();
    match request.verb {
        BulkVerb::Delete => format!("Delete {what} · {figures}"),
        BulkVerb::Move => format!("Move {what} to {target} · {figures}"),
        BulkVerb::Copy => format!("Copy {what} to {target} · {figures}"),
        BulkVerb::Metadata => format!("Change the metadata of {what} · {figures}"),
    }
}

async fn run(
    routes: StorageRoutes,
    headers: HeaderMap,
    verb: BulkVerb,
    body: StorageBulkBody,
) -> Result<Response, ApiError> {
    body.target.check()?;
    let request = BulkRequest {
        verb,
        source: source(&body.bucket, &body.target)?,
        bucket: body.bucket,
        destination: body.destination.map(|destination| Destination {
            bucket: destination.bucket,
            prefix: destination.prefix,
        }),
        rename_to: body.rename_to,
        metadata: body.metadata.as_ref().map(StorageMetadataPatch::engine),
        on_conflict: match body.on_conflict {
            StorageConflictPolicy::Skip => ConflictPolicy::Skip,
            StorageConflictPolicy::Replace => ConflictPolicy::Replace,
            StorageConflictPolicy::Fail => ConflictPolicy::Fail,
        },
        console: via_console(&headers),
    };
    let api = routes.api.clone();
    let previewed = request.clone();
    let preview = blocking(
        "the bulk preview",
        move || Ok(api.bulk_preview(&previewed)?),
    )
    .await?;
    if body.dry_run {
        return Ok(Json(StorageBulkPreview {
            objects: preview.objects,
            bytes: preview.bytes,
            folders: preview.folders,
            conflicts: preview.conflicts,
            conflict_sample: preview.conflict_sample,
        })
        .into_response());
    }
    let who = identity(&headers);
    let api = routes.api.clone();
    let job = routes.jobs.start(
        "storage",
        &format!("storage.{}", verb.name()),
        title(&request, &preview),
        Some(preview.objects),
        move |handle| {
            Box::pin(async move {
                let progress = JobProgress {
                    handle,
                    done: AtomicU64::new(0),
                };
                api.bulk(request, who, &progress)
                    .await
                    .map_err(ApiError::from)
            })
        },
    )?;
    Ok(accepted(job))
}

/// `POST /storage/objects:delete`.
pub(crate) async fn delete(
    State(routes): State<StorageRoutes>,
    headers: HeaderMap,
    ConsoleJson(body): ConsoleJson<StorageBulkBody>,
) -> Result<Response, ApiError> {
    run(routes, headers, BulkVerb::Delete, body).await
}

/// `POST /storage/objects:move`.
pub(crate) async fn relocate(
    State(routes): State<StorageRoutes>,
    headers: HeaderMap,
    ConsoleJson(body): ConsoleJson<StorageBulkBody>,
) -> Result<Response, ApiError> {
    run(routes, headers, BulkVerb::Move, body).await
}

/// `POST /storage/objects:copy`.
pub(crate) async fn copy(
    State(routes): State<StorageRoutes>,
    headers: HeaderMap,
    ConsoleJson(body): ConsoleJson<StorageBulkBody>,
) -> Result<Response, ApiError> {
    run(routes, headers, BulkVerb::Copy, body).await
}

/// `POST /storage/objects:metadata`.
pub(crate) async fn metadata(
    State(routes): State<StorageRoutes>,
    headers: HeaderMap,
    ConsoleJson(body): ConsoleJson<StorageBulkBody>,
) -> Result<Response, ApiError> {
    run(routes, headers, BulkVerb::Metadata, body).await
}
