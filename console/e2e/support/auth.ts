// What the Authentication journeys (`auth-*.spec.ts`, project `auth`) do to
// an engine behind the page's back, and how they read the engine's own
// figures. The five files share one engine, so:
//
// - a journey that creates many users, deletes in bulk, imports or counts
//   works in a scratch tenant (`scratchTenant`) and deletes it in `finally`
//   (a tenant's users go with it, without triggers);
// - counts are the engine's figure read at test time (`usersCount`), never
//   a constant from the seed;
// - users a journey makes in the project scope use `@journey.test` and are
//   deleted in `finally`; switches and rules are put back there too.
//
// App calls (`app`) go through the console's Auth mount without the
// console's own header, exactly as an app or the Admin SDK would: Activity
// shows them and the Inbox toasts them. Everything else here is the
// console API as the owner.

import { type Locator, type Page, type Request, expect } from '@playwright/test'
import type { Engine } from '../fixtures'
import { ownerFetch } from './api'

export const API_KEY = 'fake-api-key'

/** One part of a JWT. */
const jwtPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** A JWT the emulator accepts unsigned (`alg: none`), as its own tokens and a provider's are. */
export function unsignedJwt(payload: Record<string, unknown>): string {
  return `${jwtPart({ alg: 'none', typ: 'JWT' })}.${jwtPart(payload)}.`
}

/** The JSON payload of a JWT. */
export function payloadOf(jwt: string): Record<string, unknown> {
  const [, body = ''] = jwt.split('.')
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>
}
/** The Web SDK's header, so a call reads as an app's in Activity. */
export const WEB_CLIENT = { 'x-client-version': 'Chrome/JsCore/11.0.0/FirebaseCore-web' }

export interface AppAnswer<T = Record<string, unknown>> {
  status: number
  body: T
}

/** An Identity Toolkit path, as the client SDK (no scope) or the Admin SDK (scoped) writes it. */
export function toolkit(op: string, scope?: { project: string; tenant?: string | undefined }) {
  if (!scope) return `/identitytoolkit.googleapis.com/v1/${op}`
  const tenant = scope.tenant ? `/tenants/${encodeURIComponent(scope.tenant)}` : ''
  return `/identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(scope.project)}${tenant}/${op}`
}

/**
 * One call to the Auth emulator through the console's mount, as an app
 * (`client`: the API key) or the Admin SDK (`admin`: the owner), never as
 * the console.
 */
export async function app<T = Record<string, unknown>>(
  engine: Pick<Engine, 'origin'>,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: {
    body?: unknown
    as?: 'client' | 'admin'
    query?: Record<string, string>
    headers?: Record<string, string>
  } = {},
): Promise<AppAnswer<T>> {
  const as = options.as ?? 'client'
  const search = new URLSearchParams(options.query)
  if (as === 'client' && !search.has('key')) search.set('key', API_KEY)
  const headers: Record<string, string> = { ...WEB_CLIENT, ...options.headers }
  if (as === 'admin') headers.authorization = 'Bearer owner'
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(
    `${engine.origin}/console/api/v1/auth${path}${search.size > 0 ? `?${search}` : ''}`,
    {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
  )
  const text = await response.text()
  let body: unknown
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body: body as T }
}

export interface SignedUp {
  localId: string
  idToken: string
  refreshToken: string
  email?: string
}

/** A client sign-up (email and password), in a tenant when one is named. */
export async function signUp(
  engine: Engine,
  user: { email: string; password?: string; tenant?: string | undefined; project?: string },
): Promise<SignedUp> {
  const answer = await app<SignedUp>(
    engine,
    'POST',
    toolkit('accounts:signUp', user.project ? { project: user.project } : undefined),
    {
      body: {
        email: user.email,
        password: user.password ?? 'password-1',
        returnSecureToken: true,
        ...(user.tenant ? { tenantId: user.tenant } : {}),
      },
    },
  )
  expect(answer.status, `signUp ${user.email} → ${JSON.stringify(answer.body)}`).toBe(200)
  return answer.body
}

/** A client password sign-in; the answer as it came. */
export function signIn(
  engine: Engine,
  user: { email: string; password: string; tenant?: string | undefined },
): Promise<AppAnswer<{ idToken?: string; error?: { message: string } }>> {
  return app(engine, 'POST', toolkit('accounts:signInWithPassword'), {
    body: {
      email: user.email,
      password: user.password,
      returnSecureToken: true,
      ...(user.tenant ? { tenantId: user.tenant } : {}),
    },
  })
}

/** An Admin SDK `accounts:update` of one account. */
export async function adminUpdate(
  engine: Engine,
  uid: string,
  fields: Record<string, unknown>,
  tenant?: string,
) {
  const answer = await app(
    engine,
    'POST',
    toolkit('accounts:update', { project: engine.project, tenant }),
    { as: 'admin', body: { localId: uid, ...fields } },
  )
  expect(answer.status, `update ${uid} → ${JSON.stringify(answer.body)}`).toBe(200)
}

/** Deletes accounts as the Admin SDK's `deleteUsers` does (forced). */
export async function deleteAccounts(engine: Engine, uids: string[], tenant?: string) {
  if (uids.length === 0) return
  const answer = await app(
    engine,
    'POST',
    toolkit('accounts:batchDelete', { project: engine.project, tenant }),
    { as: 'admin', body: { localIds: uids, force: true } },
  )
  expect(answer.status, `batchDelete → ${JSON.stringify(answer.body)}`).toBe(200)
}

/** Writes accounts with `accounts:batchCreate` (overwriting), as an import would. */
export async function batchCreate(
  engine: Engine,
  users: Record<string, unknown>[],
  tenant?: string,
) {
  for (let at = 0; at < users.length; at += 1_000) {
    const answer = await app<{ error?: unknown[] }>(
      engine,
      'POST',
      toolkit('accounts:batchCreate', { project: engine.project, tenant }),
      { as: 'admin', body: { users: users.slice(at, at + 1_000), allowOverwrite: true } },
    )
    expect(answer.status, `batchCreate → ${JSON.stringify(answer.body)}`).toBe(200)
    expect(answer.body.error ?? []).toEqual([])
  }
}

/** `count` sample-shaped users (uids `sample-<seed>-<n>`, emails on `sample.test`). */
export function sampleShaped(count: number, seed = 7): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    localId: `sample-${seed}-${index + 1}`,
    email: `sample${seed}-${index + 1}@sample.test`,
    displayName: `Sample ${index + 1}`,
    rawPassword: 'password-1',
    emailVerified: true,
  }))
}

/** The Console API as the owner: JSON in and out, the status checked. */
export async function consoleJson<T>(
  engine: Engine,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await ownerFetch(engine, path, init)
  const text = await response.text()
  expect(response.ok, `${init.method ?? 'GET'} ${path} → ${response.status} ${text}`).toBe(true)
  return (text === '' ? undefined : JSON.parse(text)) as T
}

/** The engine's own count of users in a scope (and filter), read now. */
export async function usersCount(
  engine: Engine,
  scope: { tenant?: string | undefined; q?: string; project?: string } = {},
): Promise<number> {
  const search = new URLSearchParams({ limit: '1' })
  if (scope.tenant) search.set('tenant', scope.tenant)
  if (scope.q) search.set('q', scope.q)
  if (scope.project) search.set('project', scope.project)
  const page = await consoleJson<{ total: { count: number } | null }>(
    engine,
    `/auth/users?${search}`,
  )
  return page.total?.count ?? 0
}

/** One account as the console reads it, or null once it is gone. */
export async function userDetail(
  engine: Engine,
  uid: string,
  tenant?: string,
): Promise<{
  row: Record<string, unknown> & {
    displayName: string | null
    disabled: boolean
    emailVerified: boolean
    anonymous: boolean
    providers: string[]
  }
  password: string | null
  claims: Record<string, unknown> | null
} | null> {
  const search = new URLSearchParams({ uid })
  if (tenant) search.set('tenant', tenant)
  const response = await ownerFetch(engine, `/auth/user?${search}`)
  if (response.status === 404) return null
  expect(response.ok).toBe(true)
  return (await response.json()) as never
}

/** A tenant made for one journey (`scratch-<n>`), removed with its users at the end. */
export interface ScratchTenant {
  id: string
  remove(): Promise<void>
}

let scratchCount = 0

/** Creates a scratch tenant through `POST /auth/tenants`. */
export async function scratchTenant(engine: Engine): Promise<ScratchTenant> {
  scratchCount += 1
  const id = `scratch-${Date.now().toString(36).slice(-5)}${scratchCount}`
  await consoleJson(engine, `/auth/tenants`, {
    method: 'POST',
    body: JSON.stringify({
      tenantId: id,
      displayName: `Scratch ${scratchCount}`,
      allowPasswordSignup: true,
      enableEmailLinkSignin: true,
      enableAnonymousUser: true,
      disableAuth: false,
      mfaProviders: [],
    }),
  })
  return {
    id,
    remove: () => deleteTenant(engine, id),
  }
}

/** Deletes a tenant (and its users, without triggers); a tenant already gone is fine. */
export async function deleteTenant(engine: Engine, tenant: string) {
  const answer = await app(
    engine,
    'DELETE',
    `/identitytoolkit.googleapis.com/v2/projects/${engine.project}/tenants/${tenant}`,
    { as: 'admin' },
  )
  expect([200, 404], `delete tenant ${tenant} → ${JSON.stringify(answer.body)}`).toContain(
    answer.status,
  )
}

/** Runs `journey` in a scratch tenant and deletes the tenant whatever happens. */
export async function inScratchTenant<T>(
  engine: Engine,
  journey: (tenant: ScratchTenant) => Promise<T>,
): Promise<T> {
  const tenant = await scratchTenant(engine)
  try {
    return await journey(tenant)
  } finally {
    await tenant.remove()
  }
}

/** The newest call in Activity, the console's own included. */
export async function latestCall(engine: Engine): Promise<{ id: number; status: number }> {
  const page = await consoleJson<{ items: { id: number; status: number }[] }>(
    engine,
    '/auth/activity?limit=1&console=true',
  )
  const [call] = page.items
  if (!call) throw new Error('Activity is empty')
  return call
}

export interface InboxMessage {
  id: number
  kind: string
  to: string | null
  /** The SMS code, or the link's oobCode. */
  code: string | null
  link: string | null
  delivery: 'sent' | 'returned' | 'restored'
  used: boolean
  /** The call that sent it. */
  activity: number | null
}

/** The Inbox's messages matching a filter, newest first. */
export async function messages(engine: Engine, q: string, limit = 20): Promise<InboxMessage[]> {
  const search = new URLSearchParams({ q, limit: String(limit) })
  const page = await consoleJson<{ items: InboxMessage[] }>(engine, `/auth/messages?${search}`)
  return page.items
}

/** The project's switches as the emulator's own config route reads them. */
export async function emulatorConfig(engine: Engine) {
  const answer = await app<{
    signIn: { allowDuplicateEmails: boolean }
    emailPrivacyConfig: { enableImprovedEmailPrivacy: boolean }
  }>(engine, 'GET', `/emulator/v1/projects/${engine.project}/config`, { as: 'admin' })
  expect(answer.status).toBe(200)
  return answer.body
}

/** Sets the project's switches back (or to) these values. */
export async function setEmulatorConfig(
  engine: Engine,
  config: { allowDuplicateEmails?: boolean; enableImprovedEmailPrivacy?: boolean },
) {
  const body: Record<string, unknown> = {}
  if (config.allowDuplicateEmails !== undefined)
    body.signIn = { allowDuplicateEmails: config.allowDuplicateEmails }
  if (config.enableImprovedEmailPrivacy !== undefined)
    body.emailPrivacyConfig = { enableImprovedEmailPrivacy: config.enableImprovedEmailPrivacy }
  const answer = await app(engine, 'PATCH', `/emulator/v1/projects/${engine.project}/config`, {
    as: 'admin',
    body,
  })
  expect(answer.status).toBe(200)
}

/** Waits until the engine knows the fixture's blocking functions (discovery is asynchronous). */
export async function blockingFunctionsReady(engine: Engine) {
  await expect
    .poll(
      async () =>
        (await consoleJson<{ beforeCreate: unknown; beforeSignIn: unknown }>(engine, '/auth/hooks'))
          .beforeSignIn !== null,
      { timeout: 60_000 },
    )
    .toBe(true)
}

// ------------------------------------------------------------------ the admins-only rule

/** The rule U7, U13 and X1 apply on top of the rules in force (§9.4). */
export const ADMINS_ONLY = [
  '    match /admins-only/{id} {',
  "      allow read: if request.auth != null && request.auth.token.get('admin', false) == true;",
  '    }',
]

export interface AppliedRule {
  /** The line of the rule's condition in the applied source. */
  line: number
  restore(): Promise<void>
}

/**
 * Applies (does not save) the rules in force plus `ADMINS_ONLY`, writes
 * `admins-only/a1` as the owner, and hands back how to put both back.
 */
export async function applyAdminsOnly(engine: Engine): Promise<AppliedRule> {
  const now = await consoleJson<{ source: string }>(engine, '/firestore/rules?database=(default)')
  const lines = now.source.split('\n')
  const at = lines.findIndex((line) => line.includes('match /databases/{database}/documents'))
  if (at === -1) throw new Error('the rules in force have no documents block')
  const applied = [...lines.slice(0, at + 1), ...ADMINS_ONLY, ...lines.slice(at + 1)]
  const line = at + 1 + 2
  await consoleJson(engine, '/firestore/rules', {
    method: 'PUT',
    body: JSON.stringify({ database: '(default)', source: applied.join('\n'), save: false }),
  })
  const root = `projects/${engine.project}/databases/(default)/documents`
  const write = (body: unknown) =>
    consoleJson(engine, `/firestore/v1/${root}:commit`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  await write({
    writes: [
      {
        update: {
          name: `${root}/admins-only/a1`,
          fields: { secret: { stringValue: 'only admins read this' } },
        },
      },
    ],
  })
  return {
    line,
    async restore() {
      await write({ writes: [{ delete: `${root}/admins-only/a1` }] })
      await consoleJson(engine, '/firestore/rules', {
        method: 'PUT',
        body: JSON.stringify({ database: '(default)', source: now.source, save: false }),
      })
    },
  }
}

// ------------------------------------------------------------------ what the page asks

/** Whether a request is the Console API route `path` (`/auth/users`, `/auth/users:batchGet`). */
export function isRoute(request: Request, method: string, path: string): boolean {
  const url = new URL(request.url())
  return request.method() === method && url.pathname === `/console/api/v1${path}`
}

/** Every request the page makes to the Console API routes named, in order. */
export function watchRoutes(page: Page, routes: { method: string; path: string }[]) {
  const seen: Request[] = []
  const listener = (request: Request) => {
    if (routes.some((route) => isRoute(request, route.method, route.path))) seen.push(request)
  }
  page.on('request', listener)
  return {
    seen,
    of: (method: string, path: string) => seen.filter((request) => isRoute(request, method, path)),
    clear: () => seen.splice(0, seen.length),
    stop: () => page.off('request', listener),
  }
}

/** The uids a `users:batchGet` asked for. */
export function batchKeys(request: Request): string[] {
  const body = request.postDataJSON() as { keys?: string[] } | null
  return body?.keys ?? []
}

// ------------------------------------------------------------------ the browser's side

/** What a page's frame recorder keeps; this file is typed for Node, not the DOM. */
interface FrameRecorder {
  __frames: number[]
  __framing: boolean
  requestAnimationFrame(callback: (now: number) => void): number
  performance: { now(): number }
}

/** Frame intervals the page paints while `work` runs, ms. */
export async function framesDuring(page: Page, work: () => Promise<void>): Promise<number[]> {
  await page.evaluate(() => {
    const record = globalThis as unknown as FrameRecorder
    record.__frames = []
    record.__framing = true
    let last = record.performance.now()
    const tick = (now: number) => {
      record.__frames.push(now - last)
      last = now
      if (record.__framing) record.requestAnimationFrame(tick)
    }
    record.requestAnimationFrame(tick)
  })
  await work()
  return page.evaluate(() => {
    const record = globalThis as unknown as FrameRecorder
    record.__framing = false
    return record.__frames.slice(1)
  })
}

/** The 95th percentile of some values. */
export function p95(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
}

/** Resolves on the page's next animation frame: one frame, not a fixed time. */
export function nextFrame(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((done) =>
        (globalThis as unknown as FrameRecorder).requestAnimationFrame(() => done()),
      ),
  )
}

/** One computed style property of what a locator finds. */
export function computed(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (element, name) =>
      element.ownerDocument.defaultView!.getComputedStyle(element).getPropertyValue(name),
    property,
  )
}

/** Waits for every transition and animation on or around what a locator finds to end. */
export async function settled(locator: Locator): Promise<void> {
  await locator.evaluate(async (element) => {
    // This file is typed for Node: the animations as the page has them.
    const animations = element.ownerDocument.getAnimations() as unknown as {
      effect: { target?: typeof element | null } | null
      finished: Promise<unknown>
    }[]
    const running = animations
      .filter(({ effect }) => {
        const target = effect?.target
        return Boolean(target && (target.contains(element) || element.contains(target)))
      })
      .map((animation) => animation.finished.catch(() => undefined))
    await Promise.all(running)
  })
}

/** Waits until a scroller has stopped moving: three frames at one position. */
export async function scrollSettled(scroller: Locator): Promise<void> {
  await scroller.evaluate(
    (element) =>
      new Promise<void>((done) => {
        const view = element.ownerDocument.defaultView!
        let last = Number.NaN
        let still = 0
        const check = () => {
          const now = element.scrollTop
          still = now === last ? still + 1 : 0
          last = now
          if (still >= 3) done()
          else view.requestAnimationFrame(check)
        }
        view.requestAnimationFrame(check)
      }),
  )
}
