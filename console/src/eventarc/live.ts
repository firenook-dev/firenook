// Eventarc kept current by the live channel: `eventarc.events` sends one
// 100 ms window per event (`batch`) — the events that arrived, each row
// sent again (the newest summary) whenever one of its deliveries changes —
// filtered by the subscription's channel and `q` in the engine, 50 rows a
// window with a count of the rest. The page upserts the rows into its feed;
// the channels' counts and an open event are read again.

import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { EventarcEventSummary } from '@/api/generated/compute/EventarcEventSummary'
import type { EventarcLiveBatch } from '@/api/generated/compute/EventarcLiveBatch'
import type { ResetReason } from '@/api/generated/live/ResetReason'
import { statusQuery } from '@/api/queries'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { declareTopic } from '@/lib/live/topics'
import { createInvalidator, useLiveTopic } from '@/lib/live/use-live-topic'
import { eventarcKeys } from './api'

/** `eventarc.events`' parameters: one channel's events or every channel's, filtered by `q`. */
export interface EventarcEventsParams {
  /** A channel's full name, or `google` for the native channel. */
  channel?: string
  /** The event filter, in the shared grammar. */
  q?: string
}

declare module '@/lib/live/topics' {
  interface TopicMap {
    'eventarc.events': { params: EventarcEventsParams; events: { batch: EventarcLiveBatch } }
  }
}

declareTopic('eventarc.events', 'replay')

/**
 * What a window makes stale besides the feed: each event it names (an open
 * event re-reads its deliveries) and, when it holds any, the channels'
 * counts — read again rather than counted here, since a row comes again
 * for every delivery change and must not count twice.
 */
export function batchKeys(project: string, batch: Pick<EventarcLiveBatch, 'items'>) {
  if (batch.items.length === 0) return []
  return [
    eventarcKeys.channels(project),
    ...batch.items.map((item) => eventarcKeys.event(project, item.id)),
  ]
}

/** Invalidates with a leading and a trailing edge per key, so a burst reads the channels once or twice. */
function useInvalidator(client: QueryClient) {
  const [invalidator] = useState(() =>
    createInvalidator((key) => void client.invalidateQueries({ queryKey: key }), 120),
  )
  useEffect(() => () => invalidator.dispose(), [invalidator])
  return invalidator
}

/**
 * Holds the page's `eventarc.events` subscription (`params: null` = not
 * now; pass the first page's `liveCursor` as `after`). The page gets the
 * rows for its feed and the burst count for its marker row.
 */
export function useEventarcEvents(
  params: EventarcEventsParams | null,
  options: {
    after?: string | undefined
    /** Event rows, newest last: `upsert` into the page's `FeedStore` (a later delivery replaces the row). */
    onItems?: (items: readonly EventarcEventSummary[]) => void
    onBurst?: (count: number) => void
    /** After the section's queries were invalidated: reload what the page shows. */
    onReset?: (reason: ResetReason, missed: number | null) => void
  } = {},
): SubscriptionStatus {
  const client = useQueryClient()
  const project = useQuery(statusQuery).data?.projectId ?? ''
  const invalidator = useInvalidator(client)
  return useLiveTopic(
    'eventarc.events',
    params,
    {
      onBatch: (batch) => {
        invalidator.push(batchKeys(project, batch))
        if (batch.items.length > 0) options.onItems?.(batch.items)
        if (batch.burst !== null && batch.burst > 0) options.onBurst?.(batch.burst)
      },
      onReset: (reason, missed) => {
        invalidator.flush([eventarcKeys.all(project)])
        options.onReset?.(reason, missed)
      },
    },
    undefined,
    { after: options.after },
  )
}
