# Getting started

[Docs](README.md) · Getting started

Firenook runs your Firebase project locally from the files you already have:
the same `firebase.json`, rules and Functions code, the same client and Admin
SDKs, the same ports. This page takes you from install to a running suite,
your app connected and your data kept between runs. Already running the
official emulator? [Switch over](#switching-from-the-official-emulator) in
three steps; starting fresh, see [a new project](#a-new-project).

## Install

```sh
npm install --save-dev --save-exact firenook
```

With Bun: `bun add --dev --exact firenook`. The package is a small launcher;
npm or Bun picks the native engine for your machine from its optional
dependencies, so keep optional dependencies enabled. Nothing else is
downloaded, at install or at start: no Java, no firebase-tools, no emulator
archives. The one exception is an Extension from the registry, fetched once on
first use; `firenook ext:vendor` copies it into the project so even that is
offline.

Firenook needs Node 24 (it runs your Functions) on macOS (Apple silicon or
Intel), Linux (x64 or arm64, glibc) or Windows x64. Firenook is in preview
(`0.2.0-next` releases): pin an exact version and upgrade on purpose.

## Switching from the official emulator

Firenook is a drop-in replacement. `firebase.json`, `.firebaserc`, your rules
and indexes, your Functions code and your app stay exactly as they are, and
firebase-tools stays installed for deploying (Firenook has no deploy or login
command).

**1. Check your project.** Nothing changes until you drop `--dry-run`:

```console
$ npx firenook init --adopt --dry-run
  skip    Firenook: firebase.json configures the hosting emulator, which Firenook does not implement; skipping it.
  ok      nothing to change; services: firestore, auth, storage, functions
```

`init --adopt` reads your `firebase.json` the way the official CLI does and
prints a plan: errors Firenook cannot accept, services it skips (Realtime
Database, Hosting, App Hosting, Data Connect) and the additions it can make,
such as a missing `emulators` entry. `npx firenook init --adopt` applies the
additions by editing the parsed JSON, never rewriting your other keys.
`npx firenook doctor` runs the same checks plus the package and Node, read-only,
as JSON.

**2. Swap the command.** `firebase emulators:start` becomes
`firenook emulators:start` and `firebase emulators:exec` becomes
`firenook emulators:exec`; the common flags carry over (`--only`, `--project`,
`--import`, `--export-on-exit`, `--inspect-functions`):

```diff
 "scripts": {
-  "emulators": "firebase emulators:start --import ./data --export-on-exit",
-  "test:integration": "firebase emulators:exec \"npm test\""
+  "emulators": "firenook emulators:start --import ./data --export-on-exit",
+  "test:integration": "firenook emulators:exec \"npm test\""
 }
```

Firenook reads and writes the official export format, so `--import` takes the
data you already have, and every emulator listens on the port `firebase.json`
gives it. Your app needs no change.

**3. Keep your data without exporting (optional).** Instead of an import at
every start and an export at every stop, replace `--export-on-exit` with
`--keep-data`: the first start imports `./data` into `.firenook/state`, every
later start picks the data up where you left it, and `./data` itself is never
written:

```sh
npx firenook emulators:start --import ./data --keep-data
```

**What is different**

- `functions:shell` is `firenook functions:invoke`, which calls any function
  on the running suite, background triggers included
  ([Functions and Extensions](functions-and-extensions.md)).
- Realtime Database, Hosting, App Hosting and Data Connect are not emulated;
  a `firebase.json` that configures them still starts, with a warning.
- Google's Emulator UI is replaced by [the console](console.md), on the same UI
  port; its old page addresses lead to the matching console page.

**Going back** is as short: stop Firenook (it saves first), export with
`npx firenook emulators:export ./export` while it runs or with
`--export-on-exit`, and start the official CLI on that export. Never run both
on the same ports or the same working directory.

## A new project

```sh
npx firenook init
```

In a terminal, `init` opens on one screen with every choice already made, so
Enter takes them all:

- **Project ID**: `demo-<folder>`. A `demo-` id never reaches a real
  Firebase project; type another to use your real project's id.
- **Emulators**: Firestore, Auth, Storage, Pub/Sub and the console, each on
  its usual port. A port something already listens on is named, with what
  holds it.
- **Functions**: TypeScript, JavaScript or none. Cloud Tasks and Eventarc come
  with Functions.
- **Agents**: the coding agents the folder shows (`.claude/`, `.cursor/`,
  `.vscode/`, or `claude` on the PATH) get the [MCP server](mcp.md).
- **Set up**: install the packages, and pin Firenook in `package.json` with an
  `emulators` script.

`↑` `↓` move between them, `←` `→` and Space change one, Esc leaves without
writing anything. Then `init` writes the files, installs the Functions
codebase's packages and Firenook's, builds a TypeScript codebase once, and
asks whether to start the emulators there and then. Later, one command starts
them:

```sh
npm run emulators            # firenook emulators:start --keep-data --build
```

`--keep-data` keeps the data between runs from the first start. `--build`
runs the codebase's own `build:watch` script (`tsc --watch`) beside the
emulators, so TypeScript is compiled before it loads and again on every save,
with any errors in the log; see [Functions](functions-and-extensions.md#typescript).

The files are the official `firebase init` templates: `firebase.json` with each
emulator on its usual port, `.firebaserc`, the default Firestore and Storage
rules and indexes, and the Functions codebase (`functions/src/index.ts`
compiled to `functions/lib`, with a `predeploy` build in `firebase.json` as a
deploy needs, or `functions/index.js`). `init` never overwrites an existing
`firebase.json` unless you pass `--force`; in a folder that already has one,
it shows what `init --adopt` would add, and adds it on a yes.

Without a terminal (a script, CI, `--json`), `init` writes the files and
prints the commands that finish the set-up. `--yes` takes the screen's
choices with no questions and does the set-up too; `--language
typescript|javascript|none`, `--only firestore,auth,functions,storage,pubsub`,
`--agent claude,cursor,vscode`, `--no-install` and `--no-pin` change them.

## Start

```sh
npx firenook emulators:start                     # the project in .firebaserc
npx firenook emulators:start --project demo-shop  # or name one
npx firenook emulators:start --only firestore,auth
```

In a terminal you get a live screen: the start-up, the ready summary and a
log line for every function call, with keys to open the console (`o`), reload
your functions (`r`), export a snapshot (`e`) and stop (`q`, which saves the
data first). See [the terminal](terminal.md).

The console is at <http://127.0.0.1:4000/console> (the UI port in
`firebase.json`). See [the console](console.md).

## Connect your app

Your app connects exactly as it does to the official emulator. In the web
SDK:

```js
connectFirestoreEmulator(db, '127.0.0.1', 8080);
connectAuthEmulator(auth, 'http://127.0.0.1:9099');
connectStorageEmulator(storage, '127.0.0.1', 9199);
connectFunctionsEmulator(functions, '127.0.0.1', 5001);
```

The Admin SDK and server code read the usual variables
(`FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST`,
`FIREBASE_STORAGE_EMULATOR_HOST`, `PUBSUB_EMULATOR_HOST`). The console's
**Connect** button shows the snippet for each platform with your ports filled
in.

## Keep your data between runs

```sh
npx firenook emulators:start --keep-data                  # a project with no seed
npx firenook emulators:start --keep-data --import ./seed  # starting from a seed
```

`--keep-data` keeps the data in `.firenook/state` (it is short for
`--state-dir ./.firenook/state --resume-state`). The first start creates it,
importing the seed when you give one. Every start after that opens the data
where you left it, in well under a second whatever its size, and every stop
closes it cleanly. The seed stays untouched. Keeping data is opt-in, so
`--import ./data` alone still starts from that data every time, as the
official emulator does. The official way, an import at every start and an
export at every stop, works too:

```sh
npx firenook emulators:start --import ./data --export-on-exit
```

Both read and write the official export format, so data moves freely between
Firenook and the official emulator. See [data, state and tests](data-and-state.md).

## Run your tests against it

```sh
npx firenook emulators:exec "npm test"
npx firenook emulators:exec -- node ./integration-test.mjs
```

`emulators:exec` starts the suite, runs the command once everything is ready
with the emulator variables set, then stops and passes on the exit code. In
`package.json`:

```json
{
  "scripts": {
    "emulators": "firenook emulators:start",
    "test:integration": "firenook emulators:exec \"npm test\""
  }
}
```

Next: [configuration](configuration.md) · [CLI reference](cli.md) ·
[compatibility](../COMPATIBILITY.md)
