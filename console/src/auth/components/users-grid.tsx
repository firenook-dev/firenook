// The users table: the foundation's `DataTable` over the engine's pages,
// 32 px rows, the User column pinned, a sliding window of at most twenty
// pages fetched as the reader scrolls, and the rows the live channel names
// patched where they stand (`useUsersLive`). The engine sorts, filters and
// counts; this draws.
//
// What the body says when there is nothing to draw is the honest state:
// the filter matches nothing; this tenant is empty but others are not (and
// where the users are); nothing anywhere yet (with the connection snippet
// for the app); or the engine refused the request, in its own words.

import { UsersIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import type { Total } from '@/api/generated/Total'
import type { AuthTenantList } from '@/api/generated/auth/AuthTenantList'
import type { AuthUserRow } from '@/api/generated/auth/AuthUserRow'
import {
  DataTable,
  type DataTableSort,
  useHiddenColumnCount,
} from '@/components/console/data-table'
import { EmptyState, NoMatch, QueryError } from '@/components/console/empty-state'
import type { RowMenuItem } from '@/components/console/row-menu'
import { TableFooter } from '@/components/console/table-footer'
import type { CursorRows } from '@/components/console/use-cursor-rows'
import { formatCount } from '@/lib/format'
import type { TenantScope } from '../tenant-scope'
import { userColumns } from './user-cells'

/** Where the table's dragged widths and hidden columns are remembered. */
export const USERS_MEMORY = 'auth.users'

const USERS = { one: 'user', other: 'users' }

/** Other scopes that hold users, for the empty tenant's "where are they" line. */
export function usersElsewhere(
  scope: TenantScope,
  tenants: Pick<AuthTenantList, 'items' | 'projectUsers'> | undefined,
): { scope: TenantScope; label: string; users: number }[] {
  if (!tenants) return []
  const found: { scope: TenantScope; label: string; users: number }[] = []
  if (scope.kind !== 'project' && tenants.projectUsers > 0)
    found.push({
      scope: { kind: 'project' },
      label: 'Project users',
      users: tenants.projectUsers,
    })
  for (const tenant of tenants.items)
    if (tenant.users > 0 && !(scope.kind === 'tenant' && scope.tenant === tenant.tenantId))
      found.push({
        scope: { kind: 'tenant', tenant: tenant.tenantId },
        label: tenant.tenantId,
        users: tenant.users,
      })
  return found
}

export function UsersGrid({
  rows,
  loading,
  error,
  onRetry,
  q,
  onClearFilter,
  scope,
  project,
  foreign,
  tenants,
  scopeTotal,
  total,
  sort,
  onSortChange,
  sortable,
  pinned,
  openUid,
  onOpen,
  rowMenu,
  flashes,
  selection,
  emptyActions,
  footerActions,
  onScope,
}: {
  rows: CursorRows<AuthUserRow>
  loading: boolean
  error: unknown
  onRetry: () => void
  q: string
  onClearFilter: () => void
  scope: TenantScope
  project: string
  /** The page shows another project than the emulator's (`?project=`). */
  foreign: boolean
  tenants: AuthTenantList | undefined
  /** Users in this scope whatever the filter (from the figures). */
  scopeTotal: number | undefined
  total: Total | undefined
  sort: DataTableSort
  onSortChange: (sort: DataTableSort | undefined) => void
  sortable: readonly string[]
  pinned: boolean
  openUid: string | undefined
  onOpen: (row: AuthUserRow) => void
  rowMenu: (row: AuthUserRow) => readonly RowMenuItem[]
  flashes: ReadonlyMap<string, 'created' | 'updated' | 'deleted'>
  selection?:
    | {
        checked: ReadonlySet<string>
        everything: boolean
        onChange: (checked: Set<string>, everything: boolean) => void
      }
    | undefined
  /** What an empty scope offers (New user, Sample users, Import). */
  emptyActions?: ReactNode
  /** The footer's right end: Export. */
  footerActions?: ReactNode
  onScope: (scope: TenantScope) => void
}) {
  const columns = userColumns({ sortable, pinned })
  const hidden = useHiddenColumnCount(USERS_MEMORY, columns)
  const elsewhere = usersElsewhere(scope, tenants)

  const empty = (() => {
    if (error) return <QueryError error={error} onRetry={onRetry} section="auth" />
    if (q.trim() !== '') return <NoMatch filter={q} onClear={onClearFilter} noun="users" />
    if ((scopeTotal ?? 0) === 0 && elsewhere.length > 0)
      return (
        <EmptyState
          icon={UsersIcon}
          title={
            scope.kind === 'tenant'
              ? `No users in tenant ${scope.tenant} yet`
              : 'No project users yet'
          }
          description="Users appear here when your app signs someone up in this scope."
          actions={
            <div className="grid justify-items-center gap-3">
              <p
                className="max-w-[520px] text-[13px] text-kumo-subtle"
                data-testid="users-elsewhere"
              >
                {elsewhere.map((entry, index) => (
                  <span key={entry.label}>
                    {index > 0 && ' · '}
                    <button
                      type="button"
                      onClick={() => onScope(entry.scope)}
                      className="rounded-sm font-mono text-[0.9em] text-kumo-link underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:outline-none"
                      data-testid="users-elsewhere-link"
                    >
                      {entry.label}
                    </button>{' '}
                    has {formatCount(entry.users, USERS)}
                  </span>
                ))}
              </p>
              {emptyActions && (
                <div className="flex flex-wrap justify-center gap-2">{emptyActions}</div>
              )}
            </div>
          }
          testId="users-empty"
        />
      )
    return (
      <EmptyState
        icon={UsersIcon}
        title="No users yet"
        description="Users appear when your app signs someone up. You can also add one here."
        connect={{ service: 'auth', project: foreign ? project : undefined }}
        actions={emptyActions}
        testId="users-empty"
      />
    )
  })()

  return (
    <DataTable<AuthUserRow>
      ariaLabel="Users"
      rows={rows.rows}
      rowKey={(row) => row.uid}
      columns={columns}
      memoryKey={USERS_MEMORY}
      sort={sort}
      onSortChange={onSortChange}
      selection={selection}
      openKey={openUid}
      onOpen={onOpen}
      rowClick="open"
      onCursorChange={(row) => {
        if (openUid !== undefined && row.uid !== openUid) onOpen(row)
      }}
      flashes={flashes}
      hasMore={rows.hasMore}
      loadMore={rows.loadMore}
      hasPrevious={rows.hasPrevious}
      loadPrevious={rows.loadPrevious}
      anchor="key"
      rowMenu={rowMenu}
      rowOffset={rows.rowOffset}
      total={total}
      loading={loading}
      empty={empty}
      footer={
        <TableFooter
          loaded={rows.rows.length}
          rowOffset={rows.rowOffset}
          total={total}
          hasMore={rows.hasMore}
          hiddenColumns={hidden.hidden}
          onShowAll={hidden.showAll}
          noun={USERS}
          actions={footerActions}
        />
      }
      testId="users-grid"
    />
  )
}
