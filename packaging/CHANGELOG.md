# 0.1.0-next.9 — Cloud Tasks emulator, every configuration shape, the CLI surface

- Pin the engine to `7fb0c350078c94fc65a83a6f3c012a917779fbbd`, the qualified head of
  [PR #55](https://github.com/sanjevirau/fireside/pull/55) (Phases K, L and
  M) on the next.8 engine. This exact revision passed CI
  ([run 35437156565](https://github.com/sanjevirau/fireside/actions/runs/35437156565))
  and the five-platform packed-install matrix
  ([run 35437156569](https://github.com/sanjevirau/fireside/actions/runs/35437156569)),
  and a local candidate built from it passed a representative private
  consumer's extensions, integration and installed-launcher gates and its
  nine browser journeys on the full-data stack, plus an end-to-end run of
  every new command on a project scaffolded by `fireside init`; see
  `support/phase-k-tasks.md`, `support/phase-l-configuration.md`,
  `support/phase-m-cli.md` and the `receipts` blocks of the three gate
  files under `benchmarks/`. The per-release-line two-hour soak stands from
  next.6 and next.7.
- Cloud Tasks is a full emulator (Phase K). The Tasks port serves the four
  routes of the official emulator — queue registration, enqueue, delete and
  `/queueStats` — with its Express-shaped answers, registers a queue for
  every `onTaskDispatched` export at readiness and after each reload with the
  function's URL as the default target, and dispatches exactly as
  `taskQueue.js` does: a token bucket per queue that starts empty and refills
  once a second, dispatch slots sized by `maxConcurrentDispatches`, the
  `X-CloudTasks-QueueName`/`TaskName`/`TaskRetryCount`/`TaskExecutionCount`/
  `TaskETA` headers with the caller's headers overriding them and
  `TaskPreviousResponse` from the second attempt, the retry ladder with its
  backoff formula and the `maxAttempts` off-by-one, the execution count
  incremented on non-5xx failures only, the `dispatchDeadline` abort, and
  the controller's cadence (idle queues polled once a second, active queues
  continuously). `getFunctions().taskQueue().enqueue()` and `.delete()` from
  a function or an app with `CLOUD_TASKS_EMULATOR_HOST` set reach the
  handler as on the official suite. The corpus recorded from firebase-tools
  15.22.0 (6 programs, 61 steps, 39 handler observations in
  `conformance/fixtures/tasks-v1`) replays with 0 mismatches and no named
  divergence, three runs identical; the Functions runtime corpus replays
  unchanged with the emulator mounted. Not done because the official
  emulator does not do it either: `scheduleTime` as a delay, OIDC tokens on
  dispatch, queue pause/resume/purge, task listing, the Cloud Tasks v2 API,
  persistence, a UI tab.
- Every configuration shape of the tracker starts (Phase L). A service
  starts when `firebase.json` configures it, exactly as the official
  `filterEmulatorTargets` decides, and `--only` narrows the set; a project
  without Functions or Storage runs (Eventarc and Tasks follow Functions,
  the requests WebSocket follows Firestore, the UI and logging listeners
  follow `emulators.ui.enabled`, the hub always runs). Any project id is
  accepted: a `demo-*` id prints the official demo line, a real id prints
  the official "will affect production" warning for services not running,
  and the suite never contacts Firebase either way (every worker gets the
  emulator hosts and no Google credentials; user code with explicit
  credentials can still reach the real project). Any listen host is bound;
  a wildcard is announced to clients as the loopback address as the official
  `connectableHostname` does, and a non-loopback bind prints one warning
  because the emulators have no authentication. `emulators.singleProjectMode`
  (default true) warns once per foreign project id with the official Auth
  wording. `firestore` may list several databases, each with its own rules
  (a project-wide hot reload replaces every database's rules, as
  officially); every database is exported and imported. The storage section
  may be the `{rules}` object, the target array, or absent (demo projects
  get the official open default rules); `.firebaserc` may be absent;
  `emulators.database/hosting/dataconnect/apphosting` entries are skipped
  with a warning instead of refused. The rules parser now accepts
  `allow read, write;` without a condition and `rules_version='2'` without
  a semicolon, both written by the official templates. The Functions worker
  declares its routes in Express 4 and 5 syntax (firebase-functions 7.3 and
  later ship Express 5) and sees a gcloud directory under the suite state
  holding a synthetic credential, so the Admin SDK's task-queue client never
  probes the Compute Engine metadata server.
- The CLI carries every command row except the terminal launch experience
  (Phase M): `emulators:export` on a running suite through the official hub
  locator, `init` (non-interactive, official rules and index templates, a
  JavaScript codebase) and `init --adopt` (diagnoses an existing
  `firebase.json` and adds what Fireside needs), `use`, `target:apply` /
  `target:clear` (pure `.firebaserc` edits, no login), `firestore:delete`
  (a new path-scoped emulator route; recursive and whole-database deletes
  need `--force`), `functions:invoke --event-data` (the official shell's
  envelopes for Firestore, Storage, Pub/Sub, Auth, schedules, Eventarc custom
  events and task queues, posted to the running suite), `mcp` (a
  dependency-free stdio Model Context Protocol server with status,
  Firestore, Auth, Storage, Functions, Pub/Sub, Tasks and export tools),
  `--debug` (one `fireside-debug.log` per run under `.fireside/runs`, never
  deleted), the official `-P`/`-c`/`--json`/`--non-interactive`/
  `--log-verbosity`/`--ui`/`--force` flags, and `emulators:exec "<script>"`
  run through the shell as the official CLI does (the `--` argv form stays
  free of shell interpretation). `emulators:exec` keeps the Emulator UI off
  unless `--ui` is given, as officially. `functions:shell` is deliberately
  not provided: Fireside never starts a second Functions runtime. The
  default auxiliary ports are now the official ones (logging 4500, Eventarc
  9299, Tasks 9499) when `firebase.json` names none.
- Left for `0.1.0-next.10`: the own Emulator UI and the terminal launch
  experience (banner and status table).

# 0.1.0-next.8 — complete Authentication and a full Pub/Sub emulator

- Pin the engine to `03000f0cc082c1b69f06c67b6a99a5417c840243`, the qualified
  head of [PR #50](https://github.com/sanjevirau/fireside/pull/50) (Phases I
  and J) on the next.7 engine. This exact revision passed CI
  ([run 35364256374](https://github.com/sanjevirau/fireside/actions/runs/35364256374))
  and the five-platform packed-install matrix
  ([run 35364256373](https://github.com/sanjevirau/fireside/actions/runs/35364256373)),
  and a local candidate built from it passed a representative private
  consumer's extensions, integration and installed-launcher gates and its
  nine browser journeys (one-time-code login and sign-out/sign-in included)
  on the full-data stack, reopening the working state written by next.7; see
  `support/phase-i-auth.md`, `support/phase-j-pubsub.md` and the `receipts`
  blocks of `benchmarks/phase-i-auth.json` and `benchmarks/phase-j-pubsub.json`.
  The paired two-hour soak is a per-release-line gate and was waived for this
  release: the change set is confined to Auth and Pub/Sub, and both are proven
  by oracle replay against the official emulators.
- Authentication is complete (Phase I). `crates/auth-front` is rebuilt around
  the Identity Toolkit OpenAPI document that the official emulator itself
  routes and validates with (bundled under `crates/auth-front/spec` with its
  provenance), so routing, security, validation, coercion and error prose
  match operation by operation. Every one of the 61 operations the official
  Auth emulator implements is ported: password, anonymous, custom-token,
  email-link, phone and fake-IdP sign-in (Google, Apple, SAML and OIDC-shaped
  credentials), account update and delete, OOB and phone codes, session
  cookies, tenants, SMS multi-factor, passkeys, Admin batch create/get/delete/
  query, project and tenant configuration, the emulator inspection routes, the
  legacy `relyingparty` routes, blocking functions on every sign-in path,
  `user.create`/`user.delete` multicasts, official-format export/import and
  the popup/redirect helper pages. The corpus recorded from firebase-tools
  15.22.0 (61 programs, 1,068 steps in `conformance/fixtures/auth-v1`)
  replays with 17,303 compared values, 0 mismatches and four named
  divergences (V8-versus-serde parse prose in two error messages, the Node
  stack trace the official emulator appends to a 500 log line, and
  Fireside's own account-picker page whose offered accounts are compared
  exactly), three runs identical; the real-SDK popup/redirect browser gate
  and the Emulator UI Auth tab were checked against the candidate. Accounts
  exported by next.7 import unchanged, and passwords stored with the earlier
  digest still sign in and are upgraded on that sign-in. `fireside native
  auth` runs the service alone (`--state-file` persists it) and 500-class
  failures are logged with the official emulator's first line.
- Pub/Sub is a full emulator (Phase J). `crates/pubsub-front` is a broker
  behind tonic gRPC services and an HTTP/JSON transcoder on one port: every
  RPC of `google.pubsub.v1` Publisher, Subscriber and SchemaService and of
  `google.iam.v1` IAMPolicy, with leases and ack deadlines, redelivery behind
  later messages, dead-letter and retry policies, ordering keys, filters,
  message retention, seek to time or snapshot, snapshots, pull, streaming
  pull, push delivery with the official one-second retry, and Avro schemas
  with revisions, topic binding and message validation. The corpus recorded
  from the official Pub/Sub emulator 0.8.33 (42 programs, 916 steps over gRPC,
  HTTP/JSON, streaming pull and a recording push endpoint in
  `conformance/fixtures/pubsub-v1`) replays with 3,755 compared values, 0
  mismatches and no divergence, three runs identical; the pinned
  `@google-cloud/pubsub` 5.3.1 client publishes, streams, orders, pushes and
  validates schemas against it with `PUBSUB_EMULATOR_HOST`. Function targets
  consume through a real `emulator-sub-<topic>` subscription, the scheduler
  keeps ticking `onSchedule` topics, and the Functions runtime corpus
  replays unchanged (271/271). `fireside native pubsub` runs the service
  alone.
- Limitations recorded with this release: Protocol Buffer schemas, IAM,
  `detachSubscription` and `updateSnapshot` answer `UNIMPLEMENTED` exactly as
  the official emulator does; BigQuery, Cloud Storage and Bigtable export
  subscriptions do not exist; Pub/Sub state is in memory like the official
  emulator (topics and subscriptions from function discovery are recreated
  on start); ordered delivery across several ordering keys is nondeterministic
  between the official emulator's own runs, so the corpus holds Fireside to
  the single-key contract and Fireside delivers per key in order with
  redelivery queued behind later messages. Auth operations the official
  emulator answers with 501 (provider configuration, `initializeAuth`, IAM on
  tenants, Game Center, reCAPTCHA enforcement, TOTP MFA) keep answering 501
  with the recorded body. Prerelease on `next`; no stable or
  universal-compatibility claim.

# 0.1.0-next.7 — native Storage rules and the owned Functions/Extensions runtime

- Pin the engine to `0720434e3de7e0886f129f52a39d5ef2972ce45f`, the qualified
  head of [PR #43](https://github.com/sanjevirau/fireside/pull/43) (Phases G
  and H) on the next.6 engine. This exact revision passed the seven-job CI
  ([run 35254102986](https://github.com/sanjevirau/fireside/actions/runs/35254102986)),
  the five-platform packed-install matrix without Java, and a representative
  private consumer's fresh, sequential official-then-Fireside full-data
  acceptance (two two-hour soaks, browser journeys before and after
  export/restart, exact stable-state parity, fresh setup on both backends and
  the regression commands, all with zero errors); see
  `support/phase-g-storage-rules.md`, `support/phase-h-functions-runtime.md`
  and the `receipts` blocks of `benchmarks/phase-g-storage-rules.json` and
  `benchmarks/phase-h-functions-runtime.json`. next.7 carries both phases;
  no next.7 was published before this one.
- Storage Security Rules are evaluated natively (Phase G). `service
  firebase.storage` runs in the Rust rules engine with `firestore.get()` and
  `firestore.exists()`, `/internal/setRules` reloads rules on the running
  suite, and 306 production plus 334 official-emulator oracle steps replay
  identically. Java and the Storage rules jar left the product: no `--java`
  or `--storage-rules-jar` arguments, no Java check in `doctor`, and
  `fireside setup` fetches only the Emulator UI asset. `firebase.json` may
  use the `"storage": {"rules": …}` object form (one file governs every
  bucket) and `.firebaserc` targets are optional. On the consumer's Linux
  host each rules-evaluated Storage operation is about 1 ms cheaper at p50
  than through the Java runtime.
- Cloud Functions run in Fireside's own runtime (Phase H): a Rust supervisor
  with one Node worker per codebase (`support/functions-worker.mjs`) covering
  discovery through the pinned SDK control API or `functions.yaml`,
  HTTP/callable/streaming requests, Firestore, Storage, Auth, Pub/Sub,
  Eventarc and schedule triggers, blocking Auth functions, dotenv and secret
  files, reload and the background controls. The corpus recorded from
  firebase-tools 15.22.0 (5 profiles, 43 programs, 281 steps, 250 handler
  observations in `conformance/fixtures/functions-runtime-v1`) replays with
  every step identical or a listed divergence (89 asserted, each with its
  reason, in the replay's divergence table). `firebase-tools` left the CLI's
  dependencies; the suite starts with it absent from `node_modules`.
- Extensions are resolved and run by Fireside: instances from local paths,
  vendored `extensions/.sources`, the shared firebase-tools cache or the
  registry, with parameters resolved in the official precedence, `${param:X}`
  substitution and the registry's spec/trigger semantics. The registry is
  contacted with the Firebase CLI's stored login or `FIREBASE_TOKEN` and its
  objects are cached beside the source, so later starts are offline. The
  Eventarc port now serves trigger registration, `getTriggers` and
  `publishEvents` on the `google` and named channels and delivers to
  `onCustomEventPublished` handlers, Extensions custom events included.
- New local commands and options: `--inspect-functions[=port]` (one debugger
  port per codebase), `functions:invoke NAME [--data JSON] [--region]
  [--method]`, `ext:vendor` (copy every resolved extension source into the
  project and record how unpinned refs resolved), `--offline` or
  `FIRESIDE_OFFLINE=1` (any remaining registry access is a startup error)
  and a `doctor` report of every extension instance with its source and
  offline readiness. `--minimum-functions` now defaults to 1, so a plain
  `emulators:start` no longer fails the positive-minimum check.
- Measured in the consumer's Linux acceptance on the same host, seed and
  workload as next.6, against the official emulator on untuned HotSpot
  defaults (p50 milliseconds): function delivery 2.6 (next.6 3.2; official
  3.8), Storage cycle 8.0 (official 11.6), write commit 3.3 (official 198),
  listener delivery 9 (official 198), catalogue query 6.4 (official 31.1);
  emulator peak PSS 1.77 GiB against 19.35 GiB, no swap on either stack.
  Application readiness was 51.2 s against 49.2 s official because Fireside
  binds its listeners only after the full-data import and `/backends` is
  answered after codebase discovery; both are recorded follow-ups.
- Limitations recorded with this release: Python and Dart runtimes are
  ignored with a reason; dynamic (in-code) extensions and Secret Manager
  access are unsupported (`extensions/<instance>.secret.local` instead);
  the Cloud Tasks port still accepts queue registration only and answers
  dispatch with HTTP 501; there is no `functions:shell` REPL; the
  Emulator UI remains Google's 1.15.0 bundle fetched by `fireside setup`.
  State written by earlier versions upgrades on first start (CI verifies the
  upgrade from next.3 native state and the portable rollback). Prerelease on
  `next`; no stable or universal-compatibility claim.

# 0.1.0-next.6 — write-behind durability, scan and import performance

- Pin the engine to `572d4fb5f9d986accf2473858930c1e9bc3e5d57`, the merge of
  [PR #39](https://github.com/sanjevirau/fireside/pull/39) on the next.5
  engine. This exact revision passed the seven-job CI, the five-platform
  packed-install matrix and a representative private consumer's fresh,
  sequential official-then-Fireside full-data acceptance (two two-hour soaks,
  initial and post-restart browser journeys, lifecycle parity, fresh setup and
  regression commands, all with zero errors); see
  `support/phase-f-qualification.md`.
- Write-behind durability is the default
  ([#39](https://github.com/sanjevirau/fireside/pull/39)). A Firestore commit
  is acknowledged after its journal write and a non-durable redb commit; a
  background flusher (every second) and shutdown sync the journal, persist the
  commits with one durable redb commit and truncate the journal. Storage keeps
  the same contract with its own metadata journal and syncs uploaded files
  before the metadata that references them becomes durable. Killing the
  process loses nothing acknowledged (reopen replays the journal); only a
  kernel crash or power cut can lose the last interval. `--durability
  per-commit` restores the previous flush-per-write behaviour. Measured on a
  Mac: single document set 13.1 ms → 0.59 ms. In the consumer's Linux soak
  the write-commit median went from 23.9 ms with per-commit durability to
  3.2 ms (official emulator on the same host and workload: 197.5 ms) and the
  64 KiB Storage upload from 18.0 ms to 2.7 ms.
- Every HTTP front (REST, Storage, Auth, hub, UI, Requests feed) sets
  `TCP_NODELAY` on accepted connections, as the gRPC front already did
  ([#35](https://github.com/sanjevirau/fireside/pull/35)). A 64 KiB download
  over a reused keep-alive connection on Linux fell from 40.7 ms to 0.5 ms
  (Nagle waiting on the client's delayed ACK); fresh connections were
  unaffected.
- Queries not served in `__name__` order no longer decode every scanned
  document ([#38](https://github.com/sanjevirau/fireside/pull/38)). Stored
  values gain a field directory that lets filters, order keys, cursors and
  vector distances read one field path; only result pages are decoded.
  `__name__ ==`/`in` filters read the named documents directly and count-only
  aggregations use a dedicated `count` path. Values written by earlier
  versions stay readable without migration. On a 10,918-document collection
  of ~30 KiB documents: `orderBy` field limit 20 642 → 106 ms, `count()`
  737 → 91 ms, `__name__ in` ten ids 646 → 10 ms.
- REST `ListDocuments` for a named collection reads the scoped collection
  index instead of scanning the whole database
  ([#37](https://github.com/sanjevirau/fireside/pull/37)): `pageSize=1` on a
  211,202-document store 1.3 s → 1–4 ms.
- Fresh-start seed import runs inside one redb transaction with pipelined
  export decoding and concurrent Storage object copies
  ([#36](https://github.com/sanjevirau/fireside/pull/36)); Storage import of
  33,353 objects 11.1 s → 3.9 s on a Mac. Persistent resume is unchanged.
- Dependencies: `tower-http` 0.6.11 → 0.7.1 and `tokio-tungstenite` 0.29 →
  0.30 (Rust), `actions/setup-java` v6.0.1 (CI). No change to the pinned
  `firebase-tools` (15.22.0), the Rust toolchain or the package layout.
- Limitations recorded with this release: ordered full-collection scans and
  `count()` over a large collection of large documents still run at roughly
  half the Java emulator's speed (CPU-bound copying of every candidate's
  bytes out of redb), and fresh import of a large seed remains slower than
  the Java in-memory import (16 s versus 7 s in the consumer's measurement,
  the Java figure carrying no durable state). State written by this version
  carries the field directory and a durability journal, so it is not meant
  to be reopened by an older package version. Prerelease on `next`; no
  stable or universal-compatibility claim.

# 0.1.0-next.5 — Functions admission parity for upstream-ignored handlers

- Pin the engine to `40c9f3f4fd32e9cc4409b14bee5ba390b1bf3c12`, the merge of
  [PR #30](https://github.com/sanjevirau/fireside/pull/30) on the next.4
  engine.
- Fix a startup regression in next.4: the Functions host rejected every
  handler that firebase-tools 15.22.0 itself marks ignored. A published
  Extension function whose `extension.yaml` declares only `taskQueueTrigger`
  (for example `algolia/firestore-algolia-search`'s full reindex) is
  discovered by upstream without a trigger and ignored; the official emulator
  logs it and starts, next.4 failed with `discovered but not admitted`. The
  host now fails readiness only when upstream ignored a handler after a
  registration with this suite's own peers, and reports upstream-untypable
  handlers by identity and reason on stderr with an `ignoredCount` in the
  READY receipt. Those handlers still receive no deliveries, as on the
  official emulator.
- Announce each completed native routing refresh on stdout after a Functions
  source reload (`fireside functions routing refreshed: N registered
  functions`); upstream `/backends` lists a new handler slightly before the
  native topic table is replaced.
- Recaptured the `functions-readiness-v1` oracle with the upstream-ignored
  scenario and archived the owned-adapter verification receipt. No dependency
  version, toolchain or package layout change. Prerelease on `next`; no stable
  or universal-compatibility claim. Private consumer acceptance evidence for
  the next.4 engine is not re-run for this host-level correction; the
  representative consumer's real configuration (three extensions, full
  dataset) reached readiness with a private local build of the fix before
  publication.

# 0.1.0-next.4 — Phase A–F qualified engine

- Pin the engine to `fc54e341a6da4fc6ca26849287f92f335a6184ce`, the candidate
  that passed exact-source CI, all five platform install cells and a
  representative private consumer's full-data endurance, restart, parity and
  fresh-setup acceptance. See `support/phase-f-qualification.md`.
- Engine changes since next.3 cover the Phase A–E work: developer-tool
  inspection and request tracing, rules coverage, Functions readiness and
  reload contracts, state upgrade, low-disk and interrupted-export recovery,
  REST read projection/transaction semantics, canonical REST value/timestamp
  encoding, and cheaper nested-value serialization.
- Known limitations recorded with this release: under one consumer's
  concurrent two-hour workload, a limit-1 collection query and a 64 KiB
  Storage cycle had higher medians than the official emulator, while idle and
  light-load medians were at parity or better; Storage mutations pay an fsync
  by design; fresh-start import of a large dataset is slower than the Java
  in-memory import. Persistent-dataset resume was not measured in that run.
- No dependency version, toolchain or package layout change. Prerelease on
  `next`; no stable or universal-compatibility claim.

# 0.1.0-next.3 — independent source identity

- Replace the remaining consumer-shaped serialization inputs with independently
  captured, domain-neutral records from both pinned official emulators.
- Preserve all seven read transports, eight repetitions, value/order assertions,
  and memory/disk-WAL replay. No engine runtime or dependency version change.
- Pin the engine in the rewritten public history. Earlier package bytes and
  signed provenance remain unchanged; the new identity needs fresh platform
  build/install checks and protected publication approval.
- Keep previous dependency advisories and preview compatibility limits explicit.

# 0.1.0-next.2 — public distribution cleanup (published)

- Describe the generic local emulator preview without naming private consumers,
  linking their reports, or claiming universal compatibility.
- Keep private application acceptance separate from the public engine/hash receipt.
- Remove a consumer name from an unsupported-schedule diagnostic. No API, data
  format, supported schedule, state lifecycle or workload behavior changes.
- Check actual npm archive bytes before publishing: explicit file allowlist,
  no links/path traversal, no credential markers, and private-policy checks.
- Preserve earlier package versions and their evidence. This is not a new
  performance result or endurance qualification.
- All seven quality jobs and all five native platform cells remain required.
  Publication completed through a separately reviewed recovery of the original
  archives. No stable-release qualification is implied by registry tags.

# 0.1.0-next.1 — browser Auth repair

- Add the SDK-compatible local account picker and iframe event relay.
- Cover imported Google accounts, synthetic accounts, cancellation, redirect,
  persistence, Unicode and disabled-account rejection with captured fixtures.
- Accept credentials supplied through requestUri as well as postBody.
- Add private local-candidate packaging with distinct source-version identity.
- Keep disk/WAL, resume, export and platform lifecycle safeguards unchanged.
- Provider/tenant coverage remains limited; this is not real Google login or
  a universal Firebase compatibility claim.

# 0.1.0-next.0 — first installable preview

- One npm CLI selects an exact native package for macOS x64/arm64, Linux
  x64/arm64 glibc, or Windows x64. No Rust build or install-time downloader.
- Explicit compatibility-asset setup, read-only doctor, suite start/exec,
  disk/WAL persistence and graceful export-first shutdown.
- Existing Node and Java helper dependencies remain. See the package README
  for supported configuration and service limits.
- Version/source/checksum receipts identify the tested artifacts; platform
  checks are not universal application or performance qualification.
