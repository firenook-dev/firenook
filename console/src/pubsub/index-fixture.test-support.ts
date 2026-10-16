// A topics index for unit tests, built the way the engine answers one, so a
// test states only what it is about.

import type { PubsubSubscriptionSummary } from '@/api/generated/messaging/PubsubSubscriptionSummary'
import type { PubsubTopicIndex } from '@/api/generated/messaging/PubsubTopicIndex'
import type { PubsubTopicSummary } from '@/api/generated/messaging/PubsubTopicSummary'

export const PROJECT = 'demo'

export function subscriptionSummary(
  id: string,
  topic: string | null,
  overrides: Partial<Omit<PubsubSubscriptionSummary, 'counters'>> & {
    counters?: Partial<PubsubSubscriptionSummary['counters']>
  } = {},
): PubsubSubscriptionSummary {
  const name = `projects/${PROJECT}/subscriptions/${id}`
  const { counters, ...rest } = overrides
  return {
    name,
    project: PROJECT,
    id,
    topic: topic === null ? null : `projects/${PROJECT}/topics/${topic}`,
    delivery: 'pull',
    managed: 'no',
    ordering: false,
    exactlyOnce: false,
    deadLetterTopic: null,
    filter: null,
    ...rest,
    counters: {
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
      ...counters,
    },
  }
}

export function topicSummary(
  id: string,
  overrides: Partial<Omit<PubsubTopicSummary, 'counters'>> & {
    counters?: Partial<PubsubTopicSummary['counters']>
  } = {},
): PubsubTopicSummary {
  const name = `projects/${PROJECT}/topics/${id}`
  const { counters, ...rest } = overrides
  return {
    name,
    project: PROJECT,
    id,
    kind: 'user',
    scheduleFunction: null,
    schema: null,
    subscriptions: [],
    functions: [],
    ...rest,
    counters: {
      name,
      published: 0,
      lastPublishedAt: null,
      latestMessageId: null,
      mostBehind: null,
      ...counters,
    },
  }
}

export function topicIndex(
  items: PubsubTopicSummary[],
  overrides: Partial<PubsubTopicIndex> = {},
): PubsubTopicIndex {
  return {
    project: PROJECT,
    otherProjects: [],
    detached: [],
    revision: 1,
    items,
    nextCursor: null,
    prevCursor: null,
    total: { count: items.length, exact: true },
    scanned: null,
    ...overrides,
  }
}
