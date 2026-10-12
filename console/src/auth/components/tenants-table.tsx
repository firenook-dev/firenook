// The project's tenants on Settings: id, display name, users, the sign-in
// methods each allows and its multi-factor state, read a page at a time by
// the engine in id order (`GET /auth/tenants`, never creating one), each
// row patched in place when `auth.config` names its tenant
// (`POST /auth/tenants:batchGet`). A filter appears once there are more
// than 20. A row opens its edit dialog; its menu also deletes it.

import { Empty } from '@cloudflare/kumo'
import {
  BuildingsIcon,
  PencilSimpleIcon,
  SlidersHorizontalIcon,
  TrashIcon,
  UsersIcon,
} from '@phosphor-icons/react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { AuthTenant } from '@/api/generated/auth/AuthTenant'
import { DataTable, type DataTableColumn } from '@/components/console/data-table'
import { NoMatch } from '@/components/console/empty-state'
import { PanelFilter } from '@/components/console/panel'
import type { RowMenuItem } from '@/components/console/row-menu'
import { cursorPagesOptions, useCursorRows } from '@/components/console/use-cursor-rows'
import { formatNumber } from '@/lib/format'
import { useConfigLive } from '../live'
import { tenantsList } from '../queries'
import { MFA_STATE_LABELS, type MfaState, signInSummary } from '../tenants'

/** Tenants listed before the table offers a filter. */
const FILTER_ABOVE = 20
/** Rows the table shows before it scrolls. */
const VISIBLE_ROWS = 10
const ROW = 32
const HEAD = 33

/** The table's columns: the id pinned, the counts at the end. */
const COLUMNS: DataTableColumn<AuthTenant>[] = [
  {
    id: 'tenantId',
    header: 'Tenant id',
    width: 200,
    pinned: true,
    sortable: false,
    cell: (tenant) => <span className="font-mono">{tenant.tenantId}</span>,
  },
  {
    id: 'displayName',
    header: 'Display name',
    width: 180,
    cell: (tenant) =>
      tenant.displayName ? (
        <span className="font-mono">{tenant.displayName}</span>
      ) : (
        <span className="text-kumo-subtle">—</span>
      ),
    copy: (tenant) => tenant.displayName ?? '',
  },
  {
    id: 'users',
    header: 'Users',
    width: 80,
    align: 'end',
    cell: (tenant) => <span className="font-mono tabular-nums">{formatNumber(tenant.users)}</span>,
    copy: (tenant) => String(tenant.users),
  },
  {
    id: 'signIn',
    header: 'Sign-in',
    width: 240,
    cell: (tenant) => <span className="font-sans text-kumo-subtle">{signInSummary(tenant)}</span>,
    copy: (tenant) => signInSummary(tenant),
  },
  {
    id: 'mfa',
    header: 'MFA',
    width: 96,
    cell: (tenant) => (
      <span className="font-sans">
        {MFA_STATE_LABELS[tenant.mfaState as MfaState] ?? tenant.mfaState}
      </span>
    ),
    copy: (tenant) => tenant.mfaState,
  },
]

export function TenantsTable({
  project,
  onEdit,
  onDelete,
  onShowSettings,
  onShowUsers,
  onCount,
}: {
  project: string
  onEdit: (tenant: AuthTenant) => void
  onDelete: (tenant: AuthTenant) => void
  /** Shows the tenant in the Sign-in behaviour card. */
  onShowSettings: (tenant: AuthTenant) => void
  onShowUsers: (tenant: AuthTenant) => void
  /** How many tenants there are, for the section's heading. */
  onCount: (count: number | undefined) => void
}) {
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(text.trim()), 200)
    return () => window.clearTimeout(timer)
  }, [text])
  const list = tenantsList(project, q)
  const query = useInfiniteQuery({
    ...cursorPagesOptions(list.queryKey, list.fetchPage),
    enabled: project !== '',
  })
  const rows = useCursorRows(query, {
    queryKey: list.queryKey,
    fetchPage: list.fetchPage,
    rowKey: list.rowKey,
    batchGet: list.batchGet,
    q,
  })
  useConfigLive(project, {
    onChanged: (change) => {
      if (change.tenant) rows.applyKeys([change.tenant])
    },
    onReset: () => rows.reset(),
  })
  const total = rows.total?.count
  useEffect(() => {
    if (q === '') onCount(total)
  }, [q, total, onCount])

  const menu = (tenant: AuthTenant): RowMenuItem[] => [
    {
      id: 'edit',
      label: 'Edit…',
      icon: PencilSimpleIcon,
      shortcut: 'Enter',
      run: () => onEdit(tenant),
    },
    {
      id: 'settings',
      label: 'Show its sign-in settings',
      icon: SlidersHorizontalIcon,
      run: () => onShowSettings(tenant),
    },
    { id: 'users', label: 'Open its users', icon: UsersIcon, run: () => onShowUsers(tenant) },
    { id: 'delete', label: 'Delete…', icon: TrashIcon, danger: true, run: () => onDelete(tenant) },
  ]
  const shown = Math.max(1, Math.min(rows.rows.length, VISIBLE_ROWS))
  const filtering = (total ?? 0) > FILTER_ABOVE || q !== '' || text !== ''
  return (
    <div className="grid gap-2" data-testid="tenants-table">
      {filtering && (
        <div className="w-72">
          <PanelFilter
            value={text}
            onChange={setText}
            placeholder="Filter tenants by id or name"
            testId="tenants-filter"
          />
        </div>
      )}
      <div
        className="flex min-h-0 flex-col overflow-hidden rounded-lg ring ring-kumo-line"
        // The rows the table holds, up to ten: a document page, not a workbench.
        style={{ height: rows.rows.length === 0 ? undefined : HEAD + shown * ROW + 2 }}
      >
        <DataTable
          ariaLabel="Tenants"
          rows={rows.rows}
          rowKey={list.rowKey}
          columns={COLUMNS}
          memoryKey="auth.tenants"
          onOpen={onEdit}
          rowMenu={menu}
          flashes={rows.flashes}
          hasMore={rows.hasMore}
          loadMore={rows.loadMore}
          hasPrevious={rows.hasPrevious}
          loadPrevious={rows.loadPrevious}
          rowOffset={rows.rowOffset}
          total={rows.total}
          loading={query.isPending && project !== ''}
          keyboard="focus"
          empty={
            q !== '' ? (
              <NoMatch filter={q} noun="tenants" onClear={() => setText('')} />
            ) : (
              <div className="py-2" data-testid="tenants-empty">
                <Empty
                  size="sm"
                  icon={<BuildingsIcon size={32} className="text-kumo-inactive" />}
                  title="No tenants"
                  description="A tenant keeps its users apart from the project’s own, with sign-in methods of its own."
                />
              </div>
            )
          }
          testId="tenants-grid"
        />
      </div>
    </div>
  )
}
