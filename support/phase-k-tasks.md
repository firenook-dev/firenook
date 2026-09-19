# Phase K — Cloud Tasks emulator (`0.1.0-next.9`, with Phases L and M)

Written 2026-09-19 against `main` 2c1ceb3 (published engine 03000f0,
`0.1.0-next.8`). It ships with [Phase L](phase-l-configuration.md)
(configuration shapes) and [Phase M](phase-m-cli.md) (CLI surface) as
`0.1.0-next.9`, the release that closes every non-UI row of the tracker.

## Status

See the checklist in [ROADMAP.md](../ROADMAP.md#phase-k--cloud-tasks-emulator-010-next9-with-phases-l-and-m)
and the receipts in `benchmarks/phase-k-tasks.json`.

## Goal

Replace the registration-only stub on the Tasks port with a Cloud Tasks
emulator that answers like the official one: the four routes of
firebase-tools 15.22.0's `TasksEmulator` (queue registration, enqueue,
delete, `/queueStats`), queues registered for every `onTaskDispatched`
export with the function's URL as the default target, and the dispatcher of
`taskQueue.js` — token bucket per queue, dispatch slots, the `X-CloudTasks-*`
headers, the retry ladder with its backoff formula, the execution-count rule,
the dispatch deadline — so that `getFunctions().taskQueue().enqueue()` from a
function or an app with `CLOUD_TASKS_EMULATOR_HOST` set reaches the handler
exactly as it does on the official suite.

Same discipline as Phases G–J: the official emulator is recorded first, the
corpus is frozen, the implementation replays it, and every difference is
either fixed or named.

Out of scope, because the official emulator does not do them either:
`scheduleTime` as a delay, OIDC tokens on dispatch, queue pause/resume/purge,
task listing, the Cloud Tasks v2 API surface, persistence, an Emulator UI
tab.

## State before the phase (verified 2026-09-19)

`crates/suite-runtime/src/auxiliary.rs` serves one route on the Tasks port,
`POST /projects/{p}/locations/{l}/queues/{q}`, which validates the queue id
with the official regex, fills in the official defaults, rejects
`maxConcurrentDispatches > 5000` and answers `{"taskQueueConfig": …}` —
then discards the configuration. Every other path answers 501
`UNIMPLEMENTED`. Nothing in Fireside's Functions runtime registers a queue,
so even that route is never exercised in a real run. Manifest parsing of
`taskQueueTrigger` is complete (`functions-runtime/src/manifest.rs`) and the
function is reachable over HTTP at the URL the dispatcher needs;
`CLOUD_TASKS_EMULATOR_HOST` is already exported to every worker.

The official emulator is `lib/emulator/tasksEmulator.js` (Express, four
routes) and `lib/emulator/taskQueue.js` (the controller, the queue and the
dispatcher) inside firebase-tools 15.22.0; both files' digests are pinned in
the gate. The Functions emulator registers a queue for every
`taskQueueTrigger` it discovers (`addTaskQueueTrigger`, queue id = the bare
function name, location = the region, `defaultUri` = the function URL); the
Admin SDK (firebase-admin 13.10.0) posts `{task}` to
`http://$CLOUD_TASKS_EMULATOR_HOST/projects/{p}/locations/{l}/queues/{fn}/tasks`
with the literal bearer token `owner`, an empty `httpRequest.url` (the queue's
default applies), the emulated service account, a base64 `{data}` body, and
optional `name`, `scheduleTime`, `dispatchDeadline` and headers; `delete`
swallows 404.

## Oracles and precedence (frozen before implementation)

Recorded in `benchmarks/phase-k-tasks.json`, `frozen: true`:

1. **firebase-tools 15.22.0 `TasksEmulator`** with its Functions emulator and
   the Admin SDK task-queue client, driven by the Phase H harness on the
   synthetic project with a task-queue codebase. This oracle owns routes,
   status codes, bodies, the dispatch headers, the retry/backoff/deadline
   behaviour, queue registration and the Admin SDK wire shape.
2. Cloud Tasks API reference, for naming only.

Classification rule: the official emulator wins; a divergence is allowed
only for a documented emulator defect (a corrupting or nondeterministic
path) where a safe behaviour is followed instead, named in the fixture
README and asserted in the replay.

## Work packages

### K0 — Freeze the gate (½ day)

`benchmarks/phase-k-tasks.json`: toolchain pins (Rust, Node, firebase-tools
15.22.0 and the two source digests, firebase-functions 7.2.5, firebase-admin
13.10.0), the route and dispatch inventory, the out-of-scope list, the named
checks and the acceptance identities K5 fills in.

### K1 — Oracle corpus (1 day)

`conformance/fixtures/tasks-v1/` recorded by the Phase H harness with a new
`tasks` profile: the primary codebase replaced by `onTaskDispatched`
handlers with distinct retry and rate configurations (default; `maxAttempts
3` with short backoffs; `maxAttempts 1` for the deadline case;
`maxConcurrentDispatches 1`; `maxDispatchesPerSecond 1`; a second region)
plus HTTP handlers that enqueue and delete through the Admin SDK. The runner
gains a `tasks` origin for `http` actions and `{{origin:<name>}}` templates
in bodies; capture and replay take `--output` / `--fixture` so the profile
lives in its own fixture set. Six programs / 62 steps / 39 handler
observations: registration (defaults, explicit, nulls, empty body,
over-limit, invalid ids, foreign project, replacement, unrouted paths),
enqueue and dispatch (named, auto-named, duplicate, unknown queue,
`scheduleTime`, caller headers, explicit URL, second region, wrong region,
unreachable target), the retry ladder (500 vs 400, exhaustion, previous
response), deadline and limits, delete (pending, unknown, dispatched,
repeated, name reuse), the Admin SDK path.

Exit: fixtures committed with checksums and README; the integrity test
(`npm run test:tasks-fixtures`) green in CI.

### K2 — Engine (3–4 days)

New crate `crates/tasks-front` modelled on `pubsub-front`: the queue
registry keyed `queue:{project}-{location}-{queue}`, the four routes with the
Express-shaped answers (JSON `{"error"}` on registration, plain-text 404/409
on enqueue and delete, the HTML 404 page elsewhere), the dispatcher (token
bucket with the one-second refill and the empty start, slot array, the
header set and caller-override order, `dispatchDeadline` abort, the retry
ladder with the `maxAttempts` off-by-one, execution count on non-5xx only),
`/queueStats` with the official window arithmetic and the
`runningTasks = maxConcurrentDispatches` quirk, and discovery from the
Functions inventory (`FunctionDefinition.task_queue_trigger` added to the
bridge) at readiness and after every reload. The suite mounts it on the Tasks
port in place of the stub; the registration route stays available to
callers.

### K3 — Replay (½ day)

`npm run replay:functions:runtime -- --profiles tasks --fixture
fixtures/tasks-v1/emulator-programs.json` against the suite: parity or a
named divergence on every step; the Phase H corpus replays unchanged; CI
runs both.

### K5 — Qualification and release (shared with L and M)

Exact-candidate CI, consumer gates, release `0.1.0-next.9`, docs.

## Risks

- Timing: the retry, deadline and rate programs replay against the real
  clock. The corpus records counts and header values, never durations, and
  the harness waits for the expected observation count with generous
  timeouts.
- The official queue corrupts its linked list when a task that already left
  the pending queue is deleted while others are pending. The corpus pins the
  observable part (200, `numberOfTasks: -1`, 404 on repeat, 409 on reuse);
  Fireside reproduces that without the corruption, recorded as a decision in
  the gate.
