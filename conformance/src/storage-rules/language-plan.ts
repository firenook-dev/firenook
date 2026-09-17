// Phase G1 production expression corpus for `service firebase.storage`.
//
// Every case is evaluated by the production Rules API (`projects.test`) with a
// synthetic request; no bucket, object or persistent write is involved. The
// corpus covers the Storage value surface (object resource fields, request
// shape, path bindings, firestore.* mocks); general language semantics are
// already frozen by the Phase 3 Firestore corpus and the engine is shared.
//
// `resource` and `request.resource` are always passed explicitly (null or a
// map): `projects.test` treats an omitted value as undefined and raises a
// "Null value error" on access, which is a test-API artifact, not the runtime
// model. RFC 3339-shaped strings anywhere in the resource are converted to
// timestamps by `projects.test`; custom metadata values therefore never look
// like timestamps in this corpus (the emulator oracle owns metadata typing).

export const STORAGE_RULES_PROJECT_ID = "fireside-conformance";
export const STORAGE_RULES_CORPUS_SEED = "fireside-phase-g-storage-rules-v1";
export const STORAGE_RULES_CASES_PER_BATCH = 32;
export const STORAGE_RULES_BUCKET = "corpus";
export const STORAGE_RULES_REQUEST_TIME = "2026-01-15T12:34:56.123456789Z";

export type StorageMethod = "get" | "list" | "create" | "update" | "delete";

export type StorageExpressionCategory =
  | "resource-fields-and-types"
  | "request-resource-fields-and-types"
  | "null-resource-per-method"
  | "request-method-strings"
  | "request-path-segments-and-bindings"
  | "request-time"
  | "request-auth-shapes"
  | "firestore-get-and-exists"
  | "match-patterns"
  | "functions-and-let";

export interface StorageAuth {
  readonly uid: string;
  readonly token: Readonly<Record<string, unknown>>;
}

export interface StorageLanguageCase {
  readonly id: string;
  readonly category: StorageExpressionCategory;
  readonly expression: string;
  readonly method: StorageMethod;
  /// Full request path; defaults to `/b/corpus/o/lang/<id>`.
  readonly path?: string;
  /// `undefined` selects the default authenticated user; `null` is anonymous.
  readonly auth?: StorageAuth | null;
  /// Stored object; defaults per method (see `defaultResource`).
  readonly resource?: unknown;
  /// Proposed object; defaults per method (see `defaultRequestResource`).
  readonly requestResource?: unknown;
  readonly functionMocks?: readonly unknown[];
  /// Replaces the generated `match /lang/<id>` block. The block must only
  /// admit this case's path.
  readonly customMatch?: string;
  /// Functions declared at service level for this batch.
  readonly serviceFunctions?: string;
}

export interface StorageLanguageTestCase {
  readonly expectation: "ALLOW";
  readonly request: Readonly<Record<string, unknown>>;
  readonly resource: unknown;
  readonly functionMocks?: readonly unknown[];
  readonly pathEncoding: "PLAIN";
  readonly expressionReportLevel: "FULL";
}

export interface StorageLanguageBatch {
  readonly id: string;
  readonly source: string;
  readonly cases: readonly StorageLanguageCase[];
  readonly testCases: readonly StorageLanguageTestCase[];
}

export const DEFAULT_AUTH: StorageAuth = {
  uid: "alice",
  token: {
    sub: "alice",
    user_id: "alice",
    email: "alice@example.test",
    email_verified: true,
    admin: false,
    plan: "pro",
    quota: 5,
    firebase: {
      sign_in_provider: "password",
      identities: { email: ["alice@example.test"] },
    },
    iat: 1700000000,
    exp: 4102444800,
    aud: STORAGE_RULES_PROJECT_ID,
    iss: `https://securetoken.google.com/${STORAGE_RULES_PROJECT_ID}`,
  },
};

export const ADMIN_AUTH: StorageAuth = {
  uid: "admin-user",
  token: {
    sub: "admin-user",
    user_id: "admin-user",
    admin: true,
    firebase: { sign_in_provider: "custom", identities: {} },
    iat: 1700000000,
    exp: 4102444800,
    aud: STORAGE_RULES_PROJECT_ID,
    iss: `https://securetoken.google.com/${STORAGE_RULES_PROJECT_ID}`,
  },
};

/// The stored object exposed as `resource`, shaped exactly like the fourteen
/// fields the official emulator hands to the rules runtime.
export function storedObject(name: string): Readonly<Record<string, unknown>> {
  return {
    name,
    bucket: STORAGE_RULES_BUCKET,
    generation: 1757000000000000,
    metageneration: 2,
    size: 2048,
    timeCreated: "2026-01-10T08:00:00Z",
    updated: "2026-01-12T09:30:00Z",
    md5Hash: "kAFQmDzST7DWlj99KOF/cg==",
    crc32c: "z8SuHQ==",
    etag: "CKjEgYS1u4gDEAI=",
    contentDisposition: "inline",
    contentEncoding: "identity",
    contentType: "image/png",
    metadata: { owner: "alice", visibility: "private", version: "3" },
  };
}

/// The proposed object exposed as `request.resource` on create and update.
export function proposedObject(name: string): Readonly<Record<string, unknown>> {
  return {
    name,
    bucket: STORAGE_RULES_BUCKET,
    generation: 1758000000000000,
    metageneration: 1,
    size: 4096,
    timeCreated: "2026-01-15T12:34:56Z",
    updated: "2026-01-15T12:34:56Z",
    md5Hash: "1B2M2Y8AsgTpgAmY7PhCfg==",
    crc32c: "AAAAAA==",
    etag: "CJri3Ye1u4gDEAE=",
    contentDisposition: "attachment; filename=\"upload.jpg\"",
    contentEncoding: "gzip",
    contentType: "image/jpeg",
    metadata: { owner: "alice", visibility: "public" },
  };
}

function defaultResource(method: StorageMethod, name: string): unknown {
  return method === "create" || method === "list" ? null : storedObject(name);
}

function defaultRequestResource(method: StorageMethod, name: string): unknown {
  return method === "create" || method === "update" ? proposedObject(name) : null;
}

type CaseOptions = Omit<StorageLanguageCase, "id" | "category" | "expression" | "method"> & {
  readonly method?: StorageMethod;
};

function make(
  category: StorageExpressionCategory,
): (id: string, expression: string, options?: CaseOptions) => StorageLanguageCase {
  return (id, expression, options = {}) => ({
    id,
    category,
    expression,
    method: options.method ?? "get",
    ...options,
  });
}

const resourceCase = make("resource-fields-and-types");
const requestResourceCase = make("request-resource-fields-and-types");
const nullCase = make("null-resource-per-method");
const methodCase = make("request-method-strings");
const pathCase = make("request-path-segments-and-bindings");
const timeCase = make("request-time");
const authCase = make("request-auth-shapes");
const firestoreCase = make("firestore-get-and-exists");
const matchCase = make("match-patterns");
const functionCase = make("functions-and-let");

const USERS_ALICE = "/databases/(default)/documents/users/alice";
const USERS_DOC = { data: { admin: true, plan: "pro", limit: 10, tags: ["a", "b"] } };

function mockGet(path: string | undefined, result: unknown): unknown {
  return {
    function: "firestore.get",
    args: [path === undefined ? { anyValue: {} } : { exactValue: path }],
    result,
  };
}

function mockExists(path: string | undefined, value: boolean): unknown {
  return {
    function: "firestore.exists",
    args: [path === undefined ? { anyValue: {} } : { exactValue: path }],
    result: { value },
  };
}

export const STORAGE_LANGUAGE_CASES: readonly StorageLanguageCase[] = [
  // --- resource-fields-and-types ---------------------------------------
  resourceCase("res-is-map", "resource is map"),
  resourceCase("res-name-string", "resource.name is string && resource.name == 'lang/res-name-string'"),
  resourceCase("res-name-split", "resource.name.split('/')[0] == 'lang' && resource.name.split('/').size() == 2"),
  resourceCase("res-name-matches", "resource.name.matches('^lang/.*$')"),
  resourceCase("res-bucket", "resource.bucket == bucket && resource.bucket is string"),
  resourceCase("res-generation-int", "resource.generation is int && resource.generation > 0"),
  resourceCase("res-generation-value", "resource.generation == 1757000000000000"),
  resourceCase("res-metageneration", "resource.metageneration is int && resource.metageneration == 2"),
  resourceCase("res-size-int", "resource.size is int"),
  resourceCase("res-size-limit", "resource.size < 5 * 1024 * 1024 && resource.size >= 2048"),
  resourceCase("res-size-arith", "resource.size / 1024 == 2 && resource.size % 1000 == 48"),
  resourceCase("res-size-float-compare", "resource.size < 2048.5 && resource.size > 2047.5"),
  resourceCase("res-time-created-ts", "resource.timeCreated is timestamp"),
  resourceCase("res-time-created-parts", "resource.timeCreated.year() == 2026 && resource.timeCreated.month() == 1 && resource.timeCreated.day() == 10 && resource.timeCreated.hours() == 8"),
  resourceCase("res-updated-ts", "resource.updated is timestamp && resource.updated > resource.timeCreated"),
  resourceCase("res-updated-diff", "resource.updated - resource.timeCreated == duration.value(49, 'h') + duration.value(30, 'm')"),
  resourceCase("res-updated-before-now", "resource.updated < request.time && resource.timeCreated < request.time"),
  resourceCase("res-time-created-seconds", "resource.timeCreated.toMillis() == 1768032000000"),
  resourceCase("res-time-created-string-false", "resource.timeCreated is string"),
  resourceCase("res-md5-string", "resource.md5Hash is string && resource.md5Hash.size() == 24"),
  resourceCase("res-crc32c-string", "resource.crc32c is string && resource.crc32c == 'z8SuHQ=='"),
  resourceCase("res-etag-string", "resource.etag is string && resource.etag.size() > 0"),
  resourceCase("res-content-disposition", "resource.contentDisposition == 'inline'"),
  resourceCase("res-content-encoding", "resource.contentEncoding == 'identity'"),
  resourceCase("res-content-type-matches", "resource.contentType.matches('image/.*')"),
  resourceCase("res-content-type-in", "resource.contentType in ['image/png', 'image/jpeg']"),
  resourceCase("res-content-type-split", "resource.contentType.split('/')[1] == 'png'"),
  resourceCase("res-metadata-map", "resource.metadata is map && resource.metadata.size() == 3"),
  resourceCase("res-metadata-field", "resource.metadata.owner == 'alice' && resource.metadata.visibility == 'private'"),
  resourceCase("res-metadata-string-number", "resource.metadata.version is string && resource.metadata.version == '3' && int(resource.metadata.version) == 3"),
  resourceCase("res-metadata-in", "'owner' in resource.metadata && !('missing' in resource.metadata)"),
  resourceCase("res-metadata-get-default", "resource.metadata.get('missing', 'fallback') == 'fallback' && resource.metadata.get('owner', 'x') == 'alice'"),
  resourceCase("res-metadata-keys", "resource.metadata.keys().hasAll(['owner', 'visibility', 'version'])"),
  resourceCase("res-metadata-missing-error", "resource.metadata.missing == 'x'"),
  resourceCase("res-metadata-index", "resource.metadata['owner'] == 'alice'"),
  resourceCase("res-keys", "resource.keys().hasAll(['name', 'bucket', 'size', 'contentType', 'metadata'])"),
  resourceCase("res-keys-count", "resource.keys().size() == 14"),
  resourceCase("res-in-name", "'name' in resource && 'size' in resource"),
  resourceCase("res-in-missing", "!('cacheControl' in resource)"),
  resourceCase("res-missing-field-error", "resource.cacheControl == null"),
  resourceCase("res-missing-field-short-circuit", "!('cacheControl' in resource) || resource.cacheControl == 'no-cache'"),
  resourceCase("res-cache-control-present", "resource.cacheControl == 'public, max-age=60'", {
    resource: { ...storedObject("lang/res-cache-control-present"), cacheControl: "public, max-age=60" },
  }),
  resourceCase("res-content-language-present", "resource.contentLanguage == 'ja'", {
    resource: { ...storedObject("lang/res-content-language-present"), contentLanguage: "ja" },
  }),
  resourceCase("res-empty-metadata", "resource.metadata is map && resource.metadata.size() == 0", {
    resource: { ...storedObject("lang/res-empty-metadata"), metadata: {} },
  }),
  resourceCase("res-get-default-field", "resource.get('cacheControl', 'none') == 'none' && resource.get('size', 0) == 2048"),
  resourceCase("res-equality-self", "resource == resource"),
  resourceCase("res-size-string-coercion", "string(resource.size) == '2048'"),
  resourceCase("res-name-hash", "hashing.sha256(resource.name).toHexString().size() == 64"),
  resourceCase("res-delete-resource", "resource.size == 2048 && resource.metadata.owner == request.auth.uid", { method: "delete" }),

  // --- request-resource-fields-and-types --------------------------------
  requestResourceCase("rr-is-map", "request.resource is map", { method: "create" }),
  requestResourceCase("rr-name", "request.resource.name == 'lang/rr-name'", { method: "create" }),
  requestResourceCase("rr-name-matches", "request.resource.name.matches('^lang/rr-.*')", { method: "create" }),
  requestResourceCase("rr-bucket", "request.resource.bucket == bucket", { method: "create" }),
  requestResourceCase("rr-generation", "request.resource.generation is int && request.resource.metageneration == 1", { method: "create" }),
  requestResourceCase("rr-size-int", "request.resource.size is int && request.resource.size == 4096", { method: "create" }),
  requestResourceCase("rr-size-limit-allow", "request.resource.size < 5 * 1024 * 1024", { method: "create" }),
  requestResourceCase("rr-size-limit-deny", "request.resource.size < 1024", { method: "create" }),
  requestResourceCase("rr-time-created", "request.resource.timeCreated is timestamp && request.resource.timeCreated <= request.time", { method: "create" }),
  requestResourceCase("rr-updated", "request.resource.updated == request.resource.timeCreated", { method: "create" }),
  requestResourceCase("rr-md5", "request.resource.md5Hash == '1B2M2Y8AsgTpgAmY7PhCfg=='", { method: "create" }),
  requestResourceCase("rr-crc32c", "request.resource.crc32c is string", { method: "create" }),
  requestResourceCase("rr-etag", "request.resource.etag is string", { method: "create" }),
  requestResourceCase("rr-content-disposition", "request.resource.contentDisposition.matches('attachment.*')", { method: "create" }),
  requestResourceCase("rr-content-encoding", "request.resource.contentEncoding == 'gzip'", { method: "create" }),
  requestResourceCase("rr-content-type-allow", "request.resource.contentType.matches('image/.*')", { method: "create" }),
  requestResourceCase("rr-content-type-deny", "request.resource.contentType.matches('video/.*')", { method: "create" }),
  requestResourceCase("rr-content-type-in", "request.resource.contentType in ['image/jpeg', 'image/png']", { method: "create" }),
  requestResourceCase("rr-metadata-owner", "request.resource.metadata.owner == request.auth.uid", { method: "create" }),
  requestResourceCase("rr-metadata-keys", "request.resource.metadata.keys().hasOnly(['owner', 'visibility'])", { method: "create" }),
  requestResourceCase("rr-metadata-missing-error", "request.resource.metadata.version == '3'", { method: "create" }),
  requestResourceCase("rr-metadata-in", "'visibility' in request.resource.metadata", { method: "create" }),
  requestResourceCase("rr-metadata-empty", "request.resource.metadata.size() == 0", {
    method: "create",
    requestResource: { ...proposedObject("lang/rr-metadata-empty"), metadata: {} },
  }),
  requestResourceCase("rr-keys-count", "request.resource.keys().size() == 14", { method: "create" }),
  requestResourceCase("rr-missing-cache-control", "!('cacheControl' in request.resource)", { method: "create" }),
  requestResourceCase("rr-cache-control-present", "request.resource.cacheControl == 'no-store'", {
    method: "create",
    requestResource: { ...proposedObject("lang/rr-cache-control-present"), cacheControl: "no-store" },
  }),
  requestResourceCase("rr-update-size-grew", "request.resource.size > resource.size", { method: "update" }),
  requestResourceCase("rr-update-name-stable", "request.resource.name == resource.name && request.resource.bucket == resource.bucket", { method: "update" }),
  requestResourceCase("rr-update-content-type-changed", "request.resource.contentType != resource.contentType", { method: "update" }),
  requestResourceCase("rr-update-metadata-diff", "request.resource.metadata.diff(resource.metadata).affectedKeys().hasOnly(['visibility', 'version'])", { method: "update" }),
  requestResourceCase("rr-update-metadata-changed", "request.resource.metadata.diff(resource.metadata).changedKeys().hasOnly(['visibility'])", { method: "update" }),
  requestResourceCase("rr-update-metadata-removed", "request.resource.metadata.diff(resource.metadata).removedKeys().hasOnly(['version'])", { method: "update" }),
  requestResourceCase("rr-update-owner-locked", "request.resource.metadata.owner == resource.metadata.owner", { method: "update" }),
  requestResourceCase("rr-update-generation-differs", "request.resource.generation != resource.generation", { method: "update" }),
  requestResourceCase("rr-update-updated-later", "request.resource.updated > resource.updated", { method: "update" }),
  requestResourceCase("rr-update-timestamps", "request.resource.timeCreated > resource.timeCreated", { method: "update" }),
  requestResourceCase("rr-equality", "request.resource == request.resource && request.resource != resource", { method: "update" }),
  requestResourceCase("rr-metadata-string-only", "request.resource.metadata.count is string", {
    method: "create",
    requestResource: { ...proposedObject("lang/rr-metadata-string-only"), metadata: { count: "12" } },
  }),
  requestResourceCase("rr-size-zero", "request.resource.size == 0", {
    method: "create",
    requestResource: { ...proposedObject("lang/rr-size-zero"), size: 0 },
  }),

  // --- null-resource-per-method -----------------------------------------
  nullCase("null-get-resource-present", "resource != null && resource.size == 2048"),
  nullCase("null-get-request-resource", "request.resource == null"),
  nullCase("null-get-missing-object", "resource == null", { resource: null }),
  nullCase("null-get-missing-object-field-error", "resource.size == 0", { resource: null }),
  nullCase("null-get-missing-object-guarded", "resource == null || resource.size == 0", { resource: null }),
  nullCase("null-list-both", "resource == null && request.resource == null", { method: "list" }),
  nullCase("null-list-field-error", "resource.name == 'x'", { method: "list" }),
  nullCase("null-create-resource", "resource == null && request.resource != null", { method: "create" }),
  nullCase("null-create-resource-field-error", "resource.size == 0", { method: "create" }),
  nullCase("null-create-over-existing", "resource != null && request.resource.generation != resource.generation", {
    method: "create",
    resource: storedObject("lang/null-create-over-existing"),
  }),
  nullCase("null-update-both", "resource != null && request.resource != null", { method: "update" }),
  nullCase("null-update-missing-before", "resource == null && request.resource != null", {
    method: "update",
    resource: null,
  }),
  nullCase("null-delete-resource", "resource != null && request.resource == null", { method: "delete" }),
  nullCase("null-delete-missing", "resource == null", { method: "delete", resource: null }),
  nullCase("null-delete-missing-field-error", "resource.metadata.owner == request.auth.uid", { method: "delete", resource: null }),
  nullCase("null-delete-request-resource-error", "request.resource.size == 0", { method: "delete" }),
  nullCase("null-get-request-resource-field-error", "request.resource.name == 'x'"),
  nullCase("null-is-null-typecheck", "resource is map && !(request.resource is map)"),

  // --- request-method-strings -------------------------------------------
  methodCase("method-get-string", "request.method == 'get'"),
  methodCase("method-get-not-list", "request.method != 'list'"),
  methodCase("method-list-string", "request.method == 'list'", { method: "list" }),
  methodCase("method-create-string", "request.method == 'create'", { method: "create" }),
  methodCase("method-update-string", "request.method == 'update'", { method: "update" }),
  methodCase("method-delete-string", "request.method == 'delete'", { method: "delete" }),
  methodCase("method-in-list", "request.method in ['create', 'update']", { method: "update" }),
  methodCase("method-is-string", "request.method is string && request.method.size() == 6", { method: "delete" }),
  methodCase("method-read-covers-get", "true", {
    method: "get",
    customMatch: `    match /lang/method-read-covers-get {
      allow read: if true;
    }`,
  }),
  methodCase("method-read-covers-list", "true", {
    method: "list",
    customMatch: `    match /lang/method-read-covers-list {
      allow read: if true;
    }`,
  }),
  methodCase("method-get-excludes-list", "true", {
    method: "list",
    customMatch: `    match /lang/method-get-excludes-list {
      allow get: if true;
    }`,
  }),
  methodCase("method-list-excludes-get", "true", {
    method: "get",
    customMatch: `    match /lang/method-list-excludes-get {
      allow list: if true;
    }`,
  }),
  methodCase("method-write-covers-create", "true", {
    method: "create",
    customMatch: `    match /lang/method-write-covers-create {
      allow write: if true;
    }`,
  }),
  methodCase("method-write-covers-update", "true", {
    method: "update",
    customMatch: `    match /lang/method-write-covers-update {
      allow write: if true;
    }`,
  }),
  methodCase("method-write-covers-delete", "true", {
    method: "delete",
    customMatch: `    match /lang/method-write-covers-delete {
      allow write: if true;
    }`,
  }),
  methodCase("method-create-excludes-update", "true", {
    method: "update",
    customMatch: `    match /lang/method-create-excludes-update {
      allow create: if true;
    }`,
  }),
  methodCase("method-update-excludes-delete", "true", {
    method: "delete",
    customMatch: `    match /lang/method-update-excludes-delete {
      allow update: if true;
    }`,
  }),
  methodCase("method-read-excludes-write", "true", {
    method: "create",
    customMatch: `    match /lang/method-read-excludes-write {
      allow read: if true;
    }`,
  }),
  methodCase("method-comma-list", "true", {
    method: "delete",
    customMatch: `    match /lang/method-comma-list {
      allow get, delete: if true;
    }`,
  }),
  methodCase("method-multiple-allows-or", "true", {
    method: "get",
    customMatch: `    match /lang/method-multiple-allows-or {
      allow get: if false;
      allow read: if request.auth != null;
    }`,
  }),

  // --- request-path-segments-and-bindings --------------------------------
  pathCase("path-is-path", "request.path is path"),
  pathCase("path-index-0", "request.path[0] == 'b'"),
  pathCase("path-index-1-bucket", "request.path[1] == bucket && request.path[1] == 'corpus'"),
  pathCase("path-index-2", "request.path[2] == 'o'"),
  pathCase("path-index-3", "request.path[3] == 'lang'"),
  pathCase("path-index-4", "request.path[4] == 'path-index-4'"),
  pathCase("path-index-out-of-range", "request.path[5] == 'x'"),
  pathCase("path-equality", "request.path == /b/corpus/o/lang/path-equality"),
  pathCase("path-inequality", "request.path != /b/corpus/o/lang/other"),
  pathCase("path-interpolated-equality", "request.path == /b/$(bucket)/o/lang/$(request.path[4])"),
  pathCase("path-slice-tail", "request.path[3:5] == /lang/path-slice-tail"),
  pathCase("path-slice-head", "request.path[0:3] == /b/corpus/o"),
  pathCase("path-string-coercion", "string(request.path) == '/b/corpus/o/lang/path-string-coercion'"),
  pathCase("path-string-contains", "string(request.path).matches('.*/lang/.*')"),
  pathCase("path-bucket-binding-type", "bucket is string && bucket == 'corpus'"),
  pathCase("path-single-wildcard-bind", "name == 'path-single-wildcard-bind' && name is string", {
    customMatch: `    match /single/{name} {
      allow get: if name == 'path-single-wildcard-bind' && name is string;
    }`,
    path: "/b/corpus/o/single/path-single-wildcard-bind",
  }),
  pathCase("path-single-wildcard-no-deep-match", "true", {
    customMatch: `    match /shallow/{name} {
      allow get: if name == 'deep';
    }`,
    path: "/b/corpus/o/shallow/deep/path-single-wildcard-no-deep-match",
  }),
  pathCase("path-recursive-bind-path", "allPaths is path && allPaths == /deep/x/path-recursive-bind-path", {
    customMatch: `    match /deep/{allPaths=**} {
      allow get: if request.path[4] == 'x' && allPaths is path && allPaths == /deep/x/path-recursive-bind-path;
    }`,
    path: "/b/corpus/o/deep/x/path-recursive-bind-path",
  }),
  pathCase("path-recursive-bind-index", "allPaths[0] == 'deep'", {
    customMatch: `    match /deep/{allPaths=**} {
      allow get: if request.path[4] == 'y' && allPaths[0] == 'deep' && allPaths[2] == 'path-recursive-bind-index';
    }`,
    path: "/b/corpus/o/deep/y/path-recursive-bind-index",
  }),
  pathCase("path-recursive-single-segment", "allPaths == /deep/path-recursive-single-segment", {
    customMatch: `    match /deep/{allPaths=**} {
      allow get: if request.path[4] == 'path-recursive-single-segment' && allPaths == /deep/path-recursive-single-segment;
    }`,
    path: "/b/corpus/o/deep/path-recursive-single-segment",
  }),
  pathCase("path-recursive-string-compare", "string(allPaths) == '/deep/z/path-recursive-string-compare'", {
    customMatch: `    match /deep/{allPaths=**} {
      allow get: if request.path[4] == 'z' && string(allPaths) == '/deep/z/path-recursive-string-compare';
    }`,
    path: "/b/corpus/o/deep/z/path-recursive-string-compare",
  }),
  pathCase("path-root-recursive", "allPaths[0] == 'anywhere'", {
    customMatch: `    match /{allPaths=**} {
      allow get: if request.path[3] == 'anywhere' && allPaths[0] == 'anywhere' && allPaths[1] == 'path-root-recursive';
    }`,
    path: "/b/corpus/o/anywhere/path-root-recursive",
  }),
  pathCase("path-unicode-name", "name == '火🔥.txt'", {
    customMatch: `    match /unicode/{name} {
      allow get: if name == '火🔥.txt';
    }`,
    path: "/b/corpus/o/unicode/火🔥.txt",
  }),
  pathCase("path-space-name", "name == 'has space.txt' && name.size() == 14", {
    customMatch: `    match /spaced/{name} {
      allow get: if name == 'has space.txt' && name.size() == 14;
    }`,
    path: "/b/corpus/o/spaced/has space.txt",
  }),
  pathCase("path-dot-segment-literal", "true", {
    customMatch: `    match /images.v2/{name} {
      allow get: if name == 'path-dot-segment-literal';
    }`,
    path: "/b/corpus/o/images.v2/path-dot-segment-literal",
  }),
  pathCase("path-user-scoped-allow", "request.auth.uid == uid", {
    customMatch: `    match /users/{uid}/{allPaths=**} {
      allow get: if request.path[5] == 'path-user-scoped-allow' && request.auth.uid == uid;
    }`,
    path: "/b/corpus/o/users/alice/path-user-scoped-allow",
  }),
  pathCase("path-user-scoped-deny", "request.auth.uid == uid", {
    customMatch: `    match /users/{uid}/{allPaths=**} {
      allow get: if request.path[5] == 'path-user-scoped-deny' && request.auth.uid == uid;
    }`,
    path: "/b/corpus/o/users/bob/path-user-scoped-deny",
  }),
  pathCase("path-binding-in-list", "bucket in ['corpus', 'other']"),
  pathCase("path-path-in-list", "request.path in [/b/corpus/o/lang/path-path-in-list, /b/corpus/o/lang/other]"),
  pathCase("path-size-not-a-function", "request.path.size() == 5"),
  pathCase("path-index-string-error", "request.path['b'] == 'b'"),
  pathCase("path-binding-concat", "bucket + '-suffix' == 'corpus-suffix'"),
  pathCase("path-wildcard-name-with-dot", "name.split('.')[1] == 'png'", {
    customMatch: `    match /dotted/{name} {
      allow get: if name.split('.')[1] == 'png';
    }`,
    path: "/b/corpus/o/dotted/photo.png",
  }),

  pathCase("path-recursive-tail-excludes-prefix", "allPaths == /p/path-recursive-tail-excludes-prefix", {
    customMatch: `    match /deep/{allPaths=**} {
      allow get: if request.path[4] == 'p' && allPaths == /p/path-recursive-tail-excludes-prefix;
    }`,
    path: "/b/corpus/o/deep/p/path-recursive-tail-excludes-prefix",
  }),
  pathCase("path-recursive-tail-index", "allPaths[0] == 'q'", {
    customMatch: `    match /deep/{allPaths=**} {
      allow get: if request.path[4] == 'q' && allPaths[0] == 'q' && allPaths[1] == 'path-recursive-tail-index';
    }`,
    path: "/b/corpus/o/deep/q/path-recursive-tail-index",
  }),
  pathCase("path-recursive-tail-single", "allPaths == /path-recursive-tail-single", {
    customMatch: `    match /deep/{allPaths=**} {
      allow get: if request.path[4] == 'path-recursive-tail-single' && allPaths == /path-recursive-tail-single;
    }`,
    path: "/b/corpus/o/deep/path-recursive-tail-single",
  }),
  pathCase("path-recursive-tail-string", "string(allPaths) == '/r/path-recursive-tail-string'", {
    customMatch: `    match /deep/{allPaths=**} {
      allow get: if request.path[4] == 'r' && string(allPaths) == '/r/path-recursive-tail-string';
    }`,
    path: "/b/corpus/o/deep/r/path-recursive-tail-string",
  }),
  pathCase("path-space-name-size", "name == 'has space.txt' && name.size() == 13", {
    customMatch: `    match /spaced2/{name} {
      allow get: if name == 'has space.txt' && name.size() == 13;
    }`,
    path: "/b/corpus/o/spaced2/has space.txt",
  }),
  pathCase("path-wildcard-split-regex-escaped", "name.split('[.]')[1] == 'png'", {
    customMatch: `    match /dotted2/{name} {
      allow get: if name.split('[.]')[1] == 'png' && name.split('[.]').size() == 2;
    }`,
    path: "/b/corpus/o/dotted2/photo.png",
  }),
  pathCase("path-unknown-variable-is-null", "nosuchvariable == null"),

  // --- request-time ------------------------------------------------------
  timeCase("time-is-timestamp", "request.time is timestamp"),
  timeCase("time-year", "request.time.year() == 2026 && request.time.month() == 1 && request.time.day() == 15"),
  timeCase("time-clock", "request.time.hours() == 12 && request.time.minutes() == 34 && request.time.seconds() == 56"),
  timeCase("time-nanos", "request.time.nanos() == 123456789"),
  timeCase("time-millis", "request.time.toMillis() == 1768480496123"),
  timeCase("time-day-of-week", "request.time.dayOfWeek() == 4 && request.time.dayOfYear() == 15"),
  timeCase("time-compare-date", "request.time > timestamp.date(2026, 1, 1) && request.time < timestamp.date(2027, 1, 1)"),
  timeCase("time-plus-duration", "request.time + duration.value(1, 'h') > request.time"),
  timeCase("time-minus-created", "request.time - resource.timeCreated > duration.value(5, 'd')"),
  timeCase("time-string-form", "string(request.time) is string"),

  // --- request-auth-shapes ------------------------------------------------
  authCase("auth-null", "request.auth == null", { auth: null }),
  authCase("auth-null-uid-error", "request.auth.uid == 'alice'", { auth: null }),
  authCase("auth-null-guarded", "request.auth != null && request.auth.uid == 'alice'", { auth: null }),
  authCase("auth-null-or", "request.auth == null || request.auth.uid == 'alice'", { auth: null }),
  authCase("auth-present", "request.auth != null"),
  authCase("auth-uid", "request.auth.uid == 'alice' && request.auth.uid is string"),
  authCase("auth-uid-matches-token-sub", "request.auth.uid == request.auth.token.sub && request.auth.uid == request.auth.token.user_id"),
  authCase("auth-token-map", "request.auth.token is map"),
  authCase("auth-token-email", "request.auth.token.email == 'alice@example.test' && request.auth.token.email_verified == true"),
  authCase("auth-token-email-domain", "request.auth.token.email.matches('.*@example[.]test$')"),
  authCase("auth-token-custom-claim-false", "request.auth.token.admin == true"),
  authCase("auth-token-custom-claim-true", "request.auth.token.admin == true", { auth: ADMIN_AUTH }),
  authCase("auth-token-custom-claim-string", "request.auth.token.plan == 'pro' && request.auth.token.quota >= 5"),
  authCase("auth-token-missing-claim-error", "request.auth.token.missing == true"),
  authCase("auth-token-missing-claim-in", "!('missing' in request.auth.token)"),
  authCase("auth-token-get-default", "request.auth.token.get('missing', false) == false"),
  authCase("auth-token-provider", "request.auth.token.firebase.sign_in_provider == 'password'"),
  authCase("auth-token-identities", "request.auth.token.firebase.identities.email[0] == 'alice@example.test'"),
  authCase("auth-token-identities-keys", "request.auth.token.firebase.identities.keys().hasOnly(['email'])"),
  authCase("auth-token-issuer", "request.auth.token.iss == 'https://securetoken.google.com/fireside-conformance' && request.auth.token.aud == 'fireside-conformance'"),
  authCase("auth-token-iat-exp", "request.auth.token.iat is int && request.auth.token.exp > request.auth.token.iat"),
  authCase("auth-admin-uid", "request.auth.uid == 'admin-user' && request.auth.token.firebase.sign_in_provider == 'custom'", { auth: ADMIN_AUTH }),
  authCase("auth-admin-no-email", "!('email' in request.auth.token)", { auth: ADMIN_AUTH }),
  authCase("auth-uid-binding", "request.auth.uid == uid", {
    customMatch: `    match /owned/{uid}/{name} {
      allow get: if name == 'auth-uid-binding' && request.auth.uid == uid;
    }`,
    path: "/b/corpus/o/owned/alice/auth-uid-binding",
  }),
  authCase("auth-owner-or-admin", "request.auth.uid == resource.metadata.owner || request.auth.token.admin == true", { auth: ADMIN_AUTH }),
  authCase("auth-in-list", "request.auth.uid in ['alice', 'bob']"),
  authCase("auth-token-keys-count", "request.auth.token.keys().size() == 12"),

  // --- firestore-get-and-exists ------------------------------------------
  firestoreCase("fs-get-data-bool", `firestore.get(${USERS_ALICE}).data.admin == true`, {
    functionMocks: [mockGet(USERS_ALICE, { value: USERS_DOC })],
  }),
  firestoreCase("fs-get-data-string", `firestore.get(${USERS_ALICE}).data.plan == 'pro'`, {
    functionMocks: [mockGet(USERS_ALICE, { value: USERS_DOC })],
  }),
  firestoreCase("fs-get-data-int", `firestore.get(${USERS_ALICE}).data.limit > resource.size / 1024`, {
    functionMocks: [mockGet(USERS_ALICE, { value: USERS_DOC })],
  }),
  firestoreCase("fs-get-data-list", `firestore.get(${USERS_ALICE}).data.tags.hasAny(['b'])`, {
    functionMocks: [mockGet(USERS_ALICE, { value: USERS_DOC })],
  }),
  firestoreCase("fs-get-data-map", `firestore.get(${USERS_ALICE}).data is map`, {
    functionMocks: [mockGet(USERS_ALICE, { value: USERS_DOC })],
  }),
  firestoreCase("fs-get-data-missing-field-error", `firestore.get(${USERS_ALICE}).data.missing == true`, {
    functionMocks: [mockGet(USERS_ALICE, { value: USERS_DOC })],
  }),
  firestoreCase("fs-get-data-in", `'admin' in firestore.get(${USERS_ALICE}).data`, {
    functionMocks: [mockGet(USERS_ALICE, { value: USERS_DOC })],
  }),
  firestoreCase("fs-get-id", `firestore.get(${USERS_ALICE}).id == 'alice'`, {
    functionMocks: [mockGet(USERS_ALICE, { value: { ...USERS_DOC, id: "alice", __name__: USERS_ALICE } })],
  }),
  firestoreCase("fs-get-name", `firestore.get(${USERS_ALICE}).__name__ == ${USERS_ALICE}`, {
    functionMocks: [mockGet(USERS_ALICE, { value: { ...USERS_DOC, id: "alice", __name__: USERS_ALICE } })],
  }),
  firestoreCase("fs-get-interpolated-uid", "firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.admin == true", {
    functionMocks: [mockGet(USERS_ALICE, { value: USERS_DOC })],
  }),
  firestoreCase("fs-get-interpolated-bucket", "firestore.get(/databases/(default)/documents/buckets/$(bucket)).data.open == true", {
    functionMocks: [mockGet("/databases/(default)/documents/buckets/corpus", { value: { data: { open: true } } })],
  }),
  firestoreCase("fs-get-interpolated-binding", "firestore.get(/databases/(default)/documents/objects/$(name)).data.public == true", {
    customMatch: `    match /fsobj/{name} {
      allow get: if firestore.get(/databases/(default)/documents/objects/$(name)).data.public == true;
    }`,
    path: "/b/corpus/o/fsobj/fs-get-interpolated-binding",
    functionMocks: [mockGet("/databases/(default)/documents/objects/fs-get-interpolated-binding", { value: { data: { public: true } } })],
  }),
  firestoreCase("fs-get-undefined-error", `firestore.get(${USERS_ALICE}).data.admin == true`, {
    functionMocks: [mockGet(USERS_ALICE, { undefined: {} })],
  }),
  firestoreCase("fs-get-wrong-path-unmocked", "firestore.get(/databases/(default)/documents/users/bob).data.admin == true", {
    functionMocks: [mockGet(USERS_ALICE, { value: USERS_DOC })],
  }),
  firestoreCase("fs-exists-true", `firestore.exists(${USERS_ALICE})`, {
    functionMocks: [mockExists(USERS_ALICE, true)],
  }),
  firestoreCase("fs-exists-false", `firestore.exists(${USERS_ALICE})`, {
    functionMocks: [mockExists(USERS_ALICE, false)],
  }),
  firestoreCase("fs-exists-negated", `!firestore.exists(${USERS_ALICE})`, {
    functionMocks: [mockExists(USERS_ALICE, false)],
  }),
  firestoreCase("fs-exists-interpolated", "firestore.exists(/databases/(default)/documents/users/$(request.auth.uid))", {
    functionMocks: [mockExists(USERS_ALICE, true)],
  }),
  firestoreCase("fs-get-and-exists", `firestore.exists(${USERS_ALICE}) && firestore.get(${USERS_ALICE}).data.admin == true`, {
    functionMocks: [mockExists(USERS_ALICE, true), mockGet(USERS_ALICE, { value: USERS_DOC })],
  }),
  firestoreCase("fs-get-short-circuit", `request.auth.token.admin == true || firestore.get(${USERS_ALICE}).data.admin == true`, {
    functionMocks: [mockGet(USERS_ALICE, { value: USERS_DOC })],
  }),
  firestoreCase("fs-get-no-mock-error", `firestore.get(${USERS_ALICE}).data.admin == true`),
  firestoreCase("fs-exists-no-mock-error", `firestore.exists(${USERS_ALICE})`),
  firestoreCase("fs-get-named-database", "firestore.get(/databases/secondary/documents/users/alice).data.admin == true", {
    functionMocks: [mockGet("/databases/secondary/documents/users/alice", { value: USERS_DOC })],
  }),
  firestoreCase("fs-get-nested-map", `firestore.get(${USERS_ALICE}).data.profile.role == 'editor'`, {
    functionMocks: [mockGet(USERS_ALICE, { value: { data: { profile: { role: "editor" } } } })],
  }),
  firestoreCase("fs-get-list-index", `firestore.get(${USERS_ALICE}).data.tags[1] == 'b'`, {
    functionMocks: [mockGet(USERS_ALICE, { value: USERS_DOC })],
  }),
  firestoreCase("fs-bare-get-unavailable", `get(${USERS_ALICE}).data.admin == true`),
  firestoreCase("fs-bare-exists-unavailable", `exists(${USERS_ALICE})`),

  // --- match-patterns --------------------------------------------------------
  matchCase("match-nested-literal", "true", {
    customMatch: `    match /nested {
      match /child/{name} {
        allow get: if name == 'match-nested-literal';
      }
    }`,
    path: "/b/corpus/o/nested/child/match-nested-literal",
  }),
  matchCase("match-nested-wildcard-inherits", "true", {
    customMatch: `    match /albums/{album} {
      match /photos/{photo} {
        allow get: if album == 'summer' && photo == 'match-nested-wildcard-inherits';
      }
    }`,
    path: "/b/corpus/o/albums/summer/photos/match-nested-wildcard-inherits",
  }),
  matchCase("match-parent-does-not-cover-child", "true", {
    customMatch: `    match /parentonly/{name} {
      allow get: if true;
    }`,
    path: "/b/corpus/o/parentonly/match-parent-does-not-cover-child/extra",
  }),
  matchCase("match-overlapping-allows-or", "true", {
    customMatch: `    match /overlap/{name} {
      allow get: if false;
    }
    match /overlap/{other} {
      allow get: if other == 'match-overlapping-allows-or';
    }`,
    path: "/b/corpus/o/overlap/match-overlapping-allows-or",
  }),
  matchCase("match-recursive-and-single-both", "true", {
    customMatch: `    match /both/{name} {
      allow get: if false;
    }
    match /both/{allPaths=**} {
      allow get: if allPaths == /both/match-recursive-and-single-both;
    }`,
    path: "/b/corpus/o/both/match-recursive-and-single-both",
  }),
  matchCase("match-recursive-deep-in-nested", "true", {
    customMatch: `    match /tenant/{tenant} {
      match /{allPaths=**} {
        allow get: if tenant == 't1' && allPaths == /a/b/match-recursive-deep-in-nested;
      }
    }`,
    path: "/b/corpus/o/tenant/t1/a/b/match-recursive-deep-in-nested",
  }),
  matchCase("match-no-match-denies", "true", {
    customMatch: `    match /elsewhere/{name} {
      allow get: if true;
    }`,
    path: "/b/corpus/o/nowhere/match-no-match-denies",
  }),
  matchCase("match-literal-case-sensitive", "true", {
    customMatch: `    match /Public/{name} {
      allow get: if true;
    }`,
    path: "/b/corpus/o/public/match-literal-case-sensitive",
  }),
  matchCase("match-error-in-one-allow-other-allows", "true", {
    customMatch: `    match /errallow/{name} {
      allow get: if resource.metadata.missing == 'x';
      allow get: if name == 'match-error-in-one-allow-other-allows';
    }`,
    path: "/b/corpus/o/errallow/match-error-in-one-allow-other-allows",
  }),
  matchCase("match-error-only-allow-denies", "true", {
    customMatch: `    match /erronly/{name} {
      allow get: if resource.metadata.missing == 'x';
    }`,
    path: "/b/corpus/o/erronly/match-error-only-allow-denies",
  }),
  matchCase("match-non-boolean-condition", "true", {
    customMatch: `    match /nonbool/{name} {
      allow get: if resource.size;
    }`,
    path: "/b/corpus/o/nonbool/match-non-boolean-condition",
  }),
  matchCase("match-wildcard-then-literal", "true", {
    customMatch: `    match /{folder}/fixed/{name} {
      allow get: if folder == 'wild' && name == 'match-wildcard-then-literal';
    }`,
    path: "/b/corpus/o/wild/fixed/match-wildcard-then-literal",
  }),
  matchCase("match-bucket-wildcard-other-bucket", "bucket == 'other-bucket'", {
    path: "/b/other-bucket/o/lang/match-bucket-wildcard-other-bucket",
  }),
  matchCase("match-list-on-prefix", "true", {
    method: "list",
    customMatch: `    match /listing/{allPaths=**} {
      allow list: if allPaths == /listing/match-list-on-prefix;
    }`,
    path: "/b/corpus/o/listing/match-list-on-prefix",
  }),
  matchCase("match-list-on-root", "true", {
    method: "list",
    customMatch: `    match /{allPaths=**} {
      allow list: if request.path[3] == 'match-list-on-root';
    }`,
    path: "/b/corpus/o/match-list-on-root",
  }),

  matchCase("match-recursive-tail-and-single", "true", {
    customMatch: `    match /both2/{name} {
      allow get: if false;
    }
    match /both2/{allPaths=**} {
      allow get: if allPaths == /match-recursive-tail-and-single;
    }`,
    path: "/b/corpus/o/both2/match-recursive-tail-and-single",
  }),
  matchCase("match-list-on-prefix-tail", "true", {
    method: "list",
    customMatch: `    match /listing2/{allPaths=**} {
      allow list: if allPaths == /match-list-on-prefix-tail;
    }`,
    path: "/b/corpus/o/listing2/match-list-on-prefix-tail",
  }),

  matchCase("list-single-wildcard-exact-path", "true", {
    method: "list",
    customMatch: `    match /la/{x} {
      allow list: if x == 'q';
    }`,
    path: "/b/corpus/o/la/q",
  }),
  matchCase("list-single-wildcard-longer-path", "true", {
    method: "list",
    customMatch: `    match /lb/{x} {
      allow list: if true;
    }`,
    path: "/b/corpus/o/lb/q/extra",
  }),
  matchCase("list-recursive-shorter-path-unbound-wildcard", "true", {
    method: "list",
    customMatch: `    match /lc/{uid}/{allPaths=**} {
      allow list: if true;
    }`,
    path: "/b/corpus/o/lc",
  }),
  matchCase("list-recursive-shorter-path-unbound-wildcard-null", "true", {
    method: "list",
    customMatch: `    match /ld/{uid}/{allPaths=**} {
      allow list: if uid == null;
    }`,
    path: "/b/corpus/o/ld",
  }),
  matchCase("list-recursive-shorter-path-unbound-wildcard-access", "true", {
    method: "list",
    customMatch: `    match /le/{uid}/{allPaths=**} {
      allow list: if uid == 'alice';
    }`,
    path: "/b/corpus/o/le",
  }),
  matchCase("list-recursive-zero-segments-true", "true", {
    method: "list",
    customMatch: `    match /lf/{uid}/{allPaths=**} {
      allow list: if uid == 'alice';
    }`,
    path: "/b/corpus/o/lf/alice",
  }),
  matchCase("list-recursive-zero-segments-binding-is-path", "true", {
    method: "list",
    customMatch: `    match /lg/{uid}/{allPaths=**} {
      allow list: if uid == 'alice' && allPaths is path;
    }`,
    path: "/b/corpus/o/lg/alice",
  }),
  matchCase("list-recursive-zero-segments-binding-null", "true", {
    method: "list",
    customMatch: `    match /lh/{uid}/{allPaths=**} {
      allow list: if uid == 'alice' && allPaths == null;
    }`,
    path: "/b/corpus/o/lh/alice",
  }),
  matchCase("list-recursive-one-segment-index", "true", {
    method: "list",
    customMatch: `    match /li/{allPaths=**} {
      allow list: if allPaths[0] == 'users';
    }`,
    path: "/b/corpus/o/li/users",
  }),
  matchCase("list-literal-then-wildcards-partial", "true", {
    method: "list",
    customMatch: `    match /lj/{x}/b/{y} {
      allow list: if x == 'q';
    }`,
    path: "/b/corpus/o/lj/q",
  }),
  matchCase("list-literal-then-wildcards-partial-unbound", "true", {
    method: "list",
    customMatch: `    match /lk/{x}/b/{y} {
      allow list: if x == 'q' && y == null;
    }`,
    path: "/b/corpus/o/lk/q",
  }),
  matchCase("get-recursive-zero-segments", "true", {
    method: "get",
    customMatch: `    match /ll/{uid}/{allPaths=**} {
      allow get: if uid == 'alice' && allPaths is path;
    }`,
    path: "/b/corpus/o/ll/alice",
  }),
  matchCase("get-recursive-zero-segments-null", "true", {
    method: "get",
    customMatch: `    match /lm/{uid}/{allPaths=**} {
      allow get: if uid == 'alice' && allPaths == null;
    }`,
    path: "/b/corpus/o/lm/alice",
  }),
  matchCase("get-single-wildcard-shorter-path", "true", {
    method: "get",
    customMatch: `    match /ln/{uid}/{name} {
      allow get: if true;
    }`,
    path: "/b/corpus/o/ln/alice",
  }),
  matchCase("list-recursive-zero-segments-resource-null", "true", {
    method: "list",
    customMatch: `    match /lo/{allPaths=**} {
      allow list: if resource == null && request.resource == null;
    }`,
    path: "/b/corpus/o/lo",
  }),

  // --- functions-and-let ------------------------------------------------------
  functionCase("fn-service-level", "isOwner()", {
    serviceFunctions: `  function isOwner() {
    return request.auth != null && request.auth.uid == resource.metadata.owner;
  }`,
  }),
  functionCase("fn-service-level-with-args", "sizeUnder(3000)", {
    serviceFunctions: `  function sizeUnder(limit) {
    return resource.size < limit;
  }`,
  }),
  functionCase("fn-match-level", "true", {
    customMatch: `    match /fn/fn-match-level {
      function isImage() {
        return resource.contentType.matches('image/.*');
      }
      allow get: if isImage();
    }`,
    path: "/b/corpus/o/fn/fn-match-level",
  }),
  functionCase("fn-let-binding", "true", {
    customMatch: `    match /fn/fn-let-binding {
      function withinQuota() {
        let quota = request.auth.token.quota;
        let kib = resource.size / 1024;
        return kib < quota;
      }
      allow get: if withinQuota();
    }`,
    path: "/b/corpus/o/fn/fn-let-binding",
  }),
  functionCase("fn-path-argument", "true", {
    customMatch: `    match /fn/fn-path-argument {
      function isUnder(prefix) {
        return request.path[0:3] == prefix;
      }
      allow get: if isUnder(/b/corpus/o);
    }`,
    path: "/b/corpus/o/fn/fn-path-argument",
  }),
  functionCase("fn-resource-argument", "true", {
    customMatch: `    match /fn/fn-resource-argument {
      function ownedBy(object, uid) {
        return object.metadata.owner == uid;
      }
      allow get: if ownedBy(resource, request.auth.uid);
    }`,
    path: "/b/corpus/o/fn/fn-resource-argument",
  }),
  functionCase("fn-request-resource-argument", "true", {
    method: "create",
    customMatch: `    match /fn/fn-request-resource-argument {
      function validUpload(object) {
        return object.size < 8192 && object.contentType.matches('image/.*');
      }
      allow create: if validUpload(request.resource);
    }`,
    path: "/b/corpus/o/fn/fn-request-resource-argument",
  }),
  functionCase("fn-calls-function", "true", {
    customMatch: `    match /fn/fn-calls-function {
      function signedIn() {
        return request.auth != null;
      }
      function isAlice() {
        return signedIn() && request.auth.uid == 'alice';
      }
      allow get: if isAlice();
    }`,
    path: "/b/corpus/o/fn/fn-calls-function",
  }),
  functionCase("fn-firestore-in-function", "true", {
    customMatch: `    match /fn/fn-firestore-in-function {
      function isAdmin() {
        return firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.admin == true;
      }
      allow get: if isAdmin();
    }`,
    path: "/b/corpus/o/fn/fn-firestore-in-function",
    functionMocks: [mockGet(USERS_ALICE, { value: USERS_DOC })],
  }),
  functionCase("fn-error-propagates", "true", {
    customMatch: `    match /fn/fn-error-propagates {
      function broken() {
        return resource.metadata.missing == 'x';
      }
      allow get: if broken() || true;
    }`,
    path: "/b/corpus/o/fn/fn-error-propagates",
  }),
  functionCase("fn-let-shadow-binding", "true", {
    customMatch: `    match /fn/{name} {
      function tagged() {
        let name = 'shadowed';
        return name == 'shadowed';
      }
      allow get: if name == 'fn-let-shadow-binding' && tagged();
    }`,
    path: "/b/corpus/o/fn/fn-let-shadow-binding",
  }),
  functionCase("fn-service-level-inherits-binding", "bucketIs('corpus')", {
    serviceFunctions: `  function bucketIs(expected) {
    return bucket == expected;
  }`,
  }),
  functionCase("fn-service-level-unknown-binding-null", "bucketIsNull()", {
    serviceFunctions: `  function bucketIsNull() {
    return bucket == null;
  }`,
  }),
];

export function buildStorageLanguageBatches(): readonly StorageLanguageBatch[] {
  const ids = new Set<string>();
  for (const testCase of STORAGE_LANGUAGE_CASES) {
    if (ids.has(testCase.id)) throw new Error(`duplicate storage language case ${testCase.id}`);
    ids.add(testCase.id);
    if (!/^[a-z0-9-]+$/u.test(testCase.id)) {
      throw new Error(`storage language case id must be a plain slug: ${testCase.id}`);
    }
  }
  const batches: StorageLanguageBatch[] = [];
  for (let start = 0; start < STORAGE_LANGUAGE_CASES.length; start += STORAGE_RULES_CASES_PER_BATCH) {
    const cases = STORAGE_LANGUAGE_CASES.slice(start, start + STORAGE_RULES_CASES_PER_BATCH);
    const index = batches.length;
    batches.push({
      id: `storage-language-batch-${index.toString().padStart(2, "0")}`,
      source: buildSource(cases),
      cases,
      testCases: cases.map(toTestCase),
    });
  }
  return batches;
}

export function casePath(testCase: StorageLanguageCase): string {
  return testCase.path ?? `/b/${STORAGE_RULES_BUCKET}/o/lang/${testCase.id}`;
}

function objectName(testCase: StorageLanguageCase): string {
  return casePath(testCase).split("/").slice(4).join("/");
}

function toTestCase(testCase: StorageLanguageCase): StorageLanguageTestCase {
  const name = objectName(testCase);
  const auth = testCase.auth === undefined ? DEFAULT_AUTH : testCase.auth;
  const requestResource =
    "requestResource" in testCase
      ? testCase.requestResource
      : defaultRequestResource(testCase.method, name);
  const resource = "resource" in testCase ? testCase.resource : defaultResource(testCase.method, name);
  return {
    expectation: "ALLOW",
    request: {
      auth,
      method: testCase.method,
      path: casePath(testCase),
      time: STORAGE_RULES_REQUEST_TIME,
      resource: requestResource,
    },
    resource,
    ...(testCase.functionMocks === undefined ? {} : { functionMocks: testCase.functionMocks }),
    pathEncoding: "PLAIN",
    expressionReportLevel: "FULL",
  };
}

function buildSource(cases: readonly StorageLanguageCase[]): string {
  const serviceFunctions = cases
    .map((testCase) => testCase.serviceFunctions)
    .filter((value): value is string => value !== undefined)
    .join("\n");
  const matches = cases
    .map(
      (testCase) =>
        testCase.customMatch ??
        `    match /lang/${testCase.id} {
      allow ${testCase.method}: if ${testCase.expression};
    }`,
    )
    .join("\n");
  return `rules_version = '2';
service firebase.storage {
${serviceFunctions.length > 0 ? `${serviceFunctions}\n` : ""}  match /b/{bucket}/o {
${matches}
  }
}
`;
}
