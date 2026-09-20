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
3. Ephemeral UI state: `src/lib/store.ts` (Zustand): palette, layout, socket
   status, selection sets.

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
(`--color-kumo-brand` and the link colour) and the IBM Plex type pair,
self-hosted from `public/fonts`. The accent is reserved for the primary
action, active navigation and links; switches use `variant="neutral"` (Kumo's
default switch is hard-coded blue) so they match the checkbox.

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

## Repository rules that apply here too

The independence rule (AGENTS.md) covers fixtures, seeds, screenshots and
copy in the console. Merged-but-unpublished sections are described as "on the
way", never as available. Performance claims about the console need
acceptance-host numbers.
