# Model Context Protocol

[Docs](README.md) · Model Context Protocol

Give a coding agent the running local suite: `firenook mcp` serves Firestore, Auth, Storage, Functions and their calls, the log, Security Rules, Pub/Sub, Cloud Tasks, schedules, Eventarc and Extensions as MCP tools.

```sh
firenook mcp                          # stdio server for the running suite
firenook mcp --only firestore,auth    # a subset of the tool groups
```

## Connect your agent

From the project folder, with Firenook installed in the project:

```sh
npx firenook mcp add             # writes the files below for the agents it finds
npx firenook mcp add --dry-run   # shows what it would write
npx firenook mcp add --agent cursor,vscode
```

It looks for Claude Code (a `.claude/` folder, `CLAUDE.md`, an existing
`.mcp.json` or `claude` on the PATH), Cursor (`.cursor/`) and VS Code
(`.vscode/`), and writes each one's project file with the entry
`npx firenook mcp`. Other servers in those files are kept, a second run
changes nothing, and another `firenook` entry is replaced only with `--force`.
Commit the files so your team's agents have the server too, and restart the
agent to load it. `firenook init` offers the same for a new project, and
`init --adopt` lists it with its other additions. An agent configured only in
the home folder gets the line to add (Codex: `codex mcp add firenook -- npx
firenook mcp`); no file outside the project is edited. The console's Connect
dialog has the same snippets, with install links for Cursor and VS Code, on
its Coding agent tab.

The server reads `firebase.json` and `.firebaserc` from the folder the agent
starts it in, so it needs no project id. Start the emulators as usual
(`npx firenook emulators:start`); every tool finds them on each call.

By hand instead, Claude Code, from the project folder (this writes
`.mcp.json`):

```sh
claude mcp add --scope project firenook -- npx firenook mcp
```

Agents that read an `mcpServers` file, such as Cursor's `.cursor/mcp.json`:

```json
{"mcpServers": {"firenook": {"command": "npx", "args": ["firenook", "mcp"]}}}
```

VS Code's `.vscode/mcp.json` names the same entry under `servers`:

```json
{"servers": {"firenook": {"type": "stdio", "command": "npx", "args": ["firenook", "mcp"]}}}
```

### Outside a project folder

An agent that starts servers from its own settings, with no project folder,
needs nothing more: with no `firebase.json` in its folder and no `--project`,
`firenook mcp` uses the one suite on this machine whose hub locator
(`hub-<project>.json` in the temporary directory) answers. It looks again on
every call, so a suite started after the agent is found without restarting
the server. When two suites answer, the tools name both and ask you to start
the server with `--project <id>`; when none does, they say to start one with
`firenook emulators:start`. A locator whose hub no longer answers, or whose
port another suite took, is ignored.

`--project <id>` (and `--config /path/to/firebase.json`) still choose the
project explicitly. The server's first line on stderr, and the
`firenook_status` tool, say how the project was found.

## What it serves

`firenook mcp` is a dependency-free MCP server over stdio (newline-delimited
JSON-RPC 2.0; protocol `2025-06-18`, and `2025-03-26`/`2024-11-05` clients are
accepted) that gives a coding agent the running local suite: `initialize`,
`ping`, `tools/list` and `tools/call`, capabilities `{"tools": {}}`.

Every tool resolves the suite through the hub locator on each call (falling
back to the project's configured ports), so a suite restarted on other ports
is found, and returns a clear error while nothing runs. Results are compact
JSON text; Firestore documents are plain JSON with the `{"$timestamp"}`,
`{"$ref"}`, `{"$geo"}` and `{"$bytes"}` sentinels, so a document read back
can be written again without losing types. Emulator routes are called with the
owner token the Admin SDK uses, never through Security Rules. Stdout carries
only JSON-RPC lines; diagnostics go to stderr.

The tools marked *console* use the engine's Console API, which the suite
serves on the Emulator UI port: they need the UI on (the default; a suite
started with `emulators.ui.enabled: false` answers them with an error that
says so). Every request the server makes carries
`x-firenook-client: firenook-mcp/<version>`, and after each call it tells the
console which tool ran (the Connect dialog's Coding agent tab shows when an
agent last called); nothing else is recorded.

`--only` takes the group names below; `firenook_status` and `emulators_export`
are always served.

### Status

| Tool | Does |
| --- | --- |
| `firenook_status` | how the project was found, hub locator, hub status, the `/emulators` listing, the console address and the CLI version; outside a project, the suites whose locators answer |
| `emulators_export` | `emulators:export`: Firestore, Auth and Storage data to a directory outside the project |

### `firestore`

| Tool | Does |
| --- | --- |
| `firestore_get` | read one document |
| `firestore_query` | a structured query (`where`, `orderBy`, `limit`) over a collection, or with `collectionGroup` over every collection with that id |
| `firestore_count` | count matching documents (a COUNT aggregation), collection-group too |
| `firestore_set` | write a document (replace, or `merge` top-level fields) |
| `firestore_delete` | delete a document or collection (`recursive` for everything beneath) |
| `firestore_list_collections` | collection ids at the root or under a document |

### `auth`

| Tool | Does |
| --- | --- |
| `auth_list_users`, `auth_get_user` | accounts, or one by uid, email or phone |
| `auth_create_user`, `auth_delete_user` | create an account with synthetic credentials; delete one |
| `auth_oob_codes`, `auth_verification_codes` | the email and SMS codes the emulator holds instead of sending them |
| `auth_mint_token` | *console*: an ID token (one hour) and refresh token for a user, to call a function or a REST route as that user; `claims` for this token only |
| `auth_set_claims`, `auth_remove_claims` | *console*: replace or merge a user's custom claims; remove named claim keys |
| `auth_disable_user`, `auth_enable_user`, `auth_revoke_tokens` | *console*: disable or enable an account; revoke its refresh tokens |
| `auth_list_tenants` | *console*: tenants with their user counts and sign-in settings |

### `storage`

| Tool | Does |
| --- | --- |
| `storage_list`, `storage_get_metadata` | objects and folder prefixes under a prefix; one object's metadata |
| `storage_read` | *console*: an object's content, text inline or binary as base64, at most `maxBytes` (default 64 KiB, at most 1 MiB) with a `truncated` flag |
| `storage_upload` | *console*: create or replace an object from `text` or `base64`, with content type and custom metadata (finalize triggers run) |
| `storage_delete` | *console*, destructive: delete an object, or a folder (a path ending in `/`) |
| `storage_copy`, `storage_move` | *console*: copy or move an object or folder, in the same or another bucket; refuse to overwrite unless `overwrite` |

### `functions`

| Tool | Does |
| --- | --- |
| `functions_list` | the loaded functions with their trigger kind and URL |
| `functions_invoke` | `functions:invoke` as a tool (`data` for HTTPS/callable, `eventData` and `resource` for background events) |
| `functions_list_calls` | *console*: recent calls, newest first, with trigger, outcome, HTTP status, duration and the error's first line; filter by function, kind, outcome |
| `functions_get_call` | *console*: one call in full: cause, request and response, event payload, the error and its stack trace, its console output, timings |
| `functions_replay_call` | *console*: run a recorded call again and report the new call |

### `logs`

| Tool | Does |
| --- | --- |
| `logs_search` | *console*: the suite's log by service, level, function, call, text and time (`-15m`, `today`, RFC 3339, `reload`), newest lines oldest first; `q` takes the console's filter terms |
| `logs_facets` | *console*: counts of the matching lines by level, service, function, codebase, instance and kind |

### `rules`

| Tool | Does |
| --- | --- |
| `rules_get` | *console*: the Firestore and Storage rules in force, with their file and problems |
| `rules_evaluate` | *console*: whether a get, list, create, update or delete would be allowed as a given user (`uid` and `claims`, an `idToken`, or unauthenticated), with the rule line that decided it and each evaluated expression's value; a draft `source` too; nothing is written |
| `rules_list_denials` | *console*: recent requests the rules denied; with `explain`, the lines that denied each one |

### `pubsub`

| Tool | Does |
| --- | --- |
| `pubsub_publish` | publish a message through the Pub/Sub emulator |
| `pubsub_list_topics`, `pubsub_list_subscriptions` | *console*: topics with their counts and the functions they trigger; subscriptions with delivery, filter, dead-letter topic and backlog |
| `pubsub_peek` | *console*: a subscription's backlog in delivery order without pulling, leasing or acking anything |

### `tasks` and `schedules`

| Tool | Does |
| --- | --- |
| `tasks_stats` | Cloud Tasks queue statistics |
| `tasks_list`, `tasks_run` | *console*: queues and their waiting tasks; dispatch one task now |
| `schedules_list`, `schedules_run` | *console*: scheduled functions with their next and latest runs; run one now (one tick to its topic, as Cloud Scheduler would) |

### `eventarc` and `extensions`

| Tool | Does |
| --- | --- |
| `eventarc_publish` | *console*: publish a custom CloudEvent (default the project's Firebase channel) and report which functions received it and how each call ended |
| `eventarc_list_events`, `eventarc_get_event`, `eventarc_replay_event` | *console*: the events received, newest first; one with its data and deliveries; deliver one again |
| `extensions_list`, `extensions_reload` | *console*: Extensions instances with their state and load errors; reload one |

### `reset`

| Tool | Does |
| --- | --- |
| `emulators_clear` | *console*, destructive: delete all data of the chosen services (`firestore`, `auth`, `storage`, `pubsub`, `tasks`) |

`emulators_clear` keeps the console's safeguard: clearing one service needs
nothing more, but clearing two or more is refused unless `confirmProject`
names the project id, and the refusal says exactly what to pass, for example
`confirmProject: "demo-shop"`. The engine checks the same rule again.

Nothing is sent anywhere but the local emulators: the server holds no
credentials, contacts no cloud service and never reaches outside the machine.
Treat what an agent writes through it as you would any emulator data: synthetic
only.
