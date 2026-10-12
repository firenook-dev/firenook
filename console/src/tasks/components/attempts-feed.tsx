// The queue's Attempts tab (TK-25, S21a): every attempt of every task in
// the queue as it happens — when, which task, which attempt, what it
// answered, how long it took, the first line of the response — the way a
// webhook dashboard lists deliveries. It replays what the engine still
// keeps (10,000 attempts across queues) and then follows; `p` holds it
// still and counts what arrives. → opens a row's whole response, selecting
// a row opens its task, `c` copies the task's name, Shift+C the attempt.

import { Link, useNavigate } from '@tanstack/react-router'
import { LightningIcon } from '@phosphor-icons/react'
import { type ReactNode, useState } from 'react'
import type { TasksAttemptEvent } from '@/api/generated/messaging/TasksAttemptEvent'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import { EmptyState } from '@/components/console/empty-state'
import { EntityLink } from '@/components/console/entity-link'
import { FeedList } from '@/components/console/feed-list'
import { OutcomeChip } from '@/components/console/outcome-chip'
import { SectionBody } from '@/components/console/section-page'
import { useNow } from '@/lib/clock'
import { formatClock, formatDuration, formatNumber, useClockFormat } from '@/lib/format'
import type { FeedStore } from '@/lib/live/feed-store'
import { useShortcuts } from '@/lib/shortcuts'
import { toast } from '@/lib/toasts'
import { attemptKey } from '../live'
import { attemptLogs, useLogsLinkable } from '../logs'
import {
  attemptChip,
  displayName,
  executionText,
  readableResponse,
  responseSummary,
} from '../states'

/** A task as a row names it: its short name, or `auto·8812` for one the emulator named. */
export function taskLabel(event: Pick<TasksAttemptEvent, 'taskName'>): string {
  const short = event.taskName.slice(event.taskName.lastIndexOf('/') + 1)
  return displayName({ generated: event.taskName.startsWith('/'), shortName: short })
}

/** The columns, one width each, shared by the header and the rows. */
const COLUMNS = {
  when: 'w-[92px]',
  task: 'w-[140px]',
  attempt: 'w-14',
  status: 'w-[96px]',
  took: 'w-16',
} as const

function Header() {
  return (
    <div className="flex items-center gap-3 px-3">
      <span className={COLUMNS.when}>When</span>
      <span className={COLUMNS.task}>Task</span>
      <span className={`${COLUMNS.attempt} text-right`}>Attempt</span>
      <span className={COLUMNS.status}>Status</span>
      <span className={`${COLUMNS.took} text-right`}>Took</span>
      <span>Response or error</span>
    </div>
  )
}

function When({ at }: { at: string }) {
  const { format } = useClockFormat()
  // A relative clock counts by the second; the other formats never change.
  const now = useNow(format === 'relative' ? 'second' : 'minute')
  return <>{formatClock(at, format, now)}</>
}

function AttemptRow({ event }: { event: TasksAttemptEvent }) {
  const { attempt } = event
  const chip = attemptChip(attempt)
  const said = responseSummary(attempt.response) || responseSummary(attempt.error)
  return (
    <span
      className="flex min-w-0 flex-1 items-center gap-3 px-3 font-mono text-[12px]"
      data-testid="attempt-row"
    >
      <span className={`${COLUMNS.when} shrink-0 text-[11px] text-kumo-subtle tabular-nums`}>
        <When at={attempt.startedAt} />
      </span>
      <span className={`${COLUMNS.task} shrink-0 truncate text-kumo-default`}>
        {taskLabel(event)}
      </span>
      <span className={`${COLUMNS.attempt} shrink-0 text-right text-kumo-default tabular-nums`}>
        {formatNumber(attempt.attempt)}
      </span>
      <span className={`${COLUMNS.status} shrink-0 font-sans`}>
        <OutcomeChip word={chip.word} tone={chip.tone} mono={chip.mono} detail={chip.detail} />
      </span>
      <span className={`${COLUMNS.took} shrink-0 text-right text-kumo-subtle tabular-nums`}>
        {formatDuration(attempt.durationMs)}
      </span>
      <span className="min-w-0 truncate text-kumo-subtle">{said}</span>
    </span>
  )
}

function Expanded({
  event,
  queue,
  logs,
}: {
  event: TasksAttemptEvent
  queue: TasksQueue
  logs: boolean
}) {
  const { attempt } = event
  const link = logs ? attemptLogs(queue, attempt) : undefined
  return (
    <div className="grid gap-1.5 pr-3 pb-2 pl-[calc(92px+1.5rem)]" data-testid="attempt-expanded">
      <span className="text-[12px] text-kumo-subtle">
        {executionText(attempt)} · sent with X-CloudTasks-TaskRetryCount {attempt.retryCount}
      </span>
      {(attempt.response || attempt.error) && (
        <pre className="m-0 max-h-48 overflow-auto rounded bg-kumo-tint px-2 py-1 font-mono text-[12px] leading-5 break-words whitespace-pre-wrap text-kumo-default">
          {attempt.response ? readableResponse(attempt.response) : attempt.error}
        </pre>
      )}
      {(attempt.invocation || link) && (
        <span className="flex items-center gap-3 text-[12px]">
          {attempt.invocation && (
            <span className="flex items-center gap-1.5">
              <LightningIcon size={12} className="text-kumo-subtle" />
              <EntityLink entity={attempt.invocation} />
            </span>
          )}
          {link && (
            <Link
              to={link.to as never}
              search={link.search as never}
              className="text-kumo-link underline-offset-2 hover:underline"
            >
              Logs
            </Link>
          )}
        </span>
      )}
    </div>
  )
}

function copy(text: string, title: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast({ key: 'tasks-copy', title }),
    () => toast({ key: 'tasks-copy', title: 'Could not copy', tone: 'danger' }),
  )
}

export function AttemptsView({
  queue,
  store,
  paused,
  onPaused,
  onOpen,
  banners,
  inspector,
  taskId,
}: {
  queue: TasksQueue
  store: FeedStore<TasksAttemptEvent>
  paused: boolean
  onPaused: (paused: boolean) => void
  onOpen: (taskId: string, options?: { replace?: boolean }) => void
  banners: ReactNode
  inspector: (navigation: { onPrev?: () => void; onNext?: () => void }) => ReactNode
  taskId: string | undefined
}) {
  const logs = useLogsLinkable()
  const navigate = useNavigate()
  const [selected, setSelected] = useState<TasksAttemptEvent | undefined>(undefined)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  useShortcuts({ id: 'tasks.attempts', label: 'Attempts' }, [
    {
      key: 'c',
      label: "Copy the attempt's task name",
      when: () => selected !== undefined,
      run: () => selected && copy(selected.taskName, `Copied ${taskLabel(selected)}`),
    },
    {
      key: 'Shift+c',
      label: 'Copy the attempt as JSON',
      when: () => selected !== undefined,
      run: () =>
        selected &&
        copy(
          JSON.stringify(selected, null, 2),
          `Copied attempt ${selected.attempt.attempt} of ${taskLabel(selected)}`,
        ),
    },
    {
      key: 'l',
      label: "Open the attempt's logs",
      when: () =>
        selected !== undefined && logs && attemptLogs(queue, selected.attempt) !== undefined,
      run: () => {
        const link = selected ? attemptLogs(queue, selected.attempt) : undefined
        if (link) void navigate({ to: link.to as never, search: link.search as never })
      },
    },
  ])
  return (
    <>
      {banners}
      <SectionBody>
        <FeedList<TasksAttemptEvent>
          ariaLabel={`Attempts of ${queue.id}`}
          store={store}
          order="newest-first"
          rowHeight={32}
          rowKey={attemptKey}
          renderRow={(event) => <AttemptRow event={event} />}
          expanded={expanded}
          renderExpanded={(event) => <Expanded event={event} queue={queue} logs={logs} />}
          onToggleExpanded={(key, open) =>
            setExpanded((now) => {
              const next = new Set(now)
              if (open) next.add(key)
              else next.delete(key)
              return next
            })
          }
          selectedKey={selected ? attemptKey(selected) : undefined}
          onSelect={(event) => {
            setSelected(event)
            onOpen(event.taskId, { replace: taskId !== undefined })
          }}
          follow={!paused}
          onFollowChange={(follow) => onPaused(!follow)}
          header={<Header />}
          empty={
            <EmptyState
              icon={LightningIcon}
              title="No attempts yet"
              description={`Each dispatch of a task in ${queue.id} appears here as it happens, with what the handler answered.`}
              testId="attempts-empty"
            />
          }
          testId="attempts-feed"
        />
        {taskId !== undefined && inspector({})}
      </SectionBody>
    </>
  )
}
