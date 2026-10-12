// What the Logs and Overview journeys (`logs*.spec.ts`, `overview*.spec.ts`,
// project `observe`) do to an engine and read back from it: calls to the
// observe fixture's functions (`scripts/fixtures/functions/observe.js`),
// reads refused by the rules on the Firestore port, and the engine's own
// answers about its log, which every count on the page must equal.

import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type Locator, type Page, expect } from '@playwright/test'
import { resolveFunctionsSdk } from '../../scripts/functions-sdk.mjs'
import { type SeedUser, SEED_USERS } from '../../scripts/seed/identities.mjs'

/** An engine as these helpers need it: the worker's or a dedicated one. */
export interface ObservedEngine {
  origin: string
  project: string
  ports: Record<string, number>
}

// The engine's answers, as much of each as the journeys read (the console's
// generated types live in the app's project, not this one).

/** One line of the console log (`LogEntry`). */
export interface LogEntry {
  cursor: string
  time: string
  level: 'debug' | 'info' | 'warn' | 'error'
  service: string
  source?: string
  function?: string
  execution?: string
  kind?: string
  message: string
  payload?: Record<string, unknown>
  refs?: { kind: string; key: string }[]
}

/** A slice of the log (`LogPage`). */
export interface LogPage {
  items: LogEntry[]
  older: string | null
  newer: string | null
  tail: string
  anchor: string | null
}

/** The engine's counts for a view (`LogFacets`). */
export interface LogFacets {
  kept: number
  matched: number
  logged: number
  internalHidden: number
  levels: { value: string; count: number }[]
  kinds: { value: string; count: number }[]
  lastReload: string | null
}

/** The volume of a view (`LogHistogram`). */
export interface LogHistogram {
  from: string
  to: string
  bucketMs: number
  buckets: { debug: number; info: number; warn: number; error: number }[]
}

/** The seed people (`scripts/seed/identities.mjs`), by first name. */
export const ADA = SEED_USERS[0] as SeedUser
export const GRACE = SEED_USERS[1] as SeedUser

/** A name no other journey has used: a uid, a document id, a marker in a line. */
export function unique(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
}

export interface FunctionCall {
  status: number
  body: string
  /** The invocation id the engine sends back to a console request (compute's monitor), if any. */
  execution: string | null
}

/**
 * Calls one of the fixture's HTTP functions on the Functions port, as an
 * app would, and reads the response to its end: no journey depends on a
 * line that only a drained body would bring.
 */
export async function callFunction(
  engine: ObservedEngine,
  name: string,
  query: Record<string, string | number> = {},
): Promise<FunctionCall> {
  const search = new URLSearchParams(
    Object.entries(query).map(([key, value]): [string, string] => [key, String(value)]),
  )
  const url = `http://127.0.0.1:${engine.ports.functions}/${engine.project}/us-central1/${name}${
    search.size > 0 ? `?${search}` : ''
  }`
  const response = await fetch(url)
  const body = await response.text()
  return { status: response.status, body, execution: response.headers.get('x-firenook-execution') }
}

const api = (engine: ObservedEngine, path: string, params: Record<string, string> = {}) => {
  const search = new URLSearchParams(params)
  return `${engine.origin}/console/api/v1/logs/${path}${search.size > 0 ? `?${search}` : ''}`
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url} → ${response.status} ${await response.text()}`)
  return (await response.json()) as T
}

/** A page of the log, as the Logs page reads it (`GET /logs/entries`). */
export function logPage(engine: ObservedEngine, params: Record<string, string> = {}) {
  return readJson<LogPage>(api(engine, 'entries', params))
}

/** The engine's counts for a view (`GET /logs/facets`): what `MatchCount` and the panel show. */
export function facetsOf(engine: ObservedEngine, view: Record<string, string> = {}) {
  return readJson<LogFacets>(api(engine, 'facets', view))
}

/** The engine's volume for a view (`GET /logs/histogram`): what the strip draws. */
export function histogramOf(engine: ObservedEngine, view: Record<string, string> = {}) {
  return readJson<LogHistogram>(api(engine, 'histogram', view))
}

/** The newest line matching `filter` (the Logs filter language), if the engine keeps one. */
export async function newestLine(
  engine: ObservedEngine,
  filter: string,
  params: Record<string, string> = {},
): Promise<LogEntry | undefined> {
  const page = await logPage(engine, { q: filter, limit: '1', ...params })
  return page.items.at(-1)
}

/** The cursor of the newest line matching `filter`: what `linkTo` builds a `logs.entry` link from. */
export async function cursorOf(
  engine: ObservedEngine,
  filter: string,
): Promise<string | undefined> {
  return (await newestLine(engine, filter))?.cursor
}

/** Waits until the engine has logged a line matching `filter` (after `after`, when given) and returns the newest. */
export async function lineOf(
  engine: ObservedEngine,
  filter: string,
  options: { after?: string; timeout?: number } = {},
): Promise<LogEntry> {
  let found: LogEntry | undefined
  await expect
    .poll(
      async () => {
        found = await newestLine(engine, filter, options.after ? { after: options.after } : {})
        return found !== undefined
      },
      { timeout: options.timeout ?? 15_000, message: `a line matching ${filter}` },
    )
    .toBe(true)
  return found as LogEntry
}

/** Sum of every level of every bucket: the lines a histogram counts. */
export function histogramTotal(histogram: LogHistogram): number {
  return histogram.buckets.reduce(
    (sum, bucket) => sum + bucket.debug + bucket.info + bucket.warn + bucket.error,
    0,
  )
}

/** One part of a JWT: JSON, base64url. */
const jwtPart = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

/**
 * An ID token for `user` that the emulator accepts: unsigned (`alg: none`),
 * with the claims the Auth emulator would put in a real one — the way the
 * Firebase SDKs talk to it, and what the console's `mintUnsignedToken`
 * writes for a custom identity.
 */
export function unsignedToken(user: SeedUser, project: string): string {
  const now = Math.floor(Date.now() / 1000)
  return `${jwtPart({ alg: 'none', typ: 'JWT' })}.${jwtPart({
    iss: `https://securetoken.google.com/${project}`,
    aud: project,
    auth_time: now,
    sub: user.uid,
    user_id: user.uid,
    iat: now,
    exp: now + 3600,
    email: user.email,
    email_verified: true,
    firebase: { identities: { email: [user.email] }, sign_in_provider: 'password' },
  })}.`
}

const firestoreApp = (engine: ObservedEngine) =>
  `http://127.0.0.1:${engine.ports.firestore}/v1/projects/${engine.project}/databases/(default)/documents`

/** Reads a document on the Firestore port as `user`, the way their app would: the status. */
export async function readAs(
  engine: ObservedEngine,
  user: SeedUser,
  path: string,
): Promise<number> {
  const response = await fetch(`${firestoreApp(engine)}/${path}`, {
    headers: { authorization: `Bearer ${unsignedToken(user, engine.project)}` },
  })
  await response.text()
  return response.status
}

/** Lists a collection on the Firestore port as `user` (a `runQuery`): the status. */
export async function listAs(
  engine: ObservedEngine,
  user: SeedUser,
  collection: string,
): Promise<number> {
  const response = await fetch(`${firestoreApp(engine)}:runQuery`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${unsignedToken(user, engine.project)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: collection }] } }),
  })
  await response.text()
  return response.status
}

/** Writes a document over REST on the Firestore port as the owner, as an Admin SDK would. */
export async function writeOnPort(
  engine: ObservedEngine,
  path: string,
  fields: Record<string, unknown>,
  project = engine.project,
): Promise<void> {
  const root = `projects/${project}/databases/(default)/documents`
  const response = await fetch(`http://127.0.0.1:${engine.ports.firestore}/v1/${root}:commit`, {
    method: 'POST',
    headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
    body: JSON.stringify({ writes: [{ update: { name: `${root}/${path}`, fields } }] }),
  })
  expect(response.ok, `commit ${path} → ${response.status} ${await response.text()}`).toBe(true)
}

/**
 * Runs `code` (an ES module) with node in a folder of its own beside the
 * pinned Admin SDK, outside every project folder (a file in a Functions
 * codebase would reload it), with nothing of this machine's environment
 * but `env`: no credentials, no emulator hosts. Its standard output.
 */
export async function runWithAdminSdk(
  code: string,
  env: Record<string, string> = {},
): Promise<string> {
  const folder = mkdtempSync(join(tmpdir(), 'firenook-admin-sdk-'))
  try {
    mkdirSync(join(folder, 'node_modules'))
    symlinkSync(
      join(resolveFunctionsSdk(), 'firebase-admin'),
      join(folder, 'node_modules', 'firebase-admin'),
      'dir',
    )
    writeFileSync(join(folder, 'script.mjs'), code)
    const { stdout } = await promisify(execFile)(process.execPath, [join(folder, 'script.mjs')], {
      cwd: folder,
      env: { PATH: process.env.PATH ?? '', HOME: folder, ...env },
      timeout: 60_000,
    })
    return stdout
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

// The Logs page.

/** Every line row the feed draws (markers, edges and gaps are not lines). */
export const logRows = (page: Page): Locator => page.getByTestId('log-row')

/** The line rows whose text holds `text`. */
export const logRow = (page: Page, text: string | RegExp): Locator =>
  logRows(page).filter({ hasText: text })

/** A row's part, as `LogLine` names them: time, level, source, message, trail. */
export const part = (row: Locator, name: 'time' | 'level' | 'source' | 'message' | 'trail') =>
  row.locator(`[data-part="${name}"]`)

/**
 * Opens `/console/logs` with `search` and waits for its first page: a line,
 * an edge of the log, or a state that says why there is none.
 */
export async function openLogs(
  page: Page,
  engine: ObservedEngine,
  search: Record<string, string> = {},
): Promise<void> {
  const params = new URLSearchParams(search)
  await page.goto(`${engine.origin}/console/logs${params.size > 0 ? `?${params}` : ''}`)
  await expect(page.getByTestId('logs-page')).toBeVisible()
  await expect(
    page
      .getByTestId('log-row')
      .or(page.getByTestId('log-edge'))
      .or(page.getByTestId('logs-no-match'))
      .or(page.getByTestId('logs-empty'))
      .or(page.getByTestId('logs-filter-problem'))
      .first(),
  ).toBeVisible({ timeout: 15_000 })
}

/** The page's `q` (decoded), or null without one. */
export function queryOf(page: Page): string | null {
  return new URL(page.url()).searchParams.get('q')
}

/** How many lines `MatchCount` says match, read from its text ("1,234 lines"). */
export async function matchCount(page: Page): Promise<number> {
  const text = await page.getByTestId('logs-match-count').innerText()
  const digits = /([\d,]+)\s+lines?/.exec(text)?.[1]
  if (!digits) throw new Error(`MatchCount reads "${text}"`)
  return Number(digits.replaceAll(',', ''))
}

/**
 * Whether the engine says which invocation printed each Functions line
 * (compute's monitor attribution, read by observe's `functions_input`).
 * Until it does, Functions lines are plain: no function, no execution, no
 * structured payload, no end line for a call whose body is drained late.
 */
export async function attributesInvocations(engine: ObservedEngine): Promise<boolean> {
  const uid = unique('probe')
  await callFunction(engine, 'hello', { uid })
  const line = await lineOf(engine, `"loading cart for ${uid}"`)
  return line.execution !== undefined && line.function !== undefined
}

/** Why a journey that needs invocation attribution does not run on this engine. */
export const NEEDS_ATTRIBUTION =
  "this engine does not attribute Functions lines to their invocations yet (compute's monitor, read by functions_input)"

/**
 * Resolves a Kumo colour token in the page, as the browser paints it
 * (`--color-kumo-danger` → `rgb(…)` or `oklch(…)`), for comparing with a
 * computed style: as a text colour, or as a background.
 */
export function tokenColour(
  page: Page,
  token: string,
  property: 'color' | 'backgroundColor' = 'color',
): Promise<string> {
  return page.evaluate(
    ([name, key]) => {
      const doc = (globalThis as unknown as { document: DocumentLike }).document
      const probe = doc.createElement('span')
      probe.style[key] = `var(${name})`
      doc.body.appendChild(probe)
      const colour = doc.defaultView.getComputedStyle(probe)[key]
      probe.remove()
      return colour
    },
    [token, property] as const,
  )
}

/** The few DOM members `tokenColour` touches; this file is typed for Node, not the DOM. */
interface DocumentLike {
  createElement(tag: string): {
    style: { color: string; backgroundColor: string }
    remove(): void
  }
  body: { appendChild(node: unknown): void }
  defaultView: { getComputedStyle(node: unknown): { color: string; backgroundColor: string } }
}
