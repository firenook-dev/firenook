// Cloud Tasks with no queue picked (TK-01, TK-02, D-T10): every queue of
// the project in one table — state, what waits, what holds a slot, its
// limits and its traffic — the way the Cloud console lists queues, with
// what the emulator refused above it. A project with no queue says how a
// queue comes to be, with this engine's Tasks address.

import { Button, Tooltip } from '@cloudflare/kumo'
import { LightningIcon, PlusIcon, QueueIcon } from '@phosphor-icons/react'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import type { TasksQueueList } from '@/api/generated/messaging/TasksQueueList'
import { DataTable, type DataTableColumn } from '@/components/console/data-table'
import { EmptyState } from '@/components/console/empty-state'
import { EntityLink } from '@/components/console/entity-link'
import { RelativeTime } from '@/components/console/relative-time'
import { SectionBanner } from '@/components/console/section-banner'
import { SectionBody } from '@/components/console/section-page'
import { TableFooter } from '@/components/console/table-footer'
import {
  SectionToolbar,
  ToolbarDivider,
  ToolbarRow,
  ToolbarScope,
} from '@/components/console/toolbar'
import { PanelToggle } from '@/components/shell/section-panel'
import { Kbd, StatusDot } from '@/components/kit'
import { formatNumber } from '@/lib/format'
import { useAgedCount } from '@/messaging/windows'
import { queueLabel } from '../queue-address'
import { maxAttemptsNote } from '../retry-plan'
import { RefusedBanners } from './refused-banner'
import { TasksConnect } from './tasks-connect'

const NOUN = { one: 'queue', other: 'queues' }

function Rate({
  window,
  span,
  bucket,
}: {
  window: TasksQueue['counters']['dispatched']
  span: number
  bucket?: number
}) {
  return <Figure value={useAgedCount(window, span, bucket)} />
}

/**
 * A count in the table: a zero in the inactive ink, so the figures that are
 * not zero are the ones the eye finds — one rule for every count column,
 * the live rates and the queue's own counters alike.
 */
function Figure({ value, tone }: { value: number; tone?: 'warning' | undefined }) {
  return (
    <span
      className={
        value === 0 ? 'text-kumo-inactive' : tone === 'warning' ? 'text-kumo-warning' : undefined
      }
    >
      {formatNumber(value)}
    </span>
  )
}

function columns(queues: readonly TasksQueue[]): DataTableColumn<TasksQueue>[] {
  return [
    {
      id: 'queue',
      header: 'Queue',
      width: 190,
      pinned: true,
      cell: (queue) => <span className="truncate">{queueLabel(queues, queue)}</span>,
      copy: (queue) => queue.id,
    },
    {
      id: 'state',
      header: 'State',
      width: 100,
      cell: (queue) => (
        <span className="font-sans">
          <StatusDot
            tone="neutral"
            label={queue.paused ? 'Paused' : queue.holdScheduled ? 'Holding' : 'Running'}
          />
        </span>
      ),
    },
    {
      id: 'waiting',
      header: 'Waiting',
      width: 80,
      align: 'end',
      cell: (queue) => <Figure value={queue.counters.pending + queue.counters.held} />,
    },
    {
      id: 'running',
      header: 'Running',
      width: 80,
      align: 'end',
      cell: (queue) => <Figure value={queue.counters.running + queue.counters.dispatching} />,
    },
    {
      id: 'backoff',
      header: 'Backoff',
      width: 80,
      align: 'end',
      cell: (queue) => <Figure value={queue.counters.backoff} tone="warning" />,
    },
    {
      id: 'dispatched',
      header: 'Sent / min',
      width: 92,
      align: 'end',
      cell: (queue) => <Rate window={queue.counters.dispatched} span={60} />,
    },
    {
      id: 'failed',
      header: 'Failed / 5 min',
      width: 108,
      align: 'end',
      cell: (queue) => <Rate window={queue.counters.failed} span={300} bucket={10} />,
    },
    {
      id: 'target',
      header: 'Target',
      width: 200,
      cell: (queue) =>
        queue.function ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <LightningIcon size={12} className="shrink-0 text-kumo-subtle" />
            <EntityLink entity={{ ...queue.function.functionRef, label: queue.function.name }} />
          </span>
        ) : (
          <span className="truncate font-sans text-kumo-subtle">registered by a client</span>
        ),
    },
    {
      id: 'oldest',
      header: 'Oldest waiting',
      width: 116,
      cell: (queue) =>
        queue.counters.oldestPendingAt ? (
          <RelativeTime iso={queue.counters.oldestPendingAt} />
        ) : (
          <span className="text-kumo-inactive">—</span>
        ),
    },
    {
      id: 'limits',
      header: 'Limits',
      width: 120,
      cell: (queue) => (
        <Tooltip
          content="maxDispatchesPerSecond · maxConcurrentDispatches"
          render={
            <span className="cursor-default truncate">
              {formatNumber(queue.config.maxDispatchesPerSecond)}/s ·{' '}
              {formatNumber(queue.config.maxConcurrentDispatches)} slots
            </span>
          }
        />
      ),
    },
    {
      id: 'attempts',
      header: 'Max attempts',
      width: 104,
      align: 'end',
      cell: (queue) => (
        <Tooltip
          content={maxAttemptsNote(queue.config)}
          render={<span className="cursor-default">{formatNumber(queue.config.maxAttempts)}</span>}
        />
      ),
    },
  ]
}

export function QueuesLanding({
  list,
  missing,
  onOpen,
  onEnqueue,
  project,
}: {
  list: TasksQueueList
  /** A queue the link named that this project does not register. */
  missing: string | undefined
  onOpen: (queue: TasksQueue) => void
  onEnqueue: () => void
  project: string
}) {
  const queues = list.items.toSorted(
    (a, b) => a.id.localeCompare(b.id) || a.location.localeCompare(b.location),
  )
  return (
    <>
      <SectionToolbar>
        <ToolbarRow testId="tasks-toolbar">
          <PanelToggle where="toolbar" />
          <ToolbarScope
            icon={<QueueIcon size={14} />}
            detail={<span className="font-mono">{project}</span>}
            testId="queue-field"
          >
            Task queues
          </ToolbarScope>
          <span className="min-w-0 flex-1" />
          <ToolbarDivider />
          <Tooltip
            content={
              <span className="flex items-center gap-1.5">
                Enqueue a task <Kbd>n</Kbd>
              </span>
            }
            render={
              <Button
                variant="primary"
                size="sm"
                icon={<PlusIcon />}
                onClick={onEnqueue}
                disabled={queues.length === 0}
                data-testid="tasks-enqueue"
              >
                Enqueue
              </Button>
            }
          />
        </ToolbarRow>
      </SectionToolbar>
      {missing && (
        <SectionBanner tone="warning" testId="tasks-missing-queue">
          No queue named <span className="font-mono text-[0.9em]">{missing}</span> is registered in{' '}
          <span className="font-mono text-[0.9em]">{project}</span>. Queues register from{' '}
          <span className="font-mono text-[0.9em]">onTaskDispatched</span> exports or a client’s
          POST …/queues/{missing}.
        </SectionBanner>
      )}
      <RefusedBanners
        refused={list.refused}
        rejected={list.rejectedRegistrations}
        queues={list.items}
        onOpen={onOpen}
      />
      <SectionBody>
        <DataTable<TasksQueue>
          ariaLabel={`Task queues of ${project}`}
          rows={queues}
          rowKey={(queue) => queue.key}
          columns={columns(queues)}
          memoryKey="tasks.queues"
          onOpen={onOpen}
          total={list.total ?? undefined}
          empty={
            <EmptyState
              icon={QueueIcon}
              title="No task queues"
              description="A queue appears for each function exported with onTaskDispatched, or when a client registers one; none is registered in this project."
              actions={<TasksConnect />}
              testId="tasks-no-queues"
            />
          }
          footer={
            queues.length > 0 ? (
              <TableFooter
                loaded={queues.length}
                total={list.total ?? undefined}
                hasMore={false}
                noun={NOUN}
              />
            ) : undefined
          }
          testId="queues-table"
        />
      </SectionBody>
    </>
  )
}
