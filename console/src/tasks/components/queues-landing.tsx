// Cloud Tasks with no queue picked (TK-01, TK-02, D-T10): every queue of
// the project in one table — its state, what waits, what runs, what is in
// backoff and what failed for good — the way the Cloud console lists
// queues, with what the emulator refused above it. Its traffic, limits and
// function are the queue's own (Configuration, row one). A project with no
// queue says how a queue comes to be, with this engine's Tasks address.

import { Button, Tooltip } from '@cloudflare/kumo'
import { PlusIcon, QueueIcon } from '@phosphor-icons/react'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import type { TasksQueueList } from '@/api/generated/messaging/TasksQueueList'
import { DataTable, type DataTableColumn } from '@/components/console/data-table'
import { EmptyState } from '@/components/console/empty-state'
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
import { queueLabel } from '../queue-address'
import { RefusedBanners } from './refused-banner'
import { TasksConnect } from './tasks-connect'

const NOUN = { one: 'queue', other: 'queues' }

/**
 * A count in the table: a zero in the inactive ink, so the figures that are
 * not zero are the ones the eye finds — one rule for every count column.
 */
function Figure({ value, tone }: { value: number; tone?: 'warning' | 'danger' | undefined }) {
  return (
    <span
      className={
        value === 0
          ? 'text-kumo-inactive'
          : tone === 'warning'
            ? 'text-kumo-warning'
            : tone === 'danger'
              ? 'text-kumo-danger'
              : undefined
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
      // Ran out of retries, as History counts them (its Failed switch).
      id: 'failed',
      header: 'Failed',
      width: 80,
      align: 'end',
      cell: (queue) => <Figure value={queue.counters.outcomes.failed} tone="danger" />,
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
