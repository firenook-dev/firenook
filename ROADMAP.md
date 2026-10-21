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
- [x] The six packages published under the former name were deprecated on
  2026-09-20 after the consumer's pin swap and gates on `0.2.0-next.1`
  (every version carries the deprecation notice; a notice-only
  `0.1.0-next.10` with no engine is their `latest`/`next`).

## Read path and listener maintenance (`0.2.0-next.2`)

A fix round on the `0.2.0-next.1` engine, recorded in
`support/read-path-audit.md`: the official Emulator UI's Firestore browser
polls `ListCollectionIds` and `ListDocuments(show_missing)` every 10 s, and
both walked the whole database and copied every document body; every
Firestore read ran on the shared async workers, so four such scans stalled
Auth, Storage and the UI itself. No new service or API.

- [x] Key cursor with subtree skips in the store; `ListCollectionIds`,
  `ListDocuments` (missing documents, unnamed listing), recursive delete and
  clear-database walk keys under a prefix instead of the database.
- [x] Index-only `count()` on both backends; the REST aggregation handler
  shares the gRPC lazy count path; REST `runQuery` honours `select`
  (recorded against the official emulator first).
- [x] Bounded read pool for every CPU-bound Firestore read, listener
  initialization and refresh, the REST query bodies and the suite export;
  `RunQuery` streams through a bounded channel.
- [x] Auth persists its state only when a request changed it, writing after
  the lock is released; the Requests-diagnostics report is summarized once a
  minute and events serialize outside the buffer lock.
- [x] Listen streams wake on a commit notifier instead of a 10 ms poll and
  maintain their views incrementally (window entry/eviction included), with a
  randomized equivalence test against full evaluation on both backends.
- [x] Equality field index in the disk store: top-level `==` and `in`
  filters on one collection read only the documents holding the value
  instead of the whole collection, so a queue-shaped query (a few active jobs
  among many settled ones) and every listener refill it causes cost what they
  return. Candidates only; every filter is still evaluated. Randomized and
  exhaustive equivalence tests against the scanning stores;
  `FIRENOOK_FIELD_INDEXES=0` restores scanning.
- [x] Published as `firenook@0.2.0-next.2` with `@firenook/cli-<platform>` ×5
  on 2026-10-03 (release PR #68, tag `npm-v0.2.0-next.2` on ed6876a, engine
  63d554c, release run 37123335020; registry integrity equal to the release
  assets for all six packages, provenance attestations verified on a fresh
  install, `next` → 0.2.0-next.2, `latest` untouched). The release also
  carries the console scaffold (#63) and the Rust 1.99 lint fixes (#67).
- [ ] Acceptance-host lanes for this engine: not run before publication; the
  local verification is in the CHANGELOG entry and the follow-up section of
  `support/read-path-audit.md`.

## Own console (Phase N, `0.2.0-next.3`)

The emulator's own UI replaces the served Google 1.15.0 bundle and the
`firenook setup` download, and is the product surface later deployments
share. It lives in `console/` (client-only React, Vite, TanStack, Kumo on
Base UI, Tailwind) and is embedded into the binary by `crates/console-front`,
mounted under `/console` on the UI port. The Google UI was served beside it
at the port's root until every section had landed; since `0.2.0-next.3` the
root leads to the console.

- [x] Published as `firenook@0.2.0-next.3` with `@firenook/cli-<platform>` ×5
  on 2026-10-17 (release PR #81, tag `npm-v0.2.0-next.3` on 5ee8c92, engine
  19f2338, release run 39031389689; registry integrity equal to the release
  assets for all six packages, provenance attestations verified on a fresh
  install, `next` → 0.2.0-next.3). Every section below ships in it, Google's
  UI is gone, and #80's five fixes for checks that failed now and then.

- [x] (Shipped in `0.2.0-next.2`.) Stack, shell, command palette, overview and
  the Console API's first route with Rust-generated TypeScript types; unit,
  end-to-end (real engine) and bundle-budget checks in CI; the console is
  built before every engine build.
- [x] Same-origin data services under the console: the Firestore REST front,
  the Requests feed and the Auth application mount under `/console/api/v1`,
  so the console works wherever its page loads from (a proxy, an HTTPS
  alias) and never needs the service ports from the browser.
- [x] Live channel: a server-sent event stream fed by the store's commit
  observers carries every commit's document paths; the console invalidates
  by scope and flashes the rows on screen. Nothing polls.
- [x] Firestore workbench: path bar as a command line with completion and
  index counts, grid with inferred typed columns (mixed types flagged),
  cursor-paged and virtualized, the SDK query chain as text with the live
  count, view-as-user over the rules engine with the Requests drawer and the
  deciding rule lines, inspector with typed editors and JSON, add and delete
  (recursive), copy as code (Web, Admin, Flutter, REST). Found and fixed on
  the way: the REST front ignored `startAt`/`endAt` cursors.
- [x] Creating and shaping: one `New` menu that follows the context (document,
  root collection, subcollection under the open document, duplicate, JSON
  import), typed fields from the first document, the inspector grows
  subcollections in place, the path bar offers to create what does not
  exist, column headers sort, filter and hide, scalar cells edit in place,
  reference cells peek at their target beside the grid, every row shows
  its subcollections and jumps into them, and ⌘K carries the page's
  collections, recent paths and actions.
- [x] The shape of the data: the engine keeps a schema index per database
  (collection patterns such as `users/*/orders/*/items` with document and
  parent counts, one key-only walk on first use, exact from then on through
  the commit observer) and serves it at `/console/api/v1/firestore/schema`.
  The console draws it as a tree: a root opens as a grid, a nested pattern
  opens as the collection group it names, the row for the current shape is
  marked and the foot says how many parents carry it. The grid names each
  row's subcollections in their own column, the path bar shows a pattern's
  `*`, the root landing describes each collection's shape, and ⌘K finds
  any pattern by name.
- [x] The shell's layout: the navigation is expanded or collapsed to icons
  (flipped at its foot or with `[`, kept per browser), a collapsed one
  slides its labels out on hover, and every section can fill a panel
  column beside its content. Firestore fills it with the database, a filter and the schema
  tree, open only along the current path, so a database with dozens of
  roots and hundreds of thousands of documents reads at a glance; the
  workbench runs edge to edge under its own toolbar, and `t` hides the
  panel.
- [x] Every database of the project: `/console/api/v1/firestore/databases`
  lists `(default)`, every database `firebase.json` declares and every one
  a client has written to (the store seeks once per database), and the
  panel's picker offers them, asking again each time it opens. Picking one
  switches the tree, the path bar and the grid to that database alone.
- [x] A pass over the Firestore section against a database of its own making:
  a long field name no longer widens its column without end and a short one
  under a long type badge keeps its header, arrays preview their items the
  way maps preview their keys, the inspector keeps a long field's type and
  remove controls inside the panel, a query that does not parse says so
  instead of claiming to load for ever and leaves its text editable, the
  document actions sit below the subcollections they act with, the grid's
  footer and the query line scroll rather than stack when the column is
  narrow, the inspector floats over the grid below `xl` instead of
  squeezing it to a sliver, and the console follows the operating system's
  colour scheme (Kumo's dark tokens were complete; nothing set `data-mode`).
- [x] A theme the person picks: light, dark, or match the operating system,
  remembered per browser and offered both in the header and in ⌘K. `system`
  keeps following the OS live, so a machine that darkens at sunset takes the
  console with it, while an explicit choice outlives the OS changing. Three
  buttons rather than a menu, because Kumo's `DropdownMenu` is not in the
  first route's chunk and pulling it in cost 10 KB of the bundle budget.
- [x] One request for a whole screen of subcollections.
  `POST /console/api/v1/firestore/subcollections` answers a list of parents
  at once — which collections each document has and how many documents are
  in each — from the schema index, which now keeps the concrete collections
  (`users/u_9f3k2/orders`) beside the patterns it already kept. The grid's
  column asked `ListCollectionIds` per rendered row and a count per chip, so
  a screen cost dozens of requests and scrolling a large collection cost
  thousands; the console now collects every path a tick asks for into one
  request, while keeping its cache and live invalidation per document. The
  index agrees with the store's own listing, descendant-only collections
  included: `teams/t1` has `channels` even when no channel document exists.
  Measured on 82,000 documents, a 32-row screen takes 2 ms in one request
  against 9 ms in the 96 it replaces.
- [x] The engine reports the version it actually ships as. Every crate here
  carries the `0.0.1` workspace placeholder, because the npm package's
  version is set by the packaging checkout while the binary is built from
  the pinned engine commit — so the binary cannot know it at compile time
  and the console's badge read `engine 0.0.1`. The CLI now passes
  `FIRENOOK_RELEASE_VERSION` and `FIRENOOK_ENGINE_REVISION` at launch,
  `firenook --version` and the console's status document report them, and a
  binary started any other way says "unreleased build" rather than naming a
  number that means nothing.
- [x] The grid reads previews instead of whole documents. A collection whose
  documents carry large maps made the page query ship 30 MB of JSON to paint
  one screen — 302 KB a document, of which a cell shows one truncated line,
  and the inspector refetched the document anyway. `runQuery` now opts in
  with `x-firenook-preview`, and the REST front cuts strings and containers
  to what a preview can draw while reporting their real sizes, so a cell
  still shows the true entry count and never passes a fragment off as the
  whole value. The fields the cursor orders by are kept whole, a cut value
  is not editable in place, and a request without the header is unchanged
  byte for byte.
- [x] A console reader that goes away no longer wedges the schema index.
  The walk was owned by whichever request asked for it first, so a browser
  navigating, a socket closing or a client timing out dropped it mid-flight
  and left the database marked as building for ever: the schema tree and the
  grid's subcollections then hung for the life of the process while queries
  and the status document kept answering normally. The walk now runs on its
  own task and every reader waits on the notification, with an attempt
  budget so a store that cannot be walked fails instead of looping.
- [x] One connection could hold the suite's stop open for ever. The engine
  printed that it was stopping and then never exited, so the ports stayed
  taken and nothing could restart on them. A listener's graceful drain stops
  accepting and then waits for the connections it already has: it closes the
  ones sitting idle between requests, but a connection that has begun a
  request and not finished sending it is not idle, so the wait never ended.
  Every stream the console and the UI hold open already ends itself on the
  stop signal, which is why the change feed was not the cause. Each HTTP
  listener now gives the drain three seconds and then closes whatever is
  still connected, the way the Firestore port already closed its WebChannel
  and gRPC responses. A stop with nothing left to wait for is unchanged.
- [x] Explain: what a query reads here, and what it would need in
  production. The local engine answers every query it is given, so a query
  that works all through development can still fail after a deploy for want
  of a composite index. The plan comes from the code that runs the query,
  not from a description of it — one function decides the strategy and
  `execute_iter` and `plan` both call it — and names where the candidates
  come from: documents read by name, an equality field index, a collection
  scan or a collection-group scan. Beside it is the index requirement,
  derived by asking a catalog that declares nothing what the query would
  need, and the project's own `firestore.indexes.json` then says whether it
  is already declared. The entry to paste is printed from the requirement
  and a test declares that printed entry to prove it satisfies the query. A
  declared index is a trailing `__name__` away from looking missing, which
  is how the Firebase CLI writes some of its entries, so that field is now
  matched as the implicit one it is.
- [x] Export from the page: the query you are looking at, as JSON, NDJSON or
  CSV. It reads whole documents rather than the previews a cell draws from,
  pages the whole result with the grid's own cursors, and says before it
  writes anything what the file will contain and whose view it is — an
  export made while viewing as a user holds what that user can read. Plain
  JSON is keyed by document id, which is the shape this console imports, so
  an export loads straight back in; references, bytes, geopoints and vectors
  have no plain-JSON form that survives that, so "keep Firestore types
  exactly" writes the REST wire shape and the import now recognises it
  instead of storing the wrappers as maps.
- [x] One instant, one spelling. Writing that round trip found the engine
  answering with a timestamp in two shapes: every REST response it encodes
  by hand carried `Z` and as many fractional digits as the value needed,
  while a listing, which is serialized from the protobuf message, carried
  `+00:00` and six. A client comparing an `updateTime` it listed against one
  it read saw one document with two different times. Protobuf JSON's
  canonical form — always `Z`, a fraction of exactly zero, three, six or
  nine digits — is now what every endpoint writes, and the normalisation the
  WebChannel and Functions paths each carried a copy of lives in one place.
- [x] A rules editor. The emulator exists so rules can be got right before
  they reach production, and the loop that takes — edit the file, restart,
  try again — is the slowest part of writing them. The rules are now the
  text on screen: `GET`/`PUT /console/api/v1/firestore/rules` read what is
  in force and replace it, a change compiles and takes effect on the next
  request, and the Requests feed then shows the line that decided it.
  Applying and saving are separate, so trying something out never rewrites
  the file behind you; a ruleset that does not compile changes nothing, says
  which line and column, and never reaches the file. A database whose rules
  `firebase.json` does not configure can still be edited and says it was not
  saved rather than implying it was.
- [x] One live connection per browser. Every console page used to open its
  own server-sent event stream, and over plain http the browser allows six
  connections to the console's address, shared by every tab and every request:
  a few tabs and the console's own requests queued behind its streams. Pages now
  subscribe to topics on one stream that one visible tab holds for all the
  others; a tab opened in the background takes nothing until it is shown. A
  subscriber that missed something — a reconnect, a slow tab, a tab that was
  hidden — gets what it missed replayed, or is told so and reloads what it
  shows; the Firestore grid now refetches only the queries a missed write
  touched, and patches a changed document in place instead of reloading every
  page it had scrolled through. When the engine stops it says so at once; when
  it restarts, the console notices by itself, says so, and reloads what is on
  screen.
- [x] Every section knows whether it can be used. The status document names
  each section as ready, starting or absent, with why — not configured in
  firebase.json, left out by --only, or not emulated by Firenook — and the
  exact firebase.json lines or command to turn it on, and is pushed when a
  service finishes starting, so the Functions page fills in by itself when
  discovery ends. The navigation dims what is not running and carries badges
  for what needs a look: a rules file that stopped compiling is a red count on
  Rules the moment it is saved.
- [x] The console says what is true for the whole suite: background triggers
  paused by a test harness (with Resume, since when, and how many events
  reached no function), an app that writes to another project id than this
  emulator's (with the project it used, its data a click away, and how to fix
  it), and whether the data lives in memory or on disk and survives a restart.
- [x] ⌘K searches Firestore's collections and documents from anywhere, from the
  engine's own indexes rather than a walk of the data; each section adds its
  own things to the same search when it lands.
- [x] One error shape across the Console API, with a code and a fix, one
  paging contract with opaque cursors, and one filter language
  (`provider:google -is:disabled ada`, `level=error data.userId:u_1`) that the
  browser and the engine parse the same way, held to one shared file of cases.
- [x] One kit every section is built from: the page's panel, toolbar rows and
  inspector, a table that pages through the engine in both directions and
  patches live rows in place, feeds that pause without losing their place,
  JSON and payload views, a filter field that knows its keys, editors, a
  request composer, an identity picker, a confirmation that says what a
  destructive action sets off, and empty states that hand over the exact
  snippet to connect an app. An empty Firestore collection now shows that
  snippet too.
- [x] Authentication. The users table reads the engine, not the whole
  user list: a page is one request whatever the user count, filtering and
  sorting run in the engine over an index it keeps beside the accounts and
  reads outside the data lock, so the console never slows the app's own
  Auth calls, and the filters panel counts disabled, anonymous,
  custom-token, MFA, claims, unverified, never-signed-in and per-provider
  users exactly. Sign-ups and sign-ins appear without a reload and without
  moving the row being read, and a token refresh costs the console nothing.
  A user opens onto every field the emulator stores — the password it
  keeps recoverably included — with the account actions the Admin SDK has;
  the claims editor checks what Firebase checks as it is typed, measures
  the 1,000-character limit the way Firebase does, and shows the ID token
  those claims produce. "Sign in as" mints the token a real sign-in would —
  tenant, provider and second factor, beforeSignIn on request — without
  signing in, and Inspect a token shows it with what still differs;
  Firestore's "view as" and every identity picker now take
  their token from the engine the same way, re-mint it before it expires
  and drop it as soon as a change to the account would change it. Every link and code the
  emulator would have sent is in an inbox, live, with the action it stands
  for one click away, and ⌘K copies the latest SMS code or opens the latest
  email link from anywhere. Every call to the Auth emulator is in Activity
  with its exact error, the name the SDK gives it, what to change, and what
  it caused: the blocking functions it ran (with their own messages), the
  triggers it queued, the codes it sent and the accounts it changed; a
  call can be copied as curl or replayed. A pasted token is decoded and
  judged the way the rules, the emulator and the Admin SDK would judge it. Tenants (with the id you choose), one account
  per email, email enumeration protection, blocking functions and the
  lifecycle listeners are on one settings page; bulk changes run as jobs
  you can preview and cancel, users import (streamed) and export in the
  emulator's own format, and sample users (up to 1,000 at a time) fill a
  project in seconds and leave as cleanly. Users are in ⌘K. Found and fixed on the way: the suite
  gave Auth no origin, so a code requested through the console linked to
  the console's address; every mutating Auth request — every token refresh
  included — rewrote the whole state, pretty-printed, under the lock, which
  is now snapshotted in O(1) and written off the request path; an engine
  started without a state file saved it under the older layout's version,
  so tenants, codes and proofs were lost on the next restart; custom claims
  were measured in UTF-8 bytes where Firebase counts UTF-16 code units; and
  `batchGet` cloned every account for each page.
- [x] Storage. Every bucket and folder with the files under it, counted
  and sized exactly by an index the engine keeps beside the objects and
  updates one write at a time, so the folder tree and the counts stay
  current without a scan. A folder lists from the engine one page at a
  time in either direction, by name, size, last change or type, filtered
  by name, type, size, dates, custom metadata or what a file carries;
  writes from the app patch the rows they touch in place, and a sorted or
  filtered view counts them and offers Refresh instead of jumping. A list
  and a thumbnail grid, and previews that ask only for what they draw:
  images, video, audio, PDFs, text and code, JSON as text or a tree, CSV
  as a table, HTML with scripts off, and any other bytes, a zip among
  them, as hex with what their first bytes say. A file opens onto its
  facts, the gs:// path, the download URL and REST address an app
  connected to the emulator gets, its download tokens (made and revoked
  from there), a metadata editor that sends only what changed and says
  when the file changed underneath, its history — who changed it, from the
  app or the console, and whether the event reached the Functions emulator
  and which invocations it started — the exact event bodies it sends, with
  Send again, and a warning with a one-click fix when its contentType
  disagrees with its bytes. Small text files edit in place. Uploads of
  files and whole folders with progress, cancel, retry and a question when
  names are taken; new folders, rename, move, copy, duplicate, metadata
  for many files at once and delete run as jobs that report progress and
  can be cancelled, and a folder or a selection downloads as one streamed
  zip at any size. The whole page can act as any Auth user, an anonymous
  client or a custom token: listings, previews and uploads then meet the
  rules (uploads are judged before a byte is sent), a column says what
  that identity may read and delete, and every refusal names the line that
  refused it, with "See why" and "Try in the playground". ⌘K goes to a
  pasted gs:// or download URL, a recent folder or file, any folder the
  tree has read and any bucket. Storage rules have their own page: an
  editor that knows Storage rules (the file an upload proposes,
  `firestore.get()`, the metadata keys the bucket's files carry), live
  checks with Storage's own lints, every decision the rules made with the
  values each expression had written into the editor, a playground, saved
  tests that export as a test file, coverage, history, what applying a
  draft would turn around, starter rules drawn from the bucket's folders,
  and the folders each match block governs. Found and fixed on the way:
  Storage rules files were never reloaded when they changed (the official
  CLI watches them); listing a folder walked every object under it twice
  on every page while holding the service's lock; an aborted upload left
  its staged bytes behind, and so did a crash mid-upload; two uploads
  staged in the same microsecond shared a file; Storage queued trigger
  events even when the suite ran no Functions (the official emulator sends
  none then); and an unfinished resumable upload kept its staged bytes for
  ever (it now goes after seven idle days, as production's session URIs
  expire).
- [x] Functions: every function by codebase with its trigger in plain words,
  and every way one receives nothing said out loud — ignored, its service
  not started, paused, removed by a reload, or dropped at load because the
  emulator cannot deliver its event type. The load that failed and the one
  still serving, the worker behind each codebase (reported the moment it
  exits, restarted from the page, with its inspector address under
  `--inspect-functions`), a TypeScript build that is behind its sources,
  and an env file changed since the last load. Invoke an HTTP function or
  a callable as any Auth user with App Check, or paste a curl command into
  the form; watch a streaming answer arrive; send a test event shaped
  exactly like the official functions shell's; or do the real thing —
  write the document, publish the message, enqueue the task through Cloud
  Tasks, upload the file, sign the user up. Every invocation is kept with
  its request or event, its answer, its timing and **only its own log
  lines**: the worker tags each line with the invocation that printed it,
  which the runtime threw away before. Replay one after a fix, or edit it
  and replay. Schedules show their next run in the zone the scheduler
  evaluates them in and run now through it; the environment shows which
  file set each value, secrets masked until revealed, and sets a missing
  secret or param in the right file, putting the file back if the codebase
  then does not load. Pausing background triggers (the console's one
  switch) says how many events of each service were dropped, counted at
  the sources. Every invocation links to what caused it — the document,
  the object, the user, the message, the task, the event, the sign-up that
  ran a blocking function — and a red badge on Invocations counts failures
  you have not looked at. Nothing polls: everything rides the console's one
  live channel, filtered in the engine, and recording is bounded (2,000
  invocations and 64 MiB, at least 200 of each kind) with budgets on its
  hot paths (`cargo bench -p firenook-functions-runtime --bench monitor`).
  Found and fixed on the way: a worker outlived an engine killed outright
  (SIGKILL, a crash), idling for ever with its codebase loaded; it now
  ends itself within a second of its runtime going away. And the reload
  watcher, given a project path through a symlink (macOS's `/var`) with a
  dot-named directory above it, ignored every change; it now matches the
  canonical spelling too.
- [x] Extensions: each instance with its source and whether it starts
  offline, its configuration and the file each value comes from, the
  functions it adds and the ones the emulator does not deliver, the APIs it
  would call that have no emulator, its roles and lifecycle hooks, the
  events it emits, and its notes rendered safely with their console links
  kept in the console. Reconfigure writes the file that actually set the
  value, keeping its comments, and reloads the instance in place, once —
  and puts the file back if the new values do not load; editing an
  instance's parameter file in an editor reloads it too. A registry
  instance can be vendored into the project from the page. An instance
  dropped for triggers the suite does not emulate now says so.
- [x] Eventarc: every event on every channel with the trigger it reached or
  the filter that kept it out, the type nobody listens for with the one you
  probably meant, publishing a custom event with a preview of who will get
  it, replaying one with a new id, and who publishes what to whom. Events
  that could not be read or matched nothing used to vanish without a trace;
  the last 1,000 are kept.
- [ ] Firebase Alerts through the Eventarc emulator's native channel, as on
  the official emulator, and the thirteen test alerts the official UI
  offered. Waits on recording the oracle (`functions-alerts-v1`); until
  then an alert function loads, is listed as not delivered with that
  reason, and there is no Alerts page.
- [ ] Declared SDK params: resolve defaults into the worker environment the
  way the official emulator does (it writes them to `.env.local`); record
  the oracle first. The console already marks unresolved params and sets a
  value on request.
- [ ] Extension lifecycle tasks (onInstall/onUpdate/onConfigure): the
  recorded oracle drops the task-queue functions they run; running them
  needs a new recording and a deliberate divergence.
- [x] Eventarc publishing from function or extension code through the Admin
  SDK, with no credential of its own: the Admin SDK asks Google's token
  endpoint for an access token before it calls the local emulator, and the
  worker now answers that exchange for the synthetic credential every
  worker holds (a credential the developer configured still goes to
  Google), so `getEventarc().channel().publish()` works offline as it does
  in production.
- [x] Pub/Sub. Topics with their subscriptions and the functions they
  trigger, in a tree that also flags topics written under another project
  id than the emulator's, and publishes the emulator refused because the
  topic does not exist — with the topic you probably meant. The messages a
  topic received stay readable (the engine keeps the newest 5,000 of each
  topic and 16 MiB, or the topic's own retention window up to 100,000),
  filtered by key, id, text or the same filter expression a subscription
  takes, exported as NDJSON or JSON and published again, ticked rows or a
  file at a time. Each message shows, for every subscription and function,
  what became of it: waiting, leased, acknowledged, dead-lettered, filtered
  out, queued for a function, delivered, or failed with the handler's error,
  with the exact request each function received, and a function can be run
  again with one message alone; every run of a topic's functions is one
  link away in Functions › Invocations. A composer publishes JSON, text,
  bytes or Avro with attributes and an ordering key, up to a thousand at a
  time with templated ids, or on an interval that keeps going when the tab
  is closed, and checks data against the topic's schema as it is typed. A
  backlog can be read in the order the next pull takes it, without leasing
  it, its rows acknowledged or returned, and purged; push subscriptions
  show every outcome with its count, dead letters have their own list, and
  filters say where they fail to parse. A whole setup — topics,
  subscriptions, schemas — exports to a file and imports into another run
  or project. Schemas have an editor the engine's parser checks as it is
  typed, each commit a new revision, and the topics that use them. A
  scheduled function's Schedule tab in Functions shows its expression in
  words, its next runs and its runs' outcomes, runs it now, pauses it, and
  the schedule runs in the time zone it declares. Found and
  fixed on the way: every published message and every acknowledged one was
  kept for the life of the process, and the acknowledged ones were visited
  by the 50 ms timer; every pull sorted the whole backlog; dead-lettered
  messages never reached a function on the dead-letter topic, whose
  subscription then grew for ever; cron schedules fired at UTC hours
  whatever zone they declared, and a daily schedule with a zone never fired;
  the Pub/Sub timer outlived the suite.
- [x] Cloud Tasks. Every queue with its configuration in force and where each
  value came from, live counters (pending, held, running, in backoff, slots
  and, while the rate limit holds tasks back, a token bucket that refills
  on screen), every pending and running task with its first and latest
  attempts, the handler's responses and the next retry, with the emulator's
  `maxAttempts` + 1 said where the figure shows, a queue's attempts as they
  happen as its function's invocations in Functions, and the last thousand
  finished tasks with their outcome. Tasks can be enqueued by hand exactly
  as the Admin SDK sends them, run now, stopped, deleted (auto-named ones
  too, which the API cannot), re-enqueued from history; queues pause,
  resume, purge, and can hold scheduled tasks until their time. Refused
  enqueues are listed with where the queue really is, and a queue
  re-registered because its options changed says what it dropped instead
  of losing it silently. The Tasks port is unchanged: these controls are
  the console's. Found and fixed on the way: dispatch responses were never
  read, refused queue registrations left only a log line, and the
  statistics windows grew until someone asked for them.
- [x] Logs: one stream for every service. The engine keeps the latest 20,000
  lines as structured entries beside the official Logging feed, which is
  unchanged, and keeps the last 2,000 errors, failures and denials longer,
  so a flood of output does not erase the error it was caused by. The
  console pages back through them, follows new lines and freezes the moment
  you scroll, filters with the console's one filter language — level,
  service, function, extension instance, codebase, kind, invocation, payload
  field, words, regular expressions, and `-` to exclude any of them — with
  live counts per value and a volume strip to pick a time from, opens any
  line with the lines around it, and downloads exactly what the filter
  shows. Everything a function prints says which call printed it,
  firebase-functions' structured lines arrive as fields, and every call has
  exactly one end line even when nobody reads its response. Notable engine
  events are lines of their own: a refused rules decision with a link to
  why (told apart from the console's own "view as" reads), rules applied
  from the console or reloaded from their file, a rules file that stopped
  compiling, the official Firestore clear, a reset from the console,
  background triggers paused and resumed. Found on the
  way: the official feed writes levels in lower case and Firenook wrote them
  in capitals, and the debug log dropped any line longer than 8 KiB.
- [x] Overview: what runs, where, and whether it is healthy — each section's
  address, its live figures, its current problems, why a section is not
  running and the exact fix, the recent errors, failures and denials over
  the last hour, the code to connect an app on every platform with the host
  it sees, and the engine's own configuration and where its data lives. The
  suite's own warnings — an app writing to another project id,
  background triggers left paused by a test harness — lead the page in the
  same words every page uses; configuration the terminal prints once (a
  project that is not a demo, a public listen address, emulators missing
  while Functions run, diagnostics off) stays until it is dismissed.
- [x] Snapshots and resets from the console, as engine jobs: download the
  emulators' data as a standard export (the zip unpacks into a folder
  `--import` reads), save one on the engine's machine, or reset a section's
  data (Firestore, Authentication, Storage, Pub/Sub, Cloud Tasks) or every
  resettable section at once. One data job runs at a time, shows its
  progress in every tab, survives the tab that started it, and is cancelled
  cleanly before the engine exits. A Firestore reset runs no Functions
  triggers unless asked to — it commits as maintenance, which the trigger
  observer ignores and every listener still sees — and open Firestore pages
  reload once at its start and once at its end.
- [x] Parity checklist against the Google UI (`support/console-parity.md`):
  every feature of the 1.15 bundle with the console screen that covers it,
  every row ticked. The Google UI is gone with it: the engine neither
  verifies nor serves the archive, `firenook setup` downloads nothing (it
  stays, so scripts that run it pass), the UI port's root and the official
  UI's page addresses (`/firestore/…`, `/auth`, `/storage/…`, `/logs?q=…`)
  lead to the console's page for the same thing, and `/api/config`, the
  logging feed and the Requests socket are unchanged. The install fetches
  nothing. Test Firebase Alerts, the one feature of the old UI the console
  lacks, waits on alert delivery (above).
- [ ] A write log, and perhaps an undo with it. Built and then taken out
  again, which is the useful part of the entry: the engine can keep a
  bounded window of commits with the document as it was and as it became,
  and the console can list them, show the leaves that moved under their
  dotted path, and put one back. Nothing else in the field ships this —
  the Firebase console versions Rules and Remote Config but not documents,
  Supabase needs an audit extension you install yourself, and the usual
  answer elsewhere is point-in-time restore, which rolls the whole
  database rather than one write. That is an argument for it, since the
  objections are production's and not an emulator's: storage cost and
  undoing a write something downstream already read.

  Two findings decided against shipping it now. The undo writes through
  the store, so **it fires triggers** — undoing a write a Function made
  runs that Function again, which can re-apply it or loop, and the button
  promises a restoration it cannot keep. And the value is lopsided: the
  log answers "what did my app just do?", which nothing else answers,
  while the undo is the half carrying the hazard and the least worth in a
  database you can re-seed. If it returns: log first, undo behind a
  confirmation that says triggers will fire, and the per-document history
  in the inspector rather than one global list — the question is almost
  always "what happened to *this*?". The removal is one commit, so the
  implementation is readable in the history rather than lost.


## Terminal UI (`0.2.0-next.4`)

The last row of the CLI surface: what a developer sees in the terminal from
`emulators:start`, keeping the `All emulators ready` contract.

- [x] The engine prints terminal events (`--terminal-events`) in place of the
  human lines they stand for; without the switch its output is unchanged
  ([DESIGN.md](DESIGN.md#the-terminal)).
- [x] In a terminal, the npm package draws a start-up card with a row per
  service filling in, the ready summary (console, ports, warnings, a newer
  release), the log with a line per call and its output under it, reloads
  and failed saves with the code around the error, and a footer pinned to
  the window's last line with the keys. Pipes, CI and `emulators:exec` keep
  the plain lines.
- [x] A start that cannot run says what went wrong, how to fix it and what
  became of the data: a taken port names its holder and a free port, refused
  saved data names what changed (a `.DS_Store` from Finder by name).
- [x] The release check: once a day, in the background, shown on the next
  start, off in CI, in the plain output and on request.
- [x] Published as `firenook@0.2.0-next.4` with `@firenook/cli-<platform>` ×5
  on 2026-10-17 (PR #82, release PR #83, tag `npm-v0.2.0-next.4` on 5e4e920,
  engine 8cf0bab, release run 39035262983; registry integrity equal to the
  release assets for all six packages, provenance attestations verified on a
  fresh install). `latest` and `next` both point to 0.2.0-next.4, so a plain
  `npm i firenook` installs it.
- [ ] Acceptance-host lanes for the console and terminal engines: not run
  before publication; the local and CI verification is in the CHANGELOG
  entries of both releases.

## Saved data: the seed record, quick repairs, safe stops (`0.2.0-next.5`)

Saved data (`--state-dir` with `--resume-state`) checked its seed by reading
every byte on every start (26 s for a 7.8 GB seed), and a `.DS_Store` that
Finder wrote refused it. A stop during start-up ended the process where it
stood, which left the store to a full repair at the next start, shown only as
"resuming".

- [x] `native-seed.json`: each seed file's size, times and SHA-256; a start
  compares details and reads only the files whose details changed.
- [x] Files operating systems write (`.DS_Store`, `._*`, `Thumbs.db`,
  `desktop.ini`, `__MACOSX` …) are ignored; the Storage import skips `._*`.
- [x] A first import hashes the seed on worker threads beside the import; the
  receipt keeps the whole-seed fingerprint earlier engines verify.
- [x] Data saved by an earlier engine is checked once in full, with or without
  the operating system's files, then recorded.
- [x] `firenook state:adopt-seed`: keep the data with the seed as it is now;
  the previous receipt is kept.
- [x] A refused seed names the files that changed, on screen and in the log.
- [x] Quick repair on the store's durable commits; a full repair shows its
  progress.
- [x] Stops are listened for from the first moment: a stop while starting
  closes the data cleanly, and the start-up limit counts quiet time only.
  - Found after release (2026-10-18): a stop once the emulators are ready
    leaves the data files marked open, and no test opened the file itself
    after either kind of stop. See "Closing the data on stop" below.
- [x] Published as `firenook@0.2.0-next.5` with `@firenook/cli-<platform>` ×5
  on 2026-10-18 (PR #85, release PR #86, tag `npm-v0.2.0-next.5` on d7764ca,
  engine 18becb0, release run 39050978077 with its SDK browser gate run a
  second time after the Firebase JS SDK build was caught mid-write; registry
  integrity equal to the release assets for all six packages, provenance
  attestations verified on a fresh install).
- [x] Follow-up: built and published in 0.2.0-next.6; see "Data closed on stop, the kept count, the store's size" below.

## Data closed on stop, the kept count, the store's size (`0.2.0-next.6`)

Built in this order, in one go, with the review on the finished candidate:

1. **Closing the data on stop** (below): done.
2. **Start-up speed** (below): the document count is kept, done. Loading
   Functions while the data opens is left out: with the count kept it would
   save tens of milliseconds on a resumed start, and on a first import it
   would fire triggers for imported documents as it stands.
3. **Store size** (below): `firenook state:compact`, clearing the old
   documents table, `state:inspect` and the Overview's size on disk, done.
   Repack and packing better while running follow in a later release.
4. **Releases** (below): publishing straight to `latest` when the release
   owner asks, done, so next.6 itself can use it.

Then one combined candidate, qualified as for earlier releases: CI on the
exact head, the consumer gates and paired acceptance, and publication only
with approval.

- [x] Published as `firenook@0.2.0-next.6` with `@firenook/cli-<platform>` ×5
  on 2026-10-18 (PR #93, release PR #94, tag `npm-v0.2.0-next.6` on 9837199,
  engine 767605d, release run 39121740242 dispatched with `latest`: the CLI
  on `latest` with its `next` left on 0.2.0-next.5, the native packages on
  `next`; registry integrity equal to the release assets for all six
  packages, provenance attestations verified on a fresh install). A
  consumer's integration, Extensions admission and installed-package gates
  passed on the published package, and its two stores were measured on
  copies; the acceptance-host lanes were not run.

## Closing the data on stop (`0.2.0-next.6`)

Found on 2026-10-18. A stop once the emulators are ready makes every commit
durable, reports "stopped cleanly", and ends the process without closing
Firestore's `firenook.redb`; since 0.2.0-next.4 it leaves Storage's
`metadata.redb` open too. redb clears its "repair needed" mark only when its
`Database` is dropped, so the next start repairs the file. No data is lost:
the repair rebuilds redb's record of free space, and every acknowledged
commit is already on disk. The start pays for it: with 0.2.0-next.4 a full
repair of the 32.6 GB store measured below took about 11 minutes, shown only
as "resuming"; the quick repair of 0.2.0-next.5 takes about 10 s on the same
store, with a full repair still possible when the saved allocator state is
stale.

Measured with each release's engine alone (`firenook suite`, no npm CLI):
Firestore, Auth and Storage on a fresh state directory, three writes, a
SIGINT once ready, then the file header read and the file opened with redb:

| Engine | `firestore/firenook.redb` | `storage/metadata.redb` |
| --- | --- | --- |
| 0.2.0-next.2 | closed | closed |
| 0.2.0-next.3 | repair needed | closed |
| 0.2.0-next.4 | repair needed | repair needed |
| 0.2.0-next.5 | repair needed | repair needed |

The stop sequence flushes Firestore but never releases the store, and
Storage's `shutdown()` runs while something else still holds its metadata
database. What keeps them alive is not found yet; the work added with the
console (0.2.0-next.3) and the terminal UI (0.2.0-next.4) is the first place
to look.

- [x] **Close both databases when stopping.** Three things kept them open.
  The console's change feed and schema index were registered as commit
  observers while holding the store, and the Overview's counting held it
  too: the store held its observers, they held the store, and the file
  stayed open (0.2.0-next.3). Storage holds a Firestore handle for its rules,
  so it closes first. And the console's whole-database walks (a schema, the
  Overview's count) run on worker threads that did not watch the stop.
  Built: `Store::close` makes every commit durable, releases the observers,
  raises a flag the walks check every 4,096 documents, waits up to 5 s for
  handles ending their own stop and drops the database;
  `StorageRuntime::close` does the same for the metadata. The observers now
  hold only what they record (the counting a `WeakStore`). A stop once ready
  and a stop while starting drop the parts that hold data handles, close
  Storage, then Firestore; a database still held is a failed stop. Measured
  on a copy of the 4.3 GB store with 16 functions: the stop takes 1.4 s and
  leaves both files closed (0.2.0-next.5: 0.1 s, Firestore left open); with
  three console pages open, 3 s more is the existing grace for requests in
  flight.
- [x] **Test it on the file.** The engine itself, stopped once ready for
  Firestore, Auth and Storage and for Firestore alone, then both files
  opened read-only (`crates/cli/tests/stop_closes_data.rs`); a suite stopped
  while starting, with the console's pieces built; the store and Storage
  closes, a handle still held, and the console test that fails if any of its
  pieces keeps the store open.
- [x] **Say "stopped" only when the engine stopped.** Only an engine that
  finished its stop (or a stop signal before it listened for one, when
  nothing was open yet) is "stopped". A kill shows "Firenook did not finish
  stopping" and that the next start checks the data first and repairs it if
  it needs to; plain mode says the same in one line.

## Start-up speed (`0.2.0-next.6`; loading Functions beside the data left)

After 0.2.0-next.5 a resumed start no longer reads its seed, and what is left
is the data itself and the order the steps run in. Measured on resumed starts
with every service: a 4.3 GB store of 211,000 documents spends about 12 s
opening Firestore, Auth and Storage and 7.5 s loading about 20 functions; a
32.6 GB store of 2.7 million documents spends about 2.5 minutes opening the
data and 7 s on 21 functions.

- [x] **Keep Firestore's document count.** Built for 0.2.0-next.6: every
  commit saves the count and logical bytes beside the revision they
  describe (`document_usage_v1` in the metadata table); an open reads them
  when that revision is the store's, counts once otherwise and saves the
  result, and a journal replay carries them forward write by write. Nothing
  enforces a limit from them; they size the memory accounting and the
  figures. Measured on copies, resumed with Firestore, Auth and Storage: the
  32.6 GB store opened in 146 s with 0.2.0-next.5, 134 s on its first
  0.2.0-next.6 start (the one count) and 67 ms from then on (ready in
  0.35 s); the 4.3 GB store with its 16 functions, 1.4 s and 63 ms (ready
  in 8.6 s and 7.1 s, the rest is Functions). 0.2.0-next.5 opens the data
  as before, and the saved figures stay valid after it opened them.
  The plan as written:
  Every open decodes every document
  to size the memory accounting (entries and logical bytes); on the larger
  store that is the 2.5 minutes. Save the count and size in the store's
  metadata with each durable commit and on a clean close, adjust it during
  journal replay, and read it instead. A store without it, or one just
  repaired, counts once and saves it. Target: an open in seconds.
  - The count itself is quick on a warm cache (211,000 documents in under
    1.5 s); it is slow because it reads the whole file from a cold disk at
    every start. With a saved count that read moves to the first requests,
    and only for what they touch: readiness comes in seconds, and a client
    that reads most of the data right after the start pays part of it
    there. Still a large net gain on big stores.
  - The saved count records the store revision it belongs to. A store
    written meanwhile by an engine that does not keep the count (going back a
    release and forward again), a full repair, or a missing count means one
    recount. Journal replay after a crash adjusts it write by write.
  - A wrong count would only misreport figures (the console Overview's data
    size, the stop summary, memory reports), never the data; confirm before
    building that nothing enforces a limit from it.
  - Not at first: a background recount after readiness to check the saved
    figure. It would compete with the first requests for the disk.
  - Tests as for the seed record: crash and replay, going back a release,
    repair, and a count that does not match its revision.
- [ ] **Load Functions while the data opens.** Not in 0.2.0-next.6. With
  the count kept, opening the data takes tens of milliseconds, so running it
  beside Functions saves at most that much on a resumed start (measured:
  0.2 s of 7.1 s). The gain is on a first import, and that is exactly
  where it is unsafe as it stands: an import commits as client writes, so a
  function registered while the import runs would fire for every imported
  document. It needs delivery held until the data is ready, and ports bound
  first; worth it only if first imports matter enough.
  The plan as written: Loading codebases needs Node
  and the code, not the data, so it can run beside Firestore, Auth and
  Storage instead of after them. Conditions: bind every port first and hold
  data requests until the data is ready (code that queries Firestore while
  it loads must get an answer, not a refused connection); opening or
  importing data fires no triggers; Auth's blocking functions are registered
  before any sign-up is admitted, which readiness already guarantees.
  Pub/Sub's schedules come from the Functions inventory, so they still follow
  it (2 ms). Saves the Functions row (about 7 s with 20 functions).
- [x] **Measure the store's size.** See "Store size" below.

## Store size (`0.2.0-next.6`; repack and packing better left)

Measured on 2026-10-18 on a copy of the 32.6 GB store above, kept in daily
development for weeks after importing a seed that a fresh import stores in
4.3 GB (211,000 documents):

| Part of the file | Size |
| --- | --- |
| Documents' keys and values | 7.5 GB |
| Unused room in the pages holding them | 10.0 GB |
| Free pages kept after deletes and rewrites | 8.6 GB |
| Field index (20 million entries) | 3.5 GB |
| Collection and collection-group indexes | 2.9 GB |

The growth itself is the application's: 2.5 million documents written after
the import, two-thirds of them event records of about 600 bytes. The store
around them is what Firenook can improve. An import writes in key order and
packs pages tightly, 1.47 bytes of file per byte of data; weeks of live
writes, inserted in every order and rewritten while they grow, leave 2.34.
A value larger than a page sits alone in a page of the next power of two
(8 KB up to 512 KB). And the file never shrinks: redb reuses freed pages but
does not return them. The legacy `documents_v1` table was empty, so its
leftover copy (below) played no part here. Repairing the copy took 10 s with
the quick repair of 0.2.0-next.5. The per-table figures are redb's own table
statistics; the per-collection ones come from one pass over the documents.

0.2.0-next.6 takes the compact command, clearing the old table and showing
the size; repack and packing better while running come after it.

- [x] **`firenook state:compact`.** Built for 0.2.0-next.6, with
  `state:inspect` beside it; both refuse while the emulator holds the data.
  It copies the file first (a clone where the file system has one, removed
  once the compaction succeeds; `--no-copy` skips it), opens it through the
  store so a crash's journal replays and the file closes cleanly, then runs
  redb's compaction until it finds nothing more to move. Measured on a copy
  of the 32.6 GB store: 16 minutes, 32.60 GB → 27.79 GB, so 4.82 GB of its
  8.60 GB of free pages back to the disk. The other 3.78 GB stay free inside
  the file once redb finds nothing more to move (why it stops there is not
  measured yet), and the tables are page for page as before. The store then opened in 150 ms with all
  2,703,834 documents. The rest of the space is the repack's. The plan as
  written: With the emulator stopped, redb's
  `Database::compact` moves pages into free space and truncates the file.
  Lossless: each step is an ordinary commit and every document stays as it
  is. An interrupted compaction leaves the next start a full repair (redb
  does not use quick repair for it yet), so take a copy first (a
  copy-on-write clone where the file system has one), print the sizes before
  and after, and refuse while the state is in use. Gains up to the free
  pages (8.6 GB above), not the part-filled ones.
- [ ] **Repack.** Write a new file table by table in key order, as an import
  does; check it against the old one (entry counts and a digest of every key
  and value per table); swap it in; keep the old file until the check
  passes. Gains the free pages and most of the part-filled ones, and the
  count at each open reads less. Estimated 16–17 GB for the store above, to
  be measured. Needs free disk for the new file; perhaps
  `state:compact --repack`.
- [ ] **Pack better while running.** Find what keeps live pages part-filled,
  and whether large values belong out of line or compressed (measure the
  ratio on real documents first). Any change to the stored format keeps the
  rule of 0.2.0-next.5: the previous release still opens the data.
- [x] **Clear the old documents table after its migration.** Built for
  0.2.0-next.6: the migration clears `documents_v1` in the same commit as
  the copy, and an open clears one an earlier engine left behind; tested
  with a store holding both tables. The plan as written:
  `migrate_legacy_documents` copies `documents_v1` into `documents_v2` and
  the scope indexes but leaves `documents_v1` in place, so a store first
  written before that layout keeps a dead copy of every document. Every
  release since 0.1.0-next.3 reads only `documents_v2`, so clearing it costs
  no supported compatibility; compaction then returns the space. Test with a
  store holding both tables.
- [x] **Show the size.** Built for 0.2.0-next.6: `firenook state:inspect
  --state-dir DIR` lists every table (entries, keys and values, pages) and
  the part of the file in no table, for a stopped store, reading it
  read-only unless it is marked for repair. The console Overview's
  Firestore card shows "On disk", the file's size, beside the documents;
  free pages need a walk of the whole file, so they are in `state:inspect`
  only. The plan as written: A `state:inspect` that prints the table above for a
  stopped store, and the file size and free pages on the console Overview
  beside the data size, so growth shows before a start slows down.


## Releases (`0.2.0-next.6`)

- [x] **Publish straight to `latest` when the release owner asks.** Moving
  `latest` was a separate `npm dist-tag add` per package with the owner's 2FA
  in an interactive terminal, since npm's trusted publishing (OIDC) covers
  `npm publish` only and the workflow keeps no stored token. Built for
  0.2.0-next.6: the dispatch input `latest` of `release-npm.yml`, off by
  default. The authorize job's summary tells the `npm-release` approver which
  channel the CLI goes to, and the publish step prints it with the plan, one
  `--tag` per package. With it on, the five native packages go to `next` and
  are verified against the release assets as before, then the CLI is
  published with `--tag latest` (a prerelease too: the tag is explicit) and
  its index must show `latest`. With it off, every npm command and registry
  check is as before. One pure function picks the tag
  (`packaging/release-channel.mjs`); the authentication dry-run uses it too.
  A resume must repeat the choice its recovery receipt records
  (`"latest": true`, left out for `next`), or the authorize job stops before
  approval. Decided about `next`: npm sets one tag per publish and OIDC cannot
  move tags, so a release published to `latest` leaves the CLI's `next` on the
  previous release until it is moved by hand; `packaging/PUBLISHING.md` says
  so, and the release notes of such a release must say so too. Tested with a
  dry run of the publish script for both settings on a constructed artifact
  set (`packaging/release-channel.test.mjs`).

## Coding agents and keeping data without a seed (`0.2.0-next.7`)

Found on 2026-10-20 while reviewing the README. Both items make a promise the
README already makes work without reading the docs first. Built on
2026-10-20 in one go: the engine, the CLI, the MCP server and the console in
parallel branches, merged into one candidate (PR #107).

- [x] Published as `firenook@0.2.0-next.7` with `@firenook/cli-<platform>` ×5
  on 2026-10-21 (PR #107, release PR #108, tag `npm-v0.2.0-next.7` on
  7d4cefe, engine 37fdd03). Release run 39464616341, dispatched with
  `latest`, passed every gate; npm acknowledged all five native uploads, but
  `@firenook/cli-win32-x64` took about 58 minutes to become visible (its
  next.6 upload took 3), past the 20-minute barrier, so the publisher stopped
  before the CLI. Recovery receipt PR #109 and resume run 39478322080 then
  published the CLI to `latest` from the original bytes, with no rebuild:
  the CLI's `next` stays on 0.2.0-next.6, the native packages are on `next`,
  registry integrity equals the release assets for all six packages, and
  provenance attestations verify on a fresh install. A consumer's Extensions,
  installed-package and integration gates passed on the candidate built from
  the PR head.

- [x] **Keep data in a project that has no seed.** Keeping data between runs
  needed `--state-dir` and `--resume-state`, and `--resume-state` refused to
  start without `--import`, while a nonempty state directory refuses to start
  without `--resume-state`. A project made with `firenook init` has no seed,
  so it could not keep its data at all. Built: the launcher and the engine
  accept `--resume-state` without `--import`. The receipt keeps its format
  (format 2, the same fields, unknown fields still rejected): a seedless state
  records an empty seed path and fingerprint, writes no seed record, and is
  complete once its stores exist. Three refusals name the way on: a seedless
  state started with `--import` ("start without --import to keep using it"),
  a seeded state started without it ("pass --import <seed>"), and saved data
  started without `--resume-state`; `state:adopt-seed` refuses a seedless
  state. 0.2.0-next.6 reads a seedless receipt and refuses it with
  "--resume-state requires --import as seed identity" (no `--import`) or "it
  was imported from , not <seed>" (with one), every state file byte for byte
  unchanged. The terminal's refusal card gives each case its own fix line.
  Tests: the first start, a resume, every refusal, an unfinished first start,
  the receipt read back through the unchanged struct, export destinations,
  and 0.2.0-next.6 on a seedless state.
- [x] **`--keep-data`**, short for `--state-dir ./.firenook/state
  --resume-state` (with the seed when `--import` is given); `--state-dir`
  names another directory. Keeping data stays opt-in for `emulators:start`:
  someone switching from the official emulator expects `--import ./data` to
  start from that data every time, and `emulators:exec` stays fresh for
  tests.
- [x] **`init` uses it.** The start command `init` prints for a new project
  carries `--keep-data`, and the README's "Your data stays", its switching
  steps, getting started, the data guide and the CLI reference show
  `--keep-data`.
- [x] **Set up a coding agent in one command: `firenook mcp add`.** It finds
  the agents a project uses (Claude Code: `.claude/`, `CLAUDE.md`, an existing
  `.mcp.json` or `claude` on the PATH; Cursor: `.cursor/` or `.cursorrules`;
  VS Code: `.vscode/`) and writes each one's project file: `.mcp.json`,
  `.cursor/mcp.json`, `.vscode/mcp.json` (under `servers`, with
  `type: stdio`). The entry is `npx firenook mcp` with no project id (plus
  `--config` when `firebase.json` is in another folder), so the file can be
  committed. Other servers in the files are kept, a second run changes
  nothing, another `firenook` entry is replaced only with `--force`, and a
  file that is not plain JSON (comments) is left alone with the snippet
  printed. It takes `--dry-run`, `--agent` and `--json`. Codex and Windsurf,
  configured only in the home folder, get the line printed, never a file
  edited outside the project.
- [x] **`init` offers it.** In a terminal, a new project's `init` asks once,
  naming the agents found; Enter or `y` writes the files, `n`, Ctrl-C or
  Ctrl-D prints the command instead. Without a terminal, with `--json` or
  `--non-interactive`, it prints `firenook mcp add` as a next step. `init
  --adopt` lists it in its plan as one more addition and applies it with the
  rest. Both run the same code as `mcp add`.
- [x] **`firenook mcp` with no arguments finds the running suite.** With no
  `firebase.json` in its folder and no `--project`, the server uses the one
  suite whose `hub-<project>.json` locator answers with the process id the
  locator records, and asks for `--project` when two do. It looks again on
  every call (the locator folder's scan is cached until the folder changes),
  so a suite started after the agent is found without a restart.
- [x] **A "Coding agent" tab in the console's Connect dialog.** Built: an
  Agents group with one tab: the `npx firenook mcp add` command, then Claude
  Code (the project and user commands, `.mcp.json`), Cursor ("Add to
  Cursor", `.cursor/mcp.json`), VS Code ("Add to VS Code", "Add to VS Code
  Insiders", `.vscode/mcp.json`) and any other agent's `mcpServers` entry. A
  checkbox adds `--project <id>` to the user-level items when more than one
  emulator runs on the machine; project files never carry it. The console
  writes no project files. The server now marks its requests
  (`x-firenook-client: firenook-mcp/<version>`) and posts each call to
  `POST /console/api/v1/agents/calls`, held in memory; the tab reads `GET
  /console/api/v1/agents` when it opens and shows "Last call 2 min ago:
  firestore_query (firenook-mcp/0.2.0-next.7)".
- [x] **The terminal's `?` help names `firenook mcp add`.**

**The MCP server's coverage.** `firenook mcp` had 19 tools: status, export,
Firestore get/query/set/delete/list collections, Auth users and pending codes,
Storage listing and metadata, Functions list and invoke, a Pub/Sub publish and
Cloud Tasks queue stats. Built: 54 tools, the new ones over the console's API
(`/console/api/v1`, which the suite serves on the UI port; a suite started
without the UI answers them with an error that says so), in twelve `--only`
groups: firestore, auth, storage, functions, logs, rules, pubsub, tasks,
schedules, eventarc, extensions, reset. Every tool ran against a running
0.2.0-next.6 suite, and `docs/mcp.md` lists them.

- [x] **Logs and function calls.** `logs_search` (service, level, function,
  call, text, time), `logs_facets`, `functions_list_calls` (trigger, outcome,
  status, duration, error), `functions_get_call` (cause, request and
  response, event, the error with its stack, the call's log, timings) and
  `functions_replay_call`.
- [x] **Security Rules.** `rules_get` (Firestore and Storage rules in force,
  with problems), `rules_evaluate` (a request as a uid with claims, an ID
  token or no one, against the rules in force or a draft: the verdict, the
  deciding line and each expression's value) and `rules_list_denials`
  (recent denials from the log, with the denying lines on request). No route
  lists rule decisions yet, so denials come from the `rules.denied` log
  lines, which diagnostics write.
- [x] **More of Auth.** `auth_mint_token` (an ID token and refresh token for a
  user), `auth_set_claims`, `auth_remove_claims`, `auth_disable_user`,
  `auth_enable_user`, `auth_revoke_tokens` and `auth_list_tenants`.
- [x] **Reset.** `emulators_clear` over `/suite/clear`; clearing two or more
  services needs `confirmProject` set to the project id, as the console asks,
  and the refusal names the value.
- [x] **Storage files.** `storage_read` (text inline, binary as base64, with
  a size cap and a `truncated` flag), `storage_upload`, `storage_delete` (an
  object or a folder), `storage_copy` and `storage_move`.
- [x] **The rest.** Eventarc publish, list, get and replay; Extensions list
  and reload; Pub/Sub topics, subscriptions and a backlog peek that leases
  nothing; Cloud Tasks list and run; schedules list and run; Firestore
  `firestore_count` and collection-group queries.

Each tool has a test against the fake suite in
`packaging/cli-commands.test.mjs`, and `docs/mcp.md` lists every tool.

**Fixes the README demo and the next.6 benchmark found** (recorded in
`benchmarks/next6-paired-acceptance.json` `followUps`):

- [x] **Timestamps finer than a microsecond.** Firestore accepted them, then
  the export refused them ("export timestamps must have microsecond
  precision"). Built: every commit stores timestamps rounded down to the
  microsecond (fields, values in maps and arrays, transform operands), the
  REST and gRPC decoders round before rules run, and the export rounds down a
  finer value an earlier engine saved. The official emulator's answer was
  already in the frozen `developer-tools-request-values-v1` fixture (a PATCH
  of `…05.123456789Z` answered `…05.123456Z`); a REST test now replays it.
- [x] **Functions discovery took about 6 s.** Found: the SDK's discovery
  server answered in about 0.2 s, then the engine waited for it to exit. Its
  `/__/quitquitquit` closes the server, which waits for open connections, and
  the engine's client kept its connection open for reuse, so Node waited out
  its 5 s keep-alive. Built: the discovery client keeps no idle connection;
  the timeout, the kill after 10 s and every message are unchanged.
  Discovery of a seven-function codebase went from 6.2 s to 0.2 s, and on
  the acceptance host the whole suite with that codebase is ready in 0.78 s
  against 6.82 s (`benchmarks/next7-regression.json`). A test holds idle
  connections for 30 s and fails at 10 s without the fix.
- [x] **The Functions log line's duration** printed floating-point noise
  (`1.6076249999999999ms`). Built: the line keeps the official `in Nms`
  shape, with one decimal under 10 ms and whole milliseconds above, as the
  console does, and its `durationMs` detail carries the same duration to
  the microsecond.
- [x] **The console's document panel crashed** with a TypeError when `doc=`
  in the URL held a bare id rather than a full path (`x` instead of
  `orders/x`). Built: a bare id is read against the open collection, and a
  path that names no document opens the panel on "Document not found"
  without asking the engine.

**Checked against 0.2.0-next.6** on the acceptance host with the private
consumer seed instead of a new paired run, since no measured path changed
(`docs/benchmarks.md`, `benchmarks/next7-regression.json`): imports, resumed
starts, writes, listener delivery and 20 of 26 query shapes within run-to-run
noise; memory 11 MB higher once ready. It also explained the last open
follow-up of the next.6 benchmark: a start on a freshly copied state
directory is slow only until the copy's pending writes reach the disk
(`sync` before the start: 0.56–0.66 s on both releases), so nothing in
Firenook needs fixing. Ordered and range field indexes, the six slower query
shapes, remain for a later release.

## The Firestore tree at once, and code in colour (`0.2.0-next.8`)

Found on 2026-10-21 on a store of 2.7 million documents (26 GB): the
console's Firestore tree said "Mapping the database…" for about three and a
half minutes after each start, while the grid beside it already listed the
root collections. And the console's code (the Connect dialog's snippets, a
document as code, a request as code) was plain grey text, with Flutter,
Swift, Kotlin and Java snippets marked as JavaScript. Built on 2026-10-21.

- [ ] **The tree's first walk reads the collection index, not the
  documents.** The tree comes from the schema index, built by one walk of a
  database's document keys the first time a console asks. Walking the keys
  of the documents table still reads every page of every body, which sits
  beside its key: 17.5 GB of pages on that store. `Snapshot::document_keys`
  lists a database's keys from the collection index instead, one short
  entry per document (1.4 GB of pages there), with the snapshot's overlay
  merged; counting does not need path order. The walk took 37 s instead of
  133 s on clones of that store, and 39.5 s through the console. A test
  checks it lists the key cursor's keys, flushed or not, on both backends.
- [ ] **A clean stop saves the tree with the data.** The index is saved as a
  note of the store (`Store::save_note`, a `metadata_v1` entry with the
  revision it describes) once the services have stopped, and only when no
  document changed since the newest commit the index was told of; the next
  start loads it when the store opens at that revision. A commit since, a
  crash, or a stop that did not save means a walk on first use, as before.
  On that store: the restart was ready in 0.6 s and the tree answered in
  0.9 ms, identical to the walked one; a write before a clean stop was in the
  next start's tree; a write followed by `kill -9` left the older note
  unread, and the walk counted the write. The stop with the save took 0.2 s.
- [ ] **The tree shows the root collections while it waits.** The roots come
  from `ListCollectionIds` (17 ms on that store), each with its own count,
  drawn like the tree's roots and opening their collection on a click, with
  "Finding subcollections…" held at the panel's foot, so no row moves when
  the tree arrives.
- [ ] **Code in colour wherever the console shows it.** Every code block is
  coloured with the editor's own palette (`code-editor/ink.ts`), keywords
  and keys in the key hue, strings in the string hue, numbers and types in
  the literal hue, comments and punctuation receding. A block now has to say
  its language, so the type checker finds any that does not; the Connect
  dialog's tabs say theirs (Flutter Dart, Apple Swift, Android Kotlin, Java,
  Python, Go, JavaScript, shell, JSON, and the environment variables as
  `.env` lines: name, value, comment). Comments take the console's secondary
  grey in the editor too; the inactive grey read at about 1.5:1 in the light
  theme. A word after a dot is a member in every language (Dart's `.set(`
  is no keyword, and Go's mode no longer calls a dot a number). Each
  language's parser loads the
  first time a block in it is shown (0.8 to 7.7 KB gzipped each; the
  JavaScript and JSON grammars are the editor's), so no route's first load
  grows, and both bundle budgets hold.
