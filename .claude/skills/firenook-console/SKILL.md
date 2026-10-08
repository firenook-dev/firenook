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
params), TanStack Query (server state), TanStack Table + Virtual (grids),
TanStack Form + zod (editors), Zustand (ephemeral UI state), Kumo on Base UI
(components), Tailwind 4 with Kumo's semantic tokens, Phosphor icons. Not
used: TanStack Start (there is no JavaScript server; the Rust binary serves
the app), TanStack DB and Store (pre-1.0), MobX, `dark:` variants, CDN fonts.

## Where state lives

1. Server data: TanStack Query, keyed by scope. Never poll. Live updates come
   from the console channel and patch or invalidate by scope.
2. View state: the URL, through Router search params (path, filters, order,
   selection, tab). Every view is a shareable link.
3. Ephemeral UI state: `src/lib/store.ts` (Zustand): palette, socket status,
   selection sets. Layout choices that should survive a reload live in
   `src/lib/layout.ts` (localStorage per browser).

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
  shell shows the slot only while a section fills it; the button at the
  left of the top bar and `t` hide and show it (`useLayout.panelOpen`,
  remembered). Sections without a panel get the full width.
- The content column has no padding of its own. Document-like pages wrap
  themselves in `<Page>` (`page.tsx`, the reading gutter); workbenches fill
  it edge to edge with their own toolbar and borders.

## Speed rules, enforced

- No polling, deltas only.
- Virtualize every long list (rows, log lines, JSON trees).
- First route under 300 KB gzip: `npm run budget --prefix console` reads the
  Vite manifest and fails over budget. Lazy-load CodeMirror, shiki, echarts.
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
would write the fragment over the value. The inspector is unaffected: it has
always fetched the document itself (2 ms for a 100 KB one).

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
change feed does this with `take_until`, and so do the logging and Requests
sockets; and `serve_until_shutdown` gives the drain `DRAIN_GRACE` and then
closes whatever is still connected, which is what catches a client that
stopped partway through a request. Add a streaming endpoint and it needs the
first rule; the second is already there for everything. `transport_tests.rs`
holds the reproduction beside the fix for both the HTTP and the gRPC side.

## Commands

```
npm run dev --prefix console          # Vite with HMR, proxies /console/api to FIRENOOK_UI_ORIGIN (default http://127.0.0.1:4000)
npm run build --prefix console        # writes console/dist; debug engine builds read it from disk at runtime
npm run check|lint|format:check|test|budget --prefix console
npm run test:e2e --prefix console     # Playwright against target/debug/firenook and a synthetic project (e2e/engine.ts)
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
| page (Overview, a section placeholder) | 20 px `heading size="lg"`, sections 16 px | 14 px | — |
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
hover is `bg-kumo-base`, which only ever appears while the field is lit, so
it always has the ground to stand against.

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
`Explain`, what came back, and `Code`. A control that belongs to both rows
belongs in row one.

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

A chip on a row that lights up on hover has to move the other way or it is
swallowed: `TypeBadge` takes `group-hover:bg-kumo-base`, and both the
header button and the inspector's type trigger carry `group`. A journey
holds every settled badge to one ground and the mixed one to a different
one, and fails the moment a second colour appears.

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

## Firestore workbench (built, `src/firestore/`)

- Data path: the browser talks Firestore REST to the console's own origin
  (`/console/api/v1/firestore/v1/...`, a second `rest-front` router on the
  same service), Identity Toolkit at `/console/api/v1/auth/...` and the
  Requests websocket at `/console/api/v1/firestore/requests`. Never reach
  the service ports from the browser.
- Live: `GET /console/api/v1/firestore/changes?database=` is an SSE stream
  from the store's commit observer (`ChangeFeed` in
  `crates/console-front/src/firestore.rs`); `src/firestore/live.ts`
  invalidates TanStack Query scopes and flashes rows. Payloads are paths
  only, never documents.
- Identity: `Authorization: Bearer owner` bypasses rules; "view as" mints
  an unsigned `alg: none` emulator token for an Auth user
  (`src/firestore/view-as.ts`), so rules run exactly as for the app.
- View state is the URL (`path`, `q`, `group`, `as`, `doc`, `tab`);
  selection and focus are Zustand; queries are keyed
  `['fs', db, kind, scope, ...]` so the channel can target them.
- Query text is the SDK chain (`where(...).orderBy(...).limit(n)`), parsed
  and printed by `src/firestore/query.ts`; cursors are exact because
  `__name__` is always the last order.
- Seed a synthetic project for development: `npm run seed -- <ui-origin>
  <project>` (`scripts/seed-firestore.mjs`; the e2e global setup uses it;
  the synthetic engine's rules deny listing `users` to clients so "view as"
  has denials to show).
- Creating: every path into the create dialog is a `CreateRequest` on the
  `useCreateDialog` store (`src/firestore/create.ts`): `document` (with an
  optional `template` to duplicate or `id` for a missing ancestor),
  `collection` (its first document creates it; `parent` empty = root) and
  `import` (object keyed by id, array or NDJSON, batches of 200 `set`s). An
  explicit id uses a `create` write (`currentDocument.exists: false`); the
  engine answers 412, shown as "already exists". `FieldsPanel` in
  `field-editor.tsx` is the typed rows + JSON view shared by the inspector
  and the dialog; `draftsFromJson` keeps timestamp/reference types when the
  text is unchanged.
- Grid interactions: `HeaderMenu` writes `orderBy` into the query (the header
  shows the arrow) and composes `where("field", "==", )` into the query line
  through `useQueryLine.compose` (caret placed before `)`); hidden columns
  live in `useColumns`, reset per collection. Inline editing
  (`InlineCellEditor`) is for string/number/boolean/timestamp/null/unset
  cells; a click that would open the inspector over the clicked cell waits
  `DOUBLE_CLICK_MS` so a double-click can edit instead. Columns keep their
  width (a trailing filler `<col>` takes the slack) so nothing moves when
  the inspector opens. Column widths come from `inferColumns`: the type's own
  width, or the header's needs when those are greater, capped at
  `MAX_HEADER_WIDTH`. `headerWidth` counts the type badge's text as well as
  the field name, because a two-letter field under a `boolean` badge needs
  more room than its values ever will; the cap stops one long field name
  from pushing every other column off the screen. Both ends are covered by
  `columns.test.ts` and a browser journey. Reference cells and reference fields *peek*
  (`selectDocument`) rather than navigate; the inspector shows "open in
  grid" when the document is outside the current collection.
- The schema panel: `GET /console/api/v1/firestore/schema?database=` is the
  engine's schema index (`SchemaIndex` in `crates/console-front/src/schema.rs`:
  patterns like `users/*/orders` with `documents` and `parents` counts, one
  key-only snapshot walk on the first request per database, then exact
  through the commit observer; process-local, never persisted). The console
  side is `src/firestore/schema.ts` (`schemaQuery`, `patternOf`, `findNode`,
  `childrenOf`, `filterSchema`, `isExpanded`, the `useSchemaTree` store) and
  `components/schema-panel.tsx`, which fills the shell's section panel with
  the database picker, a filter and the tree. The picker is fed by
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
- Undo (the live indicator's popover, ⌘K): `ChangeLog` in
  `crates/console-front/src/changelog.rs` is a commit observer keeping a
  bounded window of commits with the `before`/`after` images the store hands
  it, so an undo restores the exact document rather than a re-derivation.
  `GET /changelog` lists, `POST /undo` applies the inverse as **one** commit
  with a precondition per document, so a change something has moved past is
  refused whole. Two rules that are easy to get wrong: a document written
  twice in one commit must collapse to a single inverse (two writes would
  precondition on different update times and refuse each other), and the
  undo's own commit is found again by the revision it installed, not by
  being the newest. The window carries document data, so it is bounded in
  commits and bytes, drops a commit over `MAX_COMMIT_BYTES` rather than
  letting a bulk import evict everything, and is attached only when
  `config.diagnostics` is on — the route is then simply absent, and the
  console reads a 404 as "diagnostics are off" rather than "nothing
  happened". The console asks only while the popover is open, because the
  live channel invalidates `['fs', db, 'changelog']` on every commit.
- Rules (`?view=rules`, the toolbar's Rules button, ⌘K): `RulesEditor` in
  `crates/console-front/src/rules.rs` reads `RulesRuntime::rules_for(...)`
  and replaces a database's ruleset with `install_database`, which is the
  level `firebase.json` declares rules at and the level that takes
  precedence. **Compile before writing**: a ruleset that does not compile
  must change nothing and must never reach the file, and `LoadError`'s
  diagnostics carry the line and column the editor places. Applying and
  saving are separate — a change is in force the moment it compiles and
  reaches the repository only when asked. `?view` switches the content
  column rather than adding a route, and `setPath` clears it, because
  choosing a collection is asking for its data. The editor is a textarea
  over a numbered gutter in one scroller: a code editor would cost several
  times its worth of the first-route budget.
- ⌘K is the shell's palette; pages contribute through
  `usePaletteProviders.register(key, (query) => groups)` (`src/lib/palette.ts`).
  Firestore's provider (`src/firestore/palette.tsx`) adds Go-to for
  path-shaped text, recents (`src/firestore/recents.ts`, localStorage per
  project+database), every pattern of the schema tree (a nested one opens
  as its group) and its actions; the panel toggle (`t`) and the nav modes
  are the shell's "Layout" group. `matchesQuery` is word-wise: every word
  of the query must appear in the title, breadcrumbs or keywords.
- Kumo gotchas met here: `DropdownMenu.RadioItem` needs `closeOnClick`;
  `CommandPalette.Results`/`Items` render functions must return keyed
  elements; a `Tooltip` inside a `<button>` nests buttons (use `title`);
  `Popover.Content` drops unknown props, so a test id goes on a div inside
  it; a Kumo toast puts the same words in its title and its description, so
  a journey matches the heading by role;
  `Text` takes no `className` (wrap it). A Rust doc comment on a `ts-rs`
  type must not contain `*/` (it ends the generated JSDoc early), so
  patterns are described in words there.

## Repository rules that apply here too

The independence rule (AGENTS.md) covers fixtures, seeds, screenshots and
copy in the console. Merged-but-unpublished sections are described as "on the
way", never as available. Performance claims about the console need
acceptance-host numbers.
