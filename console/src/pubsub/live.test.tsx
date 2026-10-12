import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Page } from '@/api/generated/Page'
import type { PubsubCountersFrame } from '@/api/generated/messaging/PubsubCountersFrame'
import type { PubsubPushStreak } from '@/api/generated/messaging/PubsubPushStreak'
import type { PubsubSchedule } from '@/api/generated/messaging/PubsubSchedule'
import type { PubsubSubscriptionCounters } from '@/api/generated/messaging/PubsubSubscriptionCounters'
import type { PubsubSubscriptionSummary } from '@/api/generated/messaging/PubsubSubscriptionSummary'
import type { PubsubTopicIndex } from '@/api/generated/messaging/PubsubTopicIndex'
import type { PubsubTopicSummary } from '@/api/generated/messaging/PubsubTopicSummary'

// The hooks subscribe through `useLiveTopic`, stood in for here so what
// each event does to the query cache is what is tested; the journeys run
// the real channel against the engine.
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

const { applyCountersFrame, catchUpIndex, countersLog } = await import('./counters')
const live = await import('./live')
const { pubsubKeys, topicIndexQuery } = await import('./queries')

const PROJECT = 'demo-console'
const ORDERS = `projects/${PROJECT}/topics/orders`
const WORKER = `projects/${PROJECT}/subscriptions/orders-worker`

function subscriptionCounters(name: string, backlog: number): PubsubSubscriptionCounters {
  return {
    name,
    backlog,
    available: backlog,
    outstanding: 0,
    pushing: 0,
    retainedAcked: 0,
    backlogBytes: backlog * 10,
    oldestUnackedAt: null,
    redelivered: 0,
    ackedTotal: 0,
    deadLetteredTotal: 0,
    blockedKeys: 0,
    consumers: { streaming: 0, waitingPulls: 0, lastPullAt: null },
  }
}

function subscription(name: string, backlog: number): PubsubSubscriptionSummary {
  return {
    name,
    project: PROJECT,
    id: name.split('/').at(-1) ?? name,
    topic: ORDERS,
    delivery: 'pull',
    managed: 'no',
    ordering: false,
    exactlyOnce: false,
    deadLetterTopic: null,
    filter: null,
    counters: subscriptionCounters(name, backlog),
  }
}

function topic(
  name: string,
  published: number,
  subscriptions: PubsubSubscriptionSummary[],
): PubsubTopicSummary {
  return {
    name,
    project: PROJECT,
    id: name.split('/').at(-1) ?? name,
    kind: 'user',
    scheduleFunction: null,
    schema: null,
    counters: { name, published, lastPublishedAt: null, latestMessageId: null, mostBehind: null },
    subscriptions,
    functions: [],
  }
}

function index(revision: number): PubsubTopicIndex {
  return {
    project: PROJECT,
    otherProjects: [],
    detached: [],
    revision,
    items: [
      topic(ORDERS, 3, [subscription(WORKER, 3)]),
      topic(`projects/${PROJECT}/topics/audit`, 0, []),
    ],
    nextCursor: null,
    prevCursor: null,
    total: { count: 2, exact: true },
    scanned: null,
  }
}

function frame(revision: number, published: number, backlog: number): PubsubCountersFrame {
  return {
    revision,
    topics: [
      { name: ORDERS, published, lastPublishedAt: null, latestMessageId: null, mostBehind: null },
    ],
    subscriptions: [subscriptionCounters(WORKER, backlog)],
    throughput: [],
  }
}

describe('counters frames on the topics index (U-06)', () => {
  it('replace the counters they name, keep the rest, and take the revision', () => {
    const before = index(10)
    const { index: after, unknown } = applyCountersFrame(before, frame(12, 7, 5))
    expect(unknown).toBe(false)
    expect(after.revision).toBe(12)
    expect(after.items[0]?.counters.published).toBe(7)
    expect(after.items[0]?.subscriptions[0]?.counters.backlog).toBe(5)
    // Untouched topics keep their identity, for the tree's memoized rows.
    expect(after.items[1]).toBe(before.items[1])
  })

  it('replace, never add: counters are state', () => {
    const once = applyCountersFrame(index(10), frame(12, 7, 5)).index
    const twice = applyCountersFrame(once, frame(13, 7, 5)).index
    expect(twice.items[0]?.counters.published).toBe(7)
  })

  it('are ignored when not newer than the index', () => {
    const before = index(12)
    expect(applyCountersFrame(before, frame(12, 99, 99)).index).toBe(before)
    expect(applyCountersFrame(before, frame(11, 99, 99)).index).toBe(before)
  })

  it('say when they name what the index lacks', () => {
    const named = {
      ...frame(12, 1, 1),
      subscriptions: [subscriptionCounters(`projects/${PROJECT}/subscriptions/new`, 1)],
    }
    expect(applyCountersFrame(index(10), named).unknown).toBe(true)
  })

  it('patch detached subscriptions too', () => {
    const detached = `projects/${PROJECT}/subscriptions/left`
    const before = { ...index(1), detached: [subscription(detached, 1)] }
    const after = applyCountersFrame(before, {
      revision: 2,
      topics: [],
      subscriptions: [subscriptionCounters(detached, 9)],
      throughput: [],
    }).index
    expect(after.detached[0]?.counters.backlog).toBe(9)
  })

  it('catch a re-read index up with the frames that came while it was out', () => {
    const caught = catchUpIndex(index(10), [frame(9, 1, 1), frame(11, 4, 4), frame(14, 6, 2)])
    expect(caught.revision).toBe(14)
    expect(caught.items[0]?.counters.published).toBe(6)
    expect(caught.items[0]?.subscriptions[0]?.counters.backlog).toBe(2)
  })
})

describe('stale keys (U-06)', () => {
  it('sort backlog rows, messages and snapshots apart', () => {
    expect(
      live.splitStaleKeys(['backlog:1.4.4', 'message:12', 'snapshots', 'backlog:0.9.3', 'other']),
    ).toEqual({ backlog: ['1.4.4', '0.9.3'], messages: ['12'], snapshots: true })
  })

  it('name the lists each resource kind makes stale', () => {
    const keys = live.resourceKeys(PROJECT, ['snapshots']).map((key) => key.join('/'))
    expect(keys).toEqual(['pubsub/demo-console/snapshots', 'pubsub/demo-console/topic'])
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

describe('usePubsubCounters (U-06)', () => {
  it('subscribes with the project and at most 24 throughput topics, sorted', () => {
    const many = Array.from(
      { length: 30 },
      (_, n) => `projects/p/topics/t${String(n).padStart(2, '0')}`,
    )
    renderHook(() => live.usePubsubCounters(PROJECT, many.toReversed()), { wrapper })
    const params = subscribed('pubsub.counters').params as { project: string; throughput: string[] }
    expect(params.project).toBe(PROJECT)
    expect(params.throughput).toEqual(many.slice(0, 24))
  })

  it('waits for a project', () => {
    renderHook(() => live.usePubsubCounters(undefined), { wrapper })
    expect(subscribed('pubsub.counters').params).toBeNull()
  })

  it('patches the cached index, and keeps the frame for a re-read to catch up with', async () => {
    client.setQueryData(pubsubKeys.topics(PROJECT), index(10))
    renderHook(() => live.usePubsubCounters(PROJECT), { wrapper })
    const onCounters = subscribed('pubsub.counters').handlers.onCounters as (
      f: PubsubCountersFrame,
    ) => void
    act(() => onCounters(frame(11, 8, 8)))
    const cached = client.getQueryData<PubsubTopicIndex>(pubsubKeys.topics(PROJECT))
    expect(cached?.items[0]?.counters.published).toBe(8)
    expect(countersLog.newerThan(PROJECT, 10)).toHaveLength(1)
  })

  it('a re-read older than a frame comes back caught up', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(index(10)), { status: 200 }))
    countersLog.record(PROJECT, frame(15, 42, 1))
    const read = await client.fetchQuery(topicIndexQuery(PROJECT))
    expect(read.revision).toBe(15)
    expect(read.items[0]?.counters.published).toBe(42)
    fetch.mockRestore()
  })

  it('keeps each followed topic’s newest throughput window', () => {
    renderHook(() => live.usePubsubCounters(PROJECT, [ORDERS]), { wrapper })
    const onCounters = subscribed('pubsub.counters').handlers.onCounters as (
      f: PubsubCountersFrame,
    ) => void
    const window = {
      endsAt: '2026-10-12T10:00:00.000Z',
      buckets: [[0, 3]] as Array<[number, number]>,
    }
    act(() => onCounters({ ...frame(20, 1, 1), throughput: [{ topic: ORDERS, window }] }))
    expect(live.throughputOf(PROJECT, ORDERS)).toEqual(window)
    const { result } = renderHook(() => live.useThroughput(PROJECT, ORDERS), { wrapper })
    expect(result.current).toEqual(window)
  })
})

/** A schedule with only what a frame patches. */
const schedule = (functionId: string, runs: number) =>
  ({
    functionId,
    paused: false,
    automatic: true,
    nextRunAt: null,
    runs,
  }) as unknown as PubsubSchedule

describe('the other Pub/Sub topics (U-06)', () => {
  it('pubsub.topic hands rows to the tables and reads message details again', () => {
    const onBacklogKeys = vi.fn()
    const onMessageKeys = vi.fn()
    const onPublished = vi.fn()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    renderHook(
      () =>
        live.useTopicLive(PROJECT, ORDERS, WORKER, { onBacklogKeys, onMessageKeys, onPublished }),
      { wrapper },
    )
    const held = subscribed('pubsub.topic')
    expect(held.params).toEqual({ project: PROJECT, topic: ORDERS, subscription: WORKER })
    const onStale = held.handlers.onStale as (stale: { keys: string[] }) => void
    act(() => onStale({ keys: ['backlog:1.2.2', 'message:2'] }))
    expect(onBacklogKeys).toHaveBeenCalledWith(['1.2.2'])
    expect(onMessageKeys).toHaveBeenCalledWith(['2'])
    expect(invalidate).toHaveBeenCalledWith({ queryKey: pubsubKeys.message(PROJECT, ORDERS, '2') })
    const published = { latestId: '9', added: 2, ids: ['9', '8'], overflow: false }
    act(() => (held.handlers.onPublished as (p: typeof published) => void)(published))
    expect(onPublished).toHaveBeenCalledWith(published)
  })

  it('pubsub.topic resets and ends send the tables back to page one', () => {
    const onReset = vi.fn()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    renderHook(() => live.useTopicLive(PROJECT, ORDERS, undefined, { onReset }), { wrapper })
    const held = subscribed('pubsub.topic')
    expect(held.params).toEqual({ project: PROJECT, topic: ORDERS })
    act(() => (held.handlers.onReset as () => void)())
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: pubsubKeys.topicMessageDetails(PROJECT, ORDERS),
    })
    act(() => (held.handlers.onEnd as () => void)())
    expect(onReset).toHaveBeenCalledTimes(2)
  })

  it('pubsub.push upserts streaks in place', () => {
    const { result } = renderHook(() => live.usePushFeed(PROJECT, WORKER), { wrapper })
    const onAttempts = subscribed('pubsub.push').handlers.onAttempts as (batch: {
      items: PubsubPushStreak[]
    }) => void
    const streak = (count: number): PubsubPushStreak => ({
      streak: 's1',
      subscription: WORKER,
      messageId: '7',
      firstAttempt: 1,
      lastAttempt: count,
      count,
      firstAt: '2026-10-12T10:00:00.000Z',
      lastAt: '2026-10-12T10:00:05.000Z',
      status: 500,
      error: null,
      latencyMs: 3,
      response: 'no',
    })
    act(() => onAttempts({ items: [streak(1)] }))
    act(() => onAttempts({ items: [streak(312)] }))
    expect(result.current.store.size()).toBe(1)
    const row = result.current.store.at(0)
    expect(row?.kind === 'item' ? row.item.count : undefined).toBe(312)
  })

  it('pubsub.push starts a new feed for another subscription', () => {
    const { result, rerender } = renderHook(({ name }) => live.usePushFeed(PROJECT, name), {
      wrapper,
      initialProps: { name: WORKER },
    })
    const first = result.current.store
    rerender({ name: `${WORKER}-2` })
    expect(result.current.store).not.toBe(first)
  })

  it('pubsub.deliveries names keys, counts new ones, and resets on overflow', () => {
    const onKeys = vi.fn()
    const onAdded = vi.fn()
    const onReset = vi.fn()
    renderHook(() => live.useDeliveriesLive(PROJECT, ORDERS, { onKeys, onAdded, onReset }), {
      wrapper,
    })
    const onChanged = subscribed('pubsub.deliveries').handlers.onChanged as (c: {
      keys: string[]
      added: number
      overflow: boolean
    }) => void
    act(() => onChanged({ keys: ['e1'], added: 3, overflow: false }))
    expect(onKeys).toHaveBeenCalledWith(['e1'])
    expect(onAdded).toHaveBeenCalledWith(3)
    act(() => onChanged({ keys: [], added: 0, overflow: true }))
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('pubsub.schedules patches the states it names', () => {
    const page: Page<PubsubSchedule> = {
      items: [schedule('a', 1), schedule('b', 1)],
      nextCursor: null,
      prevCursor: null,
      total: { count: 2, exact: true },
      scanned: null,
    }
    const patched = live.applySchedulesFrame(page, {
      revision: 4,
      schedules: [
        {
          functionId: 'a',
          paused: true,
          automatic: true,
          nextRunAt: 'later',
          runs: 2,
          lastRunAt: null,
          lastOutcome: 'delivered',
        },
      ],
    })
    expect(patched.items[0]).toMatchObject({ paused: true, runs: 2, nextRunAt: 'later' })
    expect(patched.items[1]).toBe(page.items[1])
    expect(live.applySchedulesFrame(page, { revision: 5, schedules: [] })).toBe(page)
  })
})

/** A `published` event naming `ids`. */
const publishedOf = (ids: string[], added = ids.length, overflow = false) => ({
  added,
  ids,
  overflow,
})

describe('a message list following its topic (U-06)', () => {
  const away = { loaded: true, atHead: false, filtered: false }

  it('at the head, or before its first page has landed, reads the head again', () => {
    expect(live.publishedStep({ ...away, atHead: true }, publishedOf(['12', '11']))).toEqual({
      kind: 'read-head',
    })
    expect(
      live.publishedStep({ ...away, loaded: false, filtered: true }, publishedOf(['12'])),
    ).toEqual({ kind: 'read-head' })
  })

  it('scrolled away, counts what arrived above, never moving the rows read', () => {
    expect(live.publishedStep(away, publishedOf(['14', '13', '12']))).toEqual({
      kind: 'count',
      added: 3,
    })
    // Past a hundred, the event names no ids: every one is counted.
    expect(live.publishedStep({ ...away, filtered: true }, publishedOf([], 250, true))).toEqual({
      kind: 'count',
      added: 250,
    })
  })

  it('scrolled away under a filter, asks the engine which of the new ids match', () => {
    expect(live.publishedStep({ ...away, filtered: true }, publishedOf(['14', '13']))).toEqual({
      kind: 'match',
      ids: ['14', '13'],
    })
  })
})
