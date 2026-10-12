// Which users, calls and messages a page shows: the shell's project and the
// page's `tenant` param, turned into the request params, topic params and
// query-key slots every Auth request and subscription uses.
//
// `tenant` means a little more on the feeds than on Users. Users (and the
// Settings card) show one tenant's accounts or the project's own: absent is
// the project's users, a tenant id is that tenant's, and `(all)` or `(none)`
// are dropped without an error. The Inbox and Activity show every tenant by
// default: absent is all of them, `(none)` the project's own only, a tenant
// id that tenant's.
//
// Absent `project` is the configured one everywhere, and is what the
// requests and topics send while the page shows it.

import type { BulkTarget } from '@/api/generated/BulkTarget'
import type { AuthActivityParams } from '@/api/generated/auth/AuthActivityParams'
import type { AuthConfigParams } from '@/api/generated/auth/AuthConfigParams'
import type { AuthInboxParams } from '@/api/generated/auth/AuthInboxParams'
import type { AuthUsersParams } from '@/api/generated/auth/AuthUsersParams'
import { splitKey } from '@/lib/sections/keys'

/** The pages a scope belongs to: Users and Settings read one tenant, the feeds read all by default. */
export type AuthPage = 'users' | 'inbox' | 'activity' | 'settings'

/** The project's own accounts, one tenant's, or (on the feeds) every tenant's. */
export type TenantScope = { kind: 'project' } | { kind: 'tenant'; tenant: string } | { kind: 'all' }

/** The feeds' `tenant` value for the project's own calls and messages. */
export const NO_TENANT = '(none)'
/** A `tenant` value naming every tenant, accepted as the feeds' default. */
export const ALL_TENANTS = '(all)'

const FEEDS: ReadonlySet<AuthPage> = new Set(['inbox', 'activity'])

/** What a page's `tenant` param names. */
export function tenantScope(page: AuthPage, raw: string | undefined): TenantScope {
  const value = raw?.trim() ?? ''
  if (FEEDS.has(page)) {
    if (value === '' || value === ALL_TENANTS) return { kind: 'all' }
    if (value === NO_TENANT) return { kind: 'project' }
    return { kind: 'tenant', tenant: value }
  }
  if (value === '' || value === ALL_TENANTS || value === NO_TENANT) return { kind: 'project' }
  return { kind: 'tenant', tenant: value }
}

/** The `tenant` param that shows `scope` on `page`, absent for the page's default. */
export function tenantParam(page: AuthPage, scope: TenantScope): string | undefined {
  if (scope.kind === 'tenant') return scope.tenant
  if (FEEDS.has(page)) return scope.kind === 'project' ? NO_TENANT : undefined
  return undefined
}

/**
 * The scope's slot in a query key: the tenant id, `''` for the project's
 * own accounts (as `tokenKey` writes it), `'*'` for every tenant.
 */
export function tenantKey(scope: TenantScope): string {
  if (scope.kind === 'tenant') return scope.tenant
  return scope.kind === 'all' ? '*' : ''
}

/** The tenant a users request names: the id, or nothing for the project's users. */
export function usersTenant(scope: TenantScope): string | undefined {
  return scope.kind === 'tenant' ? scope.tenant : undefined
}

/** The `tenant` a feed request or topic sends: the id, `(none)` for the project's, nothing for all. */
export function feedTenant(scope: TenantScope): string | undefined {
  if (scope.kind === 'tenant') return scope.tenant
  return scope.kind === 'project' ? NO_TENANT : undefined
}

/** `project` as requests and topics send it: absent for the configured project (or before it is known). */
export function projectParam(project: string): string | undefined {
  return project === '' ? undefined : project
}

/** `auth.users` for a users scope; every tenant at once is not a scope this topic has. */
export function usersTopicParams(project: string, scope: TenantScope): AuthUsersParams | null {
  if (scope.kind === 'all') return null
  const params: AuthUsersParams = {}
  const p = projectParam(project)
  if (p !== undefined) params.project = p
  if (scope.kind === 'tenant') params.tenant = scope.tenant
  return params
}

/** `auth.activity` for what the Activity page shows: its scope, its `q`, the console's own edits or not. */
export function activityTopicParams(
  project: string,
  scope: TenantScope,
  q: string | undefined,
  includeConsole: boolean,
): AuthActivityParams {
  const params: AuthActivityParams = { console: includeConsole }
  const p = projectParam(project)
  if (p !== undefined) params.project = p
  const tenant = feedTenant(scope)
  if (tenant !== undefined) params.tenant = tenant
  if (q) params.q = q
  return params
}

/** `auth.inbox` for what the Inbox shows. */
export function inboxTopicParams(
  project: string,
  scope: TenantScope,
  q: string | undefined,
): AuthInboxParams {
  const params: AuthInboxParams = {}
  const p = projectParam(project)
  if (p !== undefined) params.project = p
  const tenant = feedTenant(scope)
  if (tenant !== undefined) params.tenant = tenant
  if (q) params.q = q
  return params
}

/** `auth.config` and `auth.hooks`. */
export function configTopicParams(project: string): AuthConfigParams {
  const p = projectParam(project)
  return p === undefined ? {} : { project: p }
}

// ------------------------------------------------------------------ users

/**
 * An `auth.user` key, `<tenant>|<uid>` with the tenant empty for the
 * project's users — what `EntityRef::auth_user` builds in the engine, what
 * a bulk job's `keys` and its errors name. Tenant ids never hold `|`, so the
 * uid may.
 */
export function userKey(tenant: string | null | undefined, uid: string): string {
  return `${tenant ?? ''}|${uid}`
}

/** An `auth.user` key read back; a key without a bar is a project user's uid. */
export function parseUserKey(key: string): { tenant: string | undefined; uid: string } {
  const [first = '', rest] = splitKey(key)
  if (rest === undefined) return { tenant: undefined, uid: first }
  return { tenant: first === '' ? undefined : first, uid: rest }
}

/** A bulk job over ticked users of one scope (at most 10,000 keys, the engine's limit). */
export function keysTarget(scope: TenantScope, uids: readonly string[]): BulkTarget {
  const tenant = usersTenant(scope)
  return { by: 'keys', keys: uids.map((uid) => userKey(tenant, uid)) }
}

/**
 * A bulk job over every user the filter matches when the job runs: the
 * page's `q` and the users list's own scope params as JSON (`{"tenant":
 * "acme"}`, `{}` for the project's users).
 */
export function queryTarget(scope: TenantScope, q: string | undefined): BulkTarget {
  const tenant = usersTenant(scope)
  return { by: 'query', q: q ?? '', scope: tenant === undefined ? {} : { tenant } }
}
