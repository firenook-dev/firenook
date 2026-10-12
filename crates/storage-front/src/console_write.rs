//! The console handle's write half: uploads, metadata, tokens, folders,
//! deletes, events sent again, upload sessions and clearing everything.
//!
//! Every write goes through the write path's own pieces under the mutation
//! guard, exactly as the protocol's do: a console upload mints a token,
//! meets the rules as the chosen identity and fires the `finalized` event
//! like an SDK upload, so the emulator never has a hidden write path.

use std::collections::BTreeMap;

use axum::body::Body;
use serde_json::{Map as JsonMap, Value as JsonValue, json};

use crate::bulk::{BulkProgress, MetadataPatch};
use crate::changes::{ChangeContext, EventDelivery};
use crate::console::{ConsoleError, Identity, ObjectView, StorageConsoleApi};
use crate::decisions::RulesCheck;
use crate::folder_index::FolderStats;
use crate::listing::is_marker;
use crate::rules::Operation;
use crate::sessions::{SessionCursor, SessionPage};
use crate::write::{self, Pending, TokenOp};
use crate::{CommitSpec, StorageEvent, lock, persist_state, stream_to_staging};

/// The most bytes a custom metadata header carries, decoded.
pub const METADATA_HEADER_BYTES: usize = 64 * 1024;

/// One console upload: where, with what metadata, and how a taken name and
/// the replaced object's tokens are treated.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConsoleUpload {
    pub bucket: String,
    pub name: String,
    /// `application/octet-stream` when absent.
    pub content_type: Option<String>,
    pub cache_control: Option<String>,
    pub content_disposition: Option<String>,
    pub content_encoding: Option<String>,
    pub content_language: Option<String>,
    pub custom_metadata: BTreeMap<String, String>,
    /// `If-None-Match: *`: refuse instead of replacing.
    pub if_none_match: bool,
    /// Keep the replaced object's download tokens (Admin only).
    pub keep_tokens: bool,
    /// The request carried `x-firenook-console`.
    pub console: bool,
}

/// The Storage events a change can produce, for [`StorageConsoleApi::resend`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResendEvent {
    Finalize,
    MetadataUpdate,
}

/// The v1 and v2 bodies one event of an object carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventBodies {
    pub v1: JsonValue,
    pub v2: JsonValue,
}

/// The Storage event bodies an object produces now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventPayloads {
    /// Functions is part of this suite, so sending one again means something.
    pub functions: bool,
    pub finalize: EventBodies,
    pub metadata_update: EventBodies,
    pub delete: EventBodies,
}

/// The `x-firenook-metadata` header's value: `b64.` and the base64url of
/// the JSON `{cacheControl, contentDisposition, contentEncoding,
/// contentLanguage, customMetadata}`, so a value with any character survives
/// a browser's header rules.
pub fn parse_metadata_header(value: &str) -> Result<ConsoleUpload, ConsoleError> {
    use base64::Engine as _;
    let refused = || {
        ConsoleError::Invalid("x-firenook-metadata must be b64.<base64url of the JSON>.".to_owned())
    };
    let encoded = value.trim().strip_prefix("b64.").ok_or_else(refused)?;
    if encoded.len() > METADATA_HEADER_BYTES * 4 / 3 + 4 {
        return Err(ConsoleError::TooLarge(
            "The metadata header is over 64 KB; send less custom metadata.".to_owned(),
        ));
    }
    let bytes = crate::URL_SAFE_NO_PAD
        .decode(encoded.trim_end_matches('='))
        .map_err(|_| refused())?;
    if bytes.len() > METADATA_HEADER_BYTES {
        return Err(ConsoleError::TooLarge(
            "The metadata header is over 64 KB; send less custom metadata.".to_owned(),
        ));
    }
    let JsonValue::Object(fields) =
        serde_json::from_slice::<JsonValue>(&bytes).map_err(|_| refused())?
    else {
        return Err(refused());
    };
    let text = |key: &str| -> Result<Option<String>, ConsoleError> {
        match fields.get(key) {
            None | Some(JsonValue::Null) => Ok(None),
            Some(JsonValue::String(value)) => Ok(Some(value.clone())),
            Some(_) => Err(ConsoleError::Invalid(format!(
                "x-firenook-metadata: {key} is a string."
            ))),
        }
    };
    let mut custom_metadata = BTreeMap::new();
    match fields.get("customMetadata") {
        None | Some(JsonValue::Null) => {}
        Some(JsonValue::Object(custom)) => {
            for (key, value) in custom {
                let JsonValue::String(value) = value else {
                    return Err(ConsoleError::Invalid(format!(
                        "x-firenook-metadata: customMetadata.{key} is a string."
                    )));
                };
                custom_metadata.insert(key.clone(), value.clone());
            }
        }
        Some(_) => {
            return Err(ConsoleError::Invalid(
                "x-firenook-metadata: customMetadata is an object of strings.".to_owned(),
            ));
        }
    }
    for key in fields.keys() {
        if !matches!(
            key.as_str(),
            "cacheControl"
                | "contentDisposition"
                | "contentEncoding"
                | "contentLanguage"
                | "customMetadata"
        ) {
            return Err(ConsoleError::Invalid(format!(
                "x-firenook-metadata: {key} is not a field it carries; use cacheControl, contentDisposition, contentEncoding, contentLanguage or customMetadata."
            )));
        }
    }
    Ok(ConsoleUpload {
        cache_control: text("cacheControl")?,
        content_disposition: text("contentDisposition")?,
        content_encoding: text("contentEncoding")?,
        content_language: text("contentLanguage")?,
        custom_metadata,
        ..ConsoleUpload::default()
    })
}

fn denied_admin_only(message: &str) -> ConsoleError {
    ConsoleError::Denied {
        message: message.to_owned(),
        fix: Some("Act as Admin to do this.".to_owned()),
        refusal: None,
        no_ruleset: false,
    }
}

fn internal(error: crate::StorageApiError) -> ConsoleError {
    ConsoleError::Internal(error.message)
}

/// A GCS object name the console accepts.
fn check_name(name: &str) -> Result<(), ConsoleError> {
    if name.is_empty() {
        return Err(ConsoleError::Invalid("The object needs a name.".to_owned()));
    }
    if name.len() > 1024 {
        return Err(ConsoleError::Invalid(format!(
            "An object name is at most 1,024 bytes; this one is {}.",
            name.len()
        )));
    }
    if name.contains(['\r', '\n']) {
        return Err(ConsoleError::Invalid(
            "An object name cannot contain a line break.".to_owned(),
        ));
    }
    if name == "." || name == ".." {
        return Err(ConsoleError::Invalid(
            "An object cannot be named . or ..".to_owned(),
        ));
    }
    Ok(())
}

impl StorageConsoleApi {
    /// A streaming upload through the commit path: staged as the bytes
    /// arrive, judged as `create` for a client once staged, committed with
    /// a minted token (or, Admin only, the replaced object's tokens) and a
    /// `finalized` event, as an SDK upload is.
    pub async fn upload(
        &self,
        spec: ConsoleUpload,
        body: Body,
        who: &Identity,
    ) -> Result<ObjectView, ConsoleError> {
        check_name(&spec.name)?;
        if spec.keep_tokens && *who != Identity::Admin {
            return Err(denied_admin_only(
                "Only the Admin SDK can keep download tokens on a replacement.",
            ));
        }
        let state = self.state_ref();
        let uploaded = stream_to_staging(state, &spec.bucket, body)
            .await
            .map_err(|error| ConsoleError::Invalid(error.message))?;
        let guard = state.mutation.lock().await;
        if spec.if_none_match && self.stored(&spec.bucket, &spec.name).is_some() {
            return Err(ConsoleError::AlreadyExists(format!(
                "{} already exists.",
                spec.name
            )));
        }
        let mut object_metadata = JsonMap::new();
        for (field, value) in [
            ("cacheControl", &spec.cache_control),
            ("contentDisposition", &spec.content_disposition),
            ("contentEncoding", &spec.content_encoding),
            ("contentLanguage", &spec.content_language),
        ] {
            if let Some(value) = value {
                object_metadata.insert(field.to_owned(), json!(value));
            }
        }
        let object_metadata = JsonValue::Object(object_metadata);
        let commit_spec = CommitSpec {
            bucket: &spec.bucket,
            name: &spec.name,
            content_type: spec
                .content_type
                .as_deref()
                .unwrap_or("application/octet-stream"),
            metadata: spec.custom_metadata.clone(),
            object_metadata: &object_metadata,
            authorization: who.authorization(),
            firebase: true,
            console: spec.console,
            keep_tokens: spec.keep_tokens,
        };
        let commit = write::prepare_commit(state, &guard, &commit_spec, &uploaded);
        let decision = match self.judge(
            who,
            &RulesCheck {
                bucket: &spec.bucket,
                name: &spec.name,
                operation: Operation::Create,
                before: commit.before.as_ref(),
                after: Some(&commit.object),
                authorization: who.authorization(),
                console: spec.console,
            },
        ) {
            Ok(decision) => decision,
            Err(error) => {
                uploaded.staged.discard();
                return Err(error);
            }
        };
        let mut pending = Pending::default();
        let object = write::commit_locked(
            state,
            &guard,
            &mut pending,
            commit,
            uploaded,
            &ChangeContext::from_authorization(who.authorization(), spec.console),
        )
        .await
        .map_err(internal)?;
        pending.commit(state).await.map_err(internal)?;
        drop(guard);
        pending.dispatch(state);
        let mut view = ObjectView::of(&object, *who == Identity::Admin);
        view.decision = decision;
        Ok(view)
    }

    /// Changes an object's metadata with patch semantics, judged as
    /// `update` for a client; refused with the current metageneration when
    /// `if_metageneration` is no longer it.
    pub async fn update_metadata(
        &self,
        bucket: &str,
        name: &str,
        patch: &MetadataPatch,
        if_metageneration: Option<u64>,
        who: &Identity,
        console: bool,
    ) -> Result<ObjectView, ConsoleError> {
        let state = self.state_ref();
        let request = patch.to_json();
        let guard = state.mutation.lock().await;
        let stored = self.stored(bucket, name);
        let proposed = stored
            .as_ref()
            .map(|before| write::proposed_metadata(before, &request));
        let decision = self.judge(
            who,
            &RulesCheck {
                bucket,
                name,
                operation: Operation::Update,
                before: stored.as_ref(),
                after: proposed.as_ref(),
                authorization: who.authorization(),
                console,
            },
        )?;
        let object = stored
            .ok_or_else(|| ConsoleError::NotFound(format!("No object {name} in gs://{bucket}.")))?;
        if let Some(expected) = if_metageneration
            && expected != object.metageneration
        {
            return Err(ConsoleError::Precondition {
                message: format!(
                    "This file changed since you opened it (metageneration {}, you had {expected}).",
                    object.metageneration
                ),
                current: object.metageneration,
            });
        }
        let mut pending = Pending::default();
        let object = write::update_metadata_locked(
            state,
            &guard,
            &mut pending,
            object,
            &request,
            &ChangeContext::from_authorization(who.authorization(), console),
        );
        pending.commit(state).await.map_err(internal)?;
        drop(guard);
        pending.dispatch(state);
        let mut view = ObjectView::of(&object, *who == Identity::Admin);
        view.decision = decision;
        Ok(view)
    }

    /// Creates or revokes a download token: Admin only, as the official API
    /// has it. Either moves the metageneration and sends `metadataUpdated`.
    pub async fn token(
        &self,
        bucket: &str,
        name: &str,
        op: &TokenOp,
        who: &Identity,
        console: bool,
    ) -> Result<ObjectView, ConsoleError> {
        if *who != Identity::Admin {
            return Err(denied_admin_only(
                "Only the Admin SDK can create or revoke download tokens.",
            ));
        }
        let state = self.state_ref();
        let guard = state.mutation.lock().await;
        let object = self
            .stored(bucket, name)
            .ok_or_else(|| ConsoleError::NotFound(format!("No object {name} in gs://{bucket}.")))?;
        if let TokenOp::Revoke(token) = op
            && !object.download_tokens.contains(token)
        {
            return Err(ConsoleError::NotFound(
                "This object has no such download token.".to_owned(),
            ));
        }
        let mut pending = Pending::default();
        let object = write::token_locked(
            state,
            &guard,
            &mut pending,
            object,
            op,
            &ChangeContext::from_authorization(who.authorization(), console),
        );
        pending.commit(state).await.map_err(internal)?;
        drop(guard);
        pending.dispatch(state);
        Ok(ObjectView::of(&object, true))
    }

    /// Creates the zero-byte marker the official UI creates for a folder
    /// (`prefix` ending in `/`), judged as `create` for a client.
    pub async fn create_folder(
        &self,
        bucket: &str,
        prefix: &str,
        who: &Identity,
        console: bool,
    ) -> Result<(String, Option<FolderStats>), ConsoleError> {
        check_name(prefix)?;
        if !prefix.ends_with('/') {
            return Err(ConsoleError::Invalid(
                "A folder's name ends with `/`.".to_owned(),
            ));
        }
        let segment = prefix
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("");
        if segment.len() > 252 {
            return Err(ConsoleError::Invalid(
                "A folder name is at most 252 bytes.".to_owned(),
            ));
        }
        let state = self.state_ref();
        let staged = crate::write_staged(state, bucket, &[])
            .await
            .map_err(internal)?;
        let uploaded = crate::summarize_file(staged).await.map_err(internal)?;
        let guard = state.mutation.lock().await;
        if self.stored(bucket, prefix).is_some() {
            return Err(ConsoleError::AlreadyExists(format!(
                "{prefix} already exists."
            )));
        }
        let commit_spec = CommitSpec {
            bucket,
            name: prefix,
            content_type: "text/plain",
            metadata: BTreeMap::new(),
            object_metadata: &JsonValue::Null,
            authorization: who.authorization(),
            firebase: false,
            console,
            keep_tokens: false,
        };
        let commit = write::prepare_commit(state, &guard, &commit_spec, &uploaded);
        if let Err(error) = self.judge(
            who,
            &RulesCheck {
                bucket,
                name: prefix,
                operation: Operation::Create,
                before: None,
                after: Some(&commit.object),
                authorization: who.authorization(),
                console,
            },
        ) {
            uploaded.staged.discard();
            return Err(error);
        }
        let mut pending = Pending::default();
        write::commit_locked(
            state,
            &guard,
            &mut pending,
            commit,
            uploaded,
            &ChangeContext::from_authorization(who.authorization(), console),
        )
        .await
        .map_err(internal)?;
        pending.commit(state).await.map_err(internal)?;
        drop(guard);
        pending.dispatch(state);
        Ok((prefix.to_owned(), self.folder(bucket, prefix)))
    }

    /// Deletes one object, judged as `delete` for a client.
    pub async fn delete(
        &self,
        bucket: &str,
        name: &str,
        who: &Identity,
        console: bool,
    ) -> Result<(), ConsoleError> {
        let state = self.state_ref();
        let guard = state.mutation.lock().await;
        let stored = self.stored(bucket, name);
        self.judge(
            who,
            &RulesCheck {
                bucket,
                name,
                operation: Operation::Delete,
                before: stored.as_ref(),
                after: None,
                authorization: who.authorization(),
                console,
            },
        )?;
        let object = stored
            .ok_or_else(|| ConsoleError::NotFound(format!("No object {name} in gs://{bucket}.")))?;
        let mut pending = Pending::default();
        write::delete_locked(
            state,
            &guard,
            &mut pending,
            object,
            &ChangeContext::from_authorization(who.authorization(), console),
        );
        pending.commit(state).await.map_err(internal)?;
        drop(guard);
        pending.dispatch(state);
        Ok(())
    }

    /// The v1 and v2 bodies each Storage event of the object carries now,
    /// built by the dispatcher's own code without sending anything.
    pub fn event_payloads(&self, bucket: &str, name: &str) -> Result<EventPayloads, ConsoleError> {
        let state = self.state_ref();
        let object = self
            .stored(bucket, name)
            .ok_or_else(|| ConsoleError::NotFound(format!("No object {name} in gs://{bucket}.")))?;
        let bodies = |event| {
            let built = crate::events::bodies(state, event, &object, None);
            EventBodies {
                v1: built.v1,
                v2: built.v2,
            }
        };
        Ok(EventPayloads {
            functions: state.options.functions,
            finalize: bodies(StorageEvent::Finalize),
            metadata_update: bodies(StorageEvent::Metadata),
            delete: bodies(StorageEvent::Delete),
        })
    }

    /// Sends the object's `finalize` or `metadataUpdate` event again, as it
    /// is now, with fresh ids (the delivery runtime drops an id it has seen).
    /// Admin only; the object is not rewritten and no change is recorded.
    pub fn resend(
        &self,
        bucket: &str,
        name: &str,
        event: ResendEvent,
        who: &Identity,
    ) -> Result<EventDelivery, ConsoleError> {
        if *who != Identity::Admin {
            return Err(denied_admin_only("Only Admin can send an event again."));
        }
        let state = self.state_ref();
        let object = self
            .stored(bucket, name)
            .ok_or_else(|| ConsoleError::NotFound(format!("No object {name} in gs://{bucket}.")))?;
        if is_marker(&object) && event == ResendEvent::MetadataUpdate {
            return Err(ConsoleError::Invalid(
                "A folder marker has no metadata to announce.".to_owned(),
            ));
        }
        let nonce = format!(
            "resend-{}-{}",
            crate::now_millis(),
            crate::RESEND_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        Ok(state.dispatch_with(
            match event {
                ResendEvent::Finalize => StorageEvent::Finalize,
                ResendEvent::MetadataUpdate => StorageEvent::Metadata,
            },
            &object,
            Some(&nonce),
        ))
    }

    /// The upload sessions of `bucket` not yet finalized, newest activity
    /// first.
    #[must_use]
    pub fn sessions(
        &self,
        bucket: &str,
        after: Option<&SessionCursor>,
        before: Option<&SessionCursor>,
        limit: usize,
    ) -> SessionPage {
        crate::sessions::list(self.state_ref(), bucket, after, before, limit)
    }

    /// Removes an upload session and its staged bytes.
    pub async fn discard_session(&self, bucket: &str, id: &str) -> Result<(), ConsoleError> {
        crate::sessions::discard(self.state_ref(), bucket, id).await
    }

    /// Removes every object and unfinished upload session of every bucket
    /// in one transaction, as `/internal/reset` does (no Storage event, the
    /// revision kept moving forwards, one reset announcement), then unlinks
    /// the data files 1,000 at a time, reporting each thousand to
    /// `progress`. Returns the objects removed. Rules and decisions stay.
    pub async fn clear_all(&self, progress: &dyn BulkProgress) -> Result<u64, ConsoleError> {
        let state = self.state_ref();
        let guard = state.mutation.lock().await;
        let (files, removed) = {
            let mut data = lock(&state.inner);
            let removed = u64::try_from(data.objects.len()).unwrap_or(u64::MAX);
            let files = data
                .objects
                .values()
                .map(|object| object.data_file.clone())
                .chain(
                    data.uploads
                        .values()
                        .map(|upload| upload.staging_file.clone()),
                )
                .collect::<Vec<_>>();
            data.clear();
            persist_state(state, &data).map_err(internal)?;
            (files, removed)
        };
        state.views.clear();
        for chunk in files.chunks(1_000) {
            for file in chunk {
                let _ = tokio::fs::remove_file(state.config.data_dir.join(file)).await;
            }
            progress.done(u64::try_from(chunk.len()).unwrap_or(u64::MAX));
        }
        drop(guard);
        Ok(removed)
    }
}
