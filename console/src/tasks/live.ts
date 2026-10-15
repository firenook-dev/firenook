// Cloud Tasks' live topics (messaging spec §6.3) and the hooks the page
// holds them with, each a subscription on the console's one live channel.
//
// - `tasks.counters` (state, compared by the Tasks revision): frames patch
//   the cached queue list in place, newest only; `queues` (a queue
//   registered, re-registered, paused, resumed, its hold changed, a refusal)
//   reads the list again.
// - `tasks.queue` (invalidation): the keys of task rows that changed phase,
//   appeared or left, the tasks whose detail changed, and the tasks that
//   finished (History's head).
//
// A queue's attempts as they happen are Functions › Invocations': each is
// an invocation of the queue's function.

import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { TasksCountersFrame } from '@/api/generated/messaging/TasksCountersFrame'
import type { TasksFinishedBatch } from '@/api/generated/messaging/TasksFinishedBatch'
import type { TasksQueueList } from '@/api/generated/messaging/TasksQueueList'
import type { TasksQueuesChanged } from '@/api/generated/messaging/TasksQueuesChanged'
import type { TasksStale } from '@/api/generated/messaging/TasksStale'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { declareTopic } from '@/lib/live/topics'
import { createInvalidator, useLiveTopic } from '@/lib/live/use-live-topic'
import { applyQueueCounters, countersLog } from './counters'
import { tasksKeys } from './queries'

declare module '@/lib/live/topics' {
  interface TopicMap {
    'tasks.counters': {
      params: { project?: string }
      events: { counters: TasksCountersFrame; queues: TasksQueuesChanged }
    }
    'tasks.queue': {
      params: { project?: string; queue: string }
      events: { stale: TasksStale; finished: TasksFinishedBatch }
    }
  }
}

declareTopic('tasks.counters', 'compare')
declareTopic('tasks.queue', 'none')

// ------------------------------------------------------------ counters

/** Puts a counters frame into the cached queue list; reads the list again when the frame names a queue it lacks. */
export function applyTasksCounters(
  client: QueryClient,
  project: string,
  frame: TasksCountersFrame,
) {
  countersLog.record(project, frame)
  const key = tasksKeys.queues(project)
  const list = client.getQueryData<TasksQueueList>(key)
  if (!list) return
  const applied = applyQueueCounters(list, frame)
  if (applied.list !== list) client.setQueryData(key, applied.list)
  if (applied.unknown) void client.invalidateQueries({ queryKey: key, exact: true })
}

/** Holds `tasks.counters` for `project` while mounted (`undefined` = not now). */
export function useTasksCounters(project: string | undefined): SubscriptionStatus {
  const client = useQueryClient()
  const [invalidator] = useState(() =>
    createInvalidator((key) => void client.invalidateQueries({ queryKey: key }), 120),
  )
  useEffect(() => () => invalidator.dispose(), [invalidator])
  return useLiveTopic('tasks.counters', project ? { project } : null, {
    onCounters: (frame) => {
      if (project) applyTasksCounters(client, project, frame)
    },
    onQueues: () => {
      if (project) invalidator.push([tasksKeys.queues(project), tasksKeys.queueDetails(project)])
    },
    onReset: () => {
      if (!project) return
      countersLog.clear(project)
      invalidator.flush([tasksKeys.queues(project), tasksKeys.queueDetails(project)])
    },
  })
}

// ------------------------------------------------------------ one queue

/** The task id in a row key (`phase.id`), or undefined when it is not one. */
export function rowTaskId(key: string): string | undefined {
  const dot = key.indexOf('.')
  const id = dot === -1 ? '' : key.slice(dot + 1)
  return /^\d+$/.test(id) ? id : undefined
}

/** The keys of a `stale` event, sorted by what they name. */
export function splitTaskKeys(keys: readonly string[]): {
  /** Task row keys, the `row:` prefix removed (old and new keys of a task that changed phase). */
  rows: string[]
  /**
   * Task ids whose detail changed: those a `task:` key names, and those
   * whose row changed (a task that changed phase or state changed its
   * detail too; the engine sends the row key alone then).
   */
  tasks: string[]
} {
  const rows: string[] = []
  const tasks = new Set<string>()
  for (const key of keys) {
    if (key.startsWith('row:')) {
      const row = key.slice('row:'.length)
      rows.push(row)
      const id = rowTaskId(row)
      if (id !== undefined) tasks.add(id)
    } else if (key.startsWith('task:')) tasks.add(key.slice('task:'.length))
  }
  return { rows, tasks: [...tasks] }
}

export interface QueueLiveHandlers {
  /** Task rows that changed, appeared or left: the Tasks table's `applyKeys`. */
  onRowKeys?: (keys: string[]) => void
  /**
   * Tasks that finished. At the top of History, the page reads its head
   * page again and flashes the new ids; scrolled away, `added` goes to
   * the table's `newAbove`.
   */
  onFinished?: (batch: TasksFinishedBatch) => void
  /** The subscription lost track: the page's tables go back to page one. */
  onReset?: () => void
  /**
   * The engine took the subscription. `tasks.queue` names what changes from
   * then on, so a table read before it (its first read races the
   * subscription) reads its rows again, in place.
   */
  onTaken?: () => void
}

/** Holds `tasks.queue` for the open queue (by its engine key); task details are read again here. */
export function useQueueLive(
  project: string | undefined,
  queue: string | undefined,
  handlers: QueueLiveHandlers,
): SubscriptionStatus {
  const client = useQueryClient()
  return useLiveTopic('tasks.queue', project && queue ? { project, queue } : null, {
    onStale: (stale) => {
      if (!project || !queue) return
      const split = splitTaskKeys(stale.keys)
      if (split.rows.length > 0) handlers.onRowKeys?.(split.rows)
      for (const id of split.tasks)
        void client.invalidateQueries({ queryKey: tasksKeys.task(project, queue, id) })
    },
    onFinished: (batch) => handlers.onFinished?.(batch),
    onReset: () => {
      if (project && queue)
        void client.invalidateQueries({ queryKey: tasksKeys.taskDetails(project, queue) })
      handlers.onReset?.()
    },
    onEnd: () => handlers.onReset?.(),
    onTaken: () => handlers.onTaken?.(),
  })
}
