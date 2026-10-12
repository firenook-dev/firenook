// Every view of the Eventarc pages is a link: the channel in scope, the
// filter, the event open, the publish drawer (and the event it was filled
// from), and whether the feed is paused. Defaults never appear in the
// address: no channel is every channel, no `paused` is following. The
// route files read these schemas; the pages read the state through
// `useRouteSearch`, so the first route carries the schemas alone.

import { z } from 'zod'
import { zFlag } from '@/lib/search-params'

export const eventsSearch = z.object({
  /** The scope: a channel's full resource name, or `google` for the native channel. */
  channel: z.string().optional(),
  /** `type:… source:… subject:… delivery:delivered|filtered|unheard|failed|pending words`. */
  q: z.string().optional(),
  /** The event open in the inspector, by id (`<nonce>-<seq>`). */
  event: z.string().optional(),
  /** The publish drawer. */
  new: z.literal('event').optional(),
  /** Edit and publish (`Shift+R`): the drawer filled from this event, then dropped. */
  prefill: z.string().optional(),
  /** The feed holds still; written with `replace`. */
  paused: zFlag,
})

export type EventsSearch = z.infer<typeof eventsSearch>

export const channelsSearch = z.object({
  /** The channel the page scrolls to and lights. */
  channel: z.string().optional(),
})

export type ChannelsSearch = z.infer<typeof channelsSearch>
