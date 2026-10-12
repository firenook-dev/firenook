// The Queues panel (TK-01, TK-01a): every queue of the project with what
// waits and what holds a slot, then the registrations the emulator
// refused and the enqueues the Tasks port turned down, each group only
// when it has rows. The queue on screen carries no figure — row two of the
// toolbar counts it — and a paused queue draws the pause glyph, so the
// state the queue is in reads from the panel without a word.

import { PauseCircleIcon, QueueIcon, WarningIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import type { TasksQueueList } from '@/api/generated/messaging/TasksQueueList'
import { PanelFilter, PanelHeader } from '@/components/console/panel'
import { PanelTree, type PanelTreeNode } from '@/components/console/panel-tree'
import { ScopeSelect } from '@/components/console/scope-select'
import { SectionPanel } from '@/components/shell/section-panel'
import { formatNumber } from '@/lib/format'
import { queueLabel } from '../queue-address'

const REJECTED = 'group:rejected'
const REFUSED = 'group:refused'

/** What the panel says about a queue when pointed at. */
export function queueTitle(queue: TasksQueue): string {
  const { counters } = queue
  const waiting = counters.pending + counters.held
  const slot = counters.dispatching + counters.running + counters.backoff
  const parts = [
    `${formatNumber(waiting)} waiting${counters.held > 0 ? ` (${formatNumber(counters.held)} held)` : ''}`,
    `${formatNumber(slot)} in a slot${counters.backoff > 0 ? ` (${formatNumber(counters.backoff)} in backoff)` : ''}`,
  ]
  const states = [
    queue.paused ? 'Paused: tasks wait until you resume.' : undefined,
    queue.holdScheduled ? 'Holding scheduled tasks until their time.' : undefined,
  ].filter(Boolean)
  return [`${queue.id} in ${queue.location}`, parts.join(' · '), ...states].join('\n')
}

/** The tree's nodes: the queues, then the refusals. */
export function panelNodes(list: TasksQueueList, current: string | undefined): PanelTreeNode[] {
  const queues = list.items.toSorted(
    (a, b) => a.id.localeCompare(b.id) || a.location.localeCompare(b.location),
  )
  const nodes: PanelTreeNode[] = queues.map((queue) => ({
    id: queue.key,
    label: queueLabel(list.items, queue),
    icon: queue.paused ? PauseCircleIcon : QueueIcon,
    count:
      queue.key === current
        ? undefined
        : `${formatNumber(queue.counters.pending + queue.counters.held)} · ${formatNumber(
            queue.counters.dispatching + queue.counters.running + queue.counters.backoff,
          )}`,
    title: queueTitle(queue),
  }))
  if (list.rejectedRegistrations.length > 0)
    nodes.push({
      id: REJECTED,
      label: 'Not registered',
      icon: WarningIcon,
      count: list.rejectedRegistrations.length,
      tone: 'warning',
      title: 'onTaskDispatched functions the emulator refused to register as queues.',
      children: list.rejectedRegistrations.map((rejected) => ({
        id: `rejected:${rejected.functionId}`,
        label: rejected.name,
        icon: WarningIcon,
        title: `${rejected.name} (${rejected.region}): ${rejected.reason}`,
      })),
    })
  if (list.refused.length > 0)
    nodes.push({
      id: REFUSED,
      label: 'Refused enqueues',
      icon: WarningIcon,
      count: list.refused.reduce((sum, refused) => sum + refused.count, 0),
      tone: 'warning',
      title: 'Requests the Tasks port refused, coalesced by queue and error.',
      children: list.refused.map((refused, index) => ({
        id: `refused:${index}:${refused.location}/${refused.queue}`,
        label: `${refused.location}/${refused.queue}`,
        icon: WarningIcon,
        count: `×${formatNumber(refused.count)}`,
        tone: 'warning' as const,
        title: [refused.error, refused.suggestion].filter(Boolean).join('\n'),
      })),
    })
  return nodes
}

export function QueuesPanel({
  list,
  current,
  project,
  configured,
  onOpen,
  onOpenRoot,
  onProject,
}: {
  list: TasksQueueList | undefined
  /** The queue on screen (its key). */
  current: string | undefined
  project: string
  configured: string | undefined
  onOpen: (queue: TasksQueue) => void
  /** A refusal was picked: the root lists them in full. */
  onOpenRoot: () => void
  onProject: (project: string) => void
}) {
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([REJECTED, REFUSED]))
  const nodes = list ? panelNodes(list, current) : []
  const projects = [...new Set([configured ?? project, project, ...(list?.projects ?? [])])].filter(
    (name) => name !== '',
  )
  return (
    <SectionPanel label="Queues">
      <PanelHeader
        filter={
          <PanelFilter
            value={filter}
            onChange={setFilter}
            placeholder="Filter queues"
            testId="queues-filter"
          />
        }
      >
        {projects.length > 1 ? (
          <ScopeSelect
            label="Project"
            value={project}
            items={projects.map((name) => ({
              value: name,
              detail: name === configured ? 'this emulator' : undefined,
            }))}
            onChange={onProject}
            className="flex-1"
            testId="queues-project"
          />
        ) : (
          <span
            className="flex h-6.5 min-w-0 items-center gap-1.5 px-1 text-[12px]"
            data-testid="queues-project"
          >
            <span className="shrink-0 text-kumo-subtle">Project</span>
            <span className="truncate font-mono text-kumo-default">{project}</span>
          </span>
        )}
      </PanelHeader>
      <PanelTree
        nodes={nodes}
        current={current}
        expanded={expanded}
        onToggle={(id, open) =>
          setExpanded((now) => {
            const next = new Set(now)
            if (open) next.add(id)
            else next.delete(id)
            return next
          })
        }
        onOpen={(node) => {
          if (node.id === REJECTED || node.id === REFUSED) {
            setExpanded((now) => {
              const next = new Set(now)
              if (next.has(node.id)) next.delete(node.id)
              else next.add(node.id)
              return next
            })
            return
          }
          if (node.id.startsWith('rejected:') || node.id.startsWith('refused:')) {
            onOpenRoot()
            return
          }
          const queue = list?.items.find((item) => item.key === node.id)
          if (queue) onOpen(queue)
        }}
        filter={filter}
        ariaLabel="Queues"
        empty="No queue is named like that."
        testId="queues-tree"
      />
    </SectionPanel>
  )
}
