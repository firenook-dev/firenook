# Phase H — Owned Functions runtime and Extensions (`0.1.0-next.7`, together with Phase G)

Written 2026-09-17 against `main` 39ba9a2. This is a plan, not a claim of
work done. It follows [Phase G](phase-g-storage-rules.md) (native Storage
rules, `next.7`); together they remove every runtime dependency except Node.

## Goal

Run user Cloud Functions and Firebase Extensions without firebase-tools.
Fireside owns the Functions port, discovery, the worker processes, HTTP and
callable routing, event delivery, environment and secrets, reload, and the
Extensions lifecycle (registry resolution, download and cache, build,
parameters, registration). The user's JavaScript/TypeScript — and the
extension authors' JavaScript — still executes in Node, because that is the
production runtime; Fireside ships a small Node worker of its own for that.
After this phase `firebase-tools` is not imported, spawned or version-pinned
anywhere in the product.

Out of scope: Python and Dart functions, Realtime Database, Hosting, App
Hosting, Data Connect, general Pub/Sub subscribers, `functions.config()`
(removed from firebase-functions 7). Those remain unsupported and are reported
as ignored exports, as the official emulator does.

## Current state (verified 2026-09-17)

**Rust already owns** the parts that are not JavaScript execution:

| Crate / file | Role today |
| --- | --- |
| `crates/functions-bridge` (2,014 lines) | Trigger registry, v1/v2 registration (`/functions/projects/{p}/triggers/{key}`), Firestore/Auth/Storage change matching, event envelopes derived from official captures, bounded dispatch queue, delivery policy and health, `/backends` inventory discovery |
| `crates/pubsub-front` (1,022 lines) + `SchedulerRuntime` in `suite-runtime` | Topic control and publish contract used by Functions and Extensions, `onSchedule` scheduling, inventory refresh on reload |
| `crates/suite-runtime/src/auxiliary.rs` | Eventarc/Tasks registration endpoints (delivery answers 501) |
| `crates/suite-runtime/src/functions_readiness.rs`, `lib.rs:1012–1160` | Spawns the host, parses `FIRESIDE_FUNCTIONS_HOST_READY` / `_UPDATED` receipts, refreshes routing after reload, shutdown |

**Node/firebase-tools owns** execution, through `support/functions-host.cjs`
(389 lines, embedded in the binary), which loads from the consumer's
`node_modules/firebase-tools@15.22.0`:

| firebase-tools module | Lines | What it does for Fireside |
| --- | --- | --- |
| `emulator/functionsEmulator.js` | 1,301 | Binds the Functions port itself, discovers endpoints, spawns one worker per trigger, routes `/{project}/{region}/{name}` and `/functions/projects/{p}/triggers/{id}`, `/backends`, source watching and reload, `--inspect` plumbing |
| `emulator/functionsEmulatorRuntime.js` + `functionsEmulatorShared.js` | 968 | The worker: loads the codebase, resolves `FUNCTION_TARGET`, serves `/*` with an express app, converts HTTP bodies into `http`, `cloudevent` or legacy-event invocations, raw-body capture, health route, timeouts |
| `emulator/extensionsEmulator.js` + `extensions/emulator/{triggerHelper,specHelper,optionsHelper}.js` + `deploy/extensions/planner.js` | 776 | Resolves `publisher/name@version` through the registry API, downloads and caches the source, `npm install` + `npm run gcp-build`, reads `extensions/<id>.env` and `.secret.local`, injects `PROJECT_ID`/`EXT_INSTANCE_ID`/`DATABASE_URL`/`STORAGE_BUCKET`, substitutes `${param:…}`, converts `resources` into function definitions (drops `taskQueueTrigger`) |

The host also runs `requireAuth` when Extensions are configured
(`functions-host.cjs:320–326`), because the registry call needs the Firebase
CLI's login token; it deliberately hands `account: undefined` to the workers.

Discovery in the pinned SDK: `firebase-functions@7.2.5` ships
`lib/bin/firebase-functions.js` (93 lines), which serves the endpoint manifest
at `GET /__/functions.yaml` when `FUNCTIONS_CONTROL_API=true`; firebase-tools
also accepts a static `functions.yaml`. Both are SDK contracts, not
firebase-tools contracts.

**Consumer shape (Twodart):** one codebase (`templates-firebase-function`,
`nodejs24`, built to `dist/`), 34 TypeScript files / 5,620 lines, 18 exports:
6 `onCall` + 1 v1 `https.onCall`, 1 `onRequest`, 5 `onDocumentWritten`,
2 `onDocumentDeleted`, 1 `onDocumentCreated`, 2 `onSchedule`; SDKs
`firebase-functions ^7.2.5`, `firebase-admin ^13.8.0`. Three Extension
instances: `invertase/firestore-stripe-payments@0.3.12` (7 resources, 9
params, 24 declared events, `eventTrigger` + `httpsTrigger`) and two instances
of `algolia/firestore-algolia-search@1.2.10` (3 resources, 11 params,
`eventTrigger` + `taskQueueTrigger`, the latter dropped upstream), with
`.env` and `.secret.local` per instance.

**Existing oracle evidence** for Functions is thin: about 40 recorded items
across `functions-callable-http-and-error-contract` (7),
`functions-startup-discovery` (2), `firestore-trigger-registration-and-v1-v2-dispatch`
(2+2), `pubsub-schedule-and-function-dispatch` (8), `auth-import-export-and-trigger-dispatch`
(7), `functions-readiness-v1` (6), `functions-topic-reload-v1` (3),
`developer-tools-functions-lifecycle-v1` (2). None cover the callable
protocol in depth, CORS, streaming, v1 event context, environment files,
secrets, multiple codebases, Extensions parameters or Extensions events.

**Reference point:** fireemu (t-k/fireemu v0.7.1) runs user Functions on its own
~2,300-line Node runner plus Rust supervision, with recorded conformance
against firebase-tools 15.28.2 for discovery, HTTP/callable including
streaming, Firestore/Storage/Pub/Sub/Auth events, blocking functions,
schedules and the dotenv chain. It does not implement Extensions. That is the
evidence that the runtime half is a bounded job; the Extensions half is new
work with no public reference implementation.

## Oracles and precedence (freeze before implementation)

Record in `benchmarks/phase-h-functions-runtime.json`, `frozen: true`:

1. **The official Functions emulator** (firebase-tools 15.22.0, the version
   the product pins today) running the same codebase and the same Extensions,
   for every HTTP-observable contract: routes, status codes and bodies,
   callable envelopes and error codes, CORS, event envelopes as received by
   handlers, environment as seen by handlers, `/backends`, readiness order,
   reload behaviour, Extensions parameter injection and registration.
2. **Production Cloud Functions** only where the emulator is known to diverge
   and the SDK documents production behaviour (kept minimal; the emulator is
   the compatibility target for a local tool).
3. The `firebase-functions` SDK source at the pinned version, for the wire
   manifest (`stackToWire`) and the runtime environment variables it reads.

Classification as in Phases 3 and G: match the official emulator; when
Fireside deliberately differs (it must not fail startup on an upstream-ignored
export, for instance), the difference is recorded in the fixture invariants.

## Work packages

### H0 — Freeze the gate (1 day)

- `benchmarks/phase-h-functions-runtime.json`: pins (Node 24, firebase-tools
  15.22.0 as oracle, firebase-functions 7.2.5, firebase-admin 13.x), the
  supported trigger matrix (below), the named checks, the list of
  firebase-tools surfaces that must be gone, and the Extensions Google
  dependency decision.
- Supported trigger matrix, frozen: v2 `onRequest`, `onCall` (including
  streaming), `onDocument{Created,Updated,Deleted,Written}` with and without
  auth context, `onObject{Finalized,Deleted,MetadataUpdated}`,
  `onMessagePublished`, `onSchedule`, `beforeUserCreated`/`beforeUserSignedIn`;
  v1 `https.onRequest`/`onCall`, `firestore.document().on*`,
  `storage.object().on*`, `pubsub.topic().onPublish` and `schedule().onRun`,
  `auth.user().onCreate/onDelete`/`beforeCreate`/`beforeSignIn`; Extensions
  `httpsTrigger`, `eventTrigger` (Firestore/Storage/Pub/Sub/Auth),
  `scheduleTrigger`. Everything else is an ignored export with a reason.
- Extensions registry decision (see Risks): reuse the Firebase CLI's stored
  login token when present, accept `FIREBASE_TOKEN`, and add an offline
  vendored-source mode; an own OAuth login flow is not in this phase.

### H1 — Oracle corpus (5–7 days)

New fixture set `conformance/fixtures/functions-runtime-v1/` recorded by a
new `capture:functions:runtime` harness that starts the official emulator on
a synthetic project with a synthetic codebase exercising every row of the
trigger matrix, and a second synthetic codebase for multi-codebase cases.
Target ≥40 programs / ≥250 steps, each step `{id, request, status, headers,
body, handler-observed invocation}` where the handler echoes what it received
(request shape, event envelope, `process.env` subset, auth context).

Programs:

- Discovery and inventory: export order, ignored exports and their reasons,
  `/backends` shape, two codebases, `functions.yaml` static discovery, a
  codebase that throws at load, an ESM codebase, region defaults and explicit
  regions.
- HTTP: `/{project}/{region}/{name}` and sub-paths, query strings, raw body,
  content types, both official 404 bodies, timeouts, response streaming.
- Callable: v1 and v2 envelopes, `HttpsError` codes and `details`, auth
  context (ID token, invalid token, none), App Check header handling,
  streaming (`Accept: text/event-stream`, `sendChunk`, error after a chunk),
  CORS preflight on every varying header.
- Events: Firestore v1 context and v2 CloudEvent for each change type,
  `withAuthContext`, Storage v1/v2, Pub/Sub message shape and attributes,
  Auth user events, blocking functions' request/response protocol and the
  seven-second deadline, schedules (cron and App Engine syntax, time zones),
  retry/duplicate delivery policy.
- Environment: the dotenv chain (`.env`, `.env.<projectId>`, `.env.<alias>`,
  `.env.local`), refusal messages for invalid files, `.secret.local`,
  `FUNCTIONS_EMULATOR`, `FIREBASE_CONFIG`, `GCLOUD_PROJECT`, `K_SERVICE`,
  `FUNCTION_TARGET`, `FUNCTION_SIGNATURE_TYPE`, emulator host variables for
  the Admin SDK, credential isolation.
- Lifecycle: readiness order, reload after a source change (added, removed,
  changed trigger), worker crash and restart, shutdown with in-flight
  requests, `--inspect` port assignment.
- Extensions: a synthetic local extension (spec with every trigger kind, every
  param type, `${param:…}` substitution in resources, events) plus the three
  Twodart refs from the shared cache: resolved definitions, injected
  parameters and auto-params, secret handling, `taskQueueTrigger` dropped with
  the recorded reason, extension `httpsTrigger` URL shape, Firestore
  `eventTrigger` delivery into the extension function, declared Extensions
  events published to Eventarc and consumed by a user `onCustomEventPublished`
  handler if the official emulator delivers them (measured).

Exit: fixtures checksummed, README, CI integrity; the Twodart codebase and
Extensions run against the official emulator as a private, non-published
smoke recorded as a checklist only.

### H2 — Owned runtime: Rust supervisor + Node worker (8–12 days)

- New crate `functions-runtime` (Rust): binds the Functions port; loads
  `firebase.json` `functions` entries (codebases, `source`, `runtime`,
  `ignore`); starts one worker per codebase; discovers endpoints through the
  SDK's `FUNCTIONS_CONTROL_API` manifest (fallback: static `functions.yaml`);
  builds the inventory that `functions-bridge`, `pubsub-front` and the
  scheduler already consume (today read from `/backends`); routes HTTP and
  callable requests to workers; converts bridge deliveries to worker
  invocations (`http`, `cloudevent`, legacy event); enforces per-function
  timeouts, concurrency and the callable/streaming limits; serves the
  official `/backends` and `/functions/projects/…` routes for compatibility
  with tools that call them (the Emulator UI does); watches sources and
  reloads; exposes readiness the way `functions_readiness.rs` expects, so the
  suite's startup and `refresh_inventory` paths change minimally.
- New `support/functions-worker.mjs` (Node, embedded like the host today,
  target ≤1,500 lines): loads a codebase, resolves the endpoint by name, sets
  the per-invocation environment (`FUNCTION_TARGET`, signature, `K_SERVICE`,
  declared secrets), executes `http`/`cloudevent`/legacy-event invocations,
  converts `HttpsError`s, supports callable streaming, health and quit
  routes, `--inspect` when asked, structured log lines back to Rust.
- Blocking functions: the loopback bridge from `auth-front` into the runtime
  with the recorded deadline semantics.
- Eventarc: keep registration; add delivery only for Extensions custom events
  if H1 shows the official emulator delivers them.
- Tests: unit tests in the crate; replay of every H1 program against
  Fireside; the readiness/topic-reload/lifecycle fixtures keep passing
  unchanged, because their contracts are the suite's, not the host's.

### H3 — Extensions in Rust (5–7 days)

- New crate `extensions` (Rust): parse `firebase.json` `extensions`
  (`instanceId → ref | local path`), `extensions/<id>.env` and `.secret.local`
  with the official dotenv dialect (shared with H2); resolve a ref through the
  registry API (`GET /v1beta/publishers/{p}/extensions/{e}/versions/{v}` →
  spec + `sourceDownloadUri`) using the stored CLI token or `FIREBASE_TOKEN`;
  download to the same cache directory firebase-tools uses
  (`~/.cache/firebase/extensions/<publisher>/<name>@<version>`, honouring
  `FIREBASE_EXTENSIONS_CACHE_PATH`) so existing caches are reused and nothing
  is fetched twice; run `npm install` and `npm run gcp-build` with the
  project's Node; parse `extension.yaml` (`resources`, `params`, `events`,
  `lifecycleEvents`, `roles`, `apis`; `v1beta.function` and `v2function`
  types); substitute `${param:NAME}`; compute auto-params
  (`PROJECT_ID`, `EXT_INSTANCE_ID`, `DATABASE_URL`, `STORAGE_BUCKET`,
  `DATABASE_INSTANCE`, `PROJECT_NUMBER`); convert resources into the same
  endpoint definitions user functions produce; register them as an extra
  codebase per instance in `functions-runtime`, with the instance's env.
- Offline mode: `fireside ext:vendor` copies resolved sources into
  `<project>/extensions/.sources/<ref>` (or a configured directory) and the
  loader prefers a vendored source; a project with all extensions vendored
  starts with no network and no token. This is the recommended public path
  and the credential-free CI path.
- Errors: unresolved ref, missing token, failed build, unknown param, missing
  required param — each with an actionable message and the official wording
  where the fixture recorded one.
- Tests: the synthetic local extension end to end; the three Twodart refs
  from cache (no network in tests); registry resolution tested with a local
  mock server.

### H4 — Remove firebase-tools, add the local commands it enabled (2–3 days)

- Delete `support/functions-host.cjs`, the `firebase-tools` root discovery
  and `15.22.0` checks in `packages/cli/src/runtime.mjs:16` and
  `suite-runtime` (`firebase_tools_root`, preflight row, `--firebase-tools-root`).
- `packages/cli`: `emulators:start --inspect-functions[=port]`,
  `functions:shell`-style `fireside functions:invoke <name> [--data …]`
  (built on the runtime's invoke route; the interactive REPL is optional),
  `fireside ext:vendor`, `doctor` reports codebases, extension instances and
  their source state.
- Docs: `README.md`, `packages/cli/README.md`, `COMPATIBILITY.md` Functions
  row ("Fireside runtime with Node workers; Extensions resolved and run by
  Fireside"), `DESIGN.md` sections "Functions runtime" and "Extensions", the
  CLI guide, ROADMAP closing paragraph. Twodart: `CLAUDE.md` login sentence
  ("Firebase CLI login is used only to download public Extension
  definitions") becomes the vendored/token statement; `bun setup` no longer
  needs firebase-tools for the Fireside backend (it stays for the official
  fallback and `deploy`).
- Package: `firebase-tools` leaves the consumer's required dependency set for
  the Fireside path; the wrapper never resolves it.

### H5 — Qualification and release as `0.1.0-next.7` (4–6 days)

1. Exact-candidate CI on all jobs, including a new "start the suite with
   `firebase-tools` absent from `node_modules`" step.
2. Twodart gates on the packed candidate: `bun test:fireside-integration`,
   `bun test:fireside-extensions` (its oracle fixture was captured from the
   official emulator, so it is the right judge: 26 definitions, 24 admitted,
   2 upstream-ignored with reasons, clean stop), journeys 1–6, a Stripe
   webhook round trip and an Algolia index trigger in the credential-free
   profile (both must reach the handler; the external call is expected to
   fail deliberately), `--inspect-functions` attach from VS Code.
3. Hetzner paired acceptance with the current harness; the function lane
   and startup time are the ones expected to move (no firebase-tools load,
   one worker per codebase instead of one per trigger).
4. Clean setup without firebase-tools and without Java, and a fully offline
   start with vendored extensions.
5. Release by the recorded procedure; `latest` untouched.

## Sequencing and size

H0 → H1 → H2 ∥ H3 (once H1 is frozen) → H4 → H5. Roughly five to seven weeks
for one engineer with agent support. Phase G ships as `next.7` first; H starts
immediately after G1's fixtures are frozen if capacity allows, because the
two phases touch different crates. Combined G + H is about three months.

## Risks

- **Registry access without firebase-tools.** The extension source URL is a
  short-lived signed URL returned by an authenticated registry call. Options:
  reuse the token the Firebase CLI stores in its configstore (works for every
  developer who has ever run `firebase login`), accept `FIREBASE_TOKEN`, or
  vendor sources. All three are in scope; an own OAuth device flow with a
  Fireside-registered client is a later decision. Consequence: a machine that
  has never logged in and has no vendored sources cannot fetch an extension —
  the same constraint as today, stated instead of hidden.
- **Fidelity breadth.** The trigger matrix is frozen in H0; anything outside
  it is an ignored export with a reason, never a silent drop. The corpus, not
  memory of firebase-tools, defines the envelopes.
- **Extensions events (Eventarc).** Today 501; H1 measures whether the
  official emulator delivers `events` to user handlers. If it does, H2 adds
  delivery for that path only.
- **`taskQueueTrigger`.** Upstream drops it; Fireside keeps the recorded
  ignore reason so the Twodart gate's "2 ignored" expectation still holds.
- **Worker model difference.** One worker per codebase (fireemu's choice)
  versus one per trigger (official) changes `FUNCTION_TARGET` visibility and
  secret isolation; the fixture records what handlers observe, and the worker
  sets per-invocation environment synchronously before each handler.
- **Emulator UI.** The official UI's Functions tab reads `/backends` and
  logs from the hub; those routes stay until the own UI replaces it.
