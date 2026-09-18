# storage-rules-v1 — Phase G oracle corpus for Storage Security Rules

Frozen evidence for evaluating `service firebase.storage` rulesets natively
(Phase G, `support/phase-g-storage-rules.md`, gate
`benchmarks/phase-g-storage-rules.json`). Two oracles, each owning one half of
the contract:

| File | Oracle | Owns |
| --- | --- | --- |
| `production-expression-corpus.json` | Production Rules API `projects.test` for project `fireside-conformance` (`capture:storage:rules:cloud`, `src/storage-rules/language-plan.ts`) | Expression semantics over the Storage value surface: 306 cases in 10 batches, FULL expression reports, no persistent reads or writes, no credentials stored |
| `emulator-programs.json` | Official Storage emulator, firebase-tools 15.22.0 in process with `cloud-storage-rules-runtime-v1.1.3.jar` (`0cd52db6…`) and the official Firestore emulator 1.22.0 registered for `firestore.*` callbacks (`capture:storage:rules`, `src/storage-rules/emulator-plan.ts`) | The request model: 26 programs, 334 raw HTTP steps, each step optionally installing its own one-line ruleset through `PUT /internal/setRules` so a verdict localizes to one field |

Precedence (recorded in the gate file): production for expression semantics;
where the emulator and production disagree on the request model, production
wins and the emulator divergence is listed below. Everything is synthetic.
The unsigned JWTs in `tokens` are synthetic test identities, not credentials.

## What the production corpus established

- The Storage `resource` and `request.resource` are maps: `is map`, `keys()`,
  `in`, `get(k, default)` work; a missing field is a runtime error
  (`Property x is undefined on object`), `!('x' in resource)` is the guard.
- `timeCreated` / `updated` are timestamps; `size`, `generation`,
  `metageneration` are ints; `md5Hash`, `crc32c`, `etag`, `contentType`,
  `contentDisposition`, `contentEncoding`, `name`, `bucket` are strings;
  `metadata` is a string→string map. `projects.test` converts every RFC 3339
  shaped string to a timestamp (including inside `metadata`), which the corpus
  avoids; the emulator oracle owns metadata typing (always strings).
- `request.path` is a path: indexing, slicing and `==` against path literals
  work; `request.path.size()` is `Function not found`; indexing with a string
  is a property access error; an out-of-range index is `Index out of bound`.
- `request.method` is the operation name; `allow read` covers get+list,
  `allow write` covers create+update+delete; overlapping allows OR-compose.
- `request.query` is undefined under Storage (`Property query is undefined`).
- `resource` is null under `list` (compile-time warning "Invalid variable
  name: resource", runtime null). `request.resource` is null except on
  create/update; a field access on either null is `Null value error` → deny.
- `request.auth` is null for anonymous requests; `request.auth.uid` on null is
  a `Null value error`; `request.auth.token` is the raw claim map.
- A recursive wildcard binds the segments *after* its literal prefix
  (`match /deep/{allPaths=**}` with `/deep/x/y` binds `/x/y`), may bind zero
  segments (an empty path, not null), and its bindings index like paths.
  A single-segment wildcard never matches a shorter or longer path, for `list`
  as much as for `get`: `match /la/{x}` matches a list on `/la/q`; a list on
  `/lc` never matches `/lc/{uid}/{allPaths=**}`.
- `firestore.get(path)` / `firestore.exists(path)` are the only document
  functions; bare `get` / `exists` compile with a warning and fail at runtime
  (`Function not found error: Name: [get]`). In `projects.test` they exist
  only through `functionMocks`; the real callback behaviour is in the emulator
  corpus.
- `string(timestamp)` and `string(path)` are `Unsupported operation` errors;
  `int('3') == 3`; `hashing.sha256('text')` hashes the UTF-8 bytes;
  `toMillis()` and `dayOfYear()` exist on timestamps.
- `split(re)` splits on every regular-expression match, zero-width matches
  included at any position (`'ab'.split('b*') == ['', 'a']`), drops trailing
  empty pieces (`'photo.png'.split('g') == ['photo.pn']`) and collapses an
  all-empty result to `['']` (`'photo.png'.split('.') == ['']`); no match
  returns the input (`''.split(',') == ['']`).
- Boolean operators are three-valued over runtime errors: a false operand
  decides `&&` and a true operand decides `||` even when the other operand
  errors (`broken() || true` allows, `error && false` denies without an
  error); otherwise the error stands (`error || false`, `false || error`).
- Functions are lexically scoped: a service-level function referencing a
  match wildcard sees an unbound name (`Null value error`), not the caller's
  binding.
- An unknown identifier compiles with a warning and is a `Null value error` at
  runtime even against `== null`; a service-level function does not see match
  bindings (same error). A non-boolean allow condition is a `Type error`.

## What the emulator corpus established (request model)

- `request.auth.uid` is the `user_id` claim only; a token with just `sub` has
  `uid == null` (`sub-only-uid-is-null`). Both `Bearer` and `Firebase` schemes
  decode; malformed tokens, `Basic …`, a bare `Bearer`, and no header are all
  `request.auth == null`; expiry is not checked; the token map is the raw
  payload; `request.auth.keys()` is `['uid', 'token']`.
- `resource` is the stored object (or null) on get/update/delete and null on
  create-of-new and list; `request.resource` is the proposed object on
  create/update and null otherwise. Both carry exactly 14 keys: name, bucket,
  generation, metageneration, size, timeCreated, updated, md5Hash, crc32c,
  etag, contentDisposition, contentEncoding, contentType, metadata.
  `cacheControl` and `contentLanguage` are never exposed (`in` is false;
  access is an error). Absent contentDisposition/contentEncoding are present
  as null. `metadata` never contains `firebaseStorageDownloadTokens`.
- A v0 media upload (no metadata part) gets `contentType
  'application/octet-stream'` regardless of the request Content-Type header;
  a multipart upload takes contentType, contentDisposition, contentEncoding and
  custom metadata (stringified) from the metadata part; the object name comes
  from `?name=` (multipart without it is 400).
- On a metadata PATCH `request.resource` is the merged object: `metageneration`
  is `resource.metageneration + 1`, `updated` moves, size/hashes/generation are
  unchanged, `metadata: {k: null}` removes a key, `contentType: null` leaves
  the key present with a null value.
- An upload over an existing object is checked as **create** with `resource`
  set to the stored object; `allow update` alone never admits it
  (`upload-over-existing`). The plan's production-vs-emulator question on this
  is settled for the emulator; production `projects.test` has no upload path,
  so the emulator model is adopted and named here.
- Rules run once, at finalize, for resumable uploads, with the received size;
  a denied finalize answers 403 with `x-goog-upload-status: final`, a later
  `query` is 200 `final`, a later `finalize` is 403 `Forbidden` (text), and no
  object exists. The authorization captured at `start` is the one evaluated;
  a finalize sent by another user still succeeds
  (`resumable-auth-captured-finalize-as-bob`). A cancelled upload finalizes as
  400.
- `list` is evaluated on `/b/{bucket}/o/{prefix without trailing slash}`; the
  bucket root is `/b/{bucket}/o`. A `rules_version = '1'` ruleset loads, admits
  get/create, and denies list with the warning "Permission denied. List
  operations are only allowed for rules_version='2'."
- Order of checks: rules before existence. A get/delete of a missing object is
  403 when the rules deny or error and 404 when they allow; a PATCH of a
  missing object under `allow update` is 404.
- Bypasses: `Bearer owner` and `Firebase owner` skip rules everywhere;
  a valid download token skips rules for GET metadata and media only (PATCH
  and DELETE with a token are still evaluated); a wrong token is 403.
  `?create_token=` / `?delete_token=` and `/b/…/copyTo/…` are admin-only
  regardless of rules (`Missing admin credentials.`; copy hard-codes owner).
  Every JSON API route (`/storage/v1`, `/upload/storage/v1`,
  `/download/storage/v1`) skips rules with or without a user token; JSON PATCH
  is 501 in the official emulator.
- `firestore.get` / `firestore.exists` read the registered Firestore emulator
  at request time (latest state, not a snapshot): `.data` is the typed document
  map, `.id` is the document id, `.__name__` is the **project-qualified** path
  `/projects/{project}/databases/(default)/documents/…` (`is path`, `[0] ==
  'projects'`), the value `is map` with a `data` key. A missing document, a
  wrong database id or a path without `/databases/…/documents` is a `Null
  value error` on `.data`; `exists` returns false. Twenty-one distinct
  accesses in one request succeed (no access limit observed); repeats are
  served without error.
- Runtime errors deny with 403 and the emulator's warning line
  `com.google.firebase.rules.runtime.common.EvaluationException: Error:
  <file> line [n], column [m]. <text>`; an error in one allow does not stop a
  sibling allow or another match block from admitting the request.
- `PUT /internal/setRules`: single file → one ruleset for every bucket (also
  unconfigured buckets); multiple files need `resource` (else 400 "Each member
  of 'rules.files' array must contain 'name', 'content', and 'resource'");
  missing/empty `files` → 400 "Request body must include 'rules.files'
  array"; a compile failure → 400 "There was an error updating rules, see logs
  for more details" **and the previous ruleset is dropped**: every v0 request,
  owner included, is then 403 "Permission denied. Storage Emulator has no
  loaded ruleset." until a valid ruleset is installed; the JSON API is
  unaffected. In multi-file mode a bucket without a file behaves the same way.
  One invalid file of several leaves the other buckets served. A `service
  cloud.firestore` source loads (200) and, matching nothing, denies every
  request. A missing trailing semicolon is accepted.
- Startup with a ruleset that does not compile: the emulator starts, logs the
  parse issues, and serves 403 "no loaded ruleset" (owner included) until
  `setRules` installs a valid one.
- The consumer program replays the consumer's two rulesets verbatim: owner
  get/put/list/patch/delete under `/users/{uid}`, admin claim, anonymous and
  other-user denials, anonymous `get` on the assets bucket, anonymous `list`
  denied there, token-URL reads bypassing rules.

## Divergences (production precedence) and oracle limitations

| Id | Emulator | Production | Fireside |
| --- | --- | --- | --- |
| `request-method-undefined` | `request.method` is absent from the request map (`Property method is undefined on object`) | Defined; `allow read` still expands normally | Define `request.method` |
| `list-prefix-template-matching` | A `list` path is treated as a prefix: `/a/{x}` never matches a list on `/a/q`; a shorter path matches `/users/{uid}/{allPaths=**}` with `uid` unbound (`Null value error`); a one-segment `**` binding is a path template whose index errors (`Variable  is not bound in path template`) | Standard matching: `/la/{x}` matches `/la/q`; shorter paths do not match; `**` bindings index normally | Standard matching |
| `firestore-document-name-form` | `firestore.get(...).__name__` is `/projects/{p}/databases/(default)/documents/…` | Not observable through `projects.test` (mocks echo the supplied value) | Emulator form, the only runtime evidence |
| `no-firestore-access-limit` | 21 distinct `firestore.*` calls succeed | Not observable through mocks | No limit below 21; the replay asserts 21 |
| `set-rules-failure-drops-ruleset` | A failed reload leaves no ruleset (403 for everyone) | n/a (no reload API) | Parity on `setRules`; startup with a bad ruleset stays a startup failure |
| `empty-path-segment-crashes-runtime` | An object name with an empty segment (`a//b`) makes the rules runtime jar exit (`IllegalArgumentException: Path segment cannot be empty`) and the request never answers; recorded in `oracleCrashNotRecordedLive`, not replayed live | Unknown | Evaluate with empty segments dropped from the path, never hang |
| `projects-test-omitted-resource-undefined` | n/a | An omitted `resource` / `request.resource` in a test case is undefined (`Null value error`), so the corpus always passes them explicitly | Null when absent (emulator model) |
| `projects-test-rfc3339-strings-become-timestamps` | Metadata values are strings | `projects.test` converts RFC 3339 strings anywhere in the resource to timestamps | Strings (emulator model) |

## Layout

- `production-expression-corpus.json` — `batches[]` with `source`, `cases`
  (the plan entries), `testCases` (the exact `projects.test` requests) and the
  raw `response`; `results[]` summarizes `{id, category, method, state,
  error}`.
- `emulator-programs.json` — `tokens` (synthetic unsigned JWT payloads and
  encodings), `programs[]` each with `rules`, `rulesInstall`, `firestoreSeed`
  and `observations[]` of `{id, rulesInstall?, request {method, path,
  resolvedPath, headers, body}, response {status, headers, body}, logs}`.
  Paths may carry templates `{{uploadUrl:<step>}}` / `{{token:<step>}}` that a
  replay resolves from its own earlier responses; `authorization` values are
  `@name` / `firebase:@name` token references or literals. Dynamic values
  (generation, timestamps, etag, download tokens, upload ids, origins) are
  normalized to placeholders. `startupCompileError` records the separate
  bad-ruleset start.
- `SHA256SUMS` — frozen digests; `npm run test:storage-rules-fixtures` checks
  them and the structural minimums from the gate file.

Regenerating either file requires re-running the capture and re-freezing the
gate; fixtures are never edited by hand.
