# Cloud Tasks oracle corpus (Phase K1)

Programs recorded against the official Firebase Cloud Tasks emulator
(firebase-tools 15.22.0 `lib/emulator/tasksEmulator.js` + `taskQueue.js`,
started by the official suite with the Functions emulator, the Java Firestore
emulator, Auth, Storage, Pub/Sub, Eventarc and Extensions) on the synthetic
Phase H project with its primary codebase replaced by task-queue handlers
(`tasksSource()` in `conformance/src/functions-runtime/plan.ts`). Every
program step is an HTTP request to the Tasks port or the Functions port, and
every `onTaskDispatched` handler appends what its request carried (the parsed
`queueName`, `id`, `retryCount`, `executionCount`, `scheduledTime`,
`previousResponse`, the `X-CloudTasks-*` and caller headers, the data) to the
observation file the runner reads back. Everything is synthetic: no
credentials, no real data.

| File | Contents |
| --- | --- |
| `emulator-programs.json` | 1 profile (`tasks`) / 6 programs / 61 steps / 39 handler observations |
| `SHA256SUMS` | digests frozen in `benchmarks/phase-k-tasks.json` (`capture.frozenFixtureSha256`) |

Re-record with `npm run capture:functions:runtime -- tasks --output=fixtures/tasks-v1/emulator-programs.json`
(the same environment as the Phase H capture: `FIREBASE_TOOLS_15_22_ROOT`,
`FIREBASE_FUNCTIONS_7_2_ROOT` with its sibling `firebase-admin`, `NODE24`,
Java and the cached emulator jars; about three minutes). Replay against
Fireside with `npm run replay:functions:runtime -- --binary <fireside>
--profiles tasks --fixture fixtures/tasks-v1/emulator-programs.json`.

## Programs

| Program | Category | Steps | Covers |
| --- | --- | --- | --- |
| `tasks-discovery-and-registration` | tasks-registration | 17 | `/backends` with every `taskQueueTrigger`, `/queueStats` before and after, queue registration with defaults, explicit values, nulls, an empty body, `maxConcurrentDispatches > 5000`, three invalid ids, a foreign project, re-registration, and the three unrouted paths |
| `tasks-enqueue-and-dispatch` | tasks-dispatch | 11 | a named task, an auto-named task, a duplicate name (409), an unknown queue (404), `scheduleTime`, caller headers overriding `X-CloudTasks-QueueName`, an explicit `httpRequest.url`, a second region, the wrong region, a queue whose default URL is unreachable |
| `tasks-retry-ladder` | tasks-dispatch | 5 | a 500 then success (execution count unchanged), a 400 then success (execution count incremented), `maxAttempts: 3` exhausted (four runs), two failures then success, the previous response header |
| `tasks-deadline-and-limits` | tasks-dispatch | 6 | `dispatchDeadline: "1s"` against a 2.5 s handler (aborted, retried once, then failed), `maxConcurrentDispatches: 1` serialising three tasks, `maxDispatchesPerSecond: 1` pacing three tasks enqueued together |
| `tasks-delete` | tasks-delete | 9 | deleting on an unknown queue, an unknown task, a task that already left the queue (200, and the queue count goes negative), the same task again (404), reusing a deleted name (409) |
| `tasks-admin-sdk` | tasks-admin-sdk | 13 | `getFunctions().taskQueue().enqueue()` with `CLOUD_TASKS_EMULATOR_HOST`: plain, with `id`/`scheduleDelaySeconds`/`dispatchDeadlineSeconds`/`headers`, a duplicate id (`functions/task-already-exists`), a `uri`, an unknown queue, an explicit region; `delete()` of a pending task, an unknown task (swallowed), an unknown queue (swallowed) |

## What the recording shows

- The whole surface is four routes: `POST /projects/{p}/locations/{l}/queues/{q}`
  (registration, called by the Functions emulator for every
  `onTaskDispatched` export with the function's URL as `defaultUri`),
  `POST …/queues/{q}/tasks`, `DELETE …/queues/{q}/tasks/{id}` and
  `GET /queueStats`. Every other path is Express' HTML 404.
- Queue keys are `queue:{project}-{location}-{queue}`; the queue id is the
  bare function name, the location its region. Any project id registers.
- The queue id check is the code's `^[A-Za-z0-9-]+$` / ≤ 100 characters, while
  the 400 message describes a different rule (letters, numbers, hyphens,
  underscores, 62 characters); the message is reproduced verbatim.
- Enqueue decodes the base64 `httpRequest.body` in place and echoes the task;
  an auto-generated name carries a leading slash
  (`/projects/…/tasks/<random>`), so such a task can never be deleted through
  the name the delete route reconstructs (no leading slash).
- Errors on enqueue and delete are plain text (`Tried to queue a task from a
  non-existent queue`, `A task with the same name already exists`, `Tried to
  remove a task from a non-existent queue`, `Tried to remove a task that
  doesn't exist`); registration errors are `{"error": "<text>"}`.
- Dispatch headers: `Content-Type`, `X-CloudTasks-QueueName` (the internal
  key), `X-CloudTasks-TaskName` (last name segment),
  `X-CloudTasks-TaskRetryCount`, `X-CloudTasks-TaskExecutionCount`,
  `X-CloudTasks-TaskETA` (`scheduleTime` as sent, otherwise the current epoch
  milliseconds), then the caller's `httpRequest.headers` (they override),
  then `X-CloudTasks-TaskPreviousResponse` from the second attempt on. No
  `Authorization` header is sent; the SDK skips OIDC verification under the
  emulator.
- `scheduleTime` never delays a dispatch. A non-2xx answer schedules a retry;
  only non-5xx answers increment the execution count. `maxAttempts: 3` runs
  the task four times (the stop check precedes the attempt increment).
  Backoff is `min(maxBackoffSeconds, minBackoffSeconds × (2^min(attempt-1,
  maxDoublings) + max(0, attempt - maxDoublings - 1) × 2^maxDoublings))`.
- `dispatchDeadline` (`"<n>s"`, default 60 s) aborts the emulator's request;
  the handler keeps running and the task is retried like any failure.
- Deleting a task that already left the pending queue succeeds (the node map
  is never cleaned on dequeue) and the queue's `numberOfTasks` becomes -1;
  a second delete answers 404; the name stays reserved (409 on reuse) for
  the process lifetime.
- `/queueStats` reports `runningTasks` as the dispatch-slot count
  (`maxConcurrentDispatches`), `tasksAdded`/`failedTasks` as five-minute
  counts divided by five and `completedLastMin` as a one-minute count; the
  replay treats those three windows as volatile.
- The controller polls idle queues once a second and active queues
  continuously, so a task enqueued on an idle emulator waits up to a second
  before its first dispatch; the programs enqueue rate-limited tasks
  together and wait before deleting a dispatched task so that the recorded
  outcome does not depend on the poll phase.

## Normalization

The Phase H runner's normalization applies: origins and hosts become
`{{origin:<name>}}` / `{{host:<name>}}`, project and temporary directories
become placeholders, auto-generated task ids in names and in
`X-CloudTasks-TaskName` (`{{id}}`), `X-CloudTasks-TaskETA` and
`scheduledTime` (`{{time}}`), epoch values under time keys (`{{number}}`),
pids and elapsed times. The replay additionally ignores the
dispatch-deadline program's per-worker `attempt` and `concurrent` values
(the official worker is restarted after the aborted request; Fireside keeps
its worker), the three `/queueStats` windows, and the matched-line count of
the final log step.

## Divergences

None: the replay matches every step without an asserted divergence
(`conformance/src/functions-runtime/replay-fireside.ts` lists only the
ignored per-worker and window values above).
