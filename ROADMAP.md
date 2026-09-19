# First-release phases

This is a product backlog, not a claim that the work below is implemented or
verified. [COMPATIBILITY.md](COMPATIBILITY.md) describes the current preview.
Existing release evidence continues to apply only to its recorded candidate.
[support/roadmap.html](support/roadmap.html) is a self-contained tracker of the
same information — phases, services, CLI surface, configuration shapes and the
remaining drop-in backlog — for reading in a browser; its data block is updated
alongside this file.

## Scope and verification

The first release focuses on the supported Firestore, Auth, Storage and Functions
service profile, its function-oriented scheduling/Pub/Sub support, and the local
developer tools needed to use and debug those services. It is not a promise of
every Firebase service, SDK version or command-line configuration.

Compatibility is defined by the pinned official emulator and supported client
contracts. Use independent synthetic fixtures before behavior changes, and retain
generic regressions. Consumers provide representative private integration and
performance checks; testing every consumer business function is not an emulator
release requirement. No private schema, application code, data or logs belong in
the public fixtures or release artifacts.

## Execution order

These A–F labels organize the next scoped release. They do not restart historical
milestones or authorize expansion into additional emulator services. Checklists
below record current scoped qualification; existing tests remain evidence within their original
scope and should not be recreated merely to satisfy this document.

| Phase | Deliverable | Completion check |
| --- | --- | --- |
| A | Pinned baseline and missing developer-tool oracle fixtures | Versions, supported scope, existing coverage and new captures are recorded before implementation |
| B | Functional developer inspection and debugging | Supported UI controls, Requests/tracing, rules coverage and bounded diagnostics pass synthetic/API/browser checks |
| C | Supported service-contract corrections | Readiness, generic lifecycle/delivery cases and demonstrated protocol gaps pass oracle-backed regressions |
| D | Upgrade and failure recovery | Supported state upgrades, interrupted export, low disk and rollback preserve data or fail actionably |
| E | Evidence-backed efficiency improvements | Comparable before/after measurements, preserved semantics and bounded diagnostics overhead |
| F | Combined release qualification | Exact-candidate CI/packages, representative consumer acceptance and final release report; publication requires approval |

Use feature-sized fixture and implementation commits within a phase, not one
large commit per phase. Phases A–E use short targeted tests and local packages;
reserve long acceptance for the combined Phase F candidate. A phase is complete
only with its named checks and required exact-candidate CI receipts, not because
its implementation has been written. Evidence may reveal additional fixes inside
this scope; expanding scope or changing a frozen criterion requires explicit review.

## Phase A — Baseline and oracle fixtures

- [x] Record the current source/package identity, the pinned official emulator
  and UI versions, supported service/client profile and relevant existing tests.
  Separate known unsupported features, coverage gaps and reproduced defects.
- [x] Capture the missing developer-tool contracts with tiny synthetic data:
  normal and denied requests, tracing/coverage, UI data controls, service status
  and reconnect behavior. Reuse valid existing fixtures where the contract is
  already captured; commit new fixtures before the corresponding product change.
- [x] Record a short reproducible starting baseline for lifecycle, representative
  operations and memory, with separate process boundaries. Define the developer
  tool's buffer/retention and diagnostic-overhead checks before implementation.

Local evidence and limitations are in the [Phase A report](support/phase-a-developer-tools.md).
Phase A was reviewed and merged in [PR #3](https://github.com/firenook-dev/firenook/pull/3).
All seven jobs passed for candidate `85ef3e74abc8a5381eaf5535a8430ef06f8c48ce`
in [CI run 34499162765](https://github.com/firenook-dev/firenook/actions/runs/34499162765).
This receipt covers the oracle/baseline work, not later product changes.

Done when Phase B has versioned fixture inputs, expected observations, provenance
and a concrete verification plan. This is not a full re-audit of every consumer
function, and no two-hour workload is needed for this phase. Later phases capture
their newly demonstrated contract gaps before implementing those corrections.

## Phase B — Functional developer tools

Developer-facing inspection and debugging are required first-release work, not
an optional documentation-only deferral. Serving the official UI assets or
accepting a WebSocket connection is not sufficient evidence of functionality.

Implementation progress is recorded in the [Phase B work log](support/phase-b-developer-tools.md).
The [B–D source qualification audit](support/phase-bcd-qualification.md) records
the completed named checks and exact CI boundary; Phase F release acceptance
is separate and remains incomplete.
Completed internal building blocks do not check off a user-visible requirement.

- [x] Qualify the supported Firestore document, Auth account and Storage object
  browsing and mutation controls through the UI, not only direct API calls.
- [x] Implement the Firestore Requests feed and request/rule-evaluation details,
  including allowed and denied operations and the identifiers needed to correlate
  events. Confirm the UI actually renders the captured information.
- [x] Implement the supported rules-coverage endpoints and reports against the
  official oracle. Correct rule enforcement alone does not establish coverage
  or tracing compatibility.
- [x] Verify service discovery/status and useful logs across startup failures,
  reconnect, reload and shutdown. An empty feed must not mask a broken transport.
- [x] Bound debug buffers and retention. Test slow/disconnected UI clients and
  measure the tracing overhead without changing application semantics.

Done when generic fixture/API regressions and browser verification demonstrate
the supported UI features, reconnect handling and resource bounds. Until then
the compatibility matrix must continue to state the limitations. Broader, unused
services are outside this phase.

## Phase C — Supported service contracts and readiness

- [x] Verify readiness against the configured/discovered Functions inventory and
  expose missing or failed handlers; a minimum count alone is insufficient.
  Use generic handlers to test discovery and lifecycle, not consumer business logic.
- [x] Capture the Functions host's required auxiliary startup requests. Preserve
  those contracts while ensuring unsupported Eventarc/Tasks delivery requests do
  not receive misleading success responses. General task/event emulation remains
  outside the first-release service profile.
- [x] Reuse existing passing contract coverage and fill genuine gaps in the
  supported service profile with oracle-backed regressions. Treat untested paths
  as coverage gaps, not automatically as product defects.

Done when supported HTTP/callable/trigger and scheduling cases, service errors,
discovery/reload and demonstrated Firestore/Auth/Storage gaps have the required
generic regressions. Consumer billing or other business calculations are outside
this qualification. No complete Eventarc/Tasks or general Pub/Sub emulator is added.

## Phase D — State lifecycle and failure recovery

- [x] Qualify supported native-state upgrades, clean/crash restart, failed or
  interrupted export, low disk and rollback through completed portable exports.
  Retain user state; fail with an actionable recovery path when reuse is unsafe.
- [x] Reuse existing native reopen, dataset-isolation and export/import tests.
  Add targeted fault cases and compatibility-version cases, not duplicate
  happy-path suites. Document which formats can reopen and when export/import
  is required; never use a fresh import as proof of native upgrade compatibility.

Done when the scoped fault/upgrade matrix demonstrates retained acknowledged
state or an explicit safe recovery path, and the normal lifecycle still passes.
Tiny isolated fixtures handle fault injection; full-data lifecycle qualification
belongs to the final combined acceptance.

## Phase E — Measured efficiency improvements

Short qualification is recorded in the [Phase E report](support/phase-e-efficiency.md)
and [exact source/platform receipt](benchmarks/results/phase-e/source-qualification.json).
The small synthetic measurements do not establish full-data memory or throughput;
that representative consumer boundary remains Phase F.

- [x] Profile representative collection reads, Storage operations and lifecycle
  costs before changing the implementation. Distinguish first import, native
  reopen and export/reimport; separate emulator costs from consumer processes.
- [x] Optimize demonstrated allocation, retention, serialization and I/O costs
  while retaining protocol, rules, listener and durability semantics. Compare
  equivalent operations on the same hardware; do not require a win everywhere.
- [x] Include developer-tool tracing overhead and compare both idle and active
  diagnostics. Preserve the original binary's measurements and failed attempts;
  do not relabel old results as verification of a changed candidate.

Done when each adopted optimization has reproducible before/after evidence,
correctness regressions and no unacceptable regression against the predeclared
checks. A measured path with no justified optimization is an honest outcome,
not permission for speculative refactoring or an unsupported speed claim.

## Phase F — Combined release qualification

The [qualification status](support/phase-f-qualification.md) records exact-source
CI/platform success and the completed private run. Final audit found a consumer
cache-notification assertion gap; a short supplemental check outside the
protected runner then verified the invalidation path on both backends, so the
audit is closed without a product change. Slower catalogue-query, Storage-cycle
and startup measurements are recorded as known limitations of this release with
component attribution, not hidden. `0.1.0-next.4` was published through the
protected release workflow on 2026-09-11 and verified from the registry; see
the qualification status for the receipt. Phase F is complete for this scoped
release. `0.1.0-next.5` corrected a Functions admission regression and
`0.1.0-next.6` (2026-09-17) retired the recorded catalogue-query, Storage-cycle
and startup limitations after a second full consumer acceptance on its exact
engine. Stable promotion (`latest`) remains a separate reviewed decision.

- [x] Batch fixes with short targeted tests, then run the required exact-candidate
  quality, SDK, native-package and representative consumer acceptance checks.
- [x] Freeze any added qualification details before measurement. Do not weaken
  existing thresholds or silently reinterpret earlier results. A roadmap update
  neither starts a workload nor retroactively passes an old candidate.
- [x] Complete the scoped full-data/endurance, restart, parity and clean-setup
  acceptance once the combined candidate passes its cheap prerequisites. A
  previous official comparison may be reused only when comparability and
  authorization still hold; label reused evidence as banked. No silent long retry.
- [x] Verify the registry-installed release, publish generic compatibility and
  performance evidence, and document remaining out-of-scope features. Private
  consumer acceptance evidence stays private.

Done when the exact candidate's correctness, developer tools, data safety,
performance, platform checks and limitations have a reviewed report. Tagging and
npm publication require separate release approval; after publication, verify the
registry-installed artifacts and update consumer exact pins. Do not infer a stable
or universal-compatibility claim from completing this scoped release.

Phase G removed Java: Storage rules are evaluated natively. Phase H replaces
firebase-tools as the Functions/Extensions host; Node stays as the user's
Functions runtime. Adding Realtime Database, Hosting, App Hosting, Data
Connect or general Pub/Sub subscribers is separate work. Publication, tagging
and release approval remain governed by the release contract.

## Phase G — Native Storage Security Rules (`0.1.0-next.7`)

The plan, current-state audit, oracle precedence and named checks are in the
[Phase G plan](support/phase-g-storage-rules.md). G0–G4 are implemented on the
main line; G5 (qualification and release) is pending.

| Step | Deliverable | Completion check |
| --- | --- | --- |
| G0 | Frozen gate `benchmarks/phase-g-storage-rules.json` | Oracles, budgets, Java-surface inventory and v1-ruleset decision recorded before fixtures |
| G1 | `conformance/fixtures/storage-rules-v1` | ≥25 emulator programs / ≥150 steps and ≥200 production expression cases, checksummed, CI integrity green |
| G2 | `rules-engine` accepts `service firebase.storage` | Every G1 expression case replays; divergences asserted, not skipped |
| G3 | `storage-front` evaluates natively, `firestore.*` and `/internal/setRules` work | Every G1 emulator step is parity or a listed divergence; no `Command::new` in `storage-front` |
| G4 | Java gates, `--java`, jar download and docs removed | Suite starts with `java` absent from PATH; `setup` fetches one asset |
| G5 | Exact-candidate CI, consumer gates, paired acceptance, no-Java clean setup, release | `0.1.0-next.7` published through the release workflow; receipts recorded |

- [x] G0 — Freeze the gate before any fixture or product change
  (`benchmarks/phase-g-storage-rules.json`, Rules API probe receipt).
- [x] G1 — Record the production and official-emulator Storage rules corpus;
  commit fixtures before implementation (306 production cases, 26 programs /
  334 steps, checksummed, CI integrity step).
- [x] G2 — Generalize the parser, request model and evaluator; add the
  `firestore` namespace; replay the corpus in unit tests
  (`crates/rules-engine/tests/storage_oracle_replay.rs`).
- [x] G3 — Replace the Java child with the native engine in `storage-front`;
  implement ruleset reload; replay every recorded step over HTTP
  (`crates/storage-front/src/rules_replay_tests.rs`).
- [x] G4 — Remove the runtime, the CLI gate, the asset and the documentation
  of the Java requirement; add the no-Java CI step.
- [x] G5 — Qualify the exact candidate (CI, consumer gates, paired acceptance,
  clean setup without Java) and publish `0.1.0-next.7` as a prerelease
  (2026-09-18: paired acceptance attempt 13 PASS on engine 0720434; release
  run 35327767919; `next` → next.7).

Done when a machine without Java can install, set up, start, enforce Storage
rules including `firestore.get()`, resume and export, and the recorded corpus
shows parity with the official emulator or a documented production-precedence
divergence. `latest` promotion remains a separate decision.

## Phase H — Owned Functions runtime and Extensions (`0.1.0-next.7`, together with Phase G)

The plan, current-state audit, oracle precedence and named checks are in the
[Phase H plan](support/phase-h-functions-runtime.md). User and extension
JavaScript keeps running in Node; Firenook replaced firebase-tools as the host.

| Step | Deliverable | Completion check |
| --- | --- | --- |
| H0 | Frozen gate `benchmarks/phase-h-functions-runtime.json` | Trigger matrix, oracles, firebase-tools-surface inventory and the Extensions registry decision recorded before fixtures |
| H1 | `conformance/fixtures/functions-runtime-v1` | ≥40 programs / ≥250 steps against firebase-tools 15.22.0 covering discovery, HTTP/callable, events, environment, lifecycle and Extensions |
| H2 | `functions-runtime` crate + `support/functions-worker.mjs` | Every H1 runtime step is parity or a listed divergence; readiness/reload fixtures unchanged |
| H3 | `extensions` crate with registry, cache, build, params and vendored offline mode | Synthetic extension and the consumer's three instances resolve and run from cache without network |
| H4 | firebase-tools removed; `--inspect-functions`, `functions:invoke`, `ext:vendor` added | Suite starts with `firebase-tools` absent from `node_modules`; docs updated |
| H5 | Exact-candidate CI, consumer gates, paired acceptance, offline clean setup, release | `0.1.0-next.7` published through the release workflow; receipts recorded |

- [x] H0 — Freeze the gate and the supported trigger matrix (2026-09-17,
  `benchmarks/phase-h-functions-runtime.json`).
- [x] H1 — Record the official-emulator Functions and Extensions corpus;
  commit fixtures before implementation (2026-09-17: 5 profiles, 43
  programs, 281 steps, 250 handler observations in
  `conformance/fixtures/functions-runtime-v1`).
- [x] H2 — Build the Rust supervisor and the Node worker; replay the corpus
  (2026-09-17: `crates/functions-runtime`, `support/functions-worker.mjs`;
  main, v1-blocking and inspect profiles replay with every non-extension step
  identical or a listed divergence).
- [x] H3 — Build the Extensions loader; vendored offline mode (2026-09-17:
  `crates/extensions`, `firenook extensions status|vendor`, `--offline`;
  the synthetic extension and the two registry instances replay from the
  shared cache with their registry sidecars).
- [x] H4 — Remove firebase-tools from the product and add the local commands
  (2026-09-17: `support/functions-host.cjs` deleted, `firebase-tools` left
  the CLI's dependencies, `--inspect-functions`, `--offline`,
  `functions:invoke`, `ext:vendor`, `doctor` extension report).
- [x] H5 — Qualify the exact candidate (CI, consumer gates incl. the Extensions
  gate, paired acceptance, offline clean setup) and publish `0.1.0-next.7`
  (2026-09-18: same acceptance and release as G5; function delivery 2.6 ms p50
  against 3.8 official, emulator peak PSS 1.77 GiB against 19.35).

Done when a project with user Functions and Extensions starts on a machine
with Node only, every supported trigger delivers with the recorded envelope,
the consumer's Extensions gate passes on the owned runtime, and vendored
extensions start with no network. Python/Dart functions stay unsupported.

## Phase I — Complete Authentication (`0.1.0-next.8`, together with Phase J)

The plan, current-state audit, oracle precedence and named checks are in the
[Phase I plan](support/phase-i-auth.md). The official Auth emulator implements
61 operations; Firenook implements 23 of them before this phase.

| Step | Deliverable | Completion check |
| --- | --- | --- |
| I0 | Frozen gate `benchmarks/phase-i-auth.json` | Operation inventory, oracles and named checks recorded before fixtures |
| I1 | `conformance/fixtures/auth-v1` | ≥60 programs / ≥500 steps against firebase-tools 15.22.0 covering every implemented operation, blocking functions on every blocked sign-in method, tenants, SMS MFA, passkeys, OOB and phone codes, export/import |
| I2 | `auth-front` rewritten on a typed account model with every operation | Every I1 step is parity or a named divergence in a Rust replay |
| I3 | Blocking functions and triggers on every path | Recorded functions calls match for each sign-in method |
| I4 | Replay, SDK browser profile, Emulator UI check | Replay green; browser cells green; UI Auth tab manual check recorded |
| I5 | Exact-candidate CI, consumer gates, release (paired acceptance waived for this release) | `0.1.0-next.8` published through the release workflow; receipts recorded |

- [x] I0 — Freeze the gate and the operation inventory (2026-09-18,
  `benchmarks/phase-i-auth.json`).
- [x] I1 — Record the official Auth emulator corpus; commit fixtures before
  implementation (2026-09-18: 61 programs / 1068 steps in
  `conformance/fixtures/auth-v1`, every one of the 61 implemented and 42
  unimplemented official routes exercised; three recordings identical).
- [x] I2 — Every operation ported (2026-09-18: `crates/auth-front` rewritten
  on the official `OpenAPI` contract — routing, credentials, validation and
  coercions from the bundled document; all 61 implemented operations, the 42
  `501` answers, pages, legacy `relyingparty` routes, tenants, SMS MFA,
  passkeys, session cookies, export/import; standalone `firenook auth`).
- [x] I3 — Blocking functions on every blocked sign-in method and lifecycle
  multicasts on every create/delete path (2026-09-18; the recorded calls
  match per method).
- [x] I4 — Replay green (2026-09-18: 61 programs / 1068 steps / 17,303
  values, 0 mismatches, four named divergences — parse-error prose, the
  Node stack trace on a 500 log line, Firenook's own picker page — three
  consecutive runs identical; the real-SDK popup/redirect browser gate and
  the five earlier `firebase-suite-v1` Auth fixtures stay green). Emulator UI
  Auth-tab check recorded at I5 with the candidate.
- [x] I5 — Qualified and published as `0.1.0-next.8` on 2026-09-19 (tag `npm-v0.1.0-next.8` on 316a464, release run 35372788758, registry integrity equal to the release assets, `next` → next.8, `latest` untouched): CI green on the exact head, consumer
  extensions/integration/installed gates and the nine browser journeys pass
  on the candidate; the paired 2 h soak was waived by the owner for this
  release (per-release-line gate; the next.6 and next.7 records stand).

Done when an application using any sign-in method, tenants, MFA, email or
phone verification, session cookies or the Admin SDK's account management runs
against Firenook with the recorded official behaviour.

## Phase J — Pub/Sub emulator (`0.1.0-next.8`, together with Phase I)

The plan, current-state audit, oracle precedence and named checks are in the
[Phase J plan](support/phase-j-pubsub.md). The official emulator is
`cloud-pubsub-emulator-0.8.33` with 37 RPCs over gRPC and HTTP/JSON; Firenook
has a nine-route HTTP adapter with no message backlog before this phase.

| Step | Deliverable | Completion check |
| --- | --- | --- |
| J0 | Frozen gate `benchmarks/phase-j-pubsub.json` | RPC inventory, oracles and named checks recorded before fixtures |
| J1 | `conformance/fixtures/pubsub-v1` | ≥40 programs / ≥400 steps against emulator 0.8.33 over both transports |
| J2 | Broker core: backlog, ack deadlines, ordering, filters, push, seek/snapshots, schemas | Unit replay of every J1 program's semantics |
| J3 | gRPC services on the Pub/Sub port + full HTTP/JSON transcoding | `@google-cloud/pubsub` connects and every J1 step is parity or a named divergence |
| J4 | Replay over both transports; Functions delivery through the broker | Replay green; existing schedule/dispatch fixtures unchanged |
| J5 | Exact-candidate CI, consumer gates, release (paired acceptance waived for this release) | `0.1.0-next.8` published through the release workflow; receipts recorded |

- [x] J0 — Freeze the gate and the RPC inventory (2026-09-18,
  `benchmarks/phase-j-pubsub.json`).
- [x] J1 — Corpus recorded and frozen (2026-09-18: 42 programs / 916 steps
  in `conformance/fixtures/pubsub-v1` against `cloud-pubsub-emulator-0.8.33`,
  all 37 RPCs over gRPC and 36 over HTTP/JSON, push endpoint and streaming
  pull sessions recorded; two recordings identical).
- [x] J2 — Broker core (2026-09-18: `crates/pubsub-front` rewritten — backlog
  with leases, ack deadlines, redelivery, dead-lettering, ordering keys,
  filters, topic retention, seek to time and snapshot, push loop with the
  official retry cadence, Avro schemas with revisions; function delivery
  keeps `emulator-sub-<topic>` and the unchanged envelopes).
- [x] J3 — `google.pubsub.v1` Publisher/Subscriber/SchemaService and
  `google.iam.v1` IAMPolicy over tonic plus the full HTTP/JSON transcoding on
  the one Pub/Sub port (2026-09-18; `firenook pubsub` runs it standalone).
- [x] J4 — Replay green (2026-09-18: 42 programs / 916 steps / 3,755 values,
  0 mismatches, no named divergences, three consecutive runs identical);
  `@google-cloud/pubsub` 5.3.1 with `PUBSUB_EMULATOR_HOST` publishes,
  streams, orders, pushes and validates schemas against Firenook; the Phase H
  Functions/Extensions corpus replays unchanged (271/271).
- [x] J5 — Qualified and published as `0.1.0-next.8` on 2026-09-19 (tag `npm-v0.1.0-next.8` on 316a464, release run 35372788758, registry integrity equal to the release assets, `next` → next.8, `latest` untouched) (same candidate, gates and waiver as
  I5; the scheduled functions and function targets ran on the rewritten
  broker during the journeys).

Done when a client library with `PUBSUB_EMULATOR_HOST` set publishes,
subscribes (pull, streaming, push), orders, filters, seeks and validates
schemas against Firenook with the recorded official behaviour, and function
delivery is unchanged.

## Phase K — Cloud Tasks emulator (`0.1.0-next.9`, with Phases L and M)

The plan, current-state audit, oracle precedence and named checks are in the
[Phase K plan](support/phase-k-tasks.md). The official Cloud Tasks emulator
is four Express routes and a dispatcher inside firebase-tools 15.22.0;
Firenook has a registration-only stub answering 501 elsewhere before this
phase.

| Step | Deliverable | Completion check |
| --- | --- | --- |
| K0 | Frozen gate `benchmarks/phase-k-tasks.json` | Route/dispatch inventory, oracle source digests and named checks recorded before fixtures |
| K1 | `conformance/fixtures/tasks-v1` | ≥6 programs / ≥60 steps against firebase-tools 15.22.0 covering every route, the dispatch headers, the retry ladder, the deadline, the limits, deletion and the Admin SDK path |
| K2 | `crates/tasks-front`: queue registry, four routes, dispatcher, discovery from the Functions inventory | Unit tests for every recorded status/body and dispatch rule |
| K3 | Replay of the tasks profile against the suite; Phase H corpus unchanged | Replay green in CI |
| K5 | Exact-candidate CI, consumer gates, release | `0.1.0-next.9` published through the release workflow; receipts recorded |

- [x] K0 — Freeze the gate (2026-09-19, `benchmarks/phase-k-tasks.json`).
- [x] K1 — Corpus recorded and frozen (2026-09-19: 6 programs / 62 steps /
  39 handler observations in `conformance/fixtures/tasks-v1`, recorded by
  the Phase H harness's new `tasks` profile).
- [x] K2 — Engine (2026-09-19: `crates/tasks-front` — queue registry, the
  four routes with Express-shaped answers, the dispatcher with the official
  cadence, `/queueStats`, discovery from the Functions inventory at readiness
  and after reloads; mounted on the Tasks port in place of the stub).
- [x] K3 — Replay green (2026-09-19: 61/61 steps, 0 mismatches, no named
  divergence, three runs identical; the Functions runtime corpus replays
  271/271 with the Tasks emulator mounted).
- [x] K5 — Qualified and published as `0.1.0-next.9` on 2026-09-19 (tag `npm-v0.1.0-next.9` on e9c58e0, release run 35440801335, registry integrity equal to the release assets, `next` → next.9, `latest` untouched): exact-candidate CI 35437156565 / 35437156569 on 7fb0c35, consumer gates and nine browser journeys on the local candidate (`receipts.k5`).

Done when `getFunctions().taskQueue().enqueue()` from a function or an app
with `CLOUD_TASKS_EMULATOR_HOST` set reaches the handler with the recorded
headers, retries and limits, and `/queueStats` answers.

## Phase L — Configuration shapes (`0.1.0-next.9`, with Phases K and M)

The plan and the recorded official behaviours are in the
[Phase L plan](support/phase-l-configuration.md); the gate is
`benchmarks/phase-l-configuration.json`.

| Step | Deliverable | Completion check |
| --- | --- | --- |
| L1 | Service subsets (`--only`, projects without Functions or Storage) | Every listener, runtime, hub entry, import and export step conditional; a subset suite starts and stops cleanly |
| L2 | Any project id, any listen host, `ui.enabled: false`, `singleProjectMode`, `--debug-log` | Official banners and warnings; loopback connect addresses for a wildcard bind; UI and logging follow the flag; foreign-project warning once |
| L3 | Multiple Firestore databases | Rules per database with the documented precedence; every database exported and imported |
| L4 | Wrapper acceptance of every shape | `packaging/cli.test.mjs` covers derivation, `--only`, storage forms, real ids, hosts, flags |
| L5 | Exact-candidate CI, consumer gates, release | `0.1.0-next.9` published; receipts recorded |

- [x] L1 — Service subsets in the engine (2026-09-19).
- [x] L2 — Project ids, hosts, UI/logging coupling, single-project mode,
  debug log, missing `.firebaserc` and missing `storage` section
  (2026-09-19).
- [x] L3 — Multiple Firestore databases (2026-09-19: `firestore` arrays,
  rules per database with a project-wide hot reload replacing every
  database's rules as officially, every database exported and imported).
- [x] L4 — Wrapper (2026-09-19: official service derivation and `--only`,
  storage object form and absence, `firestore` arrays, real ids, hosts,
  `ui.enabled`, `singleProjectMode`, `--debug`, the compatibility flags).
- [x] L5 — Qualified and published as `0.1.0-next.9` on 2026-09-19 (tag `npm-v0.1.0-next.9` on e9c58e0, release run 35440801335, registry integrity equal to the release assets, `next` → next.9, `latest` untouched) (same candidate and gates as K5).

## Phase M — CLI surface (`0.1.0-next.9`, with Phases K and L)

The command-by-command decisions are in the [Phase M plan](support/phase-m-cli.md);
the gate is `benchmarks/phase-m-cli.json`.

| Step | Deliverable | Completion check |
| --- | --- | --- |
| M1 | `emulators:export`, `use`, `target:apply` / `target:clear`, `firestore:delete`, `init` / `init --adopt`, `--debug`, compatibility flags, exec shell-string form | Unit tests against fake binaries and servers |
| M2 | Engine support: path-scoped delete route, `--debug-log` | rest-front and suite-runtime tests |
| M3 | `functions:invoke --event-data` | Background envelopes delivered to the running suite |
| M4 | `mcp` | Dependency-free stdio server with the emulator-facing tools |
| M5 | Exact-candidate CI, consumer gates, release | `0.1.0-next.9` published; receipts recorded |

- [x] M1 — Wrapper commands (2026-09-19: `emulators:export`, `use`,
  `target:apply` / `target:clear`, `firestore:delete`, `init` /
  `init --adopt`, `--debug`, `-P`/`-c`/`--json`/`--non-interactive`/
  `--log-verbosity`/`--ui`/`--force`, the exec shell-string form; 92
  packaging tests).
- [x] M2 — Engine support (2026-09-19: `DELETE
  /emulator/v1/projects/{p}/databases/{db}/documents/{path}?mode=…` and
  `--debug-log`).
- [x] M3 — `functions:invoke --event-data` (2026-09-19: the official shell's
  envelopes for Firestore, Storage, Pub/Sub, Auth v1, schedules, Eventarc
  custom events and task queues, posted to the running suite).
- [x] M4 — `mcp` (2026-09-19: dependency-free stdio server with status,
  Firestore, Auth, Storage, Functions, Pub/Sub, Tasks and export tools).
- [x] M5 — Qualified and published as `0.1.0-next.9` on 2026-09-19 (tag `npm-v0.1.0-next.9` on e9c58e0, release run 35440801335, registry integrity equal to the release assets, `next` → next.9, `latest` untouched) (same candidate and gates as K5).

## Rename to Firenook (`0.2.0-next.1`)

The project took its new name, Firenook, on 2026-09-19; `0.1.0-next.9`
is the last release under the former name and `0.2.0-next.1` the first under the
new one (see the `0.2.0-next.1` entry of `packaging/CHANGELOG.md` and the
README's migration note). The engine is the next.9 engine plus the rename, the
in-place adoption of store files written before it and the decoding of listen
resume tokens issued before it; no emulator behaviour changed.

- [x] Rename PR [#58](https://github.com/firenook-dev/firenook/pull/58) merged
  (head 9d69251: CI 35445747233, packed installs 35445747328); repositories
  transferred to `firenook-dev/firenook` (and the private harness repository
  alongside it) with the release environment, secret and runner intact.
- [x] Published as `firenook@0.2.0-next.1` with `@firenook/cli-<platform>`
  ×5 on 2026-09-19 (tag `npm-v0.2.0-next.1` on 630779b, release run 35449320572,
  registry integrity equal to the release assets and provenance attestations
  for all six packages, `next` and `latest` → 0.2.0-next.1 since the packages
  have no stable version yet).
- [x] Fresh-machine installs from the registry: macOS arm64 (this checkout's
  host), Linux x64, macOS arm64 and Windows x64 on GitHub-hosted machines
  (`npm i -D firenook`, `firenook init`, `firenook setup`, `emulators:exec` on
  the scaffold; `npm audit signatures` verifies the attestations);
  the native-upgrade verifier resumed state written by the last old-name
  engine (`0.1.0-next.3`) under this one.
- [ ] Deprecation of the six packages published under the former name waits
  for the consumer's pin swap and gates on `0.2.0-next.1`.
