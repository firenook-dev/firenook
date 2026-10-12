// Every function of every codebase in one table — the dashboard the
// Firebase console has, with numbers that mean something locally: kind,
// trigger in words, codebase, when it last ran, runs, errors and p95 over
// the engine's retained window. A function that receives nothing says why
// in its trigger cell, in the warning tone, instead of looking healthy; the
// functions the emulator dropped at load are listed too, last.
//
// The snapshot holds every function, so the order and the filter are
// applied here; the figures arrive live (the page's `functions.events`
// subscription replaces each function's stats as invocations finish).

import { Tooltip, cn } from '@cloudflare/kumo'
import { LightningIcon } from '@phosphor-icons/react'
import type { FunctionsSnapshot } from '@/api/generated/compute/FunctionsSnapshot'
import {
  DataTable,
  type DataTableColumn,
  type DataTableSort,
} from '@/components/console/data-table'
import { EmptyState, NoMatch } from '@/components/console/empty-state'
import { invocationChip } from '@/components/console/outcome-chip'
import { RelativeTime, exactTime } from '@/components/console/relative-time'
import type { RowMenuItem } from '@/components/console/row-menu'
import { KindBadge } from '@/compute/kind-badge'
import { DurationText } from '@/compute/duration-text'
import { formatNumber } from '@/lib/format'
import { type OverviewRow, filterOverview, overviewRows } from '../filters'
import { chipStatus } from '../kinds'
import { notLoadedText, statusText, triggerText } from '../trigger-text'

const MEMORY_KEY = 'functions.overview'

/** The problem a row's trigger cell says instead of its trigger, and its tone. */
function problemOf(row: OverviewRow): { text: string; tone: 'warning' | 'subtle' } | undefined {
  if (row.kind === 'notLoaded') return { text: notLoadedText(row.entry), tone: 'warning' }
  const summary = row.summary
  if (summary.status === 'receiving') return undefined
  return { text: statusText(summary), tone: summary.status === 'removed' ? 'subtle' : 'warning' }
}

function nameOf(row: OverviewRow): string {
  return row.kind === 'notLoaded' ? row.name : row.summary.name
}

function regionOf(row: OverviewRow): string {
  return row.kind === 'notLoaded' ? row.region : row.summary.region
}

function codebaseOf(row: OverviewRow): string {
  return row.kind === 'notLoaded' ? row.codebase : row.summary.codebase
}

/** A sortable value per column; not-loaded rows have none and sort last. */
function sortValue(row: OverviewRow, column: string): string | number | undefined {
  if (column === 'name') return nameOf(row).toLowerCase()
  if (column === 'codebase') return codebaseOf(row)
  if (row.kind === 'notLoaded') return undefined
  const { summary } = row
  switch (column) {
    case 'kind':
      return summary.kind
    case 'trigger':
      return (problemOf(row)?.text ?? triggerText(summary)).toLowerCase()
    case 'lastRun':
      return summary.stats.last ? Date.parse(summary.stats.last.startedAt) : undefined
    case 'runs':
      return summary.stats.runs
    case 'errors':
      return summary.stats.failures
    case 'p95':
      return summary.stats.p95Ms ?? undefined
    default:
      return undefined
  }
}

/** The overview's order: by `sort` (name ascending by default), not-loaded rows always last. */
export function sortOverview(
  rows: readonly OverviewRow[],
  sort: DataTableSort | undefined,
): OverviewRow[] {
  const { column, direction } = sort ?? { column: 'name', direction: 'asc' as const }
  const sign = direction === 'asc' ? 1 : -1
  return rows.toSorted((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'notLoaded' ? 1 : -1
    const left = sortValue(a, column)
    const right = sortValue(b, column)
    if (left === undefined && right === undefined) return nameOf(a).localeCompare(nameOf(b))
    if (left === undefined) return 1
    if (right === undefined) return -1
    if (left === right) return nameOf(a).localeCompare(nameOf(b))
    return (left < right ? -1 : 1) * sign
  })
}

function figure(value: number | null | undefined, danger = false) {
  if (value === null || value === undefined || value === 0)
    return <span className="text-[11px] text-kumo-inactive">–</span>
  return (
    <span
      className={cn('text-[11px] tabular-nums', danger ? 'text-kumo-danger' : 'text-kumo-default')}
    >
      {formatNumber(value)}
    </span>
  )
}

/**
 * Default widths: 880 px in all, so with the check cell (44) and the column
 * menu (40) the table fits the page beside the open panel at 1440 px, with
 * room left for a classic scrollbar, and every header reads whole (a header
 * takes about 35 px for its padding and sort arrow).
 */
const COLUMNS: readonly DataTableColumn<OverviewRow>[] = [
  {
    id: 'name',
    header: 'Function',
    width: 208,
    pinned: true,
    sortable: true,
    copy: (row) => (row.kind === 'notLoaded' ? row.entry.id : row.summary.id),
    cell: (row) => {
      const problem = problemOf(row)
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          {problem && (
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                problem.tone === 'warning' ? 'bg-kumo-warning' : 'bg-kumo-interact',
              )}
              aria-label={problem.text}
              data-testid="overview-problem"
            />
          )}
          <span className="truncate text-kumo-default">{nameOf(row)}</span>
          <span className="shrink-0 text-[11px] text-kumo-subtle">{regionOf(row)}</span>
        </span>
      )
    },
  },
  {
    id: 'kind',
    header: 'Kind',
    width: 84,
    sortable: true,
    cell: (row) =>
      row.kind === 'notLoaded' ? (
        <span className="text-[11px] text-kumo-inactive">–</span>
      ) : (
        <KindBadge kind={row.summary.kind} />
      ),
  },
  {
    id: 'trigger',
    header: 'Trigger',
    width: 200,
    sortable: true,
    copy: (row) => (row.kind === 'notLoaded' ? row.entry.eventType : triggerText(row.summary)),
    cell: (row) => {
      const problem = problemOf(row)
      const text = problem?.text ?? (row.kind === 'function' ? triggerText(row.summary) : '')
      const whole =
        row.kind === 'function' && problem ? `${triggerText(row.summary)} — ${problem.text}` : text
      return (
        <Tooltip
          content={whole}
          render={
            <span
              className={cn(
                'block min-w-0 truncate',
                problem?.tone === 'warning'
                  ? 'font-sans text-[12px] text-kumo-warning'
                  : problem
                    ? 'font-sans text-[12px] text-kumo-subtle'
                    : 'text-kumo-default',
              )}
              data-testid="overview-trigger"
            >
              {text}
            </span>
          }
        />
      )
    },
  },
  {
    id: 'codebase',
    header: 'Codebase',
    width: 96,
    sortable: true,
    cell: (row) => {
      const extension = row.kind === 'function' && row.summary.extensionInstance !== null
      return (
        <span className="flex min-w-0 items-baseline gap-1">
          {extension && <span className="font-sans text-[11px] text-kumo-subtle">ext</span>}
          <span className="truncate">{codebaseOf(row)}</span>
        </span>
      )
    },
  },
  {
    id: 'lastRun',
    header: 'Last run',
    width: 88,
    sortable: true,
    copy: (row) => (row.kind === 'function' ? (row.summary.stats.last?.startedAt ?? '') : ''),
    cell: (row) => {
      const last = row.kind === 'function' ? row.summary.stats.last : null
      if (!last) return <span className="font-sans text-[12px] text-kumo-inactive">–</span>
      const chip = invocationChip({
        outcome: last.outcome,
        status: chipStatus(last),
        callableStatus: last.callableStatus ?? undefined,
      })
      return (
        <Tooltip
          content={`${exactTime(last.startedAt)} · ${chip.word}`}
          render={
            <span className="block min-w-0 truncate">
              <RelativeTime iso={last.startedAt} className="text-kumo-default" />
            </span>
          }
        />
      )
    },
  },
  {
    id: 'runs',
    header: 'Runs',
    width: 68,
    align: 'end',
    sortable: true,
    cell: (row) => figure(row.kind === 'function' ? row.summary.stats.runs : undefined),
  },
  {
    id: 'errors',
    header: 'Errors',
    width: 72,
    align: 'end',
    sortable: true,
    cell: (row) => figure(row.kind === 'function' ? row.summary.stats.failures : undefined, true),
  },
  {
    id: 'p95',
    header: 'p95',
    width: 64,
    align: 'end',
    sortable: true,
    cell: (row) =>
      row.kind === 'function' && row.summary.stats.p95Ms !== null ? (
        <DurationText ms={row.summary.stats.p95Ms} />
      ) : (
        <span className="text-[11px] text-kumo-inactive">–</span>
      ),
  },
]

export function FunctionsOverview({
  snapshot,
  q,
  sort,
  onSortChange,
  onClearFilter,
  onOpen,
  rowMenu,
}: {
  snapshot: FunctionsSnapshot
  q: string
  sort: DataTableSort | undefined
  onSortChange: (sort: DataTableSort | undefined) => void
  onClearFilter: () => void
  onOpen: (row: OverviewRow) => void
  rowMenu: (row: OverviewRow) => readonly RowMenuItem[]
}) {
  const all = overviewRows(snapshot)
  const rows = sortOverview(filterOverview(all, q), sort)
  return (
    <DataTable
      ariaLabel="Functions"
      rows={rows}
      rowKey={(row) => row.key}
      columns={COLUMNS}
      memoryKey={MEMORY_KEY}
      sort={sort}
      onSortChange={onSortChange}
      onOpen={onOpen}
      rowClick="open"
      rowMenu={rowMenu}
      total={{ count: rows.length, exact: true }}
      empty={
        all.length === 0 ? (
          <EmptyState
            icon={LightningIcon}
            title="No functions are loaded"
            description={
              snapshot.codebases.length === 0
                ? 'firebase.json configures no Functions codebase. Add one and the functions it exports appear here as soon as they load.'
                : 'No codebase exports a function the emulator loaded. A codebase that failed says why in the panel.'
            }
            testId="functions-empty"
          />
        ) : (
          <NoMatch filter={q} onClear={onClearFilter} noun="functions" />
        )
      }
      testId="functions-overview"
    />
  )
}

/** The overview's count: every row the filter keeps. */
export function overviewCount(snapshot: FunctionsSnapshot, q: string): number {
  return filterOverview(overviewRows(snapshot), q).length
}
