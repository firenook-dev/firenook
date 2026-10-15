// Pub/Sub's server state: the query keys every page and live handler
// agrees on, and the query options built on the API. Keys follow the
// console's shape, `['pubsub', project, kind, …]`, the project being the one
// the page shows (`useConsoleProject`), so the live topics refresh by prefix
// exactly what changed and `?project=` never mixes two projects' data.
//
// Lists the engine pages are cursor lists for `useCursorRows`: each helper
// answers the query key, the page fetcher, the row key, the batch read and
// the infinite options together, so a page writes
//
//   const list = messageList(project, topic, q, expr)
//   const query = useInfiniteQuery(list.options)
//   const rows = useCursorRows(query, { ...list, q })
//
// and live keys go to `rows.applyKeys`. The bounded lists (topics, schemas,
// schedules, refusals) are one page holding every item.

import { queryOptions } from '@tanstack/react-query'
import type { PubsubBacklogState } from '@/api/generated/messaging/PubsubBacklogState'
import type { PubsubDeliveryPage } from '@/api/generated/messaging/PubsubDeliveryPage'
import type { PubsubFunctionMark } from '@/api/generated/messaging/PubsubFunctionMark'
import type { PubsubMessageCheckBody } from '@/api/generated/messaging/PubsubMessageCheckBody'
import type { PubsubPublishBody } from '@/api/generated/messaging/PubsubPublishBody'
import type { PubsubSchemaExampleBody } from '@/api/generated/messaging/PubsubSchemaExampleBody'
import type { CursorPages } from '@/components/console/use-cursor-rows'
import { cursorPagesOptions } from '@/components/console/use-cursor-rows'
import {
  type PageAt,
  batchGetBacklog,
  batchGetDeliveries,
  batchGetMessages,
  checkFilter,
  checkMessage,
  checkSchema,
  getBacklog,
  getDeliveries,
  getDispatch,
  getMessage,
  getMessages,
  getRejected,
  getSchedules,
  getSchema,
  getSchemas,
  getSetup,
  getSubscription,
  getTopic,
  getTopicIndex,
  previewPublish,
  schemaExample,
} from './api'
import { catchUpIndex, countersLog } from './counters'

export const pubsubKeys = {
  /** Everything of one project: what a `reset` of every topic would refresh. */
  section: (project: string) => ['pubsub', project] as const,
  /** The topics index (the panel tree, the landing grid, completion). */
  topics: (project: string) => ['pubsub', project, 'topics'] as const,
  /** Every topic detail of the project (a prefix). */
  topicDetails: (project: string) => ['pubsub', project, 'topic'] as const,
  topic: (project: string, name: string) => ['pubsub', project, 'topic', name] as const,
  /** Every subscription detail of the project (a prefix). */
  subscriptionDetails: (project: string) => ['pubsub', project, 'subscription'] as const,
  subscription: (project: string, name: string) =>
    ['pubsub', project, 'subscription', name] as const,
  /** Every message list of a topic, whatever its filters (a prefix). */
  topicMessages: (project: string, topic: string) =>
    ['pubsub', project, 'messages', topic] as const,
  messages: (project: string, topic: string, q = '', expr = '') =>
    ['pubsub', project, 'messages', topic, q, expr] as const,
  /** Every message detail of a topic (a prefix). */
  topicMessageDetails: (project: string, topic: string) =>
    ['pubsub', project, 'message', topic] as const,
  message: (project: string, topic: string, id: string) =>
    ['pubsub', project, 'message', topic, id] as const,
  dispatch: (
    project: string,
    topic: string,
    id: string,
    functionId: string,
    eventId = '',
    mark = '',
  ) => ['pubsub', project, 'dispatch', topic, id, functionId, eventId, mark] as const,
  /** Every backlog list of a subscription (a prefix). */
  subscriptionBacklog: (project: string, subscription: string) =>
    ['pubsub', project, 'backlog', subscription] as const,
  backlog: (project: string, subscription: string, state?: PubsubBacklogState) =>
    ['pubsub', project, 'backlog', subscription, state ?? 'all'] as const,
  /** Every deliveries list of a topic (a prefix). */
  topicDeliveries: (project: string, topic: string) =>
    ['pubsub', project, 'deliveries', topic] as const,
  deliveries: (project: string, topic: string, functionId?: string, outcome?: PubsubFunctionMark) =>
    ['pubsub', project, 'deliveries', topic, functionId ?? '', outcome ?? 'all'] as const,
  /** A topic's delivery counts by outcome, over every delivery kept (one function's, or all). */
  deliveryCounts: (project: string, topic: string, functionId?: string) =>
    ['pubsub', project, 'deliveries', topic, functionId ?? '', 'counts'] as const,
  schemas: (project: string) => ['pubsub', project, 'schemas'] as const,
  /** Every schema detail of the project (a prefix). */
  schemaDetails: (project: string) => ['pubsub', project, 'schema'] as const,
  schema: (project: string, name: string) => ['pubsub', project, 'schema', name] as const,
  schedules: (project: string) => ['pubsub', project, 'schedules'] as const,
  rejected: (project: string) => ['pubsub', project, 'rejected'] as const,
  setup: (project: string) => ['pubsub', project, 'setup'] as const,
  /** Checks the pages make as text is typed: read-only answers, keyed by what was asked. */
  check: (project: string, kind: string, ...asked: readonly (string | undefined)[]) =>
    ['pubsub', project, 'check', kind, ...asked.map((part) => part ?? '')] as const,
}

/** How long an answer to a check of typed text is kept once nothing reads it. */
const CHECK_GC_MS = 30_000

/**
 * The topics index. Counters frames keep it current (`usePubsubCounters`);
 * a re-read catches up with the frames that arrived while it was out.
 */
export const topicIndexQuery = (project: string) =>
  queryOptions({
    queryKey: pubsubKeys.topics(project),
    queryFn: async ({ signal }) => {
      const index = await getTopicIndex(project, signal)
      return catchUpIndex(index, countersLog.newerThan(project, index.revision))
    },
    enabled: project !== '',
  })

export const topicQuery = (project: string, name: string) =>
  queryOptions({
    queryKey: pubsubKeys.topic(project, name),
    queryFn: ({ signal }) => getTopic(name, signal),
    enabled: project !== '' && name !== '',
  })

export const subscriptionQuery = (project: string, name: string) =>
  queryOptions({
    queryKey: pubsubKeys.subscription(project, name),
    queryFn: ({ signal }) => getSubscription(name, signal),
    enabled: project !== '' && name !== '',
  })

export const messageQuery = (project: string, topic: string, id: string) =>
  queryOptions({
    queryKey: pubsubKeys.message(project, topic, id),
    queryFn: ({ signal }) => getMessage(topic, id, signal),
    enabled: project !== '' && topic !== '' && id !== '',
  })

/**
 * The request one delivery of a function received. It never changes once
 * recorded; before that (queued, running) it is rebuilt, so the delivery's
 * mark is in the key and a delivery that moves on is read again.
 */
export const dispatchQuery = (
  project: string,
  topic: string,
  id: string,
  functionId: string,
  eventId?: string,
  mark?: PubsubFunctionMark,
) =>
  queryOptions({
    queryKey: pubsubKeys.dispatch(project, topic, id, functionId, eventId, mark),
    queryFn: ({ signal }) => getDispatch(topic, id, functionId, eventId, signal),
    staleTime: Number.POSITIVE_INFINITY,
  })

export const rejectedQuery = (project: string) =>
  queryOptions({
    queryKey: pubsubKeys.rejected(project),
    queryFn: ({ signal }) => getRejected(project, signal),
    enabled: project !== '',
  })

export const schemasQuery = (project: string) =>
  queryOptions({
    queryKey: pubsubKeys.schemas(project),
    queryFn: ({ signal }) => getSchemas(project, signal),
    enabled: project !== '',
  })

export const schemaQuery = (project: string, name: string) =>
  queryOptions({
    queryKey: pubsubKeys.schema(project, name),
    queryFn: ({ signal }) => getSchema(name, signal),
    enabled: project !== '' && name !== '',
  })

export const schedulesQuery = (project: string) =>
  queryOptions({
    queryKey: pubsubKeys.schedules(project),
    queryFn: ({ signal }) => getSchedules(project, signal),
    enabled: project !== '',
  })

export const setupQuery = (project: string) =>
  queryOptions({
    queryKey: pubsubKeys.setup(project),
    queryFn: ({ signal }) => getSetup(project, signal),
    enabled: project !== '',
  })

// ------------------------------------------------------------ cursor lists

/** A topic's history, newest first; rows keyed by message id. */
export function messageList(project: string, topic: string, q?: string, expr?: string) {
  const queryKey = pubsubKeys.messages(project, topic, q, expr)
  const fetchPage = (page: PageAt, signal: AbortSignal) =>
    getMessages({ topic, q, expr }, page, signal)
  return {
    queryKey,
    fetchPage,
    rowKey: (row: { id: string }) => row.id,
    batchGet: (request: Parameters<typeof batchGetMessages>[1], signal: AbortSignal) =>
      batchGetMessages({ topic, expr }, request, signal),
    options: {
      ...cursorPagesOptions(queryKey, fetchPage),
      enabled: project !== '' && topic !== '',
    },
  }
}

/** A subscription's backlog in delivery order; rows keyed by their position, so a moved row is a new key. */
export function backlogList(project: string, subscription: string, state?: PubsubBacklogState) {
  const queryKey = pubsubKeys.backlog(project, subscription, state)
  const fetchPage = (page: PageAt, signal: AbortSignal) =>
    getBacklog({ subscription, state }, page, signal)
  return {
    queryKey,
    fetchPage,
    rowKey: (row: { key: string }) => row.key,
    batchGet: (request: Parameters<typeof batchGetBacklog>[1], signal: AbortSignal) =>
      batchGetBacklog({ subscription, state }, request, signal),
    options: {
      ...cursorPagesOptions(queryKey, fetchPage),
      enabled: project !== '' && subscription !== '',
    },
  }
}

/** A topic's deliveries to functions, newest first; rows keyed by event id. */
export function deliveryList(
  project: string,
  topic: string,
  functionId?: string,
  outcome?: PubsubFunctionMark,
) {
  const queryKey = pubsubKeys.deliveries(project, topic, functionId, outcome)
  const fetchPage = (page: PageAt, signal: AbortSignal) =>
    getDeliveries({ topic, function: functionId, outcome }, page, signal)
  return {
    queryKey,
    fetchPage,
    rowKey: (row: { eventId: string }) => row.eventId,
    // The engine reads a delivery by event id whatever the list's narrowing;
    // one that no longer matches it (a queued delivery that ran, under
    // "Queued") leaves the list, as it would on a fresh read.
    batchGet: async (request: Parameters<typeof batchGetDeliveries>[1], signal: AbortSignal) => {
      const answer = await batchGetDeliveries(topic, request, signal)
      if (functionId === undefined && outcome === undefined) return answer
      return {
        ...answer,
        items: answer.items.map((item) =>
          item.row &&
          ((functionId !== undefined && item.row.functionId !== functionId) ||
            (outcome !== undefined && item.row.mark !== outcome))
            ? { key: item.key, row: null, page: null }
            : item,
        ),
      }
    },
    options: {
      ...cursorPagesOptions(queryKey, fetchPage),
      enabled: project !== '' && topic !== '',
    },
  }
}

/**
 * A topic's delivery counts by outcome (one function's, or every one), read
 * on their own so the outcome switch stays current wherever the list is
 * scrolled: a one-row page carries them.
 */
export const deliveryCountsQuery = (project: string, topic: string, functionId?: string) =>
  queryOptions({
    queryKey: pubsubKeys.deliveryCounts(project, topic, functionId),
    queryFn: async ({ signal }) =>
      (await getDeliveries({ topic, function: functionId }, { limit: 1 }, signal)).counts,
    enabled: project !== '' && topic !== '',
  })

/** The outcome counts a deliveries list's first page carries (over every delivery kept). */
export function deliveryCountsOf(
  data: CursorPages<unknown> | undefined,
): PubsubDeliveryPage['counts'] | undefined {
  const first = data?.pages[0] as Partial<PubsubDeliveryPage> | undefined
  return first?.counts
}

// ------------------------------------------------------------ checks

/** Whether a subscription filter parses, and what it would pass of the topic's history. */
export const filterCheckQuery = (project: string, filter: string, topic?: string) =>
  queryOptions({
    queryKey: pubsubKeys.check(project, 'filter', topic, filter),
    queryFn: ({ signal }) => checkFilter({ filter, ...(topic ? { topic } : {}) }, signal),
    enabled: project !== '' && filter.trim() !== '',
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: CHECK_GC_MS,
  })

/** Whether a schema definition parses. */
export const schemaCheckQuery = (project: string, kind: string, definition: string) =>
  queryOptions({
    queryKey: pubsubKeys.check(project, 'schema', kind, definition),
    queryFn: ({ signal }) => checkSchema({ kind, definition }, signal),
    enabled: project !== '' && definition.trim() !== '',
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: CHECK_GC_MS,
  })

/** Whether a message passes a topic's bound schema revision. */
export const messageCheckQuery = (project: string, body: PubsubMessageCheckBody) =>
  queryOptions({
    queryKey: pubsubKeys.check(project, 'message', JSON.stringify(body)),
    queryFn: ({ signal }) => checkMessage(body, signal),
    enabled: project !== '',
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: CHECK_GC_MS,
  })

/** An example message for a topic's bound revision or an unsaved definition. */
export const schemaExampleQuery = (project: string, body: PubsubSchemaExampleBody) =>
  queryOptions({
    queryKey: pubsubKeys.check(project, 'example', JSON.stringify(body)),
    queryFn: ({ signal }) => schemaExample(body, signal),
    enabled: project !== '',
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: CHECK_GC_MS,
  })

/** Message 1 of a draft as the engine would publish it (templates expanded). */
export const publishPreviewQuery = (project: string, body: Omit<PubsubPublishBody, 'dryRun'>) =>
  queryOptions({
    queryKey: pubsubKeys.check(project, 'preview', JSON.stringify(body)),
    queryFn: ({ signal }) => previewPublish(body, signal),
    enabled: project !== '' && body.topic !== '' && body.messages.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: CHECK_GC_MS,
  })
