// The queue's History tab (TK-60, TK-61, S21): every task that left the
// queue — succeeded, failed, cancelled, deleted, purged or replaced — newest
// first, with its attempts, last answer, how long it took and its payload.
// It only grows at the head: a `finished` event reads the head page again
// while the reader is at the top, and counts what came in above while they
// are not. History lives beside the queue, so a re-registration keeps it.

import { Tooltip } from '@cloudflare/kumo'
import {
  ArrowCounterClockwiseIcon,
  CodeIcon,
  CopyIcon,
  PencilSimpleIcon,
  SidebarSimpleIcon,
  ClockCounterClockwiseIcon,
} from '@phosphor-icons/react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import type { TasksHistoryRow } from '@/api/generated/messaging/TasksHistoryRow'
import type { TasksOutcome } from '@/api/generated/messaging/TasksOutcome'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import { statusQuery } from '@/api/queries'
import {
  DataTable,
  type DataTableColumn,
  useHiddenColumnCount,
} from '@/components/console/data-table'
import { EmptyState, NoMatch, QueryError } from '@/components/console/empty-state'
import { OutcomeChip } from '@/components/console/outcome-chip'
import { serviceAddress } from '@/components/console/request/address'
import { RelativeTime } from '@/components/console/relative-time'
import type { RowMenuItem } from '@/components/console/row-menu'
import { SectionBody } from '@/components/console/section-page'
import { TableFooter } from '@/components/console/table-footer'
import { SectionToolbar } from '@/components/console/toolbar'
import { useCursorRows } from '@/components/console/use-cursor-rows'
import { copyToClipboard } from '@/lib/copy'
import { formatBytes, formatDuration, formatNumber } from '@/lib/format'
import { useShortcuts } from '@/lib/shortcuts'
import { toast } from '@/lib/toasts'
import { taskAsCode } from '../code'
import { historyList, taskQuery } from '../queries'
import { readStarted } from '@/lib/live/use-live-topic'
import { useQueueListener } from '../queue-live'
import { displayName, generatedDetail, outcomeChip } from '../states'
import { FilterLine, useTaskFields, usableQuery } from './filter-line'
import type { TaskActions } from './task-actions'
import { rowElement } from '@/components/console/confirm-popover'
import { PayloadCell } from './task-table'
import { ResultChip } from './result-chip'

const NOUN = { one: 'finished task', other: 'finished tasks' }
const TABLE = 'history-table'

/** A history row's name: generated ones shortened, with the full name in the tooltip. */
function NameCell({ row }: { row: TasksHistoryRow }) {
  const generated = row.name.startsWith('/')
  if (!generated) return <span className="truncate">{row.shortName}</span>
  return (
    <Tooltip
      content={generatedDetail(row.name)}
      render={
        <span className="cursor-default truncate text-kumo-subtle">
          {displayName({ generated, shortName: row.shortName })}
        </span>
      }
    />
  )
}

/** A finished task as the actions name it. */
function subject(row: TasksHistoryRow) {
  const generated = row.name.startsWith('/')
  return { id: row.taskId, label: displayName({ generated, shortName: row.shortName }), generated }
}

const COLUMNS: DataTableColumn<TasksHistoryRow>[] = [
  {
    id: 'outcome',
    header: 'Outcome',
    width: 110,
    cell: (row) => {
      const chip = outcomeChip(row.outcome)
      return (
        <span className="font-sans">
          <OutcomeChip
            word={chip.word}
            tone={chip.tone}
            detail={chip.detail}
            testId="history-outcome"
          />
        </span>
      )
    },
  },
  {
    id: 'name',
    header: 'Name',
    width: 170,
    cell: (row) => <NameCell row={row} />,
    copy: (row) => row.name,
  },
  {
    id: 'finished',
    header: 'Finished',
    width: 96,
    cell: (row) => <RelativeTime iso={row.finishedAt} />,
  },
  {
    id: 'attempts',
    header: 'Attempts',
    width: 80,
    align: 'end',
    cell: (row) =>
      row.attempts === 0 ? (
        <span className="text-kumo-inactive">—</span>
      ) : (
        <span className="tabular-nums">{formatNumber(row.attempts)}</span>
      ),
  },
  {
    id: 'last',
    header: 'Last',
    width: 96,
    cell: (row) => <ResultChip status={row.lastStatus} error={row.lastError} />,
  },
  {
    id: 'took',
    header: 'Took',
    width: 80,
    align: 'end',
    cell: (row) => (
      <Tooltip
        content="From enqueue to finish."
        render={<span className="cursor-default tabular-nums">{formatDuration(row.tookMs)}</span>}
      />
    ),
  },
  {
    id: 'payload',
    header: 'Payload',
    width: 300,
    cell: (row) => <PayloadCell body={row.body} />,
    copy: (row) => row.body.text,
  },
]

export function HistoryView({
  queue,
  project,
  outcome,
  q,
  taskId,
  onQuery,
  onOutcome,
  onOpen,
  actions,
  banners,
  inspector,
  aside,
}: {
  queue: TasksQueue
  project: string
  outcome: TasksOutcome | undefined
  q: string | undefined
  taskId: string | undefined
  onQuery: (q: string | undefined) => void
  onOutcome: (outcome: TasksOutcome | undefined) => void
  onOpen: (taskId: string | undefined) => void
  actions: TaskActions
  banners: ReactNode
  inspector: (navigation: { onPrev?: () => void; onNext?: () => void }) => ReactNode
  /** The tab's switch, on the filter line when row two has no room for it. */
  aside?: ReactNode
}) {
  const client = useQueryClient()
  const fields = useTaskFields(project)
  const usable = usableQuery(q, fields)
  const list = historyList(project, queue.key, outcome, usable)
  const query = useInfiniteQuery(list.options)
  const rows = useCursorRows(query, { ...list, q: usable })
  useQueueListener({
    // New finished tasks only ever join the head: the patch reads the head
    // page again (they fall in it) and flashes them; the table keeps the
    // reader's rows still and counts them above when scrolled away.
    finished: (batch) => (batch.overflow ? rows.reset() : rows.applyKeys(batch.ids)),
    reset: rows.reset,
    taken: () => {
      if (readStarted(client.getQueryState(list.queryKey)))
        void client.refetchQueries({ queryKey: list.queryKey, exact: true })
    },
  })
  const [cursor, setCursor] = useState<TasksHistoryRow | undefined>(undefined)
  const openRow = rows.rows.find((row) => row.taskId === taskId)
  const openIndex = openRow ? rows.rows.indexOf(openRow) : -1

  const copyCode = async (row: TasksHistoryRow) => {
    try {
      const detail = await client.fetchQuery(taskQuery(project, queue.key, row.taskId))
      const origin =
        serviceAddress('tasks', client.getQueryData(statusQuery.queryKey))?.origin ??
        'http://127.0.0.1:9499'
      const code = taskAsCode(
        { queue, task: detail.task, headers: detail.headers, body: detail.body, data: detail.data },
        'curl',
        origin,
      )
      await copyToClipboard(code, { title: `Copied ${subject(row).label} as curl` })
    } catch {
      toast({ key: 'tasks-copy', title: 'Could not copy the task as code', tone: 'danger' })
    }
  }

  const menu = (row: TasksHistoryRow): RowMenuItem[] => [
    {
      id: 'open',
      label: 'Open',
      icon: SidebarSimpleIcon,
      shortcut: 'Enter',
      run: () => onOpen(row.taskId),
    },
    {
      id: 'again',
      label: 'Enqueue again…',
      icon: ArrowCounterClockwiseIcon,
      shortcut: 'r',
      run: () => actions.again(subject(row), rowElement(TABLE, row.id)),
    },
    {
      id: 'edit',
      label: 'Edit and enqueue…',
      icon: PencilSimpleIcon,
      shortcut: 'Shift+r',
      run: () => actions.edit(row.taskId),
    },
    { id: 'code', label: 'Copy as curl', icon: CodeIcon, run: () => void copyCode(row) },
    {
      id: 'copy',
      label: 'Copy name',
      icon: CopyIcon,
      shortcut: 'Mod+c',
      run: () => {
        void copyToClipboard(row.name, { what: subject(row).label })
      },
    },
  ]

  useShortcuts({ id: 'tasks.history', label: 'History' }, [
    {
      key: 'r',
      label: 'Enqueue the finished task again…',
      when: () => cursor !== undefined,
      run: () => cursor && actions.again(subject(cursor), rowElement(TABLE, cursor.id)),
    },
    {
      key: 'Shift+r',
      label: 'Edit and enqueue the finished task',
      when: () => cursor !== undefined,
      run: () => cursor && actions.edit(cursor.taskId),
    },
  ])

  const hidden = useHiddenColumnCount('tasks.history', COLUMNS)
  const dropped = queue.historyDropped
  const empty =
    usable || outcome ? (
      <NoMatch
        filter={[outcome ? `outcome ${outcome}` : '', usable ?? ''].filter(Boolean).join(' · ')}
        onClear={() => {
          onQuery(undefined)
          onOutcome(undefined)
        }}
        noun="finished tasks"
      />
    ) : (
      <EmptyState
        icon={ClockCounterClockwiseIcon}
        title={`Nothing has finished in ${queue.id} yet`}
        description="A task arrives here when it succeeds, runs out of retries, or is stopped, deleted, purged or dropped by a re-registration. The newest thousand are kept."
        testId="history-empty"
      />
    )

  return (
    <>
      <SectionToolbar>
        <FilterLine
          q={q}
          onQuery={onQuery}
          fields={fields}
          total={rows.total}
          loading={query.isPending}
          noun={NOUN}
          aside={aside}
          placeholder="Filter finished tasks — name:order-* is:generated card"
          testId="history-filter"
        />
      </SectionToolbar>
      {banners}
      <SectionBody>
        {query.isError ? (
          <QueryError error={query.error} onRetry={() => void query.refetch()} section="tasks" />
        ) : (
          <DataTable<TasksHistoryRow>
            ariaLabel={`History of ${queue.id}`}
            rows={rows.rows}
            rowKey={(row) => row.id}
            columns={COLUMNS}
            memoryKey="tasks.history"
            openKey={openRow?.id}
            onOpen={(row) => onOpen(row.taskId)}
            onCursorChange={(row) => {
              setCursor(row)
              if (taskId !== undefined && row.taskId !== taskId) onOpen(row.taskId)
            }}
            flashes={rows.flashes}
            hasMore={rows.hasMore}
            loadMore={rows.loadMore}
            hasPrevious={rows.hasPrevious}
            loadPrevious={rows.loadPrevious}
            rowOffset={rows.rowOffset}
            total={rows.total}
            rowMenu={menu}
            loading={query.isPending}
            empty={empty}
            footer={
              rows.rows.length > 0 ? (
                <TableFooter
                  loaded={rows.rows.length}
                  rowOffset={rows.rowOffset}
                  total={rows.total}
                  hasMore={rows.hasMore}
                  hiddenColumns={hidden.hidden}
                  onShowAll={hidden.showAll}
                  noun={NOUN}
                  actions={
                    dropped > 0 ? (
                      <span className="text-[12px] text-kumo-subtle" data-testid="history-dropped">
                        The engine no longer keeps {formatNumber(dropped)} older finished{' '}
                        {dropped === 1 ? 'task' : 'tasks'} of {queue.id}; it keeps the newest{' '}
                        {formatNumber(queue.historyCapacity)} ({formatBytes(32 * 1024 * 1024)}).
                      </span>
                    ) : undefined
                  }
                />
              ) : undefined
            }
            testId={TABLE}
          />
        )}
        {taskId !== undefined &&
          inspector({
            ...(openIndex > 0 ? { onPrev: () => onOpen(rows.rows[openIndex - 1]?.taskId) } : {}),
            ...(openIndex !== -1 && openIndex < rows.rows.length - 1
              ? { onNext: () => onOpen(rows.rows[openIndex + 1]?.taskId) }
              : {}),
          })}
      </SectionBody>
    </>
  )
}
