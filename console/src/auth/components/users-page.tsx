// Authentication › Users: every account of one tenant (or the project's
// own), as the engine pages, filters, sorts and counts them over the user
// index it keeps beside the accounts — one request whatever the user count.
//
//   panel     the tenant, the facets (exact counts, a click writes the
//             term), the users opened lately
//   row one   the scope, this page's subscription notice, New
//   row two   the filter in the console's grammar, and what it matches
//   body      the table (live rows, never moving under the reader) and the
//             inspector beside it
//
// Every view is a link (`users-search.ts`); facets write `q`, so the URL is
// the truth and a pressed facet is read back from it.

import { Button } from '@cloudflare/kumo'
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '@/api/client'
import type { AuthUserRow } from '@/api/generated/auth/AuthUserRow'
import type { AuthUserFacets } from '@/api/generated/auth/AuthUserFacets'
import { BuildingsIcon } from '@phosphor-icons/react'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { EmptyState } from '@/components/console/empty-state'
import type { DataTableSort } from '@/components/console/data-table'
import { FacetList } from '@/components/console/facet-list'
import { FilterField } from '@/components/console/filter-field'
import { LiveNotice } from '@/components/console/live-notice'
import { MatchCount } from '@/components/console/match-count'
import { PanelHeader } from '@/components/console/panel'
import { SectionBanner } from '@/components/console/section-banner'
import { SectionBody, SectionPage } from '@/components/console/section-page'
import { SectionToolbar, ToolbarRow } from '@/components/console/toolbar'
import { useCursorRows } from '@/components/console/use-cursor-rows'
import { PanelToggle, SectionPanel } from '@/components/shell/section-panel'
import { checkFilter } from '@/lib/filter'
import { formatDuration } from '@/lib/format'
import { useLayout } from '@/lib/layout'
import { liveChannel } from '@/lib/live/channel'
import { useConsoleProject } from '@/lib/project'
import { parseSort, printSort } from '@/lib/search-params'
import { isTyping, useShortcuts } from '@/lib/shortcuts'
import { userFacetGroups, userFields } from '../fields'
import { identifierOf } from '../identifier'
import { useConfigLive } from '../live'
import { useUsersPalette } from '../palette'
import {
  claimKeysQuery,
  tenantPickerQuery,
  tenantQuery,
  usersFiguresQuery,
  usersList,
  usersMetaQuery,
  usersQuery,
} from '../queries'
import { type RecentUser, recentsKey, recentsOf, useRecentUsers } from '../recents'
import {
  type TenantScope,
  projectParam,
  tenantKey,
  tenantParam,
  tenantScope,
  usersTenant,
} from '../tenant-scope'
import { deleteUser, refusal } from '../user-actions'
import { useAccountTriggers } from '../user-triggers'
import { USERS_DEFAULTS, useUsersSearch } from '../users-search'
import { useUsersLive } from '../users-live'
import { TenantPicker } from './tenant-picker'
import { UserInspector } from './user-inspector'
import { UsersGrid } from './users-grid'
import { TENANT_GONE, useUserRowMenu } from './user-row-menu'

const USERS = { one: 'user', other: 'users' }

/** The User column scrolls with the others while this is set (localStorage). */
export const UNFROZEN_KEY = 'firenook.console.auth.unfrozen'

function readUnfrozen(): boolean {
  try {
    return localStorage.getItem(UNFROZEN_KEY) === 'true'
  } catch {
    return false
  }
}

function writeUnfrozen(unfrozen: boolean) {
  try {
    if (unfrozen) localStorage.setItem(UNFROZEN_KEY, 'true')
    else localStorage.removeItem(UNFROZEN_KEY)
  } catch {
    // Storage may be unavailable; the column stays as it is for this visit.
  }
}

/** One more try for a request that did not get an answer; none for the engine's refusal. */
export function retryUnlessRefused(failures: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false
  return failures < 1
}

/** How long a typed filter waits before it becomes the address (and the request). */
const FILTER_SETTLE_MS = 250

/** Whether the tenant in scope exists: always for project users; known once the engine says. */
export type TenantState = 'project' | 'checking' | 'exists' | 'missing' | 'deleted'

/** The next order after a header click: the engine's own order flips rather than vanishing. */
export function nextUsersSort(
  current: DataTableSort,
  next: DataTableSort | undefined,
  fallback: DataTableSort,
): DataTableSort {
  if (next) return next
  if (current.column === fallback.column && current.direction === fallback.direction)
    return { column: fallback.column, direction: fallback.direction === 'asc' ? 'desc' : 'asc' }
  return fallback
}

export function UsersPage() {
  const { project, foreign } = useConsoleProject()
  const { search, update } = useUsersSearch()
  const navigate = useNavigate()
  const scope = tenantScope('users', search.tenant)
  const slot = tenantKey(scope)
  const tenant = usersTenant(scope)
  const q = search.q ?? ''
  const sortText = search.sort ?? USERS_DEFAULTS.sort
  const fallbackSort = parseSort(USERS_DEFAULTS.sort) ?? { column: 'created', direction: 'desc' }
  const sort = parseSort(sortText) ?? fallbackSort
  const panelOpen = useLayout((state) => state.panelOpen)

  // ------------------------------------------------------------ the tenant
  const tenantRow = useQuery({
    ...tenantQuery(project, tenant ?? ''),
    enabled: project !== '' && tenant !== undefined,
  })
  const [seenTenant, setSeenTenant] = useState<string | undefined>(undefined)
  if (tenant !== undefined && tenantRow.data && seenTenant !== `${project}|${tenant}`)
    setSeenTenant(`${project}|${tenant}`)
  const tenantState: TenantState =
    tenant === undefined
      ? 'project'
      : tenantRow.data
        ? 'exists'
        : tenantRow.data === null
          ? seenTenant === `${project}|${tenant}`
            ? 'deleted'
            : 'missing'
          : 'checking'
  const blocked = tenantState === 'deleted' || tenantState === 'missing' ? TENANT_GONE : undefined
  useConfigLive(project)

  // ------------------------------------------------------------ the rows
  const list = usersList(project, scope, q, sortText)
  // A tenant is read once the engine says it exists, so an unknown one is
  // the banner below rather than a refused request; a refusal is the
  // engine's answer, shown at once rather than asked again.
  const readable = project !== '' && (tenantState === 'project' || tenantState === 'exists')
  const query = useInfiniteQuery({
    ...usersQuery(list),
    enabled: readable,
    retry: retryUnlessRefused,
  })
  const rows = useCursorRows(query, {
    queryKey: list.queryKey,
    fetchPage: list.fetchPage,
    rowKey: list.rowKey,
    batchGet: list.batchGet,
    q,
    sort: sortText,
  })
  const figures = useQuery(usersFiguresQuery(list))
  const meta = useQuery({ ...usersMetaQuery(project), enabled: project !== '' })
  const tenants = useQuery({ ...tenantPickerQuery(project), enabled: project !== '' })
  const claims = useQuery({
    ...claimKeysQuery(project, tenant),
    enabled: readable,
    retry: retryUnlessRefused,
  })
  const live = useUsersLive({
    project,
    scope,
    enabled: tenantState === 'project' || tenantState === 'exists',
    applyKeys: rows.applyKeys,
    reset: rows.reset,
    openUid: search.user,
  })
  const flashes = useMemo(() => {
    const merged = new Map<string, 'created' | 'updated' | 'deleted'>(rows.flashes)
    for (const uid of live.deleted) merged.set(uid, 'deleted')
    return merged
  }, [rows.flashes, live.deleted])

  // ------------------------------------------------------------ the filter
  // Completion of provider ids from the facets and of claim keys from the
  // engine's claim index.
  const providerIds = figures.data?.facets.providers
  const claimKeys = claims.data
  const fields = useMemo(
    () =>
      userFields({
        providers: () => providerIds?.map((entry) => entry.provider) ?? [],
        claims: () => claimKeys,
      }),
    [providerIds, claimKeys],
  )
  const parses = checkFilter(q, { fields }).ok
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(settle.current), [])
  const setFilter = (text: string, at: 'typed' | 'now') => {
    clearTimeout(settle.current)
    const apply = () => update({ q: text, user: undefined }, { replace: at === 'typed' })
    if (at === 'now') apply()
    else settle.current = setTimeout(apply, FILTER_SETTLE_MS)
  }

  // ------------------------------------------------------------ opening a user
  const loadRecents = useRecentUsers((state) => state.load)
  const recordRecent = useRecentUsers((state) => state.record)
  const recentItems = useRecentUsers((state) => state.items)
  useEffect(() => {
    if (project) loadRecents(recentsKey(project))
  }, [loadRecents, project])
  const open = (row: AuthUserRow) => {
    if (search.user === row.uid) {
      update({ user: undefined })
      return
    }
    recordRecent({ tenant: slot, uid: row.uid, label: identifierOf(row).text })
    update({ user: row.uid })
  }
  /** The row above or below the open one, for the inspector's chevrons. */
  const step = (by: -1 | 1) => {
    const at = rows.rows.findIndex((row) => row.uid === search.user)
    const next = at === -1 ? undefined : rows.rows[at + by]
    return next ? () => update({ user: next.uid }) : undefined
  }
  const setScope = (next: TenantScope) =>
    update({ tenant: tenantParam('users', next), user: undefined })

  // ------------------------------------------------------------ deleting one user
  const [deleting, setDeleting] = useState<AuthUserRow | null>(null)
  const deleteTriggers = useAccountTriggers(tenant, 'user.delete')
  const remove = useMutation({
    mutationFn: (row: AuthUserRow) => deleteUser({ project, tenant, uid: row.uid }),
    onSuccess: (_answer, row) => {
      setDeleting(null)
      if (search.user === row.uid) update({ user: undefined })
    },
  })
  const rowMenu = useUserRowMenu({
    project,
    scope,
    blocked,
    onOpen: open,
    onDelete: (row) => {
      remove.reset()
      setDeleting(row)
    },
  })

  // ------------------------------------------------------------ layout memory
  const [unfrozen, setUnfrozen] = useState(readUnfrozen)
  const freeze = (frozen: boolean) => {
    setUnfrozen(!frozen)
    writeUnfrozen(!frozen)
  }

  useUsersPalette({
    scope,
    tenants: tenants.data,
    recents: recentsOf(recentItems, slot),
    onScope: setScope,
    onOpenRecent: (recent: RecentUser) => update({ user: recent.uid }),
    unfrozen,
    onFreeze: freeze,
  })

  // A link to New tenant on this page: the dialog lives with the tenants, in Settings.
  useEffect(() => {
    if (search.new !== 'tenant') return
    void navigate({
      to: '/auth/settings' as never,
      search: { new: 'tenant', project: projectParam(project) } as never,
      replace: true,
    })
  }, [search.new, navigate, project])

  useShortcuts({ id: 'auth.users', label: 'Users' }, [
    {
      key: 'Escape',
      label: 'Close the user, then leave the field',
      allowInInputs: true,
      run: (event) => {
        if (isTyping(event.target)) (event.target as HTMLElement).blur()
        else if (search.user !== undefined) update({ user: undefined })
      },
    },
  ])

  // While a new filter's first page is on its way, the scope's last counts
  // stand in the panel, so the facets do not empty and refill on every
  // keystroke; the count beside the filter waits for its own.
  const [lastFacets, setLastFacets] = useState<{ scope: string; facets: AuthUserFacets }>()
  const facetScope = `${project}\u0000${slot}`
  if (figures.data && lastFacets?.facets !== figures.data.facets)
    setLastFacets({ scope: facetScope, facets: figures.data.facets })
  const facets =
    figures.data?.facets ?? (lastFacets?.scope === facetScope ? lastFacets.facets : undefined)
  const tookMs =
    figures.data?.tookMicros === undefined ? undefined : figures.data.tookMicros / 1_000
  const firstLoading = query.isPending && query.fetchStatus !== 'idle'

  return (
    <SectionPage section="auth" page="users" title="Authentication users" testId="auth-users">
      <SectionPanel label="Filters">
        <div className="flex h-full min-h-0 flex-col" data-testid="users-panel">
          <PanelHeader>
            <TenantPicker project={project} page="users" scope={scope} onChange={setScope} />
          </PanelHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-3">
            <FacetList
              groups={userFacetGroups(facets)}
              value={q}
              onChange={(next) => setFilter(next, 'now')}
              testId="user-facets"
            />
            <RecentUsers
              recents={recentsOf(recentItems, slot)}
              openUid={search.user}
              onOpen={(recent) => update({ user: recent.uid })}
            />
          </div>
        </div>
      </SectionPanel>
      <SectionToolbar testId="users-toolbar">
        <ToolbarRow testId="users-row-one">
          <PanelToggle where="toolbar" />
          {!panelOpen && (
            <div className="w-56 min-w-0 shrink" data-testid="toolbar-tenant">
              <TenantPicker
                project={project}
                page="users"
                scope={scope}
                onChange={setScope}
                testId="toolbar-tenant-picker"
              />
            </div>
          )}
          <span className="min-w-0 flex-1" />
          <LiveNotice
            status={live.status}
            what="the users"
            onRetry={() => liveChannel.retry()}
            testId="users-live"
          />
        </ToolbarRow>
        <ToolbarRow variant="line" testId="users-row-two">
          <FilterField
            value={q}
            onChange={(text) => setFilter(text, 'typed')}
            fields={fields}
            placeholder="Filter users — provider:google.com is:disabled ada"
            ariaLabel="Filter users"
            testId="users-filter"
          />
          <MatchCount
            total={figures.data?.total}
            noun={USERS}
            widest="0,000,000"
            loading={query.isFetching && !figures.data}
            hidden={!parses}
            tooltip={
              figures.data
                ? `Every user this filter matches, not only the rows loaded.${
                    tookMs === undefined ? '' : ` Counted in ${formatDuration(tookMs)}.`
                  }`
                : undefined
            }
            testId="users-count"
          />
        </ToolbarRow>
      </SectionToolbar>
      {tenantState === 'missing' && tenant !== undefined && (
        <SectionBanner
          tone="danger"
          testId="tenant-missing"
          action={
            <Button variant="secondary" size="xs" onClick={() => setScope({ kind: 'project' })}>
              Show project users
            </Button>
          }
        >
          There is no tenant <span className="font-mono text-[0.9em]">{tenant}</span> in this
          project.
        </SectionBanner>
      )}
      {tenantState === 'deleted' && tenant !== undefined && (
        <SectionBanner
          tone="danger"
          testId="tenant-deleted"
          action={
            <Button variant="secondary" size="xs" onClick={() => setScope({ kind: 'project' })}>
              Show project users
            </Button>
          }
        >
          Tenant <span className="font-mono text-[0.9em]">{tenant}</span> was deleted.
        </SectionBanner>
      )}
      <SectionBody testId="users-body">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {tenantState === 'missing' || tenantState === 'deleted' ? (
            <EmptyState
              icon={BuildingsIcon}
              title={tenantState === 'deleted' ? 'Its users went with it' : 'No users to list'}
              description={
                tenantState === 'deleted'
                  ? 'Deleting a tenant removes its users; no user.delete events fire.'
                  : 'Pick a tenant from the Tenant list, or create this one in Settings.'
              }
              testId="users-no-tenant"
            />
          ) : (
            <UsersGrid
              rows={rows}
              loading={firstLoading}
              error={query.error}
              onRetry={() => void query.refetch()}
              q={q}
              onClearFilter={() => setFilter('', 'now')}
              scope={scope}
              project={project}
              foreign={foreign}
              tenants={tenants.data}
              scopeTotal={figures.data?.scopeTotal}
              total={figures.data?.total}
              sort={sort}
              onSortChange={(next) => {
                const chosen = nextUsersSort(sort, next, fallbackSort)
                update({
                  sort: printSort(chosen) === USERS_DEFAULTS.sort ? undefined : printSort(chosen),
                })
              }}
              sortable={meta.data?.sortable ?? []}
              pinned={!unfrozen}
              openUid={search.user}
              onOpen={open}
              rowMenu={rowMenu}
              flashes={flashes}
              onScope={setScope}
            />
          )}
        </div>
        {search.user !== undefined && project !== '' && (
          <UserInspector
            key={`${project}|${slot}|${search.user}`}
            project={project}
            scope={scope}
            uid={search.user}
            tab={search.tab ?? 'details'}
            onTab={(tab) => update({ tab: tab === 'details' ? undefined : tab }, { replace: true })}
            onClose={() => update({ user: undefined, tab: undefined })}
            onPrev={step(-1)}
            onNext={step(1)}
            blocked={blocked}
            onDelete={(row) => {
              remove.reset()
              setDeleting(row)
            }}
            onSeen={(label) => recordRecent({ tenant: slot, uid: search.user ?? '', label })}
          />
        )}
      </SectionBody>
      <DangerConfirm
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null)
        }}
        title={`Delete ${deleting ? identifierOf(deleting).text : 'this user'}`}
        description={
          deleting ? (
            <>
              Deletes the account <span className="font-mono text-[0.9em]">{deleting.uid}</span> as{' '}
              <span className="font-mono text-[0.9em]">deleteUser()</span> does.
            </>
          ) : (
            ''
          )
        }
        triggers={{ answer: deleteTriggers, times: 1 }}
        consequences={['Re-import an export to get it back.']}
        pending={remove.isPending}
        {...(remove.isError ? { error: refusal(remove.error) } : {})}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting)
        }}
        testId="delete-user"
      />
    </SectionPage>
  )
}

/** The users opened lately in this scope, newest first, in the data face. */
function RecentUsers({
  recents,
  openUid,
  onOpen,
}: {
  recents: readonly RecentUser[]
  openUid: string | undefined
  onOpen: (recent: RecentUser) => void
}) {
  if (recents.length === 0) return null
  return (
    <div className="mt-4 grid gap-0.5" role="group" aria-label="Recent" data-testid="recent-users">
      <span className="px-2 pb-0.5 text-[11px] text-kumo-subtle">Recent</span>
      {recents.map((recent) => (
        <button
          key={`${recent.tenant}|${recent.uid}`}
          type="button"
          onClick={() => onOpen(recent)}
          className={`flex h-7 w-full min-w-0 items-center rounded-md px-2 text-left hover:ink ${
            openUid === recent.uid ? 'bg-kumo-tint' : ''
          }`}
          title={recent.uid}
          data-testid="recent-user"
        >
          <span className="min-w-0 truncate font-mono text-[12px] text-kumo-default">
            {recent.label}
          </span>
        </button>
      ))}
    </div>
  )
}
