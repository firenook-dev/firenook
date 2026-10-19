# The console

[Docs](README.md) · The console

Firenook's own web console: every service the suite runs, live, at `/console` on the UI port.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/console-overview-dark.png">
  <img alt="The console's Overview: the health of every service, recent problems, the data and the engine" src="assets/console-overview-light.png">
</picture>

Firenook has its own console at `/console` on the UI port —
`http://127.0.0.1:4000/console` with the default port (`emulators.ui.port` in
`firebase.json` sets another). It covers every service the suite runs:
Firestore data and security rules, Authentication (users, activity, the
inbox of codes and links, settings), Storage files and rules, Functions with
their invocations and schedules, Extensions, Eventarc, Pub/Sub (topics,
schemas), Cloud Tasks, Logs and an Overview with each section's health,
recent problems, snapshots and resets. It follows the engine live over one
connection per browser, links a thing in one section to where it shows in
another, and works without network access.

Google's Emulator UI is not served since `0.2.0-next.3`. The port's root
sends the browser to the console, and the official UI's addresses
(`/firestore/…`, `/auth`, `/storage/…`, `/extensions/…`, `/logs?q=…`) lead
to the console's page for the same thing; `/api/config`, the logging
WebSocket and the Firestore Requests socket are unchanged for the tools that
read them. The [parity checklist](../support/console-parity.md) maps every
feature of the official UI to the console screen that covers it.

The console answers only for `localhost`, `127.0.0.1`, `::1` and the
`--host` address. Reached by another name — through a reverse proxy, a
tunnel, a container's service name or a cloud host — it answers
"This console does not answer for host …" until that name is allowed:

```sh
npx firenook emulators:start --project demo-my-app --allowed-hosts emulator.internal,dev.example.test
```

Started with `--host 0.0.0.0` (or `::`) and no `--allowed-hosts`, it answers
any host name.

## A look around

| Firestore | Authentication |
| --- | --- |
| <picture><source media="(prefers-color-scheme: dark)" srcset="assets/console-firestore-dark.png"><img alt="Firestore: collections, a page of documents and one open for editing" src="assets/console-firestore-light.png"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="assets/console-auth-dark.png"><img alt="Authentication: users with filters, one open with its profile, security and providers" src="assets/console-auth-light.png"></picture> |
| **Storage** | **Function invocations** |
| <picture><source media="(prefers-color-scheme: dark)" srcset="assets/console-storage-dark.png"><img alt="Storage: a folder of product photos as a grid of thumbnails" src="assets/console-storage-light.png"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="assets/console-invocations-dark.png"><img alt="Function invocations: every call with its trigger, outcome and duration" src="assets/console-invocations-light.png"></picture> |
