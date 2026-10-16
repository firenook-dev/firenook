// Whole Cloud Tasks answers for unit tests, with every field a real engine
// sends, so a test states only what it is about. The values are the
// messaging fixture's: processOrder in us-central1 with maxAttempts 3,
// min/max backoff 1 and 4 s, two slots and ten dispatches a second.

import type { TasksAttempt } from '@/api/generated/messaging/TasksAttempt'
import type { TasksHistoryRow } from '@/api/generated/messaging/TasksHistoryRow'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import type { TasksQueueCounters } from '@/api/generated/messaging/TasksQueueCounters'
import type { TasksQueueList } from '@/api/generated/messaging/TasksQueueList'
import type { TasksTaskDetail } from '@/api/generated/messaging/TasksTaskDetail'
import type { TasksTaskRow } from '@/api/generated/messaging/TasksTaskRow'

export const PROJECT = 'demo-console'
export const LOCATION = 'us-central1'
export const NOW = Date.parse('2026-10-12T10:02:27.000Z')

export const queueKeyOf = (id: string, location = LOCATION, project = PROJECT) =>
  `queue:${project}-${location}-${id}`

const window = { endsAt: '2026-10-12T10:02:27.000Z', buckets: [] as Array<[number, number]> }

export function testCounters(overrides: Partial<TasksQueueCounters> = {}): TasksQueueCounters {
  return {
    key: queueKeyOf('processOrder'),
    pending: 0,
    held: 0,
    dispatching: 0,
    running: 0,
    backoff: 0,
    slots: 2,
    slotsInUse: 0,
    tokens: 10,
    maxTokens: 10,
    refilledAt: '2026-10-12T10:02:27.000Z',
    maxDispatchesPerSecond: 10,
    dispatched: window,
    failed: window,
    oldestPendingAt: null,
    history: 0,
    outcomes: { succeeded: 0, failed: 0, cancelled: 0, deleted: 0, purged: 0, replaced: 0 },
    ...overrides,
  }
}

export function testQueue(
  id = 'processOrder',
  overrides: Partial<TasksQueue> = {},
  location = LOCATION,
): TasksQueue {
  const key = queueKeyOf(id, location)
  return {
    key,
    project: PROJECT,
    location,
    id,
    origin: 'function',
    function: {
      functionId: `${location}-${id}`,
      name: id,
      region: location,
      functionRef: { kind: 'functions.function', key: `${location}-${id}`, label: id },
      invocationsRef: { kind: 'functions.invocations', key: `function:${location}-${id}` },
    },
    defaultUri: `http://127.0.0.1:5001/${PROJECT}/${location}/${id}`,
    registeredAt: '2026-10-12T10:00:00.000Z',
    registrations: 1,
    lastReplaced: null,
    config: {
      maxAttempts: 3,
      maxRetrySeconds: null,
      minBackoffSeconds: 1,
      maxBackoffSeconds: 4,
      maxDoublings: 16,
      maxConcurrentDispatches: 2,
      maxDispatchesPerSecond: 10,
      values: [
        { key: 'retryConfig.maxAttempts', value: '3', provided: true, unused: false },
        { key: 'retryConfig.maxRetrySeconds', value: 'null', provided: false, unused: false },
        { key: 'retryConfig.maxBackoffSeconds', value: '4', provided: true, unused: false },
        { key: 'retryConfig.maxDoublings', value: '16', provided: false, unused: false },
        { key: 'retryConfig.minBackoffSeconds', value: '1', provided: true, unused: false },
        { key: 'rateLimits.maxConcurrentDispatches', value: '2', provided: true, unused: false },
        { key: 'rateLimits.maxDispatchesPerSecond', value: '10', provided: true, unused: false },
        { key: 'timeoutSeconds', value: '10', provided: false, unused: true },
        { key: 'retry', value: 'false', provided: false, unused: true },
        { key: 'defaultUri', value: '"http://127.0.0.1:5001/x"', provided: true, unused: false },
      ],
      ladder: [
        { attempt: 1, backoffSeconds: 0, afterSeconds: 0, last: false },
        { attempt: 2, backoffSeconds: 1, afterSeconds: 1, last: false },
        { attempt: 3, backoffSeconds: 2, afterSeconds: 3, last: false },
        { attempt: 4, backoffSeconds: 4, afterSeconds: 7, last: true },
      ],
    },
    paused: false,
    holdScheduled: false,
    counters: testCounters({ key }),
    historyCapacity: 1000,
    historyDropped: 0,
    ...overrides,
  }
}

export function testList(
  queues: TasksQueue[] = [testQueue()],
  overrides: Partial<TasksQueueList> = {},
): TasksQueueList {
  return {
    project: PROJECT,
    projects: [PROJECT],
    rejectedRegistrations: [],
    refused: [],
    revision: 1,
    items: queues,
    nextCursor: null,
    prevCursor: null,
    total: { count: queues.length, exact: true },
    scanned: null,
    ...overrides,
  }
}

export function testRow(overrides: Partial<TasksTaskRow> = {}): TasksTaskRow {
  return {
    key: '1.7',
    id: '7',
    name: `projects/${PROJECT}/locations/${LOCATION}/queues/processOrder/tasks/order-1`,
    shortName: 'order-1',
    generated: false,
    state: 'pending',
    position: 1,
    enqueuedAt: '2026-10-12T10:02:15.000Z',
    origin: 'console',
    scheduleTime: null,
    dueAt: null,
    attempt: 0,
    maxRuns: 4,
    executionCount: 0,
    previousResponse: null,
    lastError: null,
    lastAttemptAt: null,
    nextAttemptAt: null,
    deadlineSeconds: 60,
    url: null,
    body: {
      json: true,
      text: '{"orderId":"o_20251","fail":true}',
      truncated: false,
      dataMember: true,
      size: 42,
    },
    stopRequested: false,
    ...overrides,
  }
}

export function testAttempt(overrides: Partial<TasksAttempt> = {}): TasksAttempt {
  return {
    attempt: 1,
    startedAt: '2026-10-12T10:02:19.204Z',
    durationMs: 12,
    status: 500,
    error: null,
    response: '{"error":{"message":"card declined","status":"INTERNAL"}}',
    countedExecution: false,
    retryCount: 0,
    invocation: null,
    ...overrides,
  }
}

export function testDetail(overrides: Partial<TasksTaskDetail> = {}): TasksTaskDetail {
  return {
    task: testRow(),
    headers: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'x-synthetic-header', value: 'console' },
    ],
    dispatchHeaders: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-CloudTasks-QueueName', value: queueKeyOf('processOrder') },
      { name: 'X-CloudTasks-TaskName', value: 'order-1' },
      { name: 'X-CloudTasks-TaskRetryCount', value: '0' },
      { name: 'X-CloudTasks-TaskExecutionCount', value: '0' },
      { name: 'X-CloudTasks-TaskETA', value: '1791712947000' },
      { name: 'x-synthetic-header', value: 'console' },
    ],
    body: '{"data":{"orderId":"o_20251","fail":true}}',
    data: '{"orderId":"o_20251","fail":true}',
    attempts: [],
    omittedAttempts: 0,
    retryPlan: [],
    stops: 'Gives up after attempt 4 (maxAttempts 3 + 1, as the official emulator runs it).',
    finished: null,
    ...overrides,
  }
}

export function testHistoryRow(overrides: Partial<TasksHistoryRow> = {}): TasksHistoryRow {
  return {
    id: '12',
    taskId: '7',
    name: `projects/${PROJECT}/locations/${LOCATION}/queues/processOrder/tasks/order-1`,
    shortName: 'order-1',
    outcome: 'succeeded',
    enqueuedAt: '2026-10-12T10:02:15.000Z',
    finishedAt: '2026-10-12T10:02:16.000Z',
    attempts: 1,
    lastStatus: 204,
    lastError: null,
    tookMs: 1000,
    body: {
      json: true,
      text: '{"orderId":"o_1"}',
      truncated: false,
      dataMember: true,
      size: 26,
    },
    ...overrides,
  }
}
