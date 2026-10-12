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
// - `tasks.attempts` (a feed): every attempt of the queue (or one task) as
//   it happens, after the attempts the engine still keeps.

import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { TasksAttemptEvent } from '@/api/generated/messaging/TasksAttemptEvent'
import type { TasksAttempts } from '@/api/generated/messaging/TasksAttempts'
import type { TasksCountersFrame } from '@/api/generated/messaging/TasksCountersFrame'
import type { TasksFinishedBatch } from '@/api/generated/messaging/TasksFinishedBatch'
import type { TasksQueueList } from '@/api/generated/messaging/TasksQueueList'
import type { TasksQueuesChanged } from '@/api/generated/messaging/TasksQueuesChanged'
import type { TasksStale } from '@/api/generated/messaging/TasksStale'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { type FeedStore, createFeedStore } from '@/lib/live/feed-store'
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
    'tasks.attempts': {
      params: { project?: string; queue: string; task?: string }
      events: { attempts: TasksAttempts }
    }
  }
}

declareTopic('tasks.counters', 'compare')
declareTopic('tasks.queue', 'none')
declareTopic('tasks.attempts', 'replay')

/** Attempts an Attempts feed holds. */
export const ATTEMPTS_FEED_MAX = 2_000
/** Attempts the engine keeps across queues, for a gap row's sentence. */
export const ATTEMPTS_RING = 10_000

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

/** The keys of a `stale` event, sorted by what they name. */
export function splitTaskKeys(keys: readonly string[]): {
  /** Task row keys, the `row:` prefix removed (old and new keys of a task that changed phase). */
  rows: string[]
  /** Task ids whose detail changed. */
  tasks: string[]
} {
  const rows: string[] = []
  const tasks: string[] = []
  for (const key of keys) {
    if (key.startsWith('row:')) rows.push(key.slice('row:'.length))
    else if (key.startsWith('task:')) tasks.push(key.slice('task:'.length))
  }
  return { rows, tasks }
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
  })
}

// ------------------------------------------------------------ attempts

/** An attempt's key in a feed: its task and its number. */
export function attemptKey(event: TasksAttemptEvent): string {
  return `${event.taskId}:${event.attempt.attempt}`
}

/** An Attempts feed's store. */
export function createAttemptsStore(): FeedStore<TasksAttemptEvent> {
  return createFeedStore<TasksAttemptEvent>({
    max: ATTEMPTS_FEED_MAX,
    key: attemptKey,
    pausedMode: 'buffer',
  })
}

/**
 * Holds `tasks.attempts` for a queue (and one task, when given): the
 * attempts the engine still keeps, then each as it happens. A new store per
 * queue and task; pause it with the `PauseButton`.
 */
export function useAttemptsFeed(
  project: string | undefined,
  queue: string | undefined,
  task?: string,
): { store: FeedStore<TasksAttemptEvent>; status: SubscriptionStatus } {
  const id = project && queue ? `${project}\u0000${queue}\u0000${task ?? ''}` : ''
  const [feed, setFeed] = useState(() => ({ id, store: createAttemptsStore() }))
  let store = feed.store
  if (feed.id !== id) {
    store = createAttemptsStore()
    setFeed({ id, store })
  }
  const status = useLiveTopic(
    'tasks.attempts',
    project && queue ? { project, queue, ...(task ? { task } : {}) } : null,
    {
      onAttempts: (batch) => store.upsert(batch.items),
      onReset: (_reason, missed) => store.gap(missed, ATTEMPTS_RING),
    },
  )
  return { store, status }
}
