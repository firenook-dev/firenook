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
| "Emulator Suite Disconnected" modal, polling `/api/config` every 2 s | The top bar's engine badge says "engine stopped" or "reconnecting" from the one live connection; nothing blocks the page; a restart is recovered without a reload, and an engine whose binary changed asks for one reload | foundation | [x] |

## Authentication

The official users page (`components/Auth/*`).

| Feature (Google UI 1.15) | Where in the console | Owner | Status |
| --- | --- | --- | --- |
| Users table: identifier, provider, created, signed in, UID | Authentication | auth | [ ] |
| Filter users | Authentication | auth | [ ] |
| Tenant picker | Authentication | auth | [ ] |
| Add a user | Authentication | auth | [ ] |
| Edit a user: display name, email, password, phone, photo URL, custom claims JSON with validation, MFA phone factors, sign-in method | Authentication | auth | [ ] |
| Delete a user | Authentication | auth | [ ] |
| Enable and disable a user | Authentication | auth | [ ] |
| Clear all users | Authentication, and Overview › Data › Reset | auth | [ ] |
| One account per email address | Authentication | auth | [ ] |
| Refresh | Authentication (live) | auth | [ ] |
| Zero state | Authentication | auth | [ ] |

## Firestore

The official data and requests pages (`components/Firestore/*`).

| Feature (Google UI 1.15) | Where in the console | Owner | Status |
| --- | --- | --- | --- |
| Collection, document and field browser | Firestore › Data | foundation | [ ] |
| Add a collection | Firestore › Data | foundation | [ ] |
| Add a document | Firestore › Data | foundation | [ ] |
| Delete a collection | Firestore › Data | foundation | [ ] |
| Delete a document | Firestore › Data | foundation | [ ] |
| Delete fields | Firestore › Data | foundation | [ ] |
| Clear all data | Overview › Data › Reset Firestore: every database, as a job, no Functions triggers unless asked, open pages reload once at its start and end | observe | [x] |
| Typed editors: string, number, boolean, timestamp, geopoint, reference, map and array JSON | Firestore › Data | foundation | [ ] |
| Collection filter: conditions and sort | Firestore › Data | foundation | [ ] |
| Requests table | Firestore › Rules › Decisions | foundation | [ ] |
| Request detail: the rules code, inspection | Firestore › Rules › Decisions | foundation | [ ] |
| Copy a path | Firestore › Data | foundation | [ ] |
| Database picker | Firestore › Data and Rules | foundation | [ ] |

## Storage

The official files page (`components/Storage/*`).

| Feature (Google UI 1.15) | Where in the console | Owner | Status |
| --- | --- | --- | --- |
| Bucket picker | Storage | storage | [ ] |
| Folder breadcrumbs | Storage | storage | [ ] |
| Upload: button and drag and drop | Storage | storage | [ ] |
| Create a folder | Storage | storage | [ ] |
| Delete selected | Storage | storage | [ ] |
| Delete all | Storage, and Overview › Data › Reset | storage | [ ] |
| Table: name, size, type, modified | Storage | storage | [ ] |
| Multiple selection | Storage | storage | [ ] |
| Side panel with a preview | Storage | storage | [ ] |
| Location: path, URL, token copy and create | Storage | storage | [ ] |
| Metadata | Storage | storage | [ ] |
| Custom metadata | Storage | storage | [ ] |

## Extensions

The official extensions pages (`components/Extensions/*`).

| Feature (Google UI 1.15) | Where in the console | Owner | Status |
| --- | --- | --- | --- |
| Instances table | Extensions | compute | [ ] |
| Detail: parameters, a secret shown on demand | Extensions | compute | [ ] |
| Detail: APIs and resources | Extensions | compute | [ ] |
| Detail: events and their snippet | Extensions | compute | [ ] |
| Detail: access and roles | Extensions | compute | [ ] |
| Detail: README | Extensions | compute | [ ] |
| Detail: related links | Extensions | compute | [ ] |
| Zero state | Extensions | compute | [ ] |

## FireAlerts

The official alerts page (`components/Firealerts/*`).

| Feature (Google UI 1.15) | Where in the console | Owner | Status |
| --- | --- | --- | --- |
| Send a test Firebase Alerts event to functions | Eventarc › Alerts (`/eventarc/alerts`) | compute | [ ] |

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
