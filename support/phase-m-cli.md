# Phase M — CLI surface (`0.1.0-next.9`, with Phases K and L)

Written 2026-09-19 against `main` 2c1ceb3 (published engine 03000f0,
`0.1.0-next.8`). It ships with [Phase K](phase-k-tasks.md) (Cloud Tasks)
and [Phase L](phase-l-configuration.md) (configuration shapes) as
`0.1.0-next.9`.

## Status (2026-09-19)

Published as `0.1.0-next.9` on 2026-09-19 (release run 35440801335, `next` → next.9,
`latest` untouched) after exact-candidate CI on 7fb0c35, the consumer gates
and the nine browser journeys on the local candidate; see the checklist in [ROADMAP.md](../ROADMAP.md#phase-m--cli-surface-010-next9-with-phases-k-and-l)
and the receipts in `benchmarks/phase-m-cli.json`.

## Goal

Close every command row of the tracker except the terminal launch
experience (Phase N with the own Emulator UI): `emulators:export` on a
running suite, `init` with an adoption mode for existing projects, `use`
and `target:apply` / `target:clear`, `firestore:delete`, background-event
invocation for `functions:invoke`, a local MCP server, `--debug` log files,
and the compatibility flags a `firebase emulators:*` script in the wild
uses. Each command is judged against the official one and then shaped for
Fireside's model: no login, no cloud project lookup, no second Functions
runtime.

## Decisions per command (from the official source, firebase-tools 15.22.0)

| Command | Official behaviour | Fireside |
| --- | --- | --- |
| `emulators:export <path>` | Reads the hub locator, checks the hub, refuses a non-empty destination without `--force` unless it is an earlier export, posts `/_admin/export`; the hub writes and moves the export | Same client, no login; the hub side already existed |
| `init` | Interactive; per-feature auth that is skipped for `demo-*`; downloads rules for real projects | Non-interactive scaffold of exactly the shape Fireside accepts (official rules and index templates, a JavaScript codebase without `npm install`), plus `--adopt` that diagnoses an existing `firebase.json` and adds what is missing |
| `use` | Requires login and calls the projects API | Pure `.firebaserc` edits; no network |
| `target:apply` / `target:clear` | Pure `.firebaserc` edits (`lib/rc.js`) | Same; `storage` only (`database` and `hosting` are not emulated) |
| `firestore:delete` | REST `runQuery` + `commit` batches; `requirePermissions` forces a login even against the emulator | One call to the whole-database clear route (`--all-collections`) or to the new path-scoped route (`mode=recursive|shallow`); no login; `--force` required for recursive and whole-database deletes |
| `functions:shell` | Starts a second private Functions emulator and opens a REPL | Not provided: Fireside never runs a second Functions runtime; `functions:invoke` gains `--event-data` to deliver a background event to the running suite |
| `mcp` | 7,700 lines, mostly cloud management; four tools reach the emulator through the hub locator | A dependency-free stdio MCP server with the emulator-facing tools only |
| `--debug` | `firebase-debug.log` in the cwd, deleted on a successful exit; per-emulator `<name>-debug.log` files | One file per run in `.fireside/runs/session-*/fireside-debug.log`, never deleted, every record labelled with its emulator |
| `emulators:exec "<script>"` | One shell string | Accepted and run through the platform shell with a note; the `--` argv form stays the no-shell path |
| `-P`, `-c`, `--non-interactive`, `--json`, `--log-verbosity`, `--ui`, `--force` | Accepted | Accepted (`--log-verbosity DEBUG` equals `--debug`; the others are documented no-ops or apply where they make sense) |

## Work packages

- **M1 — wrapper commands**: `emulators:export`, `use`, `target:*`,
  `firestore:delete`, `init` / `init --adopt`, `--debug`, the compatibility
  flags, the exec shell-string form; unit tests with fake binaries and fake
  HTTP servers in `packaging/cli.test.mjs`.
- **M2 — engine support**: the path-scoped delete route on the Firestore
  port; `--debug-log` on the suite (Phase L2).
- **M3 — `functions:invoke --event-data`**: builds the official
  CloudEvent / legacy envelopes for Firestore, Storage, Auth, Pub/Sub,
  schedule and custom events and posts them to the running suite's trigger
  route.
- **M4 — `mcp`**: stdio JSON-RPC server (`initialize`, `tools/list`,
  `tools/call`, `ping`) with emulator status, Firestore get/query/set/delete,
  Auth users and out-of-band codes, Storage listing and metadata, Functions
  list/invoke, Pub/Sub publish, task queue stats and export.
- **M5 — Qualification and release** (shared with K and L).
