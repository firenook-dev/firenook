# Phase G — Native Storage Security Rules (`0.1.0-next.7`)

Written 2026-09-17 against `main` 39ba9a2 (published engine 572d4fb,
`@fireside-dev/cli@0.1.0-next.6`). The plan below is retained as written; the
status section records what has landed since.

## Status (2026-09-18)

G0–G5 are done. PR #43 (Phases G and H together) merged into main as 860f4e1
and the qualified engine 0720434 was published 2026-09-18 as `@fireside-dev/cli@0.1.0-next.7` (tag `npm-v0.1.0-next.7` on main d38016d; release run 35327767919, 14/14 pre-publish jobs green, protected `npm-release` approval after a local `publish-packages --check`; registry integrity of all six packages equals the release assets; `npm audit signatures` verifies signatures and attestations; GitHub prerelease; `next` → next.7, `latest` untouched). Receipts:

| Step | Receipt |
| --- | --- |
| G0 | `benchmarks/phase-g-storage-rules.json` (frozen; Rules API probe `projects.test` accepted `service firebase.storage`, 3/3 SUCCESS, 2026-09-17T06:24:54Z, response `6852f9d5…`) — commit 63e9dc2 |
| G1 | `conformance/fixtures/storage-rules-v1`: 306 production `projects.test` cases in 10 batches (236 allow / 70 deny / 32 with runtime errors) and 26 official-emulator programs / 334 raw HTTP steps with the official Firestore emulator registered; `SHA256SUMS`, README with the divergence table, `npm run test:storage-rules-fixtures` in the `public-contracts` CI job — commits 63e9dc2, 71236d1, refrozen through a98ee49 |
| G2 | `crates/rules-engine`: `service firebase.storage`, `RulesService`, `StorageObject`, `request.path`, `firestore.get`/`exists`, path indexing/slicing, `int()`/`float()`, `toMillis()`/`dayOfYear()`; shared-language corrections established by the corpus (regex `split`, three-valued `&&`/`||` over errors, lexical function scope, `(default)` path segments); `tests/storage_oracle_replay.rs` replays all 306 cases and the 1024 Phase 3 cases still pass — commit e3eb0d8 |
| G3 | `crates/storage-front/src/rules.rs` native layer; `rules_replay_tests.rs` replays all 334 recorded steps over HTTP with parity or one of eight named divergences (five `request.method`, two list matching, one JSON-API PATCH); `storage-front` spawns no process; before/after rules-evaluated profile on the same Mac in `benchmarks/phase-g-storage-profile.json` (p50 upload 0.95 → 0.58 ms, metadata get 0.45 → 0.15 ms, denied read 0.48 → 0.14 ms; no regression at any percentile) — commits a98ee49, af93c14 |
| G4 | `--java` / `--storage-rules-jar` removed from the native CLI and `suite-runtime`; npm wrapper without the `java -version` gate, `--java` option or jar download (`setup` fetches the UI zip only); docs updated (README, CLI guide, COMPATIBILITY, DESIGN "Native Storage rules", ROADMAP); harnesses updated; CI step "Verify suite start without Java on PATH" (`conformance/src/suite/verify-no-java.mjs`: `java` shadowed by a failing shim and JAVA_HOME unset, UI-only asset cache, single-file `storage.rules`, owner/admin/list rules, `firestore.get` against live Firestore, `setRules` reload, clean shutdown — passes locally in 7.0 s to readiness) — commit 4ac8a0d |
| G5 | In progress. Done: exact-candidate CI green on PR #43 at cdabf62 (Rust gate, fixture/package checks, differential harness with the no-Java step, four browser-SDK cells, five packed installs — run 35196947926); consumer gates on the packed candidate `0.1.0-local.ga472db6e3dce` (integration gate 24/24; extensions gate 24 admitted / 2 upstream-ignored, as next.6; Phase 5 browser journeys 1–9 pass on the Mac against the full-data stack with no Java on the suite command line — `receipts.macJourneys`; two earlier journey failures reproduced identically on published next.6 and were harness dataset drift, fixed in the private harness at c0faebd); ~10-minute Linux smoke on the private acceptance host with the linux-x64 CI artifact and no Java on PATH (`verify-no-java.mjs` 12/12 steps, ready 5.6 s; same-host profile vs the next.6 engine under the Java runtime saves about 1 ms per rules-evaluated operation at p50 — `benchmarks/phase-g-storage-profile-linux.json`). Paired acceptance PASSED on the private acceptance host (attempt 13, 2026-09-18, engine 0720434: both 2 h soaks, export/restart, 36/36 browser journeys, exact stable-state parity, fresh setup on both backends — the Fireside stack ran with no Java process; Storage cycle 8.0 ms p50 vs 11.6 official with the native evaluator on every stage; 95 evidence checksums re-verified by an independent audit; three earlier attempts with identical inputs retained as failures for a browser verifier transient, a disk preflight and a consumer schedule firing in one stack's window — `benchmarks/phase-h-functions-runtime.json` `receipts.h5.pairedAcceptance`); the clean-setup-without-Java stage is the fresh-checkout stage of that run plus the Linux smoke; released as `0.1.0-next.7` on 2026-09-18 (release run 35327767919) |

Decisions the oracles settled differently from the plan's assumptions
(details in the fixture README and the gate's `decisions`): the official
emulator omits `request.method` and matches `list` paths as prefix templates —
production semantics are implemented and both are asserted as divergences; a
failed `/internal/setRules` drops the ruleset (parity, not "previous ruleset
kept"); every upload is `create` with `resource` set for an existing object;
the official rules runtime crashes on an object name with an empty segment,
which Fireside evaluates with the empty segment dropped. Two drop-in gaps
found on the way were closed in G4: the single-file `storage.rules` shape and
a `.firebaserc` without `targets`.

## Goal

Evaluate `service firebase.storage` rulesets in the existing Rust
`rules-engine`, so that Fireside has no Java dependency at all: no
`cloud-storage-rules-runtime` jar, no `java -version` gate, no jar download in
`fireside setup`, no per-request JVM round trip on the Storage path. Behaviour
is measured against the pinned official Storage emulator and the production
Rules API before the jar is removed, using the same oracle-first discipline as
Phase 3 (`conformance/fixtures/rules-v2`, `benchmarks/phase-3-rules.json`).

Out of scope: an own Emulator UI, the terminal launch experience, partial
`--only` profiles, `fireside init`, and replacing the firebase-tools
Functions/Extensions host — the last is [Phase H](phase-h-functions-runtime.md),
which follows this phase and is not started by it.

## Current state (verified 2026-09-17)

The whole Java surface of the product is one child process plus the gates that
exist to feed it.

| Where | What |
| --- | --- |
| `crates/storage-front/src/lib.rs:1826` | `RulesRuntime::start` spawns `java -Duser.language=en -jar <jar> serve`, piped stdin/stdout, one process per suite |
| `crates/storage-front/src/lib.rs:1865` | `load_ruleset` once per configured bucket at startup; no reload path exists (`/internal/setRules` is not implemented) |
| `crates/storage-front/src/lib.rs:1895` | `verify` per request behind `Mutex<RulesChild>`; requests serialize through the JVM |
| `crates/storage-front/src/lib.rs:1920` | A Firestore callback from the jar (`firestore.get()` / `firestore.exists()` in Storage rules) is answered with an error: "Storage rules requested a Firestore callback that is not available". The official `firebase init` Storage template's only example is exactly that call |
| `crates/storage-front/src/lib.rs:2005–2080` | Request model sent to the jar: `request.path` segments of `/b/{bucket}/o/{name}`, `request.time` = now, `request.auth` = unverified JWT payload with `uid` = `user_id` ?? `sub`, `request.resource` = the prospective object (14 metadata fields), `resource` = the stored object |
| `crates/storage-front/src/lib.rs:1701–1790` | Call sites: `get` (passes the object as both `resource` and `request.resource`), `list` (path `/b/{bucket}/o/{prefix}`, no resources), `create`/`update` at upload finalize (`:1655`, update when the object exists), `update` on metadata PATCH and token creation, `delete`. Bypasses kept outside rules: `Bearer owner` / `Firebase owner`, download tokens on reads, JSON API when `enforce_rules` is false |
| `crates/suite-runtime/src/lib.rs:627,731` | Preflight requires `java` and the jar; Storage is always started with `rules: Some(RulesRuntimeConfig { java, jar, buckets })`. `StorageConfig.rules: None` already exists in `storage-front` and is never used by the suite |
| `packages/cli/src/runtime.mjs:17–19,38` | Every `emulators:start`/`exec`/`doctor` runs `java -version` and fails without it; passes `--java` and `--storage-rules-jar` to the native binary |
| `packages/cli/src/assets.mjs:9` | `setup` downloads `cloud-storage-rules-runtime-v1.1.3.jar` (52,892,936 bytes, pinned SHA-256) beside the UI zip |
| `packages/cli/bin/fireside.mjs` | `--java PATH` option; help text "Requires Node 24 and Java for Storage rules" |
| `crates/rules-engine/src/parser.rs:57–59` | The Rust parser accepts only `service cloud.firestore` |
| `crates/rules-engine/src/evaluator.rs:612–671` | `request.{auth,method,time,resource,query}` and `resource.{data,__name__,createTime,updateTime}` are Firestore-shaped; `request.path` is not implemented for either service |
| `conformance/fixtures/firebase-suite-v1/storage-multi-bucket-rules-and-import-export` | The only Storage-rules oracle evidence today: four rule-relevant observations (owner upload/read, other-user denied, public read) |

Everything else that mentions Java (`conformance/fixtures/**/java-*`,
`capture-proxy` target names, comments) is recorded oracle evidence or
dev tooling and does not run Java at product runtime.

What the existing Rust engine already provides for the port: lexer, parser,
AST, `match` wildcards including `{name=**}`, user functions, the full
expression language and namespaces (`string`, `int`, `float`, `bytes`, `list`,
`map`, `path`, `duration`, `hashing`, `latlng`, `math`, `timestamp`), `read` /
`write` method expansion, the `DocumentAccess` trait with access accounting and
caching, evaluation traces and coverage layout. That is the majority of a
Storage rules runtime; the missing parts are the service head, the object
resource model, `firestore.*` and the Storage-side request construction.

The consumer rulesets this must run unchanged: two buckets via
`.firebaserc` targets, `request.auth.uid == uid`, `request.auth.token.admin ==
true`, `allow get` distinct from `list`, `{allPaths=**}`; no `firestore.*`,
no `request.resource` fields.

## Oracles and precedence (freeze before implementation)

Record in `benchmarks/phase-g-storage-rules.json`, `frozen: true`, before any
product change, mirroring `phase-3-rules.json`:

1. **Production Rules API** (`firebaserules.googleapis.com/v1/projects/fireside-conformance:test`)
   for expression semantics over the Storage `request`/`resource` value
   surface. The API evaluates `service firebase.storage` sources with a
   synthetic request; no bucket, object or persistent write is involved. Same
   allowlist variable (`CONFORMANCE_CLOUD_ALLOWLIST`), same per-capture budget
   (≤128 requests), no credentials stored.
2. **Official Storage emulator**, firebase-tools 15.22.0 `StorageEmulator` in
   process with the exact jar `0cd52db6…` (already how
   `conformance/src/suite/capture-storage.ts` records), plus the pinned
   official Firestore emulator 1.22.0 registered for `firestore.*` callbacks.
   This oracle owns the *request model*: which fields the emulator populates,
   when `request.resource` is null, the `list` path shape, JSON-API bypass,
   resumable finalize timing, `/internal/setRules` responses, error → status
   mapping.
3. Official language reference, for naming only.

Classification rule, as in Phase 3: match production for expression
semantics; where the official emulator and production disagree on the request
model, follow production and record the emulator divergence explicitly in the
fixture's `invariants` (fireemu's recorded examples: an upload over an existing
object is `update` in production but `create` in the emulator;
`cacheControl`/`contentLanguage` visibility). No divergence is adopted
silently, and no fixture is edited after freezing (`SHA256SUMS`).

## Work packages

Feature-sized commits, fixtures before product code, short targeted tests per
commit; the long acceptance stays in G5.

### G0 — Freeze the gate (½ day)

- `benchmarks/phase-g-storage-rules.json`: toolchain pins (Rust, Node 24,
  firebase-tools 15.22.0 for the emulator oracle, jar SHA, Firestore emulator
  jar SHA), oracle precedence and budgets, the named checks below with their
  pass criteria, the list of Java surfaces that must be gone at the end
  (the table above), and the consumer/host acceptance identities that G5 will
  fill in.
- One production `projects.test` request with a trivial `firebase.storage`
  source to confirm the Rules API accepts the Storage service for this project
  before the corpus is designed. Record the receipt.
- Decision recorded now: rulesets without `rules_version = '2'` (v1) are
  measured in G1; if the emulator accepts them, Fireside accepts them with
  v1 semantics for Storage only if the oracle shows a difference that matters
  (`list`), otherwise they are rejected with a diagnostic naming the line.
  The official init template is v2.

### G1 — Oracle corpus (3–4 days)

New fixture set `conformance/fixtures/storage-rules-v1/` with its own README,
`SHA256SUMS`, and CI integrity check in the `public-contracts` job.

**Emulator programs** (`capture:storage:rules`, a new
`conformance/src/suite/capture-storage-rules.ts` built from `capture-storage.ts`):
raw HTTP against the official Storage emulator with the Firestore emulator
registered, every step recorded as `{id, method, path, headers (synthetic),
body digest, status, decoded verdict}` and diffed later against Fireside by the
existing replay pattern. Target ≥25 programs / ≥150 steps. Programs, each with
its own tiny ruleset so a failure localizes:

- Method model: `get`, `list`, `create`, `update`, `delete` individually
  granted; `read` = get+list and `write` = create+update+delete; `list` with and
  without `rules_version = '2'`; list on the bucket root and on a prefix; list
  path shape as the emulator hands it to rules.
- `request.resource` nullness and content on each method: size, contentType
  (explicit, defaulted, from the metadata part of a multipart upload), custom
  `metadata`, `md5Hash`/`crc32c` presence, `name`/`bucket`, generation and
  metageneration, `timeCreated`/`updated`, `cacheControl`, `contentLanguage`,
  `contentDisposition`, `contentEncoding`, `etag`.
- `resource` on update and delete: locked-flag style gates; delete of a
  missing object under a rule that dereferences `resource`; metadata PATCH as
  `update`; download-token creation as `update`.
- Upload paths: simple, multipart, resumable (denied at finalize with the
  received bytes, allowed at finalize), upload over an existing object
  (create vs update — production precedence, emulator divergence recorded).
- Auth: anonymous, ID token via `Authorization: Bearer` and `Firebase`
  schemes, `uid` from `user_id` vs `sub`, custom claims, `email`, expired or
  malformed token handling as the emulator does it.
- Bypasses: `Bearer owner`, `Firebase owner`, download-token reads, JSON API
  (`/storage/v1`, `/upload/storage/v1`, `/download/storage/v1`) with and
  without a user token.
- `firestore.get()` / `firestore.exists()`: allowing, denying, missing
  document, wrong database path, a document written after the ruleset loaded
  (latest state, not snapshot), the per-request access limit (a third call)
  and its error → status mapping, `.data` field access and type coercion.
- Path matching: single segment vs `{allPaths=**}` from a nested match,
  `$(variable)` in `firestore.*` paths, unicode and percent-encoded object
  names, names with `/` sequences, the `/b/{bucket}/o` root match.
- Runtime errors inside rules (missing field, type mismatch, division by
  zero) → the emulator's status and body.
- Ruleset lifecycle: startup with a compile error (status, message shape),
  `/internal/setRules` with valid and invalid sources, multi-bucket targets
  with different rulesets, requests to an unconfigured bucket.
- Consumer-shaped program: the consumer's two rulesets verbatim with synthetic
  users (owner get/put/list, other-user denied, admin claim, anonymous `get`
  on assets, anonymous `list` denied on assets).

**Production expression corpus** (`capture:storage:rules:cloud`, new
`conformance/src/rules/capture-storage-language.ts`): ≥200 deterministic
`projects.test` cases over the Storage value surface — every `resource` and
`request.resource` field with its type, null comparisons per method, `request.method`
strings, `request.path` segments, `request.time`, `request.auth` shapes,
`firestore.*` function mocks — captured with `expressionReportLevel=FULL` so
intermediate values are preserved. No persistent reads or writes.

Exit: fixtures committed with checksums and README; CI integrity green; the
divergence list between production and the emulator written down.

### G2 — Engine: `rules-engine` learns `firebase.storage` (4–6 days)

- `parser.rs`: accept `service cloud.firestore | firebase.storage`; expose
  `Ruleset::service() -> RulesService`; a ruleset installed for the wrong
  service is a compile-time `Diagnostic` (message per G1).
- `model.rs`: `RulesService`; `Resource` becomes service-shaped — keep the
  Firestore `Resource` and add `StorageObject { name, bucket, generation,
  metageneration, size, time_created, updated, md5_hash, crc32c, etag,
  content_disposition, content_encoding, content_type, content_language,
  cache_control, metadata: BTreeMap<String, String> }` (nullable fields per
  G1); `EvaluationRequest` carries the service and the Storage variant of
  `resource` / `request_resource`; `request.path` implemented for both
  services as a `Value::Path`.
- `evaluator.rs`: field access on `StorageObject`; `request.query` is an
  error under Storage (or whatever G1 shows); `firestore` namespace with
  `get(path)` / `exists(path)` routed through `DocumentAccess::get` on a full
  `/databases/(default)/documents/…` path, with its own access limit and cache
  per request (limit value from G1); bare `get`/`exists`/`getAfter` remain
  Firestore-only; `debug()` and every existing namespace unchanged.
- `coverage_layout` / `trace`: service-agnostic; must not panic on a Storage
  ruleset even though the UI does not render Storage coverage.
- Tests: `crates/rules-engine/tests/storage_oracle_replay.rs` replays every
  G1 production case and every emulator verdict that is expressible without
  HTTP (mirrors `oracle_replay.rs`); property tests for path binding on object
  names; the consumer rulesets as a fixed test.

Exit: all G1 expression cases pass; documented divergences are asserted as
divergences, not skipped; `cargo clippy -D warnings`, `cargo fmt`.

### G3 — Storage front on the native engine (3–4 days)

- Replace `RulesRuntime` (Java child) with `NativeRules { rulesets:
  RwLock<BTreeMap<bucket, Arc<Ruleset>>>, documents: Arc<dyn DocumentAccess>
  }`. `RulesRuntimeConfig` loses `java` and `jar`; it keeps `buckets` and
  gains the document accessor. `StorageConfig.rules: None` stays the explicit
  open mode.
- Build `EvaluationRequest` from `StoredObject` at the existing call sites
  (`authorize`, `authorize_read`, `authorize_list`, finalize, PATCH, token
  creation, delete). The `request.resource` nullness per method, the `list`
  path form and `uid` derivation follow G1, not the current code (`get`
  currently passes the object as `request.resource`; that is measured, not
  assumed).
- `firestore.*` reads the suite's `core-store` through the injected accessor
  (latest committed state, per G1), so the callback error at `:1920`
  disappears.
- `/internal/setRules` implemented with the emulator's request/response shape
  from G1; rulesets swap atomically per bucket; a compile failure leaves the
  previous ruleset installed and returns the recorded error shape. This also
  makes `@firebase/rules-unit-testing`'s `loadStorageRules` work.
- Startup compile failure keeps today's behaviour: the suite fails to start
  with the diagnostics.
- Rules runtime errors and denials map to the statuses/bodies recorded in G1.
- Remove the `Mutex<RulesChild>`; evaluation is in-process and read-locked.
- Tests: storage-front unit tests replay every G1 emulator program over HTTP
  against Fireside (the existing `firebase-suite-v1` replay style) and assert
  parity or the recorded divergence; the two existing Storage rules tests keep
  passing; `profile-storage.mjs` (`benchmarks/phase-e-storage-profile.json`)
  is re-run before/after on the same Mac for the 64 KiB cycle so the removed
  JVM hop is measured, not asserted.

Exit: every G1 emulator step is parity or a listed divergence; the JSON API,
owner and download-token bypasses are unchanged; `storage-front` has no
`Command::new` left.

### G4 — Remove the runtime, the gates and the download (1–2 days)

- `suite-runtime`: drop `java` and `storage_rules_jar` from `SuiteConfig`,
  the preflight table and the Storage wiring; pass the store accessor instead.
- `crates/cli`: remove `--java` and `--storage-rules-jar` from the suite
  arguments. The native CLI's policy is that no option is silently ignored, so
  they are removed, not accepted-and-ignored; the npm wrapper is the only
  supported caller and is updated in the same change.
- `packages/cli`: delete the `java -version` gate and the `--java` option;
  `assets.mjs` keeps only the UI zip (setup still exists until the own UI
  lands); `doctor` output drops `java`; help text becomes "Requires Node 24";
  `runtime.mjs` stops passing the two arguments. Tests: `packaging/cli.test.mjs`,
  `processes.test.mjs`, `smoke-suite.mjs`.
- Docs: `README.md` (`:41,:46–47`), `packages/cli/README.md` (`:32,:111`),
  `COMPATIBILITY.md` Storage row ("rules evaluated natively; Java is not
  required"), `DESIGN.md` new section "Native Storage rules" (service model,
  `firestore.*` accessor, reload), `ROADMAP.md` closing paragraph, this file.
- CI: the conformance job keeps Java only for recording/replaying official
  oracles; the packages and Rust jobs must pass on a runner without Java.
  Add an explicit `Verify suite start without Java on PATH` step (PATH scrubbed,
  `which java` must fail) to the differential harness job.
- Consumer follow-ups on the pin bump: its setup documentation's "Java 26 is
  the tested Fireside Storage-rules runtime" becomes "Java is needed only for
  the official fallback"; its setup prerequisite check no longer requires Java
  when the backend is Fireside.

Exit: `grep -ri java crates packages` returns only oracle fixtures, comments
and the capture tooling; `fireside setup` downloads one asset.

### G5 — Qualification and release as `0.1.0-next.7` (3–5 days)

Named checks, all on the exact candidate commit:

1. Exact-candidate CI: Rust quality gate, public fixture/package checks,
   differential harness (including the new no-Java step), five-platform
   packages.
2. Consumer gates on the packed candidate: the integration gate, the
   extensions gate, journeys 1–6 on macOS (studio uploads
   under `/users/{uid}`, anonymous `get` on the assets bucket, anonymous
   `list` denied), and the supplemental cache-invalidation check from Phase F,
   whose first version recorded a rules-driven 403 on the assets bucket — that
   403 must still occur.
3. Private paired acceptance with the attempt-9 harness (`aa8b528`), a new
   `candidate-attempt-10.json`, frozen seed unchanged. The Storage cycle lane
   is the one expected to move; the official comparison from attempt 9 may be
   reused as banked evidence only if the host, seed and harness are unchanged,
   and is labelled as such.
4. **Clean-setup without Java**: a fresh-colleague stage on a machine or
   container where `java` is absent from PATH, from `bun install` through
   `fireside setup`, first start, an upload denied by rules, an upload allowed
   by rules, restart with resume, export. This is the headline claim of the
   release and is a named pass/fail stage, not a note.
5. Release, following the recorded procedure: release branch → PR → merge
   commit → annotated tag `npm-v0.1.0-next.7` → `check-release.mjs --release` →
   `release-npm.yml` → download + `publish-packages.mjs --check` → approve →
   registry integrity == release assets → `gh release edit --prerelease` →
   docs receipt PR → consumer pin bump with the extensions gate. `latest` stays
   untouched.

Exit: `support/phase-g-storage-rules.md` updated to a status document with
receipts (CI run ids, candidate identity, acceptance directory), `roadmap-progress.md`
row G, `COMPATIBILITY.md` and the CLI guide describing the new dependency set.

## Sequencing and size

G0 → G1 → G2 → G3 → G4 → G5, strictly; G2 and G3 may overlap once the G1
fixtures are frozen. Roughly three to four weeks for one engineer with agent
support; G1 is the part that must not be rushed, because everything after it
is measured against those recordings.

## Risks and how they are handled

- **Production vs emulator disagreement on the request model.** Expected; the
  freeze rule decides (production wins, emulator divergence recorded). The
  consumer rulesets do not touch the known divergent fields.
- **`firestore.*` in the emulator oracle needs a registered Firestore
  emulator**, otherwise the jar's callback fails the way Fireside's does today.
  The capture harness registers the pinned Firestore emulator before any
  `firestore.*` program runs; a program that observes the callback error is a
  harness bug, not evidence.
- **Rules API acceptance of `firebase.storage` for the conformance project** is
  checked in G0 with one request before the corpus is designed.
- **v1 rulesets.** Measured in G1; decision recorded in G0's gate file rather
  than discovered by a consumer.
- **`fireside native` callers passing `--java`.** None exist in the consumer
  (its launcher only mentions Java for the official fallback); the argument
  is removed with a clear parse error rather than ignored.
- **Access-limit and error-mapping details** (how many `firestore.*` calls,
  which status a runtime error yields) are taken from G1 recordings, never from
  memory of the documentation.
- **Performance regression** is ruled out by the before/after Storage profile
  in G3 and the paired soak in G5; the expected direction is an improvement
  because the serialized JVM round trip disappears.

## Not done by this phase

The Emulator UI is still the downloaded official bundle, so `fireside setup`
remains (with one asset). Storage coverage/Requests reporting in the UI is not
added. Partial service profiles, `fireside init`, non-demo project ids,
non-loopback binding and the terminal launch experience are separate items.
