# Model Context Protocol

[Docs](README.md) · Model Context Protocol

Give a coding agent the running local suite: `firenook mcp` serves Firestore, Auth, Storage, Functions, Pub/Sub and Cloud Tasks as MCP tools.

```sh
firenook mcp                          # stdio server for the running suite
firenook mcp --only firestore,auth    # a subset of the tool groups
```

## Connect your agent

Register `npx firenook mcp` with your agent, with Firenook installed in the
project. The server reads `firebase.json` and `.firebaserc` from the folder the
agent starts it in, so it needs no project id. Start the emulators as usual
(`npx firenook emulators:start`); every tool finds them on each call.

Claude Code, from the project folder. This writes `.mcp.json`, which you can
commit so your team's agents have it too:

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

If your agent starts servers outside the project folder, add
`--config /path/to/project/firebase.json`, and `--project <id>` when
`.firebaserc` has no default.

## What it serves

`firenook mcp` is a dependency-free MCP server over stdio (newline-delimited
JSON-RPC 2.0; protocol `2025-06-18`, and `2025-03-26`/`2024-11-05` clients are
accepted) that gives a coding agent the running local suite: `initialize`,
`ping`, `tools/list` and `tools/call`, capabilities `{"tools": {}}`.

Every tool resolves the suite through the hub locator on each call (falling
back to the project's configured ports), so a suite restarted on other ports
is found, and returns a clear error while nothing runs. Results are JSON text;
Firestore documents are plain JSON with the `{"$timestamp"}`, `{"$ref"}`,
`{"$geo"}` and `{"$bytes"}` sentinels, so a document read back can be written
again without losing types. Emulator routes are called with the owner token
the Admin SDK uses, never through Security Rules. Stdout carries only JSON-RPC
lines; diagnostics go to stderr.

| Tool | Does |
| --- | --- |
| `firenook_status` | hub locator, hub status, the `/emulators` listing and the CLI version |
| `firestore_get`, `firestore_query`, `firestore_set`, `firestore_delete`, `firestore_list_collections` | read a document, run a structured query (`where`, `orderBy`, `limit`), write (replace or `merge`), delete (document or collection, `recursive`), list collection ids |
| `auth_list_users`, `auth_get_user`, `auth_create_user`, `auth_delete_user`, `auth_oob_codes`, `auth_verification_codes` | accounts and the pending email/SMS codes the emulator holds instead of sending them |
| `storage_list`, `storage_get_metadata` | objects and folder prefixes under a prefix; one object's metadata |
| `functions_list`, `functions_invoke` | the loaded functions with their trigger kind and URL; `functions:invoke` as a tool (`data` for HTTPS/callable, `eventData` and `resource` for background events) |
| `pubsub_publish`, `tasks_stats`, `emulators_export` | publish through the Pub/Sub emulator, Cloud Tasks queue statistics, `emulators:export` |

Nothing is sent anywhere but the local emulators: the server holds no
credentials, contacts no cloud service and never reaches outside the machine.
Treat what an agent writes through it as you would any emulator data: synthetic
only.
