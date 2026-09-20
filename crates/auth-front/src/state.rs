//! Account state as the official emulator keeps it (`state.ts`): one
//! `ProjectState` per project or tenant with the same indexes, codes and
//! proofs, and the agent/tenant configuration split.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue, json};

use crate::error::{ApiError, ensure};
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
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ProjectState {
    #[serde(default)]
    pub users: BTreeMap<String, UserRecord>,
    #[serde(default)]
    pub oobs: BTreeMap<String, OobRecord>,
    #[serde(default, rename = "verificationCodes")]
    pub verification_codes: BTreeMap<String, VerificationRecord>,
    #[serde(default, rename = "temporaryProofs")]
    pub temporary_proofs: BTreeMap<String, TemporaryProof>,
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

    /// Rebuilds the derived indexes after loading persisted records.
    pub fn rebuild_indexes(&mut self) {
        self.local_id_for_email.clear();
        self.local_id_for_initial_email.clear();
        self.local_id_for_phone.clear();
        self.local_ids_for_provider_email.clear();
        self.user_for_provider_raw_id.clear();
        self.local_id_for_passkey.clear();
        let users: Vec<UserRecord> = self.users.values().cloned().collect();
        for user in users {
            self.index_user(&user);
        }
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
        self.users.insert(local_id.to_owned(), record);
        self.pending_local_ids.remove(local_id);
        let providers = provider_infos_of(props);
        let user = self.update_user_by_local_id(
            local_id,
            props,
            UpdateOptions {
                upsert_providers: providers,
                delete_providers: Vec::new(),
            },
        )?;
        self.events.push((Lifecycle::Create, user.clone()));
        Ok(Some(user))
    }

    /// `overwriteUserWithLocalId` (imports): no lifecycle event.
    pub fn overwrite_user_with_local_id(
        &mut self,
        local_id: &str,
        props: &UserRecord,
    ) -> Result<UserRecord, ApiError> {
        self.mutated();
        if let Some(before) = self.users.get(local_id).cloned() {
            self.remove_user_from_index(&before);
        }
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
        self.users.insert(local_id.to_owned(), record);
        let providers = provider_infos_of(props);
        self.update_user_by_local_id(
            local_id,
            props,
            UpdateOptions {
                upsert_providers: providers,
                delete_providers: Vec::new(),
            },
        )
    }

    /// `deleteUser`: removes the record and dispatches `delete`.
    pub fn delete_user(&mut self, user: &UserRecord) {
        self.mutated();
        let local_id = str_field(user, "localId").unwrap_or_default().to_owned();
        self.users.remove(&local_id);
        self.remove_user_from_index(user);
        self.events.push((Lifecycle::Delete, user.clone()));
    }

    /// `updateUserByLocalId`: mirrors every field of `fields` (a `null`
    /// value deletes), then maintains indexes and provider entries.
    pub fn update_user_by_local_id(
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
        let mut user = self.users.get(local_id).cloned().ok_or_else(|| {
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
        self.users.insert(local_id.to_owned(), user.clone());
        let updated = self.update_user_provider_info(user, upsert_providers, &delete_providers);
        self.users.insert(local_id.to_owned(), updated.clone());
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
        self.users.get(local_id).cloned()
    }

    #[must_use]
    pub fn get_user_by_email(&self, email: &str) -> Option<UserRecord> {
        self.local_id_for_email
            .get(email)
            .and_then(|id| self.users.get(id))
            .cloned()
    }

    #[must_use]
    pub fn get_user_by_initial_email(&self, email: &str) -> Option<UserRecord> {
        self.local_id_for_initial_email
            .get(email)
            .and_then(|id| self.users.get(id))
            .cloned()
    }

    #[must_use]
    pub fn get_user_by_phone_number(&self, phone: &str) -> Option<UserRecord> {
        self.local_id_for_phone
            .get(phone)
            .and_then(|id| self.users.get(id))
            .cloned()
    }

    #[must_use]
    pub fn get_user_by_provider_raw_id(&self, provider: &str, raw_id: &str) -> Option<UserRecord> {
        self.user_for_provider_raw_id
            .get(provider)
            .and_then(|map| map.get(raw_id))
            .and_then(|id| self.users.get(id))
            .cloned()
    }

    #[must_use]
    pub fn get_user_by_passkey_credential_id(&self, credential: &str) -> Option<UserRecord> {
        self.local_id_for_passkey
            .get(credential)
            .and_then(|id| self.users.get(id))
            .cloned()
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
            users.push(user.clone());
            seen.insert(id.clone());
        }
        if let Some(ids) = self.local_ids_for_provider_email.get(email) {
            for id in ids {
                if seen.insert(id.clone())
                    && let Some(user) = self.users.get(id)
                {
                    users.push(user.clone());
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
        record
    }

    #[must_use]
    pub fn validate_oob_code(&self, code: &str) -> Option<OobRecord> {
        self.oobs.get(code).cloned()
    }

    pub fn delete_oob_code(&mut self, code: &str) {
        self.mutated();
        self.oobs.remove(code);
    }

    #[must_use]
    pub fn list_oob_codes(&self) -> Vec<OobRecord> {
        self.oobs.values().cloned().collect()
    }

    pub fn create_verification_code(&mut self, phone: &str) -> VerificationRecord {
        self.mutated();
        let session = random_base64url(226);
        let record = VerificationRecord {
            code: random_digits(6),
            phone_number: phone.to_owned(),
            session_info: session.clone(),
        };
        self.verification_codes.insert(session, record.clone());
        record
    }

    #[must_use]
    pub fn get_verification_code(&self, session: &str) -> Option<VerificationRecord> {
        self.verification_codes.get(session).cloned()
    }

    pub fn delete_verification_code(&mut self, session: &str) {
        self.mutated();
        self.verification_codes.remove(session);
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
        self.users.clear();
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

    /// `queryUsers`: every account after `start_token`, sorted by localId.
    #[must_use]
    pub fn query_users(&self, order: QueryOrder, start_token: Option<&str>) -> Vec<UserRecord> {
        let mut users: Vec<UserRecord> = self
            .users
            .values()
            .filter(|user| {
                start_token
                    .is_none_or(|token| str_field(user, "localId").unwrap_or_default() > token)
            })
            .cloned()
            .collect();
        users.sort_by(|a, b| str_field(a, "localId").cmp(&str_field(b, "localId")));
        if order == QueryOrder::Desc {
            users.reverse();
        }
        users
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
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            project: ProjectState::default(),
            config: default_config(),
            tenants: BTreeMap::new(),
            mutations: 0,
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
        }
    }

    pub fn delete_tenant(&mut self) {
        if let Some(tenant) = &self.tenant_id
            && self.agent.tenants.remove(tenant).is_some()
        {
            self.agent.mutated();
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
