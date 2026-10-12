//! Importing users from a file, user by user.
//!
//! A file can be an emulator export (`{"kind":
//! "identitytoolkit#DownloadAccountResponse", "users": [...]}`), a CLI
//! export (`{"users": [...]}`, with `lastSignedInAt` and production password
//! hashes) or a plain array of users. [`read_users`] streams it with a
//! `DeserializeSeed` that visits the `users` array (or the top-level array)
//! one element at a time, so memory is one user whatever the file's size.
//!
//! [`Runtime::import_preview`] is the dry run: each user is validated alone
//! with `batchCreate`'s own `import_one` against a scratch scope that holds
//! nothing, emails and phones are checked unique inside the file, and
//! existing uids and emails are found in an index snapshot.
//! [`Runtime::import_commit`] reads the file again and imports it in chunks
//! of 2,000 users per critical section through `import_one`, so validation
//! and storage are `batchCreate`'s and no lifecycle event fires.

use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::io::{BufReader, Read};
use std::ops::ControlFlow;
use std::path::Path;
use std::time::{Duration, Instant};

use serde::de::{
    DeserializeSeed, Deserializer, Error as _, IgnoredAny, MapAccess, SeqAccess, Visitor,
};
use serde_json::{Map as JsonMap, Value as JsonValue, json};

use super::bulk::{BulkProgress, CHUNK, users_phrase};
use super::{ConsoleCall, ConsoleError, ConsoleErrorKind, ProviderCount};
use crate::Runtime;
use crate::observe::ConsoleOrigin;
use crate::ops::admin::import_one;
use crate::state::{AgentState, PROVIDER_PASSWORD, PROVIDER_PHONE, Scope, provider_infos};
use crate::util::{canonicalize_email, str_field, truthy, truthy_str};

/// Problems and existing uids a preview lists one by one.
pub const LISTED: usize = 200;

/// What kind of file it was.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportFormat {
    /// The emulator's own export (`accounts.json`).
    Emulator,
    /// A Firebase CLI `auth:export` file.
    Cli,
    /// A JSON array of users.
    Array,
}

impl ImportFormat {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Emulator => "emulator",
            Self::Cli => "cli",
            Self::Array => "array",
        }
    }
}

/// What reading a file found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImportShape {
    pub format: ImportFormat,
    /// Elements of the users array.
    pub users: u64,
}

/// Why a file could not be read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportError(pub String);

impl fmt::Display for ImportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// One element as found: a user object, or why it is not one.
pub type Element = Result<JsonMap<String, JsonValue>, String>;

/// The marker a visitor's `Break` travels as through serde.
const STOPPED: &str = "the import was stopped";

struct UsersSeed<'a> {
    visit: &'a mut dyn FnMut(usize, Element) -> ControlFlow<()>,
    count: &'a mut usize,
}

impl<'de> DeserializeSeed<'de> for UsersSeed<'_> {
    type Value = ();

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for UsersSeed<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an array of users")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<(), A::Error> {
        while let Some(value) = sequence.next_element::<JsonValue>()? {
            let element = match value {
                JsonValue::Object(user) => Ok(normalized(user)),
                _ => Err("Each user is a JSON object.".to_owned()),
            };
            let index = *self.count;
            *self.count += 1;
            if (self.visit)(index, element).is_break() {
                return Err(A::Error::custom(STOPPED));
            }
        }
        Ok(())
    }
}

/// The file's top level: an array of users, or an object holding `users`.
struct TopSeed<'a> {
    visit: &'a mut dyn FnMut(usize, Element) -> ControlFlow<()>,
    count: &'a mut usize,
}

impl<'de> DeserializeSeed<'de> for TopSeed<'_> {
    type Value = ImportFormat;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<ImportFormat, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for TopSeed<'_> {
    type Value = ImportFormat;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an Auth export: an object with a users array, or an array of users")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, sequence: A) -> Result<ImportFormat, A::Error> {
        UsersSeed {
            visit: self.visit,
            count: self.count,
        }
        .visit_seq(sequence)?;
        Ok(ImportFormat::Array)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<ImportFormat, A::Error> {
        let mut kind: Option<String> = None;
        let mut users = false;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "users" if !users => {
                    map.next_value_seed(UsersSeed {
                        visit: &mut *self.visit,
                        count: &mut *self.count,
                    })?;
                    users = true;
                }
                "kind" => kind = map.next_value::<JsonValue>()?.as_str().map(str::to_owned),
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        if !users {
            return Err(A::Error::custom(
                "The file has no `users` array. Choose an Auth export (accounts.json or auth:export), or a JSON array of users.",
            ));
        }
        Ok(
            if kind.as_deref() == Some("identitytoolkit#DownloadAccountResponse") {
                ImportFormat::Emulator
            } else {
                ImportFormat::Cli
            },
        )
    }
}

/// A CLI export's `lastSignedInAt` is the emulator's `lastLoginAt`.
fn normalized(mut user: JsonMap<String, JsonValue>) -> JsonMap<String, JsonValue> {
    if !user.contains_key("lastLoginAt")
        && let Some(last) = user.remove("lastSignedInAt")
    {
        user.insert("lastLoginAt".to_owned(), last);
    }
    user
}

/// Streams the users of `reader` to `visit`, one at a time, in file order.
/// `visit` may stop the read with `Break`.
pub fn read_users(
    reader: impl Read,
    visit: &mut dyn FnMut(usize, Element) -> ControlFlow<()>,
) -> Result<ImportShape, ImportError> {
    let mut count = 0_usize;
    let mut deserializer =
        serde_json::Deserializer::from_reader(BufReader::with_capacity(64 * 1024, reader));
    let format = TopSeed {
        visit,
        count: &mut count,
    }
    .deserialize(&mut deserializer)
    .map_err(|error| {
        if error.to_string().starts_with(STOPPED) {
            ImportError(STOPPED.to_owned())
        } else if error.is_syntax() || error.is_eof() {
            ImportError(format!(
                "The file is not valid JSON ({error}). Choose the export file again."
            ))
        } else {
            ImportError(error.to_string())
        }
    })?;
    deserializer
        .end()
        .map_err(|error| ImportError(format!("The file has more after its JSON: {error}.")))?;
    Ok(ImportShape {
        format,
        users: u64::try_from(count).unwrap_or(u64::MAX),
    })
}

/// How a commit treats users whose uid already exists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportMode {
    Skip,
    Overwrite,
}

/// The import's options.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportOptions {
    pub mode: ImportMode,
    /// Every imported user gets this password (stored the emulator's way).
    pub replace_password: Option<String>,
}

/// One user the import would refuse or did refuse.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportProblem {
    /// Its place in the file, from 0.
    pub index: u64,
    pub uid: Option<String>,
    pub message: String,
}

/// What an import would do (the dry run).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportPreview {
    pub format: ImportFormat,
    pub total: u64,
    pub by_provider: Vec<ProviderCount>,
    pub with_password: u64,
    /// Hashes the emulator cannot check (production exports).
    pub opaque_hashes: u64,
    pub with_claims: u64,
    /// Users whose uid already exists here (the first 200), and how many.
    pub existing: Vec<String>,
    pub existing_count: u64,
    /// The first 200 problems, and how many.
    pub problems: Vec<ImportProblem>,
    pub problem_count: u64,
    pub took: Duration,
}

/// How a commit ended.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImportOutcome {
    pub imported: u64,
    pub skipped: u64,
    pub failed: u64,
    pub cancelled: bool,
}

/// What `import_one` is given for one user of the file.
fn prepared(
    mut user: JsonMap<String, JsonValue>,
    options: &ImportOptions,
) -> JsonMap<String, JsonValue> {
    if let Some(password) = &options.replace_password {
        user.remove("passwordHash");
        user.remove("salt");
        user.insert("rawPassword".to_owned(), json!(password));
    }
    user
}

fn open(path: &Path) -> Result<std::fs::File, ConsoleError> {
    std::fs::File::open(path).map_err(|error| {
        ConsoleError::of_kind(
            ConsoleErrorKind::Internal,
            format!("The uploaded file could not be read: {error}."),
        )
        .with_fix("Choose the file again.")
    })
}

fn read_failure(error: &ImportError) -> ConsoleError {
    ConsoleError::invalid(error.0.clone())
        .with_fix("Choose an Auth export file, or a JSON array of users.")
}

impl Runtime {
    /// Reads the file at `path` once and says what importing it into
    /// `project` (or its `tenant`) with `options` would do. Changes nothing.
    pub fn import_preview(
        &self,
        project: &str,
        tenant: Option<&str>,
        path: &Path,
        options: &ImportOptions,
    ) -> Result<ImportPreview, ConsoleError> {
        let started = Instant::now();
        let tenant = tenant.filter(|tenant| !tenant.is_empty());
        let view = self.users(project, tenant)?;
        let mut providers: BTreeMap<String, u64> = BTreeMap::new();
        let mut preview = ImportPreview {
            format: ImportFormat::Array,
            total: 0,
            by_provider: Vec::new(),
            with_password: 0,
            opaque_hashes: 0,
            with_claims: 0,
            existing: Vec::new(),
            existing_count: 0,
            problems: Vec::new(),
            problem_count: 0,
            took: Duration::ZERO,
        };
        let mut emails: HashSet<String> = HashSet::new();
        let mut phones: HashSet<String> = HashSet::new();
        let mut uids: HashSet<String> = HashSet::new();
        let problem =
            |preview: &mut ImportPreview, index: usize, uid: Option<&str>, message: String| {
                preview.problem_count += 1;
                if preview.problems.len() < LISTED {
                    preview.problems.push(ImportProblem {
                        index: u64::try_from(index).unwrap_or(u64::MAX),
                        uid: uid.map(str::to_owned),
                        message,
                    });
                }
            };
        let shape = read_users(open(path)?, &mut |index, element| {
            let user = match element {
                Ok(user) => prepared(user, options),
                Err(message) => {
                    problem(&mut preview, index, None, message);
                    return ControlFlow::Continue(());
                }
            };
            let uid = truthy_str(&user, "localId").map(str::to_owned);
            if let Some(hash) = truthy_str(&user, "passwordHash") {
                preview.with_password += 1;
                *providers.entry(PROVIDER_PASSWORD.to_owned()).or_default() += 1;
                if !hash.starts_with("fakeHash:") {
                    preview.opaque_hashes += 1;
                }
            } else if truthy(user.get("rawPassword")) {
                preview.with_password += 1;
                *providers.entry(PROVIDER_PASSWORD.to_owned()).or_default() += 1;
            }
            if truthy(user.get("phoneNumber")) {
                *providers.entry(PROVIDER_PHONE.to_owned()).or_default() += 1;
            }
            for info in provider_infos(&user) {
                if let Some(provider) = truthy_str(&info, "providerId")
                    && provider != PROVIDER_PASSWORD
                    && provider != PROVIDER_PHONE
                {
                    *providers.entry(provider.to_owned()).or_default() += 1;
                }
            }
            if truthy_str(&user, "customAttributes").is_some_and(|claims| claims.trim() != "{}") {
                preview.with_claims += 1;
            }
            let Some(uid) = uid else {
                problem(&mut preview, index, None, "localId is missing".to_owned());
                return ControlFlow::Continue(());
            };
            if !uids.insert(uid.clone()) {
                problem(
                    &mut preview,
                    index,
                    Some(&uid),
                    format!("Another user in the file has the uid `{uid}`."),
                );
                return ControlFlow::Continue(());
            }
            let exists = view.index.contains(&uid);
            if exists {
                preview.existing_count += 1;
                if preview.existing.len() < LISTED {
                    preview.existing.push(uid.clone());
                }
                if options.mode == ImportMode::Skip {
                    return ControlFlow::Continue(());
                }
            }
            if let Some(email) = truthy_str(&user, "email") {
                let canonical = canonicalize_email(email);
                if !emails.insert(canonical.clone()) {
                    problem(
                        &mut preview,
                        index,
                        Some(&uid),
                        format!("Another user in the file has the email {canonical}."),
                    );
                    return ControlFlow::Continue(());
                }
                if let Some(owner) = view.index.uid_of_email(&canonical)
                    && *owner != *uid
                {
                    problem(
                        &mut preview,
                        index,
                        Some(&uid),
                        format!("((Auth Emulator does not support importing duplicate email: {canonical}))"),
                    );
                    return ControlFlow::Continue(());
                }
            }
            if let Some(phone) = truthy_str(&user, "phoneNumber")
                && !phones.insert(phone.to_owned())
            {
                problem(
                    &mut preview,
                    index,
                    Some(&uid),
                    format!("Another user in the file has the phone number {phone}."),
                );
                return ControlFlow::Continue(());
            }
            // batchCreate's own validation, against a scope that holds nothing.
            let mut scratch = AgentState::default();
            let mut scope = Scope::new_in(&mut scratch, project, tenant);
            if let Err(error) = import_one(&mut scope, &user, true, false) {
                problem(&mut preview, index, Some(&uid), error.message);
            }
            ControlFlow::Continue(())
        })
        .map_err(|error| read_failure(&error))?;
        preview.format = shape.format;
        preview.total = shape.users;
        let mut by_provider: Vec<ProviderCount> = providers
            .into_iter()
            .map(|(provider, users)| ProviderCount { provider, users })
            .collect();
        by_provider.sort_by(|left, right| {
            right
                .users
                .cmp(&left.users)
                .then_with(|| left.provider.cmp(&right.provider))
        });
        preview.by_provider = by_provider;
        preview.took = started.elapsed();
        Ok(preview)
    }

    /// Imports the file at `path` into `project` (or its `tenant`) in
    /// chunks of 2,000 users per critical section, reporting to `progress`
    /// (`done` counts imported, skipped and failed users) and stopping when
    /// it is cancelled. No lifecycle event fires. Synchronous: run it on a
    /// blocking thread.
    pub fn import_commit(
        &self,
        project: &str,
        tenant: Option<&str>,
        path: &Path,
        options: &ImportOptions,
        progress: &dyn BulkProgress,
    ) -> Result<ImportOutcome, ConsoleError> {
        let tenant = tenant.filter(|tenant| !tenant.is_empty());
        // The scope must exist (an unknown tenant is not created here).
        self.users(project, tenant)?;
        let mut call = ConsoleCall::start(
            self,
            "users.import",
            "/users:import",
            project,
            tenant,
            ConsoleOrigin::Write,
        );
        let mut outcome = ImportOutcome::default();
        let mut done = 0_u64;
        let mut chunk: Vec<(usize, JsonMap<String, JsonValue>)> = Vec::with_capacity(CHUNK);
        let mut failure: Option<ConsoleError> = None;
        let flush = |chunk: &mut Vec<(usize, JsonMap<String, JsonValue>)>,
                     outcome: &mut ImportOutcome,
                     done: &mut u64|
         -> Result<(), ConsoleError> {
            if chunk.is_empty() {
                return Ok(());
            }
            let mut failures: Vec<(String, String)> = Vec::new();
            let mut skipped = 0_u64;
            let imported = self
                .update_traced(call.trace(), |data| {
                    // Importing into the project creates it, as any write
                    // does; a tenant must exist.
                    let agent = data.agent(project);
                    if let Some(tenant) = tenant
                        && !agent.tenants.contains_key(tenant)
                    {
                        return Err(ConsoleError::unknown_tenant(tenant));
                    }
                    let mut scope = Scope::new_in(agent, project, tenant);
                    let mut imported = 0_u64;
                    for (index, user) in chunk.drain(..) {
                        let uid = str_field(&user, "localId").unwrap_or_default().to_owned();
                        if options.mode == ImportMode::Skip
                            && scope.project_ref().users.contains_key(&uid)
                        {
                            skipped += 1;
                            continue;
                        }
                        let user = prepared(user, options);
                        match import_one(
                            &mut scope,
                            &user,
                            options.mode == ImportMode::Overwrite,
                            false,
                        ) {
                            Ok(()) => imported += 1,
                            Err(error) => failures.push((format!("#{index} {uid}"), error.message)),
                        }
                    }
                    Ok(imported)
                })
                .map_err(|error| ConsoleError::of_kind(ConsoleErrorKind::Internal, error.0))??;
            let failed = u64::try_from(failures.len()).unwrap_or(u64::MAX);
            for (key, message) in &failures {
                progress.failed(key, message);
            }
            if skipped > 0 {
                progress.skipped(skipped);
            }
            outcome.imported += imported;
            outcome.skipped += skipped;
            outcome.failed += failed;
            *done += imported + skipped + failed;
            progress.progress(*done);
            std::thread::yield_now();
            Ok(())
        };
        let read = read_users(open(path)?, &mut |index, element| {
            if progress.cancelled() {
                return ControlFlow::Break(());
            }
            match element {
                Ok(user) => chunk.push((index, user)),
                Err(message) => {
                    progress.failed(&format!("#{index}"), &message);
                    outcome.failed += 1;
                    done += 1;
                }
            }
            if chunk.len() >= CHUNK
                && let Err(error) = flush(&mut chunk, &mut outcome, &mut done)
            {
                failure = Some(error);
                return ControlFlow::Break(());
            }
            ControlFlow::Continue(())
        });
        if let Some(error) = failure {
            call.finish(self, Some(&error));
            return Err(error);
        }
        match read {
            Ok(shape) => {
                progress.total(shape.users);
                flush(&mut chunk, &mut outcome, &mut done)?;
            }
            Err(error) if error.0 == STOPPED => outcome.cancelled = true,
            Err(error) => {
                let error = read_failure(&error);
                call.finish(self, Some(&error));
                return Err(error);
            }
        }
        call.describe(
            Some(users_phrase(
                usize::try_from(outcome.imported).unwrap_or(usize::MAX),
            )),
            None,
        );
        call.finish(self, None);
        Ok(outcome)
    }
}

#[cfg(test)]
#[path = "import_tests.rs"]
mod tests;
