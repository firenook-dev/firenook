# Functions runtime and Extensions oracle corpus (Phase H1)

Recorded 2026-09-17 against the official emulator suite of firebase-tools
15.22.0 (Functions, Extensions, Auth, Storage, Pub/Sub, Eventarc and Tasks in
process; the Java Firestore emulator 1.21.0) with firebase-functions 7.2.5 and
firebase-admin 13.10.0 on Node 24. Everything is synthetic: the project id is
`demo-fireside-functions-oracle`, tokens are unsigned test JWTs referenced as
`{{jwt:<name>}}`, secrets are literal placeholder strings. No credential, access
token or developer identity is stored.

The tooling lives in `conformance/src/functions-runtime/`:

| File | Role |
| --- | --- |
| `plan.ts` | The synthetic project (six user codebases, one local extension, dotenv chains, secrets) and every program |
| `runner.ts` | Executes programs against any target, reads handler observations back, normalizes volatile values |
| `capture-emulator.ts` | Starts the official suite per profile and writes this fixture (`npm run capture:functions:runtime`) |
| `fixture.ts` | Finalization shared with the replay: token placeholders, spec digests, large-string digests, counts |

Every synthetic handler appends what it observed to a JSONL file: the request
shape (`url`, `path`, `query`, headers, parsed and raw body), the event
envelope (CloudEvent attributes, snapshots, params, context), the callable
request (`data`, `auth`, `app`, `acceptsStreaming`, `rawRequest`), and the
environment subset (`FUNCTION_*`, `K_*`, `GCLOUD_PROJECT`, `FIREBASE_*`,
emulator host variables, dotenv and secret values). A recorded step therefore
carries both the HTTP-visible contract and the handler-visible contract.

## Profiles

| Profile | Programs | Steps | What it records |
| --- | --- | --- | --- |
| `main` | 38 | 260 | Discovery, HTTP, callable, streaming, CORS, Firestore/Storage/Pub/Sub/Auth events, blocking functions, environment, lifecycle, the local extension |
| `v1-blocking` | 1 | 5 | First-generation `beforeCreate`/`beforeSignIn` (a project may hold one of each, so they need their own codebase) |
| `inspect` | 1 | 5 | `--inspect-functions`: debug ports, sequential execution |
| `ext-missing-param` | 1 | 1 | The local extension without its required secret and without the bucket parameter |
| `twodart-refs` | 2 | 10 | `invertase/firestore-stripe-payments@0.3.12` and `algolia/firestore-algolia-search@1.2.10` resolved from the shared cache with synthetic parameters (requires a Firebase CLI login at capture time) |

Each profile records its readiness log, its `/backends` inventory (full
extension specs), the programs, and the shutdown result. Inside programs every
`/backends` body carries `{ $digest, name, version }` in place of the extension
spec objects; the digest is the SHA-256 of the canonical (sorted-key) JSON.

## Normalization

Placeholders replace values that change per run: `{{origin:<service>}}` and
`{{host:<service>}}` for emulator addresses, `{{projectDir}}`, `{{tmp}}`,
`{{home}}`, `{{sdkRoot}}`, `{{uuid}}`, `{{time}}` (RFC 3339 and RFC 1123),
`{{number}}` (generations, sizes, epoch millis, elapsed times), `{{id}}` (Auth
local ids, Pub/Sub message ids, short blocking-function event ids), `{{hash}}`,
`{{token}}`, `{{jwt:<name>}}`, `{{port}}` (the worker's `PORT`),
`{{workerSocket}}`, `{{localId:<step>}}` (an Auth user created by a step),
`{{ms}}` and `{{clock}}` in log lines. Strings longer than 4 KiB are stored as
`{ $sha256, length }`. Handler-side values that are not JSON are projected:
`{ $snapshot }`, `{ $change }`, `{ $buffer }`, `{ $date }`, `{ $timestamp }`,
`{ $undefined }`, `{ $function }`, and `{ $error }` for a getter that threw.

## Invariants the owned runtime must reproduce (H2)

Route and status contract on the Functions port:

- `GET /backends` answers 200 JSON with `vary: Origin`; `OPTIONS /backends`
  and every unknown path answer 404 `text/plain` "Not Found".
- `/{project}/{region}/{name}[/sub/path?query]` for any method reaches the
  handler with `url`, `originalUrl` and `path` rewritten to the sub-path
  (`/` when absent), the query preserved, `hostname` and the `host` header
  equal to the Functions origin. A different project id is "Not Found".
- An unknown function, region or trigger key answers 404
  `text/html; charset=utf-8` with `Function <key> does not exist, valid
  functions are: <keys>`, where the keys are the registered trigger keys in
  registration order (extension backends first, then codebases in
  `firebase.json` order): HTTP and callable keys are `<region>-<name>`, event
  keys are `<region>-<name>-<generation>`.
- `POST /functions/projects/{project}/triggers/{key}` delivers to the handler
  regardless of whether the definition was admitted; a `GET` on that route is
  "Not Found". Trigger keys keep generation `0` across file-watch reloads; the
  hub's `enableBackgroundTriggers` reloads with generation `1` and leaves the
  disabled generation-0 records in place (`/backends` then lists both, and a
  generation-0 key answers 204 "Background triggers are currently disabled.").
- Manual schedule firing: a v2 `onSchedule` accepts any body and answers 200
  with an empty body; the handler sees `{ jobName: undefined, scheduleTime }`.
  A v1 `onRun` answers `{"status":"acknowledged"}` and passes the posted
  `context` through.

Worker and SDK contract (both engines execute the same SDK, so everything the
SDK produces is expected to match by construction once the worker reproduces
the runtime environment):

- Express with `trust proxy`, body parsing for JSON, text, urlencoded and raw
  (`*/*`) with a 32 MB limit and `rawBody` captured; an invalid JSON body is a
  400 HTML error page from body-parser before the handler runs; an empty body
  with a JSON content type is `{}`.
- Environment: `FUNCTION_TARGET` (entry point), `FUNCTION_SIGNATURE_TYPE`
  (`http`, `event` or `cloudevent`), `K_SERVICE` (function id, `ext-<instance>-<name>`
  for extensions), `K_REVISION=1`, `PORT` (the worker's own listener),
  `GCLOUD_PROJECT`, `GOOGLE_CLOUD_QUOTA_PROJECT`, `FUNCTIONS_EMULATOR=true`,
  `TZ=UTC`, `FIREBASE_DEBUG_MODE=true`, `FIREBASE_DEBUG_FEATURES` =
  `{"skipTokenVerification":true,"enableCors":true}`, `FIREBASE_CONFIG`
  (`storageBucket`, `databaseURL`, `projectId`), `METADATA_SERVER_DETECTION=none`,
  and the emulator host variables `FIRESTORE_EMULATOR_HOST`,
  `FIREBASE_FIRESTORE_EMULATOR_ADDRESS`, `FIREBASE_AUTH_EMULATOR_HOST`,
  `FIREBASE_STORAGE_EMULATOR_HOST`, `STORAGE_EMULATOR_HOST` (`http://` origin),
  `PUBSUB_EMULATOR_HOST`, `CLOUD_EVENTARC_EMULATOR_HOST` (`http://` origin),
  `CLOUD_TASKS_EMULATOR_HOST`, `FIREBASE_EMULATOR_HUB`.
- Dotenv chain `.env` → `.env.<projectId>` → `.env.local` (later files win),
  with the recorded dialect: `export` prefix, trailing `#` comments, double
  quotes with `\n`/`\"` escapes and multi-line values, single quotes keeping
  backslashes, empty values. Every key of `.secret.local` is present in every
  worker of that codebase, declared or not. A codebase whose `.env` holds a
  lowercase or `FIREBASE_`-prefixed key loads no functions.
- Callable contracts, HttpsError status mapping, streaming (`Accept:
  text/event-stream`, `data:` frames, error frame after chunks), CORS
  preflights and simple responses, `request.auth` from unsigned tokens
  (`uid` from `user_id` or `sub`, garbage tokens leave `auth.uid` null with an
  empty token, an empty Bearer or a Basic scheme is 401), App Check headers,
  and instance id tokens are all SDK behaviour observed through the worker.

Event envelopes as received by handlers (Fireside's fronts already produce
these; the corpus pins them per trigger kind):

- Firestore v2 CloudEvents carry `source`
  `//firestore.googleapis.com/projects/projects/<project>/databases/(default)`
  (the doubled `projects/` is the Java emulator's output), `subject`
  `documents/<path>`, `location`, `project`, `database`, `namespace`,
  `document`, `params`, and for `WithAuthContext` triggers `authType: "unknown"`
  and `authId: "fake-auth-id@gmail.com"` for every writer. A no-op update still
  delivers `updated` and `written`. One commit with three writes yields three
  events.
- Firestore v1 events carry `context.eventType` `google.firestore.document.<op>`,
  `resource.name` with the full document name, `params`, and change snapshots
  whose non-existent side has no times.
- Storage v2 CloudEvents carry `source`
  `//storage.googleapis.com/projects/_/buckets/<bucket>/objects/<name>` and
  `StorageObjectData` with `firebaseStorageDownloadTokens`, `selfLink` and
  `mediaLink` on the Storage origin; v1 events carry the same object and a
  `context.resource.name` `projects/_/buckets/<bucket>/objects/<name>`.
- Pub/Sub v2 CloudEvents carry `subscription`
  `projects/<project>/subscriptions/emulator-sub-<topic>`, `messageId` as a
  numeric string, `orderingKey` (empty string when absent) and the SDK's `json`
  getter throwing for non-JSON data; v1 `onPublish` receives `message.data` as
  a Buffer. Two v2 handlers on one topic both receive every message.
- Auth v1 `user.create`/`user.delete` fan out to every handler and to
  extension auth resources with the full `UserRecord`.
- Blocking functions: sign-up runs `beforeCreate` and then `beforeSignIn`;
  sign-in runs `beforeSignIn`; the event carries `eventType`
  `providers/cloud.auth/eventTypes/user.beforeCreate:password`, `authType:
  "USER"`, `ipAddress`, `locale`, `userAgent:
  "NotYetSupportedInFirebaseAuthEmulator"`, `additionalUserInfo`, `credential:
  null` and an RFC 1123 `timestamp`; returned `displayName`, `emailVerified`,
  `customClaims` and `sessionClaims` are applied; an `HttpsError` becomes a 400
  `BLOCKING_FUNCTION_ERROR_RESPONSE : ((HTTP request to <url> returned HTTP
  error <status>: <body>))` and the user is not created; a handler sleeping
  8.5 s still succeeds (the emulator enforces no seven-second deadline).
- Extensions custom events published through the Admin SDK's Eventarc channel
  are delivered to a user `onCustomEventPublished` handler as a CloudEvent with
  `source` `projects/<project>/instances/<instance>`, `subject`, `data`
  and `datacontenttype: application/json`. Publishing an event type the
  instance never declared also answers 200 to the publisher.

Extensions resolution (H3):

- `/backends` lists each instance as a backend with `directory`, `env`,
  `extensionInstanceId`, `extensionSpec` (local) or `extension` +
  `extensionVersion` (registry), and `functionTriggers` named
  `ext-<instance>-<resource>`. `env` holds the auto parameters `PROJECT_ID`,
  `EXT_INSTANCE_ID`, `DATABASE_INSTANCE`, `DATABASE_URL`, `STORAGE_BUCKET`,
  `ALLOWED_EVENT_TYPES`, `EVENTARC_CHANNEL`, `EVENTARC_CLOUD_EVENT_SOURCE`,
  then the user parameters from `<instance>.env` and `<instance>.env.local`,
  with secret parameters replaced by their Secret Manager resource name and
  absent when no value is known.
- `${param:X}` and `${X}` are substituted in resources; a parameter default that
  itself references a parameter (`${STORAGE_BUCKET}`, `${param:COLLECTION}`)
  stays literal (the `ext-missing-param` profile records
  `BUCKET=${STORAGE_BUCKET}` and a Storage resource bound to that literal
  bucket name, which never fires).
- A missing required secret parameter does not fail startup; the worker simply
  lacks the variable.
- `taskQueueTrigger` resources are dropped from the emulated definition and
  logged as "missing a trigger"; the record keeps an HTTPS key without a
  trigger, and invoking it answers 500 `{"code":"ECONNRESET"}`.
- v1beta.function resources get `platform: gcfv1`, `regions: [location]`,
  `timeoutSeconds` from `timeout: 120s`, and `service` on the event trigger;
  v2function resources get `platform: gcfv2` and Firestore filters completed
  with `database`/`namespace` `(default)`.
- The registry profile shows Stripe's six resources and Algolia's two, the
  registry's `extensionVersion` with its public content-addressed
  `sourceDownloadUri`, and handler invocations that fail at the outbound
  Stripe/Algolia call.

## Recorded divergences Fireside adopts deliberately

These are asserted by the replay, not skipped:

- An unhandled handler error kills the official worker (the runtime logs
  `FATAL`, the parent kills the process): an HTTP handler that throws answers
  500 "Internal Server Error", a throw after headers hangs the client, a
  per-function timeout answers 500 `{"code":"ECONNRESET"}`, and a background
  handler that throws makes the emitting emulator log a 500. Fireside runs one
  worker per codebase and cannot kill it per failure: it answers the same
  statuses but keeps the worker alive.
- A function removed by a file-watch reload keeps its record on the official
  emulator and answers 500 `{"code":"ECONNRESET"}`; Fireside removes stale
  records on reload and answers the 404 "does not exist" body.
- `x-powered-by: Express` comes from the worker's Express and is reproduced;
  `vary: Origin` on every v2 HTTPS response is SDK CORS behaviour and is
  reproduced by construction.
- The official emulator starts one worker per trigger lazily and refreshes
  them on reload; Fireside starts one worker per codebase at readiness and
  restarts it on reload. Handlers observe the same per-invocation environment.
- `FIREBASE_CLI_PREVIEWS` in the observed environment is the capture harness's
  own variable and is not part of the contract.

## Freezing

`SHA256SUMS` lists `README.md` and `emulator-programs.json`; the gate file
`benchmarks/phase-h-functions-runtime.json` pins the same digests and
`conformance/test/functions-runtime-fixtures.test.mjs` verifies them in CI.
Rerunning the capture is cheap (five suite starts, about fourteen minutes) but
every rerun must refreeze the digests and this README's counts.
