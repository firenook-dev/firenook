import { describe, expect, it } from 'vitest'
import type { PubsubTopicIndex } from '@/api/generated/messaging/PubsubTopicIndex'
import {
  findSubscription,
  fullName,
  idProblem,
  projectOf,
  resolveTyped,
  scopeCompletions,
  searchValue,
  shortName,
} from './names'

describe('resource ids, as the engine checks them (U-01)', () => {
  it('take 3 to 255 characters of letters, digits and - _ . ~ + %, a letter first', () => {
    expect(idProblem('abc')).toBeUndefined()
    expect(idProblem('Topic_1.two~three+four%five-six')).toBeUndefined()
    expect(idProblem('a'.repeat(255))).toBeUndefined()
    expect(idProblem('ab')).toBe('An id has at least 3 characters.')
    expect(idProblem('a'.repeat(256))).toBe('An id has at most 255 characters; this one has 256.')
    expect(idProblem('1abc')).toBe('An id starts with a letter.')
    expect(idProblem('-abc')).toBe('An id starts with a letter.')
    expect(idProblem('')).toBe('Enter an id.')
  })

  it('name the character that cannot be in an id', () => {
    expect(idProblem('or ders')).toBe(
      'A space cannot be in an id: use letters, digits and - _ . ~ + %.',
    )
    expect(idProblem('orders/x')).toBe(
      '“/” cannot be in an id: use letters, digits and - _ . ~ + %.',
    )
    expect(idProblem('ordérs')).toBe('“é” cannot be in an id: use letters, digits and - _ . ~ + %.')
  })

  it('refuse the goog prefix, lowercase only, as the recorded emulator does', () => {
    expect(idProblem('googTopic')).toBe('An id cannot start with goog.')
    expect(idProblem('GoogTopic')).toBeUndefined()
    expect(idProblem('gooTopic')).toBeUndefined()
  })
})

describe('resource names (U-01)', () => {
  it('are built from and read back into their parts', () => {
    const name = fullName('demo', 'topics', 'orders')
    expect(name).toBe('projects/demo/topics/orders')
    expect(shortName(name)).toBe('orders')
    expect(projectOf(name, 'topics')).toBe('demo')
    expect(projectOf(name, 'subscriptions')).toBeUndefined()
    expect(shortName('')).toBe('')
    expect(shortName(null)).toBe('')
  })

  it('travel as an id under the page project, else whole', () => {
    expect(searchValue('projects/demo/topics/orders', 'topics', 'demo')).toBe('orders')
    expect(searchValue('projects/other/topics/orders', 'topics', 'demo')).toBe(
      'projects/other/topics/orders',
    )
    expect(searchValue('projects//topics/orders', 'topics', '')).toBe('projects//topics/orders')
  })
})

const counters = (name: string) => ({
  name,
  backlog: 0,
  available: 0,
  outstanding: 0,
  pushing: 0,
  retainedAcked: 0,
  backlogBytes: 0,
  oldestUnackedAt: null,
  redelivered: 0,
  ackedTotal: 0,
  deadLetteredTotal: 0,
  blockedKeys: 0,
  consumers: { streaming: 0, waitingPulls: 0, lastPullAt: null },
})

const subscription = (project: string, id: string, topic: string | null) => ({
  name: `projects/${project}/subscriptions/${id}`,
  project,
  id,
  topic,
  delivery: 'pull',
  managed: 'no' as const,
  ordering: false,
  exactlyOnce: false,
  deadLetterTopic: null,
  filter: null,
  counters: counters(`projects/${project}/subscriptions/${id}`),
})

const index: PubsubTopicIndex = {
  project: 'demo',
  otherProjects: [],
  detached: [subscription('demo', 'left-behind', null)],
  revision: 1,
  items: ['orders', 'payments', 'orders-dead'].map((id) => ({
    name: `projects/demo/topics/${id}`,
    project: 'demo',
    id,
    kind: 'user' as const,
    scheduleFunction: null,
    schema: null,
    counters: {
      name: `projects/demo/topics/${id}`,
      published: 0,
      lastPublishedAt: null,
      latestMessageId: null,
      mostBehind: null,
    },
    subscriptions:
      id === 'orders'
        ? [
            subscription('demo', 'orders-worker', 'projects/demo/topics/orders'),
            subscription('other', 'cross', 'projects/demo/topics/orders'),
          ]
        : [],
    functions: [],
  })),
  nextCursor: null,
  prevCursor: null,
  total: { count: 3, exact: true },
  scanned: null,
}

describe('what the path field names (U-01)', () => {
  it('a topic id, a topic/subscription, a subscription id or a full name', () => {
    expect(resolveTyped('orders', index, 'demo')).toEqual({ topic: 'projects/demo/topics/orders' })
    expect(resolveTyped('orders/orders-worker', index, 'demo')).toEqual({
      topic: 'projects/demo/topics/orders',
      subscription: 'projects/demo/subscriptions/orders-worker',
    })
    expect(resolveTyped('orders-worker', index, 'demo')).toEqual({
      topic: 'projects/demo/topics/orders',
      subscription: 'projects/demo/subscriptions/orders-worker',
    })
    expect(resolveTyped('projects/other/subscriptions/cross', index, 'demo')).toEqual({
      topic: 'projects/demo/topics/orders',
      subscription: 'projects/other/subscriptions/cross',
    })
    expect(resolveTyped('left-behind', index, 'demo')).toEqual({
      subscription: 'projects/demo/subscriptions/left-behind',
    })
    expect(resolveTyped('nothing', index, 'demo')).toBeUndefined()
    expect(resolveTyped('orders/nothing', index, 'demo')).toBeUndefined()
  })

  it('finds a subscription wherever the index lists it', () => {
    expect(findSubscription(index, 'projects/demo/subscriptions/left-behind')?.topic).toBeNull()
    expect(findSubscription(undefined, 'x')).toBeUndefined()
  })

  it('completes topic ids, prefixes first, then subscriptions after a slash', () => {
    expect(scopeCompletions('ord', index).map((completion) => completion.label)).toEqual([
      'orders',
      'orders-dead',
    ])
    expect(scopeCompletions('dead', index).map((completion) => completion.label)).toEqual([
      'orders-dead',
    ])
    expect(scopeCompletions('orders/', index).map((completion) => completion.label)).toEqual([
      'orders/orders-worker',
      'orders/cross',
    ])
  })
})
