# Console parity with the Google Emulator UI 1.15

Every feature of the Google Emulator UI 1.15 (the bundle the UI port's root
`/` still serves) with the console screen that covers it. When every row is
ticked, the archive and `setup` go; until then the root keeps serving the
Google UI, and its index stays pinned by the
`ui-config-logging-and-websocket` fixture.

A row is ticked (`[x]`) when its screen works end to end against a real
engine and a journey covers it. Each table is kept by the stream that owns
its area, and only that stream ticks its rows; the inventory was read from
the 1.15 archive's own sources (`src/components/...`).

## Overview

The official home page (`components/Home/*`).

| Feature (Google UI 1.15) | Where in the console | Owner | Status |
| --- | --- | --- | --- |
| One card per emulator, with On/Off and its port | Overview › Sections: a card per running section with its health, `host:port` (copy), the figures its section counts and its current problems, each linking to the page that carries it | observe | [x] |
| "Go to …" on each card | The card's title and "Open <section>", and the section's later pages ("Rules") | observe | [x] |
| The Functions card links to the logs | The Functions card's "Logs" (`/logs?q=service:functions`) | observe | [x] |
| "Not running" cards with the `firebase init emulators` text | Overview › Not running: the engine's own reason and the copyable fix (the `firebase.json` block, or the `--only` command line with the section added); sections one fix turns on share it | observe | [x] |
| The warning for a project that is not a demo ("Remember this is a local environment…"), View project and Dismiss, remembered in the browser | Overview's configuration notices: a project that is not a demo, a public listen address, emulators missing while Functions run, diagnostics off; each dismissed for this engine run in every tab. No "View project": a local tool never links to production, the notice says why it matters | observe | [x] |
| The emulators' ports, the hub's among them | Overview › Infrastructure: the hub, this UI, the logging feed and the Firestore requests socket, each with its address | observe | [x] |
| "Overview Page Loading…" spinner | The route reads the status before it draws: no spinner | observe | [x] |

## Logs

The official log viewer (`components/LogViewer/*`).

| Feature (Google UI 1.15) | Where in the console | Owner | Status |
| --- | --- | --- | --- |
| Route `/logs`, the query in `?q=` | `/logs?q=` in the console's filter language; a Google UI `?q=` (`key="value"` pairs) is rewritten on load, so a shared link opens the same view | observe | [x] |
| A live feed from the logging WebSocket | The `logs.entries` topic on the browser's one live connection, replayed from the engine's ring after a reconnect, batched by the engine, virtualized | observe | [x] |
| The last 100 matching lines | Every line the engine keeps (the newest 20,000, and the last 2,000 errors, failures and denials longer), older pages as the reader scrolls up | observe | [x] |
| Always scrolls to the newest line | Follows until the reader scrolls, selects a line or presses `p`; paused, nothing moves and the pause button and the pill count what arrived | observe | [x] |
| Query bar: Apply, Reset, Enter applies, unknown pairs marked | The filter field: completion with values from the facets, parse errors and the engine's refusals underlined, `-` to exclude any item | observe | [x] |
| Filter keys `level`, `search`, `metadata.emulator(.name)`, `metadata.extension.instanceId`, `metadata.function(.name)`, `user.*` | `level:`, `service:`, `function:`, `instance:`, `codebase:`, `execution:`, `kind:`, `is:problem`, `is:internal`, `payload.<path>:`, words, phrases and `/regex/`, plus a time range; the official keys in a pasted link | observe | [x] |
| The level button appends `level="…"` | The level word and rail on each line; Only and Hide on the Level facet | observe | [x] |
| The tag button appends the function, extension or emulator | The source chip adds its filter; the facets list every service, function, extension instance and codebase with its count | observe | [x] |
| Structured JSON, a key or value click appends `user.<path>=<value>` | The payload tree in the row and the inspector; Filter on a value adds `payload.<path>:<value>` | observe | [x] |
| Time to the second | `HH:MM:SS.mmm`, with the console-wide clock (clock, relative or UTC) | observe | [x] |
| "No logs are found which match your filters." | Says which filter hides how many lines, with Clear filters | observe | [x] |

## Shell

The frame around every page (`components/App/*`).

| Feature (Google UI 1.15) | Where in the console | Owner | Status |
| --- | --- | --- | --- |
| A top bar with a tab for every page | The sidebar, its badges for what needs a look, and ⌘K | foundation | [x] |
| "Emulator Suite Disconnected" modal, polling `/api/config` every 2 s | The top bar's engine badge says "engine stopped" or "reconnecting" from the one live connection, and opens the Overview's engine section; nothing blocks the page; a restart is recovered without a reload, and an engine whose binary changed asks for one reload | foundation | [x] |

## Authentication

The official users page (`components/Auth/*`).

| Feature (Google UI 1.15) | Where in the console | Owner | Status |
| --- | --- | --- | --- |
| Users table: identifier, provider, created, signed in, UID | Authentication › Users: user (avatar, email or phone), name, providers, created, signed in, status, phone, uid; sorted and counted by the engine, virtualized, live | auth | [x] |
| Filter users | Authentication › Users: the filter field (`is:disabled provider:google.com claim:role=admin created:>-7d …`, words), facets with counts | auth | [x] |
| Tenant picker | Authentication › Users, Inbox and Activity: the tenant picker in the panel (and in row one when the panel is shut), with counts, New tenant… and Manage tenants… | auth | [x] |
| Add a user | Authentication › Users › New user (every kind of account: email and password, phone, anonymous, a provider, custom claims); a taken email explained | auth | [x] |
| Edit a user: display name, email, password, phone, photo URL, custom claims JSON with validation, MFA phone factors, sign-in method | Authentication › Users › the inspector: Details (name, email, phone, photo URL, verified, times), Password, Claims (Firebase's own checks, the token it makes, where rules read each key), SMS second factors, linked providers | auth | [x] |
| Delete a user | Authentication › Users: the row menu, the inspector and ticked rows › Delete, a job with the functions it runs | auth | [x] |
| Enable and disable a user | Authentication › Users: the inspector's switch, and Disable / Enable on ticked rows or everything the filter matches (a job) | auth | [x] |
| Clear all users | Authentication › Settings › Data ("Delete all users of …", one tenant or every tenant, a job) and ⌘K; Overview › Data › Reset | auth | [x] |
| One account per email address | Authentication › Settings › Sign-in (the switch, with what it changes for a provider sign-in) | auth | [x] |
| Refresh | Authentication › Users is live: rows arrive, flash and patch in place from the `auth.users` topic; no refresh button | auth | [x] |
| Zero state | Authentication › Users: "No users yet" with how an app connects to this engine's Auth; an empty tenant names the scopes that hold users; New user, Sample users and Import | auth | [x] |

## Firestore

The official data and requests pages (`components/Firestore/*`).

| Feature (Google UI 1.15) | Where in the console | Owner | Status |
| --- | --- | --- | --- |
| Collection, document and field browser | Firestore › Data: the schema tree and path bar, the typed grid, the inspector (fields and JSON) | foundation | [x] |
| Add a collection | Firestore › Data › New › Collection (root), and a subcollection from the inspector | foundation | [x] |
| Add a document | Firestore › Data › New › Document (typed fields or JSON, generated or chosen id), and JSON import | foundation | [x] |
| Delete a collection | Firestore › Data: Select all, then Delete (every document the query reaches, subcollections optional) | foundation | [x] |
| Delete a document | Firestore › Data: the inspector's Delete and ticked rows' Delete | foundation | [x] |
| Delete fields | Firestore › Data › the inspector's field rows (Remove), saved as one write | foundation | [x] |
| Clear all data | Overview › Data › Reset Firestore: every database, as a job, no Functions triggers unless asked, open pages reload once at its start and end | observe | [x] |
| Typed editors: string, number, boolean, timestamp, geopoint, reference, map and array JSON | Firestore › Data: a typed editor per value in the inspector and in the grid's cells, the JSON view beside them | foundation | [x] |
| Collection filter: conditions and sort | Firestore › Data: the query line (`where(…).orderBy(…).limit(n)`), column header sort and filter, explain | foundation | [x] |
| Requests table | Firestore › Rules › Decisions (every rules decision, live, narrowed by path, uid, verdict and operation) | foundation | [x] |
| Request detail: the rules code, inspection | Firestore › Rules › Decisions › a decision: the lines that decided it lit in the editor, each expression's value, why | foundation | [x] |
| Copy a path | Firestore › Data: the path bar's copy, the inspector's title (click to copy) | foundation | [x] |
| Database picker | Firestore › Data and Rules: the database picker, which a database a client writes to joins | foundation | [x] |

## Storage

The official files page (`components/Storage/*`).

| Feature (Google UI 1.15) | Where in the console | Owner | Status |
| --- | --- | --- | --- |
| Bucket picker | Storage › the folders panel's bucket picker (every bucket with objects or configured, figures, "no rules" marked) and "Open a bucket by name…" | storage | [x] |
| Folder breadcrumbs | Storage › row one's path bar: segments, editable with folder completions, a pasted gs:// or download URL; the tree in the panel | storage | [x] |
| Upload: button and drag and drop | Storage › Upload (files, a folder, with options), a drop on the list or a folder of the tree, a pasted image; the tray with progress, cancel, retry and the taken-names question | storage | [x] |
| Create a folder | Storage › New folder (`n`, ⌘K), a zero-byte marker shown as an empty folder | storage | [x] |
| Delete selected | Storage › ticked rows › Delete: the dry run's counts in DangerConfirm, then a job with progress and cancel | storage | [x] |
| Delete all | Storage › bucket menu › "Empty the bucket…" (the same delete job), and Overview › Data › Reset | storage | [ ] until a journey empties a bucket (the folder-delete journey covers the job path) |
| Table: name, size, type, modified | Storage › the list: name, size, type, last changed, metadata keys, tokens (and Access as a client); folders first with their figures; sort and filter in the engine; the grid | storage | [x] |
| Multiple selection | Storage › ticks, Shift ranges, ⌘A, "Select all N" for the whole listing | storage | [x] |
| Side panel with a preview | Storage › the inspector's Details and Quick Look: images, video, audio, PDF, text, JSON, CSV and HTML; any other bytes, a zip among them, as hex with what their first bytes say | storage | [x] |
| Location: path, URL, token copy and create | Storage › Details › Location (gs://, path, the download URL an app connected to the emulator gets, REST) and the row menu's "Copy download URL"; Tokens (create, reveal and copy, revoke) | storage | [x] |
| Metadata | Storage › Metadata tab (standard fields, one counted Save, the stale-version band) | storage | [x] |
| Custom metadata | Storage › Metadata tab's custom keys, and metadata for many files at once | storage | [x] |

## Extensions

The official extensions pages (`components/Extensions/*`).

| Feature (Google UI 1.15) | Where in the console | Owner | Status |
| --- | --- | --- | --- |
| Instances table | Extensions › the overview's instances table | compute | [x] |
| Detail: parameters, a secret shown on demand | Extensions › an instance › Configuration (a secret revealed on request; SecretInput when editing) | compute | [x] |
| Detail: APIs and resources | Extensions › an instance › Overview (the APIs, emulated or not, and external services) | compute | [x] |
| Detail: events and their snippet | Extensions › an instance › Events (channel, declared and allowed types, a handler snippet, and how many events it published, opened in Eventarc filtered to the instance) | compute | [x] |
| Detail: access and roles | Extensions › an instance › Overview (roles) | compute | [x] |
| Detail: README | Extensions › an instance › How it works (POSTINSTALL, README) | compute | [x] |
| Detail: related links | Extensions › an instance › Overview (source URL, author) | compute | [x] |
| Zero state | Extensions › the empty state | compute | [x] |

## FireAlerts

The official alerts page (`components/Firealerts/*`).

| Feature (Google UI 1.15) | Where in the console | Owner | Status |
| --- | --- | --- | --- |
| Send a test Firebase Alerts event to functions | Not built: alerts are not delivered (Eventarc's "without alert delivery there is no Alerts page"; ROADMAP keeps the line open) | compute | [ ] |

## Out of scope

| Feature (Google UI 1.15) | Why |
| --- | --- |
| Realtime Database pages (`components/Database/*`) | Firenook does not emulate the Realtime Database: the CLI refuses `database` in `--only`, and a `firebase.json` that configures it starts without it, with a warning. |
| Hosting's "View website" | Firenook does not emulate Hosting. |
| Usage analytics (gtag, opted into from the CLI) | The console sends nothing anywhere. |

## Known differences

- The official logging feed marks a function's console output with level
  `user`; Firenook's feed writes `info` for stdout and `warn` for stderr,
  unchanged until an oracle capture of a function's console line pins the
  official record. The console's own log keeps each line's real level.
- Firenook's official Firestore clear
  (`DELETE /emulator/v1/projects/{project}/databases/{database}/documents`)
  commits normally, so Functions triggers run for what it deletes; whether
  the official emulator's does is not captured yet. The route is logged as a
  `firestore.cleared` line. The console's reset commits as maintenance and
  runs no triggers unless asked to.
