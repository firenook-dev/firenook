// The functions an instance adds: each resource of its spec with the
// function the emulator loaded for it (a link into Functions), how it is
// triggered, whether it receives anything and why not, and how often it
// ran and failed. The figures stay current: they are read from the
// Functions snapshot, which `functions.events` patches for this instance's
// codebase while the tab is open.

import { Tooltip } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import type { ExtensionFunction } from '@/api/generated/compute/ExtensionFunction'
import type { ExtensionInstanceDetail } from '@/api/generated/compute/ExtensionInstanceDetail'
import type { FunctionStats } from '@/api/generated/compute/FunctionStats'
import { EntityLink } from '@/components/console/entity-link'
import { DurationText } from '@/compute/duration-text'
import { KindBadge } from '@/compute/kind-badge'
import { StatusDot } from '@/components/kit'
import { STATUS_WORDS } from '@/compute/function-status'
import { functionsSnapshotQuery } from '@/functions/api'
import { useFunctionsEvents } from '@/functions/live'
import { formatNumber } from '@/lib/format'

/** The grid every row shares, so the columns line up without a table. */
const ROW = 'grid grid-cols-[minmax(0,1.4fr)_88px_minmax(0,1fr)_64px_64px_72px] items-start gap-x-4'

export function FunctionsTab({
  project,
  detail,
}: {
  project: string
  detail: ExtensionInstanceDetail
}) {
  const instance = detail.summary.instanceId
  const snapshot = useQuery(functionsSnapshotQuery(project))
  // The instance's own invocations patch the snapshot's figures; the
  // reload toast is the toolbar's to raise here, not the topic's.
  useFunctionsEvents(snapshot.data ? { codebase: instance } : null, {
    after: snapshot.data?.liveCursor,
    toasts: false,
  })
  const live = new Map(snapshot.data?.functions.map((summary) => [summary.id, summary.stats]))
  const rows = detail.functions
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-kumo-base" data-testid="instance-functions">
      <div className="grid max-w-5xl gap-3 px-6 py-5">
        <div className="flex items-baseline gap-3">
          <h2 className="m-0 text-[16px] leading-6 font-semibold text-kumo-default">Functions</h2>
          <span className="text-[13px] text-kumo-subtle">
            {rows.length === 0 ? (
              'This extension adds none.'
            ) : (
              <>
                {formatNumber(rows.length)} in its spec, named{' '}
                <span className="font-mono text-[12px]">ext-{instance}-&lt;resource&gt;</span> in
                Functions.
              </>
            )}
          </span>
        </div>
        {rows.length > 0 && (
          <div className="grid" role="table" aria-label={`Functions of ${instance}`}>
            <div
              className={`${ROW} border-b border-kumo-line pb-1.5 text-[12px] text-kumo-subtle`}
              role="row"
            >
              <span role="columnheader">Resource</span>
              <span role="columnheader">Kind</span>
              <span role="columnheader">Status</span>
              <span role="columnheader" className="text-right">
                Runs
              </span>
              <span role="columnheader" className="text-right">
                Errors
              </span>
              <span role="columnheader" className="text-right">
                p95
              </span>
            </div>
            {rows.map((row) => (
              <FunctionRow
                key={`${row.resource}:${row.functionId ?? ''}`}
                row={row}
                stats={(row.functionId ? live.get(row.functionId) : undefined) ?? row.stats}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function FunctionRow({ row, stats }: { row: ExtensionFunction; stats: FunctionStats | null }) {
  const status = STATUS_WORDS[row.status]
  return (
    <div
      className={`${ROW} border-b border-kumo-hairline py-2.5 last:border-b-0`}
      role="row"
      data-testid="extension-function"
      data-resource={row.resource}
      data-status={row.status}
    >
      <span className="grid min-w-0 gap-0.5" role="cell">
        <span className="truncate font-mono text-[12px] text-kumo-default">{row.resource}</span>
        {row.function ? (
          <EntityLink entity={row.function} testId="extension-function-link" />
        ) : (
          <span className="text-[12px] text-kumo-subtle">Not loaded</span>
        )}
        {row.description && <span className="text-[12px] text-kumo-subtle">{row.description}</span>}
      </span>
      <span role="cell" className="pt-px">
        <KindBadge kind={row.kind} />
      </span>
      <span className="grid min-w-0 gap-0.5" role="cell">
        <StatusDot tone={status.tone} label={status.word} />
        {row.ignoredReason && (
          <span className="text-[12px] text-kumo-subtle" data-testid="extension-function-reason">
            {row.ignoredReason}
          </span>
        )}
      </span>
      <span
        role="cell"
        className="text-right font-mono text-[12px] text-kumo-default tabular-nums"
        data-testid="extension-function-runs"
      >
        {stats ? formatNumber(stats.runs) : '–'}
      </span>
      <span
        role="cell"
        className={`text-right font-mono text-[12px] tabular-nums ${
          stats && stats.failures > 0 ? 'text-kumo-danger' : 'text-kumo-default'
        }`}
      >
        {stats ? formatNumber(stats.failures) : '–'}
      </span>
      <span role="cell" className="text-right">
        <Tooltip
          content="The slowest 5 % of the last 256 calls took at least this long."
          render={
            <span>
              <DurationText ms={stats?.p95Ms ?? null} />
            </span>
          }
        />
      </span>
    </div>
  )
}
