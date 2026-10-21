# Functions and Extensions

[Docs](README.md) · Functions and Extensions

Your Functions codebases and `firebase.json` Extensions run in Firenook's own runtime: debugging, invoking any trigger by hand, and running Extensions offline.

```sh
firenook emulators:start --project demo-my-app --inspect-functions        # debugger on 9229, 9230, ...
firenook emulators:start --project demo-my-app --inspect-functions=9333   # one codebase, explicit port
firenook functions:invoke helloWorld --project demo-my-app                # GET-less POST to the HTTPS route
firenook functions:invoke addMessage --project demo-my-app --data '{"text":"hi"}'   # callable body {"data": ...}
firenook functions:invoke onUserWritten --project demo-my-app --resource users/alice \
  --event-data '{"before":{"plan":"free"},"after":{"plan":"pro"}}'        # a Firestore document event
firenook ext:vendor --project demo-my-app                                 # copy registry Extensions into the project
firenook ext:vendor --project demo-my-app --offline                       # copy only what the shared cache holds
firenook emulators:start --project demo-my-app --offline                  # never contact the Extensions registry
```

## Params and env files

Each codebase reads the official dotenv chain, later files winning: `.env`,
`.env.<projectId>`, `.env.<alias>` and `.env.local`. The alias is the
`.firebaserc` alias the project was selected by (see
[Configuration](configuration.md)): `staging` for
`--project staging`, or for `firebase use staging`, when `staging` is an
alias; with neither, the file's only alias, else `default`. A project named
by its id has no alias. Having both `.env.<projectId>` and `.env.<alias>` is
refused, as officially. `.secret.local` holds the secrets a function
declares.

The discovery process (the SDK run that turns the code into the function
list) gets the env file values too, as the official emulator passes them, so
code that reads `process.env` while it loads (a `region` from
`process.env.SHOP_REGION`) sees the same values there and in the worker. A
param's default and the secrets are not there yet; the worker has them.

Params (`defineString`, `defineInt`, `defineBoolean`, `defineList`,
`defineSecret` ...) resolve as the official emulator resolves them when no
terminal is attached, since Firenook never prompts:

- A value in an env file wins.
- Otherwise the param takes its default, in the function's options (`region`,
  `memory`, `timeoutSeconds`, `minInstances` ...) and in `.value()`. A default
  that is an expression (`{{ params.PROJECT_ID }}-shop`) is resolved first; a
  default of the wrong type is refused.
- A param with no value and no default stops its codebase loading, with the
  official question and where to put the answer:
  `Question "Enter a string value for API_URL:" does not have a default and
  cannot be answered in non-interactive mode. Firenook never prompts: set the
  value in .env, .env.demo-my-app or .env.local, or give the param a default.`
  When it is the only codebase, the start then stops, as it does for any
  codebase that does not load (see `--minimum-functions`).
- A secret is never asked for: its value comes from `.secret.local` when the
  function runs.

Two deliberate differences: the official emulator writes the answers it
took, defaults included, to `.env.local`; Firenook writes nothing and takes
the default again at every load, so a changed default applies on the next
reload (the console's Environment tab lists the default among the
variables, marked `default`, and offers to write a value to `.env.local`). And a list param reaches `process.env` as the JSON array the
SDK's `.value()` parses, as a deployed function gets it; the official
emulator passes the text it wrote (`red,green`), which `.value()` cannot
parse.

## Triggers on a service that is not running

A trigger on a service the suite does not run (Storage left out of `--only`,
or the Realtime Database, which Firenook does not emulate) is loaded and
listed but receives no event, and the first load says so with the official
line, as a warning on the terminal screen and in the plain log (the
console's page for the function says which service it needs; Run and
functions:invoke still call it directly):

```text
functions[us-central1-onUpload]: function ignored because the storage emulator does not exist or is not running.
```

Firestore, Pub/Sub (and schedules), Storage, Auth (and blocking functions,
which stay callable on their URL) are covered. The official emulator says
this for Firestore, Pub/Sub and the Realtime Database only, and silently
registers Storage and Auth triggers it cannot deliver. An Extension
instance with such a trigger is left out whole, with the official
`extensions[<instance>]` warning that names the service.

## TypeScript

```sh
npx firenook emulators:start --build      # what `npm run emulators` runs in a project made by init
```

A TypeScript codebase loads from what its compiler writes (`main` is
`lib/index.js`), so it has to be compiled before it loads and again after
every save. With `--build`, Firenook runs the codebase's own `build:watch`
script (`tsc --watch` in the official template), starts the emulators once
the first compile is done, and keeps it running: save `src/index.ts`, the
compiler writes `lib/`, and the codebase reloads, in one terminal. A compile
with errors says them in the log, where they are and what the compiler said:

```text
22:30:29    ✕ build                   2 errors · functions
            │ src/index.ts:7:33  Type 'string' is not assignable to type 'number'.
22:30:34    ✓ build                   no errors · functions
22:30:36    ↻ reloaded        168 ms  1 function · default
```

A codebase with a `build` script but no `build:watch` is built once, before
the start. `emulators:exec --build` runs `build` once and runs no test when it
fails. The scripts are the project's own, the ones a deploy's `predeploy`
runs, so what loads locally is what a deploy builds.

## Invoking a function by hand

`functions:invoke` finds the running suite through the hub locator (so a
suite started on other ports is found) and, without `--event-data`, sends a
plain request (`--method`, default `POST`) or a callable body (`--data`) to the
function's HTTPS route. With `--event-data` it reads the loaded functions
(`GET /backends`), selects the named one (`--region` when a name is deployed
in several regions), builds the event exactly as the official `functions:shell`
does (`createLegacyEvent` for first-generation functions, a structured
`application/json` CloudEvent for second-generation ones) and posts it to the
suite's trigger route, which hands it unchanged to the codebase worker. The
delivery status and body are printed; `--json` prints the whole record
including the envelope. HTTPS/callable functions refuse `--event-data` (use
`--data`); Auth blocking functions are driven by the Auth emulator; Realtime
Database functions are not emulated.

| Trigger | `--event-data` | Notes |
| --- | --- | --- |
| Firestore (v1 `document.*`, v2 `google.cloud.firestore.document.v1.*`) | `{"before": {...}, "after": {...}}` as plain JSON fields (a bare object is the created/deleted document) | `--resource users/alice` names the document; wildcards are read back into `params`, or `--params '{"uid":"alice"}'` fills the trigger pattern. Values are encoded like the shell (`integerValue`, `mapValue`, ...) with `{"$timestamp"}`, `{"$ref"}`, `{"$geo"}` and `{"$bytes"}` sentinels for the types JSON lacks; each document value also carries its `name`, which the SDK uses for `snapshot.ref`. |
| Storage (v1 `google.storage.object.*`, v2 `google.cloud.storage.object.v1.*`) | the object metadata; `name` is required, `bucket` defaults to the trigger's bucket, `contentType`, `size`, `generation`, `metageneration`, timestamps, `id`, `selfLink` and `mediaLink` are defaulted | v1 events carry `resource: projects/_/buckets/<bucket>/objects/<name>`. |
| Pub/Sub (v1 `google.pubsub.topic.publish`, v2 `messagePublished`) | `{"data": <string or JSON>, "attributes": {...}, "orderingKey": "..."}` (string data is sent as given, other JSON as its text; both base64 on the wire) | Published through the Pub/Sub emulator when it runs, so every subscriber sees the message; otherwise the shell envelope goes straight to the trigger. |
| Auth v1 (`user.create`, `user.delete`) | a UserRecord (`uid` and `metadata` timestamps are defaulted) | `resource` defaults to `projects/<id>`. |
| Schedule | ignored (`{}`) | v2: an empty CloudEvent with Cloud Scheduler's `X-CloudScheduler-*` headers; v1: the legacy event on the `firebase-schedule-<name>` topic. |
| Eventarc custom (`onCustomEventPublished`) | the CloudEvent `data` | `--event-type` overrides the type; the channel is part of the trigger key. |
| Task queue (`onTaskDispatched`) | the task payload, enqueued as `{"data": ...}` | Sent to the Cloud Tasks emulator (`POST .../queues/<name>/tasks`) with the Admin SDK's request, so retries and rate limits apply. |

`--auth '{"uid": "...", "token": {...}}'` (or `{"admin": true}`) fills the
legacy event's `auth` as the shell's `constructAuth` does; first-generation
events default to `{"admin": false}` like the shell.

`firebase.json` `extensions` instances run like the official emulator: a
local path is read from disk; a registry ref (`publisher/name@version`) is
taken from `extensions/.sources/<publisher>/<name>@<version>` in the project
(vendored), then from the shared firebase-tools cache
(`~/.cache/firebase/extensions`, or `FIREBASE_EXTENSIONS_CACHE_PATH`), and
otherwise downloaded from the registry and built with `npm install` /
`npm run gcp-build`. Parameters come from `extensions/<instance>.env`,
`.env.<alias>`, `.env.<projectId>`, `.env.local` and `.secret.local` with the
official precedence, defaults and `${param:X}` substitution.

The registry (metadata and, on first use, the source archive) is contacted
with the Firebase CLI's stored login or a `FIREBASE_TOKEN` refresh token, the
same credential the official emulator uses. The login is read where the
Firebase CLI's configstore writes it: `$XDG_CONFIG_HOME/configstore/firebase-tools.json`,
else `<home>/.config/configstore/firebase-tools.json`, with `<home>` as Node
sees it (`%USERPROFILE%` on Windows, even where a shell sets `HOME`; `$HOME`
elsewhere); the shared cache is under the same home. Firenook stores the
registry objects next to the source (`firenook-registry.json`) so every later
start is offline; a source cached or vendored by a release published under
the former name keeps its old sidecar name and still starts offline.
Secret Manager is never contacted: provide secret parameters in
`extensions/<instance>.secret.local`. `firenook ext:vendor` copies each
resolved source into the project with its `firenook-registry.json` and records
how unpinned refs resolved, which is the recommended path for CI and for
teammates without a Firebase login; `ext:vendor --offline` copies only what is
already in the shared cache with its sidecar and never contacts the registry.
`--offline` (or `FIRENOOK_OFFLINE=1`) on a start turns any remaining registry
access into a startup error. `firenook doctor` lists every instance with its source and
whether it starts offline. Dynamic (in-code) extensions, Python/Dart runtimes
and the registry's `latest-approved` listing rules beyond version resolution
are not supported.
