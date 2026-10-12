// What the compute journeys (`functions*.spec.ts`, `extensions.spec.ts`,
// `eventarc.spec.ts`) do to an engine behind the page's back: call a
// function as an app would and read the answer to its end, read what the
// engine kept (codebases, invocations), wait for an invocation of a
// function, and write a file of the project and put it back. Every call
// reads its response body to the end. No mocked API.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import type { Engine } from '../fixtures'
import { ownerFetch } from './api'

// The parts of the console API's answers the journeys read (the generated
// types belong to the app's project, not this one).

/** A codebase or extension instance (`FunctionCodebase`). */
export interface FunctionCodebase {
  id: string
  directory: string
  state: 'loading' | 'ready' | 'failed'
  servingPrevious: boolean
  error: { message: string; detail: string | null } | null
  loads: number
  functionCount: number
  envFiles: string[]
  stale: { reason: string; file?: string } | null
  worker: {
    state: string
    pid: number | null
    node: string | null
    restarts: number
    lastExit: string | null
    inspectPort: number | null
    inFlight: number
  }
}

/** One function (`FunctionSummary`). */
export interface FunctionSummary {
  id: string
  name: string
  codebase: string
  kind: string
  status: string
  statusReason: string | null
  secrets: { key: string; provided: boolean }[]
}

/** `GET /functions` (`FunctionsSnapshot`). */
export interface FunctionsSnapshot {
  codebases: { codebase: FunctionCodebase }[]
  functions: FunctionSummary[]
}

/** One invocation in a list (`InvocationSummary`). */
export interface InvocationSummary {
  id: string
  seq: number
  functionId: string
  codebase: string
  kind: string
  origin: 'console' | 'replay' | 'emulator' | 'client'
  cause: { type: string } & Record<string, unknown>
  summary: string
  startedAt: string
  durationMs: number | null
  outcome: string | null
  outcomeClass: string
  status: number | null
  callableStatus: string | null
  replayOf: string | null
  error: string | null
  logCount: number
}

/** `GET /functions/invocations/{id}` (`InvocationView`). */
export interface InvocationView {
  detail: {
    summary: InvocationSummary
    request: {
      headers: { name: string; value: string | null; sensitive: boolean }[]
      method?: string
      path?: string
    }
    logs: { message: string; level: string; kind: string | null }[]
    event: unknown
  }
  refs: { kind: string; key: string }[]
}

/**
 * A value only the engine's own environment holds. Every compute spec file
 * imports this module, so it is set before the worker starts its engine
 * (which inherits the test process's environment); the Environment journey
 * checks no page ever shows it, since a worker inherits the engine's
 * variables and the console only counts them.
 */
export const ENGINE_SENTINEL = 'host-only-7c1f4b2e'
process.env.FIRENOOK_E2E_SENTINEL ??= ENGINE_SENTINEL

/** The region every fixture function runs in. */
export const REGION = 'us-central1'

/** A function's id as the engine names it: `us-central1-api`. */
export const functionId = (name: string) => `${REGION}-${name}`

/** The Functions emulator's own address, as an app reaches it. */
export const functionsAddress = (engine: Engine) => `http://127.0.0.1:${engine.ports.functions}`

/** A function's URL as an app calls it, with `path` after it. */
export const functionUrl = (engine: Engine, name: string, path = '') =>
  `${functionsAddress(engine)}/${engine.project}/${REGION}/${name}${path}`

export interface Answer {
  status: number
  text: string
  headers: Headers
  json<T = unknown>(): T
}

/** Calls a function as an app would and reads its answer to the end. */
export async function callFunction(
  engine: Engine,
  name: string,
  path = '',
  init: RequestInit = {},
): Promise<Answer> {
  const response = await fetch(functionUrl(engine, name, path), init)
  const text = await response.text()
  return {
    status: response.status,
    text,
    headers: response.headers,
    json: <T>() => JSON.parse(text) as T,
  }
}

/** The console API's answer as JSON, read to the end, failing on an error status. */
export async function consoleJson<T>(engine: Engine, path: string, init?: RequestInit): Promise<T> {
  const response = await ownerFetch(engine, path, init)
  const text = await response.text()
  expect(response.ok, `${init?.method ?? 'GET'} ${path} → ${response.status} ${text}`).toBe(true)
  return JSON.parse(text) as T
}

/** Every codebase and function as the Functions page reads them. */
export const functionsSnapshot = (engine: Engine) =>
  consoleJson<FunctionsSnapshot>(engine, '/functions')

/** One codebase (or extension instance) as the runtime serves it. */
export async function codebaseOf(engine: Engine, id: string): Promise<FunctionCodebase> {
  const snapshot = await functionsSnapshot(engine)
  const entry = snapshot.codebases.find((candidate) => candidate.codebase.id === id)
  expect(entry, `codebase ${id} in ${snapshot.codebases.map((c) => c.codebase.id)}`).toBeDefined()
  return entry!.codebase
}

/** How many loads a codebase has completed (1 after the first). */
export const loadsOf = async (engine: Engine, codebase: string) =>
  (await codebaseOf(engine, codebase)).loads

/** The kept invocations the engine's filter keeps, newest first (one page). */
export async function invocations(engine: Engine, q = ''): Promise<InvocationSummary[]> {
  const result = await consoleJson<{ page: { items: InvocationSummary[] } }>(
    engine,
    `/functions/invocations?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`,
  )
  return result.page.items
}

/** How many kept invocations the engine's filter matches (exact). */
export async function invocationTotal(engine: Engine, q = ''): Promise<number> {
  const result = await consoleJson<{ page: { total: { count: number } | null } }>(
    engine,
    `/functions/invocations?limit=1${q ? `&q=${encodeURIComponent(q)}` : ''}`,
  )
  return result.page.total?.count ?? 0
}

/** One invocation as its detail reads it. */
export const invocationOf = (engine: Engine, id: string) =>
  consoleJson<InvocationView>(engine, `/functions/invocations/${encodeURIComponent(id)}`)

/**
 * The newest finished invocation of `name` that `matches`, once the engine
 * has one (the engine records it when the handler is done).
 */
export async function finishedInvocation(
  engine: Engine,
  name: string,
  matches: (invocation: InvocationSummary) => boolean = () => true,
  timeout = 15_000,
): Promise<InvocationSummary> {
  let found: InvocationSummary | undefined
  await expect
    .poll(
      async () => {
        found = (await invocations(engine, `function:${functionId(name)}`)).find(
          (invocation) => invocation.outcome !== null && matches(invocation),
        )
        return found !== undefined
      },
      { timeout, message: `a finished invocation of ${name}` },
    )
    .toBe(true)
  return found!
}

/** A file of the engine's project, read and written by its path in the project. */
export function projectFile(engine: Engine, relative: string) {
  const path = join(engine.directory, relative)
  const original = readFileSync(path, 'utf8')
  return {
    path,
    original,
    read: () => readFileSync(path, 'utf8'),
    write: (text: string) => writeFileSync(path, text),
    /** Puts the original bytes back when they changed; true when it wrote. */
    restore: () => {
      if (readFileSync(path, 'utf8') === original) return false
      writeFileSync(path, original)
      return true
    },
  }
}

/**
 * Waits for a codebase's next completed load after `before` loads, and for
 * it to be serving again (`ready`, or `failed` when `failed` is asked).
 */
export async function nextLoad(
  engine: Engine,
  codebase: string,
  before: number,
  state: 'ready' | 'failed' = 'ready',
): Promise<FunctionCodebase> {
  let seen: FunctionCodebase | undefined
  await expect
    .poll(
      async () => {
        seen = await codebaseOf(engine, codebase)
        return seen.loads > before && seen.state === state
      },
      { timeout: 30_000, message: `${codebase} loaded again (${state})` },
    )
    .toBe(true)
  return seen!
}

/** Reloads a codebase as its Reload button does, and waits for the load. */
export async function reload(engine: Engine, codebase: string): Promise<FunctionCodebase> {
  const before = await loadsOf(engine, codebase)
  await consoleJson(engine, `/functions/codebases/${encodeURIComponent(codebase)}/reload`, {
    method: 'POST',
    body: '{}',
  })
  return nextLoad(engine, codebase, before)
}

/** Turns background triggers off or on, as a test harness does it (the suite control). */
export async function setBackground(engine: Engine, enabled: boolean): Promise<void> {
  await consoleJson(engine, '/suite/background', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  })
}
