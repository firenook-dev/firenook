# CLI reference

[Docs](README.md) · CLI reference

Every command the `firenook` executable accepts. Run them through your package manager (`npx firenook …`, `bunx firenook …`) or from your package scripts.

```sh
firenook init [--force] [--dry-run] [--no-functions] [--project ID]   # scaffold a project
firenook init --adopt [--dry-run] [--json]        # adapt an existing firebase.json
firenook use [alias|projectId] [--add ID [--alias NAME]] [--unalias NAME] [--clear]
firenook target:apply storage NAME BUCKET...      # .firebaserc Storage targets
firenook target:clear storage NAME
firenook setup                                    # nothing to download; kept for old scripts
firenook doctor [options]                         # read-only checks, JSON
firenook emulators:start [options]
firenook emulators:start --keep-data [--import SEED]   # keep the data between runs in .firenook/state
firenook emulators:exec [options] "npm test"      # script through the shell
firenook emulators:exec [options] -- CMD ARGS...  # argv command, no shell
firenook emulators:export DIR [--force] [--only firestore,auth,storage]
firenook firestore:delete PATH (-r | --shallow) [-f] [--database ID]
firenook firestore:delete --all-collections -f [--database ID]
firenook functions:invoke NAME [--data JSON] [--region R] [--method M]
firenook functions:invoke NAME --event-data JSON [--resource PATH] [--params JSON] [--auth JSON] [--event-type T]
firenook ext:vendor [--instance ID]...
firenook state:inspect --state-dir DIR              # what the saved Firestore file holds and how much is free
firenook state:compact --state-dir DIR [--no-copy]  # return the free pages to the disk (emulator stopped)
firenook state:adopt-seed --state-dir DIR --import SEED   # keep saved data after its seed changed
firenook mcp [--project ID] [--only firestore,auth,storage,functions,pubsub,tasks]
firenook mcp add [--agent claude,cursor,vscode] [--dry-run] [--force] [--json]   # give coding agents the server
firenook binary-path | native ARGS...
```

`init` writes `firebase.json` (Firestore, Storage in the `{rules}` form, a
JavaScript Functions codebase unless `--no-functions`, every emulator on the
official default port, `ui.enabled: true`, `singleProjectMode: true`),
`.firebaserc` with `demo-<directory name>` (or `--project`), the official
Firestore/Storage rules and indexes templates, `functions/package.json` and
`functions/index.js`, and appends `.firenook/` and `*-debug.log` to
`.gitignore`. Nothing is installed; it refuses to overwrite `firebase.json`
without `--force`. `init --adopt` runs the launcher's own checks over an
existing project and prints a plan: errors Firenook cannot accept, official
services it skips, and additions it can make (missing `emulators` entries for
configured services, a missing `.firebaserc` default, referenced rules files
that do not exist, and the MCP server for the coding agents the folder shows,
as `mcp add` writes it). Without `--dry-run`/`--json` the additions are applied
by editing the parsed JSON, never rewriting other keys; errors leave every file
untouched and exit 1. A new project's `init` prints its start command with
`--keep-data` and, in a terminal, asks once whether to give the coding agents it
finds the MCP server.

`mcp add` writes the `firenook mcp` server into the project file of each
coding agent the folder shows: `.mcp.json` for Claude Code (a `.claude/`
folder, `CLAUDE.md`, an existing `.mcp.json` or `claude` on the PATH),
`.cursor/mcp.json` for Cursor and `.vscode/mcp.json` for VS Code (under
`servers`). `--agent` names them instead. The entry is `npx firenook mcp`
with no project id (plus `--config` when `firebase.json` is in another
folder), so the files can be committed. Other servers in the files are kept,
a second run changes nothing, another `firenook` entry is replaced only with
`--force`, and a file that is not plain JSON (VS Code's comments) is left
alone with the snippet printed. Agents configured only in the home folder
(Codex, Windsurf) get the line to add, never a file edited outside the
project.

`use`, `target:apply` and `target:clear` are pure `.firebaserc` edits: no
network, no login. `use <alias|id>` records `projects.default`, `--add`
records an alias, `--unalias`/`--clear` remove one. Only `storage` targets
exist for Firenook (`database`/`hosting` are refused).

`emulators:export` finds the running suite through the same locator file the
official CLI writes (`<tmpdir>/hub-<projectId>.json`, then the configured hub
port), refuses the project directory or an ancestor, refuses a foreign
non-empty directory without `--force` (an earlier export is replaced), and
asks the hub to export the running exportable services. `firestore:delete`
speaks to the running Firestore emulator: a document path deletes that
document (`-r` also its subcollections), a collection path needs `-r` or
`--shallow`, `--all-collections` clears the database; `-r` on a collection and
`--all-collections` need `--force`. Both print JSON with `--json`.

Common options: `-P`/`--project`, `-c`/`--config`, `--json`, `--debug`,
`--log-verbosity LEVEL` (`DEBUG` behaves like `--debug`; the other levels are
accepted for compatibility and Firenook prints its full log),
`--non-interactive`. `--debug` passes `--debug-log` to the engine, which
appends every suite log record to
`<project>/.firenook/runs/session-*/firenook-debug.log`; the path is printed in
the launch banner and recorded in `launch.json`.

Not provided: `functions:shell` (Firenook never starts a second Functions
runtime; call functions on the running suite with `functions:invoke`, which
also injects the background events the shell would), and every deploy/login
command (never intercepted). `firenook mcp` serves the running suite to an
agent; see [Model Context Protocol](mcp.md).
