// The Authentication section's requests: every route of the Auth Console API
// (`/console/api/v1/auth/…`, `crates/console-front/src/auth/routes.rs`) and
// the one way the pages call the Auth emulator itself, through the same
// mount, for every write a developer makes.
//
// Reads and the console's own actions (pages, batch reads, bulk jobs,
// tokens, inspection, imports, exports, tenants with a chosen id) are the
// Console API. Edits go through the official API instead — the Identity
// Toolkit as the Admin SDK or an app calls it — so each one behaves exactly
// as it would from code, and Activity records it (`x-firenook-console:
// write`, hidden there by default; a replay, and the beforeSignIn run of
// Sign in as, are always shown).
//
// Every Console API route takes `project`; absent is the configured one.
// Nothing here creates a project or a tenant by reading it.

import { API_BASE, ApiError, apiGet, apiSend, nativeFetch, parseErrorBody } from '@/api/client'
import type { BatchGetRequest } from '@/api/generated/BatchGetRequest'
import type { BatchGetResponse } from '@/api/generated/BatchGetResponse'
import type { Job } from '@/api/generated/Job'
import type { ListMeta } from '@/api/generated/ListMeta'
import type { AuthActivityDetail } from '@/api/generated/auth/AuthActivityDetail'
import type { AuthActivityPage } from '@/api/generated/auth/AuthActivityPage'
import type { AuthBulkPreview } from '@/api/generated/auth/AuthBulkPreview'
import type { AuthBulkRequest } from '@/api/generated/auth/AuthBulkRequest'
import type { AuthClaimKeys } from '@/api/generated/auth/AuthClaimKeys'
import type { AuthConsoleOrigin } from '@/api/generated/auth/AuthConsoleOrigin'
import type { AuthDeleteUsersRequest } from '@/api/generated/auth/AuthDeleteUsersRequest'
import type { AuthHooks } from '@/api/generated/auth/AuthHooks'
import type { AuthImportPreview } from '@/api/generated/auth/AuthImportPreview'
import type { AuthImportRequest } from '@/api/generated/auth/AuthImportRequest'
import type { AuthMessage } from '@/api/generated/auth/AuthMessage'
import type { AuthMessagePage } from '@/api/generated/auth/AuthMessagePage'
import type { AuthMintedToken } from '@/api/generated/auth/AuthMintedToken'
import type { AuthRemoveClaimsRequest } from '@/api/generated/auth/AuthRemoveClaimsRequest'
import type { AuthSetClaimsRequest } from '@/api/generated/auth/AuthSetClaimsRequest'
import type { AuthSummary } from '@/api/generated/auth/AuthSummary'
import type { AuthTenant } from '@/api/generated/auth/AuthTenant'
import type { AuthTenantCreate } from '@/api/generated/auth/AuthTenantCreate'
import type { AuthTenantList } from '@/api/generated/auth/AuthTenantList'
import type { AuthTokenInspection } from '@/api/generated/auth/AuthTokenInspection'
import type { AuthTokenRequest } from '@/api/generated/auth/AuthTokenRequest'
import type { AuthUserDetail } from '@/api/generated/auth/AuthUserDetail'
import type { AuthUsersBatchGet } from '@/api/generated/auth/AuthUsersBatchGet'
import type { AuthUsersPage } from '@/api/generated/auth/AuthUsersPage'
import { longRequests } from '@/lib/long-requests'

type Params = Record<string, string | number | boolean | undefined>

/** `project` as a request sends it: left out for the configured project, or before it is known. */
function scoped(project: string, params: Params = {}): Params {
  return project === '' ? params : { project, ...params }
}

/** `apiSend`'s options for a request that may be cancelled. */
function cancellable(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal ? { signal } : {}
}

/** `path?query` for the Console API's changes, which carry their scope in the address. */
function withQuery(path: string, params: Params): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== '') search.set(key, String(value))
  return search.size > 0 ? `${path}?${search}` : path
}

/** A page of a list the engine pages: after `cursor`, or above `before`. */
export interface PageRequest {
  cursor?: string | undefined
  before?: string | undefined
  /** 100 by default, 500 at most. */
  limit?: number | undefined
}

// ------------------------------------------------------------------ users

export interface UsersRequest extends PageRequest {
  /** A tenant id; absent for the project's own users. */
  tenant?: string | undefined
  q?: string | undefined
  /** `<column>:asc|desc` over `GET /users/meta`'s sortable columns. */
  sort?: string | undefined
}

/** `GET /users`: one page of the users table (facets and counts on the first page only). */
export function getUsers(
  project: string,
  request: UsersRequest,
  signal?: AbortSignal,
): Promise<AuthUsersPage> {
  return apiGet<AuthUsersPage>(
    '/auth/users',
    scoped(project, {
      tenant: request.tenant,
      q: request.q || undefined,
      sort: request.sort,
      cursor: request.cursor,
      before: request.before,
      limit: request.limit,
    }),
    signal,
  )
}

/** `GET /users/meta`: the sortable columns, the default sort and the filter fields. */
export function getUsersMeta(project: string, signal?: AbortSignal): Promise<ListMeta> {
  return apiGet<ListMeta>('/auth/users/meta', scoped(project), signal)
}

/**
 * `POST /users:batchGet`: the rows a live window named, read again against
 * the loaded pages, with the count and the facets recounted for the
 * request's `q`.
 */
export function batchGetUsers(
  project: string,
  tenant: string | undefined,
  request: BatchGetRequest,
  signal?: AbortSignal,
): Promise<AuthUsersBatchGet> {
  return apiSend<AuthUsersBatchGet>(
    'POST',
    withQuery('/auth/users:batchGet', scoped(project, { tenant })),
    request,
    cancellable(signal),
  )
}

/** `GET /user`: one account in full. The uid rides in the query, since uids may hold `/`. */
export function getUser(
  project: string,
  tenant: string | undefined,
  uid: string,
  signal?: AbortSignal,
): Promise<AuthUserDetail> {
  return apiGet<AuthUserDetail>('/auth/user', scoped(project, { tenant, uid }), signal)
}

/** `GET /claims`: the custom claim keys users carry, most users first. */
export function getClaimKeys(
  project: string,
  tenant: string | undefined,
  signal?: AbortSignal,
): Promise<AuthClaimKeys> {
  return apiGet<AuthClaimKeys>('/auth/claims', scoped(project, { tenant }), signal)
}

// ------------------------------------------------------------------ tokens

/**
 * `POST /tokens`: the tokens a sign-in of this user would produce, minted
 * without signing in; nothing is stored. With `runBeforeSignIn` the
 * beforeSignIn function runs (its own side effects happen) and Activity
 * records the mint as a console try.
 */
export function mintToken(
  project: string,
  request: AuthTokenRequest,
  signal?: AbortSignal,
): Promise<AuthMintedToken> {
  return apiSend<AuthMintedToken>(
    'POST',
    withQuery('/auth/tokens', scoped(project)),
    request,
    cancellable(signal),
  )
}

/** `POST /token/inspect`: what a pasted token is and how each consumer judges it; changes nothing. */
export function inspectToken(
  project: string,
  token: string,
  signal?: AbortSignal,
): Promise<AuthTokenInspection> {
  return apiSend<AuthTokenInspection>(
    'POST',
    withQuery('/auth/token/inspect', scoped(project)),
    { token },
    cancellable(signal),
  )
}

// ------------------------------------------------------------------ bulk

interface BulkBodies {
  disable: AuthBulkRequest
  enable: AuthBulkRequest
  verify: AuthBulkRequest
  revoke: AuthBulkRequest
  setClaims: AuthSetClaimsRequest
  removeClaims: AuthRemoveClaimsRequest
  delete: AuthDeleteUsersRequest
}

/** The bulk changes `POST /users:<verb>` makes. */
export type BulkVerb = keyof BulkBodies

/** A bulk request without its `dryRun`, which `previewBulk` and `startBulk` set. */
export type BulkBody<V extends BulkVerb> = Omit<BulkBodies[V], 'dryRun'>

/** The dry run: what the change would do (the confirm's numbers); nothing changes. */
export function previewBulk<V extends BulkVerb>(
  project: string,
  verb: V,
  body: BulkBody<V>,
  signal?: AbortSignal,
): Promise<AuthBulkPreview> {
  return apiSend<AuthBulkPreview>(
    'POST',
    withQuery(`/auth/users:${verb}`, scoped(project)),
    { ...body, dryRun: true },
    cancellable(signal),
  )
}

/**
 * The change itself, as a job (`202`): progress on the `jobs` topic, Cancel
 * between chunks. A fifth Auth job while four run is `409 conflict`; a
 * delete that would fire triggers for more than 10,000 users is refused.
 */
export function startBulk<V extends BulkVerb>(
  project: string,
  verb: V,
  body: BulkBody<V>,
): Promise<Job> {
  return apiSend<Job>('POST', withQuery(`/auth/users:${verb}`, scoped(project)), {
    ...body,
    dryRun: false,
  })
}

// ------------------------------------------------------------------ import and export

/**
 * `POST /imports`: uploads the file itself (streamed from disk by the
 * browser, as `application/json`) and answers the dry run; the engine keeps
 * the upload 10 minutes for `startImport`. Holds one of the tab's three
 * long-request slots while it uploads.
 */
export async function uploadImport(
  project: string,
  tenant: string | undefined,
  file: Blob,
  signal?: AbortSignal,
): Promise<AuthImportPreview> {
  const release = await longRequests.acquire(signal)
  try {
    const response = await nativeFetch(withQuery('/auth/imports', scoped(project, { tenant })), {
      method: 'POST',
      body: file,
      signal: signal ?? null,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
    })
    return (await response.json()) as AuthImportPreview
  } finally {
    release()
  }
}

/** `POST /users:import` as a dry run: the kept upload previewed with these options. */
export function previewImport(
  request: Omit<AuthImportRequest, 'dryRun'>,
  signal?: AbortSignal,
): Promise<AuthImportPreview> {
  return apiSend<AuthImportPreview>(
    'POST',
    '/auth/users:import',
    { ...request, dryRun: true },
    cancellable(signal),
  )
}

/** `POST /users:import`: imports the kept upload as a job (no `user.create` triggers fire). */
export function startImport(request: Omit<AuthImportRequest, 'dryRun'>): Promise<Job> {
  return apiSend<Job>('POST', '/auth/users:import', { ...request, dryRun: false })
}

/** `DELETE /imports/{id}`: discards a kept upload. */
export function discardImport(importId: string): Promise<void> {
  return apiSend<void>('DELETE', `/auth/imports/${encodeURIComponent(importId)}`, {})
}

export interface ExportRequest {
  tenant?: string | undefined
  format: 'json' | 'csv'
  /** Every user the filter matches. */
  q?: string | undefined
  /** These users instead (at most 500). */
  uids?: readonly string[] | undefined
}

/**
 * The address of `GET /users:export`, for `download(href)`: the engine
 * streams the file from one snapshot, so nothing is assembled in the page.
 */
export function exportUsersHref(project: string, request: ExportRequest): string {
  const search = new URLSearchParams()
  if (project !== '') search.set('project', project)
  if (request.tenant) search.set('tenant', request.tenant)
  search.set('format', request.format)
  if (request.uids && request.uids.length > 0) {
    for (const uid of request.uids) search.append('uid', uid)
  } else if (request.q) search.set('q', request.q)
  return `${API_BASE}/auth/users:export?${search}`
}

// ------------------------------------------------------------------ inbox

export interface FeedRequest extends PageRequest {
  /** A tenant id, `(none)` for the project's own, absent for every tenant. */
  tenant?: string | undefined
  q?: string | undefined
}

/** `GET /messages`: a page of the Inbox, newest first, with `liveAfter` to subscribe from. */
export function getMessages(
  project: string,
  request: FeedRequest,
  signal?: AbortSignal,
): Promise<AuthMessagePage> {
  return apiGet<AuthMessagePage>(
    '/auth/messages',
    scoped(project, {
      tenant: request.tenant,
      q: request.q || undefined,
      cursor: request.cursor,
      before: request.before,
      limit: request.limit,
    }),
    signal,
  )
}

/**
 * `GET /messages?activity=`: exactly the messages one call created — how a
 * page reads the code its own call sent (from `x-firenook-activity`), never
 * by racing the feed.
 */
export function getMessagesOfCall(
  project: string,
  activity: number,
  signal?: AbortSignal,
): Promise<AuthMessagePage> {
  return apiGet<AuthMessagePage>('/auth/messages', scoped(project, { activity }), signal)
}

/** `GET /messages/{id}`: one message a link names that the page has not loaded. */
export function getMessage(id: number, signal?: AbortSignal): Promise<AuthMessage> {
  return apiGet<AuthMessage>(`/auth/messages/${id}`, undefined, signal)
}

/** `DELETE /messages`: clears the Inbox's history; codes already sent still work. */
export function clearMessages(project: string): Promise<void> {
  return apiSend<void>('DELETE', withQuery('/auth/messages', scoped(project)), {})
}

// ------------------------------------------------------------------ activity

export interface ActivityRequest extends FeedRequest {
  /** Include the console's own edits (`write`); tries and replays are always in. */
  console?: boolean | undefined
}

/** `GET /activity`: a page of calls, newest first, with `liveAfter` to subscribe from. */
export function getActivity(
  project: string,
  request: ActivityRequest,
  signal?: AbortSignal,
): Promise<AuthActivityPage> {
  return apiGet<AuthActivityPage>(
    '/auth/activity',
    scoped(project, {
      tenant: request.tenant,
      q: request.q || undefined,
      console: request.console ? true : undefined,
      cursor: request.cursor,
      before: request.before,
      limit: request.limit,
    }),
    signal,
  )
}

/** `GET /activity/{id}`: one call in full, bodies included when they are kept. */
export function getActivityEntry(id: number, signal?: AbortSignal): Promise<AuthActivityDetail> {
  return apiGet<AuthActivityDetail>(`/auth/activity/${id}`, undefined, signal)
}

/** `DELETE /activity`: clears the Activity history. */
export function clearActivity(project: string): Promise<void> {
  return apiSend<void>('DELETE', withQuery('/auth/activity', scoped(project)), {})
}

// ------------------------------------------------------------------ tenants, hooks, summary

export interface TenantsRequest {
  /** Filters by id and display name. */
  q?: string | undefined
  /** At most this many (the engine's default and most: 500). */
  limit?: number | undefined
}

/**
 * `GET /tenants`: the tenants `q` matches in id order, each with its user
 * count, and how many it matches; never creates one.
 */
export function getTenants(
  project: string,
  request: TenantsRequest,
  signal?: AbortSignal,
): Promise<AuthTenantList> {
  return apiGet<AuthTenantList>(
    '/auth/tenants',
    scoped(project, { q: request.q || undefined, limit: request.limit }),
    signal,
  )
}

/** `POST /tenants:batchGet`: tenants by id (`row: null` for one that does not exist, or no longer does). */
export function batchGetTenants(
  project: string,
  request: BatchGetRequest,
  signal?: AbortSignal,
): Promise<BatchGetResponse<AuthTenant>> {
  return apiSend<BatchGetResponse<AuthTenant>>(
    'POST',
    withQuery('/auth/tenants:batchGet', scoped(project)),
    request,
    cancellable(signal),
  )
}

/** `POST /tenants`: a tenant with the id you choose (`409 already-exists` when taken). */
export function createTenant(project: string, request: AuthTenantCreate): Promise<AuthTenant> {
  return apiSend<AuthTenant>('POST', withQuery('/auth/tenants', scoped(project)), request)
}

/** `GET /hooks`: the blocking functions a sign-up and a sign-in would call. */
export function getHooks(project: string, signal?: AbortSignal): Promise<AuthHooks> {
  return apiGet<AuthHooks>('/auth/hooks', scoped(project), signal)
}

/** `GET /summary`: the pages' facts (counts, ring capacities, whether bodies are kept). */
export function getSummary(project: string, signal?: AbortSignal): Promise<AuthSummary> {
  return apiGet<AuthSummary>('/auth/summary', scoped(project), signal)
}

// ------------------------------------------------------------------ the Auth emulator itself

/** The API key a console call sends as a client; the emulator accepts any. */
export const API_KEY = 'fake-api-key'

/** The Admin SDK's credential against the emulator. */
export const OWNER_CREDENTIAL = 'Bearer owner'

/** The Identity Toolkit path of `operation`, scoped to a project (and tenant) the way the Admin SDK writes it. */
export function toolkitPath(
  operation: string,
  scope?: { project: string; tenant?: string | undefined },
): string {
  if (!scope) return `/identitytoolkit.googleapis.com/v1/${operation}`
  const tenant = scope.tenant ? `/tenants/${encodeURIComponent(scope.tenant)}` : ''
  return `/identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(scope.project)}${tenant}/${operation}`
}

/** The v2 tenants collection, or one tenant. */
export function tenantsPath(project: string, tenant?: string): string {
  const one = tenant === undefined ? '' : `/${encodeURIComponent(tenant)}`
  return `/identitytoolkit.googleapis.com/v2/projects/${encodeURIComponent(project)}/tenants${one}`
}

/** The emulator's own routes: `config`, `oobCodes`, `verificationCodes`, `accounts`. */
export function emulatorPath(
  project: string,
  rest: 'config' | 'oobCodes' | 'verificationCodes' | 'accounts',
  tenant?: string,
): string {
  const scope = tenant ? `/tenants/${encodeURIComponent(tenant)}` : ''
  return `/emulator/v1/projects/${encodeURIComponent(project)}${scope}/${rest}`
}

/** One call to the Auth emulator through the console's mount. */
export interface EmulatorRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** The official path, as an app or the Admin SDK calls it (`toolkitPath`, `tenantsPath`…). */
  path: string
  query?: Readonly<Record<string, string | undefined>> | undefined
  /** JSON; absent sends no body. */
  body?: unknown
  /**
   * `admin`: the Admin SDK's owner credential; `client`: the app's API key
   * (`key=` in the query, unless the query already has one); `none`: neither,
   * as a recorded call without one is replayed.
   */
  as: 'admin' | 'client' | 'none'
  /** What Activity records it as: an edit (hidden by default), a try, a replay. */
  origin: AuthConsoleOrigin
  /** Headers a replay sends again (`x-client-version`…); never the credential. */
  headers?: Readonly<Record<string, string>> | undefined
}

/** What the emulator answered, and the call's id in Activity. */
export interface EmulatorAnswer<T> {
  status: number
  body: T
  /** `x-firenook-activity`: the call's id, for `?entry=` and `getMessagesOfCall`. */
  activity: number | undefined
}

/**
 * A refusal from the Auth emulator: its status, its code and the call's id
 * in Activity, so a page can explain the code and link the entry.
 */
export class AuthEmulatorError extends Error {
  readonly status: number
  /** `errorCode` of the answer: what the SDKs map to their own names. */
  readonly code: string
  readonly activity: number | undefined
  readonly body: unknown

  constructor(status: number, message: string, activity: number | undefined, body: unknown) {
    super(message)
    this.name = 'AuthEmulatorError'
    this.status = status
    this.code = errorCode(message, body)
    this.activity = activity
    this.body = body
  }
}

/**
 * An emulator answer's code, as Activity records it: the message before
 * " : " (`WEAK_PASSWORD : Password should be…` → `WEAK_PASSWORD`), or the
 * answer's status (`INVALID_ARGUMENT`) when the message is prose.
 */
export function errorCode(message: string, body?: unknown): string {
  const head = message.split(' : ')[0]?.trim() ?? ''
  if (/^[A-Z][A-Z0-9_]*$/.test(head)) return head
  const error =
    typeof body === 'object' && body !== null
      ? (body as { error?: { status?: unknown } }).error
      : undefined
  return typeof error?.status === 'string' && error.status !== '' ? error.status : message
}

function activityOf(response: Response): number | undefined {
  const value = Number(response.headers.get('x-firenook-activity'))
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

async function bodyOf(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined
  const text = await response.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** The address a request goes to: the mount, the official path, its query. */
export function emulatorUrl(request: Pick<EmulatorRequest, 'path' | 'query' | 'as'>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(request.query ?? {}))
    if (value !== undefined) search.set(key, value)
  if (request.as === 'client' && !search.has('key')) search.set('key', API_KEY)
  const path = request.path.startsWith('/') ? request.path : `/${request.path}`
  return `${API_BASE}/auth${path}${search.size > 0 ? `?${search}` : ''}`
}

/**
 * Calls the Auth emulator as the app or the Admin SDK would, through the
 * console's mount. Resolves with the answer and the call's Activity id;
 * rejects with an `AuthEmulatorError` carrying the emulator's own code, or
 * an `ApiError` (`network`) when the engine did not answer.
 */
export async function callAuthEmulator<T>(
  request: EmulatorRequest,
  signal?: AbortSignal,
): Promise<EmulatorAnswer<T>> {
  const headers = new Headers(request.headers)
  headers.delete('authorization')
  headers.set('accept', 'application/json')
  headers.set('x-firenook-console', request.origin)
  if (request.as === 'admin') headers.set('authorization', OWNER_CREDENTIAL)
  const init: RequestInit = { method: request.method, headers, signal: signal ?? null }
  if (request.body !== undefined) {
    headers.set('content-type', 'application/json')
    init.body = JSON.stringify(request.body)
  }
  let response: Response
  try {
    response = await fetch(emulatorUrl(request), init)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new ApiError(0, `The engine did not answer: ${reason}`, 'network')
  }
  const activity = activityOf(response)
  const body = await bodyOf(response)
  if (!response.ok) {
    const parsed = parseErrorBody(response.status, body, `${response.status}`)
    throw new AuthEmulatorError(response.status, parsed.message, activity, body)
  }
  return { status: response.status, body: body as T, activity }
}

/** The emulator's project switches (`GET /emulator/v1/projects/{p}/config`). */
export interface AuthEmulatorConfig {
  signIn: { allowDuplicateEmails: boolean }
  emailPrivacyConfig: { enableImprovedEmailPrivacy: boolean }
}

/**
 * The project's one-account-per-email and email enumeration protection
 * switches. The official route answers for a project it has not seen by
 * creating it, so this reads the configured project, or one that already
 * holds Auth data.
 */
export async function getEmulatorConfig(
  project: string,
  signal?: AbortSignal,
): Promise<AuthEmulatorConfig> {
  const answer = await callAuthEmulator<AuthEmulatorConfig>(
    { method: 'GET', path: emulatorPath(project, 'config'), as: 'admin', origin: 'write' },
    signal,
  )
  return answer.body
}

/** Changes the project's switches through the official route; answers them as they now stand. */
export async function updateEmulatorConfig(
  project: string,
  change: {
    allowDuplicateEmails?: boolean | undefined
    enableImprovedEmailPrivacy?: boolean | undefined
  },
): Promise<AuthEmulatorConfig> {
  const body: Record<string, unknown> = {}
  if (change.allowDuplicateEmails !== undefined)
    body.signIn = { allowDuplicateEmails: change.allowDuplicateEmails }
  if (change.enableImprovedEmailPrivacy !== undefined)
    body.emailPrivacyConfig = { enableImprovedEmailPrivacy: change.enableImprovedEmailPrivacy }
  const answer = await callAuthEmulator<AuthEmulatorConfig>({
    method: 'PATCH',
    path: emulatorPath(project, 'config'),
    body,
    as: 'admin',
    origin: 'write',
  })
  return answer.body
}
