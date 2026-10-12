// Export users (`?dialog=export`): the foundation's ExportDialog in its
// `href` mode — the engine streams the file from one snapshot and the
// browser's own download manager saves it, so nothing is assembled in the
// page. What it holds is chosen here: this filter, the ticked users (at most
// 500 by uid; more is "Select all matching", which exports by the filter),
// or every user of the tenant.

import { Tabs } from '@cloudflare/kumo'
import { useState } from 'react'
import type { Total } from '@/api/generated/Total'
import { ExportDialog } from '@/components/console/export-dialog'
import { formatNumber } from '@/lib/format'
import { type ExportScope, SELECTED_EXPORT_MAX, exportFilename, exportHref } from '../export'

/** A choice's count, when known: " (1,204)". */
function count(value: number | undefined): string {
  return value === undefined ? '' : ` (${formatNumber(value)})`
}

export function ExportUsersDialog({
  open,
  onOpenChange,
  project,
  tenant,
  q,
  total,
  scopeTotal,
  selected,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: string
  tenant: string | undefined
  q: string
  /** What the filter matches. */
  total: Total | undefined
  /** Every user of the tenant (or the project's). */
  scopeTotal: number | undefined
  /** The ticked uids. */
  selected: readonly string[]
}) {
  const filtered = q.trim() !== ''
  const canSelected = selected.length > 0 && selected.length <= SELECTED_EXPORT_MAX
  const [scope, setScope] = useState<ExportScope>(
    canSelected ? 'selected' : filtered ? 'filter' : 'all',
  )
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setScope(canSelected ? 'selected' : filtered ? 'filter' : 'all')
  }
  const chosen: ExportScope =
    scope === 'selected' && !canSelected ? (filtered ? 'filter' : 'all') : scope
  const where = tenant ? `tenant ${tenant}` : 'the project’s users'
  const tabs = [
    ...(filtered ? [{ value: 'filter', label: `This filter${count(total?.count)}` }] : []),
    { value: 'selected', label: `Selected${count(selected.length)}` },
    {
      value: 'all',
      label: `All users in ${tenant ? `tenant ${tenant}` : 'the project'}${count(scopeTotal)}`,
    },
  ]
  return (
    <ExportDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Export users"
      scope={
        <span className="grid gap-3">
          <Tabs
            size="sm"
            variant="segmented"
            value={chosen}
            onValueChange={(value) => {
              if (value === 'selected' && !canSelected) return
              setScope(value as ExportScope)
            }}
            tabs={tabs}
          />
          {!canSelected && selected.length > SELECTED_EXPORT_MAX && (
            <span className="text-[12px] text-kumo-subtle" data-testid="export-too-many">
              Export more than 500 users with This filter, or Select all matching.
            </span>
          )}
          <span className="text-[13px] text-kumo-subtle" data-testid="export-users-scope">
            {chosen === 'selected'
              ? `The ${formatNumber(selected.length)} ticked ${selected.length === 1 ? 'user' : 'users'} of ${where}.`
              : chosen === 'filter'
                ? `Every user of ${where} that ${q.trim()} matches.`
                : `Every user of ${where}.`}{' '}
            JSON is the emulator’s accounts.json, password hashes included: it loads back here and
            with --import. CSV is for a spreadsheet and carries no hashes.
          </span>
        </span>
      }
      formats={['json', 'csv']}
      filename={(format) => exportFilename(project, tenant, format === 'csv' ? 'csv' : 'json')}
      href={(format) =>
        exportHref({
          project,
          tenant,
          format: format === 'csv' ? 'csv' : 'json',
          scope: chosen,
          q,
          selected,
        })
      }
      testId="export-users"
    />
  )
}
