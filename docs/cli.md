# CLI reference

[Docs](README.md) · CLI reference

Every command the `firenook` executable accepts. Run them through your package manager (`npx firenook …`, `bunx firenook …`) or from your package scripts.

```sh
firenook init                                     # a new project: a screen of choices in a terminal
firenook init --yes [--no-install] [--no-pin]     # the same set-up, no questions
firenook init [--language typescript|javascript|none] [--only firestore,auth,functions,storage,pubsub]
              [--agent claude,cursor,vscode] [--project ID] [--force] [--dry-run] [--json]
firenook init --adopt [--dry-run] [--json]        # adapt an existing firebase.json
firenook use [alias|projectId] [--add ID [--alias NAME]] [--unalias NAME] [--clear]
firenook target:apply storage NAME BUCKET...      # .firebaserc Storage targets
firenook target:clear storage NAME
firenook setup                                    # nothing to download; kept for old scripts
firenook doctor [options]                         # read-only checks, JSON
firenook emulators:start [options]
firenook emulators:start --keep-data [--import SEED]   # keep the data between runs in .firenook/state
firenook emulators:start --build                  # compile each Functions codebase first and on every save
firenook emulators:exec [options] "npm test"      # script through the shell
firenook emulators:exec [options] -- CMD ARGS...  # argv command, no shell
firenook emulators:export DIR [--force] [--only firestore,auth,storage]
firenook firestore:delete PATH [-r | --shallow] [-f] [--database ID]
firenook firestore:delete --all-collections -f [--database ID]
firenook functions:invoke NAME [--data JSON] [--region R] [--method M]
firenook functions:invoke NAME --event-data JSON [--resource PATH] [--params JSON] [--auth JSON] [--event-type T]
firenook ext:vendor [--instance ID]... [--offline]
firenook state:inspect --state-dir DIR              # what the saved Firestore file holds and how much is free
firenook state:compact --state-dir DIR [--no-copy]  # return the free pages to the disk (emulator stopped)
firenook state:adopt-seed --state-dir DIR --import SEED   # keep saved data after its seed changed
firenook mcp [--project ID] [--only firestore,auth,storage,functions,logs,rules,pubsub,tasks,schedules,eventarc,extensions,reset]
firenook mcp add [--agent claude,cursor,vscode] [--dry-run] [--force] [--json]   # give coding agents the server
firenook binary-path | native ARGS...
firenook --version | --help
```

`init` in a terminal opens on a screen with every choice made: the project id
(`--project`, else an existing `.firebaserc` default, else
`demo-<directory name>`), the emulators (Firestore, Auth, Storage, Pub/Sub and
the console, each on the official default port, a port in use named with what
holds it), the Functions language (TypeScript, JavaScript or none), the coding
agents given the MCP server (those the folder shows), and whether to install
the packages and pin Firenook. Enter takes them; Esc writes nothing. It then
writes the files, gives the agents the server, writes `package.json` (Firenook
as an exact devDependency and an `emulators` script,
`firenook emulators:start --keep-data`, with `--build` for TypeScript; a
script or a pin already there is kept), runs `npm install` in `functions/` and
the project's package manager's install beside it (the lockfile's, else the
one that ran `init`, else npm), builds a TypeScript codebase once, and offers
to start the emulators in the same terminal; on a Node older than 22 it says how
to switch instead. Ctrl-C stops the installs and keeps what was written.

The files are the same without a terminal: `firebase.json` (Firestore, Storage
in the `{rules}` form, the Functions codebase, every emulator on its official
port, `ui.enabled`, `singleProjectMode: true`), `.firebaserc` with the project
id as its default (other keys of an existing one kept), the official
Firestore/Storage rules and indexes templates, and the official TypeScript
codebase (`functions/package.json` with `build` and `build:watch`,
`tsconfig.json`, `src/index.ts`, and a `predeploy` build in `firebase.json`,
as a deploy needs) or `functions/index.js` with `--language javascript`
(`--language none`, or `--no-functions`, writes no codebase), and appends
`.firenook/` and `*-debug.log` to `.gitignore`. Without `--yes` nothing is
installed and the commands that finish the set-up are printed; `--yes` does
the set-up as the screen would, one line a step (`--no-install`, `--no-pin`).
`--only` names the data services (the console and the hub always come; Cloud
Tasks and Eventarc come with Functions). It refuses to overwrite
`firebase.json` without `--force`; with it, `firebase.json` is written again
and every other file that exists is kept as it is (the rules, the indexes, the
Functions code, the rest of `.firebaserc`), as the official init keeps each
unless told to overwrite it: delete a file first to get its template.
`init --adopt` runs the launcher's own checks over an existing project and
prints a plan: errors Firenook cannot accept (`error`), services it skips
(`skip`), other warnings (`warn`), and additions it can make (`add`: missing
`emulators` entries for configured services, a missing `.firebaserc` default,
referenced rules files that do not exist, and the MCP server for the coding
agents the folder shows, as `mcp add` writes it). Without `--dry-run`/`--json`
the additions are applied as text: `firebase.json` and `.firebaserc` keep
every byte they had, and each addition goes at the end of the object it joins,
in that object's indentation, line endings and one-line or one-a-line layout;
errors leave every file untouched and exit 1. In a terminal, `init` in a
folder with a `firebase.json` shows that plan and applies it on a yes.

`emulators:start`, `emulators:exec` and `doctor` take the launch options:
`--only auth,functions,firestore,storage,pubsub` (`extensions` means
`functions`; Eventarc, Cloud Tasks, the hub, the console and its log follow
their service), `--import DIR` (a seed: an official export),
`--export-on-exit[=DIR]` (an export on the way out, into the `--import`
directory without `DIR`), `--keep-data`, `--state-dir DIR` and
`--resume-state` ([Data and state](data-and-state.md)),
`--durability write-behind|per-commit`, `--storage-bucket target=bucket`
(repeatable), `--host HOST`, `--allowed-hosts NAME,...` ([The
console](console.md)), `--ui`, `--minimum-functions N`,
`--inspect-functions[=PORT]`, `--offline` ([Functions and
Extensions](functions-and-extensions.md)), `--no-diagnostics`
([Configuration](configuration.md)), the port overrides
`--firestore-websocket-port`, `--hub-port`, `--logging-port`,
`--eventarc-port` and `--tasks-port` (every other port comes from
`firebase.json`), `--plain` ([The terminal](terminal.md)) and `--build`.

`--build` (start and exec) runs each Functions codebase's own build: a start
runs its `build:watch` script (its `build` when it has none) and waits for the
first compile before the engine loads the codebase, then keeps it running, so
every save is compiled and the engine reloads what the compiler wrote; exec
runs `build` once and refuses to run the tests when it fails. TypeScript's
errors are shown in the log with where they are (`src/index.ts:3:7`), other
build output as it is. Firenook compiles nothing itself: the script is the
project's, as `predeploy` runs it for a deploy.

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
network, no login. `use <alias|id>` records `projects.default`, the active
project (`--alias NAME` also records the id under that alias); `--add ID`
records an alias (`--alias NAME`, else `default`, which makes it the active
project); `--unalias NAME` removes an alias; `--clear` removes
`projects.default`, so no project is active, and keeps the aliases. With no
argument `use` lists the aliases and the active project (`--json` prints them
as JSON). Only `storage` targets exist for Firenook (`database`/`hosting` are
refused).

Commands that talk to a running suite (`emulators:export`, `firestore:delete`,
`functions:invoke`, `mcp`) find its hub as the official CLI does, through the
locator file it writes (`<tmpdir>/hub-<projectId>.json`, then the configured
hub port), with two differences. Run in a project's folder (or a folder
inside it) they reach the suite started from that folder: the locator names
one suite per project id, the first one started, so each Firenook suite also
keeps a record of its own with its folder
(`<tmpdir>/firenook-hubs/hub-<projectId>-<pid>.json`). And `--hub-port`
reaches the hub on that port, and no other. A second suite for a project id
warns that several are running, as the official CLI does, and leaves the
locator to the first one; each still stops cleanly. With only `--project` and
two suites for that id running, a command asks for `--hub-port` instead of
picking one.

`emulators:export` refuses the project directory or an ancestor, refuses a foreign
non-empty directory without `--force` (an earlier export is replaced), and
asks the hub to export the running exportable services. `firestore:delete`
speaks to the running Firestore emulator: a document path deletes that
document (`-r` also its subcollections), a collection path needs `-r` or
`--shallow`, `--all-collections` clears the database; `-r` on a collection and
`--all-collections` need `--force`. Both print JSON with `--json`.

`--version` (or `-v`) prints the CLI's version and the engine commit it
ships; `--help`, or `--help` after any command, prints the summary of every
command.

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
