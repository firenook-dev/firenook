// Cloud Tasks' server state: the query keys every page and live handler
// agrees on, and the query options built on the API. Keys follow the
// console's shape, `['tasks', project, …]`; a queue's lists sit under its
// engine key (`['tasks', project, <queue key>, 'tasks' | 'history' | 'task', …]`),
// so `tasks.queue` refreshes one queue's rows and nothing else.
//
// The queue list is the queue view's source too: it holds every queue's
// configuration and counters, kept current by `tasks.counters`. Task and
// History lists are cursor lists for `useCursorRows`, as Pub/Sub's.

import { queryOptions } from '@tanstack/react-query'
import type { TasksOutcome } from '@/api/generated/messaging/TasksOutcome'
import type { TasksTaskState } from '@/api/generated/messaging/TasksTaskState'
import { cursorPagesOptions } from '@/components/console/use-cursor-rows'
import type { PageAt } from '@/messaging/api'
import {
  type TasksList,
  batchGetHistory,
  batchGetTasks,
  getHistory,
  getListMeta,
  getQueues,
  getTask,
  getTasks,
} from './api'
import { catchUpQueues, countersLog } from './counters'

export const tasksKeys = {
  /** Everything of one project. */
  section: (project: string) => ['tasks', project] as const,
  /** The queue list (the panel, every queue's view). */
  queues: (project: string) => ['tasks', project, 'queues'] as const,
  /** Everything of one queue: its task lists, history lists and task details (a prefix). */
  queueData: (project: string, queue: string) => ['tasks', project, queue] as const,
  tasks: (project: string, queue: string, state?: TasksTaskState, q = '') =>
    ['tasks', project, queue, 'tasks', state ?? 'all', q] as const,
  /** Every task detail of a queue (a prefix). */
  taskDetails: (project: string, queue: string) => ['tasks', project, queue, 'task'] as const,
  task: (project: string, queue: string, id: string) =>
    ['tasks', project, queue, 'task', id] as const,
  /** Every history list of a queue (a prefix). */
  queueHistory: (project: string, queue: string) => ['tasks', project, queue, 'history'] as const,
  history: (project: string, queue: string, outcome?: TasksOutcome, q = '') =>
    ['tasks', project, queue, 'history', outcome ?? 'all', q] as const,
  meta: (project: string, list: TasksList) => ['tasks', project, 'meta', list] as const,
}

/**
 * The project's queues. Counters frames keep it current (`useTasksCounters`);
 * a re-read catches up with the frames that arrived while it was out.
 */
export const queuesQuery = (project: string) =>
  queryOptions({
    queryKey: tasksKeys.queues(project),
    queryFn: async ({ signal }) => {
      const list = await getQueues(project, signal)
      return catchUpQueues(list, countersLog.newerThan(project, list.revision))
    },
    enabled: project !== '',
  })

export const taskQuery = (project: string, queue: string, id: string) =>
  queryOptions({
    queryKey: tasksKeys.task(project, queue, id),
    queryFn: ({ signal }) => getTask(queue, id, signal),
    enabled: project !== '' && queue !== '' && id !== '',
  })

/** A list's order and filter fields: fixed for the engine's life. */
export const listMetaQuery = (project: string, list: TasksList) =>
  queryOptions({
    queryKey: tasksKeys.meta(project, list),
    queryFn: ({ signal }) => getListMeta(list, signal),
    staleTime: Number.POSITIVE_INFINITY,
  })

// ------------------------------------------------------------ cursor lists

/** A queue's tasks; rows keyed by `(phase, id)`, so a task that takes a slot is a new key. */
export function taskList(project: string, queue: string, state?: TasksTaskState, q?: string) {
  const queryKey = tasksKeys.tasks(project, queue, state, q)
  const fetchPage = (page: PageAt, signal: AbortSignal) =>
    getTasks({ queue, state, q }, page, signal)
  return {
    queryKey,
    fetchPage,
    rowKey: (row: { key: string }) => row.key,
    batchGet: (request: Parameters<typeof batchGetTasks>[1], signal: AbortSignal) =>
      batchGetTasks({ queue, state }, request, signal),
    options: {
      ...cursorPagesOptions(queryKey, fetchPage),
      enabled: project !== '' && queue !== '',
    },
  }
}

/** A queue's finished tasks, newest first; rows keyed by their finished id. */
export function historyList(project: string, queue: string, outcome?: TasksOutcome, q?: string) {
  const queryKey = tasksKeys.history(project, queue, outcome, q)
  const fetchPage = (page: PageAt, signal: AbortSignal) =>
    getHistory({ queue, outcome, q }, page, signal)
  return {
    queryKey,
    fetchPage,
    rowKey: (row: { id: string }) => row.id,
    batchGet: (request: Parameters<typeof batchGetHistory>[1], signal: AbortSignal) =>
      batchGetHistory(queue, request, signal),
    options: {
      ...cursorPagesOptions(queryKey, fetchPage),
      enabled: project !== '' && queue !== '',
    },
  }
}
