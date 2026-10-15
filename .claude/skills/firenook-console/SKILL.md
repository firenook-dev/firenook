---
name: firenook-console
description: How the Firenook console (console/ and crates/console-front) is built. Use when adding or changing console screens, the Console API, its live channel, tests, bundle budget or CI wiring.
---

# Firenook console

The console is the emulator's own UI: a client-only React app in `console/`,
built with Vite, embedded into the engine binary by `crates/console-front`
and mounted under `/console` on the Emulator UI port. It is one product
surface for three deployments (local emulator, self-hosted, cloud), so nothing
in it may assume localhost, a port number or an anonymous operator.

## Stack, pinned exactly

React 19, TypeScript strict, Vite 8 (Rolldown) with the React Compiler
(`react({ compiler: true })`), TanStack Router (file routes, typed search
params), TanStack Query (server state), TanStack Virtual (grids and feeds,
under the kit's own `DataTable`), zod (search params and editors), Zustand
(ephemeral UI state), Kumo on Base UI (components), Tailwind 4 with Kumo's
semantic tokens, Phosphor icons. Not used: TanStack Start (there is no
JavaScript server; the Rust binary serves the app), TanStack Table and Form
(the kit's `DataTable` and plain controlled editors do their jobs), TanStack
DB and Store (pre-1.0), MobX, `dark:` variants, CDN fonts.

## Where state lives

1. Server data: TanStack Query, keyed by scope. Never poll. Live updates come
   from the console channel and patch or invalidate by scope.
2. View state: the URL, through Router search params (path, filters, order,
   selection, tab). Every view is a shareable link.
3. Ephemeral UI state: `src/lib/store.ts` (Zustand): palette, socket status,
   selection sets. Layout choices that should survive a reload live in
   `src/lib/layout.ts` (localStorage per browser).
4. Mutable things outside React (a feed's ring, a request history) reach a
   component through `useSyncExternalStore` with an **immutable snapshot**
   (`FeedStore.snapshot()`, one object per change), never by calling their
   methods while rendering. The React compiler compiles every component and
   hook, in the build and in Vitest alike, and keeps a call's answer for as
   long as its arguments are the same objects: `store.size()` read during a
   render stays at its first answer, because the store is always the same
   store. A function that must read such an object while it renders opts
   out with `'use no memo'` and says why (`FeedList`, `useFeedPending`).

## The shell (`src/components/shell/`)

- Primary navigation is Kumo's `Sidebar`, expanded or collapsed
  (`useLayout.navOpen`, localStorage), always `peekable`: collapsed, the
  labels slide out over the page on hover, as on kumo-ui.com. The foot of
  the nav is Kumo's own `Sidebar.Trigger` (icon only, in a tooltip); `[`
  flips it; ⌘K offers it under "Layout". Only the navigation sits inside
  `Sidebar.Provider`, and the provider's wrapper is `z-30 w-auto shrink-0`
  so the fixed peek overlays the content. (Kumo 2.14's context memo omits
  `peekable`, so never flip that prop at runtime; it is constant here.) The
  expanded width is 14rem through `--sidebar-width` on the provider.
- The section panel is a second column beside the content (`PANEL_WIDTH`,
  264 px). A section fills it by rendering `<SectionPanel label="…">` (a
  portal into the shell's slot, so the section's providers reach it). The
  shell shows the slot only while a section fills it; `t` and the
  section's own `<PanelToggle where="panel" | "toolbar">` hide and show it
  (`useLayout.panelOpen`, remembered). The section places the toggle at the
  head of the panel's first row and at the head of its toolbar(s) — the
  toolbar copy renders only while the panel is hidden — and the panel's head
  is inset like the toolbar (`px-3`), so the two are **one spot** (measured
  to 0.4 px): pressed to hide, pressed again where it was to show. It sat in
  the shell's top bar, which is the console's as a whole (project, engine,
  theme, search). Sections without a panel get the full width.
  The toggle draws **the nav's own glyph** (`PanelIcon` in `components/kit`,
  Kumo's `Sidebar.PanelIcon` geometry with the state passed in — Kumo's
  reads the nav's context), bar where the nav's sits in the same state; the
  palette's two Layout rows use it too. It was Phosphor's `SquareHalf`:
  two marks for one idea. The schema journey compares the paths and the
  bar's `translate` with the nav toggle's (Tailwind 4's translate classes
  set `translate`, not `transform`).
- The content column has no padding of its own. Document-like pages wrap
  themselves in `<Page>` (`page.tsx`, the reading gutter); workbenches fill
  it edge to edge with their own toolbar and borders.

## Speed rules, enforced

- No polling, deltas only.
- Virtualize every long list (rows, log lines, JSON trees).
- First route under 300 KB gzip: `npm run budget --prefix console` reads the
  Vite manifest and fails over budget. Lazy-load CodeMirror, shiki, echarts.
  **Two budgets**: the entry chunk and its static imports (300 KB), and the
  landing route, `/console` — the entry plus the Overview's route chunk and
  its static imports (420 KB), which is what every visit loads before its
  first paint. Other route chunks are not counted, so "it would blow the
  budget" is never by itself a reason to refuse something a route loads
  lazily. Check the manifest before claiming it; the rules editor carried
  that wrong claim in a header comment for months. The Overview's dialogs
  (snapshot, save, reset) load when first asked for, which kept the
  dropdown, dialog, radio, checkbox and danger-confirm chunks off the
  landing route.
- Every script, stylesheet and SVG over 1 KB gets a gzip copy at build time
  (`precompress` in `vite.config.ts`); the engine serves it when the
  request accepts gzip, with `Vary: accept-encoding` (`serve` in
  console-front's `lib.rs`).
- Icons ship three weights, not Phosphor's six: `iconWeights()`
  (`scripts/icon-weights.mjs`, in the app, design-system and kit-harness
  builds) cuts duotone, light and thin out of every icon's `defs` module,
  11 KB gzip off the first route and 2–18 KB off each section route. An
  icon drawn in a stripped weight would render empty, so
  `src/test/icon-weights.test.ts` reads every `weight` the console, the
  design system and Kumo ask for and fails on any other; a new weight goes
  into `ICON_WEIGHTS`, never around the test.
- Assets ship inside the binary with immutable cache headers; the shell is
  `no-cache`. Fonts are self-hosted, never fetched.
- The engine does the heavy lifting (key cursors, index counts, incremental
  listeners); the client stays thin.

## The Console API contract

Rust is the source of truth. Types in `crates/console-front/src/lib.rs`
derive `ts_rs::TS`; `cargo test -p firenook-console-front` writes
`console/src/api/generated/*.ts`, which are committed and checked in CI with
`git diff --exit-code`. Never hand-edit the generated files. Routes live under
`/console/api/v1`; unknown API paths answer JSON 404, never the shell.

**The schema index's walk belongs to the index, not to a request.** It is
started on a detached task and every reader — including the one that
triggered it — waits on the `Notify`. Owning the walk from the handler meant
a reader that went away (a browser navigating, a socket closing, a client
timing out) dropped it mid-flight and left the database marked as building
for ever: `/schema` and `/subcollections` then hung for the life of the
process, while queries and `/status` kept answering, which is what makes it
so confusing to diagnose. There is a regression test; keep it.

**The grid reads previews, not whole documents.** A page of documents
carrying large maps was 30 MB of JSON to paint one screen: the grid draws a
truncated line per cell and the inspector refetches the document anyway, so
every one of those bytes was wasted. `runQuery` sends
`x-firenook-preview: bytes=256; entries=24; keep=<cursor fields>`
(`src/firestore/rest.ts`), and `crates/rest-front/src/preview.rs` cuts
strings, keeps the first entries of a map or array and reports the real size
in `firenookElided` / `firenookCount`. The request path is otherwise
untouched — same query, same rules, same documents — and a request without
the header is byte-for-byte what it always was, so no SDK sees this.
Three rules when touching it: the fields the paging cursor orders by go in
`keep`, or paging lands in the wrong place; `entryCount` is the only way to
count a container, because the entries that arrived are not all of them;
and `isPartial` blocks inline editing, because saving a previewed string
would write the fragment over the value. `isPartial` is **deep**: the cut
happens at every level (a container below depth 1 arrives as its count
alone, a nested string as 64 bytes), and asking only the top let the cell
editor open `payload` with its nested `usage` empty and save it so; the
grid's Copy had the same hole. The inspector is unaffected: it has always
fetched the document itself (2 ms for a 100 KB one).

**The engine does not know its own version.** Every crate here carries the
`0.0.1` workspace placeholder, because the product ships as an npm package
whose version the packaging checkout decides while the binary is built from
the pinned `engineRevision` — a different commit. So never report
`CARGO_PKG_VERSION`. The npm CLI passes `FIRENOOK_RELEASE_VERSION` and
`FIRENOOK_ENGINE_REVISION` at launch (`packages/cli/src/runtime.mjs`);
`firenook_suite_front::EngineRelease` validates them and is what
`firenook --version` and `ConsoleStatus.engine` report. A binary launched
any other way has no release and says "unreleased build" rather than naming
a number — `src/lib/engine.ts` phrases it, and the browser journey declares
a release in `e2e/engine.ts` so the badge has something real to assert.

**Nothing the console opens may outlive the stop signal.** A listener's
graceful drain stops accepting and then waits for the connections it already
holds, with no deadline of its own, so one connection can hold the whole
suite: the engine prints that it is stopping and never exits, the ports stay
taken, and the launcher cannot restart it. Two rules keep that from
happening. A handler that holds a response open ends it on the signal — the
live hub does this with `take_until`, and so do the logging and Requests
sockets; and `serve_until_shutdown` gives the drain `DRAIN_GRACE` and then
closes whatever is still connected, which is what catches a client that
stopped partway through a request. Add a streaming endpoint and it needs the
first rule; the second is already there for everything. `transport_tests.rs`
holds the reproduction beside the fix for both the HTTP and the gRPC side.

## Building a section

Every section after Firestore is built on one foundation: one registry file,
one gate, one page anatomy, one live channel, one list contract, one kit.
This chapter is that contract. The tables in it are written once, here; a
section that needs a row that is not in one amends the table first (a
foundation follow-up), never binds, names or emits around it.

### Where things go

| Section id (route `/<id>`) | Label | Area | Stream | Engine (`crates/console-front/src/`) | Client (`console/src/`) |
| --- | --- | --- | --- | --- | --- |
| `firestore` | Firestore | data | (built) | `firestore.rs`, `rules.rs`, … (flat) | `firestore/` |
| `auth` | Authentication | data | auth | `auth/` | `auth/` |
| `storage` | Storage | data | storage | `storage/` | `storage/` |
| `functions` | Functions | compute | compute | `compute/` | `functions/` |
| `extensions` | Extensions | compute | compute | `compute/` | `extensions/` |
| `eventarc` | Eventarc | messaging | compute | `compute/` | `eventarc/` |
| `pubsub` | Pub/Sub | messaging | messaging | `messaging/` | `pubsub/` |
| `tasks` | Cloud Tasks | messaging | messaging | `messaging/` | `tasks/` |
| `logs` | Logs | observe | observe | `observe/` | `logs/` |
| — (`/`) | Overview | — | observe | `observe/` | `overview/` |

- **Engine: one directory per stream** (`src/auth/mod.rs` plus files inside
  it). `lib.rs` already declares the five `mod` lines, so a stream never
  edits it; a flat `src/auth.rs` would. The suite side is
  `crates/suite-runtime/src/console_wiring/<stream>.rs`, whose lifecycle
  hooks (`HookContext`) are already called at their sites.
- **Client: one directory per section id**, the route's first segment.
  Code two sections of one stream share lives in `src/compute/`,
  `src/messaging/` or `src/observe/`, never in a sibling section's
  directory. Generated types go under `api/generated/<stream>/`
  (`#[ts(export_to = "<stream>/")]`, a service-family name such as
  `AuthUserRow`; `generated_names.rs` fails on a name exported twice).
- **Shared code lives only in `src/lib/`, `src/components/console/` and
  `src/components/kit/`**, owned by the foundation. Need a change there? Ask
  for it; never copy the piece into a section.
- The id is one string everywhere: route segment, `ConsoleStatus.sections[].id`,
  registry file name, first element of every query key (Firestore keeps
  `'fs'`), topic prefix (`auth.users`), badge prefix (`auth.inbox`), entity
  kind prefix (`auth.user`) and API prefix (`/console/api/v1/auth/…`).
- Routes: first page `src/routes/<id>.tsx`; sibling pages
  `src/routes/<id>_.<page>.tsx` (route id `'/<id>_/<page>'`, path
  `/<id>/<page>`); an entity is a search param, never a nested route.

### The registry (`src/lib/sections/<id>.ts`)

One file per section, assembled by `lib/services.ts` in the order of
`lib/section-order.json` (the engine reads the same file). It is in the first
route, so it holds icons, types and pure string helpers only — never a
component import beyond `shellMount`'s lazy one.

- A section joins the registry with its pages, when its journeys pass
  against a real engine; there is no flag for a section that is not
  finished, so a half-built page never ships behind one.
- `pages` (sub-items, each with its own `badges`), `badges` (ids from the
  badge table).
- The section's ⌘K rows (`?new=` and `?dialog=` open dialogs) are not in the
  registry: they live beside it in `lib/sections/<id>-actions.ts`,
  assembled by `lib/palette-actions.ts`, which only the lazy palette
  imports, so their icons stay off the first route (5 KB gzip).
  `links-every-kind.test.ts` opens every action's page with its search.
- `routes` — `kind → (key) => SectionLink`: serves engine search hits and
  every `EntityRef` another section's payload carries (`linkTo(ref)`,
  `useLinkTo`). Keys split at the first `|` (the first three for
  `tasks.task`). `searchLabels` names ⌘K's groups.
- `searchLink` — where "Search <section> for “text”" goes (absent: `?q=`;
  `null`: no such row, as for Firestore, whose `q` is an SDK chain).
- `badgeLink` — where the nav item leads while a counter badge is up
  (`seen.cursor` opens at what is new). `shellMount` — a lazy component the
  shell mounts while the section is ready (a background watcher, a beacon).
- `projectScope` — the section's API and topics take `project`, so
  `?project=` (an app writing to another project id) can show that data.
  `useConsoleProject()` reads it.

### The gate (`components/console/section-gate.tsx`)

Every section route renders `SectionFrame section="<id>"`: the shell banners,
then `SectionGate`, which reads `ConsoleStatus.sections`:

- **absent** → `ServiceNotRunning` with the engine's `detail` and `fixes`
  (the firebase.json lines, `firenook init --adopt`, the developer's own
  command line reprinted with the name added), each a copyable `CodeBlock`;
- **starting** → `ServiceStarting` with what it waits for; the page fills in
  by itself when the `shell` topic says ready (no reload);
- **ready** → the page, and the section's and the open page's badges are
  marked seen while it is mounted and visible.

A feature that needs another section says so with `RequiresNotice`
(absent: why and How to start it; starting: works as soon as it is up); the
section it names links to that section's page (its gate, or the page that
fills in). Never present a section, or a feature of one, as working before
its journeys pass.

Every `EntityRef` kind the engine constructs resolves to a page that takes
its search: `crates/suite-front/src/entity.rs` pins one sample per kind into
`src/lib/entity-kinds.json` (regenerate with `FIRENOOK_WRITE_ENTITY_KINDS=1
cargo test -p firenook-suite-front entity`) and `src/lib/links-every-kind.test.ts`
resolves each through the registries and the route tree. A new kind needs a
constructor, a sample and a `routes` entry. A `SearchSource` may answer for
another section's kinds (compute's finds Extensions instances): ⌘K labels
and draws each hit by the section its kind belongs to.

### Page anatomy

```
SectionFrame → SectionPage (h-full flex-col overflow-hidden; sr-only h1)
├── SectionPanel (optional; portal into the shell's 264 px column)
│   ├── PanelHeader: PanelToggle(where="panel") · ScopeSelect
│   ├── PanelFilter
│   └── PanelTree (virtualized; no footer, ever)
├── SectionToolbar
│   ├── ToolbarRow (row one): PanelToggle(where="toolbar") · scope/path field
│   │     │ ToolbarDivider │ LiveNotice · identity │ ToolbarDivider │ primary action
│   └── ToolbarRow variant="line" (row two): FilterField · MatchCount · row actions · PauseButton (feeds)
│         └── SelectionBar laid over row two while rows are ticked (never swapped in)
├── SectionBanner* / RequiresNotice (only when true, one line each)
└── SectionBody (relative flex min-h-0 flex-1)
    ├── DataTable | FeedList | editor (flex-1) └── TableFooter
    └── Inspector (absolute below xl, in the flow from xl; width per widthKey)
```

| Piece | Classes (the kit applies them; never re-derive) |
| --- | --- |
| Row one | `flex h-11 shrink-0 items-center gap-1 border-b border-kumo-line bg-kumo-base pr-2 pl-3` (38.5 px at the 14 px root, Firestore's) |
| Row two | outer `grid shrink-0 border-b border-kumo-line bg-kumo-base`, inner `box-content flex min-h-8 items-center gap-2 overflow-x-auto px-3 py-1.5` |
| Field | `flex h-8 min-w-0 flex-1 items-center rounded-lg pr-0.5 focus-within:bg-kumo-control focus-within:ring focus-within:ring-kumo-focus hover:not-focus-within:ink`; `ring ring-kumo-danger` at rest when invalid |
| Divider | `mx-1.5 h-5 w-px shrink-0 bg-kumo-line`, only between two groups that are both on screen: `LiveNotice divider="before"` draws its own, so a notice that is absent leaves no stray rule |
| Scope (a name, not a path) | `ToolbarScope`: 12 px medium, its `detail` quiet after it ("All functions", "Users · No tenant", "Task queues demo-…") |

**The inspector** (`Inspector`, `InspectorTitle`, `InspectorSection`,
`InspectorFooter`): header 44 px with the title (an entity's key in the data
face, 12 px mono, copyable; an English title is `PanelTitle`), meta, icon
actions in tooltips, previous/next with the row's `noun`, close. It follows
the table's cursor (`DataTable` moves its cursor to a changed `openKey`;
`onCursorChange` is how an open inspector follows ↑ ↓). Tabs are
`Label · N`; facts are `KeyValueList`; payloads `JsonTree`/`JsonView`/
`PayloadView`; an empty section is its heading alone (`Sessions · none`).
Footer: tools left, destructive as a ghost button with red children, primary
right; below 350 px the least important control gives up its word
(`useInspectorRoom().labels`), by width, never by rule. Escape closes it
before it clears a selection. One `widthKey` per inspector (`auth.user`).

Empty, loading and error: `EmptyState` (with `connect: { service }`, the
connection snippet for this engine, and the project the app writes to when
the engine has seen it use another; a section with an API to call teaches
it with a `CodeBlock` and a primary main button), `NoMatch` (its `children`
add what only the page can say — Logs names the filter that hides how many
lines), `QueryError` (the engine's message as the title, its fix under it,
Retry), `TableSkeleton` and `DataTable loading` (both after 150 ms, so a
fast answer never flashes). **One loading pattern per kind of surface**: a
table or a feed shows its skeleton rows (a feed under its `FeedHeader`); a
pane that is not a list shows the Firestore grid's centred secondary line;
the word is always "Loading …"; a page that waits for its scope (Storage's
buckets) draws its frame — panel and both toolbar rows — and puts the
skeleton where the list goes.

Tables and feeds share one header band: 33 px with its rule, 12 px medium
(`DataTable`'s header controls are 18 px; a feed's `FeedHeader` is the same
band). A list's status bar is `TableFooter` ("N loaded") or, for a feed,
`FeedFooter` ("N loaded · the engine keeps the newest N …"). The column
settings cell pinned to the right draws its edge (`PIN_EDGE_END`) while
columns lie beyond it. Clearing what a page holds is `ClearHistoryButton`
(ghost, glyph and word in the danger tone) everywhere.

Below `xl` an open inspector floats over the list, and the section panel
steps aside while it is open (`panelShown` in `lib/layout.ts`; the
person's choice is untouched and comes back when the inspector closes;
the toggle shows the panel anyway). An inspector's tabs are always the
kit's segmented `tabs` under the header, never underline tabs in the
title or the body.

### The live channel

- **Never `new EventSource` in a section.** The lint rule
  (`no-restricted-globals`, off only in `src/lib/live/**`) and the engine's
  `only_live_streams` test enforce it. Over plain http a browser allows six
  connections to the console's address, shared by every tab and request; one
  stream per page, then one per tab, queued the console's own requests
  behind its streams. One visible **leader tab** holds the browser's only
  `GET /console/api/v1/live`; other tabs ride it over a `BroadcastChannel`;
  a tab opened in the background takes nothing until it is shown, and a tab
  hidden for 20 s gives its subscriptions back (`releaseMs`; journeys
  shorten it with `localStorage['firenook.console.live-timing']`).
- Subscribe with `useLiveTopic(topic, params, handlers)` (handlers by ref;
  `params: null` = not now) or, for keys to invalidate,
  `useInvalidateOn(topic, params, { keys, resetKeys })` (a leading and a
  trailing edge per key). Declare a topic in `src/<id>/live.ts`: augment
  `TopicMap` (`declare module '@/lib/live/topics'`) and call
  `declareTopic('<topic>', 'replay' | 'compare' | 'none')`.
- **Resume kinds.** `replay` — the subscriber resumes from its cursor and
  gets what it missed (`tick` moves the cursor alone); a cursor that left the
  ring gets `reset gap` with `missed`. `compare` — a state topic sends its
  snapshot on open and shares one engine subscription per parameters across
  the browser. `none` — invalidation only. A subscription that waited without
  a cursor (opened in a background tab, given back while hidden, ended before
  it had one) is told `reset gap` once it is taken, so its page reloads what
  it shows.
- **Payloads are keys, not entities** (ids, paths, counters), except feeds,
  whose content is the point. The engine coalesces per subscriber, at most
  one event per subscription per 100 ms, deduplicating keys; past 1,000
  keys in a window it sends `reset`. A feed topic takes `q` (the shared
  grammar) and the engine filters replay and live tail; the client never
  filters a feed. Feeds batch under `items` (≤ 1,000 a window) through
  `replay_topic` + `ReplayOptions { filter, shape, max_items, max_bytes }`.
- Bounds (§6.6 of the foundation spec): 64 connections per engine (the 65th
  is `429`, "too many console tabs"), 128 subscriptions per connection, an
  outgoing queue of 256 events and 8 MiB (overflow → `reset lagged`), rings
  10,000 entries / 8 MiB by default and 64 MiB together (`RingBudget`). Every
  stream ends on the stop signal (`stopping`, then the end).
- A restart (a new engine instance) invalidates every query, clears
  selections and toasts "The engine restarted"; a new instance of another
  build (`consoleBuild`/`engineRevision`) changes nothing and the shell asks
  for a reload instead. `LiveNotice` (`onRetry={() => liveChannel.retry()}`)
  is for one subscription the engine ended or refused; the channel's own
  state is the engine badge's, said nowhere else.

### Lists

- The engine pages: `Page { items, nextCursor, prevCursor, total, scanned }`,
  opaque cursors both ways (`PageQuery { cursor, before, limit, q, sort }`),
  100 by default, 500 at most. `ListMeta` says which columns sort (only where
  an index answers) and the filter's `fields`. An unindexed filter scans at
  most a `ScanBudget` (200,000 items or 30 ms) per request and keeps the
  sorted keys in the `ResultCache` (LRU 8, dropped when the revision moves),
  so later pages and live refreshes slice instead of scanning;
  `Total.exact: false` and `scanned` say how far it got (`MatchCount`).
- The client: `cursorPagesOptions(key, fetchPage)` + `useInfiniteQuery` +
  `useCursorRows(query, { queryKey, fetchPage, rowKey, batchGet, q, sort })`
  → `DataTable` (`rows`, `rowOffset`, `hasMore`/`loadMore`,
  `hasPrevious`/`loadPrevious`, `total`, `flashes`). Live keys go to
  `rows.applyKeys` (patched in place through `POST …:batchGet`, ≤ 1 request
  per 120 ms; only the page a created row falls in is read again); `reset`
  and `end` → `rows.reset()`. **Never refetch every page.** The window holds
  at most 20 pages; scrolled back, a dropped page is read again.
- Footer: `TableFooter` + `useHiddenColumnCount(memoryKey, columns)`.
  Selection: `<ToolbarRow variant="line" overlay={selecting && <SelectionBar …/>}>`.
  Feeds: `FeedList` over `createFeedStore` (a ring, one notification a frame;
  `useFeed(store)` hands out its `FeedSnapshot` — size, version, dropped,
  pending), `useFeedPending` for `PauseButton`. A second table on one page:
  `keyboard="focus"`.

### Shared engine services

- **Jobs** (`JobRegistry`): bulk work answers `202` with a `Job` at once
  (`accepted(job)`); `JobHandle` reports `progress`, `skipped`,
  `failed_item_with` (first 20 kept, the count exact) and checks
  `cancelled()` between batches. 4 running per section, 1 for `suite.*`;
  the next is `409 conflict`. Targets are `BulkTarget` (`keys` or
  `Query { q, scope }`). Progress rides the `jobs` topic only; the
  `<section>.jobs` badge is automatic; `useJob`, `useJobs`, `cancelJob`.
- **Streamed answers and files**: `ndjson_response(items, shutdown)` flushes
  per item and ends on stop; `attachment(filename)` for downloads (unicode
  names encoded); `lib/download.ts` on the client.
- **Links between sections**: `EntityRef { kind, key, label? }`, built only
  through `entity.rs`'s constructors; rendered with `EntityLink` (plain text
  while the target section is absent from the engine).
- **The guard** (`guard.rs`, on the whole mount): a change is JSON, or
  carries `x-firenook-console` (`[a-z0-9-]{1,16}`) for a binary body — a
  bodiless POST is a simple request any page can send; `Sec-Fetch-Site`
  must be same-origin; `/live` and WebSocket upgrades check `Origin`; the
  `Host` must be allowed (`--allowed-hosts`).
- **Native mounts** (a service under `/console/api/v1/<id>/native`) are
  `forwarded()`: sandboxed (`Content-Security-Policy: sandbox`, `nosniff`),
  because a service's HTML is otherwise a document on the console's origin;
  a link to what a service serves for an app goes to its own port
  (`serviceAddress`).
- **Section hooks**: `Section::summary` (the Overview's figures) and
  `Section::clear` (`POST /suite/clear`); suite controls (`/suite/background`,
  `/suite/destinations`, `/suite/export`); `ForeignProjects` and
  `projectScope`.
- **Late services**: a service that starts after the console is a `Late<T>`
  (`get()` answers `ApiError::starting` with its label until `set`);
  `late_native` serves a native mount the same way; a topic waits for it.

### Errors, paging, filters, search, badges

- **One error shape**: `{ error: { code, message, fix? } }` from `ApiError`
  (`api_error.rs`); codes are kebab-case (`not-found`, `invalid-argument`,
  `permission-denied`, `resource-exhausted`, `unsupported-media-type`,
  `conflict`, `starting`, …). The client's `ApiError` reads `code` and `fix`
  and maps Google-style bodies too. `ConsoleJson` for bodies (413/415/400
  with the serde message).
- **One filter grammar**: `filter.rs` ⇄ `lib/filter.ts`, held to
  `src/lib/filter-cases.json` by both (`filter::golden::run`,
  `runGoldenCases`). **A grammar change edits the golden file first.**
  Messages and UTF-16 spans are exact; a section's own fields keep a cases
  file of their own beside its code, run with
  `describe('…', () => runGoldenCases(cases))`. `FilterField` takes
  `ListMeta.fields` plus `suggest` functions.
- **Search**: a section adds a `SearchSource` (exact and prefix hits from its
  own indexes, substrings within a budget, a cancel flag; 5 hits a section by
  default; never a
  walk the page itself would not start). Page providers that list entities
  set `PaletteItem.ref` so ⌘K shows a thing once.
- **Badges**: a `BadgeHandle` per badge (`set`, `add`, `add_at` with a
  cursor), O(1), coalesced to ≤ 4 a second on the `shell` topic.
  `useLocalBadge` for a tab's own (uploads).

### Keyboard (one registry)

`useShortcuts({ id, label }, shortcuts)` registers a scope; the shell's one
listener dispatches, the most recently mounted scope first; `?` lists what
can be pressed now. Single keys stand aside in fields, menus, dialogs and
while an editor is open (`useEditing`). The reserved keys — no stream binds a
key outside this table:

| Key | Scope | Does |
| --- | --- | --- |
| ⌘K / Ctrl+K | shell | Palette |
| `[` | shell | Collapse / expand the sidebar |
| `t` | shell | Hide / show the section panel |
| `?` | shell | Keyboard shortcuts |
| `/`, `f` | page | Focus the page's filter field (Firestore: `/` edits the path, `f` the query) |
| `n` | page | The page's primary create action (`?new=…`) |
| Escape | page | Close the overlay → the inspector → clear the selection → blur the field |
| ↑ ↓ / ← → | table | Row / cell cursor; an open inspector follows |
| Home / End, PgUp / PgDn | table | First / last loaded row; one viewport |
| Enter / Space | table | Open the cursor row / tick it |
| ⌘A / ⌘C | table | Tick every loaded row / copy the cursor cell's copy value |
| Delete / Backspace | table | Delete the ticked rows (through `DangerConfirm`) |
| Shift+F10, ContextMenu | table | The cursor row's `RowMenu` |
| ↑ ↓ (`j` `k`), Enter | feed | Move / open the selected row |
| End / Home | feed | The live edge (and follow) / the oldest kept row |
| → / ← | feed | Expand / collapse the selected row |
| `p` | feed | Pause / resume (`PauseButton`) |
| `e` | feed | Errors only (Logs `level:error`, Activity `is:error`, Invocations `outcome:failed`, Eventarc `delivery:failed`) |
| `c` / Shift+C | feed | Copy the row's primary value / the row as JSON |
| `r` / Shift+R | row | Run again / edit, then run again |
| `o` / `l` | row | Open the row's target / open in Logs |
| `i` | Functions | The Run tab |
| `g` | Firestore, Storage | Scope flip (collection group; flat listing) |
| `e` | Firestore | Explain |
| `v`, `u` / Shift+U, ⌘L, Shift+Space, F2, ⌥⌘C | Storage | Layout; upload files / a folder; path field; Quick Look; rename; copy the path |
| F8 / Shift+F8 | rules pages | Next / previous problem |
| `w`, `x` | Logs | Warnings and errors; clear the view |
| `a` | Auth Inbox | Apply the selected code or link |
| `a` / `x` / `e` | Pub/Sub Pull, on a received row | Ack / nack / extend |
| ⌘↵ / ⌘S | editors, composers | Send or apply / save |

### Vocabulary

**Search params** (zod `validateSearch`, read through `useRouteSearch`;
defaults never in the URL):

| Param | Meaning |
| --- | --- |
| `q` | The page's filter in the shared grammar (Firestore's is its SDK chain) |
| `sort` | `<column>:asc\|desc`, server-side order (`zSort`, `parseSort`, `printSort`) |
| entity noun | The item open in the inspector by its key: `user`, `object`, `function`, `invocation`, `instance`, `event`, `message`, `task`, `entry`, `schedule`, `decision`, `queue`, `topic`, `subscription`, `schema` (Firestore: `doc`) — never abbreviated |
| `tab` | Only the inspector's tab |
| `view` | The main area's tab of a scope |
| `layout` | A display mode (Storage list / grid) |
| `panel` | A side panel of tools (rules pages, Auth try/inspect) |
| `state`, `outcome` | A single-choice switch with counts, named after its field |
| `db`, `bucket`, `codebase`, `channel`, `queue`, `location`, `topic`, `tenant` | The scope picker's value |
| `path` | A path inside the scope |
| `as` | The identity requests run as (`serializeViewAs` / `parseViewAs`) |
| `new`, `dialog`, `prefill` | Open the create dialog / another dialog / fill it from an item |
| `source` | Compute's test-event source |
| `paused` | `true` when a feed is paused (`zFlag`; never `live=false`) |
| `project` | Another project the app used (`projectScope` sections only) |
| `from`, `to` | A time window (RFC 3339 or relative, `-15m`) |

**Topics** (`<section>.<noun>`; `tick`, `reset`, `end` reserved):

| Topic | Params | Events | Resume |
| --- | --- | --- | --- |
| `shell` | `{}` | `status`, `badges` | compare |
| `jobs` | `{ section? }` | `job` | replay |
| `firestore.changes` | `{ database?, scope? }` | `change` | replay (path-only ring) |
| `firestore.rules` | `{ database? }` | `rules`, `file` | compare |
| `auth.users` | `{ project?, tenant? }` | `changed`, `cleared` | none |
| `auth.activity` | `{ project?, tenant?, q?, console? }` | `calls` | replay |
| `auth.inbox` | `{ project?, tenant?, q? }` | `messages` | replay |
| `auth.config`, `auth.hooks` | `{ project? }` | `changed` | none |
| `storage.objects` | `{ bucket, prefix? }` | `changed`, `index` | replay |
| `storage.rules` | `{ bucket? }` | `rules`, `file` | compare |
| `storage.decisions` | `{ bucket?, name?, q? }` | `decisions` | replay |
| `functions.events` | `{ function?, codebase?, q?, changesOnly? }` | `batch` | replay |
| `functions.invocation` | `{ id }` | `snapshot`, `log`, `chunk`, `finished` | replay |
| `functions.codebase-log` | `{ codebase }` | `lines` | replay |
| `eventarc.events` | `{ channel?, q? }` | `batch` | replay |
| `extensions.changes` | `{}` | `changed` | none |
| `pubsub.counters` | `{ project?, throughput? }` | `counters`, `resources`, `rejected` | compare |
| `pubsub.topic` | `{ project?, topic, subscription? }` | `published`, `stale` | none |
| `pubsub.push` | `{ project?, subscription }` | `attempts` | replay |
| `pubsub.deliveries` | `{ project?, topic }` | `changed` | none |
| `pubsub.schedules` | `{ project? }` | `schedules` | compare |
| `tasks.counters` | `{ project? }` | `counters`, `queues` | compare |
| `tasks.queue` | `{ project?, queue }` | `stale`, `finished` | none |
| `tasks.attempts` | `{ project?, queue?, task? }` | `attempts` | replay |
| `logs.entries` | `{ q?, from?, to? }` | `entries` | replay |
| `overview` | `{}` | `state` | compare |

**Badges** (no badge outside this table):

| Id | Kind | Tone | Shown on |
| --- | --- | --- | --- |
| `firestore.rules` | gauge | danger | Firestore › Rules |
| `firestore.denials` | counter | neutral | Firestore › Rules |
| `auth.inbox` | counter | neutral | Authentication › Inbox |
| `storage.rules` | gauge | danger | Storage › Rules |
| `<section>.jobs` | gauge | neutral | the section's item (automatic) |
| `storage.uploads` | local | neutral | Storage (this tab) |
| `functions.failed` | counter | danger | Functions › Invocations |
| `functions.load` | gauge | danger | Functions |
| `pubsub.rejected`, `pubsub.dead-lettered` | counter | attention | Pub/Sub › Topics |
| `tasks.failed` | counter | danger | Cloud Tasks |
| `logs.errors` | counter | attention | Logs |
| `shell.foreign` | gauge | danger | the shell banner and the engine badge's dot |

**Entity kinds** (`EntityRef`, keys split at the first `|`):
`firestore.collection` `<db>|<pattern>` · `firestore.document` `<db>|<path>` ·
`firestore.decision` `<db>|<requestId>` · `auth.user` `<tenant>|<uid>` ·
`auth.call` · `auth.message` · `storage.object` `<bucket>|<name>` ·
`storage.folder` `<bucket>|<prefix>` · `storage.decision` `<bucket or *>|<id>` ·
`functions.function` · `functions.invocation` · `functions.codebase` ·
`extensions.instance` · `eventarc.event` · `eventarc.channel` · `pubsub.topic`,
`pubsub.subscription`, `pubsub.schema` (full resource names) ·
`pubsub.message` `<topic>|<id>` · `pubsub.schedule` `<function id>` ·
`tasks.queue` `<project>|<location>|<queue>` ·
`tasks.task` `<project>|<location>|<queue>|<id>` · `logs.entry` `<cursor>`.
Filtered Logs links are `linkToLogs({ function?, execution?, instance?,
service?, level?, from?, to?, entry?, since? })`, never hand-spelled.

**Headers** — one `x-firenook-*` family: `x-firenook-console` (every console
request; Auth's `write`/`try`/`replay`), `x-firenook-cause-<kind>` (what made a
function run), `x-firenook-activity` and `x-firenook-execution` (answers, only
to a request that asked), Storage's `x-firenook-metadata`/`-keep-tokens`,
Firestore's `x-firenook-preview`. All are stripped before user code.

**Toasts and long requests** — `toast()` from `lib/toasts.ts`: three at most
(the oldest goes), the same `key` replaces in place, a replayed event or the
console's own echo is not toasted; the stack floats above the page's footer
band. A tab runs at most three long requests besides the one `/live`
(`lib/long-requests.ts`; uploads, an invoke stream, a composer's streamed
answer take a slot).

### Names

The only spellings: `useLiveTopic`, `useInvalidateOn`, `useCursorRows`,
`IdentityPicker`, `SectionBanner`, `ShellBanners`, `FilterField`,
`MatchCount`, `ToolbarDivider`, `LiveNotice`, `RequiresNotice`, `PauseButton`,
`MaskedValue`, `RowMenu`, `FacetList`, `CodeBlock`, `EntityLink`,
`DangerConfirm`, `ConfirmPopover`, `CodePopover`, `SectionJobs`,
`FeedTime`, `ExportDialog`, `OutcomeChip`, `LogLine`, `MiniBars`,
`JobsWatch`, `routes`, `badgeLink`, `shellMount`, `linkTo`, `linkToLogs`,
`resolveAuthorization`, `identityKey`, `useTriggersFor`, `useLocalBadge`,
`useJobs`, `toast`, `copyToClipboard`, `errorText`, `clockTime`,
`createRecents`, `connectSnippet`, `connectDialects`, `CODE_DIALECTS`,
`codeTab`, `FLASH_MS`, `ApiError`, `api_error.rs`,
`ConsoleJson`, `EntityRef`, `Job`, `BulkTarget`, `JobRegistry`,
`SearchSource`, `ReplayOptions`, `replay_topic`, `ComputeParts`,
`ForeignProjects`, `HookContext`, `Section::summary`, `Section::clear`. A
second name for one of these is sent back in review.

### The kit

Import each module by its path (`@/components/console/data-table`), never a
barrel, so a route chunk carries only what it uses. The shell imports only
`components/kit` and `lib/*`; everything in `components/console/` loads in
route chunks. Identity: requests run as a `ViewAs` through
`resolveAuthorization`/`fetchAs` (the engine mints a user's token; never
`mintUnsignedToken` directly); `IdentityPicker` picks it. Requests:
`components/console/request/` (`requestAsCode`, `useRequestHistory`,
`ResponseView`; an invoke streams through the engine,
`functions/invoke-stream.ts`). Copy as code is `CodePopover`
(`components/console/code-popover.tsx`): a footer's Code button and a
`CodeBlock` with a tab per dialect, labels from the one list
`CODE_DIALECTS` (`request/as-code.ts`, through `codeTab(id, code)`), a
note under it, and the last tab remembered per `kind`. Every piece has a
design-system card (`console/design-system/src/cards/`, one file per
stream, loaded by glob). A few behaviours worth knowing:

- **Running the app's code again asks in a popover, destroying data in a
  dialog.** `ConfirmPopover` (`components/console/confirm-popover.tsx`) is
  the one confirmation for a replay, a run now, a run or enqueue again: a
  popover beside the row (`rowElement(testId, key)`) or the button, the
  page's upper middle when neither is there; `r` opens it, Enter confirms,
  the caller's words say what runs again; an `option` (Eventarc's "Keep the
  id") and the run's own pending and refusal (`errorText`) live in it.
  `useConfirmPopover().ask(request)` is the page's one popover for
  whoever asks. `DangerConfirm` stays the dialog that deletes.
- A section's bulk work is `SectionJobs` (`components/console/section-jobs.tsx`)
  under its toolbar: `section`, an optional `filter`, the `verb` its items
  are counted with, Cancel (or `cancelLabel`), a bar while the total is
  known, a summary for `summaryMs` (4 s) once it ends, "See why" over the
  failed items with the section's own `why(error)` beside each, and
  `onEnded` to read lists again; a job that failed or stopped says why.
  Test ids: `<testId>s`, `<testId>`, `-progress`, `-message`, `-cancel`,
  `-see-why`. Its card is `design-system/src/cards/console-shared.tsx`.
- `DangerConfirm` draws `DangerConfirmBody`, which is exported: a card (or
  any page that needs the confirmation at rest) draws the real body framed,
  handed a `Job` instead of subscribing. `TriggerLineItem` and
  `triggerLine` are the trigger line any destructive dialog draws
  (Firestore's delete dialog uses them).
- `StatusDot` keeps its width; let it shrink (`className="min-w-0
  shrink"`) and its word ends in an ellipsis. `OutcomeChip` keeps its width
  beside a truncating sibling; `shrink` lets it give way (put the whole word
  in `detail`).
- Custom claim keys come from `lib/claim-keys.ts` `useClaimKeys(project)`
  (the engine's claim index, asked when completion opens): `fresh` for a
  rules editor's `rulesCompletion.claims`, `now` for `JsonField`'s
  `completeKeys`.
- A design-system card whose views subscribe to a live topic (a trigger
  line holds `functions.events`) calls `quietLiveChannel()` from
  `cards/shared.tsx` in its providers, so nothing opens a connection; and
  answers any API read from the query cache. `npm run design-system` fails
  on any browser error.
- Times have one formatter each way (`lib/format.ts`): `clockTime(at,
  'minute' | 'second' | 'ms')` is the wall clock (`14:02`, `14:02:11`,
  `14:02:11.348`, local), `formatClock(iso, format)` a feed's time in the
  console-wide clock setting (`useClockFormat`: time, relative or UTC),
  `clockOrDate` the time today and the date before it on another day,
  `pad` the one zero-padder. A feed row's time cell is `FeedTime`
  (`components/console/feed-time.tsx`: the setting, the other forms on
  hover); a fact's age is `RelativeTime`. Never slice a formatted time.
- "Connect your app" has one tab list, `CONNECT_TABS` in
  `lib/connect-tabs.ts` (each tab's `?connect=` value, generator target,
  label and title; data only, because the Overview's route schema reads
  it in the first route). `connectSnippet(target, …)` writes one snippet;
  `connectDialects(status, { services, params? })` in `lib/connect.ts`
  gives a `CodeBlock` its tabs from that list (an empty section shows
  `EMPTY_CONNECT`: web, node, python, go).

### End-to-end

- `scripts/synthetic-engine.mjs` `startEngine({ profile, project, only, wait,
  seed, fixtureEnv, env, launchContext, args, uiPort, keepDirectory })` — a
  real engine on free ports (held until spawn) with the launch context the
  npm CLI would pass; `npm run engine -- --profile <name>` runs one for
  development. `stop()` removes the engine's project directory (15–75 MB
  each; a suite run starts hundreds), and so does a start that fails;
  `keepDirectory` keeps it past `stop()` for another engine to start on what
  this one saved, and `remove()` takes it away (`dedicatedEngine` keeps
  each journey's until the journey ends). `FIRENOOK_KEEP_ENGINE_DIR=1` keeps
  them all, to look at what an engine wrote.
- CI builds the engine once and runs each Playwright project as its own job
  (`console-journeys` in `.github/workflows/ci.yml`): the whole suite is
  about 17 minutes on 12 cores, more than one runner's budget.
- **Profiles** (`scripts/profiles/<name>.mjs`: data, auth, storage, compute,
  messaging, observe, all) say what runs, which **fixtures** write the
  project (`scripts/fixtures/<name>.mjs`) and which **seeders** fill it
  (`scripts/seed/<name>.mjs`; people come from `SEED_USERS`).
  `FIRENOOK_SEED_SCALE=large` asks for the perf datasets.
- One Functions codebase (`scripts/fixtures/functions/`): `index.js` plus a
  file per stream, chosen by `FIXTURE_STREAMS`. The fixture writes the
  profile's `fixtureEnv` to `.env` and to `fixture-env.json`, and the codebase
  reads the JSON first, because the emulator gives `.env` to running
  functions but not to the discovery that lists them. The SDK is installed
  offline: `npm run e2e:sdk` once (CI runs it).
- One Playwright project per stream, each with a worker engine of its
  profile (`e2e/fixtures.ts`): import `test`/`expect` from `./fixtures`; a
  journey that stops, restarts or slows an engine takes `dedicated` and
  `dedicatedEngine()`, in a spec file that sets `workerEngine: false` at its
  top level so the host runs one engine at a time. Helpers live in
  `e2e/support/` (`look`, `clipboard`, `downloads`, `live` — `dropLive`
  drops the channel through its own release path, since `page.route` leaves
  an open `EventSource` alone — `api`, `shell`). Run one project:
  `npx playwright test --project <name>`; perf journeys:
  `FIRENOOK_PERF=1 FIRENOOK_SEED_SCALE=large npx playwright test --project shell --grep @perf`.
- The kit's own primitives are measured on the **kit harness**
  (`e2e/kit-harness/`: FeedList as Logs draws it, JsonView as an inspector
  does). `e2e/support/kit.ts` builds it with the console's plugins in
  production mode (`buildKitHarness`) and serves it under the engine's
  `/console/__kit/` (`openKitHarness`), so it takes the console's fonts; the
  page answers through `window.__kit` (types in `kit-harness/runs.ts`, the
  one file both TypeScript projects check). A stream measures its own page
  at load in its own spec; the harness is for what a page is built from.

### Who edits what

| Files | Owner and rule |
| --- | --- |
| `crates/console-front/src/{lib.rs, section.rs, live/*, paging.rs, filter.rs, search.rs, jobs.rs, suite.rs, entity.rs, api_error.rs, http.rs, guard.rs, json.rs}` | Foundation only; streams ask for follow-ups |
| `crates/console-front/src/{firestore.rs, rules.rs}` | Only the scheduled isolated commits (observe's `announce_rebuilt` and `summary`/`clear` in `observe/firestore_data.rs`; auth's claim reads) |
| `crates/console-front/src/<stream>/` | That stream only |
| `crates/suite-runtime/src/lib.rs`, `project_scope.rs` | Foundation only (the hooks are pre-placed: streams edit `console_wiring/<stream>.rs`) |
| `crates/functions-bridge` | Foundation; compute#1 (`explain_match`, cause headers, `note_dropped`); observe's maintenance-commit rule |
| `crates/rules-engine` | Storage in `analysis.rs`, auth in `claim_reads.rs`, `lib.rs` re-exports only |
| Service crates | Their stream; another stream's one-liners only through compute#1 |
| `console/src/{lib/*, components/console/*, components/kit/*, components/shell/*}` | Foundation only, except the isolated shared-component commits and compute's `lib/triggers.ts` |
| `console/src/lib/sections/<id>.ts` | That section (Firestore's and Logs' as scheduled) |
| `console/src/firestore/**` | In order only: foundation → storage #11 → auth #20 → compute #16 → observe |
| `routeTree.gen.ts`, `api/generated/**` | Never hand-merged; regenerate (`npm run build`, `cargo test -p firenook-console-front`) |
| `scripts/synthetic-engine.mjs`, `e2e/fixtures.ts`, `e2e/engine.ts`, `playwright.config.ts`, `scripts/fixtures/functions/index.js` | Foundation only |
| Profiles, fixtures, seeders, `e2e/support/<stream>.ts`, `design-system/src/cards/<stream>.tsx`, `scripts/fixtures/functions/<stream>.js` | One file per stream |
| This file | Per-stream headings below; the shared tables here are the foundation's |
| `ROADMAP.md` | Each stream replaces only its own line |
| `Cargo.lock`, `console/package-lock.json` | Foundation; streams add `workspace = true` lines only |

### Merging

`routeTree.gen.ts` is regenerated, never merged (take either side, run
`npm run build`); generated types are regenerated by the crate tests, never
merged; after a merge that touches `package-lock.json`, `npm ci`. Each
stream edits its own engine module, wiring file, registry file, profile,
fixture, seeder, cards file and heading in this skill, so a merge meets the
shared files only where a follow-up was asked for.

### What building the foundation taught

- HTTP/1.1 allows six connections per origin; that is why the channel exists,
  and why one per *tab* was not enough: background tabs held theirs.
- `page.route` does not close an `EventSource` that is already open, so
  journeys drop the channel through the product's release path
  (`dropLive`), never a hook.
- A POST without a body is a simple request any page on the web can send:
  console changes take JSON and the guard enforces it. WebSockets bypass
  CORS, so an upgrade checks `Origin`. A mounted service's HTML is a document
  on the console's origin unless it is sandboxed.
- `include_str!` reads the shared golden file and the section order, so Rust
  and the browser cannot drift apart.
- A `watch` is the right channel for state (status, badges), a `broadcast`
  for events, a `ReplayRing` for feeds; a global revision is not a per-scope
  cursor.
- `tokio::time::timeout` around `spawn_blocking` abandons the wait, not the
  work.
- The Auth emulator's `accounts:query` cannot be bounded (`501` for `limit`),
  so pickers use `/auth/identities`.
- Kumo's menu button paints its hover ground as an absolute `::before` over
  the row: anything inside the row that must take the pointer (a badge's
  tooltip) is positioned to sit above it.
- Kumo's `Sidebar` turns into its mobile, off-canvas form below its
  breakpoint, also inside a contained preview; a card that draws the nav is
  wider than that.
- A worker-scoped Playwright option cannot change inside a `describe`; it
  forces a new worker and is refused. Set it at a spec file's top level.
- A frame-time measurement from a scroll driven by a round trip per step
  measures the round trips: drive the scroll inside the page
  (`requestAnimationFrame`) and measure after the engine's first schema walk.
- Tests of uncompiled code passed while every production `FeedList` drew
  nothing that arrived after it mounted: the compiler had cached
  `store.size()` by the store's identity. Vitest now compiles with the React
  compiler, and the kit's perf journeys run a production build of the kit.
- `toLocaleString('en-US')` builds a number formatter per call (about 20 µs);
  a tree of a hundred shut rows paid 11 ms for it. `formatNumber` keeps one.

## Commands

```
npm run dev --prefix console          # Vite with HMR, proxies /console/api to FIRENOOK_UI_ORIGIN (default http://127.0.0.1:4000)
npm run build --prefix console        # writes console/dist; debug engine builds read it from disk at runtime
npm run check|lint|format:check|test|budget --prefix console
npm run engine --prefix console -- --profile all   # a synthetic engine with every service, fixture and seeder
npm run seed --prefix console -- <ui-origin> <project>   # the Firestore seed into a running engine
npm run e2e:sdk --prefix console      # the offline Functions SDK the fixture codebase links (once)
npm run test:e2e --prefix console     # every Playwright project, each against real engines (FIRENOOK_BINARY)
npx playwright test --project data    # one project, from console/ (data, auth, storage, compute, messaging, observe, shell)
npm run design-system --prefix console  # every design-system card, captured to console/.design-system
cargo test -p firenook-console-front  # crate tests + TypeScript bindings export
```

## Design

Follow the `kumo-design` skill (vendored Kumo rules) and `console/AGENTS.md`.
Semantic tokens only (`bg-kumo-base`, `text-kumo-subtle`, `ring-kumo-line`),
14 px content text, sentence-case headings, `font-semibold` not `font-bold`,
no colour transitions on hover, dialogs always mounted and toggled with
`open`. Firenook's identity lives in `src/theme.css` alone: the ember accent
(`--color-kumo-brand` and the link colour) and the type pair (Inter for
the interface, the face Kumo's docs render in; IBM Plex Mono for data),
self-hosted from `public/fonts`. The sans face is registered as
`InterVariable`, not `Inter`: the TanStack devtools inject a document-level
`@font-face` named Inter in dev builds, and the last declared face wins, so
a face named Inter would render the devtools' build on the dev server.
Light, dark, or the operating system's choice: `lib/color-mode.ts` holds
`useTheme` (`light | dark | system`, remembered under
`firenook.console.theme`), resolves it and sets `data-mode` before the first
render, and keeps following `prefers-color-scheme` for as long as `system`
is the choice. Kumo's dark tokens and the dark block in `theme.css` key on
that attribute, and `index.html` declares `color-scheme: light dark` so the
browser's own scrollbars and controls match. `ThemePicker` in the header is
three buttons, not a menu, and ⌘K offers the same three: Kumo's
`DropdownMenu` is not in the first route's chunk and pulling it in cost
10 KB of the bundle budget, which is a poor trade for hiding three icons
behind a click.
`theme.css` also sets what kumo-ui.com sets on its body and Kumo's
stylesheet does not: `-webkit-font-smoothing: antialiased` and Inter's
`calt, cv02, cv03, cv04`; without them macOS renders every weight heavier
than Kumo's docs show. The accent is reserved for the primary
action, active navigation and links; switches use `variant="neutral"` (Kumo's
default switch is hard-coded blue) so they match the checkbox.

### The type scale, and which surface a size belongs to

Kumo's scale resolves to `xs` 12, `sm` 13, `base` 14, `lg` 16, `xl` 20 px,
and `Text variant="heading"` is 16 px semibold whatever `size` says (20 px
only at `size="lg"`). The console uses it by surface, not by taste:

| | title | body | chrome, counts |
| --- | --- | --- | --- |
| page (Overview, a section's gate) | 20 px `heading size="lg"`, sections 16 px | 14 px | — |
| dialog — it owns the screen | 16 px `text-lg font-semibold` | 14 px | 13 px |
| popover, dropdown, the inspector | **14 px `PanelTitle`** | 13 px `size="sm"` | 12 px, figures 11 px |
| toolbar, grid, chips | — | — | 12 px, figures 11 px, `kbd` 10 px |

`PanelTitle` (`components/kit`) exists because `variant="heading"` is three
steps above the 12 px control a popover hangs off, which makes the whole
surface read as a larger world than the page behind it. A surface attached
to a control gets a title one step above its own body and no more. Never
reach past 14 px inside one.

Kumo's `DropdownMenu.Item` is `text-base`, so `theme.css` sets every menu
part to 13 px once, unlayered, rather than per call site — a new menu is the
right size without being told. A menu row's second line is 12 px whatever
its face, and a two-line row takes `className="items-start"` so its icon
and tick sit on the first line instead of between the two. Use `MenuCheck`
rather than Kumo's `selected`, which renders the tick hard against the label
with no gap; note that a Phosphor icon carries width and height attributes,
so a gap has to go on a wrapper — padding on the icon eats the glyph.

**Every block names its own size, in pixels.** A size is inherited only
inside a run of prose. `em` is for one case and one only — mono set *within*
a sans sentence, where `text-[0.9em]` has to track whatever that sentence
is: `Import into <mono>products</mono>`. Used on a block it silently
measures against whichever ancestor happens to be set, and the same class
rendered 14.4 px in the toolbar, 12.6 px in a grid cell and 10.8 px where 12
was meant. A block that names nothing is worse: `html` is 14 px so it lands
on the content size rather than the browser's 16, but a Kumo `Table.Cell` is
14 px and a cell that sets no size takes it. One grid row held five sizes at
once that way — 11, 12, 12.6, 13 and 14 px — and the whole of it read as
sloppy without any one thing looking wrong.

**A value is data, so it is set in the data face** — strings included. A
string left in the interface face was the only value in the inspector two
pixels larger than the timestamp above it, and the only column in the grid
that did not line up with the id beside it. The grid is 12 px for a value
and 11 px for the detail that qualifies one (the exact stamp under a
relative time, the count in a container's chip); the relative time is the
only English in a row, so the only sans. A field row in the inspector is a
grid row stood on its end and takes the same 12 px, not the panel's 13 —
13 px is for the panel's prose.

Kumo decides some of this and has to be asked the right way. Its monospace
`Text` variants are **fixed at 13 px** (`size` accepts only `lg`), so
`InlineCopyText variant="mono"` is a size above a 12 px row: take
`variant="body" size="xs"` and ask for `font-mono` in the class instead.
Its `Select` at `size="sm"` is 14 px while its `Input` at `size="sm"` is 12,
so a select stacked above a filter needs `size="xs"` to match it. A journey
reads the computed sizes back out of a row and the panel beside it, because
this is not a thing you can see in a diff.

A select's `label` is a **form label stacked over the box** (14 px medium,
a second row). Where a box sits in a toolbar or a panel header, name it
inside instead, through `renderValue` — muted sans name, mono value, the way
the top bar writes "Project <id>" — and keep `aria-label`. The database
picker reads "Database (default)". And give the trigger `min-w-0`: Kumo
wraps every `Select` in a one-column grid whose track grows to the text, so
a long value pushes the box past its parent and the caret out of sight. The
database journey opens a 39-character id and checks the box keeps its width.

### Capitals: English for the person, lowercase for the data

Anything written *to* the reader starts with a capital — every control label
(`Rules`, `New`, `Run`, `Explain`, `Code`, `Filter`, `This collection`,
`All <id>`), every menu item and group label, every status word
(`Live`, `Unavailable`, `Unsaved`, `Undone`, `Not enforced`) and every
sentence of explanation under one, which also takes a full stop. A control
and the menu it opens must agree: the trigger said `this collection` while
its own menu item said `This collection`, which is the kind of mismatch that
reads as carelessness before anyone can say why.

Anything that *is* data stays exactly as the data has it: Firestore's value
types (`string`, `timestamp`, `doc`, `null`), collection ids and field names
including the grid's own `id` and `subcollections` columns, the query text,
a path preview's `auto id`, and API vocabulary someone will retype elsewhere
(`collection group`, which is `COLLECTION_GROUP` in `firestore.indexes.json`).
Output that leads with a figure needs no capital at all — `67 documents ·
count 15 ms`.

### The two toolbar rows, and toggles

A section's toolbar is two rows and the split is a rule, not a space
problem. A persistent control keeps a fixed place; variable-length content
runs after it. The reason is that a path changes length with every move, so
a control placed after it slides a few hundred pixels on each one and can
never be aimed at. Adjacency is worth less than a target that stays put.

So the path is a **field**, the way an address bar is, and the row is the
browser's own shape: the scope picker leads, then the field, which holds the
breadcrumb and runs to the end of the row. Reading the path and typing it
are the same box — clicking to edit swaps the content and changes no
geometry, which is what stops an outlined input appearing out of nowhere
under the pointer. The one control that acts on the whole path — copy —
sits **inside** the field against its right edge: the end of the path
wherever the path ends, and a target a longer path cannot move. Dividers
mark the groups — one between the scope and the path, one before the status
group — and the last isolates the control that writes: `New` stands alone,
everything that reports or switches view is on the other side.

**The field carries no chrome at rest.** It has three states and each one
earns its ink: flat for reading, a ground (`bg-kumo-tint`) under the
pointer, an outline only on focus. An outline is the one mark on a screen
that means *type here*, so at rest it would lie about a breadcrumb; and a
permanent fill claims a whole row of the toolbar is an input. The dividers,
not the ground, are what say where the path group begins and ends, which is
what keeps copy attached to the path while the field shows nothing. An
outline is also the one shape of chrome that cannot survive here: a Tailwind
`ring` is a shadow painted *outside* the box, the field ends flush with the
row's clip, and the clip ate its right edge, leaving the box open-ended on
any wide window. A journey holds the resting `boxShadow` at `none`.

Nothing inside the field may be marked with a fill of its own, because the
ground under it moves. **Where you are is the segment that is not faded** —
ancestors `text-kumo-subtle`, the last one `text-kumo-default` — not a
tagged chip; a chip has to be light on the bar and dark on the hover ground,
and flipping it as the pointer arrives reads as a fault. A segment's own
hover is `hover:ink` (below), which only ever
appears while the field is lit, so it lands a step darker than that
ground.

A toolbar must degrade, never overlap. A `shrink-0` group inside a
`flex-1` parent paints over its neighbour when the parent runs out of room,
so the parent takes `overflow-hidden` — but that clip also swallows any
popup anchored inside it, so it lifts while one can be open (the path's
completions hang below the row from inside it). **Playwright sees neither
half of that**: `toBeVisible` does not test for a clip, and `click` scrolls
the clipping box first, which nobody using a mouse can do — so both passed
while the completions were unreachable for months. Assert the popup with
`ownerDocument.elementFromPoint` at its own centre instead. The pieces give
way in a stated order: the identity's qualifier first (`As Admin (bypasses rules)` →
`As Admin` below `2xl`), then the words on `Live` and `Rules` below `xl`,
then the empty click-to-edit target (`flex-1 basis-0`, no `min-w`), and only
then the path itself, which scrolls **to its end** — the database name never
changes and where you are is the last segment. A `ResizeObserver` watches
the segments *and* their box, because both sides of that move: the counts
arrive and widen the content, and the window narrows and takes the box's
width away. The scroller sits inside a 32 px field now, so it hides its own
scrollbar or the bar is drawn across the path. One journey checks all of
this at 1440, 1280, 1152 and 1024. **Row one is the scope**: where you are (the database picker, the
path, the collection-group toggle), the state of the connection (`live`),
who the reads run as (`View as` — it applies to every read the section
makes, the schema tree and the inspector included, so it is never a
property of the query), and what acts on the whole section (`Rules`,
`New`). **Row two is this one query**: the filter or the SDK chain, `Run`,
`Explain`, and what came back. A control that belongs to both rows
belongs in row one.

**The query field is the path field's twin**, a row below: one box (`h-8
rounded-lg`), the funnel inside it, flat at rest, `bg-kumo-tint` under the
pointer (`hover:not-focus-within:`), `bg-kumo-control` and the focus ring
on `focus-within`, and the one control that acts on the whole query
inside against the right edge, where the path keeps copy: an × that is
**always there while the line is**. With text or a query it clears
(`query-clear`); with nothing to clear it shuts the line (`query-close`,
"Close the filter"), as Escape does — before, an opened empty line had no
way back to the Filter button but that key. Shutting from inside hands
focus to the Filter button (`refocus`), and a line held open only by its
query shuts when the query is cleared. A query that did not parse keeps a `ring-kumo-danger` outline
at rest. The row scrolls sideways when narrow, and **a scroller clips at its
padding edge**, so the padding is the scroller's own (`px-3 py-1.5`), not
the line's: with it outside, the field was 28 px in a 28 px scroller and
focus drew two brackets with no top or bottom. **The row is `box-content
min-h-8`**: the minimum is the field's height with the padding on top. With
the padding counted inside it, the shut row closed around the 23 px Filter
button and grew 5.25 px when the field opened, pushing the grid down. The
journey measures the room every clipping ancestor leaves the field
(`ringRoom`, ≥ 1 px), compares its focused look with the path field's, and
holds the first row's `y` while the line opens and shuts.

**The count is the figure alone** — `240 documents` — in a Kumo tooltip
that says what it counts ("Every document this query matches, not only
the rows loaded. Counted in 3 ms.", or "From the schema tree's count."
for a pattern). It printed `· count 19 ms` beside the figure, which read
as a second number nobody could place. Explain has a tip too ("What this
query reads, and the index production needs"): it is Firestore's own name
for the feature, which says nothing to anyone who has not met Query
Explain. **The count sits in a slot as wide as `0,000,000 documents`**
(`MatchCount`: an invisible sizer in the same grid cell, in the same type),
and the slot stays, empty, while the query does not parse. The field
takes whatever the row has left, so a count that changed width moved Run
and Explain under the pointer — 240 to 67 documents was 12 px with the
timing, 6.8 px without it. The journey holds Run's `x` across 240, 67, 0
and a parse error.

### Colour means something, or it is not spent

The type badge is one quiet chip for every type — 11 px mono,
`bg-kumo-tint`, `text-kumo-subtle` — because the word already names the
type. A colour per type says the same thing twice, and eight saturated
chips across a header row is a rainbow with no hierarchy that drowns the
one colour in there that carries information. It also made a `null` look
like an error, which it is not; a null is a value.

That one colour is **`mixed`**: a column holding *values* of two different
types. It is amber, with a dot, and the odd cells beneath it carry the same
amber tint — the only pair of coloured things in the grid, which is what
makes them legible. A mark nobody has seen before cannot have its only
explanation in a `title`, so the column's own menu opens with
`More than one type here` and the breakdown (`string ×3, number ×1`).

**A null is not a second type.** Firestore has no schema — a field is
whatever each document says it is, and these columns are a reading of the
page, not a promise — but `null` is how an *optional* field is written, and
deliberately so: a document that omits the field is invisible to a query
that filters or orders on it, while `where(f, '==', null)` finds one that
holds null. So a column of timestamps and nulls is a timestamp column, and
marking it fired the warning on the commonest well-formed shape in a real
database: three of eight columns, all of them fine. `inferColumns` reads
the type from the documents that hold a value, sets `mixed` only when two
or more of those disagree, and calls a column `null` only when that is all
there is. The cell tint follows the same rule. What the column holds is
still one click away in its menu, under `What this column holds` when there
is nothing wrong with it. The muted `null` already in the cell is the only
mark that case needs, and an absent field stays blank, which is a different
thing again.

A chip on a row that lights up on hover has to keep a ground or it is
swallowed: `TypeBadge` takes `group-hover:ink`, a step darker with the
lit header (it went white, the other way, until hovers were made one
rule), and the header button carries `group`. In a menu
trigger the chip has no ground of its own and the trigger's hover is its.
A journey holds every settled badge to one ground and the mixed one to a
different one, and fails the moment a second colour appears.

**Every button hovers the same way: one step of ink over its own resting
colour.** The class is `hover:ink` (`@utility ink` in `theme.css`): the
hover fill `--color-firenook-hover` — black at 4 % in light mode, white at
9.6 % in dark, the alphas that land exactly on `kumo-tint` over
`kumo-base` — laid as a **background image** above the control's
background colour. As an image it adds to what is there, so a grey chip
goes a step greyer, a white card a step down from white, a bare icon a
step down from its row. Never an opaque surface token as a hover, and never
the hover fill as a background *colour*: Kumo's ladder in light mode is
base 255, overlay 251, elevated 248, tint 245, and the zebra rows, a
focused row, the header, chips and the lit path field sit at 245–248.
`hover:bg-kumo-base` went **white** there (the open-row button, the chip ×,
path segments), `hover:bg-kumo-elevated` went lighter or vanished, and the
fill painted as a colour turned a grey chip into the same grey (245 → 245
on a white row) — a hover that changed nothing.

- **Kumo's ghost `Button`** is held to the same step by one unlayered rule
  (`[data-kumo-component='Button'].bg-inherit:hover` — `bg-inherit` is the
  ghost variant's mark): its resting ground plus ink, where Kumo paints an
  opaque `kumo-tint` that disappears on anything at or below it. Menu items
  and palette results (`data-highlighted`) take the fill too; Kumo's
  `kumo-overlay` highlight is four levels below a white menu.
- **A framed button keeps its frame's colour under a mouse focus.** Kumo
  rings any focused button in `kumo-focus/50` (near black), the mouse's
  included, and a menu hands focus back to its trigger — so a mode picked
  from a menu (the scope picker's "All", View as) wore a dark outline until
  the next click. One unlayered rule,
  `[data-kumo-component='Button'].ring-kumo-line:focus:not(:focus-visible)`,
  puts `--tw-ring-color` back to `kumo-line`; the keyboard keeps Kumo's
  2 px `focus-visible` ring. `secondary` for a mode that is on (Explain,
  View as, the scope) stays the rule; inside that frame, no second box —
  the scope trigger's id is plain mono, the chip is the menu's.
- **A ring is drawn outside the box, so no clip may sit flush against a
  ringed control.** The path bar clips (so its never-shrinking controls
  cannot paint over the status group), and its first control is the framed
  scope picker: "All aiGatewayJobs" lost the left of its frame. The clip
  now reaches a step past its contents at both ends (`-mx-1 px-1`, nothing
  moves). A control that must touch a clip draws its focus ring inside
  (`focus-visible:ring-inset`), as the column resize strips do — they run
  the header's full height at the top of the grid's scroller. The journey
  "no frame or focus ring is cut by the box that clips it" (`cutRings`)
  checks every outer ring at rest and every focus ring under a Tab walk.
- **An icon says what happens, and one icon means one thing.** The
  open-row button is `SidebarSimpleIcon mirrored` — a window with a pane on
  its right, the panel it opens — and `weight="fill"` while its row is the
  one in the panel. It was `ArrowsOutSimpleIcon`, the diagonal "expand"
  arrows, which say maximise and which the field rows already use for
  putting a value in a box. The un-mirrored glyph is the nav sidebar's.
- **An icon button is Kumo's ghost `Button`** (`size="sm" shape="square"`),
  as the path's copy is. The open-row control was a bare button with a
  hover and a browser tooltip of its own, and in a dense row it read as no
  hover at all. Square icon controls that stay hand-made (the strip, the
  tree's arrow, a chip's ×) take `rounded-md` and `hover:ink`.
- **A tooltip on anything clickable is Kumo's `Tooltip`**, never `title`:
  the browser's waits about a second and arrives in the platform's skin.
  A Kumo `Button` turns its `title` into one; elsewhere wrap the element
  with `Tooltip render={…}`, a disabled one in a span (as Kumo's `Button`
  does), and `disabled` the tip where there is nothing to say. Closed
  tooltips add no DOM: scrolling the grid measured the same frames (p50
  16.6 ms, p95 22–24 ms) with one on every row's open button and id. The
  request log's per-row time, path and uid keep `title` — up to 500 rows,
  not virtualised, three tips each.

A journey hovers one control of each kind in both modes — including a
chip on a white and a zebra row and the open button on a focused row —
and measures each against itself at rest, every layer composited
(`paintOf`, images above colours): a six-level step, darker in light mode,
lighter in dark. It also checks the open button's tip is the console's.

Count each figure once. The path bar prints a count for every collection on
the way *except* the one in view, because row two already counts that one
under the query and the identity actually in force; two counts a row apart
either agree redundantly or disagree with nothing to explain why.

Kumo ships no `Toggle`; a toggle is a `Button` with `aria-pressed` and
`variant={on ? 'secondary' : 'ghost'}` — never `primary`, which is reserved
for the action of the row (`New`, `Run`). `Switch` is a settings control and
does not belong in a toolbar. Base UI's `Toggle`/`ToggleGroup` are installed
and unstyled if a real pressed state is ever needed. Let the label carry the
state wherever an off state would otherwise have no name: `Filter` becomes
the printed query it is applying.

A toggle can only ever show the state you are in. When the state you are
*not* in has to be legible too — a mode that changes what every row means —
it is a `DropdownMenu` that names both, like `ScopePicker` and `ViewAsPicker`
beside it, not a pressed button. Put the figures and the explanation in the
menu items (`DropdownMenu.Item` has `icon`, `selected` and children, no
`description`; **a `DropdownMenu.Label` throws unless it and its items sit
inside a `DropdownMenu.Group`**), and keep a one-key shortcut so flipping it
costs no more than the toggle did. `DropdownMenu` is already in the Firestore
chunk, so it is free there and 10 KB anywhere in the first route.

### The field tree, and what an editor is for

A document in the inspector is a `DraftNode[]` (`src/firestore/draft.ts`),
not a list of `{name, type, text}` rows. **A field, a map entry and an array
element are the same object** — a name (or an index), a type, a value — so
they are one node and `FieldRow` recurses. That is the whole reason the
panel exists: the one case a form beats raw JSON at is nested structure, and
the version before this dropped to a JSON textarea the moment a value
stopped being flat, which is exactly where it was wanted. Rows are the
default and `raw` on a container is the escape hatch, revealed on hover.

**Rows and `raw` are one subtree written two ways, so the button converts
— it does not flip a flag.** It flipped a flag, and a container's `text` is
*empty* by construction (the children are the value), so opening the JSON
view on a map with fields in it showed `{}`, marked the field changed, and
would have written that empty map on the next Save. Going back discarded
whatever had been typed, for the same reason in reverse. A user found it.
`toggleRaw` now serialises the children on the way in (`containerJson`) and
rebuilds them on the way out (`rawChildren`), and refuses to leave while
the JSON does not parse — the row already says why underneath, and the text
is worth more than the view, so the button disables rather than discarding.

`parseNode` on a `raw` container goes **through the rows**, not straight to
a value. Parsing the text directly loses every type JSON cannot write down
— a timestamp and a reference both come back strings — so a map merely
*looked* at as JSON would have saved as a different map. Routing through
`rawChildren` lets `agrees` keep whichever node the JSON still describes,
which is the same round trip the document-level JSON tab makes. `mapEntries`
and `itemNodes` are that one rule, shared by both. The text is read by the
same rules too (`readContainer`: everything inside inferred with `INFER`,
doubles read from the literal, the outermost value never inferred, so a map
holding exactly `latitude`/`longitude` stays a map), and a parse failure is
the parser's own message with its position. It used to read the text
plainly, so a date typed into a field's JSON stayed a string and `3.0` saved
as an integer where the JSON tab would have made them a timestamp and a
double.

`draft.ts` is pure and unit-tested: `nodesFrom` builds the tree,
`parseNode` reads it back, `problemsOf` says what is wrong *by node*, and
`diffDocument` works out the one write. Everything the components do is
render it.

**The editor is what knows what a good value looks like, so there is one per
type.** A text box per type is the same as no editor: a number carries an
`integer`/`double` control, a timestamp a calendar and how long ago it was,
a reference the completion of the path it points at, a geopoint two
labelled numbers instead of one string with a comma in it, bytes their
count and their text when they are text. `value-editors.tsx` holds them.

**An integer and a double are different Firestore types written the same
way.** `3` is both, so the text cannot say which, and the node carries it
(`integer`, `numberForm`). Without that, `editorText` printed `3` and
`parseEditorText` read an integer back: every double that read whole was
silently narrowed the moment its field was touched, and *duplicating* a
document narrowed all of them at once, because a duplicate writes every
field. A unit test and a journey hold both ends.

**Checked as it is typed, and Save knows before it is pressed.**
`problemsOf` runs on every keystroke and the message lands on the row that
owns it — a broken number three levels down is marked three levels down,
not on the field at the top of the tree. `diffDocument` compares *values*,
so Save is dead until something really changed and alive again when it is
typed back. That comparison is by value, which means a timestamp compares
by instant: the engine returns `…T00:00:00Z` and the editor writes
`…T00:00:00.000Z`, and comparing the strings made every document holding a
whole-second timestamp look edited the moment it was opened.

**A rename is a delete and a set, and only here.** Firestore has no rename
operation; the mask carries the new name and the old one in one write. The
diff gets this for free by looking `before` up under the name the field is
*going* to have — a name the document does not hold yet has nothing to be
equal to, so it is written, and the old name falls out of `live` and is
cleared. A second `renamed` term looked necessary and was not; it was
removed when no regression could be made to fail with it gone. The row says
**renaming changes this document only**, because the other documents in the
collection keep the old name and a console that does not say so is setting
a trap.

**A row is one line, and depth is the only thing that moves a name.** A
document is a tree, and a tree is legible only when a node is a line: the
first cut put the name on one line and the value on the next, which made
every node a block 47 px tall, and an indent of 16 px says nothing against
that. Worse, the caret column was given to containers alone and was *wider*
(21 px) than the indent — so at one depth a map stood right of its
siblings, and `projects` was drawn **six pixels to the left of `limits`,
the map containing it**. Depth and type were fighting over the same
pixels and depth lost. Now every row carries the caret column whether or
not it has a caret, the indent is that column's own width, and a name and
its value share a line with a quiet `:` between them. The same document
went from 1,107 px to 557.

The caret column is as narrow as a caret and a hit target allow, and the
tree keeps no left padding of its own, because **the tree is the one thing
in the panel that starts right of the panel's own content column** and
every pixel here widens that step. It was 31 px in while the path and the
tabs sat at 12; on a real document whose only map was its last field, that
read as a dozen rows of nothing. It is 20 px now, and the add-field line
carries the same column — it is a field row without a caret, and the name
being typed belongs where the names above it are. A journey holds that
column.

**A list of siblings shares two columns.** Names were a column already and
values were not: the name is content-wide so its value can sit beside it,
which meant the values on a real document began at **eight different
offsets spread over 58 px**. Reading down the values is half of what anyone
does with a document, and a staircase defeats it. `COLUMNS` in
`field-row.tsx` gives each list `grid-cols-[minmax(0,max-content)_minmax(0,1fr)]`
and every row is `grid-cols-subgrid`, so the track finds the widest name
with **no measuring** — no ref, no effect, no state — while each row still
paints its own ground and carries its own absolute strip. The colon went
with it: a column does a colon's job.

It is per sibling list, not per document, so a nested list sets its own
width and depth stays readable. Two things that only show in a browser: the
unsaved dot has to keep its place always, or the first edit widens the name
column and shifts every value in the list — the jitter this layout exists
to end; and a regression that collapses the list to one column **does not**
fail the guard, because `col-span-2` then creates an implicit `auto`
column that sizes to the widest name anyway. The guard's regression is the
flex layout it replaced.

**Top-to-bottom was the alternative and lost on nesting.** It aligns
everything for free and gives a value the full width — on a flat document
of long values, genuinely better. But every leaf at every depth pays the
doubling: `users/u_k65eq` goes 557 px → ~900 px, which stops fitting on a
laptop, and a node becomes a ~45 px block against an 18 px indent, which is
the ratio that made `projects` look like a sibling of `limits`. Firestore
documents nest, so the column wins.

**The panel's width is the real constraint, so it drags.**
`components/console/inspector-width.ts` is a small store with the same localStorage pattern as
`lib/layout.ts`: `setWidth` during the drag, `remember` at the end, so a
drag is not sixty storage writes. It is clamped to leave the grid 360 px —
the grid is the other half of the screen — and the panel's own left edge is
the grip, with a double-click home and arrow keys for the keyboard. At
620 px the pairings document stops wrapping entirely, which is more than
any arrangement of the two columns can buy.

**It opens at a share of the window, not a number.** `defaultWidth()` is
28% of `innerWidth`, floored at 420 and capped at 760. The flat 420 it
replaces was picked on a 1440 px laptop and shipped to a 2557 px display,
where it is **16% of the window against the 26% Supabase gives the same
panel** — snug where it was chosen and stingy where it ended up. The floor
means nothing changes below ~1500 px, which is also why the journey's
`toBe(420)` still holds; the share only shows above it. It reads the
*window*, not the space beside the grid, because the first panel opens
before there is a layout to measure.

**The panel is `xl:relative`, never `xl:static`.** The two lay out
identically in the flow, but only a positioned element is a containing
block, and under `static` the grip absolutely positioned on its edge
escaped to an ancestor and drew itself **523 px away, down the left side of
the grid**. A user found that, not the suite, and the reason is worth
keeping: the journey asserted the width *changed*, and every drag it made
landed on the clamp — which a width-only assertion cannot tell apart from a
working grip. A control that is dragged needs a guard that it is **where a
hand would reach for it** (`paintedAtItsOwnCentre` on the panel's edge) and
that it **follows the pointer by the distance dragged**, not merely that
something moved.

**A value is never cut short.** A console is for reading a document before
it is for editing one, so a value that runs past the panel's edge is the
panel failing at its first job — and a URL truncated there loses its path,
which is the half that says anything. An `input` cannot wrap at all, so
every value whose text can be any length (string, reference, bytes) is a
`textarea` that holds one line most of the time, inside `Grows`: an
invisible mirror of the text sets the height of a grid cell and the field
lies on top of it. `field-sizing: content` says that in one word but not in
every browser, and a value cut short in Firefox is still cut short.

Two traps in that, both measured: the mirror and the field must agree on
their metrics to the pixel (`WRAP_BOX`), and the wrap must be
`overflow-wrap: break-word`, **not** `anywhere` — they break a long token
identically, but `anywhere` counts those break opportunities towards
min-content width, which collapsed a content-sized field to one character
per line. Every item on the line is one text line tall and the line is
`items-start`, so a value that takes two lines leaves its name on the
first rather than floating between them. In an inline field Enter still
means "done with this one"; Shift+Enter puts in a newline, which is what
turns the value into a region.

That also settles where a trailing label goes. `double`, `ref`, `lat`,
`18 d ago` are **words** — bounded, tiny — and sit beside the value. The
bytes note is not a word but a sentence (the decoded text runs to forty
characters), so it goes below: left beside the value it took 180 px of a
405 px line and squeezed a base64 blob into four lines.

A value that is a *region* of text rather than a line of it — a multi-line
string, a vector, a container in `raw` mode — cannot share the line, so it
goes underneath at the panel's full width (`valueIsRegion`). **A container says what it holds, and only when shut.** It said
`{ 3 fields }` either way — a count is the one thing about a map you can
already see, since its fields are listed directly beneath it, and it said
it loudest while open, where the children were right there saying it
better. Open, the value cell is empty and the row is a header; shut, it is
the keys and how many more (`{ dasd }`, `{ alpha, beta, delta, +5 }`), with
an array showing brief values instead since its items have no names. A
container with more than `LARGE` (6) descendants **opens shut**, so a
document with a big map in it opens scannable rather than buried.

**What it holds is also the way in.** The preview is a button that opens
the container: the caret is four pixels of chevron and the words beside it
are what the eye went to. It is `tabIndex={-1}` and `aria-hidden` — a
redundant pointer target, so the caret keeps the semantics and anything
that is not a pointer still sees one control rather than two.

**A field opens its own helper; a button beside it does not.** Three
controls in this panel have now been moved for the same reason — a control
drawn only on hover is a control nobody finds. The reference field opened
its completions on focus from the start, and the **timestamp** now opens
its picker the same way (`Anchored` in `components/console/completions.tsx`, which
`Completions` is also built on). The calendar button is gone from the
strip. Rules learned doing it:

- The panel must **not shut on the field's own blur**. A calendar takes
  focus onto the day it selects, so that shut it on the first day pressed
  and a time could never be set. The test is whether focus left the field
  *and* the panel: React sends a portal's events up its own React tree, so
  one `onBlur` on the wrapper hears both, but the panel is not a DOM
  descendant — it is matched by `data-testid`, not by `contains`.
- Kumo's `DatePicker` is **react-day-picker, day granularity only**, and a
  Firestore timestamp is an instant. So the panel pairs it with a time
  input, and **the text stays the truth**: the pickers speak in days and
  seconds, and the ISO text carries the milliseconds neither can say.
  `defaultMonth` is required, or it opens on this month while the value's
  own month sits behind an arrow.
- It costs **+68 KB of JS** on the Firestore route and nothing on the
  first route, because `bundle-budget.mjs` follows the entry chunk's
  static imports and the Firestore route is already code-split. Measure
  `find dist/assets -name '*.js' | xargs cat | wc -c`, not the budget, to
  see what a Kumo component actually weighs.

**One column for the whole document, not one per list.** A nested list used
to build its own tracks (`COLUMNS`) and size the name column to its own
widest name, so a map of short names inside a document of long ones started
its values **26 px left of its parent's siblings and ran that much wider** —
the deeper the row, the further out it burst, which reads as the opposite
of containment. A user found it on a real `redirectUri`. Every depth is now
`grid-cols-subgrid` of the document's two tracks, and the indent still
works because **a subgrid takes its own margin, border and padding out of
the edge track**: `ml-2.5 border-l pl-2.5` narrows that list's name column
and leaves the value column exactly where it is. Nested items also feed the
top-level `max-content`, so the name track is the widest name at any depth,
indent included, capped by `max-w-40` on the input.

Guarding this needs **two strings at two depths**, not any two values: a
number shares its box with the word saying how it is stored, so it is
legitimately narrower, and comparing one against a string fails for a
reason that has nothing to do with the column.

**The caret hangs in the margin; it does not stand in a column.** It had
one — `GUTTER`, given to every row whether or not it held a caret, because
giving it only to maps pushed a map's name past its own siblings (the bug
where `projects` drew left of the `limits` containing it). But a column
costs every row to serve the few: a real document of fourteen fields with
one map in it paid **18 px of nothing, thirteen times**, and its names sat
31 px in while every other label in the drawer sat on 12. A user put it as
"we literally leave a big empty left space for all fields".

`CARET` is `absolute -left-4` against the line, which is the positioned
ancestor. Out of the flow it cannot push anything, so **siblings stay
aligned for free** — the thing the column was there to buy — and a name is
a name whether or not the field opens.

**A guide line descends from the caret that opened it, or it descends from
nothing.** Hanging the caret moved it outside the name column while the
nested list's rail stayed inside one: `ml-1` put the line 3.5 px into the
column and the caret hangs 14 px out of it, leaving **11 px of white
between the chevron and the rail it heads** — the same 11 at every depth,
because the offset is built in rather than drifting, which is why it reads
as a misdraw and not as a rounding slip. An arrow and a line that never
meet are two marks near each other, not a statement about what contains
what, and the tree then has to be read off the indent alone. The fix is
arithmetic, not ink: the caret's centre is −7 px from the column, which
is `-ml-2` on a 14 px root, and `pl-5` → `pl-8` gives back exactly what the
margin took, so **the 22 px indent and every value column are untouched**.
It also widens the one gap that was tight — a child's own caret hangs into
the same margin and cleared the rail by 3 px; it now clears it by 14.

This is the cheaper half of what an `├─` tree would say. Before adding the
horizontal tee, note two things measured here: rows are **variable height**
(a wrapped value is three lines and the name sits at the top), so the stub
has to land 14 px from the row top rather than at the row's centre; and the
stub cannot be one length, because a leaf child has 29 px of clear run from
rail to name while a **container** child has 15 before its own chevron is in
the way. VS Code avoids that with a reserved chevron column — the column
this console deleted.

Removing a column means hunting the places that stood clear of it. A
region, a rename note and a problem message all carried `pl-6` to clear
the caret, and kept it after the caret stopped being there — so an
expanded value sat 21 px in while its own name sat on the panel's column.
**Whatever goes under a line starts where the line starts**, and ends
where a line's own box ends (`pr-1`, which the value cell spends and the
region has to spend too). Four consequences:

- The panel's left padding has to **hold** the hang: `pl-5` on the list
  (17.5 px) against a 14 px caret leaves the glyph about 5 px inside the
  edge. Hang it further than the padding and it is simply clipped away,
  which a left-offset assertion cannot tell from a caret that is there —
  so the guard also asks `paintedAtItsOwnCentre`.
- The **nesting step** has to clear it too: `ml-1 … pl-5` is 22 px, so a
  child's caret lands 8 px in and the guide line stays at 3.5 px, to the
  left of that caret rather than running through it.
- The caret takes the line's hover ground (`group-hover/line:bg-kumo-tint`)
  and the line drops its left rounding for a container, or the band stops
  at the name and the caret sits outside the row it belongs to.

**The drawer has one content column, and every section is in it.** The
path, the tabs, the field names, the add-field line, Subcollections, Save
and Delete all sit on **19 px** left and about 18 right (`px-5`, with the
list at `pl-5 pr-4` because the value cell already spends `pr-1`). The
field list did not: at `pl-0` a row's hover ground began 1 px from the
panel's edge and its values ended 19 px from the other — the asymmetry a
user saw as "the field is until the end". The guard compares a row's
**ground** with Save and a value's right edge with Delete.

Measuring a drawer's padding means measuring **every section, and the ink
rather than the box**: a ghost icon button carries its own padding, so its
box sits closer to the edge than a bordered one while the glyph lands in
the same place. Checking one pair of numbers and calling it symmetric is
how the first attempt at this passed while four of the six edges were
still wrong.

**A value wears a box; a name does not.** The rule used to be "nothing at
rest" for both, on the grounds that a value is read far more often than it
is changed — and it was wrong about what the reader needs to know. Measured
against Supabase's row editor (668 px drawer, 33 px controls, 86 px of
pitch per field), the one thing of theirs that was free to copy was the
bordered control: it says *you can type here* before anybody tries one, and
a column of bare text says the opposite, so the panel read as a dump of a
document rather than an editor of one. Nothing else argued otherwise
either — the type menu, the only hint that a value's type can be changed at
all, is under the pointer.

The box genuinely costs nothing vertically: a Tailwind `ring` is painted
with a box-shadow, so a boxed line is exactly as tall as a bare one. What
the old rule was really protecting against was **37 boxes stacked 2 px
apart**, which is a wall and not a list — so the air went up with the box,
to a 28 px line and a 6 px `gap-y` (Supabase spends 53 px of air per field,
which it can: a Postgres row is six columns and never nests). The name
stays bare, and moved to **13 px interface face** against the value's 12 px
mono: both in one voice gave the eye nothing to tell a label from the data
it labels.

Buttons at rest are still only the type chips, the disclosure carets and
the switches. `ACCESSORY` in `field-context.ts` is the one strip holding
all the rest.

**The strip overlays the end of the line; it does not reserve it.** Holding
its place cost **93 of a line's 405 px** — a quarter of every row, kept
open at rest for buttons that are not drawn at rest — and that was exactly
the width a 24-character timestamp was being truncated by. It **floats**:
its own ground, a hairline and a shadow, one line tall and pinned to the
top of the row. It used to borrow the line's ground (`bg-inherit`), which
was invisible while values wore nothing and became a notch cut out of the
end of the box the moment they did — a thing that occludes has to look like
a thing. It is `pointer-events-none` until shown, or an invisible button
would swallow clicks on the end of a value. Three consequences worth
knowing:

- It answers to the **line**, not the row, because a row contains its
  children — `group/line`, not `group/row`. Pointing at one entry of a map
  used to arm the map's controls as well, three sets lit for one pointer.
- It reveals on hover and on its **own** `focus-within`, never the line's.
  A strip that came up on the line's focus landed on the text being typed;
  this way it stays down while a value has focus, and a Tab out of the
  value into the strip still brings it up.
- Because of `pointer-events-none`, a journey must point at the row before
  pressing one of its controls. `press()` in `firestore.spec.ts` does that;
  a bare `.click()` hangs on actionability, which is the right answer —
  no person can click a control nothing is pointing at.
- Anything the strip can cover must be a *word*, not a control. It covers
  the end of every value box, so a control placed there is unreachable:
  hovering to reach it is what raises the thing hiding it.
- **The strip owns its buttons** (`StripButton`), and Kumo's does not fit
  here for two measured reasons. Its `xs` square renders **12 px** — the
  root font is 14 px, so every rem-based size comes out an eighth smaller
  than the design system means — and three of those **2 px apart** read as
  one smudge rather than as three controls. And it has no pressed state to
  offer: `ghost` and `secondary` resolve to the *same white square* at this
  size, so the JSON toggle looked identical whether the row was in JSON or
  not, which is the one thing it exists to report. `className` does not
  survive its `cn()` merge either, so the state cannot be added from
  outside. One 21 px square, a 3.5 px gap, and `on` draws as the console's
  own filled-and-ringed box, with `aria-pressed` set only where there is a
  state to report. The type chip is the same height.
- A regression proof that *appends* a Tailwind utility proves nothing:
  `gap-0` after `gap-1` loses to whichever the stylesheet orders last.
  Replace the class, do not add to it.

The hover ground belongs to the **line**, not to each input. A column of
twenty one-line rows has to answer "which field am I on", and grounding the
value alone answered "which control" instead.

A line and a region are now **one column of boxes** in the same ink
(`Line` and `valueAreaClass`); the only difference between them is how many
lines they hold. Every line box is full width, which is what keeps the
column a column — and that is why a value's own word (`double`, `ref`,
`18 d ago`) is **inside** the box at its end, with `lat`/`lng` inside at
its start. Outside, the control had to be content-wide to keep value and
word together, which meant boxes in eight different widths; `SIZED` and
`field-sizing: content` are gone from the line editors with it. A leading
word is not an option for anything but a unit, because it would push the
text right and break the value column the whole layout exists for.
Remember that `html` is 14 px here, so `max-w-40` is 140 px, not 160.

Once a panel is that quiet, **the footer's count needs somewhere to point**:
a field the next Save will write carries a small ember dot beside its name.
That is the accent doing the job it is reserved for — Save is the row's
primary action and this is what it is about to write.

`TypeBadge` takes `menu` where the chip opens the type menu, and the two
places differ on purpose: in a grid header it is a label in a dense row and
keeps its ground; on a field row it lives in the strip, because **the type
is a control and the value already says what it is** — a number is digits,
a boolean is a switch, a map counts its own entries. Where the text alone
is ambiguous the editor says so in a word of its own instead: `double`,
`ref`, `lat`/`lng`, `11 bytes`, `3 dimensions`, `18 d ago`. **A word says;
the strip changes.** The integer/double toggle was the one control that
broke that rule, and it only worked while the end of a value was somewhere
the strip did not reach — once values wore boxes the two wanted the same
pixels, the strip won, and nothing could click it. It is now `NumberForm`
in `ValueControls`, drawn as the word it covers; the word itself is a
plain span. A control nothing can click is worse than one that is only
there under the pointer, which is where this row keeps its controls.

**Adding a field is one line, and the line knows the collection.**
`useKnownFields` reads the grid's own page query — same key, same cache, no
second request — and runs `inferColumns` over it, so the name completes
from what the rest of the collection calls its fields and brings that
field's usual type with it. Tab completes, Enter adds, focus lands on the
value. Firestore is schemaless, but a collection has a de-facto shape and
the console had already worked it out.

**A popup inside `overflow: auto` is an invisible popup.** Both lists here
hang off an input in a scrolling column, so `Completions` draws in a portal
from the input's own rectangle and follows it while anything scrolls; the
add-field line itself sits *below* the scroller, where it is always
reachable and nothing clips it. The journeys assert paint with
`elementFromPoint` at the element's own centre — `toBeVisible` does not
test for a clip and `click` scrolls the clipping box first, which no person
can do.

**Reference completion is a key range, not a page filtered in the browser.**
`listDocumentIds` orders by `__name__` from the prefix. The first version
fetched fifty ids and filtered them here, which offered nothing on the
first collection it met, because the id being typed was the two-hundredth.

Use Firestore's own words even when they are long: `collection group`, not
`group` — a bare `group` in a grid reads as group-by, and the canonical term
is what someone searches the docs and `firestore.indexes.json` with. The
schema index knows what a collection group spans without a request:
`patternsById` gives every pattern carrying an id, each node's `documents`
sums to the group's size and its `parents` to the number of collections
(one pattern is not one collection — `users/*\/orders` is a separate orders
under every user that has one).

The component library the design tool works from is `design-system/`
(`npm run design-system` renders every card through a real browser into
`.design-system/bundle`, `npm run design-system:dev` serves the cards). Add a
card there for every new pattern before it is designed with. Component docs: `npx @cloudflare/kumo doc <Component>`. TanStack docs:
`npx @tanstack/cli search-docs "<query>"` / `npx @tanstack/cli doc <library> <path>`.

### The bottom of a panel: colour on what can be done, height on what is there

**Never draw the only action of a line as unavailable.** The add-field
button was `ghost` + `disabled={!typed}`, which is half opacity on an
already subtle grey — beside a placeholder and a type chip that are also
subtle, so **nothing in the band was at full strength** and the band whose
whole job is to advertise "you can add a field" was the faintest ink in
the panel. A user: *"adding new field feels not so visible"*. A control
that can always begin its own job has no disabled state to draw: give it a
border, and with nothing typed let it focus the field that needs filling.

**The brand fill is a signal, not a decoration.** A `primary` button drawn
at all times is drawn at `opacity: 0.5` when disabled, so "save now" and
"nothing to save" differed only by translucency and the washed accent
still pulled hardest at rest. `variant={changed > 0 ? 'primary' :
'secondary'}` makes the one saturated mark in the drawer appear exactly
when there is work to do.

**Red once.** `secondary-destructive` — red text, white ground, border —
measured as the loudest control in the footer at rest, louder than Save, in
an editor whose usual business is reading. Kumo has no ghost destructive,
so put the colour on the children of a `ghost`: `icon={<TrashIcon
className="text-kumo-danger" />}` and a `<span className="text-kumo-danger">`
for the word. A child's own colour beats the button's inherited one, which
is the one way past Kumo's `cn()` merge dropping an outer `className`.

**An empty section is one line.** Subcollections was **56 px against the
footer's 42** — the tallest band in the panel and the only one with
nothing in it — because a 12 px label was followed by a 13 px "None yet."
in the same grey: a sentence larger than its own heading, so there was no
heading, just two grey lines of which the louder said nothing. `· none` in
the label says it, and the absent list says it twice. 138 px of chrome in
three compartments became 120.

**Check the box sizes of anything you touch down here.** The subcollections
`+` was still a Kumo `size="xs"` square — 12 px at our 14 px root, half of
every other icon button and below any sane hit target. `sm` is 23 and
matches the footer. See also the strip's own 21 px squares.

### Copy as code earns its place by being typed, or not at all

The case against the feature in 2026 is that a model writes the SDK call.
That is right about **syntax** and wrong about **data**: what a model cannot
produce is this document — its path, its field names, and above all its
Firestore types. `integerValue` vs `doubleValue`, `timestampValue` vs a
string, `referenceValue` vs a path. The console is the only thing that
knows them, so the job moved from "remind me of the call" to "hand me this
document, typed, for a prompt, a fixture or a seed script".

`documentAsCode` was failing exactly that job. It printed
`JSON.stringify(json)` while `literalFor` — the typed emitter for the
query line — sat **in the same file, unused by it**. Measured against a
real document: a timestamp came back a string, a geopoint a map, a
reference a path, and a whole-valued double an integer. Running the
snippet wrote a different document than the one it was copied from, which
is the one thing the feature exists not to do. Only `rest` was right,
because it is built from `restFields`.

**The query line's Code was taken out** for failing the same test. The
line already *is* the SDK chain, so the Web tab printed back what had just
been typed, and the only data in it — a path and the literals of a
`where` — is what the person typed a moment before. With no filter, the
common case, it was `collection()` plus `limit(100)`: the grid's page
size, which nobody asked for, so the snippet fetched a hundred documents
of a collection the grid pages through whole. Its import line was a fixed
list (`collectionGroup`, `doc`, `orderBy`, `where`, `GeoPoint` whether used
or not), and no journey had ever opened it. `CodeBlock` now lives in
`components/console/code-block.tsx`; the inspector's document uses it, and
so do the gate, the empty states and the shell banners.

Rules that fall out:

- **Build a snippet from the REST fields, never from the JSON beside
  them.** The JSON shape is lossy by construction.
- **Emit the import line from what the body uses** (`Timestamp`,
  `GeoPoint`, `Bytes`), or the snippet does not compile where it is
  pasted.
- **Name what a dialect cannot express rather than losing it.** JavaScript
  has one number type, so a double with no fractional part goes back as an
  integer; the snippet says which field, by path. Dart has two and prints
  `269.0`.
- `vector` is still emitted as a plain array in the three SDK dialects —
  a known remaining gap, left rather than guessed at, because inventing a
  constructor name puts a call that does not exist on somebody's clipboard.

### Where the main button goes in a panel footer

The user's call, and it is the right one: **the action goes right, the
tools go left.** A footer's main button is where a hand goes looking for
it, and Save is the only control down there anyone clicks twice.

The objection — that this seats the confirming action against the
destroying one — is about *adjacency*, not about which end Save is at, and
it is answered by sending the tools the other way rather than by keeping
Save on the left. Measured: Save↔Delete was 303 px with Save left; it is
**202 px** with Save right and the tools moved; it would have been **3 px**
had only Save moved.

**Group a footer's tools by what they do, not by which one is
frightening.** The first cut put the rule before Delete, isolating it for
being destructive — which grouped a read-only helper (Code, which opens a
panel and changes nothing) with an action that creates a document. The
honest line is between *looking at this document* and *changing which
documents exist*: `Code │ Duplicate Delete`. Delete confirms in a dialog,
so sitting it beside Duplicate costs nothing a misclick could not take
back. Three pixels is the rhythm *within* a group, and the gap past the
rule is several times it.

**Label by weight.** Code had a word and Duplicate had none, which was
backwards: Duplicate acts on data and deserves one, Code is a peek.
Worse, the one bare glyph was a *copy* icon, and the header above has
one too that copies the path — so the control nobody could name was also
the one most easily taken for something else.

**Then drop a label by width, not by rule.** The first fix took Code's
word away at every width, which was over-corrective: measured with the
word kept, Save↔Delete is 13 px at the 320 px floor but **113 px at 420
and 409 px at the 716 the panel opens to on a wide display** — the word
only ever cost anything in a thirty-pixel band just above the floor,
and `defaultWidth()` is a *share of the window*, so most people never
go near it. The word is now shown down to `CODE_LABEL_AT` (350) and
dropped below it, Code being the first word the row gives up because it
is the one control down there that changes nothing. The threshold is a
Save's own width — 42 px — of clear space between Save and Delete,
which is the least that reads as "the other end of the row".

The panel's width *is* the footer's width, so the footer reads
`useInspectorWidth` rather than growing a `ResizeObserver` or a
container query of its own. Kumo draws a labelled button and an
icon-only one from different shapes of props, so that is two JSX
branches, not one element with a conditional `children` — under
`exactOptionalPropertyTypes` a `children` that is sometimes `undefined`
satisfies neither. The tooltip stands in both, because a glyph alone has
to be hoverable to be nameable.

**Kumo's `Tooltip` wraps a `Popover.Trigger` through `render`**, nesting
one render prop in the other — `Tooltip render={<Popover.Trigger
render={<Button/>} />}`. Verified: one `<button>`, tooltip on hover,
popover on click.

### The create dialog is 720 px

Kumo's largest `Dialog` size is `lg` = `sm:w-[32rem]`, which is **448 px**
against this console's 14 px root (its runtime map has an `xl` at 48 rem,
but the typings do not expose it). That was sized before the dialog held
the field editor and the JSON tab: the JSON tab got **43 columns** —
exactly the length of `  "createdAt": "2026-10-10T18:32:32.415Z",` — the
value box was 222 px with the type chip over the end of a timestamp, and
a long parent path wrapped the title to three lines.

`className="p-6 sm:w-[720px]"` overrides it for the forms that hold the
field editor: **80 columns**, measured (640 → 69, 720 → 80, 800 → 91),
and about what the inspector opens to on a wide display, so the same
editor gets the same room in both places. Kumo's own
`max-w-[calc(100vw-2rem)]` still bounds it (600 px window → 572 px).
Import holds no field editor and keeps `lg`. The journey measures a
78-character line against a short one: at 448 it is 53 px tall, three
wrapped lines.

### A schemaless collection's columns

Measured on a collection of three shapes (90 / 10 / 20 documents across
two pages) and on one keyed by user id (40 documents × 15 own keys = 601
fields). Each rule below fixed something that was seen, not supposed.

- **Order is decided once per collection** (`arrangeColumns`): the first
  reading is commonest first, ties in natural order (`field2` before
  `field10`, `Intl.Collator` numeric — the engine lists in byte order);
  every later field joins at the end. Ordering every page by count put
  three second-page fields in the middle, under the reader mid-scroll. The
  order is held in `Grid` state keyed by database|collection|group (not the
  query, so a sort keeps every column where it was) and includes fields a
  filter took away, so they come back in place. `arrangeColumns` hands back
  the *same array* when nothing is new — the grid sets state during render
  on identity, and a fresh array each render is an infinite loop.
- **Coverage is shown** when a field is not in every loaded document:
  `25%` after the type badge (`coverage`, floored; `<1%`), and "In 10 of
  the 100 loaded documents" in the header menu. `of` excludes placeholder
  rows for missing ancestors. `headerWidth` reserves room for it.
- **Not set is not empty**: a document without the field draws a short
  rule (`data-testid="not-set"`), distinct from `null` and `""`, which are
  words. Placeholder rows draw nothing in field cells.
- **Rare fields fold** (`foldRare`) once there are more than `FOLD_AFTER`
  (24) columns: a field in one document, or in no more than 5% of them,
  goes into a trailing `+N fields` column (`FOLDED_COLUMN`) whose cells
  list the ones each row has; the header menu says why and offers "Show
  them as columns". 1,501 fields drawn whole was 143,667 elements and
  250–950 ms frames; folded it is 1,196 elements at 16.7 ms, and unfolded
  with column virtualization it still scrolls at 16.7.
- **The id can be frozen or not** from its own header menu
  (`IdHeaderMenu`, `id-header` — not `column-id`, which a field named `id` would also be —: "Freeze column" / "Unfreeze column"),
  frozen by default and remembered per shape in `useIdFreeze`
  (`components/console/column-widths.ts`, localStorage `firenook.console.unfrozen-ids`).
  Unfrozen, the id scrolls with the fields and only the check column stays,
  carrying the edge; `pinned` (what `reveal` and the editor's bounds keep
  clear) is then the check column alone.
- **The id is pinned** (with the check column): `PIN_CELL` is sticky on
  the row's own `--kumo-table-row-bg`, so it is opaque in every row state
  (the focused row sets that variable too). The edge (`PIN_EDGE`) appears
  only once `data-scrolled` is on the scroller, and is a full-height
  `::after` gradient strip, never a `box-shadow`: a shadow with a negative
  spread shrinks on every side, so each row's stopped short of its top and
  bottom and the edge read as a stack of pills (222 mid-row, 254 at every
  boundary, sampled beside it); and the check cell's one `box-shadow`
  already belongs to the focused row's accent bar. Not Kumo's
  `sticky` prop: it paints a 24 px fade over the first field at rest.
- **A sort that drops documents says so** (`presenceFields`, the query
  line's `query-leaves-out`): Firestore returns only documents that have
  every `orderBy` field and the field of a `!=` / `not-in`. With only
  sorts, the collection count minus the match count is the exact number
  left out ("225 documents without referredBy are left out"); with a
  filter too, the note says it without a number; when nothing is left out
  it says nothing.

### Ticked rows get their own bar, over the query line

`SelectionBar` (`selection-bar.tsx`) appears while any row is ticked and
holds everything about the selection: clear (×), the count, "Select all
N" (`selectEverything` sets `useSelection.everything`; "matching" when a
query is in force, because the bar covers the line that shows it), Copy
(JSON keyed by id or CSV, through `renderExport`), Export, and Delete N.
Before, Delete sat in the toolbar beside the identity picker and Export
and the count in the footer; the footer's Export now hides while
selecting so there is one of each. **It is laid over the query line
(`absolute inset-0` in a `relative` wrapper, the line `inert` under it),
not swapped for it**: the line is one or two rows tall depending on
chips, and a swap moved the rows under a shift-click — the journey fails
on a 1 px move. Unticking any row drops `everything`.

The grid's own footer (`GridFooter`) is a status bar: what is loaded on the
left ("N loaded · more on scroll", with "N hidden columns · show all"
beside it), Export alone at the right end (`ml-auto`). **No "first page N
ms"**: it timed one request and stood beside every later count, and it was
the browser's wall time (transfer and decode) read as the engine's speed;
the count's tooltip ("Counted in N ms") is the timing kept. Everything
used to sit on the left with the right half always empty. **There is no Load
more button**: the next page is fetched while the last twenty rows are still
ahead (an effect on the virtualizer's last visible index, so a short page or
keyboard walking fetches too), so the button only ever arrived after the
rows it would have loaded. "More on scroll" is said, not offered.

- Delete everything: an unfiltered collection goes in one request to the
  engine's path delete (`deletePath(collection, recursive)`), anything
  else is read for its paths and deleted per path (recursive) or in
  commits of 500, with "N of M deleted…" while it runs.
- `deletePath` **always sends `mode=`**: the engine reads a document path
  with no mode as shallow, and "Also delete subcollections underneath"
  (ticked by default) deleted the document and left its subcollections —
  measured, 200 on the subdocument after the delete.
- A selection is read by path (`batchGetDocuments`, `:batchGet` in
  hundreds) for Copy and Export, not by paging the whole result and
  keeping the ticked few — on 182,000 documents that read everything to
  copy two.
- `exportPages` treats `DEFAULT_LIMIT` as the grid's page size, not a
  written limit: it used to end every export at 100 (100 of `users`' 240,
  under "Every document in users").
- Kumo toasts have `role="dialog"`, so a journey looking for a dialog
  while a toast is up filters by its text.

### The grid edits where the value is

Double-click a cell, or Enter / F2 on the cell cursor, and `CellEditor`
(`cell-editor.tsx`) opens **over the cell**, in a portal placed from the
cell's rectangle. Chosen over both alternatives: an input inside the cell
is fastest but a column is too narrow for the `integer`/`double` word, a
calendar, completions or a tree (the old in-cell editor did five types
and sent six to the inspector); a popover below moves the value away from
the eye and wraps a one-word change in chrome. So a value that is a line
(string, number, boolean, timestamp, reference, geopoint, bytes, null)
opens *on* the cell, at least as wide as it and its text where the cell's
was, and a structure (map, array, vector, multi-line string, raw JSON)
opens as a panel from the same corner holding the inspector's own
`FieldRows`. Same editors (`ValueEditor`, `ValueControls`, `TypeMenu` —
extracted from the field row so both use one), same type changes; a
retype that changes shape swaps line ↔ panel and moves focus.

- Enter saves (a map's entry Enter too, via `next`), ⌘/Ctrl+Enter saves
  from a panel, Escape cancels, a press anywhere else saves (spreadsheet
  rules). A nested calendar or completion list takes Escape first
  (`preventDefault` in those editors; the editor ignores a prevented
  Escape and keys from its own portals).
- Only the field is written, with a mask and `exists: true`. Untouched
  (`node === initial`) writes nothing; a value equal to the stored one
  writes nothing.
- A missing field, or a `null`, opens as its column's type (`string` when
  the column is all null) and creates the field when typed into.
- The editor's portal carries **no z-index**. `#root` is `isolate`, so a
  body-level portal draws above the page in arrival order: the editor over
  the grid, and a Kumo menu opened from it over the editor. It sat on
  `z-50`, above Kumo popups that have no z-index (Kumo's own rule: isolate
  the app root, never z-index a portaled layer), and its type menus opened
  underneath it.
- A previewed value (`isPartial`, deep) is fetched whole first through
  `documentQuery` — saving the fragment is the bug this guards.
- A map or array panel has the inspector's **Fields · N | JSON** switch
  (Kumo `Tabs`, segmented sm, in the header; `Items · N` for an array),
  not an icon toggle — the `{}` was there and went unfound. The JSON is the
  inspector's `CodeEditor` (lazy chunk, `autoFocus`, `typeMarks` against the
  rows it was opened from, `tidyPaste`) with **Format JSON** where the `+`
  sits in rows. The switch is `toggleRaw`, so Fields waits (dimmed, with a
  tooltip) while the JSON does not parse. ⌘↵ is taken in
  `onKeyDownCapture`, before CodeMirror reads it as "insert a blank line".
  Nested containers inside the rows keep their small `{}` toggle, as in the
  inspector.
- `useSelection.editing` marks an edit in progress so the workbench's and
  grid's shortcuts stand aside wherever focus is; the grid clears it on
  unmount. The number box takes `formOutside` so its word is not drawn
  twice beside the toggle.
- The cell cursor (`useSelection.field`, `data-cursor`, a 1.5 px brand
  inset): ←/→ move along the columns (left of the first field is the
  row's own cell, where Enter opens the inspector), ↑/↓ keep the column,
  ⌘/Ctrl+C copies the value (`copyText`: scalars as typed, maps/arrays as
  JSON, the id from the row cell; partial values fetched whole) unless
  text is selected. Shift-click ticks a range from the last row ticked;
  the check cell cancels a *shift* mouse-down, because shift on a press is
  also the browser's "extend the text selection" and painted every cell
  between the two rows (the journey asserts the selection stays empty).
- **The grid's text cannot be selected** (`select-none` on `grid-scroll`):
  it picks rows and cells, and a drag across it painted every id and value
  it crossed. A value is copied with ⌘C on the cursor cell, an id with its
  own copy button, and text is chosen in the cell editor, which is
  portalled to `body` and so outside the rule. The shift guard stays for a
  selection begun outside the grid. The editor opens with its value
  selected, and a drag that starts on selected text *moves* it — the
  journey places a caret before it drags.

### Size and age beside the document path

The header reads `472 B · 1 mo ago` beside the name, the way a file list
writes size and modified time. Both are quiet subtle text — the age was a
filled `Badge` and the darkest mark in the header, louder than the path
it belongs to, for a fact you glance at twice a session.

**The age** is `updateTime`, the engine's record of the last write — not
any field of the document. The two can disagree by years: a journey seeds
`createdAt: 2020-01-01` and the header says *just now* while the row
beneath says *7 y ago*. It names itself in a Kumo tooltip ("Last changed
…", `compactIso`), not a native `title`.

**The size** is `src/firestore/size.ts`, Firestore's own rule: strings
and field names are UTF-8 bytes + 1, numbers and timestamps 8 whatever
they read, a geopoint 16, a vector 8 a dimension (not the map it is
spelled as in JSON), a reference priced as the name it points at, a
document its name + fields + 32. Google's worked example
(`users/jeff/tasks/my_task_id` = 44 + 71 + 32 = **147**) is a unit test,
line by line. A map does *not* carry its own 32; the docs leave that
implicit and the worked example adds it exactly once.

It counts the **draft**, live: every draft change goes through one
`changeNodes`, which reports up to `Inspector`, keyed to the editor that
reported it so a switched-to or remotely rewritten document shows its
stored size until edited. Quiet below 90%; from there it adds the share
and turns amber (`973 KB · 94%`); over the limit red (`1.05 MB · 105%`),
rounding up so one byte over never reads 100%, with a tooltip that says
the engine will store it and Firestore will not.

**The engine does not enforce the 1 MiB limit** — no crate holds a
document-size check, and neither `COMPATIBILITY.md` nor `ROADMAP.md`
mentions it. Until it does, this header is the only warning before a
deploy.

Two placements were tried and measured before this one:

- **A progress ring** (asked about) — a real 11-field record is 472
  bytes, 0.045% of the limit: 0.02 px of arc on a 16 px ring, and a bar
  would need 2,222 px to show one pixel. A ring is the instrument for a
  quantity that spans its range in normal use; document size lives in the
  bottom tenth of a percent, so it would read empty — or as a spinner
  that never started — for nearly every document, and it moves the number
  behind a hover. The share appears in text once it is news instead.
- **The footer, beside Save** — semantically neat, and it broke the floor:
  at 320–350 px an over-limit size pushed Save 39–47 px off the footer's
  edge, and at 350 Code's word came back and made it worse. That footer is
  tuned to the controls it has; check overflow at 320 and 350 whenever
  anything is added to it.

### The write log and its undo were taken out

They are not in the console. `ROADMAP.md` carries the entry and the
reasoning; the implementation is one commit back in history rather than
dead code holding an 8 MB window open on the write path.

What to keep from it if it returns. **An undo fires triggers** — it writes
through `store.commit`, and `TriggerObserver` is a commit observer on that
same store, so undoing a write a Function made runs that Function again.
That is arguably right (a hidden write path that skipped triggers would
make the emulator lie), and it means the button cannot keep the promise
its toast makes. **The log is the valuable half and the undo is the
hazardous one**, so if it comes back it is a log first, with the undo
behind a confirmation that names the trigger behaviour. And it belongs
**per document, in the inspector**, not as one global list: the question
is almost always "what happened to *this*?".

**What is left in its place:** the console has **one live connection per
browser** (`src/lib/live`), so a dropped channel is said **once, by the
engine badge in the top bar** (amber "reconnecting", red "engine stopped"
the moment the engine says it is stopping, amber "too many console tabs"),
with a tooltip saying what is on screen may be out of date. The grid is
kept current by that channel, so a dropped channel is a grid that looks
fresh and is not — the one thing a dev tool must not do quietly. While it
is up there is nothing to say: a green "Live" in every toolbar was the
normal case announced beside the engine's own green dot. The toolbar keeps
a `LiveNotice` chip only for this page's own subscription, when the engine
ended or refused it. A journey drops the channel with `dropLive`
(`e2e/support/live.ts`: the product's own release path — the tab hidden
until it lets the connection go, the live routes refused, the tab shown
again), sees the badge say so, writes a document meanwhile, and after
`restoreLive` sees the row catch up without a reload: `firestore.changes`
replays what was missed. The count beside it went with the panel it used
to open: a number nobody can look into is trivia, and it was counting
writes since the tab opened while the panel counted what the engine still
held, both under the word "change".

## Security rules (built, `src/firestore/rules-page/` on the rules kit `src/rules/`)

**The rules kit** (`src/rules/`) is what every rules page shares, Firestore's
and Storage's: the draft (`useRulesDraft` over a backend: the document in
force, how to install a text, where the draft is kept), the check as you type
(`useRulesCheck`), the toolbar (`RulesToolbar` with a `scope` slot, its
`DraftState`, `CoverageToggle`, `DraftActions`), the banners (on
`SectionBanner`), `Problems` (F8 / Shift+F8 walk them), `HistoryDialog`,
`diff.ts`, `overlay.ts`, `explain.ts`, `ExplanationView`, `coverage.ts`,
`tests-core.ts` and `TestsPanel`, `Verdict` (on `StatusDot`), the decisions
panel shell (`DecisionsShell`; each page's adapter fills it), `focus.ts` and
the one search schema (`rulesPageSearch('db' | 'bucket')`, with `line`). It
imports nothing from a section's directory. Change it with both pages'
journeys running. **Only a loaded text is checked**: the editor holds an
empty text until the rules arrive, and checking it flashed `1:1 expected
"service"` in the Problems strip on every visit (`textToCheck`). A link's
`line` is revealed and marked once the rules have loaded, then leaves the
address.

Rules are **a page of their own**, `/firestore/rules` (route file
`routes/firestore_.rules.tsx`, the trailing underscore keeps it out of the
data route's layout; `useSearch({ from: '/firestore_/rules' })` takes the
route id, `useNavigate({ from: '/firestore/rules' })` the path). The nav
shows Firestore as Kumo's `Sidebar.Collapsible` over its `pages` (Data,
Rules) — `ConsoleSection.pages` in `src/lib/services.ts`; the active page
carries `data-active`. They were a mode of the data view (a Rules button
among View as and New swapping the grid for a textarea, the schema tree
left beside it meaning nothing) and the Requests drawer sat at the data
page's foot; both are gone, and so is the Observe ▸ Requests placeholder.

**Layout.** Toolbar: the shared `DatabasePicker` (rules are per database),
the file name, a "Draft · not applied" or "Applied · not saved" badge,
Coverage, History, Revert / Apply (⌘↵) / Save (⌘S, disabled when draft,
in force and file agree). Banners under it, each only when true: no rules
loaded (everything allowed), the file on disk does not compile, the rules
changed under your draft (Discard / Keep editing), what applying would
turn around ("Show them" filters the decisions to the flips), saved tests
that fail against the draft. The editor fills the left; a 440 px side
panel has Decisions · Playground · Tests · Collections (counts as badges).

**The editor** is the shared CodeMirror `CodeEditor` with
`language="rules"` (`components/code-editor/rules/`: a `StreamLanguage`
with brace folding and context completion — `request.auth.token.`, the
built-ins and methods, `resource.data.` fields **sampled from the data**
through `rulesCompletion.fields(pattern)` → `fieldsQuery` in
`schema-fields.ts`, custom claims from the Auth users). New props: `marks`
(the engine's diagnostics), `lineMarks`, `inlineValues` (debugger-style
values after expressions), `gutterNotes` (coverage), `reveal`. ⌘↵ is
claimed by the rules language (`Prec.highest` keymap) — CodeMirror's own
`Mod-Enter` inserts a blank line, which went into the rules with every
keyboard Apply.

**One overlay at a time.** A panel draws into the editor through
`useOverlay` (`src/rules/overlay.ts`): lines and values, plus the `source`
they refer to; the page applies it only while the editor holds that exact
text. A reveal comes from a click, an overlay's arrival or a link's `line`
(`useEditorFocus`) — each carries `at`, the latest wins.

**Checking as you type.** `POST /rules/check` (debounced 300 ms) returns
compile errors or the engine's lint warnings (`code`: `open-access`,
`auth-only`, `unvalidated-write`; positions are UTF-16 `from`/`to`), the
outline, and the map against the schema index. The Problems strip under
the editor lists them; Collections shows the warnings and the map
(governing match blocks with the operations their allows grant, uncovered
collections, match blocks that reach no data). "Add starter rules"
(`starter.ts`) writes a match block from sampled fields: ownership from a
`users/{userId}` ancestor, `users` itself, or an owner field; a
`valid<Name>(data)` with `hasOnly`, `hasAll` for fields every sample
carries, and type checks; inserted before the documents block closes.

**Decisions** (`decisions.ts`, `decisions-panel.tsx`, `decision-detail.tsx`)
are drawn by the rules kit's `DecisionsShell`, the same panel as Storage's:
one filter field (Firestore matches path, user and method in the browser;
Storage parses `path uid:<uid> method` into the topic's parameters), All /
Denied, Clear, the count line, two-line rows from `DecisionRowParts`
(verdict, method, path; when, who, extras, the draft's flip, the deciding
lines) and the "Holding the last N…" footer. They read the official
Requests websocket, unchanged — its JSON is pinned by conformance
fixtures. **History arrives as one JSON array, live events
one by one**; the old drawer parsed only objects and silently dropped the
replay. Typed rules values (`intValue`, `pathValue`, `undefined` …) become
`FsValue` through `fromRulesValue`. A decision opens onto who asked
(claims, provider), the lines that ran (deduplicated with ×n), the
document before/after with changed keys, and **Why**: `GET
/rules/decisions/{requestId}` re-runs the retained context against the
ruleset that decided it and returns the explanation. "See why" on a denied
grid read links with `path`, `uid`, `denied` and **`pick`**: pick opens the
newest matching denial **once** and is cleared — the first version
re-picked every time the list came back, so "All decisions" bounced (and
the React Compiler memoizes the filtered list, so a sabotage that drops
`decision` from the effect's dependencies does not reproduce it). An empty
list says the Admin SDK and the console as admin skip rules; a database
with no rules file says nothing is checked.

**Inline values** (`src/rules/explain.ts`, `inlineSteps`): the engine reports every
expression evaluated; written after each, a line is unreadable. Keep each
whole operand and each comparison — drop a span when a longer evaluated
span starts at the same place and the text after it continues the chain
(`.`, `[`, `(`) — and the last value of a span evaluated twice. The
explanation view drops the condition's own value (it is the verdict above
it) and lists steps inside called functions separately, plus the
`get()`/`exists()` count and `queryReason` (which filter a list needs).

**Coverage** is the official report, read from the console origin at
`/console/api/v1/firestore/emulator/v1/projects/{p}:ruleCoverage` and
refetched when the decisions feed grows (no timer). Offsets are Unicode
scalars with an **inclusive** end (`scalarToUtf16`); the `report` key is
**absent** when the rules have nothing to count (`if true` alone) — that
crashed the page once. Drawn only over the text it describes.

**Playground** (`playground.tsx`, `requests.ts`): a form becomes the
request a real client sends — a token minted like View as, data typed by
`fromJson(INFER)` + `encodeFields`, a list query through `parseQuery` +
`toStructuredQuery` — and `POST /rules/evaluate` runs it against the
**editor's text** (a dry run: nothing committed or recorded), again on
every edit. "Try in the playground" loads a decision's replayable
`request` (recorded auth, before-document, time).

**Tests** (`tests-store.ts` on the kit's `tests-core.ts`): saved cases per project+database in
localStorage, run against the editor's text after each edit (an error
counts as a deny, as in Firestore); export as a
`@firebase/rules-unit-testing` file (`tests-export.ts`: seeds the
document read with `withSecurityRulesDisabled`, `assertSucceeds` /
`assertFails`) or as JSON.

**History and the file.** `GET /rules/history` (startup, console, file,
reload); the dialog diffs any version — and the file on disk when it
differs — against the editor (`src/rules/diff.ts`), "Put in the editor" makes it the
draft. The live channel's `firestore.rules` topic tells the page when what
governs the database changed (`rules`, cursor = the hash in force) and the
file's status on every subscription (`file`), so a file saved in an editor
shows up without a reload and a file that broke while the tab was away is
said when it comes back;
the engine watches each configured rules file (1 s debounce, a broken file
keeps the rules in force and reports `fileProblems`). No polling anywhere.

**Engine contract**: `crates/console-front/src/rules.rs` (read, apply,
check, history, the `firestore.rules` topic) and `rules_eval.rs` (evaluate, decision detail,
impact); generated types in `src/api/generated/`. A Rust doc comment that
contains `*/` — a pattern like `users/*/orders` — closes the generated
TypeScript comment and breaks the console build; spell it out.

**Test hooks**: Kumo's `Badge` and `Select` do not pass `data-testid`
through — wrap the badge, find the select by role and name. Journeys live
in `e2e/rules.spec.ts`; each one that changes rules restores the rules in
force and the file on disk in `finally`, because the data journeys read
through them. Typing into CodeMirror meets its bracket closing and
indenting: paste instead (`pasteRules`).

## Firestore workbench (built, `src/firestore/`)

- Data path: the browser talks Firestore REST to the console's own origin
  (`/console/api/v1/firestore/v1/...`, a second `rest-front` router on the
  same service), Identity Toolkit at `/console/api/v1/auth/...` and the
  official Requests websocket at `/console/api/v1/firestore/requests`,
  which the rules page reads as its decisions. Never reach the service
  ports from the browser.
- Live: the `firestore.changes` topic on the console's one live channel
  (`useLiveTopic`, `src/lib/live`), fed by the store's commit observer
  (`ChangeFeed` in `crates/console-front/src/firestore.rs`, a ring of
  path-only batches, so a dropped connection or a hidden tab gets the
  commits it missed replayed). `src/firestore/live.ts` patches updated rows
  of loaded pages in place through `documents:batchGet` read as the page's
  identity, refetches the window (at most 20 pages, `maxPages`) for creates,
  deletes and truncated commits, invalidates the other scopes and flashes
  rows. Payloads are paths only, never documents. No route of its own
  streams: `only_live_streams` (console-front) fails if one does, and the
  `EventSource` global is a lint error outside `src/lib/live`.
- Identity: `Authorization: Bearer owner` bypasses rules; "view as" is the
  kit's `IdentityPicker` (`components/console/identity-picker.tsx`, test id
  `view-as`) over `lib/identity.ts`: an Auth user reads with the token the
  Auth emulator itself issues for the account (`POST /auth/tokens`, cached
  under `['auth', project, 'token', tenant, uid]`, minted again five minutes
  before it expires and once more on a 401), found through the bounded
  `GET /auth/identities` search, never every account; a custom identity (any
  uid and claims) and a uid the engine cannot mint read with an unsigned
  `alg: none` token made in the browser. `FirestoreScope` carries `identity`
  and `authorize(signal)`; query keys hold `identityKey(identity)`, never a
  token, so rules run exactly as for the app.
- View state is the URL (`path`, `q`, `group`, `as`, `doc`, `tab`);
  selection and focus are Zustand; queries are keyed
  `['fs', db, kind, scope, ...]` so the channel can target them.
- Query text is the SDK chain (`where(...).orderBy(...).limit(n)`), parsed
  and printed by `src/firestore/query.ts`; cursors are exact because
  `__name__` is always the last order.
- Seed a synthetic project for development: `npm run seed -- <ui-origin>
  <project>` (`scripts/seed/firestore.mjs`; the `data` profile's seeder runs
  it for every engine the journeys start; the fixture's rules deny listing
  `users` to clients so "view as" has denials to show).
- Creating: every path into the create dialog is a `CreateRequest` on the
  `useCreateDialog` store (`src/firestore/create.ts`): `document` (with an
  optional `template` to duplicate or `id` for a missing ancestor),
  `collection` (its first document creates it; `parent` empty = root) and
  `import` (object keyed by id, array or NDJSON, batches of 200 `set`s). An
  explicit id uses a `create` write (`currentDocument.exists: false`); the
  engine answers 412, shown as "already exists". `FieldsPanel` in
  `field-editor.tsx` is the field tree + JSON view shared by the inspector
  and the dialog; the model is `src/firestore/draft.ts` (see below).
- Grid interactions: `HeaderMenu` writes `orderBy` into the query (the header
  shows the arrow, the `th` carries `aria-sort`) and composes
  `where("field", "==", )` into the query line through
  `useQueryLine.compose` (caret placed before `)`); hidden columns and the
  `unfolded` flag live in `useColumns`, reset per collection. Rows are
  `GridRow` (`grid-row.tsx`), a `memo` component fed values and a ref of
  `RowActions`, because `Grid` re-renders on every scroll frame. **Rows and
  columns are both virtualized** (two `useVirtualizer`s on one scroller; the
  horizontal one uses `scrollMargin` for the pinned and subcollection
  columns and is told `measure()` when widths change), so a column off
  screen is not in the DOM — a journey reaches one with the `reach()`
  helper. Rows are exactly 32 px (`[&_td]:h-[32px]`, `ROW_HEIGHT = 32`):
  `h-9` is 31.5 px on the 14 px root and the virtualizer used to place rows
  at 36. **A click is the cell's** — it moves the cell cursor and opens
  nothing; the row's **open button** (`open-row`, beside the checkbox in
  the 64 px pinned check cell, shown on hover, on the focused row, and
  pressed on the row the panel holds) opens the inspector and closes it
  again, as does Enter on the row's own cell. While the panel is open, a
  click on another row moves it there, as ↑/↓ always did. Clicking opened
  the panel on every click until then — 40% of a 1600 px grid gone to say
  "this one" — with a 260 ms wait wherever the panel would cover the cell
  so a double-click could still land; both are gone. Ticking a row's box
  never moves the cursor (`data-check`). Columns keep their
  width (a trailing filler `<col>` takes the slack) so nothing moves when
  the inspector opens. Column widths come from `inferColumns`: the type's
  own width, or the header's needs when those are greater, capped at
  `MAX_HEADER_WIDTH`; a dragged width (`ColumnResizer` on every header,
  double-click resets, arrows step 16 px) is kept per *shape* of collection
  in `useColumnWidths` (`components/console/column-widths.ts`, localStorage
  `firenook.console.column-widths`, `__name__` for the id column). Reference
  cells and reference fields *peek* (`selectDocument`) rather than
  navigate; the inspector shows "open in grid" when the document is outside
  the current collection. See "A schemaless collection's columns" and "The
  grid edits where the value is" under Design for the rest.
- The schema panel: `GET /console/api/v1/firestore/schema?database=` is the
  engine's schema index (`SchemaIndex` in `crates/console-front/src/schema.rs`:
  patterns like `users/*/orders` with `documents` and `parents` counts, one
  key-only snapshot walk on the first request per database, then exact
  through the commit observer; process-local, never persisted). The console
  side is `src/firestore/schema.ts` (`schemaQuery`, `patternOf`, `findNode`,
  `childrenOf`, `filterSchema`, `isExpanded`, the `useSchemaTree` store) and
  `components/schema-panel.tsx`, which fills the shell's section panel with
  the database picker, a filter and the tree — and **no footer**. One said
  the current pattern, its count and parents, and "the group also covers
  …": the lit row, that row's count and tooltip, and (for the last) the
  scope picker's "All" description, which names every pattern the group
  reads when there are several. It was a third band at the window's foot
  beside the grid footer and the Requests bar, and its pattern count
  disagreed with the filter line's whenever the grid showed one collection. The picker is fed by
  `GET /console/api/v1/firestore/databases` (`DatabaseCatalog` in
  `crates/console-front/src/databases.rs`: `(default)` always, every id
  `firebase.json` declares and every database holding a document, from
  `Store::databases`, which seeks once per database), through
  `src/firestore/databases.ts` (`databasesQuery`, own key outside the `fs`
  keys; `databaseItems` keeps the database on screen in the list even when
  the engine does not list it). The picker refetches on open, so a database
  a client just created appears without a reload. `?db=` names the database
  in the URL and is dropped for `(default)`. Only the path to the current
  collection is open by default; `toggleNode` records explicit opens and
  closes, `reveal` clears closes along a newly opened path, a closed node
  shows `+N` subcollections below it, and the filter keeps matching ids with
  their ancestors (everything open while filtering). A *pattern path* in the
  URL (`path=users/*/orders`) is the collection group of its last id:
  `workbench.isPattern` is true, `group` is forced, `setPath` of a pattern
  opens it as a group, and nothing can be created there (New menu, `n`, the
  empty state all check `isPattern`). The path bar is the left half of the
  workbench toolbar; it renders `*` segments as inert and counts a pattern
  segment from the schema. The live channel invalidates
  `['fs', db, 'schema']` on any create or delete.
- Subcollections in the grid: `SubcollectionsCell` is its own column (shown
  when the schema knows subcollections under this collection, or a missing
  ancestor is loaded; `subcollectionsWidth` sizes it from the known ids). It
  renders named chips with their document counts, each navigating, with a
  menu past three; the seed nests three levels
  (`users/{u}/orders/{o}/items/{i}`, `teams/t_real/channels/{c}/messages/{m}`,
  `products/{p}/reviews/{r}`).
  **Never ask per row.** `listCollectionIds` plus a count per chip is one
  request per row and three more per chip — a screen costs dozens and
  scrolling costs thousands. `POST /firestore/subcollections` answers a list
  of parents at once from the schema index, and
  `src/firestore/subcollections.ts` collects every path asked for in the
  same macrotask into one of those requests (`BATCH_LIMIT` 200, the engine
  refuses over 500). Queries stay keyed per path
  (`['fs', db, 'subcollections', path]`), so the cache and the live channel
  still invalidate per document; only the traffic is shared. The inspector
  uses the same query, so opening a row costs nothing. Like `/schema`, the
  endpoint reads the index and evaluates no rules, so the key carries no
  authorization. Measured on 82,000 documents: 2 ms for a 32-row screen in
  one request, against 9 ms in the 96 requests it replaces (32 listings
  and 64 counts), and those 96 issued concurrently from a host with no
  browser connection limit.
- Explain (`e`, the query line's button, ⌘K): `POST
  /console/api/v1/firestore/explain` answers how the query runs and what it
  would require in production. The plan is never a description of the engine
  written twice — `QueryStrategy::of` is the only place that chooses, and
  both `execute_iter` and `plan` call it, with a test that runs every query
  shape through both and fails if they disagree. `IndexCatalog::advise` asks
  an empty catalog what the query needs (single-field indexes inside a
  collection are automatic in production, so an empty catalog names exactly
  what must be declared) and this project's catalog whether it declares it;
  `suite-runtime` keeps the parsed catalog per database id for that, where it
  used to validate the file and throw it away. The endpoint runs the query to
  time it and evaluates no rules, so the panel labels the count as the
  engine's own. The console explains the query the person wrote: the grid's
  `DEFAULT_LIMIT` page size is dropped (`queryToExplain`), because explaining
  with it reports a floor of one page and a strategy our paging chose.
- Export (the grid's footer, ⌘K): `src/firestore/export.ts` pages the whole
  result with `cursorAfter`, the same cursor builder the grid pages with,
  and **without the preview header** — a file must never carry a value cut
  short for a cell. Formats are JSON keyed by document id (what
  `parseImport` reads, so an export loads back in), NDJSON and CSV with
  dotted columns for nested maps. "Keep Firestore types exactly" writes the
  REST wire shape, and `isRestShape` in `value.ts` is what lets the import
  recognise such a file and decode it rather than storing `{"stringValue":…}`
  as a map; it matches on the wire's own field names, so a person's own
  one-key map is not mistaken for it. The dialog names the scope and whose
  identity it reads as, because rules apply.
- There is no undo: the write log and its undo were taken out (see "The
  write log and its undo were taken out" under Design), and there is no
  `changelog.rs`, `GET /changelog` or `POST /undo`.
- Rules are a page of their own — see "Security rules" below. `?view=rules`
  and `/requests` redirect there.
- ⌘K is the shell's palette; pages contribute through
  `usePaletteProviders.register(key, (query) => groups)` (`src/lib/palette.ts`).
  Firestore's provider (`src/firestore/palette.tsx`) adds Go-to for
  path-shaped text, recents (`src/firestore/recents.ts`, localStorage per
  project+database, twelve kept), every pattern of the schema tree (a nested one opens
  as its group) and its actions; the panel toggle (`t`) and the nav modes
  are the shell's "Layout" group. `matchesQuery` is word-wise: every word
  of the query must appear in the title, breadcrumbs or keywords.
- The root landing shows **one row of recents, in the collection cards'
  columns**: the same `repeat(auto-fill, minmax(240px, 1fr))` grid, and
  `RECENT_SHOWN` hides each place past the column count with container
  queries (`@container`, `hidden @min-[734px]:block`, breakpoints
  n × 240 + (n − 1) × 7). Twelve at full length wrapped into seven rows
  above the collections they were a shortcut past; ⌘K still has all
  twelve. A chip cuts its path **from the front** (`dir="rtl"` on the
  truncating span, `<bdi>` around the path so it still reads left to
  right), parent muted and the last segment plain: the id is what tells
  two documents of one collection apart. A nested path's chip has a
  tooltip with the whole path.
- **Every copy answers with the same tick.** Icon and labelled copy
  buttons use `CopyGlyph` + `useCopied` (`components/kit/copy-glyph.tsx`):
  Kumo's ClipboardText motion, the copy mark rising out of its box as the
  tick rises in, back after 1.5 s, and only once the clipboard has the
  text. Kumo's `InlineCopyText` (project id, ids, the inspector's path)
  swaps its tick in on the spot; `styles.css` makes it rise in, keyed on
  `[data-kumo-component='InlineCopyText'][aria-label='Copied'] > svg`.
  The path's copy gave no answer at all before. A new copy button takes
  the glyph; the `ticked` helper in the journeys checks it.
- **Every copy goes through `copyToClipboard`** (`lib/copy.ts`): the text,
  and a note — `what` ("Copied the code 482913") or a whole `title` for
  the toast, an optional `description`, `refused` for what to do when the
  browser has no clipboard, a `key` when the toast must replace another.
  Without `what` or `title` it says nothing on success (`useCopied` uses
  it so: the tick says it); a refused write always says so and never
  throws. Never call `navigator.clipboard` directly.
- Kumo gotchas met here: `DropdownMenu.RadioItem` needs `closeOnClick`;
  a `Tooltip` given a `Button` as its **child** nests two `<button>`s and
  React says so in the console — pass it as `render={<Button … />}`, which
  is what every tooltip in the inspector does;
  `CommandPalette.Results`/`Items` render functions must return keyed
  elements; a `Tooltip` inside a `<button>` nests buttons (use `title`);
  `Popover.Content` drops unknown props, so a test id goes on a div inside
  it; **`Badge` drops `data-*` too** — it renders a span and nothing of
  yours reaches it, so a test id goes on a wrapper around it (which is
  also what the tooltip attaches to); a `Tooltip` *does* wrap a
  `Popover.Trigger` through nested `render` props, keeping one `<button>`
  with hover and click both live; a Kumo toast puts the same words in its
  title and its description, so a journey matches the heading by role;
  `Text` takes no `className` (wrap it); **Kumo's text colours are
  `--text-color-kumo-*`, not `--color-kumo-*`** — `var(--color-kumo-default)`
  does not exist, and a shadow naming it is invalid as a whole and draws
  nothing, silently (the pinned-id edge did this until a journey asserted
  its computed `box-shadow`); `Table.ResizeHandle` fixes its accessible name
  to "Resize column" for every column and paints `bg-kumo-base`, so the grid
  has its own `ColumnResizer`; the success and danger tints are
  translucent, so a flash painted *as* a sticky cell's background lets the
  scrolled content show through — `styles.css` animates a registered
  `@property --row-flash` colour as a gradient layer over the ground
  instead; a CSS grid track sizes to its content's minimum unless it is
  `minmax(0, …)` (the line editor's two geopoint inputs spilled to 461 px
  in 320). A Rust doc comment on a `ts-rs`
  type must not contain `*/` (it ends the generated JSDoc early), so
  patterns are described in words there.

## Rows and JSON are one draft (`field-editor.tsx`)

The inspector's two tabs are two views of a single `DraftNode[]`, not two
editors with a hand-off. There is **no Apply button**, and adding one back
would be a regression:

- Text that parses becomes rows on the keystroke. `Save` reads the rows,
  so it works from either view with no special case and its count is
  honest in both.
- Text that does not parse leaves the rows alone, says so in place, and
  holds `Save` with "The JSON does not parse yet" — writing the last good
  rows would be writing something other than what is on screen.
- Reconciliation is against `baseline`, the rows as they were when the
  view opened, **never against its own output**. Reconciling against the
  last keystroke's result loses a type the moment its line is briefly
  mid-edit: delete a timestamp, type the same instant back, and it
  returns as a string.
- Entering the view rebuilds the text from the rows, because anything
  that parsed is already in them — *except* when the text does not parse
  and `nodes === leftWith` (nothing edited the rows while the view was
  away), which is the one case where the text is the only copy of that
  work. This is a fixed bug, not a nicety: the view used to rebuild
  unconditionally, so a glance at the Fields tab silently discarded
  anything typed and not applied.

Why Apply went: a user asked what it was for, and the honest answer was
two jobs — turning text into rows, and rescuing that text before the tab
switch threw it away. The tab beside it already did the first. One draft,
two views, and exactly one control in the panel that writes.

Note the JSON view therefore has **nothing on the right of its band**.
That is correct rather than lopsided: it has no action of its own, so
`Format` sits alone on the left where tools go.

## How a value in the JSON view gets its type

Three things, in this order, and the order is the safety property.

1. **The rows.** `agrees` keeps a node whole when the text still projects
   to the same JSON. This runs first, so reading can never retype a field
   nobody touched — a string that happens to hold an ISO instant, left
   alone, is still a string.
2. **The characters** (`json-text.ts`). `JSON.parse` loses `3.0` vs `3`,
   so the literal is read out of the source text. Not inference —
   literacy, and the only way to author a `double` from this view.
3. **The shapes** (`fromJson(value, INFER)`). `{latitude, longitude}` and
   `{__type__: "__vector__", value}` are what `toJson` *writes*, so
   reading them back inverts this module's own output. An ISO string
   becoming a timestamp is the one real guess.

Reachable from JSON: 9 of Firestore's 11 types. `reference` is not
inferred — `"users/u1"` and `"images/logo.png"` are the same shape — and
`bytes` cannot be, since base64 is indistinguishable from text. Both are
set from the Fields tab's type menu.

Traps met while building this, all of which shipped as bugs first:

- **`writtenAsDouble` must only see number literals.** Run over every
  span it matches the `e` in `"latitude"` and calls the map a double.
- **`tidyJson` must put the point back.** Format and the paste-tidy both
  go through `JSON.stringify`, which writes the double 3 as `3` — so
  they silently destroyed the type before anything read it. The literals
  written with a point are noted going in and spliced back coming out,
  from the end forwards so earlier offsets hold.
- **A whole double still cannot round-trip through text.** Regenerated
  from rows it reads `269`, and only the row knows. That is what the
  carried mark is for, and `json-marks.test.ts` pins the limit.
- **`parseEditorText` deliberately does not infer.** A row declared
  `map` whose text is `{"latitude":1,"longitude":2}` would become a
  geopoint and fail its own type check.

`json-marks.ts` marks both kinds and words them differently, because only
one survives editing: *"Stays a timestamp…"* (the row holds it) versus
*"Read as a timestamp…"* (the text says it). `inferredTypes` finds the
second by parsing twice — with `INFER` and with nothing — and diffing, so
there is no second copy of the rules to drift.

## The code editor (`src/components/code-editor/`)

CodeMirror 6, MIT, behind a `lazy()`. Three files:

- `props.ts` — `CodeEditorProps` and `CodeMark`, written out rather than
  imported from CodeMirror so an annotator is a plain function over strings
  and numbers, unit-testable without an editor or a DOM.
- `editor.tsx` — the real thing. **Nothing imports this directly.** A static
  import from anywhere pulls ~400 KB of CodeMirror into that chunk.
- `index.tsx` — `lazy(() => import('./editor'))` plus a `<pre>` fallback in
  the same face, size and ground, so the swap moves no text. Import from
  here.

Measured: `editor-*.js` is 404 KB raw / 130 KB gzip in its own chunk; the
Firestore route chunk grew 3 KB; the first-route budget did not move.

Rules the editor follows:

- **Fills by flexing, never by `height: 100%`.** A percentage height
  against a parent whose own height is `auto` resolves as `auto`. The
  create dialog's field box is exactly that — a column that grows to its
  content with `min-h`/`max-h` — and the editor came out three lines tall
  inside it. `'&': { flex: 1, minHeight: 0 }` in the theme, and a flex
  column all the way up.
- **Every colour is a Kumo token**, so dark mode needs no second palette
  — and that has to include the colours CodeMirror paints *for* you.
  `@codemirror/lint` writes its own into the library (`#aaf` on `#77e`
  for the info square, `#999` for its squiggle) and its dark theme
  changes neither, so a pale lilac box sat on the console's dark ground
  for a whole release. The gutter shapes are a CSS `content` holding an
  SVG with the colour inside it, which no variable can reach: hand
  `content` back its `normal` value and draw the shape with a background
  and a border instead. Centre it with `display: flex` on
  `.cm-gutter-lint .cm-gutterElement`, not a margin tuned to one line
  height. When taking a library's paint over, check what else it draws
  — `grep` its `baseTheme` for literal colours.
- **`lineHeight: '1.25rem'`**, the console's own `leading-5`.
- **The palette is restrained on purpose.** The grid refuses a colour per
  type because colour in this console means something or it is not spent.
  Raw JSON is the exception that earns it: a field row writes `string`
  beside the value, a line of JSON writes only `"269"`, so here the ink is
  the only thing saying what a value is. One hue — keys carry weight, not
  hue; strings are the baseline; everything that is **not** a string is
  blue; null is the absence it describes.
- **The test id goes on `.cm-content`**, the element that holds the text and
  the focus. Playwright's `fill()` works on it because it is
  `contenteditable`, so journeys written against the old textarea kept
  passing unchanged.

`src/firestore/json-marks.ts` is the Firestore half: the six types JSON
cannot write down (timestamp, reference, bytes, geopoint, vector, and a
double that reads whole) marked on the values that carry them, which
replaced a sentence of prose that was true of three lines in thirty.

**A mark means exactly one thing: edit this value here and it will not be
this type any more.** Measured by editing each type in the JSON tab and
saving — a **timestamp**, **geopoint**, **vector** and a double written
`3.0` all come back as themselves, and so does everything if you edit
another field or press Format. Only **bytes**, a **reference** and a
double that reads whole (`269`) are lost, and lost on *any* change to
that value: `d29ybGQ=` is valid base64 and still saves as a string. So
only those three are marked, the condition being `carried && !inferred`
rather than a list of three, so teaching the editor to read one back out
of the text also stops it being marked. Each message names the concrete
reason ("one base64 string looks like any other") and the way round it
("The Fields tab keeps the type" — verified; editing bytes there
preserves `bytesValue`).

Two earlier versions of this copy were wrong, and the user caught both.
The first marked all six types with one sentence about "the row behind
this line" — jargon for the draft model, on a tab that shows no rows —
and warned that editing would cost the type when for most of them it
would not. The second split the sentence in two but still marked all
six, so a document of timestamps carried four boxes and three lines of
prose beside values in no danger, which teaches a reader to ignore the
mark before they ever meet the one that matters. **A mark that fires on
everything is a mark nobody reads.** Copy about behaviour gets checked
against the behaviour, on the wire — and a mark gets shown only where
something is actually at stake.

Its
`valueSpans` is a forgiving scanner — the text is being typed, so it stops
at the first thing it cannot read and records only what it actually read;
an empty span at the end of a half-typed document is a marker on nothing.
Paths join on `\u0000`, so a key called `a.b` is never confused with `b`
inside `a`. Container marks stop at the end of their first line: a
geopoint is four lines of JSON and underlining all four to say one thing
reads as damage.

## Authentication (built, `src/auth/`)

**Pages**: `/auth` (Users, `routes/auth.tsx`), `/auth/inbox`,
`/auth/activity` and `/auth/settings` (`routes/auth_.<page>.tsx`, route
ids `/auth_/<page>`). `tenant` is each page's scope param
(`auth/tenant-scope.ts`): absent means the page's default — the project's
own users on Users and Settings, every tenant on Inbox and Activity —
`(none)` is the project's users on a feed, anything else a tenant id. The
section is project-scoped: every route and topic takes `project` from
`useConsoleProject()`. Every view is a link: Users has `q`, `sort`, `user`
and `tab`; create dialogs open from `?new=` (`user`, `import`, `sample`;
`tenant` goes to Settings, where the tenant dialog lives) and Export from
`?dialog=export`; Inbox has `message`, Activity `entry`, `console` (the
console's own edits shown), `panel=try|inspect` and `method`; Settings has
`section`. A feed paused is `?paused=true`.

**Links**: the registry's `routes` open `auth.user` (`<tenant>|<uid>`,
split at the first bar; no bar is a project user), `auth.call` (call id)
and `auth.message` (message id); keys are built in Rust only by
`EntityRef::auth_user/auth_call/auth_message`, in TypeScript by
`auth/links.ts`. Never write an Auth URL by hand from another section, and
never write another section's URL from Auth (`EntityLink`, `linkToLogs`,
`serializeViewAs`, the rules pages' search schema through `rulesLineLink`).

**The engine owns the list, and reads it outside the lock.** `GET
/auth/users?tenant=&q=&sort=&cursor=&before=&limit=` filters, sorts and
counts over the `UserIndex` (`crates/auth-front/src/console/index.rs`):
`im` structures, so a console read holds the data lock only to clone a
snapshot, and one ordered set per sortable column kept up to date one
change at a time, so nothing is ever rebuilt. A filtered first page pins
its match list (eight per scope, two minutes idle); later pages slice it.
Auth sends the count and facets with the first page and with every
`users:batchGet`, so the page reads them from `usersFiguresQuery`, never
from `useCursorRows`' total, which vanishes once the window slides. Never
read the whole user list through the official API (`accounts:query`): it
has no paging, and the official emulator refuses its `limit`.

**Console reads never create anything.** `AuthData::agent` creates a
project and `Scope::new` a tenant on first reference (official behaviour);
console reads use `data.projects.get` and `agent.tenants.get` and answer
`not-found` or an empty page. An unknown tenant refuses the `auth.users`
subscription too.

**Writes go through the official API**: `callAuthEmulator` (`auth/api.ts`)
sends Identity Toolkit calls through the mount with `x-firenook-console:
write` (`try` and `replay` for Try a sign-in and Replay), so every edit is
recorded in Activity and behaves as the Admin SDK's. The answer carries
`x-firenook-activity: <call id>` only when the request carried the console
header. Bulk changes (`POST /auth/users:<verb>`: disable, enable, verify,
revoke, setClaims, removeClaims, delete) take a `BulkTarget` (keys or the
page's `q`) and answer a preview on `dryRun`, else a foundation job that
works in chunks of 2,000 and can be cancelled between them; imports upload
first (`POST /auth/imports`, streamed), preview, then run as a job (`POST
/auth/users:import`); export is `GET /auth/users:export` in the emulator's
own format; `POST /auth/tenants` creates a tenant with the id you choose.

**Tokens come from the engine** through the foundation's
`resolveAuthorization`: `POST /auth/tokens` mints what a sign-in would —
provider, tenant, the account's first second factor unless told otherwise,
a draft of custom claims, beforeSignIn when `runBeforeSignIn` is set —
mutates nothing, and lists in `differences` what still differs from a real
sign-in. Auth extends the request only with optional fields; `idToken` and
`expiresAt` keep the foundation's meaning. The beacon follows `auth.users`
for every scope with a cached token and drops a token the moment its
account's token fields change or it is deleted. `POST /auth/token/inspect`
judges a pasted token for each consumer (the rules, the emulator's own
calls, `verifyIdToken` with and without the revocation check, a sign-in)
with a reason and a fix.

**Live**: topics on the one channel per browser — `auth.users` (keys with
fields, coalesced in 100 ms windows, a refresh-only change sends nothing,
resume compares the scope's index generation, a reset past 1,000 keys),
`auth.activity` and `auth.inbox` (feeds on `replay_topic`, filtered by the
engine with the page's `q`; subscribe with `after` = the first page's
`liveAfter` and skip the replay's `tick` events), `auth.config` and
`auth.hooks`; subscribe only from the page that shows the data. The users
grid hands a window's uids to `useCursorRows.applyKeys`; one `POST
/auth/users:batchGet` patches rows and brings the count and facets. It
never refetches every loaded page or a head page. The inbox badge is the
engine's `auth.inbox` counter. Row one shows `LiveNotice` only when this
page's subscription ended; the channel's state is the top-bar badge.

**Codes are fetched by call id, never raced**: `GET
/auth/messages?activity=<call id>` returns what that call sent
(`callMessagesQuery`). The observer records a call before its response is
returned.

**Activity comes from the Auth app itself**: one `CallRecord` per finished
call (the engine keeps the newest 10,000; messages 2,000) with its steps —
blocking functions with the function's own message, its custom and session
claims and the invocation id read from `x-firenook-execution` after
sending `x-firenook-cause-auth-call`; triggers; messages sent and used;
user changes; configuration. Bodies are kept as received and sent, at
most 16 KiB each, and only with diagnostics on. `x-firenook-console:
write` calls are hidden unless `?console=true`; `try` and `replay` are
always shown; Replay asks first for operations that are not idempotent.
Errors are explained from `auth/errors.ts` with the SDK's own code and
sentence from `auth/sdk-errors.gen.ts`, which `scripts/auth-sdk-errors.mjs`
regenerates from `@firebase/auth` (1.13.5); `operations.ts` must label
every operation the engine dispatches (its test reads the Rust sources).

**Claims**: the 1,000 limit counts JavaScript string length (UTF-16 code
units) of the compact JSON, as the official emulator does; the claims
meter measures that as soon as the text is JSON. Kumo's `Meter` paints its
bar as a brand gradient, so a tone replaces the `from-`/`via-`/`to-` stops
(a `bg-` colour never shows). Auth overwrites `email`, `email_verified`,
`phone_number`, `provider_id`, `user_id` and `auth_time` in the token, and
custom `name`/`picture` replace the profile's (`shadowed`, `overrides` on
the minted token). Where rules read a claim comes from
`Ruleset::claim_reads()` (`crates/rules-engine/src/claim_reads.rs`) on the
rules documents (`claimReads`) — never a regex over rule text.

**Suite facts are not Auth's**: foreign projects (`ForeignProjects`, which
Auth feeds at start), background triggers (`ConsoleStatus`), which
functions listen (`useTriggersFor`), connection snippets (`lib/connect.ts`)
and toasts (`lib/toasts.ts`) each have one owner; Auth draws no banner for
them.

**Persistence** is snapshotted under the lock and encoded off it
(`crates/auth-front/src/persist.rs`): a change reaches `auth-state.json`
within 250 ms (four times the last encode when that is longer), and
`flush()` writes at once — the native checkpoint, an import and the
`before_finish` hook at shutdown use it. A test that reads the file must
flush first.

**Test hooks**: the `auth` Playwright project (`e2e/auth-*.spec.ts`; the
journeys that need their own engine are in `auth-engines.spec.ts`).
Journeys that count, bulk-change or import work in a scratch tenant
(`scratchTenant`/`inScratchTenant` in `e2e/support/auth.ts`) deleted in
`finally`; counts are read from the engine at test time (`usersCount`);
`app()` calls the Identity Toolkit as an app would, without the console
header, so Activity shows the call and the beacon toasts its codes. Sample
users are `sample-*` on `sample.test`; the seed (`scripts/seed/auth.mjs`)
exports `SEED_TENANT`, `SEED_MFA_USER` and `SEED_ADMIN`; the codebase's
only blocking functions and account triggers
(`scripts/fixtures/functions/auth.js`) are benign for every email but
`@blocked.test` and `@claims.test`; `SEED_USERS` are never edited.

**What building it taught**:
- `im` 15.1's `next_back` loses runs once a set is three levels deep
  (about 2,100 entries): the index never steps backwards through an
  `im` set; it walks down with a fresh `range(..last).next_back()` per
  step.
- A toast renders under a modal's inert backdrop, where role queries miss
  it: find it by text.
- `page.route` does not intercept a redirect's target.
- A Kumo `Select` reads `''` as no value: scope sentinels are `(none)` and
  `(all)`.

## Storage (built, `src/storage/`)

**Pages**: `/storage` (Files, `routes/storage.tsx`) and `/storage/rules`
(`routes/storage_.rules.tsx`; route id `/storage_/rules`, so
`useSearch({ from: '/storage_/rules' })` and `useNavigate({ from:
'/storage/rules' })`). Every view of Files is a link (`storage/search.ts`):
`bucket` (absent for the default bucket), `path` (the folder, ending in `/`;
empty segments such as `a//b/` are kept, never collapsed), `object` (the
entity: the file open in the inspector), `tab`, `layout=list|grid`,
`sort=<name|size|updated|type>:<asc|desc>`, `q`, `flat` (everything under
the folder), `as` (`serializeViewAs`), `new=folder|upload` and
`dialog=quick-look`. Defaults never reach the address
(`stripSearchParams(FILES_DEFAULTS)`), and the default bucket is dropped by
the route's middleware or, for a link that lands before the buckets are
known, by the page. The page's own moves navigate with `resetScroll:
false`: the router restores the previous view's offsets on every search
change, and that threw a keyboard move (Home with a file open) back to where
the reader had been. The Rules page reads the rules kit's schema,
`rulesPageSearch('bucket', { panel: [decisions, playground, tests, folders]
})` in `rules-page/rules-search.ts` (`bucket` only in per-bucket mode).
Files links to Rules only through `storage/rules-link.ts`
(`useRulesPageLink`, `useTryInPlayground`), which offers a link only while
the router knows `/storage_/rules`. Links out are `EntityRef`s through
`EntityLink`/`linkTo` (an Auth user in Activity, a function a trigger
reached), never hand-built URLs; Storage's own keys are pinned in
`entity.rs`: `storage.object` and `storage.folder` are `<bucket>|<path>`,
`storage.decision` is `<bucket or *>|<id>`.

**The engine lists; the browser never walks.** One `GET /storage/objects`
per page (100 rows) through `useCursorRows`, folders first; cursors are
opaque and go both ways (`nextCursor`, `prevCursor` → `before`), so a long
folder is a sliding window of 20 pages, never a capped forward list. A sort
or a filter is an engine view (`view_cache.rs`: compact, single-flight,
served for up to 2 s after its folder moved, marked `stale` with
`changesSince`); Refresh asks for it `fresh`. Never `listAll` plus
`getMetadata` per file (the official UI's N + 1). The filter's fields come
from `GET /storage/objects/meta` and the folder's profile (types and
metadata keys it holds); `filter-cases.json` holds the client parser and
the engine's to one set of cases (`runGoldenCases`, `include_str!`).

**Counts come from the folder index** (`folder_index.rs`): exact, built once
by a walk that never stops writers and then kept one write at a time;
`null` means "still counting", never zero. The count slot reads
`GET /storage/folder` while unfiltered and the view's totals while
filtered, never `useCursorRows`' total. The panel's tree reads each open
level as the owner (`treeQuery`, the first 100 folders by name, then "+N
more · open in the list"), whoever the page acts as: it is the operator's
map, and its figures are the index's, which no rule governs. The listing
beside it meets the rules.

**Live patches rows, and only where it is cheap.** `storage.objects`
(params `{ bucket }`) names the touched objects; `useStorageObjectsLive`
refreshes every non-list key itself, throttled to 250 ms per key, and the
page decides per listing: by name and unfiltered, `rows.applyKeys` patches
those rows through `POST /storage/objects:batchGet` and a new name refetches
only the page it falls in; a sorted or filtered view is never refetched by
a live event, it counts what touched its scope and `MatchCount` offers
Refresh (`stale`). A window of over 1,000 names arrives `truncated`, and a
listing it covers starts again from page one. The topic resumes by replay
over a path-only ring, because the storage revision is global across
buckets. `storage.rules` (compare) keeps the banners true; subscribe only
from the page that shows the data.

**A folder marker is a folder.** A zero-byte `prefix/` object is hidden
inside its folder and drawn by its parent as an empty folder (`empty: true`);
the protocol's own output is untouched. "This folder is empty" says the
marker is what the app's `list()` sees.

**One connection per browser, three long requests per tab.** Previews,
thumbnails and uploads share the tab's three long-request slots
(`storage/net.ts` over `lib/long-requests.ts`): the inspector's preview
first, tiles in view order, then uploads, which hold at most two while a
picture waits. A tile that scrolls away leaves the queue or clears its
`src`. So a console read always gets a connection.

**User bytes never run as the console.** `/storage/object/media` always
sends `nosniff` and a sandbox CSP (PDF excepted) with an inline
disposition; HTML is shown as source or in a script-less `srcdoc` frame,
never `<iframe src>`; "Open in new tab" stays on the console's origin.
**Previews ask for what they draw**: 256 KB of text ("Load all" up to 16 MB),
64 KB of hex (a zip too, with what its first bytes say), a 320 px
thumbnail; a gzip-encoded object is read decoded and never by range
(`media.ts`). Text up to 1 MB that
is valid UTF-8 and not gzip-encoded edits in place; Save writes it as one
upload that keeps the metadata. The list draws type icons; only the grid
and the inspector show pictures, and SVG, AVIF, ICO and images up to
256 KB come from the media route, larger ones from the thumbnail route.

**Uploads are real uploads.** One streaming `PUT /storage/object` per file
(XHR for progress; metadata in `x-firenook-metadata: b64.<base64url
JSON>`; `ifNoneMatch` sends `If-None-Match: *`, and the 409 `already-exists`
it can get is a row skipped as taken), through the commit path: a minted token, the rules as `create` for the identity, the
finalize event. A client identity's drop is judged first with
`POST /storage/rules/evaluate` and refused files are never sent. The queue
is data (`upload-queue-store.ts`, finished rows past 1,000 dropped, the
tray virtualized past 50); the work is `uploads.ts`; the shell's beacon
(`uploads-beacon.tsx`, `shellMount`) reads the queue for the nav's "N
uploading" and the leave-page guard on every page. `setUploadTransport` is
the one way to stand in for XHR (tests, the design-system card).

**Identity applies to everything the Files page does**, previews included:
a file the access check (`POST /storage/rules/access`, `get` and `delete`
for each page, recorded nowhere) refuses is a lock tile with its line, not a
picture, since an `<img>` cannot carry a token. Tokens are Admin-only (the
official API's rule), and so is Send again. A refusal is an
`ApiError` `permission-denied` with `decision`, `line`, `noRuleset`,
`evaluation` and `request` extras, so `RefusalDetail` explains it ("See
why") and hands it to the playground ("Try in the playground") even after
the decision has left the engine's window; a stale metageneration is
`failed-precondition` with `current`, which the inspector turns into
"Changed since you opened it" with Load the new version / Keep mine. The
console reads and writes as Admin where the emulator refuses every client
(a bucket no rules govern), and says so in a banner.

**Foundation Jobs, not loops**, for anything beyond one file:
`POST /storage/objects:<delete|move|copy|metadata>` with a `BulkTarget`
(the ticked keys, or the page's `q` for "Select all"), and `dryRun: true`
for the counts a dialog shows. storage-front does only the batch work:
batches of 200 under one guard through the write path's `*_locked`
pieces (never the locking wrappers: a tokio mutex is not reentrant), one
metadata transaction and one live event per batch, and a wait between
batches while the Functions emulator has over 10,000 requests queued.
Progress, cancel, retention and the jobs badge are the foundation's; a
reload re-attaches through `GET /jobs?section=storage` (`StorageJobs`).
Move hard-links and commits both records at once; copy stages before the
guard and commits like an upload (never new bytes with old metadata, one
new token); both send the events a copy-then-delete sends. A zip of a
folder or a selection streams from `objects:export` (zip64 past 4 GB).
Destruction goes through `DangerConfirm` (its trigger line from
`useTriggersFor`, none while it answers `'unknown'`).

**Storage's log lines are Storage's.** Rules runtime errors and failed
flushes go through `set_log_sink` (still printed to the terminal, never in
the official Logging feed); every recorded denial becomes a
`storage.denied` line (`storage.denied.console` at info for the console's
own) with `EntityRef`s to the file or folder, the decision and the user,
at most 50 a second and then one line counting the rest. A console list
refetched within a minute for the same identity, folder and outcome is not
recorded again: `DecisionLog::record` returns the decision that stands for
it, so a refusal always names one.

**The Rules page is the rules kit's** (`src/rules/`, see Security rules):
Storage adds the `storage.decisions` adapter (`rules-page/decisions.ts`: the
filters are the topic's parameters and the URL, the log keeps the newest
10,000, the engine re-runs the newest 2,000), the playground's file
requests (`requests.ts`, `formFromRequest` for a hand-over), the Folders
tab (which match block governs each folder, from the folder index), starter
rules from a folder's profile, and tests that export as a test file. Change
the kit with both pages' journeys running; coverage is the same report
Firestore reads.

**Keys** (the foundation's reserved table): `g` flat, `v` list or grid,
Shift+Space Quick Look, Alt+⌘C copy the path, `n` new folder, `u` / Shift+U
upload files / a folder, F2 rename, Delete or Backspace delete the ticked
rows, Escape closes the file then clears the ticks, ⌘S saves in the
inspector, the grid's arrows, Home, End, PgUp, PgDn, Space, ⌘A and
Shift+F10. `⌘↑` is deliberately not bound. ⌘K (`storage/palette.tsx`) goes
to a pasted location (gs://, a download URL of production or an emulator,
a JSON API URL, `bucket/path`), recent folders and files, folders the tree
has read and other buckets; rows carry `ref { kind, key }`.

**Test hooks**: the `storage` Playwright project (`e2e/storage.spec.ts`,
`e2e/storage-rules.spec.ts`) on the `storage` profile. The seed
(`scripts/seed/storage.mjs`) exports `STORAGE_SEED`, every count a journey
expects; the fixture (`scripts/fixtures/storage.mjs`) writes per-bucket
rules by default (`STORAGE_RULES_MODE` `single` or `none` for the other
shapes), and its lines 1 to 15 are the journeys' line numbers.
`e2e/support/storage.ts` has `tokenFor`, `upload`/`getMetadata`/
`listFolder` as an app sends them, `ownerJson`, `folderFigures` and
`resetToSeed`; people come from `SEED_USERS` (`?as=<uid>%3A<email>`).
Journeys never count what another journey made: each works in its own
folder. The design-system cards (`design-system/src/cards/storage.tsx`)
render the whole Files and Rules pages over a filled cache, with the card
leading the live channel on the relay, drawing the pictures the media
routes would send and holding uploads mid-way through `setUploadTransport`.

**What building it taught**:
- TanStack Router restores element scroll on every search navigation;
  in-page updates need `resetScroll: false`.
- Kumo's `Popover.Content`, `Dialog` and `Select` drop `data-testid`: put
  test ids on an inner `<div className="contents">`.
- A Kumo tooltip on a focused button eats the first Escape: an overlay that
  must close at once listens at the window in the capture phase.
- Kumo's DataTable header checkbox is `thead [role=checkbox]` (a span).
- `npx playwright test --project data file.ts` takes the file as another
  project name: use `--project=data`. `setInputFiles` refuses buffers over
  50 MB: pass the path of a sparse file. `page.route` then `unroute` while a
  handler still awaits throws "Route is already handled".
- `toContainText('1,201 deleted')` matches "200 of 1,201 deleted…": wait
  for the final "Done: N of N".
- React sets an image's address twice: the attribute when it creates it,
  the `src` property again once it is mounted.
- macOS: temporary names from the clock collide (microsecond clock), and a
  std `Mutex` hands itself straight back to a thread that re-locks, so a
  long walk must sleep between steps or it starves writers.
- A runtime keeps redb open while its console tasks run: `shutdown()` or
  `stop_console_tasks()` before removing its directory.
- `vi.spyOn(Storage.prototype, 'getItem')` misses happy-dom's
  `localStorage`; under Vitest's happy-dom `import.meta.url` is not a file
  URL (read a source with `?raw`).

## Functions, Extensions and Eventarc (built, `src/functions/`, `src/extensions/`, `src/eventarc/`)

Three sections over one engine recorder. Routes: `/functions` (the overview,
a codebase with `codebase=`, a function's workbench with `function=`, its
inspector `tab=run|trigger|environment`, an invocation with `invocation=`,
edit and replay with `prefill=`, `paused`, `q`, `sort`, `source`),
`/functions/invocations` (`q`, `invocation`, `paused`), `/extensions`
(`instance`, `view=overview|configuration|functions|events|readme`, `edit`,
`q`), `/eventarc` (`channel`, `q`, `event`, `new=event`, `prefill`,
`paused`) and `/eventarc/channels` (`channel`). Each schema lives in the
section's `search.ts`; the pages read it through `useRouteSearch`, so the
first route carries the schemas alone. There is no `/eventarc/alerts`: the
engine does not deliver Firebase Alerts yet, an alert function is
`ignored` with that reason, and a journey asserts the page is absent.

**Where things are.** Pure logic with Vitest beside it in
`src/functions/*.ts` (kinds and their verbs, trigger text, the panel tree,
filters, envelopes, callable, identity headers, blocking, Copy as commands,
curl paste, the invoke request and stream, run drafts, saved tests);
pages and forms in `src/functions/components/` (overview, codebase view,
workbench and its Run / Trigger / Environment tabs, the six run forms on
`run-parts.tsx`, invocation list, row and detail, `request-view.tsx`,
`invocation-actions.tsx`). `src/extensions/` and `src/eventarc/` follow
the same split. UI shared by the three lives in `src/compute/`:
`KindBadge`, `DurationText`, `EnvChangeDialog` (every env or parameter
save), the event row, the status words,
`SecretInput` (a password group with its eye and the kit's `CopyButton`
inside the field — not Kumo's `SensitiveInput`, whose copy tab rises over
the field's top edge) and `useSeededPending`. Registry entries in
`lib/sections/{functions,extensions,eventarc}.ts`; the badges sit on pages,
never on the section (`functions.load` on Functions, `functions.failed` on
Invocations), because a section's own badges are marked seen on every one
of its pages.

**The engine.** `crates/functions-runtime/src/monitor/` (store, cause,
outcome, structured), `console.rs` (the control handle), `env_files.rs`,
`watcher.rs`; `crates/extensions/src/control.rs` and `params.rs`;
`crates/console-front/src/compute/` (routes, topics, rings, filters,
search); `crates/suite-runtime/src/console_wiring/compute.rs` (the parts,
the hand-over, the parameter-file watcher, the one Functions log sink).
Generated types in `src/api/generated/compute/`.

- **The Monitor is the only invocation recorder.** Created by the suite
  before Functions start (`console_wiring::compute::parts`, handed to the
  runtime through `FunctionsRuntime::start_with(…, RuntimeOptions {
  monitor, log_delivery: LogDelivery::Attributed })`) and fed by hooks in
  `dispatch`, the worker slot, the loads and `publish_events`; the console
  reads it and registers its topics on it. Never add a second recorder or
  a delivery journal: extend the Monitor's types. Messaging joins its
  fanout to it with `by_event_id` / `by_task`; the per-kind floor keeps
  200 of each kind inside the 2,000-record, 64 MiB bound
  (`MonitorLimits`). `cargo bench -p firenook-functions-runtime --bench
  monitor -- --quick` re-times the hot paths after criterion and fails
  over budget.
- **One id per invocation.** `Monitor::begin` mints `<nonce>-<seq>`; it is
  the `x-firenook-execution` header (to the worker, and in the answer only
  when the request carried `x-firenook-console` or a cause header), every
  log line's `execution` and the console's `#1,284`. Router search values
  are parsed as JSON, so an id written by hand into a URL must be quoted
  (`encodeURIComponent(JSON.stringify(id))`): `40406e-694` unquoted is the
  number 4.04e-690 and the page refuses it.
- **Compute owns attribution end to end**: the worker patch
  (`support/functions-worker.mjs`), the `LogEvent` fields, the single end
  line, and `monitor/structured.rs` — one parser, which observe calls.
  Terminal output and the official logging records do not change:
  `functions_log` prints and records `event.compatible_events()`, and an
  end line with no counterpart before is `consoleOnly`.
- **Live is topics, never a section stream.** `functions.events`,
  `functions.invocation`, `functions.codebase-log`, `eventarc.events` and
  `extensions.changes` on the one channel, fed by the Monitor's live sink
  under its lock into the rings (`functions` 10,000 / 8 MiB, `eventarc`
  4,000 / 4 MiB), resumed by replay; snapshots carry the cursor read in
  the same lock; patches are idempotent (absolute stats, upsert by id).
  Bursts become a marker row (50 rows a batch, exact stats). The feed
  recipe: seed a `createFeedStore` from the page query (newest first, so
  push reversed), subscribe with `after: page.liveCursor` and
  `onItems: store.upsert`, and pass `params: null` until the cursor is in.
  A list opened paused counts only what arrives after its first page
  (`useSeededPending`), or a reload with `paused=true` says "200 new".
- **Finishing rules.** Background invocations finish at the response head
  (the worker answers after the handler settles); HTTP ones at the body's
  end, and a body the caller dropped is drained by a spawned task so the
  record still ends; `clientGone` only when the caller started reading and
  stopped. After a pause and resume the services deliver to both the old
  and the new trigger key, as on the official emulator; the superseded key
  answers 204 and is not recorded.
- **No event body is parsed on the dispatch path.** Senders state the
  cause in `x-firenook-cause-*` headers (names and percent-encoding in
  `firenook_functions_bridge::cause`); the cause and summary are
  classified once, when the started row is serialized.
- **Every `x-firenook-*` header is a control header**, stripped by prefix
  in the runtime and the worker (`headers` and `rawHeaders`); user code
  never sees one, and no response header is added to a request that did
  not ask for it.
- **Paused means dropped.** Sources drop events while background triggers
  are off and count them per service for the shell's banner, the only
  place the paused state is drawn; compute never invents records for them.
  A test event sent while paused is recorded `paused` and runs nothing.
- **Links into other sections are `EntityRef`s the engine builds**
  (`entity.rs` constructors); filtered Logs go through `linkToLogs`.
  Compute exports no link builder. Task causes link the task by
  `task_id(queue, task)` and the queue; Run now goes through messaging's
  `ScheduleControl::run` and Enqueue through `TasksConsole::enqueue_console`
  (a reserved name or a full queue is a conflict, said in the form).
- **"Which functions fire here" has one matcher**: `GET
  /functions/triggers` (through `useTriggersFor`, `'unknown'` while
  starting, one reference-counted `functions.events {changesOnly}`
  subscription per tab) and `POST /functions/match`, both on one matcher
  in `console.rs` (Firestore's through the bridge's `explain_match`).
- **Test events are the functions shell's envelopes.** `envelopes.ts` is a
  port of `packages/cli/src/invoke.mjs` held to it by a parity test that
  imports the CLI module; change both or neither. 2nd-gen Firestore test
  events are JSON (the shell's form), real deliveries protobuf, decoded
  for the detail with `decode_document_event`; the SDK takes both.
- **Run answers follow the invocation to its end.** `RunAnswer` reads the
  kept record (patched by `functions.invocation`), so a direct Run now
  stops saying Running; `useNextInvocation` subscribes to the function's
  events from mount and keeps the last 50 finished, so "Do it for real"
  finds an invocation that finished before its request returned. Only an
  `http` cause shows its status code as the chip's word (`chipStatus`); a
  callable, a blocking function or a task says Succeeded, the callable
  status or Allowed.
- **Never send the engine's inherited environment.** Only the count; a
  journey sets a sentinel variable and asserts it never reaches the page.
- **Secrets are revealed, never listed.** `.secret.local` values,
  extension secrets and sensitive request headers are null with
  `sensitive: true` in every list and detail; the reveal routes read them
  at request time; replay reads them inside the engine.
- **A file change that does not load never stays on disk.** Extension
  reconfigure and codebase env edits restore every file they wrote when
  the reload fails. The console's own writes never cause a second reload:
  self-writes are keyed by the canonical path (the watcher reports
  `/private/var/…` where the console wrote `/var/…`) and forgotten once
  the file holds anything else. An env file edited on disk does not reload
  a codebase — it flags `envChanged` until Reload — while an extension's
  parameter file edited on disk reloads that instance.
- **Mutations take JSON and come from the console.** Every mutating compute
  route takes a `ConsoleJson` body; the foundation's guard covers the
  mount.
- **Outcome words and classes** come from the engine; the client never
  derives a class. `OutcomeChip` is the foundation's.
- **Invocation logs** are observe's `LogLine` rows through `LogLines`: in
  an invocation, a 52 px offset column (84 px once a line is a minute in)
  and no level column while every line is info, so a one-line message
  gets the row; a codebase's load log keeps the clock column.
- **Per browser**: run drafts per tab in sessionStorage
  (`firenook.console.run-drafts`), saved tests in localStorage (50 per
  function, 1 MB per project, export and import as JSON), the editor that
  stack frames open in (`firenook.console.editor`: VS Code, Cursor,
  JetBrains).

**Journeys** (`--project compute`): `e2e/functions*.spec.ts`,
`extensions.spec.ts`, `eventarc.spec.ts`, helpers in
`e2e/support/compute.ts` (every compute spec imports it, which sets the
environment sentinel before the worker's engine starts). The profile
(`scripts/profiles/compute.mjs`) runs the shared codebase on the offline
`firebase-functions` install with `FIXTURE_STREAMS: 'compute,auth'`:
compute's functions in `scripts/fixtures/functions/compute.js` (and
`compute-eventarc.js`), the blocking ones from `auth.js`, users from
`SEED_USERS`. `scripts/fixtures/compute.mjs` writes the `jobs`
(TypeScript) and `broken` codebases and `functions/.secret.local` from
strings, because `tsc` and oxfmt read every file under `scripts/`; ids are
unique per project, so jobs' function is `heartbeat`. Never a static
`functions.yaml` in the shared codebase (it hides every other stream's
functions). A worker-scoped `engineOptions` needs a file of its own.
Restore any env file a journey edits and reload the codebase. Journey 11
(blocking) skips until the Authentication stream's `auth.js` is in.

**Known gaps.** A handler error the SDK catches itself (a schedule
answering 500 with an empty body) leaves `InvocationSummary.error` null.
(The Admin SDK's Eventarc publish from function or extension code needs no
credential of its own: the worker answers the synthetic credential's token
exchange, so the greeter fixture calls a plain `initializeApp()`.)

## Pub/Sub and Cloud Tasks (built, `src/pubsub/`, `src/tasks/`, shared code in `src/messaging/`)

**Pages.** Pub/Sub is one nav entry with three pages: Topics (`/pubsub`,
`routes/pubsub.tsx`), Schemas (`/pubsub/schemas`, `routes/pubsub_.schemas.tsx`)
and Schedules (`/pubsub/schedules`, `routes/pubsub_.schedules.tsx`). Schedules
lives under Pub/Sub because a tick is a publish to `firebase-schedule-<name>`;
this stream owns the scheduler and the `ScheduleControl` trait
(`crates/pubsub-front/src/schedule_control.rs`) that compute's Run now calls.
Cloud Tasks is one page (`/tasks`, `routes/tasks.tsx`): the queues in the
panel, a queue with Tasks, Attempts, History and Configuration, a task in the
inspector (Payload, Request, Attempts).

**Search parameters.** Topics: `topic` and `subscription` (an id under the
page's project, or a full name that travelled whole), `view` (`messages`,
`subscriptions`, `deliveries`, `snapshots`, `settings` on a topic; `backlog`,
`pull`, `push`, `dead-letters`, `settings` on a subscription), `message`,
`tab`, `q`, `expr` (a subscription filter expression over attributes),
`state`, `function`, `outcome`, `paused`, `new`, `dialog` (`replay`, `setup`,
`export`), `prefill`, `project`. Schemas: `schema`, `revision`, `diff`, `view`,
`panel=test`, `new=schema`. Schedules: `schedule` (the function id). Tasks:
`queue` by id with `location` only when two locations register that id (the
page drops it otherwise), `view`, `task` (the console's decimal id), `tab`,
`state`, `outcome`, `q`, `paused`, `new=task`, `prefill`. The router parses
query values as JSON, so `?message=40` arrives as a number and an id of
digits is written quoted (`message=%2246%22`): the schemas accept a string or
a number and normalize (`text` in `routes/pubsub.tsx`, `src/tasks/search.ts`).

**Links.** `pubsub.topic`, `pubsub.subscription` and `pubsub.schema` are keyed
by full name, `pubsub.message` by `<topic full name>|<id>`, `pubsub.schedule`
by function id, `tasks.queue` by `<project>|<location>|<queue>` and
`tasks.task` by that plus `|<task id>`; the registries' `routes` open them
(`src/messaging/links.ts`). A link always writes `project` (and `location`
for Tasks) and the page tidies what it does not need; a subscription link
carries no topic, which the Topics page completes from its index. These pages
link out only through `EntityLink`, `linkTo` and `linkToLogs`, and never
write another section's URL.

**Topics, not streams.** Eight, declared in `src/pubsub/live.ts` and
`src/tasks/live.ts`: `pubsub.counters`, `pubsub.schedules` and
`tasks.counters` are `compare` (state: without a cursor they open with every
entity of the project, and over 1,000 they answer a reset instead; then
changes after the revision, at most every 250 ms and 200 a frame, throughput
for at most 24 topics on screen); `pubsub.topic`, `pubsub.deliveries` and
`tasks.queue` are invalidation (published ids, moved backlog keys, delivery
event ids, task row keys and finished ids, which the page reads back through
`:batchGet`); `pubsub.push` and `tasks.attempts` are `replay` over a console
ring fed inline by the runtime's sink. Time is a stamp, not a window: a
throughput window carries its end and the client ages it
(`src/messaging/windows.ts`). A list read again catches up with the frames
that arrived meanwhile (`src/messaging/frames.ts`, 32 frames or 10 s per
project), because a tab joining a shared subscription gets only the latest
event of each name. `pubsub.schedules` also follows compute's Monitor, so a
run's outcome arrives live; a reconnect while Functions run gets a reset.
Never a per-message broadcast, never `new EventSource`.

**The broker has two watches.** `changed` is deliverability: waiting pulls
wake on it. Everything the console needs goes on `console`. A console-only
bump on `changed` makes every waiting pull spin.

**Lists are pages with meta; mutable rows are patched.** `messageList`,
`backlogList`, `deliveryList`, `taskList` and `historyList` (in each section's
`queries.ts`) go through `useCursorRows`. Backlog, task and delivery rows are
keyed by position or event id and patched in place through `:batchGet`;
message and History heads read again at the top and count `newAbove` below
it; the window is 20 pages. Message rows are deduplicated by id and backlog
places renumbered (`src/messaging/rows.ts`).

**Peek is the default, Pull is a choice.** Nothing on screen leases a message
unless the person pressed Pull. Pull warns when a subscriber is connected, is
absent on a subscription the functions consumer drains, and explains itself
on a push subscription. `a`, `x` and `e` act only in the Pull tab, on a
received row.

**Console-only controls never reach the wire**: pause, hold, stop retrying,
force acknowledge, release, publish jobs (foundation `Job`s), schedule pause
and clear. Every engine change in these crates passes the oracle replays:
`npm run replay:pubsub` and `npm run replay:functions:runtime -- --fixture
fixtures/tasks-v1/emulator-programs.json --profiles tasks`.

**Deliveries are compute's record joined by event id**: a topic's Deliveries
tab and a message's deliveries read the fanout the runtime recorded and the
invocation compute keeps; `GET /pubsub/dispatch?event=` serves the request
each delivery received (a run again has its own CloudEvent id). When the SDK
caught the handler's throw itself (`onSchedule` answers 500 with no body), the
failure takes its error from the invocation's first error-level log line.
Never add a second journal. Suite facts are not drawn here: background
triggers and foreign projects are the shell banner's.

**Setup export and import** (`src/pubsub/setup.ts`, `dialog=setup`): version 2,
indented JSON, function-managed resources (schedule topics, `emulator-sub-*`)
left out; the import previews what it creates, what exists and what it leaves
out, and moves a file from another project into the one shown.

**Cloud Tasks reads the engine's figures.** History's counts by outcome, the
retry ladder, a task's retry plan and the sentence saying when the emulator
gives up come from the engine (`TasksQueueCounters.outcomes`,
`TasksQueueConfig.ladder`, the dispatcher's own rules), never from the
browser. A newly enqueued task opens in the inspector. A real
`onTaskDispatched` answers 204, and an `HttpsError` arrives in the attempt's
response snippet, not its error.

**Names travel whole in query strings**, never as path segments; a queue
travels to the engine as its opaque key.

**Memory bounds** are DESIGN.md's (Pub/Sub and Cloud Tasks for the console).
Any new console-held state in these crates needs a bound and an eviction rule
in the same commit.

**Shared code** (`src/messaging/`): `api.ts` (query strings, page cursors),
`frames.ts`, `links.ts`, `rows.ts` and `windows.ts`. Run again, Run now and
Enqueue again ask through the kit's `ConfirmPopover` (`useConfirmPopover`,
`rowElement`), because they run the handler; Delete goes through
`DangerConfirm`; a failure reads through `errorText` (`lib/error-text.ts`).

**The messaging fixture**: `scripts/fixtures/functions/messaging.js` (the real
SDK, loaded through `FIXTURE_STREAMS`) and the seeders `scripts/seed/pubsub.mjs`
and `scripts/seed/tasks.mjs`. Journeys create their own topics and client
queues through `e2e/support/messaging.ts` and need the functions SDK
(`npm run e2e:sdk`, or `FIRENOOK_FUNCTIONS_SDK` pointing at a `node_modules`
holding it). The scale journeys (`pubsub-scale.spec.ts`,
`tasks-scale.spec.ts`, `@perf`) are opt-in with `FIRENOOK_PERF=1` and need no
`FIRENOOK_SEED_SCALE`: each starts its own engine and seeds it.

**Honest notes**: one sentence where the emulator differs from production,
shown only where the difference bites — push retries every second and never
dead-letters (the Push tab), `maxAttempts` + 1 runs (the Attempt column and
the retry plan), a schedule time does not delay a task unless the queue holds
scheduled tasks (the ETA column), a re-registration replaces a queue (its
banner).

**Keys**: the foundation's reserved-keys table, no new row. `n` publishes on
a topic (a new schema on Schemas, Enqueue on a queue), `p` pauses the Push
and Attempts feeds, `r` and Shift+R run again (behind a confirmation, or
through a form), `l` opens in Logs while Logs is built, `a`/`x`/`e` only in
the Pull tab, Delete acknowledges ticked backlog rows, `c` and Shift+C copy
in the Attempts feed.

**Testing gotchas.** Kumo `Select` does not forward `data-testid`: find it with
`getByRole('combobox', { name })`. A single-key shortcut pressed while focus
is still in a closing popover or dialog is skipped, so wait for the overlay to
go. `DataTable` draws only the rows on screen: count with the `MatchCount` or
the footer. The design-system cards are `console/design-system/src/cards/messaging.tsx`.

## Logs and the overview (built, `src/logs/`, `src/overview/`)

Where things are. Engine: `crates/console-front/src/observe/` (`log.rs` the
console log, `fields.rs` the Logs filter fields, `logs.rs` the routes and the
`logs.entries` topic, `overview.rs` the state and the engine details,
`firestore_data.rs` Firestore's summary and clear, `snapshots.rs` the snapshot
job and its file). Producers write `LogInput` (`suite-front`
`console_input.rs`, kinds declared once in `kinds`); the suite's wiring is
`suite-runtime/src/console_wiring/observe.rs`. Console: `src/logs/` (the page),
`src/overview/` (`/`), `src/observe/` (only what those two share: the topic
declarations, kinds, `LevelWord`, `SourceChip`, the level series and
`LevelStrip`), the registry `src/lib/sections/logs.ts` (badge, routes,
`linkToLogs`) and `logs-actions.ts` beside it (the suite-wide ⌘K actions). Journeys: `e2e/logs.spec.ts`,
`e2e/overview*.spec.ts`, helpers `e2e/support/observe.ts`, profile `observe`.

- **The log ring.** One `ReplayRing` of 20,000 lines / 16 MiB, and a problem
  ring of 2,000 / 2 MiB holding the same entries (shared, not copied); a
  filter that can only match problems (`is:problem`, `level:error`, a problem
  `kind:`) reads both — because a flood would otherwise erase the error it
  was caused by. The last Functions reload is remembered outside the rings.
  Everything a filter reads (the JSON, the search text, interned labels, the
  problem, marker and internal flags) is computed once when the line
  arrives; readers snapshot the rings and filter outside every lock.
  Batching, lag recovery and resume are `replay_topic`'s; never write them
  again for a feed.
- **The open sequence.** `GET /logs/entries` (the newest 500) → subscribe
  `logs.entries` with `after: page.tail`: no gap, no duplicate. Cursors carry
  the epoch, so a restart can never resume at an old number (`entry=` from
  another run says so); `older` is passed as `before`, `newer` as `after`.
  Pages are fetched by the feed into its store, never cached as queries: a
  cached page is a stale second copy of what the store holds.
- **Paused freezes.** `FeedList pausedMode="freeze"`: nothing is appended
  while paused; `PauseButton` and the pill count what arrived. Resume
  replays up to 1,000 lines, or reopens at the newest page under "1,204
  lines arrived while paused" — because trimming under a reader with
  measured rows jumps the view, and an unbounded paused buffer grows without
  limit. `FeedList` freezes the store in its own effect, which runs before
  the page's: the feed writes a page while paused through
  `resume(); push(); pause()`.
- **Hidden tabs parse nothing.** The Logs subscription is given back at once
  on `visibilitychange` (the channel's own release waits 20 s) and taken
  again from its cursor when shown — because rAF does not run in a
  background tab and a buffer would flush hundreds of thousands of lines in
  one frame.
- **Counts come from the engine.** `MatchCount`, the facets and the volume
  strip are refetched (trailing, at most every 1.5 s, only while lines
  arrive), never patched in the browser — because the ring evicts and a
  patched count only ever grows.
- **Attribution is compute's.** `functions_input` maps compute's `LogEvent`
  to a `LogInput` and calls compute's structured-line parser; the legacy
  feed stays one record per printed line with today's levels. A line that
  names its function only in its terminal label (`functions[us-central1-hello]`)
  is filtered by that label as a phrase — the source chip writes that, never
  a `function:` that would match nothing.
- **Kinds are the mechanism.** Badges, recent problems and facets are views
  over entries and their totals: to make a line countable, emit it with a
  kind through `LogInput` from the stream that owns the crate (declared once
  in `kinds`, `LOG_KINDS` generated, a facet plural in `src/observe/kinds.ts`)
  and declare a badge in the registry. A kind without a label fails a test.
- **Every `Section::summary` is lock-free and O(1).** Never
  `Snapshot::databases()` or `object_bytes()` on a status tick. Firestore's
  figure walks this project's keys once (the blocking pool, first Overview
  read) and then moves by each commit's delta; commits in other projects
  move a separate count by revision, so an app writing to another project
  id never inflates this project's card.
- **Data actions are foundation jobs.** Never run a reset or an export inside
  a request: a snapshot is a `suite.snapshot` job, a reset `/suite/clear`,
  and the registry's one-`suite.*`-job rule keeps them apart (the next is
  `409`). The snapshot's id is `job.result.snapshot` (128 random bits), not
  the job id; the engine keeps the newest one for 10 minutes or until it is
  downloaded, and only the tab that started it downloads it by itself.
- **A reset is maintenance.** Firestore's clear commits through
  `commit_maintenance`: listeners and the change feed see it, the trigger
  observer does not (unless `runTriggers`), and open Firestore pages reload
  once at its start and once at its end (`announce_rebuilt`; two in 100 ms
  are one). Every new trigger-like `CommitObserver` must ignore
  `CommitOrigin::Maintenance`.
- **The data cards draw from what they are given.** `DataCards` takes the
  status and a `SnapshotView`; `DataSection` keeps the hooks (the jobs topic)
  and the three dialogs. Keep it that way: a design-system card cannot
  subscribe, so a component that both subscribes and draws cannot be shown
  there.
- **Figures above 14 px.** The Overview's headline figures are 16 px mono
  medium — the only figures above 14 px, because each is its card's
  subject; their labels are 12 px sans. A card without figures says what its
  section holds in one line (`cardHolds`), never a made-up zero.
- **Import `@/observe/live` for its effect.** `import '@/observe/live'`, never
  `import type` alone: the `declareTopic` calls would not run and `overview`
  would resume as `replay` (one engine subscription per subscriber, no
  state for a newcomer).

Gotchas: a log line's refs are `EntityRef`s built with the foundation's
constructors, never by hand, so their keys match the registry's `routes`; a
refused collection-group list carries `firestore.collection` `**/orders`,
which Firestore's route opens as the group. The console's REST mount is a
separate `rest_router` with a `with_origin(Console)` rules handle: a new
console data route must use it, or its denials count as the app's (and raise
the Rules badge). The engine refuses a bad regex with `span` beside `error`;
`logs/api.ts` reads it itself (`LogsRequestError`), because the client's
`ApiError` keeps code, message and fix only. The router parses search with
`lib/search-params.ts` `parseSearch`: a bare number stays text (a
hand-typed `?invocation=40406e-694` or `?uid=12345`), so a param that is a
number coerces it (`z.coerce.number()`); a hand-typed `?q="Cart is empty"`
still arrives as words. A string `LogLine` source truncates with an
ellipsis (inside a FeedList the row's hover is the only ink). A value derived from `useSyncExternalStore` must
take the store's version as an input, or the compiled hook keeps its first
answer (`useNotices`). Kumo's `Button` turns `title` into a tooltip on a
disabled button; that is how a data control says why it waits.

## Repository rules that apply here too

The independence rule (AGENTS.md) covers fixtures, seeds, screenshots and
copy in the console. Merged-but-unpublished sections are described as "on the
way", never as available. Performance claims about the console need
acceptance-host numbers.
