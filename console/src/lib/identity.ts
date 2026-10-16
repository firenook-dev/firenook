// Who a request runs as. The engine evaluates rules for every call, so
// reading as a user shows exactly what that user's app would get, including
// the denial and the rule line that decided it. Firestore's "view as" was
// the first to need it; Storage's "As" and compute's "Call as" read the same
// identities, so it lives here.
//
// One token path per kind. The owner and the anonymous client need no
// token; a custom identity (any uid and claims, no Auth record) is an
// unsigned token minted here; an Auth user's is the token the Auth emulator
// itself issues for that account (`POST /auth/tokens`), so it carries the
// account's real claims, provider and verification, exactly what the app
// would hold. Every caller goes through `resolveAuthorization`.

import { queryOptions } from '@tanstack/react-query'
import { ApiError, apiGet, apiSend } from '@/api/client'
import type { AuthToken } from '@/api/generated/auth/AuthToken'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { IdentityUser } from '@/api/generated/IdentityUser'
import type { Page } from '@/api/generated/Page'
import { queryClient } from './query'

export type { IdentityUser } from '@/api/generated/IdentityUser'

export type ViewAs =
  | { kind: 'owner' }
  | { kind: 'anonymous' }
  /** An existing Auth record; `tenant` absent for the project's own users. */
  | {
      kind: 'user'
      uid: string
      tenant?: string | undefined
      email?: string | undefined
      claims?: Record<string, unknown> | undefined
    }
  /**
   * Any identity, no Auth record needed: "a user with admin: true" for a
   * claims rule or a callable. Minted here, so it works without Auth running.
   */
  | {
      kind: 'custom'
      uid: string
      claims: Record<string, unknown>
      signInProvider?: string | undefined
      emailVerified?: boolean | undefined
      email?: string | undefined
    }

export const OWNER_AUTHORIZATION = 'Bearer owner'

/**
 * The `Authorization` header for the kinds that need no engine: the owner,
 * none for an anonymous client, and a custom identity's unsigned token. An
 * Auth user's comes from `resolveAuthorization`.
 */
export function authorizationFor(
  viewAs: Extract<ViewAs, { kind: 'owner' | 'anonymous' | 'custom' }>,
  project: string,
): string | undefined {
  if (viewAs.kind === 'owner') return OWNER_AUTHORIZATION
  if (viewAs.kind === 'anonymous') return undefined
  return `Bearer ${mintUnsignedToken(viewAs, project)}`
}

/** What the picker says of a user whose token the engine could not mint. */
export const SYNTHETIC_NOTE = 'Not an Auth user: synthetic token'

/** An Auth user's token, as it sits in the query cache. */
export interface UserToken {
  authorization: string
  /** When the token stops being accepted, ms since the epoch. */
  expiresAt: number
  /**
   * The engine could not mint one — no such account, Authentication not
   * running, or another project than the emulator's — so this is an
   * unsigned token made here with what the identity says.
   */
  synthetic: boolean
}

/** A token is minted again this long before it expires. */
const REMINT_BEFORE_MS = 5 * 60_000
/** A synthetic token is trusted this long: the account may be created meanwhile. */
const SYNTHETIC_FOR_MS = 30_000

/** Where an Auth user's engine token is cached, so the auth section's topics can drop it. */
export const tokenKey = (project: string, tenant: string | undefined, uid: string) =>
  ['auth', project, 'token', tenant ?? '', uid] as const

type UserIdentity = Extract<ViewAs, { kind: 'user' }>

/**
 * The cache entry for a user's token. Its query function never takes the
 * query's abort signal: concurrent callers share one mint, and one of them
 * going away must not cancel it for the others.
 */
export const userTokenQuery = (user: UserIdentity, project: string) =>
  queryOptions({
    queryKey: tokenKey(project, user.tenant, user.uid),
    queryFn: () => mintUserToken(user, project),
    staleTime: (query) => {
      const token = query.state.data
      if (!token) return 0
      const freshUntil = token.synthetic
        ? Math.min(token.expiresAt - REMINT_BEFORE_MS, query.state.dataUpdatedAt + SYNTHETIC_FOR_MS)
        : token.expiresAt - REMINT_BEFORE_MS
      return Math.max(0, freshUntil - query.state.dataUpdatedAt)
    },
    gcTime: 60 * 60_000,
    retry: false,
  })

/** The engine's status as the shell last saw it, if it has. */
function knownStatus(): ConsoleStatus | undefined {
  return queryClient.getQueryData<ConsoleStatus>(['status'])
}

async function mintUserToken(user: UserIdentity, project: string): Promise<UserToken> {
  const status = knownStatus()
  // The engine mints for its own project's accounts only, and only while
  // Authentication runs; another project's user, or none at all, reads
  // through a token made here.
  const otherProject = status !== undefined && status.projectId !== project
  const authAbsent = status?.sections.find((section) => section.id === 'auth')?.state === 'absent'
  if (otherProject || authAbsent) return syntheticToken(user, project)
  try {
    const token = await apiSend<AuthToken>(
      'POST',
      '/auth/tokens',
      user.tenant ? { uid: user.uid, tenant: user.tenant } : { uid: user.uid },
    )
    const expiresAt = Date.parse(token.expiresAt)
    return {
      authorization: `Bearer ${token.idToken}`,
      expiresAt: Number.isNaN(expiresAt) ? Date.now() + 3_600_000 : expiresAt,
      synthetic: false,
    }
  } catch (error) {
    // No such account (deleted since the link was made, or never there),
    // or an engine without Authentication: the request still runs, as an
    // identity with that uid, and says so.
    if (error instanceof ApiError && error.code === 'not-found')
      return syntheticToken(user, project)
    throw error
  }
}

function syntheticToken(user: UserIdentity, project: string): UserToken {
  return {
    authorization: `Bearer ${mintUnsignedToken(user, project)}`,
    expiresAt: Date.now() + 3_600_000,
    synthetic: true,
  }
}

/** Resolves with `promise`, or rejects as soon as `signal` aborts (the work itself goes on). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

/**
 * The one token path per kind. `user`: the engine's token (`POST
 * /auth/tokens`), cached under `tokenKey`, minted once for concurrent
 * callers and again five minutes before it expires; a uid the engine cannot
 * mint gets a synthetic token (`SYNTHETIC_NOTE`). `owner`, `anonymous`,
 * `custom`: no request. Compute's "Call as", Storage's "As" and Firestore's
 * view as all call this, never `mintUnsignedToken`.
 */
export async function resolveAuthorization(
  viewAs: ViewAs,
  project: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (viewAs.kind !== 'user') return authorizationFor(viewAs, project)
  const token = await abortable(queryClient.fetchQuery(userTokenQuery(viewAs, project)), signal)
  return token.authorization
}

/**
 * Drops a user's cached engine token, so the next request mints a new one;
 * false for the kinds that have none to drop.
 */
export function forgetToken(viewAs: ViewAs, project: string): boolean {
  if (viewAs.kind !== 'user') return false
  queryClient.removeQueries({ queryKey: tokenKey(project, viewAs.tenant, viewAs.uid), exact: true })
  return true
}

/**
 * Sends a request as `viewAs`. An engine-minted token the engine refuses
 * (`401`: it expired while it sat in the cache, or the machine slept past
 * it) is dropped, minted again, and the request sent once more.
 */
export async function fetchAs(
  viewAs: ViewAs,
  project: string,
  send: (authorization: string | undefined) => Promise<Response>,
  signal?: AbortSignal,
): Promise<Response> {
  const first = await send(await resolveAuthorization(viewAs, project, signal))
  if (first.status !== 401 || !forgetToken(viewAs, project)) return first
  return send(await resolveAuthorization(viewAs, project, signal))
}

/**
 * The query-key part for requests made as `viewAs`: what decides the
 * answer, never the token itself. A user is their tenant and uid (the
 * engine's token carries their claims); `identityOfKey` reads it back.
 */
export function identityKey(viewAs: ViewAs): string {
  if (viewAs.kind === 'owner') return 'owner'
  if (viewAs.kind === 'user')
    return (
      serializeViewAs(
        viewAs.tenant
          ? { kind: 'user', uid: viewAs.uid, tenant: viewAs.tenant }
          : { kind: 'user', uid: viewAs.uid },
      ) ?? ''
    )
  return serializeViewAs(viewAs) ?? ''
}

/** The identity an `identityKey` names, enough to send requests as it again. */
export function identityOfKey(key: string): ViewAs {
  return parseViewAs(key)
}

/** Users one picker answer holds by default; the engine allows at most 50. */
export const IDENTITY_PAGE = 20

/**
 * At most `limit` users matching `text` (an email or uid prefix, then a
 * name or email substring), from `GET /auth/identities` — every tenant's
 * when `tenant` is undefined, the project's own for `''`. Never every
 * account. An error is thrown as the engine's `ApiError`, never turned
 * into an empty list.
 */
export async function searchIdentityUsers(
  project: string,
  text: string,
  options: { tenant?: string | undefined; limit?: number; signal?: AbortSignal } = {},
): Promise<IdentityUser[]> {
  const page = await apiGet<Page<IdentityUser>>(
    '/auth/identities',
    { q: text, limit: options.limit ?? IDENTITY_PAGE, tenant: options.tenant, project },
    options.signal,
  )
  return page.items
}

export const identityUsersQuery = (project: string, text: string, tenant?: string) =>
  queryOptions({
    queryKey: ['auth', project, 'identities', tenant ?? '*', text] as const,
    queryFn: ({ signal }) => searchIdentityUsers(project, text, { tenant, signal }),
    staleTime: 30_000,
    retry: false,
  })

/** The `ViewAs` for a user the picker found. */
export function viewAsOfUser(user: IdentityUser): Extract<ViewAs, { kind: 'user' }> {
  const viewAs: Extract<ViewAs, { kind: 'user' }> = { kind: 'user', uid: user.uid }
  if (user.tenant) viewAs.tenant = user.tenant
  if (user.email) viewAs.email = user.email
  if (user.claims) viewAs.claims = user.claims
  return viewAs
}

/**
 * The emulator accepts unsigned `alg: none` ID tokens with the claims the
 * Auth emulator would have put in a real one. This is how the Firebase SDKs
 * talk to it too; nothing here works against production.
 */
export function mintUnsignedToken(
  identity: Extract<ViewAs, { kind: 'user' | 'custom' }>,
  project: string,
): string {
  const now = Math.floor(Date.now() / 1000)
  const email = identity.email
  const provider =
    identity.kind === 'custom'
      ? (identity.signInProvider ?? (email ? 'password' : 'custom'))
      : email
        ? 'password'
        : 'custom'
  // An Auth user's email is verified as far as rules can tell, as before; a
  // custom identity says so itself, and is unverified unless it does.
  const verified =
    identity.kind === 'custom'
      ? (identity.emailVerified ?? (email ? false : undefined))
      : email
        ? true
        : undefined
  const firebase: Record<string, unknown> = {
    identities: email ? { email: [email] } : {},
    sign_in_provider: provider,
  }
  if (identity.kind === 'user' && identity.tenant) firebase.tenant = identity.tenant
  const payload: Record<string, unknown> = {
    iss: `https://securetoken.google.com/${project}`,
    aud: project,
    auth_time: now,
    sub: identity.uid,
    user_id: identity.uid,
    iat: now,
    exp: now + 3600,
    firebase,
    ...(email ? { email } : {}),
    ...(email || verified !== undefined ? { email_verified: verified ?? false } : {}),
    ...identity.claims,
  }
  const header = { alg: 'none', typ: 'JWT' }
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}.`
}

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

const CUSTOM_PREFIX = 'custom.'

/**
 * A uid as it sits in `?as=`: `%`, `:` and `|` percent-escaped, and a uid
 * that would read as one of the other forms — `owner`, `anonymous`, or one
 * starting `custom.` — with its first letter escaped, so every uid there is
 * survives the round trip.
 */
function escapeUid(uid: string): string {
  const escaped = uid.replace(/%/g, '%25').replace(/:/g, '%3A').replace(/\|/g, '%7C')
  if (escaped === 'owner' || escaped === 'anonymous' || escaped.startsWith(CUSTOM_PREFIX))
    return `%${escaped.charCodeAt(0).toString(16).toUpperCase()}${escaped.slice(1)}`
  return escaped
}

/**
 * Only the escapes `escapeUid` writes are undone, so an older link whose
 * uid happened to hold some other `%` sequence reads exactly as it did.
 */
function unescapeUid(text: string): string {
  const first = /^%(6F|61|63)/i.test(text)
    ? String.fromCharCode(Number.parseInt(text.slice(1, 3), 16)) + text.slice(3)
    : text
  return first.replace(/%(25|3A|7C)/gi, (escape) =>
    String.fromCharCode(Number.parseInt(escape.slice(1), 16)),
  )
}

function escapeTenant(tenant: string): string {
  return tenant.replace(/%/g, '%25').replace(/\|/g, '%7C')
}

function unescapeTenant(text: string): string {
  return text.replace(/%(25|7C)/gi, (escape) =>
    String.fromCharCode(Number.parseInt(escape.slice(1), 16)),
  )
}

/**
 * The URL-safe form kept in the `as` search param: absent for the owner,
 * `anonymous`, `[<tenant>|]<uid>[:<email>]` for an Auth user and
 * `custom.<base64url JSON>` for a custom identity.
 */
export function serializeViewAs(viewAs: ViewAs): string | undefined {
  if (viewAs.kind === 'owner') return undefined
  if (viewAs.kind === 'anonymous') return 'anonymous'
  if (viewAs.kind === 'custom') {
    const body: Record<string, unknown> = { uid: viewAs.uid, claims: viewAs.claims }
    if (viewAs.signInProvider !== undefined) body.signInProvider = viewAs.signInProvider
    if (viewAs.emailVerified !== undefined) body.emailVerified = viewAs.emailVerified
    if (viewAs.email !== undefined) body.email = viewAs.email
    return `${CUSTOM_PREFIX}${base64url(JSON.stringify(body))}`
  }
  const tenant = viewAs.tenant ? `${escapeTenant(viewAs.tenant)}|` : ''
  const uid = escapeUid(viewAs.uid)
  return viewAs.email ? `${tenant}${uid}:${viewAs.email}` : `${tenant}${uid}`
}

/** Reads `?as=`; anything it cannot read is the owner, which is what an absent param means. */
export function parseViewAs(raw: string | undefined): ViewAs {
  if (!raw || raw === 'owner') return { kind: 'owner' }
  if (raw === 'anonymous') return { kind: 'anonymous' }
  if (raw.startsWith(CUSTOM_PREFIX)) {
    const custom = parseCustom(raw.slice(CUSTOM_PREFIX.length))
    // An older link to a user whose uid starts `custom.` still opens that user.
    if (custom) return custom
  }
  const bar = raw.indexOf('|')
  const tenant = bar === -1 ? undefined : unescapeTenant(raw.slice(0, bar))
  const rest = bar === -1 ? raw : raw.slice(bar + 1)
  const colon = rest.indexOf(':')
  const uid = unescapeUid(colon === -1 ? rest : rest.slice(0, colon))
  const email = colon === -1 ? undefined : rest.slice(colon + 1)
  const user: Extract<ViewAs, { kind: 'user' }> = { kind: 'user', uid }
  if (tenant) user.tenant = tenant
  if (email) user.email = email
  return user
}

function parseCustom(encoded: string): Extract<ViewAs, { kind: 'custom' }> | undefined {
  let body: unknown
  try {
    body = JSON.parse(fromBase64url(encoded))
  } catch {
    return undefined
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const { uid, claims, signInProvider, emailVerified, email } = body as Record<string, unknown>
  if (typeof uid !== 'string' || uid === '') return undefined
  const custom: Extract<ViewAs, { kind: 'custom' }> = {
    kind: 'custom',
    uid,
    claims:
      claims && typeof claims === 'object' && !Array.isArray(claims)
        ? (claims as Record<string, unknown>)
        : {},
  }
  if (typeof signInProvider === 'string') custom.signInProvider = signInProvider
  if (typeof emailVerified === 'boolean') custom.emailVerified = emailVerified
  if (typeof email === 'string') custom.email = email
  return custom
}

export function describeViewAs(viewAs: ViewAs): string {
  if (viewAs.kind === 'owner') return 'Admin (bypasses rules)'
  if (viewAs.kind === 'anonymous') return 'Anonymous'
  if (viewAs.kind === 'custom') return `${viewAs.email ?? viewAs.uid} (custom)`
  const name = viewAs.email ?? viewAs.uid
  return viewAs.tenant ? `${name} · ${viewAs.tenant}` : name
}

/** The same, without the qualifier a narrow toolbar has no room for. */
export function describeViewAsShort(viewAs: ViewAs): string {
  if (viewAs.kind === 'owner') return 'Admin'
  if (viewAs.kind === 'custom') return viewAs.email ?? viewAs.uid
  if (viewAs.kind === 'user') return viewAs.email ?? viewAs.uid
  return describeViewAs(viewAs)
}
