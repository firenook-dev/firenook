// Server state for the Authentication pages, keyed `['auth', project, …]`
// (foundation §4.4) so the section's topics refresh exactly what changed by
// prefix — the foundation's identity search (`['auth', p, 'identities', …]`)
// and engine tokens (`['auth', p, 'token', tenant, uid]`) included. Nothing
// here polls: live windows patch rows, invalidate one key, or push into a
// feed (`live.ts`).

import { type QueryClient, type QueryKey, queryOptions, skipToken } from '@tanstack/react-query'
import type { BatchGetRequest } from '@/api/generated/BatchGetRequest'
import type { Total } from '@/api/generated/Total'
import type { AuthActivityPage } from '@/api/generated/auth/AuthActivityPage'
import type { AuthMessagePage } from '@/api/generated/auth/AuthMessagePage'
import type { AuthUserFacets } from '@/api/generated/auth/AuthUserFacets'
import type { AuthUserRow } from '@/api/generated/auth/AuthUserRow'
import type { AuthUsersBatchGet } from '@/api/generated/auth/AuthUsersBatchGet'
import type { AuthUsersPage } from '@/api/generated/auth/AuthUsersPage'
import { type CursorPageParam, cursorPagesOptions } from '@/components/console/use-cursor-rows'
import { queryClient } from '@/lib/query'
import {
  batchGetTenants,
  batchGetUsers,
  getActivity,
  getActivityEntry,
  getClaimKeys,
  getEmulatorConfig,
  getHooks,
  getMessage,
  getMessages,
  getSummary,
  getTenants,
  getUser,
  getUsers,
  getUsersMeta,
} from './api'
import { type TenantScope, feedTenant, tenantKey, usersTenant } from './tenant-scope'

export const AUTH = 'auth' as const

/** Rows a page asks for: the engine's default. */
export const PAGE_SIZE = 100
/** Tenants the picker lists before it asks to type. */
export const TENANT_PICKER_SIZE = 50
/** Calls the engine keeps, and the most an Activity feed holds (`AuthSummary.activityCapacity`). */
export const ACTIVITY_CAPACITY = 10_000
/** Messages the engine keeps, and the most the Inbox holds (`AuthSummary.messageCapacity`). */
export const MESSAGE_CAPACITY = 2_000

/** Every key the section uses. `tenantKey` is the tenant id, `''` for project users, `'*'` for all. */
export const authKeys = {
  /** Everything Auth holds for a project (identities and tokens included). */
  project: (project: string) => [AUTH, project] as const,
  /** Every users list of a project, whatever its tenant, filter and order. */
  allUsers: (project: string) => [AUTH, project, 'users'] as const,
  /** The users table (infinite, cursor pages). */
  users: (project: string, tenant: string, q: string, sort: string) =>
    [AUTH, project, 'users', tenant, q, sort] as const,
  /** The users count and facets for a filter, kept beside the table as pages slide. */
  usersFigures: (project: string, tenant: string, q: string) =>
    [AUTH, project, 'users-figures', tenant, q] as const,
  usersMeta: (project: string) => [AUTH, project, 'users-meta'] as const,
  /** Every user detail of a project. */
  allUserDetails: (project: string) => [AUTH, project, 'user'] as const,
  user: (project: string, tenant: string, uid: string) =>
    [AUTH, project, 'user', tenant, uid] as const,
  claims: (project: string, tenant: string) => [AUTH, project, 'claims', tenant] as const,
  /** Every tenants list (the Settings table, read again on `auth.config`). */
  allTenants: (project: string) => [AUTH, project, 'tenants'] as const,
  tenants: (project: string, q: string) => [AUTH, project, 'tenants', q] as const,
  /** Every answer of the tenant picker (its first page, and what it finds as you type). */
  allTenantPicker: (project: string) => [AUTH, project, 'tenant-picker'] as const,
  tenantPicker: (project: string, q: string) => [AUTH, project, 'tenant-picker', q] as const,
  /** The project's switches (`''`) or one tenant's settings. */
  allConfig: (project: string) => [AUTH, project, 'config'] as const,
  config: (project: string, tenant: string) => [AUTH, project, 'config', tenant] as const,
  hooks: (project: string) => [AUTH, project, 'hooks'] as const,
  summary: (project: string) => [AUTH, project, 'summary'] as const,
  /** Every first page of Activity. */
  allActivity: (project: string) => [AUTH, project, 'activity'] as const,
  activity: (project: string, scope: string, q: string, includeConsole: boolean) =>
    [AUTH, project, 'activity', scope, q, includeConsole] as const,
  activityEntry: (project: string, id: number) => [AUTH, project, 'activity-entry', id] as const,
  /** Every first page of the Inbox. */
  allMessages: (project: string) => [AUTH, project, 'messages'] as const,
  messages: (project: string, scope: string, q: string) =>
    [AUTH, project, 'messages', scope, q] as const,
  message: (project: string, id: number) => [AUTH, project, 'message', id] as const,
  /** The newest message of the project, whatever its tenant: where the Inbox's unread dots start. */
  newestMessage: (project: string) => [AUTH, project, 'newest-message'] as const,
  /** The messages one call created (`?activity=`). */
  /** The beacon's newest code or link of one channel. */
  latest: (project: string, channel: 'sms' | 'email') =>
    [AUTH, project, 'latest', channel] as const,
}

// ------------------------------------------------------------------ users

/** The figures the users page shows beside its rows: the count, the facets, the scope's size. */
export interface UsersFigures {
  total: Total
  facets: AuthUserFacets
  scopeTotal: number
  /** Microseconds the engine spent on the last first page, for the count's tooltip. */
  tookMicros: number | undefined
}

/** The figures a first page carries, when it carries them. */
export function figuresOfPage(page: AuthUsersPage): UsersFigures | undefined {
  if (!page.total || !page.facets || page.scopeTotal === null) return undefined
  return {
    total: page.total,
    facets: page.facets,
    scopeTotal: page.scopeTotal,
    tookMicros: page.tookMicros,
  }
}

/** The figures a batch read recounted, over what the first page said (its timing kept). */
export function figuresOfBatch(
  answer: AuthUsersBatchGet,
  previous: UsersFigures | undefined,
): UsersFigures {
  return {
    total: answer.total,
    facets: answer.facets,
    scopeTotal: answer.scopeTotal,
    tookMicros: previous?.tookMicros,
  }
}

/** What a users table is: its key, how it reads a page, and how a live window reads rows again. */
export interface UsersList {
  queryKey: QueryKey
  figuresKey: QueryKey
  /** For `cursorPagesOptions` and `useCursorRows`: a first page also writes the figures. */
  fetchPage: (page: CursorPageParam, signal: AbortSignal) => Promise<AuthUsersPage>
  /**
   * For `useCursorRows`: `POST /users:batchGet`, whose recounted count and
   * facets are written to the figures; the answer goes back unchanged.
   */
  batchGet: (request: BatchGetRequest, signal: AbortSignal) => Promise<AuthUsersBatchGet>
  rowKey: (row: AuthUserRow) => string
}

/** The users table of one scope, filter and order. */
export function usersList(
  project: string,
  scope: TenantScope,
  q: string,
  sort: string,
  client: QueryClient = queryClient,
): UsersList {
  const tenant = usersTenant(scope)
  const slot = tenantKey(scope)
  const figuresKey = authKeys.usersFigures(project, slot, q)
  return {
    queryKey: authKeys.users(project, slot, q, sort),
    figuresKey,
    fetchPage: async (page, signal) => {
      const answer = await getUsers(
        project,
        {
          tenant,
          q,
          sort,
          cursor: page.cursor,
          before: page.before,
          // A page read again with new rows in it asks for them too (`useCursorRows`).
          limit: page.limit ?? PAGE_SIZE,
        },
        signal,
      )
      const figures = figuresOfPage(answer)
      if (figures) client.setQueryData<UsersFigures>(figuresKey, figures)
      return answer
    },
    batchGet: async (request, signal) => {
      const answer = await batchGetUsers(project, tenant, request, signal)
      client.setQueryData<UsersFigures>(figuresKey, (previous) => figuresOfBatch(answer, previous))
      return answer
    },
    rowKey: (row) => row.uid,
  }
}

/** The users table's infinite query: a window of at most 20 cursor pages. */
export function usersQuery(list: UsersList) {
  return cursorPagesOptions(list.queryKey, list.fetchPage)
}

/**
 * The count and the facets the users page shows, written by the first page
 * and by every live batch read (never fetched on their own), so they stay
 * right while the window slides past the first page.
 */
export const usersFiguresQuery = (list: Pick<UsersList, 'figuresKey'>) =>
  queryOptions<UsersFigures>({
    queryKey: list.figuresKey,
    queryFn: skipToken,
    staleTime: Number.POSITIVE_INFINITY,
  })

/** The sortable columns and the filter fields: the engine's, the same for its whole run. */
export const usersMetaQuery = (project: string) =>
  queryOptions({
    queryKey: authKeys.usersMeta(project),
    queryFn: ({ signal }) => getUsersMeta(project, signal),
    staleTime: Number.POSITIVE_INFINITY,
  })

/** One account in full (the inspector). A deleted account is `not-found`, never retried. */
export const userQuery = (project: string, scope: TenantScope, uid: string) =>
  queryOptions({
    queryKey: authKeys.user(project, tenantKey(scope), uid),
    queryFn: ({ signal }) => getUser(project, usersTenant(scope), uid, signal),
    retry: false,
  })

/**
 * The custom claim keys users carry: the claims editor's completion and the
 * rules editors' (`request.auth.token.` completion). Refreshed only when an
 * `auth.users` window names `customAttributes`.
 */
export const claimKeysQuery = (project: string, tenant: string | undefined) =>
  queryOptions({
    queryKey: authKeys.claims(project, tenant ?? ''),
    queryFn: ({ signal }) => getClaimKeys(project, tenant, signal),
    staleTime: Number.POSITIVE_INFINITY,
  })

// ------------------------------------------------------------------ tenants, config, hooks

/**
 * The Settings tenants table: every tenant `q` matches, up to the engine's
 * 500, in one request. An `auth.config` event reads it again
 * (`useConfigLive`); a project has a handful of tenants, not a page of them.
 */
export const tenantsQuery = (project: string, q: string) =>
  queryOptions({
    queryKey: authKeys.tenants(project, q),
    queryFn: ({ signal }) => getTenants(project, { q }, signal),
  })

/**
 * The tenant picker's items: the first page (or what `q` finds, once there
 * are too many to list), each with its user count, and the project's own
 * users. Read again when the menu opens.
 */
export const tenantPickerQuery = (project: string, q = '') =>
  queryOptions({
    queryKey: authKeys.tenantPicker(project, q),
    queryFn: ({ signal }) => getTenants(project, { q, limit: TENANT_PICKER_SIZE }, signal),
  })

/** One tenant's settings and user count; `null` once it is deleted (it is never created by asking). */
export const tenantQuery = (project: string, tenant: string) =>
  queryOptions({
    queryKey: authKeys.config(project, tenant),
    queryFn: async ({ signal }) => {
      const answer = await batchGetTenants(project, { keys: [tenant], pageStarts: [] }, signal)
      return answer.items[0]?.row ?? null
    },
  })

/** The project's one-account-per-email and enumeration-protection switches. */
export const projectConfigQuery = (project: string) =>
  queryOptions({
    queryKey: authKeys.config(project, ''),
    queryFn: ({ signal }) => getEmulatorConfig(project, signal),
  })

/** The blocking functions a sign-up and a sign-in call (`auth.hooks` refreshes it). */
export const hooksQuery = (project: string) =>
  queryOptions({
    queryKey: authKeys.hooks(project),
    queryFn: ({ signal }) => getHooks(project, signal),
    staleTime: Number.POSITIVE_INFINITY,
  })

/** The pages' facts: counts, ring capacities, whether request bodies are kept. */
export const summaryQuery = (project: string) =>
  queryOptions({
    queryKey: authKeys.summary(project),
    queryFn: ({ signal }) => getSummary(project, signal),
  })

// ------------------------------------------------------------------ feeds

/**
 * The first page of Activity for what the page shows: the newest calls,
 * the facets, whether bodies are kept and `liveAfter`, the position the
 * live tail starts from. Read once per scope and filter while the page is
 * mounted, and not kept after it (a feed seeded from an old page would
 * replay everything since); batches refresh it (for the facets) at most
 * every 2 s.
 */
export const activityPageQuery = (
  project: string,
  scope: TenantScope,
  q: string,
  includeConsole: boolean,
) =>
  queryOptions<AuthActivityPage>({
    queryKey: authKeys.activity(project, tenantKey(scope), q, includeConsole),
    queryFn: ({ signal }) =>
      getActivity(
        project,
        { tenant: feedTenant(scope), q, console: includeConsole, limit: PAGE_SIZE },
        signal,
      ),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  })

/** Older calls, below `cursor` (a feed's "load more"; not cached). */
export function olderActivity(
  project: string,
  scope: TenantScope,
  q: string,
  includeConsole: boolean,
  cursor: string,
  signal?: AbortSignal,
): Promise<AuthActivityPage> {
  return getActivity(
    project,
    { tenant: feedTenant(scope), q, console: includeConsole, cursor, limit: PAGE_SIZE },
    signal,
  )
}

/** One call in full; a call the ring dropped is `not-found` ("The engine no longer keeps call #…"). */
export const activityEntryQuery = (project: string, id: number) =>
  queryOptions({
    queryKey: authKeys.activityEntry(project, id),
    queryFn: ({ signal }) => getActivityEntry(id, signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

/** The first page of the Inbox for what the page shows (as `activityPageQuery`). */
export const messagesPageQuery = (project: string, scope: TenantScope, q: string) =>
  queryOptions<AuthMessagePage>({
    queryKey: authKeys.messages(project, tenantKey(scope), q),
    queryFn: ({ signal }) =>
      getMessages(project, { tenant: feedTenant(scope), q, limit: PAGE_SIZE }, signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  })

/** Older messages, below `cursor`. */
export function olderMessages(
  project: string,
  scope: TenantScope,
  q: string,
  cursor: string,
  signal?: AbortSignal,
): Promise<AuthMessagePage> {
  return getMessages(project, { tenant: feedTenant(scope), q, cursor, limit: PAGE_SIZE }, signal)
}

/**
 * The project's newest message id, read once when the Inbox opens: the
 * messages that arrived since this browser last looked are the newest
 * `unseen` of them (the badge's growth), so their dots start below it.
 */
export const newestMessageQuery = (project: string) =>
  queryOptions({
    queryKey: authKeys.newestMessage(project),
    queryFn: async ({ signal }) =>
      (await getMessages(project, { limit: 1 }, signal)).items[0]?.id ?? 0,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  })

/** One message a link names; `not-found` once the store dropped it. */
export const messageQuery = (project: string, id: number) =>
  queryOptions({
    queryKey: authKeys.message(project, id),
    queryFn: ({ signal }) => getMessage(id, signal),
    retry: false,
  })
