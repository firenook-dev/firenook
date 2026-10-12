import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TasksAttemptEvent } from '@/api/generated/messaging/TasksAttemptEvent'
import type { TasksCountersFrame } from '@/api/generated/messaging/TasksCountersFrame'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import type { TasksQueueCounters } from '@/api/generated/messaging/TasksQueueCounters'
import type { TasksQueueList } from '@/api/generated/messaging/TasksQueueList'

// As in Pub/Sub's live tests: `useLiveTopic` is stood in for, so what each
// event does to the cache and the feed is what is tested.
const calls = vi.hoisted(() => ({
  topics: [] as Array<{ name: string; params: unknown; handlers: Record<string, unknown> }>,
}))

vi.mock('@/lib/live/use-live-topic', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/live/use-live-topic')>()),
  useLiveTopic: (name: string, params: unknown, given: Record<string, unknown>) => {
    calls.topics.push({ name, params, handlers: given })
    return 'live'
  },
}))

const { applyQueueCounters, catchUpQueues, countersLog } = await import('./counters')
const live = await import('./live')
const { queuesQuery, tasksKeys } = await import('./queries')

const PROJECT = 'demo-console'
const KEY = `queue:${PROJECT}-us-central1-processOrder`
const window = { endsAt: '2026-10-12T10:00:00.000Z', buckets: [] as Array<[number, number]> }

function counters(
  key: string,
  pending: number,
  official: TasksQueueCounters['official'] = null,
): TasksQueueCounters {
  return {
    key,
    pending,
    held: 0,
    dispatching: 0,
    running: 0,
    backoff: 0,
    slots: 2,
    slotsInUse: 0,
    tokens: 10,
    maxTokens: 10,
    refilledAt: '2026-10-12T10:00:00.000Z',
    maxDispatchesPerSecond: 10,
    dispatched: window,
    succeeded: window,
    failed: window,
    added: window,
    oldestPendingAt: null,
    history: 0,
    outcomes: { succeeded: 0, failed: 0, cancelled: 0, deleted: 0, purged: 0, replaced: 0 },
    official,
  }
}

const OFFICIAL = {
  numberOfTasks: 1,
  tasksAdded: 1,
  completedLastMin: 0,
  failedTasks: 0,
  runningTasks: 2,
}

function list(revision: number): TasksQueueList {
  return {
    project: PROJECT,
    projects: [PROJECT],
    rejectedRegistrations: [],
    refused: [],
    revision,
    items: [{ key: KEY, counters: counters(KEY, 1, OFFICIAL) } as unknown as TasksQueue],
    nextCursor: null,
    prevCursor: null,
    total: { count: 1, exact: true },
    scanned: null,
  }
}

const frame = (revision: number, pending: number, key = KEY): TasksCountersFrame => ({
  revision,
  queues: [counters(key, pending)],
})

describe('counters frames on the queue list (U-15)', () => {
  it('replace the counters they name, keeping the official figures, and take the revision', () => {
    const { list: after, unknown } = applyQueueCounters(list(4), frame(6, 12))
    expect(unknown).toBe(false)
    expect(after.revision).toBe(6)
    expect(after.items[0]?.counters.pending).toBe(12)
    expect(after.items[0]?.counters.official).toEqual(OFFICIAL)
  })

  it('are ignored when not newer, and say when they name a queue the list lacks', () => {
    const before = list(6)
    expect(applyQueueCounters(before, frame(6, 99)).list).toBe(before)
    expect(applyQueueCounters(list(1), frame(2, 1, 'queue:other')).unknown).toBe(true)
  })

  it('catch a re-read list up', () => {
    expect(catchUpQueues(list(4), [frame(3, 0), frame(9, 7)]).items[0]?.counters.pending).toBe(7)
  })
})

describe('task keys (U-15)', () => {
  it('sort rows and task details apart', () => {
    expect(live.splitTaskKeys(['row:0.4', 'task:4', 'row:1.4', 'other'])).toEqual({
      rows: ['0.4', '1.4'],
      tasks: ['4'],
    })
  })

  it('read a task detail again when its row changed', () => {
    expect(live.splitTaskKeys(['row:0.9', 'row:1.12', 'task:3'])).toEqual({
      rows: ['0.9', '1.12'],
      tasks: ['9', '12', '3'],
    })
    expect(live.rowTaskId('1.12')).toBe('12')
    expect(live.rowTaskId('nonsense')).toBeUndefined()
  })
})

let client: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)

/** The last subscription a hook made to `topicName`. */
function subscribed(topicName: string) {
  const found = calls.topics.findLast((entry) => entry.name === topicName)
  if (!found) throw new Error(`nothing subscribed to ${topicName}`)
  return found
}

beforeEach(() => {
  calls.topics.length = 0
  countersLog.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

describe('the Cloud Tasks topics (U-15)', () => {
  it('tasks.counters patches the cached list; a re-read catches up', async () => {
    client.setQueryData(tasksKeys.queues(PROJECT), list(4))
    renderHook(() => live.useTasksCounters(PROJECT), { wrapper })
    const held = subscribed('tasks.counters')
    expect(held.params).toEqual({ project: PROJECT })
    act(() => (held.handlers.onCounters as (f: TasksCountersFrame) => void)(frame(5, 3)))
    expect(
      client.getQueryData<TasksQueueList>(tasksKeys.queues(PROJECT))?.items[0]?.counters.pending,
    ).toBe(3)

    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(list(2)), { status: 200 }))
    const read = await client.fetchQuery(queuesQuery(PROJECT))
    expect(read.revision).toBe(5)
    expect(read.items[0]?.counters.pending).toBe(3)
    fetch.mockRestore()
  })

  it('tasks.counters reads the list again when the queues change', () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    renderHook(() => live.useTasksCounters(PROJECT), { wrapper })
    act(() =>
      (subscribed('tasks.counters').handlers.onQueues as (q: { revision: number }) => void)({
        revision: 9,
      }),
    )
    expect(invalidate).toHaveBeenCalledWith({ queryKey: tasksKeys.queues(PROJECT) })
  })

  it('tasks.queue hands rows to the table and reads task details again', () => {
    const onRowKeys = vi.fn()
    const onFinished = vi.fn()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    renderHook(() => live.useQueueLive(PROJECT, KEY, { onRowKeys, onFinished }), { wrapper })
    const held = subscribed('tasks.queue')
    expect(held.params).toEqual({ project: PROJECT, queue: KEY })
    act(() =>
      (held.handlers.onStale as (s: { keys: string[] }) => void)({
        keys: ['row:1.7', 'row:0.7', 'task:7'],
      }),
    )
    expect(onRowKeys).toHaveBeenCalledWith(['1.7', '0.7'])
    expect(invalidate).toHaveBeenCalledWith({ queryKey: tasksKeys.task(PROJECT, KEY, '7') })
    const batch = { latestId: '3', added: 1, ids: ['3'], overflow: false }
    act(() => (held.handlers.onFinished as (b: typeof batch) => void)(batch))
    expect(onFinished).toHaveBeenCalledWith(batch)
  })

  it('tasks.attempts keeps each attempt once, by task and number', () => {
    const { result } = renderHook(() => live.useAttemptsFeed(PROJECT, KEY), { wrapper })
    const onAttempts = subscribed('tasks.attempts').handlers.onAttempts as (b: {
      items: TasksAttemptEvent[]
    }) => void
    const attempt = (n: number): TasksAttemptEvent => ({
      queue: KEY,
      taskId: '7',
      taskName: 'order-1',
      attempt: {
        attempt: n,
        startedAt: '2026-10-12T10:00:00.000Z',
        durationMs: 3,
        status: 500,
        error: null,
        response: 'card declined',
        countedExecution: false,
        retryCount: n - 1,
        invocation: null,
      },
    })
    act(() => onAttempts({ items: [attempt(1), attempt(2)] }))
    act(() => onAttempts({ items: [attempt(2)] }))
    expect(result.current.store.size()).toBe(2)
    expect(subscribed('tasks.attempts').params).toEqual({ project: PROJECT, queue: KEY })
  })
})
