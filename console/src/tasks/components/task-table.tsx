// The queue's Tasks tab (TK-10, TK-11, TK-12, S20): every pending, held and
// running task, paged by cursor (those in a slot first, then the waiting
// ones in task-id order, the order they leave in) and patched in place as
// they change — `tasks.queue` names the rows, `:batchGet` reads them again,
// a task that took a slot is one gone key and one new key, a finished one
// leaves for History. Nothing on screen moves but the row that changed.
// Ticked rows run now or delete as jobs; the filter line narrows by name or
// payload text.

import { Button, Tooltip } from '@cloudflare/kumo'
import {
  CopyIcon,
  PencilSimpleIcon,
  PlayIcon,
  SidebarSimpleIcon,
  StopIcon,
  TrashIcon,
  TrayIcon,
} from '@phosphor-icons/react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useRef, useState } from 'react'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import type { TasksTaskRow } from '@/api/generated/messaging/TasksTaskRow'
import { DangerConfirm } from '@/components/console/danger-confirm'
import {
  DataTable,
  type DataTableColumn,
  useHiddenColumnCount,
} from '@/components/console/data-table'
import { EmptyState, NoMatch, QueryError } from '@/components/console/empty-state'
import { RelativeTime } from '@/components/console/relative-time'
import type { RowMenuItem } from '@/components/console/row-menu'
import { SectionBody } from '@/components/console/section-page'
import { SelectionBar } from '@/components/console/selection-bar'
import { TableFooter } from '@/components/console/table-footer'
import { SectionToolbar } from '@/components/console/toolbar'
import { useCursorRows } from '@/components/console/use-cursor-rows'
import { StatusDot } from '@/components/kit'
import { useNow } from '@/lib/clock'
import { copyToClipboard } from '@/lib/copy'
import { formatNumber } from '@/lib/format'
import { toast } from '@/lib/toasts'
import { useShortcuts } from '@/lib/shortcuts'
import { startDeleteTasks, startRunTasks } from '../api'
import { errorText } from '@/lib/error-text'
import { taskList } from '../queries'
import { readStarted } from '@/lib/live/use-live-topic'
import { useQueueListener } from '../queue-live'
import {
  STATE_DETAIL,
  type StateFilter,
  attemptDetail,
  attemptText,
  countdownText,
  displayName,
  generatedDetail,
  stateTone,
  stateWord,
} from '../states'
import { FilterLine, useTaskFields, usableQuery } from './filter-line'
import { ResultChip } from './result-chip'
import { handlerName, type TaskActions } from './task-actions'
import { TasksConnect } from './tasks-connect'

const NOUN = { one: 'task', other: 'tasks' }

/** The row element of a task in a table, for a popover to hang off. */
export function rowElement(testId: string, key: string): Element | null {
  return document.querySelector(`[data-testid="${testId}"] [data-key="${CSS.escape(key)}"]`)
}

function StateCell({ row }: { row: TasksTaskRow }) {
  // To the second only where a due time counts down in the words.
  const now = useNow(row.state === 'held' ? 'second' : 'minute')
  return (
    <Tooltip
      content={STATE_DETAIL[row.state]}
      render={
        <span className="inline-flex min-w-0 cursor-default font-sans">
          <StatusDot
            tone={stateTone(row.state)}
            label={stateWord(row, now)}
            pulse={row.state === 'running'}
            testId="task-state"
          />
        </span>
      }
    />
  )
}

function NextCell({ row }: { row: TasksTaskRow }) {
  if (row.state === 'backoff' && row.nextAttemptAt) return <Countdown at={row.nextAttemptAt} />
  if (row.state === 'running') return <span className="font-sans text-kumo-subtle">in flight</span>
  if (row.state === 'dispatching')
    return <span className="font-sans text-kumo-subtle">next tick</span>
  return <span className="text-kumo-inactive">—</span>
}

/** A countdown on the shared one-second clock, mounted only while its row is on screen. */
function Countdown({ at }: { at: string }) {
  const now = useNow('second')
  return <span className="font-sans text-kumo-warning tabular-nums">{countdownText(at, now)}</span>
}

function NameCell({ row }: { row: TasksTaskRow }) {
  if (!row.generated) return <span className="truncate">{row.shortName}</span>
  return (
    <Tooltip
      content={generatedDetail(row.name)}
      render={
        <span className="cursor-default truncate text-kumo-subtle" data-testid="task-generated">
          {displayName(row)}
        </span>
      }
    />
  )
}

/** A body preview: the `data` member without its wrapper, marked as such. */
export function PayloadCell({ body }: { body: TasksTaskRow['body'] }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {body.dataMember && (
        <span className="shrink-0 rounded bg-kumo-tint px-1 text-[11px] leading-4 text-kumo-subtle">
          data
        </span>
      )}
      <span className="truncate">{body.text === '' ? '—' : body.text}</span>
    </span>
  )
}

/** The Tasks tab's columns; ETA shows only when a task here carries a schedule time. */
export function taskColumns(rows: readonly TasksTaskRow[]): DataTableColumn<TasksTaskRow>[] {
  return [
    { id: 'state', header: 'State', width: 150, cell: (row) => <StateCell row={row} /> },
    {
      id: 'name',
      header: 'Name',
      width: 170,
      cell: (row) => <NameCell row={row} />,
      copy: (row) => row.name,
    },
    {
      id: 'enqueued',
      header: 'Enqueued',
      width: 96,
      cell: (row) => <RelativeTime iso={row.enqueuedAt} />,
    },
    {
      id: 'attempt',
      header: 'Attempt',
      width: 80,
      align: 'end',
      cell: (row) =>
        row.attempt === 0 ? (
          <span className="text-kumo-inactive">—</span>
        ) : (
          <Tooltip
            content={attemptDetail(row.maxRuns)}
            render={<span className="cursor-default tabular-nums">{attemptText(row)}</span>}
          />
        ),
    },
    {
      id: 'last',
      header: 'Last',
      width: 96,
      cell: (row) => <ResultChip status={row.previousResponse} error={row.lastError} />,
    },
    { id: 'next', header: 'Next', width: 112, cell: (row) => <NextCell row={row} /> },
    {
      id: 'payload',
      header: 'Payload',
      width: 300,
      cell: (row) => <PayloadCell body={row.body} />,
      copy: (row) => row.body.text,
    },
    {
      id: 'eta',
      header: 'ETA',
      width: 180,
      // Shown when any task here carries a schedule time: the emulator does
      // not wait for it unless the queue holds scheduled tasks.
      hiddenByDefault: !rows.some((row) => row.scheduleTime !== null),
      cell: (row) =>
        row.scheduleTime ? (
          <span className="truncate">{row.scheduleTime}</span>
        ) : (
          <span className="text-kumo-inactive">—</span>
        ),
    },
  ]
}

const TABLE = 'task-table'

/** A task as the actions name it. */
function subject(row: TasksTaskRow) {
  return { id: row.id, label: displayName(row), generated: row.generated }
}

/** Whether Run now can send it: waiting, held, or in backoff. */
function runnable(row: TasksTaskRow): boolean {
  return row.state === 'pending' || row.state === 'held' || row.state === 'backoff'
}

export function TasksView({
  queue,
  project,
  state,
  q,
  taskId,
  onQuery,
  onState,
  onOpen,
  actions,
  banners,
  inspector,
  aside,
}: {
  queue: TasksQueue
  project: string
  state: StateFilter | undefined
  q: string | undefined
  taskId: string | undefined
  onQuery: (q: string | undefined) => void
  onState: (state: StateFilter | undefined) => void
  onOpen: (taskId: string | undefined) => void
  actions: TaskActions
  banners: ReactNode
  inspector: (navigation: { onPrev?: () => void; onNext?: () => void }) => ReactNode
  /** The tab's switch, on the filter line when row two has no room for it. */
  aside?: ReactNode
}) {
  const fields = useTaskFields(project)
  const usable = usableQuery(q, fields)
  const list = taskList(project, queue.key, state, usable)
  const query = useInfiniteQuery(list.options)
  const rows = useCursorRows(query, { ...list, q: usable })
  const queryClient = useQueryClient()
  useQueueListener({
    rows: rows.applyKeys,
    reset: rows.reset,
    // Rows read before the engine took the subscription are read again, in
    // place: a task enqueued between the two was never going to be told.
    taken: () => {
      if (readStarted(queryClient.getQueryState(list.queryKey)))
        void queryClient.refetchQueries({ queryKey: list.queryKey, exact: true })
    },
  })

  // Ticked rows, by row key; cleared when the list they were ticked in changes.
  const scope = `${queue.key}|${state ?? ''}|${usable ?? ''}`
  const [checked, setChecked] = useState<{
    scope: string
    keys: ReadonlySet<string>
    everything: boolean
  }>({ scope, keys: new Set(), everything: false })
  let ticked = checked
  if (checked.scope !== scope) {
    ticked = { scope, keys: new Set(), everything: false }
    setChecked(ticked)
  }
  const selecting = ticked.everything || ticked.keys.size > 0
  const clear = () => setChecked({ scope, keys: new Set(), everything: false })
  const target = () =>
    ticked.everything
      ? {
          by: 'query' as const,
          q: usable ?? '',
          scope: { queue: queue.key, ...(state ? { state } : {}) },
        }
      : { by: 'keys' as const, keys: [...ticked.keys] }
  const selectedCount = ticked.everything
    ? (rows.total?.count ?? ticked.keys.size)
    : ticked.keys.size

  const [deleting, setDeleting] = useState<{
    jobId?: string
    error?: string
    pending: boolean
  } | null>(null)
  const runRef = useRef<HTMLButtonElement>(null)
  // The cursor by task id: its row key changes when it takes a slot, and the
  // keys act on the row as it is now, not as it was when the cursor landed.
  const [cursorId, setCursorId] = useState<string | undefined>(undefined)
  const cursor = rows.rows.find((row) => row.id === cursorId)

  const openRow = rows.rows.find((row) => row.id === taskId)
  const openIndex = openRow ? rows.rows.indexOf(openRow) : -1

  const menu = (row: TasksTaskRow): RowMenuItem[] => [
    {
      id: 'open',
      label: 'Open',
      icon: SidebarSimpleIcon,
      shortcut: 'Enter',
      run: () => onOpen(row.id),
    },
    {
      id: 'run',
      label: 'Run now…',
      icon: PlayIcon,
      shortcut: 'r',
      disabled: runnable(row)
        ? undefined
        : row.state === 'running'
          ? 'Its request is in flight.'
          : 'It already holds a slot and is sent on the next tick.',
      run: () => actions.run(subject(row), rowElement(TABLE, row.key)),
    },
    {
      id: 'edit',
      label: 'Edit and enqueue a copy…',
      icon: PencilSimpleIcon,
      shortcut: 'Shift+r',
      run: () => actions.edit(row.id),
    },
    {
      id: 'stop',
      label: 'Stop retrying',
      icon: StopIcon,
      disabled:
        row.state === 'backoff' || (row.state === 'running' && !row.stopRequested)
          ? undefined
          : row.stopRequested
            ? 'It stops after the attempt in flight.'
            : 'Only a task that has made an attempt can stop retrying; delete a waiting one.',
      run: () => actions.stop(subject(row)),
    },
    {
      id: 'copy',
      label: 'Copy name',
      icon: CopyIcon,
      shortcut: 'Mod+c',
      run: () => {
        void copyToClipboard(row.name, { what: displayName(row) })
      },
    },
    {
      id: 'delete',
      label: 'Delete…',
      icon: TrashIcon,
      danger: true,
      shortcut: 'Delete',
      run: () => actions.remove(subject(row)),
    },
  ]

  const startDelete = async () => {
    setDeleting((now) => ({ ...now, pending: true }))
    try {
      const job = await startDeleteTasks({ queue: queue.key, target: target() })
      setDeleting({ jobId: job.id, pending: false })
      clear()
    } catch (error) {
      setDeleting({ pending: false, error: errorText(error) })
    }
  }

  useShortcuts({ id: 'tasks.tasks', label: 'Tasks' }, [
    {
      key: 'r',
      label: 'Run the task now…',
      when: () => cursor !== undefined && runnable(cursor),
      run: () => cursor && actions.run(subject(cursor), rowElement(TABLE, cursor.key)),
    },
    {
      key: 'Shift+r',
      label: 'Edit and enqueue a copy of the task',
      when: () => cursor !== undefined,
      run: () => cursor && actions.edit(cursor.id),
    },
    {
      key: 'Delete',
      label: 'Delete the ticked tasks',
      when: () => selecting,
      run: () => setDeleting({ pending: false }),
    },
    {
      key: 'Backspace',
      label: 'Delete the ticked tasks',
      when: () => selecting,
      run: () => setDeleting({ pending: false }),
    },
    {
      key: 'Escape',
      label: 'Clear the selection',
      when: () => selecting && taskId === undefined,
      run: clear,
    },
  ])

  const hidden = useHiddenColumnCount('tasks.tasks', taskColumns(rows.rows))
  const counters = queue.counters
  const neverUsed =
    counters.history === 0 &&
    counters.pending + counters.held + counters.backoff + counters.running === 0
  const empty =
    usable || state ? (
      <NoMatch
        filter={[state ? `state ${state}` : '', usable ?? ''].filter(Boolean).join(' · ')}
        onClear={() => {
          onQuery(undefined)
          onState(undefined)
        }}
        noun="tasks"
      />
    ) : queue.paused ? (
      <EmptyState
        icon={TrayIcon}
        title="Paused. New tasks wait here until you resume."
        description="Run now sends one past the pause; Resume lets them all go."
        testId="tasks-empty"
      />
    ) : (
      <EmptyState
        icon={TrayIcon}
        title={
          neverUsed
            ? `Nothing enqueued into ${queue.id} yet`
            : `Nothing pending or running. ${formatNumber(counters.history)} finished — see History.`
        }
        description={
          neverUsed
            ? `Tasks run ${handlerName(queue)} about a second after they are enqueued. Enqueue one here, or from your code with the Admin SDK's taskQueue().enqueue().`
            : 'A task leaves this list the moment it finishes; History keeps the newest thousand.'
        }
        {...(neverUsed ? { actions: <TasksConnect queue={queue} /> } : {})}
        testId="tasks-empty"
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
          placeholder="Filter tasks — name:order-* is:console card"
          testId="tasks-filter"
          overlay={
            selecting && (
              <SelectionBar
                count={selectedCount}
                total={rows.total}
                everything={ticked.everything}
                filtered={usable !== undefined || state !== undefined}
                noun={NOUN}
                onSelectEverything={() =>
                  setChecked({ scope, keys: ticked.keys, everything: true })
                }
                onClear={clear}
                actions={
                  <>
                    <Button
                      ref={runRef}
                      variant="ghost"
                      size="sm"
                      icon={<PlayIcon />}
                      onClick={() =>
                        actions.confirm({
                          title: `Run ${formatNumber(selectedCount)} ${selectedCount === 1 ? 'task' : 'tasks'} now?`,
                          description: `Each takes a free slot past the rate limit and a pause, and runs ${handlerName(queue)}.`,
                          confirm: 'Run now',
                          anchor: runRef.current,
                          testId: 'run-many-confirm',
                          run: async () => {
                            const job = await startRunTasks({ queue: queue.key, target: target() })
                            clear()
                            toast({
                              key: `tasks-run-job-${job.id}`,
                              title: job.title,
                              description:
                                'Progress is in the jobs strip; tasks without a free slot are listed as failed there.',
                              tone: 'info',
                            })
                          },
                        })
                      }
                      data-testid="tasks-run-ticked"
                    >
                      Run now…
                    </Button>
                    <span className="ml-auto shrink-0 pl-3">
                      <Button
                        variant="secondary-destructive"
                        size="sm"
                        icon={<TrashIcon />}
                        onClick={() => setDeleting({ pending: false })}
                        data-testid="tasks-delete-ticked"
                      >
                        Delete {formatNumber(selectedCount)}
                      </Button>
                    </span>
                  </>
                }
              />
            )
          }
        />
      </SectionToolbar>
      {banners}
      <SectionBody>
        {query.isError ? (
          <QueryError error={query.error} onRetry={() => void query.refetch()} section="tasks" />
        ) : (
          <DataTable<TasksTaskRow>
            ariaLabel={`Tasks of ${queue.id}`}
            rows={rows.rows}
            rowKey={(row) => row.key}
            columns={taskColumns(rows.rows)}
            memoryKey="tasks.tasks"
            selection={{
              checked: ticked.keys,
              everything: ticked.everything,
              onChange: (keys, everything) => setChecked({ scope, keys, everything }),
            }}
            openKey={openRow?.key}
            onOpen={(row) => onOpen(row.id)}
            onCursorChange={(row) => {
              setCursorId(row.id)
              if (taskId !== undefined && row.id !== taskId) onOpen(row.id)
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
                />
              ) : undefined
            }
            testId={TABLE}
          />
        )}
        {taskId !== undefined &&
          inspector({
            ...(openIndex > 0 ? { onPrev: () => onOpen(rows.rows[openIndex - 1]?.id) } : {}),
            ...(openIndex !== -1 && openIndex < rows.rows.length - 1
              ? { onNext: () => onOpen(rows.rows[openIndex + 1]?.id) }
              : {}),
          })}
      </SectionBody>
      <DangerConfirm
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
        title={`Delete ${formatNumber(selectedCount)} ${selectedCount === 1 ? 'task' : 'tasks'}`}
        description={`They leave ${queue.id} for History, as deleted.`}
        consequences={[
          'A request already in flight keeps running; its answer is not recorded.',
          'Auto-named tasks go too, which the Cloud Tasks API could never delete.',
        ]}
        {...(deleting?.jobId ? { jobId: deleting.jobId } : {})}
        {...(deleting?.error ? { error: deleting.error } : {})}
        pending={deleting?.pending ?? false}
        onConfirm={() => void startDelete()}
        testId="tasks-delete"
      />
    </>
  )
}
