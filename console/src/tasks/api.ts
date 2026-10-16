// Cloud Tasks' Console API, one typed function per route (messaging spec
// §7.5), under `/console/api/v1/tasks`. A queue is addressed by the
// emulator's opaque key (`queue:{project}-{location}-{queue}`, which cannot
// be split back into its parts: the list carries them), a task by the
// console's decimal id (auto names begin with a slash). Every change is a
// JSON body, DELETE included.

import { apiGet, apiSend } from '@/api/client'
import type { BatchGetRequest } from '@/api/generated/BatchGetRequest'
import type { BatchGetResponse } from '@/api/generated/BatchGetResponse'
import type { Job } from '@/api/generated/Job'
import type { ListMeta } from '@/api/generated/ListMeta'
import type { Page } from '@/api/generated/Page'
import type { TasksBulkBody } from '@/api/generated/messaging/TasksBulkBody'
import type { TasksEnqueueBody } from '@/api/generated/messaging/TasksEnqueueBody'
import type { TasksHistoryRow } from '@/api/generated/messaging/TasksHistoryRow'
import type { TasksHoldBody } from '@/api/generated/messaging/TasksHoldBody'
import type { TasksOutcome } from '@/api/generated/messaging/TasksOutcome'
import type { TasksPurgeBody } from '@/api/generated/messaging/TasksPurgeBody'
import type { TasksPurgeResult } from '@/api/generated/messaging/TasksPurgeResult'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import type { TasksQueueList } from '@/api/generated/messaging/TasksQueueList'
import type { TasksQueueRef } from '@/api/generated/messaging/TasksQueueRef'
import type { TasksRunResult } from '@/api/generated/messaging/TasksRunResult'
import type { TasksTaskDetail } from '@/api/generated/messaging/TasksTaskDetail'
import type { TasksTaskRef } from '@/api/generated/messaging/TasksTaskRef'
import type { TasksTaskRow } from '@/api/generated/messaging/TasksTaskRow'
import type { TasksTaskState } from '@/api/generated/messaging/TasksTaskState'
import { type PageAt, withQuery } from '@/messaging/api'

export type { PageAt } from '@/messaging/api'

// ------------------------------------------------------------ queues

/** The project's queues with their configuration and counters, the refused registrations and enqueues; one page. */
export function getQueues(project: string, signal?: AbortSignal): Promise<TasksQueueList> {
  return apiGet('/tasks/queues', { project }, signal)
}

/** Stops dispatching (console only): pending tasks stay put, running ones finish. */
export function pauseQueue(body: TasksQueueRef): Promise<TasksQueue> {
  return apiSend('POST', '/tasks/queue/pause', body)
}

export function resumeQueue(body: TasksQueueRef): Promise<TasksQueue> {
  return apiSend('POST', '/tasks/queue/resume', body)
}

/** Removes every pending task (and stops the retries of those in a slot, when asked). */
export function purgeQueue(body: TasksPurgeBody): Promise<TasksPurgeResult> {
  return apiSend('POST', '/tasks/queue/purge', body)
}

/** Holds tasks scheduled for later until their time (console only; off is the emulator's way). */
export function holdQueue(body: TasksHoldBody): Promise<TasksQueue> {
  return apiSend('POST', '/tasks/queue/hold', body)
}

// ------------------------------------------------------------ tasks

/** What a task list reads: one queue, narrowed to one state and a filter or not. */
export interface TaskScope {
  queue: string
  state?: TasksTaskState | undefined
  q?: string | undefined
}

/** One page of a queue's tasks: those in a slot first, then pending and held, each in task-id order. */
export function getTasks(
  scope: TaskScope,
  page: PageAt = {},
  signal?: AbortSignal,
): Promise<Page<TasksTaskRow>> {
  return apiGet(
    '/tasks/tasks',
    { queue: scope.queue, state: scope.state, q: scope.q, ...page },
    signal,
  )
}

/** Loaded task rows read again by their `(phase, id)` keys. `q` travels in the body. */
export function batchGetTasks(
  scope: Pick<TaskScope, 'queue' | 'state'>,
  request: BatchGetRequest,
  signal?: AbortSignal,
): Promise<BatchGetResponse<TasksTaskRow>> {
  return apiSend(
    'POST',
    withQuery('/tasks/tasks:batchGet', { queue: scope.queue, state: scope.state }),
    request,
    signal ? { signal } : {},
  )
}

/** A `tasks.run` job over tasks (ids, or every task a query matches). */
export function startRunTasks(body: TasksBulkBody): Promise<Job> {
  return apiSend('POST', '/tasks/tasks:run', body)
}

/** A `tasks.delete` job over tasks. */
export function startDeleteTasks(body: TasksBulkBody): Promise<Job> {
  return apiSend('POST', '/tasks/tasks:delete', body)
}

/** A task, pending, in a slot or finished: its request, attempts and retry plan. */
export function getTask(queue: string, id: string, signal?: AbortSignal): Promise<TasksTaskDetail> {
  return apiGet('/tasks/task', { queue, id }, signal)
}

/** Enqueues a task exactly as the Admin SDK would send it, held to the Tasks port's 100 KiB. */
export function enqueue(body: TasksEnqueueBody): Promise<TasksTaskRow> {
  return apiSend('POST', '/tasks/tasks', body)
}

/** Runs a pending or held task in a free slot now (a task in backoff on the next tick). */
export function runTask(body: TasksTaskRef): Promise<TasksRunResult> {
  return apiSend('POST', '/tasks/task/run', body)
}

/** Stops a task's retries: one in backoff is finished as cancelled; a running one after its attempt. */
export function stopTask(body: TasksTaskRef): Promise<TasksTaskRow> {
  return apiSend('POST', '/tasks/task/stop', body)
}

/** Enqueues a task again with the same body and headers, under a new generated name. */
export function enqueueAgain(body: TasksTaskRef): Promise<TasksTaskRow> {
  return apiSend('POST', '/tasks/task/enqueue-again', body)
}

/** Deletes any task, auto-named ones too (which the Tasks API cannot). */
export function deleteTask(body: TasksTaskRef): Promise<void> {
  return apiSend('DELETE', '/tasks/task', body)
}

// ------------------------------------------------------------ history

/** What a history list reads: one queue, narrowed to one outcome and a filter or not. */
export interface HistoryScope {
  queue: string
  outcome?: TasksOutcome | undefined
  q?: string | undefined
}

/** One page of a queue's finished tasks, newest first. */
export function getHistory(
  scope: HistoryScope,
  page: PageAt = {},
  signal?: AbortSignal,
): Promise<Page<TasksHistoryRow>> {
  return apiGet(
    '/tasks/history',
    { queue: scope.queue, outcome: scope.outcome, q: scope.q, ...page },
    signal,
  )
}

/** Loaded finished tasks read again by id (a response snippet that came after the row). */
export function batchGetHistory(
  queue: string,
  request: BatchGetRequest,
  signal?: AbortSignal,
): Promise<BatchGetResponse<TasksHistoryRow>> {
  return apiSend(
    'POST',
    withQuery('/tasks/history:batchGet', { queue }),
    request,
    signal ? { signal } : {},
  )
}

// ------------------------------------------------------------ list metadata

/**
 * The task lists' order and filter fields (`GET /tasks/tasks/meta`):
 * History filters with the same grammar, so it reads these too.
 */
export function getListMeta(signal?: AbortSignal): Promise<ListMeta> {
  return apiGet('/tasks/tasks/meta', {}, signal)
}
