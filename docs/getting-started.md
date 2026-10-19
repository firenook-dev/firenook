# Getting started

[Docs](README.md) · Getting started

Firenook runs your Firebase project locally from the files you already have:
the same `firebase.json`, rules and Functions code, the same client and Admin
SDKs, the same ports. This page takes you from install to a running suite,
your app connected and your data kept between runs.

## Install

```sh
npm install --save-dev --save-exact firenook
```

With Bun: `bun add --dev --exact firenook`. The package is a small launcher;
npm or Bun picks the native engine for your machine from its optional
dependencies, so keep optional dependencies enabled. Nothing else is
downloaded, at install or at start: no Java, no firebase-tools, no emulator
archives.

Firenook needs Node 24 (it runs your Functions) on macOS (Apple silicon or
Intel), Linux (x64 or arm64, glibc) or Windows x64. Firenook is in preview
(`0.2.0-next` releases): pin an exact version and upgrade on purpose.

## A new project

```sh
npx firenook init
cd functions && npm install && cd ..
npx firenook emulators:start
```

`init` writes `firebase.json` with every emulator on its usual port,
`.firebaserc` with a `demo-<folder>` project, the default Firestore and
Storage rules and indexes, and a JavaScript Functions codebase
(`--no-functions` leaves it out). It installs nothing and never overwrites an
existing `firebase.json` unless you pass `--force`.

## An existing project

```sh
npx firenook init --adopt --dry-run   # what Firenook would accept, skip and add
npx firenook init --adopt             # make those additions
npx firenook doctor                   # read-only checks of the package, Node and the config, as JSON
npx firenook emulators:start
```

`init --adopt` reads your `firebase.json` the way the official CLI does and
prints a plan: errors Firenook cannot accept, services it skips (Realtime
Database, Hosting, App Hosting, Data Connect) and the additions it can make,
such as a missing `emulators` entry. It edits the parsed JSON, never rewriting
your other keys.

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
npx firenook emulators:start --import ./seed --state-dir ./.firenook/state --resume-state
```

The first start imports the seed into `./.firenook/state`. Every start after
that opens the data where you left it, in well under a second whatever its
size, and every stop closes it cleanly. The seed stays untouched. The official way, an import at
every start and an export at every stop, works too:

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

## Coming from the official emulator

- Replace `firebase emulators:start` with `firenook emulators:start`, and
  `firebase emulators:exec` with `firenook emulators:exec`. The common flags
  carry over: `--only`, `--project`, `--import`, `--export-on-exit`,
  `--inspect-functions`.
- Keep `firebase.json`, `.firebaserc`, your rules, indexes and Functions code
  as they are, and keep firebase-tools for deploying: Firenook has no deploy
  or login command.
- Bring your data across with `--import` and your existing export.
- `functions:shell` is `firenook functions:invoke`, which calls any function
  on the running suite, background triggers included
  ([Functions and Extensions](functions-and-extensions.md)).
- Realtime Database, Hosting, App Hosting and Data Connect are not emulated;
  a `firebase.json` that configures them still starts, with a warning.

To go back, stop Firenook (it saves first), export with
`firenook emulators:export ./export` while it runs or `--export-on-exit`, and
start the official CLI on that export. Never run both on the same ports or
the same working directory.

Next: [configuration](configuration.md) · [CLI reference](cli.md) ·
[compatibility](../COMPATIBILITY.md)
