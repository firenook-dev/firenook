//! Account state as the official emulator keeps it (`state.ts`): one
//! `ProjectState` per project or tenant with the same indexes, codes and
//! proofs, and the agent/tenant configuration split.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Bound;
use std::sync::Arc;

use im::OrdMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue, json};

use crate::console::index::UserIndex;
use crate::error::{ApiError, ensure};
use crate::observe::{
    ConfigChange, MessageKind, MessageMeta, MessageRecord, Notice, SmsPurpose, UserChange,
};
use crate::util::{
    is_valid_phone, mirror_field, now_millis, random_base64url, random_digits, random_id,
    str_field, truthy, truthy_str,
};

pub const PROVIDER_PASSWORD: &str = "password";
pub const PROVIDER_PHONE: &str = "phone";
pub const PROVIDER_ANONYMOUS: &str = "anonymous";
pub const PROVIDER_CUSTOM: &str = "custom";
pub const PROVIDER_GAME_CENTER: &str = "gc.apple.com";
pub const SIGNIN_METHOD_EMAIL_LINK: &str = "emailLink";
pub const PROJECT_NUMBER: &str = "12345";

/// A user record: the official `UserInfo` object, kept as JSON so that
/// every field round-trips through export/import unchanged.
pub type UserRecord = JsonMap<String, JsonValue>;

/// Provider info entry (`providerUserInfo[]`).
pub type ProviderInfo = JsonMap<String, JsonValue>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifecycle {
    Create,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockingEvent {
    BeforeCreate,
    BeforeSignIn,
}

impl BlockingEvent {
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::BeforeCreate => "beforeCreate",
            Self::BeforeSignIn => "beforeSignIn",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OobRecord {
    pub email: String,
    #[serde(rename = "newEmail", skip_serializing_if = "Option::is_none")]
    pub new_email: Option<String>,
    #[serde(rename = "requestType")]
    pub request_type: String,
    #[serde(rename = "oobCode")]
    pub oob_code: String,
    #[serde(rename = "oobLink")]
    pub oob_link: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VerificationRecord {
    pub code: String,
    #[serde(rename = "phoneNumber")]
    pub phone_number: String,
    #[serde(rename = "sessionInfo")]
    pub session_info: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TemporaryProof {
    #[serde(rename = "phoneNumber")]
    pub phone_number: String,
    #[serde(rename = "temporaryProof")]
    pub temporary_proof: String,
    #[serde(rename = "temporaryProofExpiresIn")]
    pub temporary_proof_expires_in: String,
}

/// Accounts and codes of one project or tenant.
///
/// The persisted maps are `im` persistent maps (the same JSON map on disk),
/// so the state can be snapshotted under the data lock in O(1) and encoded
/// outside it (`persist.rs`), and a console read can hold one account's
/// record without copying it. The accessors keep their signatures: a lookup
/// still answers an owned [`UserRecord`].
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ProjectState {
    #[serde(default)]
    pub users: OrdMap<String, Arc<UserRecord>>,
    #[serde(default)]
    pub oobs: OrdMap<String, OobRecord>,
    #[serde(default, rename = "verificationCodes")]
    pub verification_codes: OrdMap<String, VerificationRecord>,
    #[serde(default, rename = "temporaryProofs")]
    pub temporary_proofs: OrdMap<String, TemporaryProof>,
    // Indexes are derived; rebuilt after deserialization.
    #[serde(skip)]
    local_id_for_email: BTreeMap<String, String>,
    #[serde(skip)]
    local_id_for_initial_email: BTreeMap<String, String>,
    #[serde(skip)]
    local_id_for_phone: BTreeMap<String, String>,
    #[serde(skip)]
    local_ids_for_provider_email: BTreeMap<String, BTreeSet<String>>,
    #[serde(skip)]
    user_for_provider_raw_id: BTreeMap<String, BTreeMap<String, String>>,
    #[serde(skip)]
    local_id_for_passkey: BTreeMap<String, String>,
    #[serde(skip)]
    pending_local_ids: BTreeSet<String>,
    #[serde(skip)]
    pub events: Vec<(Lifecycle, UserRecord)>,
    /// What changed since the last drain, for the console's record of the
    /// call (`observe`); drained after every change, observer or not.
    #[serde(skip)]
    pub(crate) notices: Vec<Notice>,
    /// What the console reads: a digest of every account, kept beside the
    /// maps above (`console::index`).
    #[serde(skip)]
    user_index: UserIndex,
    /// Bumped by every persisted-state mutation, so a request that only read
    /// the state is not written back to disk. Never serialized.
    #[serde(skip)]
    mutations: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryOrder {
    Asc,
    Desc,
}

#[derive(Default)]
pub struct UpdateOptions<'a> {
    pub upsert_providers: Vec<ProviderInfo>,
    pub delete_providers: Vec<&'a str>,
}

impl ProjectState {
    /// How many persisted-state mutations this project has seen.
    #[must_use]
    pub const fn mutations(&self) -> u64 {
        self.mutations
    }

    fn mutated(&mut self) {
        self.mutations = self.mutations.wrapping_add(1);
    }

    /// The console's index of these accounts.
    pub(crate) const fn user_index(&self) -> &UserIndex {
        &self.user_index
    }

    /// Rebuilds the derived indexes after loading persisted records.
    pub fn rebuild_indexes(&mut self) {
        self.local_id_for_email.clear();
        self.local_id_for_initial_email.clear();
        self.local_id_for_phone.clear();
        self.local_ids_for_provider_email.clear();
        self.user_for_provider_raw_id.clear();
        self.local_id_for_passkey.clear();
        let users: Vec<Arc<UserRecord>> = self.users.values().cloned().collect();
        for user in users {
            self.index_user(&user);
        }
        self.user_index = UserIndex::build(&self.users);
    }

    fn index_user(&mut self, user: &UserRecord) {
        let local_id = str_field(user, "localId").unwrap_or_default().to_owned();
        if let Some(email) = truthy_str(user, "email") {
            self.local_id_for_email
                .insert(email.to_owned(), local_id.clone());
        }
        if let Some(email) = truthy_str(user, "initialEmail") {
            self.local_id_for_initial_email
                .insert(email.to_owned(), local_id.clone());
        }
        if let Some(phone) = truthy_str(user, "phoneNumber") {
            self.local_id_for_phone
                .insert(phone.to_owned(), local_id.clone());
        }
        for info in provider_infos(user) {
            if let (Some(provider), Some(raw_id)) =
                (str_field(&info, "providerId"), str_field(&info, "rawId"))
            {
                self.user_for_provider_raw_id
                    .entry(provider.to_owned())
                    .or_default()
                    .insert(raw_id.to_owned(), local_id.clone());
            }
            if let Some(email) = truthy_str(&info, "email") {
                self.local_ids_for_provider_email
                    .entry(email.to_owned())
                    .or_default()
                    .insert(local_id.clone());
            }
        }
        for passkey in passkeys(user) {
            if let Some(credential) = truthy_str(&passkey, "credentialId") {
                self.local_id_for_passkey
                    .insert(credential.to_owned(), local_id.clone());
            }
        }
    }

    /// `generateLocalId`: a fresh 28-character id, reserved until created.
    pub fn generate_local_id(&mut self) -> String {
        loop {
            let local_id = random_id(28);
            if !self.users.contains_key(&local_id) && !self.pending_local_ids.contains(&local_id) {
                self.pending_local_ids.insert(local_id.clone());
                self.mutated();
                return local_id;
            }
        }
    }

    /// `createUserWithLocalId`: `None` when the id exists; dispatches `create`.
    pub fn create_user_with_local_id(
        &mut self,
        local_id: &str,
        props: &UserRecord,
    ) -> Result<Option<UserRecord>, ApiError> {
        self.mutated();
        if self.users.contains_key(local_id) {
            return Ok(None);
        }
        let mut record = UserRecord::new();
        record.insert("localId".to_owned(), json!(local_id));
        self.users.insert(local_id.to_owned(), Arc::new(record));
        self.pending_local_ids.remove(local_id);
        let providers = provider_infos_of(props);
        let user = self
            .apply_update(
                local_id,
                props,
                UpdateOptions {
                    upsert_providers: providers,
                    delete_providers: Vec::new(),
                },
            )
            .inspect_err(|_| self.reindex(local_id))?;
        self.events.push((Lifecycle::Create, user.clone()));
        self.notices.push(Notice::User {
            uid: local_id.to_owned(),
            change: UserChange::Created,
            fields: Vec::new(),
        });
        Ok(Some(user))
    }

    /// `overwriteUserWithLocalId` (imports): no lifecycle event.
    pub fn overwrite_user_with_local_id(
        &mut self,
        local_id: &str,
        props: &UserRecord,
    ) -> Result<UserRecord, ApiError> {
        self.mutated();
        let existed = if let Some(before) = self.users.get(local_id).cloned() {
            self.remove_user_from_index(&before);
            true
        } else {
            false
        };
        let now = now_millis();
        let mut record = UserRecord::new();
        record.insert("localId".to_owned(), json!(local_id));
        record.insert(
            "createdAt".to_owned(),
            props
                .get("createdAt")
                .filter(|value| truthy(Some(value)))
                .cloned()
                .unwrap_or_else(|| json!(now.to_string())),
        );
        record.insert("lastLoginAt".to_owned(), json!(now.to_string()));
        self.users.insert(local_id.to_owned(), Arc::new(record));
        let providers = provider_infos_of(props);
        let user = self
            .apply_update(
                local_id,
                props,
                UpdateOptions {
                    upsert_providers: providers,
                    delete_providers: Vec::new(),
                },
            )
            .inspect_err(|_| self.reindex(local_id))?;
        self.notices.push(if existed {
            Notice::User {
                uid: local_id.to_owned(),
                change: UserChange::Updated,
                fields: props.keys().cloned().collect(),
            }
        } else {
            Notice::User {
                uid: local_id.to_owned(),
                change: UserChange::Created,
                fields: Vec::new(),
            }
        });
        Ok(user)
    }

    /// Brings the console's digest of `local_id` up to date with the map,
    /// for the paths that leave a record behind when an update fails.
    fn reindex(&mut self, local_id: &str) {
        match self.users.get(local_id) {
            Some(record) => self.user_index.upsert(local_id, record),
            None => self.user_index.remove(local_id),
        }
    }

    /// `deleteUser`: removes the record and dispatches `delete`.
    pub fn delete_user(&mut self, user: &UserRecord) {
        self.mutated();
        let local_id = str_field(user, "localId").unwrap_or_default().to_owned();
        self.users.remove(&local_id);
        self.user_index.remove(&local_id);
        self.remove_user_from_index(user);
        self.events.push((Lifecycle::Delete, user.clone()));
        self.notices.push(Notice::User {
            uid: local_id,
            change: UserChange::Deleted,
            fields: Vec::new(),
        });
    }

    /// Removes the record without a lifecycle event: the emulator's own
    /// delete-all semantics, for the console's deletes without triggers.
    /// `false` when there was no such account.
    pub fn delete_user_quietly(&mut self, local_id: &str) -> bool {
        let Some(user) = self.users.get(local_id).cloned() else {
            return false;
        };
        self.mutated();
        self.users.remove(local_id);
        self.user_index.remove(local_id);
        self.remove_user_from_index(&user);
        self.notices.push(Notice::User {
            uid: local_id.to_owned(),
            change: UserChange::Deleted,
            fields: Vec::new(),
        });
        true
    }

    /// `updateUserByLocalId`: mirrors every field of `fields` (a `null`
    /// value deletes), then maintains indexes and provider entries.
    pub fn update_user_by_local_id(
        &mut self,
        local_id: &str,
        fields: &UserRecord,
        options: UpdateOptions<'_>,
    ) -> Result<UserRecord, ApiError> {
        let user = self.apply_update(local_id, fields, options)?;
        // An update that sets nothing (a blocking function that changed
        // nothing) is not a change the console reports.
        if !fields.is_empty() {
            self.notices.push(Notice::User {
                uid: local_id.to_owned(),
                change: UserChange::Updated,
                fields: fields.keys().cloned().collect(),
            });
        }
        Ok(user)
    }

    /// The update itself, without the notice: creation and imports say
    /// what they did themselves.
    fn apply_update(
        &mut self,
        local_id: &str,
        fields: &UserRecord,
        options: UpdateOptions<'_>,
    ) -> Result<UserRecord, ApiError> {
        self.mutated();
        let mut upsert_providers = options.upsert_providers;
        let mut delete_providers: Vec<String> = options
            .delete_providers
            .iter()
            .map(|provider| (*provider).to_owned())
            .collect();
        let mut user = owned(self.users.get(local_id)).ok_or_else(|| {
            ApiError::internal(
                format!("Internal assertion error: trying to update nonexistent user: {local_id}"),
                "INTERNAL",
            )
        })?;
        let old_email = truthy_str(&user, "email").map(str::to_owned);
        let old_phone = truthy_str(&user, "phoneNumber").map(str::to_owned);
        let old_passkeys = passkeys(&user);
        for (field, value) in fields {
            if value.is_null() {
                user.remove(field);
            } else {
                user.insert(field.clone(), value.clone());
            }
        }
        if fields
            .get("passkeyInfo")
            .is_some_and(|value| !value.is_null())
        {
            for passkey in old_passkeys {
                if let Some(credential) = truthy_str(&passkey, "credentialId") {
                    self.local_id_for_passkey.remove(credential);
                }
            }
            for passkey in passkeys(&user) {
                if let Some(credential) = truthy_str(&passkey, "credentialId") {
                    self.local_id_for_passkey
                        .insert(credential.to_owned(), local_id.to_owned());
                }
            }
        }
        let email = truthy_str(&user, "email").map(str::to_owned);
        if let Some(old) = &old_email
            && old_email != email
        {
            self.local_id_for_email.remove(old);
        }
        if let Some(email) = &email {
            self.local_id_for_email
                .insert(email.clone(), local_id.to_owned());
        }
        if let Some(email) = &email
            && (truthy(user.get("passwordHash")) || truthy(user.get("emailLinkSignin")))
        {
            let mut info = ProviderInfo::new();
            info.insert("providerId".to_owned(), json!(PROVIDER_PASSWORD));
            info.insert("email".to_owned(), json!(email));
            info.insert("federatedId".to_owned(), json!(email));
            info.insert("rawId".to_owned(), json!(email));
            mirror_field(&mut info, "displayName", &user);
            mirror_field(&mut info, "photoUrl", &user);
            upsert_providers.push(info);
        } else {
            delete_providers.push(PROVIDER_PASSWORD.to_owned());
        }
        if let Some(initial) = truthy_str(&user, "initialEmail") {
            self.local_id_for_initial_email
                .insert(initial.to_owned(), local_id.to_owned());
        }
        let phone = truthy_str(&user, "phoneNumber").map(str::to_owned);
        if let Some(old) = &old_phone
            && old_phone != phone
        {
            self.local_id_for_phone.remove(old);
        }
        if let Some(phone) = &phone {
            self.local_id_for_phone
                .insert(phone.clone(), local_id.to_owned());
            let mut info = ProviderInfo::new();
            info.insert("providerId".to_owned(), json!(PROVIDER_PHONE));
            info.insert("phoneNumber".to_owned(), json!(phone));
            info.insert("rawId".to_owned(), json!(phone));
            upsert_providers.push(info);
        } else {
            delete_providers.push(PROVIDER_PHONE.to_owned());
        }
        if let Some(enrollments) = user.get("mfaInfo").and_then(JsonValue::as_array) {
            validate_mfa_enrollments(enrollments)?;
        }
        let updated = self.update_user_provider_info(user, upsert_providers, &delete_providers);
        self.user_index.upsert(local_id, &updated);
        self.users
            .insert(local_id.to_owned(), Arc::new(updated.clone()));
        Ok(updated)
    }

    fn update_user_provider_info(
        &mut self,
        mut user: UserRecord,
        upsert_providers: Vec<ProviderInfo>,
        delete_providers: &[String],
    ) -> UserRecord {
        let local_id = str_field(&user, "localId").unwrap_or_default().to_owned();
        let old_provider_emails = provider_emails(&user);
        if user
            .get("providerUserInfo")
            .is_some_and(JsonValue::is_array)
        {
            let mut kept = Vec::new();
            for info in provider_infos(&user) {
                let provider = str_field(&info, "providerId")
                    .unwrap_or_default()
                    .to_owned();
                if delete_providers.contains(&provider) {
                    if let Some(raw) = str_field(&info, "rawId")
                        && let Some(map) = self.user_for_provider_raw_id.get_mut(&provider)
                    {
                        map.remove(raw);
                    }
                } else {
                    kept.push(JsonValue::Object(info));
                }
            }
            user.insert("providerUserInfo".to_owned(), JsonValue::Array(kept));
        }
        if !upsert_providers.is_empty() {
            let mut infos = provider_infos(&user);
            for upsert in upsert_providers {
                let provider = str_field(&upsert, "providerId")
                    .unwrap_or_default()
                    .to_owned();
                let raw = str_field(&upsert, "rawId").unwrap_or_default().to_owned();
                self.user_for_provider_raw_id
                    .entry(provider.clone())
                    .or_default()
                    .insert(raw, local_id.clone());
                if let Some(index) = infos
                    .iter()
                    .position(|info| str_field(info, "providerId") == Some(provider.as_str()))
                {
                    infos[index] = upsert;
                } else {
                    infos.push(upsert);
                }
            }
            user.insert(
                "providerUserInfo".to_owned(),
                JsonValue::Array(infos.into_iter().map(JsonValue::Object).collect()),
            );
        }
        let mut stale = old_provider_emails;
        for email in provider_emails(&user) {
            stale.remove(&email);
            self.local_ids_for_provider_email
                .entry(email)
                .or_default()
                .insert(local_id.clone());
        }
        for email in stale {
            self.remove_provider_email_for_user(&email, &local_id);
        }
        user
    }

    fn remove_provider_email_for_user(&mut self, email: &str, local_id: &str) {
        if let Some(ids) = self.local_ids_for_provider_email.get_mut(email) {
            ids.remove(local_id);
            if ids.is_empty() {
                self.local_ids_for_provider_email.remove(email);
            }
        }
    }

    fn remove_user_from_index(&mut self, user: &UserRecord) {
        let local_id = str_field(user, "localId").unwrap_or_default().to_owned();
        if let Some(email) = truthy_str(user, "email") {
            self.local_id_for_email.remove(email);
        }
        if let Some(email) = truthy_str(user, "initialEmail") {
            self.local_id_for_initial_email.remove(email);
        }
        if let Some(phone) = truthy_str(user, "phoneNumber") {
            self.local_id_for_phone.remove(phone);
        }
        for info in provider_infos(user) {
            if let (Some(provider), Some(raw)) =
                (str_field(&info, "providerId"), str_field(&info, "rawId"))
                && let Some(map) = self.user_for_provider_raw_id.get_mut(provider)
            {
                map.remove(raw);
            }
            if let Some(email) = truthy_str(&info, "email") {
                self.remove_provider_email_for_user(email, &local_id);
            }
        }
        for passkey in passkeys(user) {
            if let Some(credential) = truthy_str(&passkey, "credentialId") {
                self.local_id_for_passkey.remove(credential);
            }
        }
    }

    #[must_use]
    pub fn get_user_by_local_id(&self, local_id: &str) -> Option<UserRecord> {
        owned(self.users.get(local_id))
    }

    /// The stored record of `local_id`, shared: an O(1) clone that a console
    /// read takes under the lock and reads after releasing it.
    #[must_use]
    pub fn shared_user(&self, local_id: &str) -> Option<Arc<UserRecord>> {
        self.users.get(local_id).cloned()
    }

    #[must_use]
    pub fn get_user_by_email(&self, email: &str) -> Option<UserRecord> {
        self.local_id_for_email
            .get(email)
            .and_then(|id| owned(self.users.get(id)))
    }

    #[must_use]
    pub fn get_user_by_initial_email(&self, email: &str) -> Option<UserRecord> {
        self.local_id_for_initial_email
            .get(email)
            .and_then(|id| owned(self.users.get(id)))
    }

    #[must_use]
    pub fn get_user_by_phone_number(&self, phone: &str) -> Option<UserRecord> {
        self.local_id_for_phone
            .get(phone)
            .and_then(|id| owned(self.users.get(id)))
    }

    #[must_use]
    pub fn get_user_by_provider_raw_id(&self, provider: &str, raw_id: &str) -> Option<UserRecord> {
        self.user_for_provider_raw_id
            .get(provider)
            .and_then(|map| map.get(raw_id))
            .and_then(|id| owned(self.users.get(id)))
    }

    #[must_use]
    pub fn get_user_by_passkey_credential_id(&self, credential: &str) -> Option<UserRecord> {
        self.local_id_for_passkey
            .get(credential)
            .and_then(|id| owned(self.users.get(id)))
    }

    /// `getUsersByEmailOrProviderEmail`: the account owning the email first,
    /// then accounts whose provider entries carry it.
    #[must_use]
    pub fn get_users_by_email_or_provider_email(&self, email: &str) -> Vec<UserRecord> {
        let mut users = Vec::new();
        let mut seen = BTreeSet::new();
        if let Some(id) = self.local_id_for_email.get(email)
            && let Some(user) = self.users.get(id)
        {
            users.push(UserRecord::clone(user));
            seen.insert(id.clone());
        }
        if let Some(ids) = self.local_ids_for_provider_email.get(email) {
            for id in ids {
                if seen.insert(id.clone())
                    && let Some(user) = self.users.get(id)
                {
                    users.push(UserRecord::clone(user));
                }
            }
        }
        users
    }

    /// `listProviderInfosByProviderId`: provider entries of every account
    /// linked to `provider`, in index order.
    #[must_use]
    pub fn list_provider_infos_by_provider_id(&self, provider: &str) -> Vec<ProviderInfo> {
        let Some(map) = self.user_for_provider_raw_id.get(provider) else {
            return Vec::new();
        };
        let mut infos = Vec::new();
        for local_id in map.values() {
            if let Some(user) = self.users.get(local_id)
                && let Some(info) = provider_infos(user)
                    .into_iter()
                    .find(|info| str_field(info, "providerId") == Some(provider))
            {
                infos.push(info);
            }
        }
        infos
    }

    pub fn create_oob(
        &mut self,
        email: &str,
        new_email: Option<&str>,
        request_type: &str,
        link: impl FnOnce(&str) -> String,
        message: MessageMeta,
    ) -> OobRecord {
        self.mutated();
        let code = random_base64url(54);
        let record = OobRecord {
            email: email.to_owned(),
            new_email: new_email.map(str::to_owned),
            request_type: request_type.to_owned(),
            oob_link: link(&code),
            oob_code: code.clone(),
        };
        self.oobs.insert(code, record.clone());
        let uid = message.uid.clone().or_else(|| self.uid_for_email(email));
        let text = match message.delivery {
            crate::observe::Delivery::Sent => {
                crate::ops::oob::oob_message_text(&record).unwrap_or_default()
            }
            _ => String::new(),
        };
        self.notices.push(Notice::Message(Box::new(oob_message(
            &record, message, uid, text,
        ))));
        record
    }

    /// The account an email names: its current email, else its first one.
    pub(crate) fn uid_for_email(&self, email: &str) -> Option<String> {
        self.local_id_for_email
            .get(email)
            .or_else(|| self.local_id_for_initial_email.get(email))
            .cloned()
    }

    #[must_use]
    pub fn validate_oob_code(&self, code: &str) -> Option<OobRecord> {
        self.oobs.get(code).cloned()
    }

    pub fn delete_oob_code(&mut self, code: &str) {
        self.mutated();
        if self.oobs.remove(code).is_some() {
            self.notices.push(Notice::Used {
                key: code.to_owned(),
            });
        }
    }

    #[must_use]
    pub fn list_oob_codes(&self) -> Vec<OobRecord> {
        self.oobs.values().cloned().collect()
    }

    pub fn create_verification_code(
        &mut self,
        phone: &str,
        purpose: SmsPurpose,
        message: MessageMeta,
    ) -> VerificationRecord {
        self.mutated();
        let session = random_base64url(226);
        let record = VerificationRecord {
            code: random_digits(6),
            phone_number: phone.to_owned(),
            session_info: session.clone(),
        };
        self.verification_codes.insert(session, record.clone());
        let uid = message.uid.or_else(|| match purpose {
            SmsPurpose::SignIn => self.local_id_for_phone.get(phone).cloned(),
            SmsPurpose::MfaEnrollment | SmsPurpose::MfaSignIn => None,
        });
        let text = crate::observe::sms_message_text(purpose, phone, &record.code);
        self.notices.push(Notice::Message(Box::new(MessageRecord {
            id: message.id,
            project: String::new(),
            tenant: None,
            kind: purpose.kind(),
            to: phone.to_owned(),
            new_email: None,
            uid,
            code: record.code.clone(),
            link: None,
            continue_url: None,
            delivery: message.delivery,
            origin: None,
            key: record.session_info.clone(),
            text,
            at_millis: Some(now_millis()),
        })));
        record
    }

    #[must_use]
    pub fn get_verification_code(&self, session: &str) -> Option<VerificationRecord> {
        self.verification_codes.get(session).cloned()
    }

    pub fn delete_verification_code(&mut self, session: &str) {
        self.mutated();
        if self.verification_codes.remove(session).is_some() {
            self.notices.push(Notice::Used {
                key: session.to_owned(),
            });
        }
    }

    /// Every code this scope holds, as found (no time, `Restored`), with
    /// fresh message ids from `next_id`: what the console's inbox shows for
    /// codes from saved state.
    pub(crate) fn saved_messages(&self, next_id: &mut dyn FnMut() -> u64) -> Vec<MessageRecord> {
        let mut messages = Vec::new();
        for record in self.oobs.values() {
            let meta = MessageMeta {
                id: next_id(),
                delivery: crate::observe::Delivery::Restored,
                continue_url: continue_url_of(&record.oob_link),
                uid: None,
            };
            let uid = self.uid_for_email(&record.email);
            let text = crate::ops::oob::oob_message_text(record).unwrap_or_default();
            let mut message = oob_message(record, meta, uid, text);
            message.at_millis = None;
            messages.push(message);
        }
        for record in self.verification_codes.values() {
            // A code's purpose is not stored: a number some account has
            // enrolled as a second factor is taken for an MFA sign-in.
            let enrolled = self.users.values().find(|user| {
                user.get("mfaInfo")
                    .and_then(JsonValue::as_array)
                    .is_some_and(|enrollments| {
                        enrollments.iter().any(|enrollment| {
                            enrollment
                                .get("unobfuscatedPhoneInfo")
                                .and_then(JsonValue::as_str)
                                == Some(record.phone_number.as_str())
                        })
                    })
            });
            let (purpose, uid) = match enrolled {
                Some(user) => (SmsPurpose::MfaSignIn, crate::observe::uid_of(user)),
                None => (
                    SmsPurpose::SignIn,
                    self.local_id_for_phone.get(&record.phone_number).cloned(),
                ),
            };
            messages.push(MessageRecord {
                id: next_id(),
                project: String::new(),
                tenant: None,
                kind: purpose.kind(),
                to: record.phone_number.clone(),
                new_email: None,
                uid,
                code: record.code.clone(),
                link: None,
                continue_url: None,
                delivery: crate::observe::Delivery::Restored,
                origin: None,
                key: record.session_info.clone(),
                text: crate::observe::sms_message_text(purpose, &record.phone_number, &record.code),
                at_millis: None,
            });
        }
        messages
    }

    #[must_use]
    pub fn list_verification_codes(&self) -> Vec<VerificationRecord> {
        self.verification_codes.values().cloned().collect()
    }

    pub fn create_temporary_proof(&mut self, phone: &str) -> TemporaryProof {
        self.mutated();
        let record = TemporaryProof {
            phone_number: phone.to_owned(),
            temporary_proof: random_base64url(119),
            temporary_proof_expires_in: "3600".to_owned(),
        };
        self.temporary_proofs
            .insert(record.temporary_proof.clone(), record.clone());
        record
    }

    #[must_use]
    pub fn validate_temporary_proof(&self, proof: &str, phone: &str) -> Option<TemporaryProof> {
        self.temporary_proofs
            .get(proof)
            .filter(|record| record.phone_number == phone)
            .cloned()
    }

    /// `deleteAllAccounts`: users and their indexes; codes stay.
    pub fn delete_all_accounts(&mut self) {
        self.mutated();
        self.notices.push(Notice::Cleared);
        self.users.clear();
        self.user_index.clear();
        self.local_id_for_email.clear();
        self.local_id_for_phone.clear();
        self.local_ids_for_provider_email.clear();
        self.user_for_provider_raw_id.clear();
        self.local_id_for_passkey.clear();
    }

    #[must_use]
    pub fn user_count(&self) -> usize {
        self.users.len()
    }

    /// Up to `limit` accounts matching `text`, for an identity picker: an
    /// email prefix (lowercased) and a uid prefix as ranges over the maps
    /// this state keeps anyway, then, only while fewer than `limit` matched,
    /// a display-name or email substring scanned within `budget` (which one
    /// search shares across the project and its tenants). Empty `text`: the
    /// first `limit` accounts by uid. Each account appears once, best match
    /// first.
    #[must_use]
    pub fn search_identities(
        &self,
        text: &str,
        limit: usize,
        budget: &mut IdentityBudget,
    ) -> Vec<&UserRecord> {
        let mut found: Vec<&UserRecord> = Vec::new();
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        if text.is_empty() {
            for user in self.users.values().take(limit) {
                budget.read += 1;
                found.push(user.as_ref());
            }
            return found;
        }
        let lower = text.to_lowercase();
        let emails = self
            .local_id_for_email
            .range::<str, _>((Bound::Included(lower.as_str()), Bound::Unbounded))
            .take_while(|(email, _)| email.starts_with(lower.as_str()));
        for (_, local_id) in emails {
            if found.len() >= limit {
                return found;
            }
            if let Some((id, user)) = self.users.get_key_value(local_id.as_str()) {
                budget.read += 1;
                if seen.insert(id.as_str()) {
                    found.push(user.as_ref());
                }
            }
        }
        let uids = self
            .users
            .range::<_, str>((Bound::Included(text), Bound::Unbounded))
            .take_while(|(id, _)| id.starts_with(text));
        for (id, user) in uids {
            if found.len() >= limit {
                return found;
            }
            budget.read += 1;
            if seen.insert(id.as_str()) {
                found.push(user.as_ref());
            }
        }
        for (id, user) in &self.users {
            if found.len() >= limit {
                break;
            }
            if budget.remaining == 0 {
                budget.exhausted = true;
                break;
            }
            budget.remaining -= 1;
            budget.examined += 1;
            budget.read += 1;
            if seen.contains(id.as_str()) {
                continue;
            }
            let matches = |field: &str| {
                str_field(user, field).is_some_and(|value| value.to_lowercase().contains(&lower))
            };
            if matches("displayName") || matches("email") {
                seen.insert(id.as_str());
                found.push(user.as_ref());
            }
        }
        found
    }

    /// `queryUsers`: every account after `start_token`, sorted by localId.
    ///
    /// The map is keyed by `localId`, so its order is already the sort; the
    /// accounts are cloned once, in order, and never re-sorted.
    #[must_use]
    pub fn query_users(&self, order: QueryOrder, start_token: Option<&str>) -> Vec<UserRecord> {
        let after = self.users_after(start_token);
        match order {
            QueryOrder::Asc => after.cloned().collect(),
            QueryOrder::Desc => after.rev().cloned().collect(),
        }
    }

    /// One `batchGet` page: at most `max_results` accounts after
    /// `start_token` in localId order (every account when `None`), and the
    /// `nextPageToken` the official emulator answers with — the last
    /// account's id whenever the page is full, even when nothing follows it.
    /// A ranged read of the ordered map: only the page's accounts are cloned.
    #[must_use]
    pub fn query_users_page(
        &self,
        start_token: Option<&str>,
        max_results: Option<usize>,
    ) -> (Vec<UserRecord>, Option<String>) {
        let after = self.users_after(start_token);
        let Some(max_results) = max_results else {
            return (after.cloned().collect(), None);
        };
        let users: Vec<UserRecord> = after.take(max_results).cloned().collect();
        let next_page_token = if max_results > 0 && users.len() == max_results {
            users
                .last()
                .and_then(|user| str_field(user, "localId"))
                .map(str::to_owned)
        } else {
            None
        };
        (users, next_page_token)
    }

    /// The accounts whose localId sorts after `start_token`, in order.
    fn users_after<'a>(
        &'a self,
        start_token: Option<&'a str>,
    ) -> impl DoubleEndedIterator<Item = &'a UserRecord> {
        let lower = start_token.map_or(Bound::Unbounded, Bound::Excluded);
        self.users
            .range::<_, str>((lower, Bound::Unbounded))
            .map(|(_, user)| user.as_ref())
    }
}

/// How far one identity search may scan for substrings, shared by the
/// project and every tenant it searches.
#[derive(Debug)]
pub struct IdentityBudget {
    remaining: usize,
    examined: u64,
    read: u64,
    exhausted: bool,
}

impl IdentityBudget {
    /// A budget of `accounts` scanned for substrings.
    #[must_use]
    pub const fn new(accounts: usize) -> Self {
        Self {
            remaining: accounts,
            examined: 0,
            read: 0,
            exhausted: false,
        }
    }

    /// Accounts the substring scan examined.
    #[must_use]
    pub const fn examined(&self) -> u64 {
        self.examined
    }

    /// Accounts read in all, by the prefix ranges and the scan.
    #[must_use]
    pub const fn read(&self) -> u64 {
        self.read
    }

    /// Whether the scan stopped because the budget ran out.
    #[must_use]
    pub const fn exhausted(&self) -> bool {
        self.exhausted
    }
}

/// `validateMfaEnrollments`.
pub fn validate_mfa_enrollments(enrollments: &[JsonValue]) -> Result<(), ApiError> {
    let mut phones = BTreeSet::new();
    let mut ids = BTreeSet::new();
    for enrollment in enrollments {
        let object = enrollment.as_object().cloned().unwrap_or_default();
        let phone = truthy_str(&object, "phoneInfo");
        ensure!(
            phone.is_some_and(is_valid_phone),
            "INVALID_MFA_PHONE_NUMBER : Invalid format."
        );
        let id = truthy_str(&object, "mfaEnrollmentId");
        ensure!(
            id.is_some(),
            "INVALID_MFA_ENROLLMENT_ID : mfaEnrollmentId must be defined."
        );
        let id = id.unwrap_or_default().to_owned();
        let phone = phone.unwrap_or_default().to_owned();
        ensure!(!ids.contains(&id), "DUPLICATE_MFA_ENROLLMENT_ID");
        ensure!(
            !phones.contains(&phone),
            "INTERNAL_ERROR : MFA Enrollment Phone Numbers must be unique."
        );
        phones.insert(phone);
        ids.insert(id);
    }
    Ok(())
}

/// An owned copy of a shared record.
fn owned(user: Option<&Arc<UserRecord>>) -> Option<UserRecord> {
    user.map(|user| UserRecord::clone(user))
}

/// The inbox's view of an out-of-band code.
fn oob_message(
    record: &OobRecord,
    meta: MessageMeta,
    uid: Option<String>,
    text: String,
) -> MessageRecord {
    MessageRecord {
        id: meta.id,
        project: String::new(),
        tenant: None,
        kind: MessageKind::of_request_type(&record.request_type),
        to: record.email.clone(),
        new_email: record.new_email.clone(),
        uid,
        code: record.oob_code.clone(),
        link: Some(record.oob_link.clone()),
        continue_url: meta.continue_url,
        delivery: meta.delivery,
        origin: None,
        key: record.oob_code.clone(),
        text,
        at_millis: Some(now_millis()),
    }
}

/// The `continueUrl` a link carries.
fn continue_url_of(link: &str) -> Option<String> {
    url::Url::parse(link).ok().and_then(|url| {
        url.query_pairs()
            .find(|(key, _)| key == "continueUrl")
            .map(|(_, value)| value.into_owned())
    })
}

/// `providerUserInfo` entries of a record.
#[must_use]
pub fn provider_infos(user: &UserRecord) -> Vec<ProviderInfo> {
    user.get("providerUserInfo")
        .and_then(JsonValue::as_array)
        .map(|infos| {
            infos
                .iter()
                .filter_map(|info| info.as_object().cloned())
                .collect()
        })
        .unwrap_or_default()
}

fn provider_infos_of(props: &UserRecord) -> Vec<ProviderInfo> {
    provider_infos(props)
}

#[must_use]
pub fn passkeys(user: &UserRecord) -> Vec<JsonMap<String, JsonValue>> {
    user.get("passkeyInfo")
        .and_then(JsonValue::as_array)
        .map(|keys| {
            keys.iter()
                .filter_map(|key| key.as_object().cloned())
                .collect()
        })
        .unwrap_or_default()
}

fn provider_emails(user: &UserRecord) -> BTreeSet<String> {
    provider_infos(user)
        .iter()
        .filter_map(|info| truthy_str(info, "email").map(str::to_owned))
        .collect()
}

/// Tenant configuration as the official emulator stores and returns it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TenantConfig {
    #[serde(flatten)]
    pub fields: JsonMap<String, JsonValue>,
}

/// One tenant: its own accounts and codes plus its configuration.
#[derive(Debug, Serialize, Deserialize)]
pub struct TenantState {
    #[serde(flatten)]
    pub project: ProjectState,
    pub config: JsonMap<String, JsonValue>,
}

fn default_config() -> JsonMap<String, JsonValue> {
    json!({
        "signIn": { "allowDuplicateEmails": false },
        "blockingFunctions": {},
        "emailPrivacyConfig": { "enableImprovedEmailPrivacy": false }
    })
    .as_object()
    .cloned()
    .unwrap_or_default()
}

/// The root project: accounts, the v2 configuration and its tenants.
#[derive(Debug, Serialize, Deserialize)]
pub struct AgentState {
    #[serde(flatten)]
    pub project: ProjectState,
    #[serde(default = "default_config")]
    pub config: JsonMap<String, JsonValue>,
    #[serde(default)]
    pub tenants: BTreeMap<String, TenantState>,
    /// Configuration and tenant mutations; see [`ProjectState::mutations`].
    #[serde(skip)]
    mutations: u64,
    /// Configuration changes since the last drain (`observe`).
    #[serde(skip)]
    pub(crate) notices: Vec<Notice>,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            project: ProjectState::default(),
            config: default_config(),
            tenants: BTreeMap::new(),
            mutations: 0,
            notices: Vec::new(),
        }
    }
}

impl AgentState {
    /// Every persisted-state mutation below this project: its own
    /// configuration and tenants, its accounts and each tenant's accounts.
    #[must_use]
    pub fn mutations(&self) -> u64 {
        self.tenants.values().fold(
            self.mutations.wrapping_add(self.project.mutations()),
            |total, tenant| total.wrapping_add(tenant.project.mutations()),
        )
    }

    fn mutated(&mut self) {
        self.mutations = self.mutations.wrapping_add(1);
    }

    pub fn rebuild_indexes(&mut self) {
        self.project.rebuild_indexes();
        for tenant in self.tenants.values_mut() {
            tenant.project.rebuild_indexes();
        }
    }

    /// `getTenantProject`: created with the default tenant config on first use.
    pub fn ensure_tenant(&mut self, project_id: &str, tenant_id: &str) {
        if !self.tenants.contains_key(tenant_id) {
            let mut config = JsonMap::new();
            config.insert("tenantId".to_owned(), json!(tenant_id));
            config.insert("allowPasswordSignup".to_owned(), json!(true));
            config.insert("disableAuth".to_owned(), json!(false));
            config.insert(
                "mfaConfig".to_owned(),
                json!({ "state": "ENABLED", "enabledProviders": ["PHONE_SMS"] }),
            );
            config.insert("enableAnonymousUser".to_owned(), json!(true));
            config.insert("enableEmailLinkSignin".to_owned(), json!(true));
            self.create_tenant_with_id(tenant_id, config, project_id);
        }
    }

    /// `createTenantWithTenantId`: `None` when the id exists.
    pub fn create_tenant_with_id(
        &mut self,
        tenant_id: &str,
        mut config: JsonMap<String, JsonValue>,
        project_id: &str,
    ) -> Option<JsonMap<String, JsonValue>> {
        if self.tenants.contains_key(tenant_id) {
            return None;
        }
        self.mutated();
        self.notices.push(Notice::Config {
            tenant: Some(tenant_id.to_owned()),
            what: ConfigChange::TenantCreated,
        });
        config.insert(
            "name".to_owned(),
            json!(format!("projects/{project_id}/tenants/{tenant_id}")),
        );
        config.insert("tenantId".to_owned(), json!(tenant_id));
        self.tenants.insert(
            tenant_id.to_owned(),
            TenantState {
                project: ProjectState::default(),
                config: config.clone(),
            },
        );
        Some(config)
    }

    /// `createTenant`: a random 28-character id.
    pub fn create_tenant(
        &mut self,
        config: &JsonMap<String, JsonValue>,
        project_id: &str,
    ) -> JsonMap<String, JsonValue> {
        self.mutated();
        loop {
            let tenant_id = random_id(28);
            if let Some(created) =
                self.create_tenant_with_id(&tenant_id, config.clone(), project_id)
            {
                return created;
            }
        }
    }

    /// `listTenants`: configs after `start_token`, sorted by id.
    #[must_use]
    pub fn list_tenants(&self, start_token: Option<&str>) -> Vec<JsonMap<String, JsonValue>> {
        self.tenants
            .iter()
            .filter(|(id, _)| start_token.is_none_or(|token| id.as_str() > token))
            .map(|(_, tenant)| tenant.config.clone())
            .collect()
    }

    #[must_use]
    pub fn one_account_per_email(&self) -> bool {
        !truthy(
            self.config
                .get("signIn")
                .and_then(|sign_in| sign_in.get("allowDuplicateEmails")),
        )
    }

    #[must_use]
    pub fn improved_email_privacy(&self) -> bool {
        truthy(
            self.config
                .get("emailPrivacyConfig")
                .and_then(|config| config.get("enableImprovedEmailPrivacy")),
        )
    }

    #[must_use]
    pub fn blocking_uri(&self, event: BlockingEvent) -> Option<String> {
        self.config
            .get("blockingFunctions")
            .and_then(|config| config.get("triggers"))
            .and_then(|triggers| triggers.get(event.name()))
            .and_then(|trigger| trigger.get("functionUri"))
            .and_then(JsonValue::as_str)
            .map(str::to_owned)
    }

    #[must_use]
    pub fn forward_credential(&self, kind: &str) -> bool {
        truthy(
            self.config
                .get("blockingFunctions")
                .and_then(|config| config.get("forwardInboundCredentials"))
                .and_then(|forward| forward.get(kind)),
        )
    }

    /// `updateConfig(update, updateMask)`.
    pub fn update_config(
        &mut self,
        update: &JsonMap<String, JsonValue>,
        update_mask: Option<&str>,
    ) -> JsonMap<String, JsonValue> {
        self.mutated();
        self.notices.push(Notice::Config {
            tenant: None,
            what: ConfigChange::Project,
        });
        match update_mask {
            None => {
                let allow_duplicates = truthy(
                    update
                        .get("signIn")
                        .and_then(|sign_in| sign_in.get("allowDuplicateEmails")),
                );
                let blocking = update
                    .get("blockingFunctions")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let privacy = truthy(
                    update
                        .get("emailPrivacyConfig")
                        .and_then(|config| config.get("enableImprovedEmailPrivacy")),
                );
                set_nested(
                    &mut self.config,
                    &["signIn", "allowDuplicateEmails"],
                    json!(allow_duplicates),
                );
                self.config.insert("blockingFunctions".to_owned(), blocking);
                set_nested(
                    &mut self.config,
                    &["emailPrivacyConfig", "enableImprovedEmailPrivacy"],
                    json!(privacy),
                );
                self.config.clone()
            }
            Some(mask) => {
                apply_mask(mask, &mut self.config, update);
                self.config.clone()
            }
        }
    }
}

fn set_nested(target: &mut JsonMap<String, JsonValue>, path: &[&str], value: JsonValue) {
    let mut current = target;
    for key in &path[..path.len() - 1] {
        let entry = current
            .entry((*key).to_owned())
            .or_insert_with(|| json!({}));
        if !entry.is_object() {
            *entry = json!({});
        }
        current = entry.as_object_mut().expect("just ensured an object");
    }
    if let Some(last) = path.last() {
        current.insert((*last).to_owned(), value);
    }
}

/// `applyMask(updateMask, dest, update)`: dotted paths copied when present
/// in the update; missing paths are skipped with a warning (not recorded).
///
/// # Panics
///
/// Never: intermediate objects are created before they are descended into.
pub fn apply_mask(
    update_mask: &str,
    dest: &mut JsonMap<String, JsonValue>,
    update: &JsonMap<String, JsonValue>,
) {
    for path in update_mask.split(',') {
        let fields: Vec<&str> = path.split('.').collect();
        let mut update_field: &JsonMap<String, JsonValue> = update;
        let mut dest_field: &mut JsonMap<String, JsonValue> = dest;
        let mut broken = false;
        for field in &fields[..fields.len().saturating_sub(1)] {
            let Some(next) = update_field.get(*field).filter(|value| !value.is_null()) else {
                broken = true;
                break;
            };
            let Some(next_object) = next.as_object() else {
                broken = true;
                break;
            };
            let entry = dest_field
                .entry((*field).to_owned())
                .or_insert_with(|| json!({}));
            if !entry.is_object() {
                *entry = json!({});
            }
            update_field = next_object;
            dest_field = entry.as_object_mut().expect("just ensured an object");
        }
        if broken {
            continue;
        }
        let Some(last) = fields.last() else {
            continue;
        };
        match update_field.get(*last) {
            Some(value) if !value.is_null() => {
                dest_field.insert((*last).to_owned(), value.clone());
            }
            _ => {}
        }
    }
}

/// Serialized state of every project the emulator has seen.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AuthData {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub projects: BTreeMap<String, AgentState>,
    /// Project creations; see [`ProjectState::mutations`].
    #[serde(skip)]
    mutations: u64,
}

impl AuthData {
    pub fn rebuild_indexes(&mut self) {
        for agent in self.projects.values_mut() {
            agent.rebuild_indexes();
        }
    }

    /// A value that changes whenever the persisted state changed. Two
    /// readings that agree mean nothing needs to be written back; the
    /// counters are never serialized and restart at zero on load.
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.projects.values().fold(self.mutations, |total, agent| {
            total.wrapping_add(agent.mutations())
        })
    }

    /// The agent project, created on first reference like `getProjectStateById`.
    pub fn agent(&mut self, project_id: &str) -> &mut AgentState {
        if !self.projects.contains_key(project_id) {
            self.mutations = self.mutations.wrapping_add(1);
        }
        self.projects.entry(project_id.to_owned()).or_default()
    }

    /// Drains what changed from every project and tenant, with the scope it
    /// happened in, filling in each message's project and tenant.
    pub(crate) fn take_notices(&mut self) -> Vec<(String, Option<String>, Notice)> {
        let mut notices = Vec::new();
        for (project_id, agent) in &mut self.projects {
            for notice in agent.notices.drain(..) {
                notices.push((project_id.clone(), None, notice));
            }
            let scopes = std::iter::once((None, &mut agent.project)).chain(
                agent
                    .tenants
                    .iter_mut()
                    .map(|(id, tenant)| (Some(id.as_str()), &mut tenant.project)),
            );
            for (tenant, project) in scopes {
                for mut notice in project.notices.drain(..) {
                    if let Notice::Message(message) = &mut notice {
                        message.project.clone_from(project_id);
                        message.tenant = tenant.map(str::to_owned);
                    }
                    notices.push((project_id.clone(), tenant.map(str::to_owned), notice));
                }
            }
        }
        notices
    }

    /// Drains lifecycle events from every project and tenant.
    pub fn take_events(&mut self) -> Vec<(String, Lifecycle, UserRecord)> {
        let mut events = Vec::new();
        for (project_id, agent) in &mut self.projects {
            for (kind, user) in agent.project.events.drain(..) {
                events.push((project_id.clone(), kind, user));
            }
            for tenant in agent.tenants.values_mut() {
                for (kind, user) in tenant.project.events.drain(..) {
                    events.push((project_id.clone(), kind, user));
                }
            }
        }
        events
    }
}

/// A resolved project or tenant scope: the official `state` argument.
pub struct Scope<'a> {
    pub project_id: String,
    pub tenant_id: Option<String>,
    agent: &'a mut AgentState,
}

impl<'a> Scope<'a> {
    pub fn new(data: &'a mut AuthData, project_id: &str, tenant_id: Option<&str>) -> Self {
        let agent = data.agent(project_id);
        if let Some(tenant) = tenant_id {
            agent.ensure_tenant(project_id, tenant);
        }
        Self {
            project_id: project_id.to_owned(),
            tenant_id: tenant_id.map(str::to_owned),
            agent,
        }
    }

    /// A scope over an already resolved agent (nested tenant access).
    pub fn new_in(agent: &'a mut AgentState, project_id: &str, tenant_id: Option<&str>) -> Self {
        if let Some(tenant) = tenant_id {
            agent.ensure_tenant(project_id, tenant);
        }
        Self {
            project_id: project_id.to_owned(),
            tenant_id: tenant_id.map(str::to_owned),
            agent,
        }
    }

    #[must_use]
    pub fn is_tenant(&self) -> bool {
        self.tenant_id.is_some()
    }

    /// The accounts of this scope.
    ///
    /// # Panics
    ///
    /// Never: the tenant is created by the constructor.
    pub fn project(&mut self) -> &mut ProjectState {
        match &self.tenant_id {
            Some(tenant) => {
                &mut self
                    .agent
                    .tenants
                    .get_mut(tenant)
                    .expect("tenant ensured")
                    .project
            }
            None => &mut self.agent.project,
        }
    }

    /// # Panics
    ///
    /// Never: the tenant is created by the constructor.
    #[must_use]
    pub fn project_ref(&self) -> &ProjectState {
        match &self.tenant_id {
            Some(tenant) => {
                &self
                    .agent
                    .tenants
                    .get(tenant)
                    .expect("tenant ensured")
                    .project
            }
            None => &self.agent.project,
        }
    }

    pub fn agent(&mut self) -> &mut AgentState {
        self.agent
    }

    #[must_use]
    pub fn agent_ref(&self) -> &AgentState {
        self.agent
    }

    fn tenant_config(&self) -> Option<&JsonMap<String, JsonValue>> {
        self.tenant_id
            .as_ref()
            .and_then(|tenant| self.agent.tenants.get(tenant))
            .map(|tenant| &tenant.config)
    }

    #[must_use]
    pub fn tenant_config_value(&self) -> Option<JsonMap<String, JsonValue>> {
        self.tenant_config().cloned()
    }

    pub fn set_tenant_config(&mut self, config: JsonMap<String, JsonValue>) {
        if let Some(tenant) = &self.tenant_id
            && let Some(state) = self.agent.tenants.get_mut(tenant)
        {
            state.config = config;
            self.agent.mutated();
            self.agent.notices.push(Notice::Config {
                tenant: Some(tenant.clone()),
                what: ConfigChange::TenantUpdated,
            });
        }
    }

    pub fn delete_tenant(&mut self) {
        if let Some(tenant) = &self.tenant_id
            && self.agent.tenants.remove(tenant).is_some()
        {
            self.agent.mutated();
            self.agent.notices.push(Notice::Config {
                tenant: Some(tenant.clone()),
                what: ConfigChange::TenantDeleted,
            });
        }
    }

    #[must_use]
    pub fn one_account_per_email(&self) -> bool {
        self.agent.one_account_per_email()
    }

    #[must_use]
    pub fn improved_email_privacy(&self) -> bool {
        self.agent.improved_email_privacy()
    }

    #[must_use]
    pub fn allow_password_signup(&self) -> bool {
        self.tenant_config()
            .is_none_or(|config| truthy(config.get("allowPasswordSignup")))
    }

    #[must_use]
    pub fn disable_auth(&self) -> bool {
        self.tenant_config()
            .is_some_and(|config| truthy(config.get("disableAuth")))
    }

    #[must_use]
    pub fn enable_anonymous_user(&self) -> bool {
        self.tenant_config()
            .is_none_or(|config| truthy(config.get("enableAnonymousUser")))
    }

    #[must_use]
    pub fn enable_email_link_signin(&self) -> bool {
        self.tenant_config()
            .is_none_or(|config| truthy(config.get("enableEmailLinkSignin")))
    }

    /// `mfaConfig`: `{ state, enabledProviders }`.
    #[must_use]
    pub fn mfa_config(&self) -> (String, Vec<String>) {
        match self.tenant_config() {
            None => ("ENABLED".to_owned(), vec!["PHONE_SMS".to_owned()]),
            Some(config) => {
                let mfa = config
                    .get("mfaConfig")
                    .and_then(JsonValue::as_object)
                    .cloned()
                    .unwrap_or_default();
                let state = str_field(&mfa, "state").unwrap_or_default().to_owned();
                let providers = mfa
                    .get("enabledProviders")
                    .and_then(JsonValue::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(JsonValue::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                (state, providers)
            }
        }
    }

    /// `(state.mfaConfig.state === "ENABLED" || "MANDATORY") && enabledProviders.includes("PHONE_SMS")`.
    #[must_use]
    pub fn sms_mfa_enabled(&self) -> bool {
        let (state, providers) = self.mfa_config();
        (state == "ENABLED" || state == "MANDATORY")
            && providers.iter().any(|provider| provider == "PHONE_SMS")
    }

    #[must_use]
    pub fn blocking_uri(&self, event: BlockingEvent) -> Option<String> {
        self.agent.blocking_uri(event)
    }

    #[must_use]
    pub fn forward_credential(&self, kind: &str) -> bool {
        self.agent.forward_credential(kind)
    }
}

#[cfg(test)]
mod identity_search_tests {
    use super::*;

    fn user(state: &mut ProjectState, uid: &str, email: Option<&str>, name: Option<&str>) {
        let mut props = UserRecord::new();
        if let Some(email) = email {
            props.insert("email".to_owned(), json!(email));
        }
        if let Some(name) = name {
            props.insert("displayName".to_owned(), json!(name));
        }
        state
            .create_user_with_local_id(uid, &props)
            .expect("created")
            .expect("new");
    }

    fn uids(found: &[&UserRecord]) -> Vec<String> {
        found
            .iter()
            .map(|user| str_field(user, "localId").unwrap_or_default().to_owned())
            .collect()
    }

    /// 10,000 accounts and three that match `ada` by email.
    fn crowd() -> ProjectState {
        let mut state = ProjectState::default();
        for index in 0..10_000 {
            user(
                &mut state,
                &format!("u{index:05}"),
                Some(&format!("person{index}@example.test")),
                None,
            );
        }
        user(&mut state, "a1", Some("ada@example.test"), Some("Ada"));
        user(&mut state, "a2", Some("ada.l@example.test"), None);
        user(&mut state, "a3", Some("adams@example.test"), None);
        state
    }

    #[test]
    fn an_email_prefix_is_a_range_that_reads_no_other_account() {
        let state = crowd();
        let mut budget = IdentityBudget::new(20_000);
        let found = state.search_identities("ADA", 3, &mut budget);
        // In email order: `ada.l@` sorts before `ada@`.
        assert_eq!(uids(&found), ["a2", "a1", "a3"]);
        assert_eq!(budget.read(), 3, "only the accounts in the range were read");
        assert_eq!(budget.examined(), 0, "no scan was needed");
    }

    #[test]
    fn a_uid_prefix_is_a_range_too() {
        let state = crowd();
        let mut budget = IdentityBudget::new(20_000);
        let found = state.search_identities("u0999", 10, &mut budget);
        assert_eq!(found.len(), 10);
        assert_eq!(uids(&found)[0], "u09990");
        assert_eq!(budget.read(), 10);
    }

    #[test]
    fn a_substring_scans_only_while_more_are_wanted_and_stops_at_the_budget() {
        let mut state = crowd();
        user(
            &mut state,
            "zz",
            Some("z@example.test"),
            Some("Lovelace, Ada"),
        );
        let mut budget = IdentityBudget::new(20_000);
        let found = state.search_identities("lovelace", 5, &mut budget);
        assert_eq!(uids(&found), ["zz"]);
        assert_eq!(budget.examined(), 10_004, "every account once");
        assert!(!budget.exhausted());
        let mut small = IdentityBudget::new(100);
        let found = state.search_identities("lovelace", 5, &mut small);
        assert_eq!(found.len(), 0);
        assert!(small.exhausted());
        assert_eq!(small.examined(), 100);
        // A budget spent is spent for the next scope too.
        let found = state.search_identities("lovelace", 5, &mut small);
        assert_eq!(found.len(), 0);
        assert_eq!(small.examined(), 100);
        // Matches by prefix come first, then substrings, each once.
        let mut budget = IdentityBudget::new(20_000);
        let found = state.search_identities("ada", 5, &mut budget);
        assert_eq!(uids(&found), ["a2", "a1", "a3", "zz"]);
    }

    #[test]
    fn no_text_lists_the_first_accounts_by_uid() {
        let state = crowd();
        let mut budget = IdentityBudget::new(20_000);
        let found = state.search_identities("", 3, &mut budget);
        assert_eq!(uids(&found), ["a1", "a2", "a3"]);
        assert_eq!(budget.read(), 3);
    }
}
