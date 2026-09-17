// Phase G1 emulator oracle programs for Storage Security Rules.
//
// Each program installs a ruleset through `PUT /internal/setRules` and then
// issues raw HTTP requests against the official Storage emulator
// (firebase-tools 15.22.0 with cloud-storage-rules-runtime v1.1.3 and the
// official Firestore emulator registered for `firestore.*` callbacks). A step
// may carry its own ruleset so that one verdict localizes to one field of the
// request model. Nothing here asserts an expectation: the recording is the
// evidence and the invariants are written after review.

export const DEFAULT_BUCKET = "demo-synthetic-app.appspot.com";
export const ASSETS_BUCKET = "synthetic-objects.example.test";
export const THIRD_BUCKET = "unconfigured.example.test";
export const PROJECT_ID = "demo-fireside-phase-g-storage-rules";

export interface RulesFile {
  readonly name: string;
  readonly content: string;
  readonly resource?: string;
}

export type StepBody =
  | { readonly kind: "json"; readonly json: unknown }
  | { readonly kind: "text"; readonly text: string; readonly contentType: string }
  | {
      readonly kind: "multipart";
      readonly metadata: Readonly<Record<string, unknown>>;
      readonly text: string;
      readonly partContentType: string;
    };

export interface Step {
  readonly id: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /// Path with optional templates: `{{uploadUrl:<step>}}`, `{{uploadId:<step>}}`, `{{token:<step>}}`.
  readonly path: string;
  /// `@name` token reference (`Bearer`), `firebase:@name` (`Firebase` scheme), or a literal header value.
  readonly auth?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: StepBody;
  /// Ruleset installed before this step (replaces the program ruleset).
  readonly rules?: readonly RulesFile[];
  /// Firestore document written before this step (relative to the database root).
  readonly firestoreWrite?: { readonly path: string; readonly fields: Readonly<Record<string, unknown>> };
  readonly note?: string;
}

export interface Program {
  readonly id: string;
  readonly category: string;
  readonly description: string;
  readonly rules: readonly RulesFile[];
  readonly firestoreSeed?: ReadonlyArray<{ readonly path: string; readonly fields: Readonly<Record<string, unknown>> }>;
  readonly steps: readonly Step[];
}

export const SYNTAX_ERROR_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read: if request.auth != null &&;
    }
`;

export const ORACLE_CRASH_EMPTY_SEGMENT = {
  id: "object-name-with-empty-segment",
  request: { method: "POST", path: `/v0/b/${DEFAULT_BUCKET}/o?name=dbl%2F%2Fx.txt` },
  observed: "no HTTP response (client timeout); the rules runtime child exits",
  runtimeStderr: [
    "Exception in thread \"main\" java.lang.IllegalArgumentException: Path segment cannot be empty",
    "at com.google.firebase.rules.runtime.utils.PathUtils.parse(PathUtils.java:129)",
    "at com.google.firebase.rules.tools.local.server.ServerActionVerify.toNewPathValue(ServerActionVerify.java:43)",
  ],
  recordedOn: "2026-09-17",
} as const;

export const TOKEN_PAYLOADS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  alice: {
    sub: "alice",
    user_id: "alice",
    email: "alice@example.test",
    email_verified: true,
    firebase: { sign_in_provider: "password", identities: { email: ["alice@example.test"] } },
  },
  bob: {
    sub: "bob",
    user_id: "bob",
    email: "bob@example.test",
    email_verified: false,
    firebase: { sign_in_provider: "password", identities: { email: ["bob@example.test"] } },
  },
  admin: {
    sub: "admin-user",
    user_id: "admin-user",
    admin: true,
    firebase: { sign_in_provider: "custom", identities: {} },
  },
  subonly: {
    sub: "subonly",
    firebase: { sign_in_provider: "anonymous", identities: {} },
  },
  expired: {
    sub: "alice",
    user_id: "alice",
    firebase: { sign_in_provider: "password", identities: {} },
    expOverride: 1500000000,
  },
};

export function wrap(body: string, version: "1" | "2" = "2"): string {
  const head = version === "2" ? "rules_version = '2';\n" : "";
  return `${head}service firebase.storage {
  match /b/{bucket}/o {
${body}
  }
}
`;
}

export function allowAll(condition: string, methods = "read, write"): string {
  return wrap(`    match /{allPaths=**} {
      allow ${methods}: if ${condition};
    }`);
}

function single(content: string, name = "storage.rules"): readonly RulesFile[] {
  return [{ name, content }];
}

function v0Object(bucket: string, name: string, query = ""): string {
  return `/v0/b/${bucket}/o/${encodeURIComponent(name)}${query}`;
}

function v0Upload(bucket: string, name: string): string {
  return `/v0/b/${bucket}/o?name=${encodeURIComponent(name)}`;
}

function v0List(bucket: string, prefix: string, extra = ""): string {
  return `/v0/b/${bucket}/o?prefix=${encodeURIComponent(prefix)}&delimiter=%2F${extra}`;
}

function text(value: string, contentType = "text/plain"): StepBody {
  return { kind: "text", text: value, contentType };
}

function json(value: unknown): StepBody {
  return { kind: "json", json: value };
}

function multipart(
  metadata: Readonly<Record<string, unknown>>,
  value: string,
  partContentType = "text/plain",
): StepBody {
  return { kind: "multipart", metadata, text: value, partContentType };
}

const TWELVE = "twelve bytes";
const OWNER = "Bearer owner";

/// Seeds an object through the owner bypass so the program's ruleset never
/// sees the seeding write.
function seed(id: string, bucket: string, name: string, body: StepBody = text(TWELVE)): Step {
  return {
    id,
    method: "POST",
    path: v0Upload(bucket, name),
    auth: OWNER,
    ...(body.kind === "multipart" ? { headers: { "x-goog-upload-protocol": "multipart" } } : {}),
    body,
    note: "owner bypass seed",
  };
}

function probe(id: string, condition: string, step: Omit<Step, "id" | "rules">, methods = "read, write"): Step {
  return { id, rules: single(allowAll(condition, methods)), ...step };
}

const B = DEFAULT_BUCKET;
const A = ASSETS_BUCKET;

export const PROGRAMS: readonly Program[] = [
  // ------------------------------------------------------------- method model
  {
    id: "method-get-only",
    category: "method-model",
    description: "allow get admits metadata and media reads only",
    rules: single(allowAll("true", "get")),
    steps: [
      seed("seed", B, "m/get.txt"),
      { id: "get-metadata", method: "GET", path: v0Object(B, "m/get.txt"), auth: "@alice" },
      { id: "get-media", method: "GET", path: v0Object(B, "m/get.txt", "?alt=media"), auth: "@alice" },
      { id: "list-denied", method: "GET", path: v0List(B, "m/"), auth: "@alice" },
      { id: "patch-denied", method: "PATCH", path: v0Object(B, "m/get.txt"), auth: "@alice", body: json({ contentType: "text/html" }) },
      { id: "delete-denied", method: "DELETE", path: v0Object(B, "m/get.txt"), auth: "@alice" },
      { id: "create-denied", method: "POST", path: v0Upload(B, "m/new.txt"), auth: "@alice", body: text(TWELVE) },
    ],
  },
  {
    id: "method-list-only",
    category: "method-model",
    description: "allow list admits list on root and prefixes only",
    rules: single(allowAll("true", "list")),
    steps: [
      seed("seed", B, "l/one.txt"),
      { id: "list-root", method: "GET", path: `/v0/b/${B}/o?delimiter=%2F`, auth: "@alice" },
      { id: "list-prefix", method: "GET", path: v0List(B, "l/"), auth: "@alice" },
      { id: "list-prefix-no-delimiter", method: "GET", path: `/v0/b/${B}/o?prefix=l%2F`, auth: "@alice" },
      { id: "list-bad-prefix", method: "GET", path: `/v0/b/${B}/o?prefix=l`, auth: "@alice", note: "prefix without trailing slash" },
      { id: "get-denied", method: "GET", path: v0Object(B, "l/one.txt"), auth: "@alice" },
    ],
  },
  {
    id: "method-create-only",
    category: "method-model",
    description: "allow create admits uploads, including uploads over an existing object",
    rules: single(allowAll("true", "create")),
    steps: [
      { id: "create-new", method: "POST", path: v0Upload(B, "c/new.txt"), auth: "@alice", body: text(TWELVE) },
      { id: "create-over-existing", method: "POST", path: v0Upload(B, "c/new.txt"), auth: "@alice", body: text("overwritten!") },
      { id: "patch-denied", method: "PATCH", path: v0Object(B, "c/new.txt"), auth: "@alice", body: json({ contentType: "text/html" }) },
      { id: "delete-denied", method: "DELETE", path: v0Object(B, "c/new.txt"), auth: "@alice" },
      { id: "get-denied", method: "GET", path: v0Object(B, "c/new.txt"), auth: "@alice" },
    ],
  },
  {
    id: "method-update-only",
    category: "method-model",
    description: "allow update admits metadata PATCH but not an upload over an existing object",
    rules: single(allowAll("true", "update")),
    steps: [
      seed("seed", B, "u/obj.txt"),
      { id: "patch-allowed", method: "PATCH", path: v0Object(B, "u/obj.txt"), auth: "@alice", body: json({ contentType: "text/html", metadata: { k: "v" } }) },
      { id: "upload-over-existing-denied", method: "POST", path: v0Upload(B, "u/obj.txt"), auth: "@alice", body: text("overwritten!") },
      { id: "delete-denied", method: "DELETE", path: v0Object(B, "u/obj.txt"), auth: "@alice" },
      { id: "patch-missing-object", method: "PATCH", path: v0Object(B, "u/missing.txt"), auth: "@alice", body: json({ contentType: "text/html" }) },
    ],
  },
  {
    id: "method-delete-only",
    category: "method-model",
    description: "allow delete admits deletes; a missing object is 404 after the rules pass",
    rules: single(allowAll("true", "delete")),
    steps: [
      seed("seed", B, "d/obj.txt"),
      { id: "get-denied", method: "GET", path: v0Object(B, "d/obj.txt"), auth: "@alice" },
      { id: "delete-allowed", method: "DELETE", path: v0Object(B, "d/obj.txt"), auth: "@alice" },
      { id: "delete-missing", method: "DELETE", path: v0Object(B, "d/obj.txt"), auth: "@alice" },
    ],
  },
  {
    id: "method-read-write",
    category: "method-model",
    description: "allow read, write admits every operation",
    rules: single(allowAll("true")),
    steps: [
      { id: "create", method: "POST", path: v0Upload(B, "rw/obj.txt"), auth: "@alice", body: text(TWELVE) },
      { id: "get", method: "GET", path: v0Object(B, "rw/obj.txt"), auth: "@alice" },
      { id: "list", method: "GET", path: v0List(B, "rw/"), auth: "@alice" },
      { id: "patch", method: "PATCH", path: v0Object(B, "rw/obj.txt"), auth: "@alice", body: json({ metadata: { k: "v" } }) },
      { id: "delete", method: "DELETE", path: v0Object(B, "rw/obj.txt"), auth: "@alice" },
      { id: "anonymous-get-missing", method: "GET", path: v0Object(B, "rw/obj.txt") },
    ],
  },
  {
    id: "method-rules-version-1",
    category: "method-model",
    description: "a ruleset without rules_version = '2' loads, admits get, and denies list",
    rules: single(wrap(`    match /{allPaths=**} {
      allow read, write: if true;
    }`, "1")),
    steps: [
      seed("seed", B, "v1/obj.txt"),
      { id: "get", method: "GET", path: v0Object(B, "v1/obj.txt"), auth: "@alice" },
      { id: "list-denied", method: "GET", path: v0List(B, "v1/"), auth: "@alice" },
      { id: "create", method: "POST", path: v0Upload(B, "v1/new.txt"), auth: "@alice", body: text(TWELVE) },
    ],
  },

  // ------------------------------------------------ request.resource per method
  {
    id: "request-resource-create-media",
    category: "request-resource-per-method",
    description: "request.resource fields for a v0 media upload (no metadata part)",
    rules: single(allowAll("true", "create")),
    steps: [
      probe("size", "request.resource.size == 12", { method: "POST", path: v0Upload(B, "rr/size.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("size-is-int", "request.resource.size is int", { method: "POST", path: v0Upload(B, "rr/size-int.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("content-type-defaulted", "request.resource.contentType == 'application/octet-stream'", { method: "POST", path: v0Upload(B, "rr/ct.txt"), auth: "@alice", body: text(TWELVE, "text/plain") }, "create"),
      probe("content-type-header-ignored", "request.resource.contentType == 'text/plain'", { method: "POST", path: v0Upload(B, "rr/ct2.txt"), auth: "@alice", body: text(TWELVE, "text/plain") }, "create"),
      probe("name", "request.resource.name == 'rr/name.txt'", { method: "POST", path: v0Upload(B, "rr/name.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("bucket", `request.resource.bucket == '${B}' && request.resource.bucket == bucket`, { method: "POST", path: v0Upload(B, "rr/bucket.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("generation-int", "request.resource.generation is int && request.resource.generation > 0", { method: "POST", path: v0Upload(B, "rr/gen.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("metageneration-one", "request.resource.metageneration == 1", { method: "POST", path: v0Upload(B, "rr/metagen.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("time-created-timestamp", "request.resource.timeCreated is timestamp && request.resource.timeCreated <= request.time", { method: "POST", path: v0Upload(B, "rr/tc.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("updated-equals-created", "request.resource.updated == request.resource.timeCreated", { method: "POST", path: v0Upload(B, "rr/upd.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("md5-base64", "request.resource.md5Hash is string && request.resource.md5Hash.size() == 24", { method: "POST", path: v0Upload(B, "rr/md5.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("crc32c-string", "request.resource.crc32c is string", { method: "POST", path: v0Upload(B, "rr/crc.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("etag-string", "request.resource.etag is string && request.resource.etag.size() > 0", { method: "POST", path: v0Upload(B, "rr/etag.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("metadata-empty-map", "request.resource.metadata is map && request.resource.metadata.size() == 0", { method: "POST", path: v0Upload(B, "rr/meta.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("download-token-not-in-metadata", "!('firebaseStorageDownloadTokens' in request.resource.metadata)", { method: "POST", path: v0Upload(B, "rr/token.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("content-disposition-null", "request.resource.contentDisposition == null", { method: "POST", path: v0Upload(B, "rr/cd.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("content-disposition-in", "'contentDisposition' in request.resource", { method: "POST", path: v0Upload(B, "rr/cd2.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("content-encoding-null", "request.resource.contentEncoding == null", { method: "POST", path: v0Upload(B, "rr/ce.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("cache-control-absent", "!('cacheControl' in request.resource)", { method: "POST", path: v0Upload(B, "rr/cc.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("cache-control-access-error", "request.resource.cacheControl == null", { method: "POST", path: v0Upload(B, "rr/cc2.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("content-language-absent", "!('contentLanguage' in request.resource)", { method: "POST", path: v0Upload(B, "rr/cl.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
    ],
  },
  {
    id: "request-resource-create-shape",
    category: "request-resource-per-method",
    description: "key set, null stored resource, method and path for a create of a new object",
    rules: single(allowAll("true", "create")),
    steps: [
      probe("keys-count", "request.resource.keys().size() == 14", { method: "POST", path: v0Upload(B, "rr/keys.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("resource-null-for-new", "resource == null", { method: "POST", path: v0Upload(B, "rr/resnull.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("method-string", "request.method == 'create'", { method: "POST", path: v0Upload(B, "rr/method.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("path-segments", `request.path == /b/${B}/o/rr/path.txt && request.path[3] == 'rr'`, { method: "POST", path: v0Upload(B, "rr/path.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("empty-body-size-zero", "request.resource.size == 0", { method: "POST", path: v0Upload(B, "rr/empty.txt"), auth: "@alice", body: text("") }, "create"),
    ],
  },
  {
    id: "request-resource-create-multipart",
    category: "request-resource-per-method",
    description: "request.resource fields for a v0 multipart upload carrying a metadata part",
    rules: single(allowAll("true", "create")),
    steps: [
      probe("content-type-from-metadata", "request.resource.contentType == 'text/plain'", { method: "POST", path: v0Upload(B, "mp/ct.txt"), auth: "@alice", headers: { "x-goog-upload-protocol": "multipart" }, body: multipart({ name: "mp/ct.txt", contentType: "text/plain" }, TWELVE) }, "create"),
      probe("custom-metadata", "request.resource.metadata.owner == 'alice' && request.resource.metadata.size() == 2", { method: "POST", path: v0Upload(B, "mp/meta.txt"), auth: "@alice", headers: { "x-goog-upload-protocol": "multipart" }, body: multipart({ name: "mp/meta.txt", contentType: "text/plain", metadata: { owner: "alice", version: "3" } }, TWELVE) }, "create"),
      probe("custom-metadata-strings", "request.resource.metadata.version is string && request.resource.metadata.flag is string", { method: "POST", path: v0Upload(B, "mp/meta-types.txt"), auth: "@alice", headers: { "x-goog-upload-protocol": "multipart" }, body: multipart({ name: "mp/meta-types.txt", contentType: "text/plain", metadata: { version: 3, flag: true } }, TWELVE) }, "create"),
      probe("content-disposition", "request.resource.contentDisposition == 'attachment'", { method: "POST", path: v0Upload(B, "mp/cd.txt"), auth: "@alice", headers: { "x-goog-upload-protocol": "multipart" }, body: multipart({ name: "mp/cd.txt", contentType: "text/plain", contentDisposition: "attachment" }, TWELVE) }, "create"),
      probe("content-encoding", "request.resource.contentEncoding == 'gzip'", { method: "POST", path: v0Upload(B, "mp/ce.txt"), auth: "@alice", headers: { "x-goog-upload-protocol": "multipart" }, body: multipart({ name: "mp/ce.txt", contentType: "text/plain", contentEncoding: "gzip" }, TWELVE) }, "create"),
      probe("cache-control-not-exposed", "!('cacheControl' in request.resource)", { method: "POST", path: v0Upload(B, "mp/cc.txt"), auth: "@alice", headers: { "x-goog-upload-protocol": "multipart" }, body: multipart({ name: "mp/cc.txt", contentType: "text/plain", cacheControl: "no-store" }, TWELVE) }, "create"),
      probe("content-language-not-exposed", "!('contentLanguage' in request.resource)", { method: "POST", path: v0Upload(B, "mp/cl.txt"), auth: "@alice", headers: { "x-goog-upload-protocol": "multipart" }, body: multipart({ name: "mp/cl.txt", contentType: "text/plain", contentLanguage: "ja" }, TWELVE) }, "create"),
      probe("name-from-metadata", "request.resource.name == 'mp/named.txt'", { method: "POST", path: v0Upload(B, "mp/named.txt"), auth: "@alice", headers: { "x-goog-upload-protocol": "multipart" }, body: multipart({ name: "mp/named.txt", contentType: "text/plain" }, TWELVE) }, "create"),
      probe("size-of-part", "request.resource.size == 12", { method: "POST", path: v0Upload(B, "mp/size.txt"), auth: "@alice", headers: { "x-goog-upload-protocol": "multipart" }, body: multipart({ name: "mp/size.txt", contentType: "text/plain" }, TWELVE) }, "create"),
      probe("download-token-in-metadata-stripped", "!('firebaseStorageDownloadTokens' in request.resource.metadata)", { method: "POST", path: v0Upload(B, "mp/tok.txt"), auth: "@alice", headers: { "x-goog-upload-protocol": "multipart" }, body: multipart({ name: "mp/tok.txt", contentType: "text/plain", metadata: { firebaseStorageDownloadTokens: "synthetic-token" } }, TWELVE) }, "create"),
    ],
  },
  {
    id: "request-resource-update-patch",
    category: "resource-on-update-and-delete",
    description: "resource and request.resource on a metadata PATCH",
    rules: single(allowAll("true")),
    steps: [
      seed("seed", B, "up/obj.txt", multipart({ name: "up/obj.txt", contentType: "text/plain", metadata: { owner: "alice" } }, TWELVE)),
      probe("method-update", "request.method == 'update'", { method: "PATCH", path: v0Object(B, "up/obj.txt"), auth: "@alice", body: json({ metadata: { k: "v" } }) }, "update"),
      probe("before-content-type", "resource.contentType == 'text/plain'", { method: "PATCH", path: v0Object(B, "up/obj.txt"), auth: "@alice", body: json({ contentType: "text/html" }) }, "update"),
      probe("after-content-type", "request.resource.contentType == 'text/markdown'", { method: "PATCH", path: v0Object(B, "up/obj.txt"), auth: "@alice", body: json({ contentType: "text/markdown" }) }, "update"),
      probe("after-metadata-merged", "request.resource.metadata.owner == 'alice' && request.resource.metadata.k == 'v2'", { method: "PATCH", path: v0Object(B, "up/obj.txt"), auth: "@alice", body: json({ metadata: { k: "v2" } }) }, "update"),
      probe("after-metadata-removed", "!('k' in request.resource.metadata) && 'k' in resource.metadata", { method: "PATCH", path: v0Object(B, "up/obj.txt"), auth: "@alice", body: json({ metadata: { k: null } }) }, "update"),
      probe("after-metageneration-increment", "request.resource.metageneration == resource.metageneration + 1", { method: "PATCH", path: v0Object(B, "up/obj.txt"), auth: "@alice", body: json({ metadata: { k: "v" } }) }, "update"),
      probe("after-updated-later", "request.resource.updated >= resource.updated && request.resource.timeCreated == resource.timeCreated", { method: "PATCH", path: v0Object(B, "up/obj.txt"), auth: "@alice", body: json({ metadata: { k: "v" } }) }, "update"),
      probe("size-and-hashes-stable", "request.resource.size == resource.size && request.resource.md5Hash == resource.md5Hash && request.resource.generation == resource.generation", { method: "PATCH", path: v0Object(B, "up/obj.txt"), auth: "@alice", body: json({ metadata: { k: "v" } }) }, "update"),
      probe("content-type-null-removes", "request.resource.contentType == null && 'contentType' in request.resource", { method: "PATCH", path: v0Object(B, "up/obj.txt"), auth: "@alice", body: json({ contentType: null }) }, "update"),
      probe("after-cache-control-not-exposed", "!('cacheControl' in request.resource)", { method: "PATCH", path: v0Object(B, "up/obj.txt"), auth: "@alice", body: json({ cacheControl: "no-store" }) }, "update"),
      probe("metadata-diff", "request.resource.metadata.diff(resource.metadata).affectedKeys().hasOnly(['z'])", { method: "PATCH", path: v0Object(B, "up/obj.txt"), auth: "@alice", body: json({ metadata: { z: "1" } }) }, "update"),
      probe("denied-patch-leaves-object", "false", { method: "PATCH", path: v0Object(B, "up/obj.txt"), auth: "@alice", body: json({ metadata: { z: "9" } }) }, "update"),
      { id: "final-metadata", method: "GET", path: v0Object(B, "up/obj.txt"), auth: OWNER },
    ],
  },
  {
    id: "request-resource-get-list-delete",
    category: "resource-on-update-and-delete",
    description: "resource and request.resource on get, list and delete",
    rules: single(allowAll("true")),
    steps: [
      seed("seed", B, "gl/obj.txt"),
      probe("get-request-resource-null", "request.resource == null", { method: "GET", path: v0Object(B, "gl/obj.txt"), auth: "@alice" }, "get"),
      probe("get-request-resource-field-error", "request.resource.size == 12", { method: "GET", path: v0Object(B, "gl/obj.txt"), auth: "@alice" }, "get"),
      probe("get-resource-fields", "resource.size == 12 && resource.name == 'gl/obj.txt' && resource.contentType == 'application/octet-stream'", { method: "GET", path: v0Object(B, "gl/obj.txt"), auth: "@alice" }, "get"),
      probe("get-resource-timestamps", "resource.timeCreated is timestamp && resource.updated is timestamp && resource.timeCreated <= request.time", { method: "GET", path: v0Object(B, "gl/obj.txt"), auth: "@alice" }, "get"),
      probe("get-resource-typed", "resource.generation is int && resource.metageneration is int && resource.md5Hash is string && resource.crc32c is string && resource.etag is string && resource.metadata is map", { method: "GET", path: v0Object(B, "gl/obj.txt"), auth: "@alice" }, "get"),
      probe("get-media-uses-get", "request.method == 'get'", { method: "GET", path: v0Object(B, "gl/obj.txt", "?alt=media"), auth: "@alice" }, "get"),
      probe("list-both-null", "resource == null && request.resource == null", { method: "GET", path: v0List(B, "gl/"), auth: "@alice" }, "list"),
      probe("list-resource-field-error", "resource.size == 12", { method: "GET", path: v0List(B, "gl/"), auth: "@alice" }, "list"),
      probe("list-method-string", "request.method == 'list'", { method: "GET", path: v0List(B, "gl/"), auth: "@alice" }, "list"),
      probe("list-path-prefix-without-slash", `request.path == /b/${B}/o/gl`, { method: "GET", path: v0List(B, "gl/"), auth: "@alice" }, "list"),
      probe("list-path-root", `request.path == /b/${B}/o`, { method: "GET", path: `/v0/b/${B}/o?delimiter=%2F`, auth: "@alice" }, "list"),
      probe("list-path-nested-prefix", `request.path == /b/${B}/o/gl/deeper`, { method: "GET", path: v0List(B, "gl/deeper/"), auth: "@alice" }, "list"),
      probe("list-root-matches-recursive-zero-segments", "true", { method: "GET", path: `/v0/b/${B}/o?delimiter=%2F`, auth: "@alice" }, "list"),
      probe("delete-resource-present", "resource.size == 12 && request.resource == null", { method: "DELETE", path: v0Object(B, "gl/obj.txt"), auth: "@alice" }, "delete"),
      probe("delete-missing-resource-null", "resource == null", { method: "DELETE", path: v0Object(B, "gl/obj.txt"), auth: "@alice" }, "delete"),
      probe("delete-missing-field-error", "resource.size == 12", { method: "DELETE", path: v0Object(B, "gl/obj.txt"), auth: "@alice" }, "delete"),
      probe("get-missing-resource-null", "resource == null", { method: "GET", path: v0Object(B, "gl/obj.txt"), auth: "@alice" }, "get"),
      probe("get-missing-field-error", "resource.size == 12", { method: "GET", path: v0Object(B, "gl/obj.txt"), auth: "@alice" }, "get"),
      probe("get-missing-allowed", "true", { method: "GET", path: v0Object(B, "gl/obj.txt"), auth: "@alice" }, "get"),
    ],
  },

  // ------------------------------------------------------------ upload paths
  {
    id: "upload-paths",
    category: "upload-paths",
    description: "media, multipart and resumable uploads are checked once, at finalize, with the received bytes",
    rules: single(allowAll("request.resource.size < 20 && request.resource.contentType == 'text/plain'", "create")),
    steps: [
      { id: "media-denied-octet-stream", method: "POST", path: v0Upload(B, "res/media.txt"), auth: "@alice", body: text(TWELVE) },
      { id: "multipart-allowed", method: "POST", path: v0Upload(B, "res/mp.txt"), auth: "@alice", headers: { "x-goog-upload-protocol": "multipart" }, body: multipart({ name: "res/mp.txt", contentType: "text/plain" }, TWELVE) },
      { id: "multipart-denied-too-large", method: "POST", path: v0Upload(B, "res/mp-large.txt"), auth: "@alice", headers: { "x-goog-upload-protocol": "multipart" }, body: multipart({ name: "res/mp-large.txt", contentType: "text/plain" }, "x".repeat(30)) },
      { id: "resumable-start", method: "POST", path: v0Upload(B, "res/resumable.txt"), auth: "@alice", headers: { "x-goog-upload-protocol": "resumable", "x-goog-upload-command": "start" }, body: json({ name: "res/resumable.txt", contentType: "text/plain" }) },
      { id: "resumable-upload-chunk", method: "POST", path: "{{uploadUrl:resumable-start}}", auth: "@alice", headers: { "x-goog-upload-command": "upload", "x-goog-upload-offset": "0" }, body: text("chunk-one|") },
      { id: "resumable-query", method: "POST", path: "{{uploadUrl:resumable-start}}", auth: "@alice", headers: { "x-goog-upload-command": "query" } },
      { id: "resumable-finalize-allowed", method: "POST", path: "{{uploadUrl:resumable-start}}", auth: "@alice", headers: { "x-goog-upload-command": "upload, finalize", "x-goog-upload-offset": "10" }, body: text("two") },
      { id: "resumable-large-start", method: "POST", path: v0Upload(B, "res/large.txt"), auth: "@alice", headers: { "x-goog-upload-protocol": "resumable", "x-goog-upload-command": "start" }, body: json({ name: "res/large.txt", contentType: "text/plain" }) },
      { id: "resumable-large-upload", method: "POST", path: "{{uploadUrl:resumable-large-start}}", auth: "@alice", headers: { "x-goog-upload-command": "upload", "x-goog-upload-offset": "0" }, body: text("x".repeat(25)) },
      { id: "resumable-large-finalize-denied", method: "POST", path: "{{uploadUrl:resumable-large-start}}", auth: "@alice", headers: { "x-goog-upload-command": "finalize" } },
      { id: "resumable-large-query-after-denial", method: "POST", path: "{{uploadUrl:resumable-large-start}}", auth: "@alice", headers: { "x-goog-upload-command": "query" } },
      { id: "resumable-large-finalize-again", method: "POST", path: "{{uploadUrl:resumable-large-start}}", auth: "@alice", headers: { "x-goog-upload-command": "finalize" } },
      { id: "resumable-large-object-absent", method: "GET", path: v0Object(B, "res/large.txt"), auth: OWNER },
      { id: "resumable-anonymous-start-not-checked", method: "POST", path: v0Upload(B, "res/anon.txt"), headers: { "x-goog-upload-protocol": "resumable", "x-goog-upload-command": "start" }, body: json({ name: "res/anon.txt", contentType: "text/plain" }), rules: single(allowAll("request.auth != null", "create")) },
      { id: "resumable-anonymous-finalize-denied", method: "POST", path: "{{uploadUrl:resumable-anonymous-start-not-checked}}", headers: { "x-goog-upload-command": "upload, finalize", "x-goog-upload-offset": "0" }, body: text(TWELVE) },
      { id: "resumable-auth-captured-at-start", method: "POST", path: v0Upload(B, "res/auth-start.txt"), auth: "@alice", headers: { "x-goog-upload-protocol": "resumable", "x-goog-upload-command": "start" }, body: json({ name: "res/auth-start.txt", contentType: "text/plain" }), rules: single(allowAll("request.auth.uid == 'alice'", "create")) },
      { id: "resumable-auth-captured-finalize-as-bob", method: "POST", path: "{{uploadUrl:resumable-auth-captured-at-start}}", auth: "@bob", headers: { "x-goog-upload-command": "upload, finalize", "x-goog-upload-offset": "0" }, body: text(TWELVE), note: "the emulator stores the start authorization on the upload" },
      { id: "resumable-cancel", method: "POST", path: v0Upload(B, "res/cancel.txt"), auth: "@alice", headers: { "x-goog-upload-protocol": "resumable", "x-goog-upload-command": "start" }, body: json({ name: "res/cancel.txt", contentType: "text/plain" }) },
      { id: "resumable-cancel-command", method: "POST", path: "{{uploadUrl:resumable-cancel}}", auth: "@alice", headers: { "x-goog-upload-command": "cancel" } },
      { id: "resumable-cancelled-finalize", method: "POST", path: "{{uploadUrl:resumable-cancel}}", auth: "@alice", headers: { "x-goog-upload-command": "finalize" } },
      { id: "gcs-resumable-not-checked", method: "POST", path: `/upload/storage/v1/b/${B}/o?uploadType=resumable&name=${encodeURIComponent("res/gcs.txt")}`, body: json({ name: "res/gcs.txt", contentType: "video/mp4" }), headers: { "x-upload-content-type": "video/mp4" } },
      { id: "gcs-resumable-finalize-bypasses-rules", method: "PUT", path: "{{uploadUrl:gcs-resumable-not-checked}}", body: text("x".repeat(40), "video/mp4") },
    ],
  },
  {
    id: "upload-over-existing",
    category: "upload-paths",
    description: "an upload over an existing object is checked as create with resource set to the stored object",
    rules: single(allowAll("resource == null", "create")),
    steps: [
      { id: "first-upload", method: "POST", path: v0Upload(B, "ov/obj.txt"), auth: "@alice", body: text(TWELVE) },
      { id: "overwrite-denied-resource-present", method: "POST", path: v0Upload(B, "ov/obj.txt"), auth: "@alice", body: text("overwritten!") },
      probe("overwrite-denied-under-update-only", "true", { method: "POST", path: v0Upload(B, "ov/obj.txt"), auth: "@alice", body: text("overwritten!") }, "update"),
      probe("overwrite-method-is-create", "request.method == 'create' && resource != null", { method: "POST", path: v0Upload(B, "ov/obj.txt"), auth: "@alice", body: text("overwritten!") }, "create"),
      probe("overwrite-resource-is-previous", "resource.size == 12 && request.resource.size == 12 && resource.generation != request.resource.generation", { method: "POST", path: v0Upload(B, "ov/obj.txt"), auth: "@alice", body: text("overwritten!") }, "create"),
      probe("overwrite-metadata-not-merged", "!('k' in request.resource.metadata)", { method: "PATCH", path: v0Object(B, "ov/obj.txt"), auth: OWNER, body: json({ metadata: { k: "v" } }) }, "update"),
      probe("overwrite-metadata-not-merged-check", "!('k' in request.resource.metadata) && 'k' in resource.metadata", { method: "POST", path: v0Upload(B, "ov/obj.txt"), auth: "@alice", body: text("overwritten!") }, "create"),
      { id: "final-object", method: "GET", path: v0Object(B, "ov/obj.txt"), auth: OWNER },
    ],
  },

  // -------------------------------------------------------------- auth shapes
  {
    id: "auth-shapes",
    category: "auth-shapes",
    description: "request.auth derivation from the Authorization header",
    rules: single(allowAll("request.auth.uid == 'alice'", "get")),
    steps: [
      seed("seed", B, "auth/obj.txt"),
      { id: "anonymous-denied", method: "GET", path: v0Object(B, "auth/obj.txt") },
      { id: "bearer-alice", method: "GET", path: v0Object(B, "auth/obj.txt"), auth: "@alice" },
      { id: "firebase-scheme-alice", method: "GET", path: v0Object(B, "auth/obj.txt"), auth: "firebase:@alice" },
      { id: "bearer-bob-denied", method: "GET", path: v0Object(B, "auth/obj.txt"), auth: "@bob" },
      { id: "sub-only-uid-null-denied", method: "GET", path: v0Object(B, "auth/obj.txt"), auth: "@subonly" },
      probe("sub-only-uid-is-null", "request.auth != null && request.auth.uid == null && request.auth.token.sub == 'subonly'", { method: "GET", path: v0Object(B, "auth/obj.txt"), auth: "@subonly" }, "get"),
    ],
  },
  {
    id: "auth-token-claims",
    category: "auth-shapes",
    description: "request.auth.token is the raw claim map; custom claims, identities, standard claims, expiry",
    rules: single(allowAll("request.auth.uid == 'alice'", "get")),
    steps: [
      seed("seed", B, "auth/obj.txt"),
      probe("token-is-full-payload", "request.auth.token.email == 'alice@example.test' && request.auth.token.email_verified == true && request.auth.token.firebase.sign_in_provider == 'password'", { method: "GET", path: v0Object(B, "auth/obj.txt"), auth: "@alice" }, "get"),
      probe("token-standard-claims", "request.auth.token.iat is int && request.auth.token.exp is int && request.auth.token.aud == '" + PROJECT_ID + "' && request.auth.token.user_id == 'alice'", { method: "GET", path: v0Object(B, "auth/obj.txt"), auth: "@alice" }, "get"),
      probe("token-identities-list", "request.auth.token.firebase.identities.email[0] == 'alice@example.test'", { method: "GET", path: v0Object(B, "auth/obj.txt"), auth: "@alice" }, "get"),
      probe("custom-claim-admin", "request.auth.token.admin == true", { method: "GET", path: v0Object(B, "auth/obj.txt"), auth: "@admin" }, "get"),
      probe("custom-claim-missing-error", "request.auth.token.admin == true", { method: "GET", path: v0Object(B, "auth/obj.txt"), auth: "@alice" }, "get"),
      probe("anonymous-auth-null", "request.auth == null", { method: "GET", path: v0Object(B, "auth/obj.txt") }, "get"),
      probe("anonymous-uid-error", "request.auth.uid == null", { method: "GET", path: v0Object(B, "auth/obj.txt") }, "get"),
      probe("malformed-token-auth-null", "request.auth == null", { method: "GET", path: v0Object(B, "auth/obj.txt"), auth: "Bearer not-a-jwt" }, "get"),
      probe("basic-scheme-auth-null", "request.auth == null", { method: "GET", path: v0Object(B, "auth/obj.txt"), auth: "Basic YWxpY2U6c2VjcmV0" }, "get"),
      probe("bearer-only-auth-null", "request.auth == null", { method: "GET", path: v0Object(B, "auth/obj.txt"), auth: "Bearer" }, "get"),
      probe("expired-token-accepted", "request.auth.uid == 'alice' && request.auth.token.exp < request.time.toMillis() / 1000", { method: "GET", path: v0Object(B, "auth/obj.txt"), auth: "@expired" }, "get"),
      probe("token-keys", "request.auth.token.keys().hasAll(['sub', 'user_id', 'iat', 'exp'])", { method: "GET", path: v0Object(B, "auth/obj.txt"), auth: "@alice" }, "get"),
      probe("auth-keys", "request.auth.keys().hasOnly(['uid', 'token'])", { method: "GET", path: v0Object(B, "auth/obj.txt"), auth: "@alice" }, "get"),
    ],
  },

  // ------------------------------------------------------------------ bypasses
  {
    id: "bypass-owner-and-download-tokens",
    category: "bypasses",
    description: "owner credentials, download tokens and admin-only routes under a deny-all ruleset",
    rules: single(allowAll("false")),
    steps: [
      { id: "owner-upload", method: "POST", path: v0Upload(B, "by/obj.txt"), auth: OWNER, body: text(TWELVE) },
      { id: "firebase-owner-get", method: "GET", path: v0Object(B, "by/obj.txt"), auth: "Firebase owner" },
      { id: "alice-get-denied", method: "GET", path: v0Object(B, "by/obj.txt"), auth: "@alice" },
      { id: "token-download", method: "GET", path: v0Object(B, "by/obj.txt", "?alt=media&token={{token:owner-upload}}") },
      { id: "token-metadata", method: "GET", path: v0Object(B, "by/obj.txt", "?token={{token:owner-upload}}") },
      { id: "wrong-token-denied", method: "GET", path: v0Object(B, "by/obj.txt", "?alt=media&token=not-a-token") },
      { id: "token-does-not-cover-patch", method: "PATCH", path: v0Object(B, "by/obj.txt", "?token={{token:owner-upload}}"), body: json({ metadata: { k: "v" } }) },
      { id: "token-does-not-cover-delete", method: "DELETE", path: v0Object(B, "by/obj.txt", "?token={{token:owner-upload}}") },
      { id: "create-token-alice-denied", method: "POST", path: v0Object(B, "by/obj.txt", "?create_token=true"), auth: "@alice", body: json({}) },
      probe("create-token-alice-denied-even-when-rules-allow", "true", { method: "POST", path: v0Object(B, "by/obj.txt", "?create_token=true"), auth: "@alice", body: json({}) }),
      { id: "create-token-owner", method: "POST", path: v0Object(B, "by/obj.txt", "?create_token=true"), auth: OWNER, body: json({}) },
      { id: "delete-token-alice-denied", method: "POST", path: v0Object(B, "by/obj.txt", "?delete_token={{token:owner-upload}}"), auth: "@alice", body: json({}) },
      { id: "copy-alice-denied", method: "POST", path: `/b/${B}/o/${encodeURIComponent("by/obj.txt")}/copyTo/b/${B}/o/${encodeURIComponent("by/copy.txt")}`, auth: "@alice", body: json({}) },
      { id: "owner-delete", method: "DELETE", path: v0Object(B, "by/obj.txt"), auth: OWNER },
    ],
  },
  {
    id: "bypass-json-api",
    category: "bypasses",
    description: "the GCS JSON API never consults rules, with or without a user token",
    rules: single(allowAll("false")),
    steps: [
      { id: "json-media-upload-anonymous", method: "POST", path: `/upload/storage/v1/b/${B}/o?uploadType=media&name=${encodeURIComponent("js/obj.txt")}`, body: text(TWELVE) },
      { id: "json-get-metadata-anonymous", method: "GET", path: `/storage/v1/b/${B}/o/${encodeURIComponent("js/obj.txt")}` },
      { id: "json-download-anonymous", method: "GET", path: `/download/storage/v1/b/${B}/o/${encodeURIComponent("js/obj.txt")}?alt=media` },
      { id: "json-list-anonymous", method: "GET", path: `/storage/v1/b/${B}/o?prefix=js%2F` },
      { id: "json-patch-anonymous", method: "PATCH", path: `/storage/v1/b/${B}/o/${encodeURIComponent("js/obj.txt")}`, body: json({ metadata: { k: "v" } }) },
      { id: "json-get-with-user-token", method: "GET", path: `/storage/v1/b/${B}/o/${encodeURIComponent("js/obj.txt")}`, auth: "@alice" },
      { id: "json-upload-with-user-token", method: "POST", path: `/upload/storage/v1/b/${B}/o?uploadType=media&name=${encodeURIComponent("js/alice.txt")}`, auth: "@alice", body: text(TWELVE) },
      { id: "json-delete-anonymous", method: "DELETE", path: `/storage/v1/b/${B}/o/${encodeURIComponent("js/obj.txt")}` },
      { id: "v0-get-of-json-object-denied", method: "GET", path: v0Object(B, "js/alice.txt"), auth: "@alice" },
    ],
  },

  // ---------------------------------------------------------- firestore access
  {
    id: "firestore-get-exists",
    category: "firestore-access",
    description: "firestore.get and firestore.exists read the registered Firestore emulator at request time",
    rules: single(allowAll("firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.admin == true", "get")),
    firestoreSeed: [
      { path: "users/alice", fields: { admin: { booleanValue: true }, quota: { integerValue: "3" }, name: { stringValue: "Alice" }, tags: { arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] } }, profile: { mapValue: { fields: { role: { stringValue: "editor" } } } } } },
    ],
    steps: [
      seed("seed", B, "fs/obj.txt"),
      { id: "get-admin-true", method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" },
      { id: "get-missing-doc-bob", method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@bob" },
      probe("exists-true", "firestore.exists(/databases/(default)/documents/users/$(request.auth.uid))", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("exists-false", "firestore.exists(/databases/(default)/documents/users/$(request.auth.uid))", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@bob" }, "get"),
      probe("exists-false-negated", "!firestore.exists(/databases/(default)/documents/users/$(request.auth.uid))", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@bob" }, "get"),
      probe("data-int", "firestore.get(/databases/(default)/documents/users/alice).data.quota is int && firestore.get(/databases/(default)/documents/users/alice).data.quota == 3", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("data-string-list-map", "firestore.get(/databases/(default)/documents/users/alice).data.name == 'Alice' && firestore.get(/databases/(default)/documents/users/alice).data.tags[1] == 'b' && firestore.get(/databases/(default)/documents/users/alice).data.profile.role == 'editor'", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("data-missing-field-error", "firestore.get(/databases/(default)/documents/users/alice).data.missing == true", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("data-keys", "firestore.get(/databases/(default)/documents/users/alice).data.keys().hasAll(['admin', 'quota', 'name'])", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
    ],
  },
  {
    id: "firestore-document-shape",
    category: "firestore-access",
    description: "the value returned by firestore.get: id, __name__, map shape, path forms",
    rules: single(allowAll("true", "get")),
    firestoreSeed: [
      { path: "users/alice", fields: { admin: { booleanValue: true }, quota: { integerValue: "3" }, name: { stringValue: "Alice" } } },
    ],
    steps: [
      seed("seed", B, "fs/obj.txt"),
      probe("document-id", "firestore.get(/databases/(default)/documents/users/alice).id == 'alice'", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("document-name", "firestore.get(/databases/(default)/documents/users/alice).__name__ == /databases/(default)/documents/users/alice", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("document-name-is-path", "firestore.get(/databases/(default)/documents/users/alice).__name__ is path", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("document-name-first-segment-projects", "firestore.get(/databases/(default)/documents/users/alice).__name__[0] == 'projects'", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("document-name-first-segment-databases", "firestore.get(/databases/(default)/documents/users/alice).__name__[0] == 'databases'", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("document-name-project-form", `firestore.get(/databases/(default)/documents/users/alice).__name__ == /projects/${PROJECT_ID}/databases/(default)/documents/users/alice`, { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("document-is-map", "firestore.get(/databases/(default)/documents/users/alice) is map", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("document-keys", "firestore.get(/databases/(default)/documents/users/alice).keys().hasAll(['data'])", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("wrong-database-path", "firestore.get(/databases/other/documents/users/alice).data.admin == true", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("path-without-databases-prefix", "firestore.get(/users/alice).data.admin == true", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("get-missing-document-error", "firestore.get(/databases/(default)/documents/users/nobody).data.admin == true", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("get-missing-document-guarded", "!firestore.exists(/databases/(default)/documents/users/nobody) || firestore.get(/databases/(default)/documents/users/nobody).data.admin == true", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
    ],
  },
  {
    id: "firestore-access-limits",
    category: "firestore-access",
    description: "latest-state reads, repeated and many distinct firestore.* accesses in one request, bare get/exists, other methods",
    rules: single(allowAll("true", "get")),
    firestoreSeed: [
      { path: "users/alice", fields: { admin: { booleanValue: true }, quota: { integerValue: "3" } } },
      ...Array.from({ length: 21 }, (_, i) => ({ path: `limits/d${i + 1}`, fields: { n: { integerValue: String(i + 1) } } })),
    ],
    steps: [
      seed("seed", B, "fs/obj.txt"),
      probe("latest-state-before-write", "firestore.get(/databases/(default)/documents/users/alice).data.quota == 3", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      { id: "latest-state-after-write", method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice", firestoreWrite: { path: "users/alice", fields: { admin: { booleanValue: true }, quota: { integerValue: "1" } } }, note: "same ruleset; the document changed after the ruleset loaded" },
      probe("one-access", "firestore.get(/databases/(default)/documents/limits/d1).data.n == 1", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("two-accesses", "firestore.get(/databases/(default)/documents/limits/d1).data.n == 1 && firestore.get(/databases/(default)/documents/limits/d2).data.n == 2", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("three-accesses", "firestore.get(/databases/(default)/documents/limits/d1).data.n == 1 && firestore.get(/databases/(default)/documents/limits/d2).data.n == 2 && firestore.get(/databases/(default)/documents/limits/d3).data.n == 3", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("four-accesses", "firestore.get(/databases/(default)/documents/limits/d1).data.n == 1 && firestore.get(/databases/(default)/documents/limits/d2).data.n == 2 && firestore.get(/databases/(default)/documents/limits/d3).data.n == 3 && firestore.get(/databases/(default)/documents/limits/d4).data.n == 4", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("ten-accesses", Array.from({ length: 10 }, (_, i) => `firestore.get(/databases/(default)/documents/limits/d${i + 1}).data.n == ${i + 1}`).join(" && "), { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("eleven-accesses", Array.from({ length: 11 }, (_, i) => `firestore.get(/databases/(default)/documents/limits/d${i + 1}).data.n == ${i + 1}`).join(" && "), { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("twenty-one-accesses", Array.from({ length: 21 }, (_, i) => `firestore.get(/databases/(default)/documents/limits/d${i + 1}).data.n == ${i + 1}`).join(" && "), { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("repeated-access-cached", "firestore.get(/databases/(default)/documents/limits/d1).data.n == 1 && firestore.get(/databases/(default)/documents/limits/d1).data.n == 1 && firestore.get(/databases/(default)/documents/limits/d1).data.n == 1 && firestore.get(/databases/(default)/documents/limits/d1).data.n == 1", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("exists-and-get-same-doc", "firestore.exists(/databases/(default)/documents/limits/d1) && firestore.get(/databases/(default)/documents/limits/d1).data.n == 1 && firestore.get(/databases/(default)/documents/limits/d2).data.n == 2", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("bare-get-unavailable", "get(/databases/(default)/documents/users/alice).data.admin == true", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("bare-exists-unavailable", "exists(/databases/(default)/documents/users/alice)", { method: "GET", path: v0Object(B, "fs/obj.txt"), auth: "@alice" }, "get"),
      probe("firestore-on-create", "firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.quota > 0 && request.resource.size < 100", { method: "POST", path: v0Upload(B, "fs/new.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("firestore-on-list", "firestore.exists(/databases/(default)/documents/users/$(request.auth.uid))", { method: "GET", path: v0List(B, "fs/"), auth: "@alice" }, "list"),
      probe("firestore-with-anonymous-uid-error", "firestore.exists(/databases/(default)/documents/users/$(request.auth.uid))", { method: "GET", path: v0Object(B, "fs/obj.txt") }, "get"),
    ],
  },

  // ------------------------------------------------------------ path matching
  // Not recorded live: an object name with an empty segment (`dbl//x.txt`)
  // makes the official rules runtime jar exit with
  // "java.lang.IllegalArgumentException: Path segment cannot be empty" and the
  // emulator never answers the request. See ORACLE_CRASH_EMPTY_SEGMENT.
  {
    id: "path-matching",
    category: "path-matching",
    description: "single and recursive wildcards, bindings, unicode names, and list prefixes",
    rules: single(wrap(`    match /users/{uid}/{allPaths=**} {
      allow read, write: if request.auth.uid == uid;
    }
    match /public/{name} {
      allow get: if true;
    }
    match /uni/{name} {
      allow get: if name == '火🔥 space.txt';
    }
    match /tail/{allPaths=**} {
      allow get: if allPaths == /a/b.txt;
    }`)),
    steps: [
      { id: "alice-upload-own", method: "POST", path: v0Upload(B, "users/alice/a.txt"), auth: "@alice", body: text(TWELVE) },
      { id: "alice-upload-nested", method: "POST", path: v0Upload(B, "users/alice/deep/er/b.txt"), auth: "@alice", body: text(TWELVE) },
      { id: "bob-get-alice-denied", method: "GET", path: v0Object(B, "users/alice/a.txt"), auth: "@bob" },
      { id: "alice-get-own", method: "GET", path: v0Object(B, "users/alice/a.txt"), auth: "@alice" },
      { id: "alice-list-own-prefix", method: "GET", path: v0List(B, "users/alice/"), auth: "@alice", note: "list path /users/alice binds allPaths to zero segments" },
      { id: "alice-list-nested-prefix", method: "GET", path: v0List(B, "users/alice/deep/"), auth: "@alice" },
      { id: "bob-list-alice-denied", method: "GET", path: v0List(B, "users/alice/"), auth: "@bob" },
      { id: "alice-list-users-root-denied", method: "GET", path: v0List(B, "users/"), auth: "@alice", note: "/users has no uid segment" },
      { id: "alice-list-bucket-root-denied", method: "GET", path: `/v0/b/${B}/o?delimiter=%2F`, auth: "@alice" },
      { id: "alice-upload-bob-denied", method: "POST", path: v0Upload(B, "users/bob/x.txt"), auth: "@alice", body: text(TWELVE) },
      seed("seed-public", B, "public/p.txt"),
      seed("seed-public-nested", B, "public/nested/q.txt"),
      seed("seed-unicode", B, "uni/火🔥 space.txt"),
      seed("seed-tail", B, "tail/a/b.txt"),
      { id: "public-single-segment", method: "GET", path: v0Object(B, "public/p.txt") },
      { id: "public-nested-not-matched", method: "GET", path: v0Object(B, "public/nested/q.txt") },
      { id: "unicode-percent-encoded", method: "GET", path: v0Object(B, "uni/火🔥 space.txt") },
      { id: "unicode-raw-utf8-path", method: "GET", path: "/v0/b/" + B + "/o/uni%2F火🔥%20space.txt", note: "unencoded unicode in the request target" },
      { id: "tail-binding-excludes-prefix", method: "GET", path: v0Object(B, "tail/a/b.txt") },
      probe("root-recursive-list-zero-segments-true", "true", { method: "GET", path: `/v0/b/${B}/o?delimiter=%2F`, auth: "@alice" }, "list"),
      probe("root-recursive-list-zero-segments-null", "allPaths == null", { method: "GET", path: `/v0/b/${B}/o?delimiter=%2F`, auth: "@alice" }, "list"),
      probe("root-recursive-list-zero-segments-is-path", "allPaths is path", { method: "GET", path: `/v0/b/${B}/o?delimiter=%2F`, auth: "@alice" }, "list"),
      probe("root-recursive-list-one-segment-is-path", "allPaths is path && allPaths[0] == 'users'", { method: "GET", path: v0List(B, "users/"), auth: "@alice" }, "list"),
      { id: "list-partial-match-unbound-wildcard-null", method: "GET", path: v0List(B, "users/"), auth: "@alice", rules: single(wrap(`    match /users/{uid}/{allPaths=**} {
      allow list: if uid == null;
    }`)), note: "list on /users: does /users/{uid}/... match with uid unbound?" },
      { id: "list-partial-match-bound-and-unbound", method: "GET", path: v0List(B, "a/q/"), auth: "@alice", rules: single(wrap(`    match /a/{x}/b/{y} {
      allow list: if x == 'q' && y == null;
    }`)) },
      { id: "list-partial-match-literal-mismatch", method: "GET", path: v0List(B, "a/q/c/"), auth: "@alice", rules: single(wrap(`    match /a/{x}/b/{y} {
      allow list: if true;
    }`)), note: "prefix /a/q/c conflicts with the literal b" },
      { id: "list-partial-match-shorter-than-literal", method: "GET", path: v0List(B, "a/"), auth: "@alice", rules: single(wrap(`    match /a/{x}/b/{y} {
      allow list: if x == null && y == null;
    }`)) },
      { id: "list-exact-match-single-wildcard", method: "GET", path: v0List(B, "a/q/"), auth: "@alice", rules: single(wrap(`    match /a/{x} {
      allow list: if x == 'q';
    }`)) },
      { id: "list-longer-than-pattern-denied", method: "GET", path: v0List(B, "a/q/extra/"), auth: "@alice", rules: single(wrap(`    match /a/{x} {
      allow list: if true;
    }`)) },
      { id: "get-partial-match-not-applied", method: "GET", path: v0Object(B, "users/alice"), auth: "@alice", rules: single(wrap(`    match /users/{uid}/{allPaths=**} {
      allow get: if true;
    }`)), note: "get on an object named users/alice: zero-segment recursive tail" },
      seed("seed-object-named-users-alice", B, "users/alice"),
      { id: "get-object-at-zero-segment-tail", method: "GET", path: v0Object(B, "users/alice"), auth: "@alice", rules: single(wrap(`    match /users/{uid}/{allPaths=**} {
      allow get: if uid == 'alice' && allPaths == null;
    }`)) },
      { id: "get-object-at-zero-segment-tail-is-path", method: "GET", path: v0Object(B, "users/alice"), auth: "@alice", rules: single(wrap(`    match /users/{uid}/{allPaths=**} {
      allow get: if uid == 'alice' && allPaths is path;
    }`)) },
      probe("bucket-binding", `bucket == '${B}'`, { method: "GET", path: v0Object(B, "public/p.txt") }, "get"),
      probe("object-name-with-encoded-slash", "request.path[3] == 'enc' && request.path[4] == 'x.txt'", { method: "POST", path: v0Upload(B, "enc/x.txt"), auth: "@alice", body: text(TWELVE) }, "create"),
      probe("object-name-with-trailing-slash", "request.path[3] == 'trail' && request.path[4] == 'x.txt'", { method: "POST", path: v0Upload(B, "trail/x.txt/"), auth: "@alice", body: text(TWELVE) }, "create"),
    ],
  },

  // ----------------------------------------------------------- runtime errors
  {
    id: "runtime-errors",
    category: "runtime-errors",
    description: "evaluation errors deny with 403 and the emulator's warning text",
    rules: single(allowAll("true")),
    steps: [
      seed("seed", B, "err/obj.txt"),
      probe("missing-metadata-field", "resource.metadata.missing == 'x'", { method: "GET", path: v0Object(B, "err/obj.txt"), auth: "@alice" }, "get"),
      probe("division-by-zero", "resource.size / 0 == 1", { method: "GET", path: v0Object(B, "err/obj.txt"), auth: "@alice" }, "get"),
      probe("non-boolean-condition", "resource.size", { method: "GET", path: v0Object(B, "err/obj.txt"), auth: "@alice" }, "get"),
      probe("null-auth-property", "request.auth.uid == 'alice'", { method: "GET", path: v0Object(B, "err/obj.txt") }, "get"),
      probe("unknown-variable", "nosuchvariable == null", { method: "GET", path: v0Object(B, "err/obj.txt"), auth: "@alice" }, "get"),
      probe("unknown-function", "resource.name.nosuchfunction() == 'x'", { method: "GET", path: v0Object(B, "err/obj.txt"), auth: "@alice" }, "get"),
      probe("string-of-timestamp", "string(request.time) is string", { method: "GET", path: v0Object(B, "err/obj.txt"), auth: "@alice" }, "get"),
      probe("path-index-out-of-range", "request.path[9] == 'x'", { method: "GET", path: v0Object(B, "err/obj.txt"), auth: "@alice" }, "get"),
      probe("request-query-undefined", "request.query == null", { method: "GET", path: v0Object(B, "err/obj.txt"), auth: "@alice" }, "get"),
      probe("error-in-one-allow-other-allows", "true", { method: "GET", path: v0Object(B, "err/obj.txt"), auth: "@alice" }, "get"),
      { id: "error-in-first-allow-second-allows", method: "GET", path: v0Object(B, "err/obj.txt"), auth: "@alice", rules: single(wrap(`    match /{allPaths=**} {
      allow get: if resource.metadata.missing == 'x';
      allow get: if request.auth.uid == 'alice';
    }`)) },
      { id: "error-in-nested-block-other-block-allows", method: "GET", path: v0Object(B, "err/obj.txt"), auth: "@alice", rules: single(wrap(`    match /err/{name} {
      allow get: if resource.metadata.missing == 'x';
    }
    match /{allPaths=**} {
      allow get: if request.auth.uid == 'alice';
    }`)) },
    ],
  },

  // -------------------------------------------------------- ruleset lifecycle
  {
    id: "lifecycle-set-rules",
    category: "ruleset-lifecycle",
    description: "/internal/setRules request and response shapes, failure behaviour, multi-bucket targets",
    rules: single(allowAll("true")),
    steps: [
      seed("seed-default", B, "life/obj.txt"),
      seed("seed-assets", A, "life/asset.txt"),
      { id: "single-file-governs-every-bucket-default", method: "GET", path: v0Object(B, "life/obj.txt"), auth: "@alice" },
      { id: "single-file-governs-every-bucket-assets", method: "GET", path: v0Object(A, "life/asset.txt"), auth: "@alice" },
      { id: "single-file-governs-unconfigured-bucket", method: "GET", path: v0Object(THIRD_BUCKET, "life/none.txt"), auth: "@alice" },
      { id: "set-rules-missing-semicolon-accepted", method: "PUT", path: "/internal/setRules", body: json({ rules: { files: [{ name: "storage.rules", content: "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    allow read: if true\n  }\n}\n" }] } }), note: "a trailing semicolon is optional; the allow sits on /b/{bucket}/o and matches no object" },
      { id: "after-missing-semicolon-get", method: "GET", path: v0Object(B, "life/obj.txt"), auth: "@alice" },
      { id: "set-rules-syntax-error", method: "PUT", path: "/internal/setRules", body: json({ rules: { files: [{ name: "storage.rules", content: SYNTAX_ERROR_RULES }] } }) },
      { id: "after-syntax-error-get", method: "GET", path: v0Object(B, "life/obj.txt"), auth: "@alice", note: "does the previous ruleset survive a failed reload?" },
      { id: "after-syntax-error-owner-get", method: "GET", path: v0Object(B, "life/obj.txt"), auth: OWNER },
      { id: "after-syntax-error-json-api", method: "GET", path: `/storage/v1/b/${B}/o/${encodeURIComponent("life/obj.txt")}` },
      { id: "after-syntax-error-list", method: "GET", path: v0List(B, "life/"), auth: "@alice" },
      { id: "after-syntax-error-upload", method: "POST", path: v0Upload(B, "life/new.txt"), auth: "@alice", body: text(TWELVE) },
      { id: "set-rules-semantic-error", method: "PUT", path: "/internal/setRules", body: json({ rules: { files: [{ name: "storage.rules", content: wrap(`    match /{allPaths=**} {
      allow read: if resource.size == 'a' +;
    }`) }] } }) },
      { id: "after-semantic-error-get", method: "GET", path: v0Object(B, "life/obj.txt"), auth: "@alice" },
      { id: "set-rules-firestore-service", method: "PUT", path: "/internal/setRules", body: json({ rules: { files: [{ name: "firestore.rules", content: "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} {\n      allow read, write: if true;\n    }\n  }\n}\n" }] } }) },
      { id: "after-firestore-service-get", method: "GET", path: v0Object(B, "life/obj.txt"), auth: "@alice" },
      { id: "set-rules-missing-files", method: "PUT", path: "/internal/setRules", body: json({ rules: {} }) },
      { id: "set-rules-empty-files", method: "PUT", path: "/internal/setRules", body: json({ rules: { files: [] } }) },
      { id: "set-rules-file-without-content", method: "PUT", path: "/internal/setRules", body: json({ rules: { files: [{ name: "storage.rules" }] } }) },
      { id: "set-rules-multi-without-resource", method: "PUT", path: "/internal/setRules", body: json({ rules: { files: [{ name: "a.rules", content: allowAll("true") }, { name: "b.rules", content: allowAll("false") }] } }) },
      { id: "set-rules-valid-single", method: "PUT", path: "/internal/setRules", body: json({ rules: { files: [{ name: "storage.rules", content: allowAll("true") }] } }) },
      { id: "after-valid-get", method: "GET", path: v0Object(B, "life/obj.txt"), auth: "@alice" },
    ],
  },
  {
    id: "lifecycle-multi-bucket",
    category: "ruleset-lifecycle",
    description: "resource-keyed rulesets: one file per bucket, unconfigured buckets, one invalid file of several",
    rules: single(allowAll("true")),
    steps: [
      seed("seed-default", B, "life/obj.txt"),
      seed("seed-assets", A, "life/asset.txt"),
      { id: "set-rules-multi-bucket", method: "PUT", path: "/internal/setRules", body: json({ rules: { files: [
        { name: "default.rules", resource: B, content: allowAll("request.auth.uid == 'alice'") },
        { name: "assets.rules", resource: A, content: allowAll("true", "get") },
      ] } }) },
      { id: "multi-default-alice", method: "GET", path: v0Object(B, "life/obj.txt"), auth: "@alice" },
      { id: "multi-default-anonymous-denied", method: "GET", path: v0Object(B, "life/obj.txt") },
      { id: "multi-assets-anonymous-get", method: "GET", path: v0Object(A, "life/asset.txt") },
      { id: "multi-assets-list-denied", method: "GET", path: v0List(A, "life/"), auth: "@alice" },
      { id: "multi-unconfigured-bucket", method: "GET", path: v0Object(THIRD_BUCKET, "life/none.txt"), auth: "@alice" },
      { id: "multi-unconfigured-bucket-owner", method: "GET", path: v0Object(THIRD_BUCKET, "life/none.txt"), auth: OWNER },
      { id: "multi-unconfigured-bucket-json-api", method: "GET", path: `/storage/v1/b/${THIRD_BUCKET}/o/${encodeURIComponent("life/none.txt")}` },
      { id: "set-rules-multi-one-invalid", method: "PUT", path: "/internal/setRules", body: json({ rules: { files: [
        { name: "default.rules", resource: B, content: allowAll("true") },
        { name: "assets.rules", resource: A, content: "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    allow read: if true\n  }\n}\n" },
      ] } }) },
      { id: "multi-one-invalid-default-get", method: "GET", path: v0Object(B, "life/obj.txt"), auth: "@alice" },
      { id: "multi-one-invalid-assets-get", method: "GET", path: v0Object(A, "life/asset.txt"), auth: "@alice" },
    ],
  },

  // ------------------------------------------------------------ consumer shape
  {
    id: "consumer-twodart",
    category: "consumer-shaped",
    description: "the Twodart default and assets rulesets verbatim, two targeted buckets",
    rules: [
      { name: "storage.default.rules", resource: B, content: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{allPaths=**} {
      allow read, write: if request.auth.uid == uid || request.auth.token.admin == true;
    }
  }
}
` },
      { name: "storage.assets.rules", resource: A, content: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{allPaths=**} {
      allow read, write: if request.auth.uid == uid || request.auth.token.admin == true;
    }
    match /{allPaths=**} {
      allow write: if request.auth.token.admin == true;
      allow get: if true;
    }
  }
}
` },
    ],
    steps: [
      { id: "default-alice-upload", method: "POST", path: v0Upload(B, "users/alice/orders/deck.png"), auth: "@alice", headers: { "x-goog-upload-protocol": "multipart" }, body: multipart({ name: "users/alice/orders/deck.png", contentType: "image/png" }, "png-bytes") },
      { id: "default-alice-get", method: "GET", path: v0Object(B, "users/alice/orders/deck.png"), auth: "@alice" },
      { id: "default-alice-media", method: "GET", path: v0Object(B, "users/alice/orders/deck.png", "?alt=media"), auth: "@alice" },
      { id: "default-bob-get-denied", method: "GET", path: v0Object(B, "users/alice/orders/deck.png"), auth: "@bob" },
      { id: "default-admin-get", method: "GET", path: v0Object(B, "users/alice/orders/deck.png"), auth: "@admin" },
      { id: "default-anonymous-get-denied", method: "GET", path: v0Object(B, "users/alice/orders/deck.png") },
      { id: "default-alice-list", method: "GET", path: v0List(B, "users/alice/orders/"), auth: "@alice" },
      { id: "default-alice-list-user-root", method: "GET", path: v0List(B, "users/alice/"), auth: "@alice" },
      { id: "default-bob-list-denied", method: "GET", path: v0List(B, "users/alice/"), auth: "@bob" },
      { id: "default-alice-patch", method: "PATCH", path: v0Object(B, "users/alice/orders/deck.png"), auth: "@alice", body: json({ metadata: { order: "42" } }) },
      { id: "default-alice-delete", method: "DELETE", path: v0Object(B, "users/alice/orders/deck.png"), auth: "@alice" },
      { id: "default-alice-outside-users-denied", method: "POST", path: v0Upload(B, "shared/x.txt"), auth: "@alice", body: text(TWELVE) },
      { id: "default-admin-outside-users-denied", method: "POST", path: v0Upload(B, "shared/x.txt"), auth: "@admin", body: text(TWELVE) },
      { id: "default-token-read-bypass", method: "POST", path: v0Upload(B, "users/alice/orders/shared.png"), auth: OWNER, headers: { "x-goog-upload-protocol": "multipart" }, body: multipart({ name: "users/alice/orders/shared.png", contentType: "image/png" }, "png-bytes") },
      { id: "default-token-read-anonymous", method: "GET", path: v0Object(B, "users/alice/orders/shared.png", "?alt=media&token={{token:default-token-read-bypass}}") },
      { id: "assets-admin-upload", method: "POST", path: v0Upload(A, "users/alice/images/logo.png"), auth: "@admin", headers: { "x-goog-upload-protocol": "multipart" }, body: multipart({ name: "users/alice/images/logo.png", contentType: "image/png" }, "png-bytes") },
      { id: "assets-admin-upload-catalog", method: "POST", path: v0Upload(A, "catalog/cache.json"), auth: "@admin", headers: { "x-goog-upload-protocol": "multipart" }, body: multipart({ name: "catalog/cache.json", contentType: "application/json" }, "{}") },
      { id: "assets-anonymous-get", method: "GET", path: v0Object(A, "catalog/cache.json") },
      { id: "assets-anonymous-media", method: "GET", path: v0Object(A, "catalog/cache.json", "?alt=media") },
      { id: "assets-anonymous-list-denied", method: "GET", path: v0List(A, "users/alice/images/") },
      { id: "assets-anonymous-root-list-denied", method: "GET", path: `/v0/b/${A}/o?delimiter=%2F` },
      { id: "assets-alice-list-own", method: "GET", path: v0List(A, "users/alice/images/"), auth: "@alice" },
      { id: "assets-alice-upload-own", method: "POST", path: v0Upload(A, "users/alice/fonts/f.ttf"), auth: "@alice", headers: { "x-goog-upload-protocol": "multipart" }, body: multipart({ name: "users/alice/fonts/f.ttf", contentType: "font/ttf" }, "ttf-bytes") },
      { id: "assets-alice-upload-catalog-denied", method: "POST", path: v0Upload(A, "catalog/other.json"), auth: "@alice", body: text("{}") },
      { id: "assets-bob-get-alice-asset", method: "GET", path: v0Object(A, "users/alice/images/logo.png"), auth: "@bob" },
      { id: "assets-bob-delete-alice-asset-denied", method: "DELETE", path: v0Object(A, "users/alice/images/logo.png"), auth: "@bob" },
      { id: "assets-admin-delete-catalog", method: "DELETE", path: v0Object(A, "catalog/cache.json"), auth: "@admin" },
      { id: "assets-alice-get-missing", method: "GET", path: v0Object(A, "catalog/missing.json"), auth: "@alice" },
    ],
  },
];
