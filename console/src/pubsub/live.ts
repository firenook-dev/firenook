// Pub/Sub's live topics (messaging spec §6.2) and the hooks the pages hold
// them with. None of them opens a connection: each is a subscription on
// the console's one live channel (`useLiveTopic`), which the leader tab
// shares with the browser's other tabs.
//
// - `pubsub.counters` (state, compared by the console revision): frames
//   patch the cached topics index in place, newest only; `resources` and
//   `rejected` say which lists to read again. The Topics and Schemas pages
//   hold it.
// - `pubsub.topic` (invalidation): new message ids of the topic in view, and
//   the keys of rows that moved — backlog positions of the scoped
//   subscription, messages whose marks moved, the snapshots list.
// - `pubsub.push` (a feed): push streaks, upserted in place by streak.
// - `pubsub.deliveries` (invalidation): event ids whose outcome moved, and
//   how many deliveries are new.
// - `pubsub.schedules` (state, compared by the scheduler's revision).

import { type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { MessagingSecondWindow } from '@/api/generated/messaging/MessagingSecondWindow'
import type { Page } from '@/api/generated/Page'
import type { PubsubCountersFrame } from '@/api/generated/messaging/PubsubCountersFrame'
import type { PubsubDeliveriesChanged } from '@/api/generated/messaging/PubsubDeliveriesChanged'
import type { PubsubPublished } from '@/api/generated/messaging/PubsubPublished'
import type { PubsubPushAttempts } from '@/api/generated/messaging/PubsubPushAttempts'
import type { PubsubPushStreak } from '@/api/generated/messaging/PubsubPushStreak'
import type { PubsubRejectedChanged } from '@/api/generated/messaging/PubsubRejectedChanged'
import type { PubsubResourcesChanged } from '@/api/generated/messaging/PubsubResourcesChanged'
import type { PubsubSchedule } from '@/api/generated/messaging/PubsubSchedule'
import type { PubsubSchedulesFrame } from '@/api/generated/messaging/PubsubSchedulesFrame'
import type { PubsubStale } from '@/api/generated/messaging/PubsubStale'
import type { PubsubTopicIndex } from '@/api/generated/messaging/PubsubTopicIndex'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { type FeedStore, createFeedStore } from '@/lib/live/feed-store'
import { declareTopic } from '@/lib/live/topics'
import { createInvalidator, useLiveTopic } from '@/lib/live/use-live-topic'
import { applyCountersFrame, countersLog } from './counters'
import { pubsubKeys } from './queries'

declare module '@/lib/live/topics' {
  interface TopicMap {
    'pubsub.counters': {
      params: { project?: string; throughput?: string[] }
      events: {
        counters: PubsubCountersFrame
        resources: PubsubResourcesChanged
        rejected: PubsubRejectedChanged
      }
    }
    'pubsub.topic': {
      params: { project?: string; topic: string; subscription?: string }
      events: { published: PubsubPublished; stale: PubsubStale }
    }
    'pubsub.push': {
      params: { project?: string; subscription: string }
      events: { attempts: PubsubPushAttempts }
    }
    'pubsub.deliveries': {
      params: { project?: string; topic: string }
      events: { changed: PubsubDeliveriesChanged }
    }
    'pubsub.schedules': {
      params: { project?: string }
      events: { schedules: PubsubSchedulesFrame }
    }
  }
}

declareTopic('pubsub.counters', 'compare')
declareTopic('pubsub.topic', 'none')
declareTopic('pubsub.push', 'replay')
declareTopic('pubsub.deliveries', 'none')
declareTopic('pubsub.schedules', 'compare')

/** Topics whose throughput one counters subscription follows (the engine refuses more). */
export const MAX_THROUGHPUT = 24
/** Push streaks a Push feed holds. */
export const PUSH_FEED_MAX = 2_000
/** Push streaks the engine keeps across subscriptions, for a gap row's sentence. */
export const PUSH_RING = 20_000

// ------------------------------------------------------------ counters

/** What each `resources` kind makes stale besides the topics index. */
export function resourceKeys(project: string, kinds: readonly string[]): QueryKey[] {
  const keys: QueryKey[] = []
  for (const kind of kinds) {
    if (kind === 'topics') keys.push(pubsubKeys.topics(project), pubsubKeys.topicDetails(project))
    else if (kind === 'subscriptions')
      keys.push(
        pubsubKeys.topics(project),
        pubsubKeys.topicDetails(project),
        pubsubKeys.subscriptionDetails(project),
      )
    else if (kind === 'snapshots')
      keys.push(pubsubKeys.snapshots(project), pubsubKeys.topicDetails(project))
    else if (kind === 'schemas')
      keys.push(
        pubsubKeys.topics(project),
        pubsubKeys.schemas(project),
        pubsubKeys.schemaDetails(project),
        pubsubKeys.topicDetails(project),
      )
  }
  return keys
}

/** What the counters topic keeps current: read again on its `reset`. Lists the other topics keep are not here. */
export function countersKeys(project: string): QueryKey[] {
  return [
    pubsubKeys.topics(project),
    pubsubKeys.topicDetails(project),
    pubsubKeys.subscriptionDetails(project),
    pubsubKeys.snapshots(project),
    pubsubKeys.rejected(project),
  ]
}

/** Puts a counters frame into the cached index; reads the index again when the frame names what it lacks. */
export function applyCounters(client: QueryClient, project: string, frame: PubsubCountersFrame) {
  countersLog.record(project, frame)
  for (const entry of frame.throughput) setThroughput(project, entry.topic, entry.window)
  const key = pubsubKeys.topics(project)
  const index = client.getQueryData<PubsubTopicIndex>(key)
  if (!index) return
  const applied = applyCountersFrame(index, frame)
  if (applied.index !== index) client.setQueryData(key, applied.index)
  if (applied.unknown) void client.invalidateQueries({ queryKey: key, exact: true })
}

/**
 * Holds `pubsub.counters` for `project` while mounted (`undefined` = not
 * now), with the throughput of `throughput` (full topic names on screen:
 * the topic in view, the landing grid's cards; at most 24, more are cut).
 * Answers this subscription's status for `LiveNotice`.
 */
export function usePubsubCounters(
  project: string | undefined,
  throughput: readonly string[] = [],
): SubscriptionStatus {
  const client = useQueryClient()
  const followed = [...new Set(throughput)].toSorted().slice(0, MAX_THROUGHPUT)
  const params = project
    ? { project, ...(followed.length > 0 ? { throughput: followed } : {}) }
    : null
  const [invalidator] = useState(() =>
    createInvalidator((key) => void client.invalidateQueries({ queryKey: key }), 120),
  )
  useEffect(() => () => invalidator.dispose(), [invalidator])
  return useLiveTopic('pubsub.counters', params, {
    onCounters: (frame) => {
      if (project) applyCounters(client, project, frame)
    },
    onResources: (changed) => {
      if (project) invalidator.push(resourceKeys(project, changed.kinds))
    },
    onRejected: () => {
      if (project) invalidator.push([pubsubKeys.rejected(project)])
    },
    onReset: () => {
      if (!project) return
      countersLog.clear(project)
      invalidator.flush(countersKeys(project))
    },
  })
}

// ------------------------------------------------------------ throughput

/** The newest throughput window of each topic seen, by project; bounded. */
const THROUGHPUT_KEPT = 256
const throughputWindows = new Map<string, MessagingSecondWindow>()
const throughputListeners = new Set<() => void>()

function setThroughput(project: string, topic: string, window: MessagingSecondWindow) {
  const key = `${project}\u0000${topic}`
  throughputWindows.delete(key)
  throughputWindows.set(key, window)
  while (throughputWindows.size > THROUGHPUT_KEPT) {
    const oldest = throughputWindows.keys().next().value
    if (oldest === undefined) break
    throughputWindows.delete(oldest)
  }
  for (const listener of throughputListeners) listener()
}

function subscribeThroughput(listener: () => void): () => void {
  throughputListeners.add(listener)
  return () => {
    throughputListeners.delete(listener)
  }
}

/** A topic's newest throughput window from the counters frames (undefined before one arrived). */
export function throughputOf(project: string, topic: string): MessagingSecondWindow | undefined {
  return throughputWindows.get(`${project}\u0000${topic}`)
}

/**
 * A topic's throughput window, re-rendering when a frame brings a new one
 * (each window is a new object, so the snapshot is immutable). Age it with
 * `useAgedCount` / `useAgedBuckets` (`@/messaging/windows`); before the
 * first frame, a topic detail's own `throughput` stands in.
 */
export function useThroughput(project: string, topic: string): MessagingSecondWindow | undefined {
  const read = () => throughputOf(project, topic)
  return useSyncExternalStore(subscribeThroughput, read, read)
}

// ------------------------------------------------------------ one topic

/** The keys of a `stale` event, sorted by what they name. */
export function splitStaleKeys(keys: readonly string[]): {
  /** Backlog row keys of the scoped subscription, the `backlog:` prefix removed. */
  backlog: string[]
  /** Message ids whose subscription or function marks moved. */
  messages: string[]
  /** The topic's snapshots changed. */
  snapshots: boolean
} {
  const backlog: string[] = []
  const messages: string[] = []
  let snapshots = false
  for (const key of keys) {
    if (key.startsWith('backlog:')) backlog.push(key.slice('backlog:'.length))
    else if (key.startsWith('message:')) messages.push(key.slice('message:'.length))
    else if (key === 'snapshots') snapshots = true
  }
  return { backlog, messages, snapshots }
}

export interface TopicLiveHandlers {
  /**
   * New messages on the topic. At the top, the page reads its head page
   * again and flashes the ids above the newest it drew; scrolled away, it
   * adds `added` to the table's `newAbove`.
   */
  onPublished?: (published: PubsubPublished) => void
  /** Moved rows of the scoped subscription's backlog: the backlog table's `applyKeys`. */
  onBacklogKeys?: (keys: string[]) => void
  /** Messages whose marks moved: the message table's `applyKeys`. */
  onMessageKeys?: (ids: string[]) => void
  /** The subscription lost track (a reconnect, a burst past 1,000 keys): the page's tables go back to page one. */
  onReset?: () => void
}

/**
 * Holds `pubsub.topic` for the topic in view (and the subscription in view,
 * whose backlog rows it names). Message details and the snapshots list are
 * read again here; rows go to the handlers.
 */
export function useTopicLive(
  project: string | undefined,
  topic: string | undefined,
  subscription: string | undefined,
  handlers: TopicLiveHandlers,
): SubscriptionStatus {
  const client = useQueryClient()
  const params =
    project && topic ? { project, topic, ...(subscription ? { subscription } : {}) } : null
  return useLiveTopic('pubsub.topic', params, {
    onPublished: (published) => handlers.onPublished?.(published),
    onStale: (stale) => {
      if (!project || !topic) return
      const split = splitStaleKeys(stale.keys)
      if (split.backlog.length > 0) handlers.onBacklogKeys?.(split.backlog)
      if (split.messages.length > 0) {
        handlers.onMessageKeys?.(split.messages)
        for (const id of split.messages)
          void client.invalidateQueries({ queryKey: pubsubKeys.message(project, topic, id) })
      }
      if (split.snapshots) {
        void client.invalidateQueries({ queryKey: pubsubKeys.snapshots(project) })
        void client.invalidateQueries({ queryKey: pubsubKeys.topic(project, topic) })
      }
    },
    onReset: () => {
      if (project && topic)
        void client.invalidateQueries({ queryKey: pubsubKeys.topicMessageDetails(project, topic) })
      handlers.onReset?.()
    },
    onEnd: () => handlers.onReset?.(),
  })
}

// ------------------------------------------------------------ push

/** A Push feed's store: one row per streak, kept in place as it grows. */
export function createPushStore(): FeedStore<PubsubPushStreak> {
  return createFeedStore<PubsubPushStreak>({
    max: PUSH_FEED_MAX,
    key: (streak) => streak.streak,
    pausedMode: 'buffer',
  })
}

/**
 * Holds `pubsub.push` for a push subscription: the streaks the engine still
 * keeps, then each as it starts or grows, upserted by streak. A new store
 * per subscription; pause it with the `PauseButton`.
 */
export function usePushFeed(
  project: string | undefined,
  subscription: string | undefined,
): { store: FeedStore<PubsubPushStreak>; status: SubscriptionStatus } {
  // A new feed for each subscription: the state follows the id it was made for.
  const id = project && subscription ? `${project}\u0000${subscription}` : ''
  const [feed, setFeed] = useState(() => ({ id, store: createPushStore() }))
  let store = feed.store
  if (feed.id !== id) {
    store = createPushStore()
    setFeed({ id, store })
  }
  const status = useLiveTopic(
    'pubsub.push',
    project && subscription ? { project, subscription } : null,
    {
      onAttempts: (batch) => store.upsert(batch.items),
      onReset: (_reason, missed) => store.gap(missed, PUSH_RING),
    },
  )
  return { store, status }
}

// ------------------------------------------------------------ deliveries

export interface DeliveriesLiveHandlers {
  /** Event ids whose outcome moved: the deliveries table's `applyKeys`. */
  onKeys?: (eventIds: string[]) => void
  /** New deliveries: at the top the head page is read again, else they go to `newAbove`. */
  onAdded?: (count: number) => void
  /** Too many to name, a reconnect, or a reset: back to page one, the counts with it. */
  onReset?: () => void
}

/** Holds `pubsub.deliveries` for the topic whose Deliveries tab is open. */
export function useDeliveriesLive(
  project: string | undefined,
  topic: string | undefined,
  handlers: DeliveriesLiveHandlers,
): SubscriptionStatus {
  return useLiveTopic('pubsub.deliveries', project && topic ? { project, topic } : null, {
    onChanged: (changed) => {
      if (changed.overflow) {
        handlers.onReset?.()
        return
      }
      if (changed.keys.length > 0) handlers.onKeys?.(changed.keys)
      if (changed.added > 0) handlers.onAdded?.(changed.added)
    },
    onReset: () => handlers.onReset?.(),
    onEnd: () => handlers.onReset?.(),
  })
}

// ------------------------------------------------------------ schedules

/** A schedules frame's states put into the cached list (runs themselves come with the next read). */
export function applySchedulesFrame(
  page: Page<PubsubSchedule>,
  frame: PubsubSchedulesFrame,
): Page<PubsubSchedule> {
  const states = new Map(frame.schedules.map((state) => [state.functionId, state]))
  let changed = false
  const items = page.items.map((schedule) => {
    const state = states.get(schedule.functionId)
    if (!state) return schedule
    changed = true
    return {
      ...schedule,
      paused: state.paused,
      automatic: state.automatic,
      nextRunAt: state.nextRunAt,
      runs: state.runs,
    }
  })
  return changed ? { ...page, items } : page
}

/**
 * Holds `pubsub.schedules` (the Schedules page): each frame patches the
 * list's states at once and reads the list again shortly after, for the
 * runs and their outcomes.
 */
export function useSchedulesLive(project: string | undefined): SubscriptionStatus {
  const client = useQueryClient()
  const [invalidator] = useState(() =>
    createInvalidator((key) => void client.invalidateQueries({ queryKey: key }), 250),
  )
  useEffect(() => () => invalidator.dispose(), [invalidator])
  return useLiveTopic('pubsub.schedules', project ? { project } : null, {
    onSchedules: (frame) => {
      if (!project) return
      const key = pubsubKeys.schedules(project)
      client.setQueryData<Page<PubsubSchedule>>(key, (page) =>
        page ? applySchedulesFrame(page, frame) : page,
      )
      invalidator.push([key])
    },
    onReset: () => {
      if (project) invalidator.flush([pubsubKeys.schedules(project)])
    },
  })
}
