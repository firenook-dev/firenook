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
firenook emulators:start --project demo-my-app --offline                  # never contact the Extensions registry
```

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
same credential the official emulator uses; Firenook stores the registry
objects next to the source (`firenook-registry.json`) so every later start is
offline. Secret Manager is never contacted: provide secret parameters in
`extensions/<instance>.secret.local`. `firenook ext:vendor` copies each
resolved source into the project and records how unpinned refs resolved, which
is the recommended path for CI and for teammates without a Firebase login;
`--offline` (or `FIRENOOK_OFFLINE=1`) turns any remaining registry access into
a startup error. `firenook doctor` lists every instance with its source and
whether it starts offline. Dynamic (in-code) extensions, Python/Dart runtimes
and the registry's `latest-approved` listing rules beyond version resolution
are not supported.

## Credentials

Every Functions worker holds synthetic credentials, never yours: an
`authorized_user` file with a `demo` client and refresh token, as its
`GOOGLE_APPLICATION_CREDENTIALS` and in the gcloud directory it sees
(`CLOUDSDK_CONFIG`). Your own `GOOGLE_APPLICATION_CREDENTIALS` and gcloud login
never reach your Functions, whatever their firebase-admin release. A call that
asks for an access token first (an Eventarc publish, a task enqueue) sends the
demo refresh to Google's token endpoint, and the worker answers it in its own
process with the emulators' token, so it never leaves the machine. A codebase's
own `.env` may still set `GOOGLE_APPLICATION_CREDENTIALS`, and a request with
those credentials goes to Google.
