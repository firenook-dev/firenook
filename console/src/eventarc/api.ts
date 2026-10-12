// The Eventarc section's conversation with the engine: every route of
// `/console/api/v1/eventarc` (compute spec §7.5), the keys they are cached
// under, and the query options the pages read them through. Keys are
// `['eventarc', project, …]`, refreshed by `eventarc.events` (`./live.ts`)
// and by a reload in Functions (which can change who listens).
//
// A channel's name holds `/`, so publishing names it in the body
// (`POST /eventarc/channel/publish`), never in the path.

import { queryOptions } from '@tanstack/react-query'
import { apiGet, apiSend } from '@/api/client'
import type { EventarcEventView } from '@/api/generated/compute/EventarcEventView'
import type { EventarcEventsResult } from '@/api/generated/compute/EventarcEventsResult'
import type { EventarcPublishRequest } from '@/api/generated/compute/EventarcPublishRequest'
import type { EventarcPublishResult } from '@/api/generated/compute/EventarcPublishResult'
import type { EventarcReplayRequest } from '@/api/generated/compute/EventarcReplayRequest'
import type { EventarcSnapshot } from '@/api/generated/compute/EventarcSnapshot'

/** The engine keeps this many Eventarc events (`MonitorLimits.events`). */
export const EVENTS_KEPT = 1_000

/** Events per page: the engine's default and the list's step. */
export const EVENT_PAGE = 200

/** The native channel's name, where Firebase's own events (alerts) arrive. */
export const NATIVE_CHANNEL = 'google'

const enc = encodeURIComponent

/** Every query key of the section. */
export const eventarcKeys = {
  all: (project: string) => ['eventarc', project] as const,
  /** `GET /eventarc/channels`: every channel with its publishers, subscribers and counts. */
  channels: (project: string) => ['eventarc', project, 'channels'] as const,
  /** Every list of events, whatever its scope and filter. */
  events: (project: string) => ['eventarc', project, 'events'] as const,
  /** The newest page of events on `channel` (`''` for every channel) matching `q`. */
  eventPage: (project: string, channel: string, q: string) =>
    ['eventarc', project, 'events', channel, q] as const,
  event: (project: string, id: string) => ['eventarc', project, 'event', id] as const,
}

/** Every channel in use, the native one, whether alerts are delivered, and where `eventarc.events` resumes. */
export function getChannels(signal?: AbortSignal): Promise<EventarcSnapshot> {
  return apiGet<EventarcSnapshot>('/eventarc/channels', undefined, signal)
}

/**
 * A page of events, newest first, on one channel or all, filtered by `q`
 * in the event grammar. The first page carries the `liveCursor` the feed
 * subscribes after.
 */
export function getEvents(
  options: {
    channel?: string | undefined
    q?: string | undefined
    cursor?: string | undefined
    limit?: number | undefined
  },
  signal?: AbortSignal,
): Promise<EventarcEventsResult> {
  return apiGet<EventarcEventsResult>(
    '/eventarc/events',
    {
      channel: options.channel === '' ? undefined : options.channel,
      q: options.q === '' ? undefined : options.q,
      cursor: options.cursor,
      limit: options.limit,
    },
    signal,
  )
}

/** One event with its delivery trace, each delivery's function and invocation as links into Functions. */
export function getEvent(id: string, signal?: AbortSignal): Promise<EventarcEventView> {
  return apiGet<EventarcEventView>(`/eventarc/events/${enc(id)}`, undefined, signal)
}

export const channelsQuery = (project: string) =>
  queryOptions({
    queryKey: eventarcKeys.channels(project),
    queryFn: ({ signal }) => getChannels(signal),
    staleTime: Number.POSITIVE_INFINITY,
  })

/** The newest events on a channel (`''` for all) matching `q`, and the cursor their feed resumes from. */
export const eventPageQuery = (project: string, channel: string, q: string) =>
  queryOptions({
    queryKey: eventarcKeys.eventPage(project, channel, q),
    queryFn: ({ signal }) => getEvents({ channel, q, limit: EVENT_PAGE }, signal),
    staleTime: Number.POSITIVE_INFINITY,
  })

/** One event; its row on `eventarc.events` invalidates it when a delivery changes. */
export const eventQuery = (project: string, id: string) =>
  queryOptions({
    queryKey: eventarcKeys.event(project, id),
    queryFn: ({ signal }) => getEvent(id, signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

/** Publishes an event on a channel the way the Admin SDK sends it, so it is converted and delivered as an app's would be. */
export function publishEvent(request: EventarcPublishRequest): Promise<EventarcPublishResult> {
  return apiSend<EventarcPublishResult>('POST', '/eventarc/channel/publish', request)
}

/** Publishes a kept event again: with a new id, or its own (`keepId`). */
export function replayEvent(
  id: string,
  request: EventarcReplayRequest,
): Promise<EventarcPublishResult> {
  return apiSend<EventarcPublishResult>('POST', `/eventarc/events/${enc(id)}/replay`, request)
}

/** Empties the engine's record of events. */
export async function clearEvents(): Promise<void> {
  await apiSend<undefined>('DELETE', '/eventarc/events', {})
}
