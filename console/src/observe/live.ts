// Observe's two live topics, declared once for both pages that use them:
// the Logs feed (`logs.entries`) and the Overview's state (`overview`).
// Importing this file declares how each resumes; the `TopicMap`
// augmentation types `useLiveTopic` for them.
//
// - `logs.entries` replays from the engine's log ring by each subscriber's
//   own cursor (`<epoch>.<seq>`), so two Logs tabs are never one engine
//   subscription. Its `entries` event carries up to 1,000 lines, oldest
//   first; the hub's `tick` moves the cursor alone and `reset gap` says how
//   many lines a resume could not replay.
// - `overview` is a state topic: one engine subscription for the browser,
//   the latest `state` handed to a newcomer, a resume that sends nothing
//   when the engine's generation has not moved.

import type { LogPage } from '@/api/generated/observe/LogPage'
import type { OverviewState } from '@/api/generated/observe/OverviewState'
import { declareTopic } from '@/lib/live/topics'

/**
 * What `logs.entries` takes: the same filter as `GET /logs/entries`. The
 * engine refuses anything else (`deny_unknown_fields`).
 */
export interface LogsTopicParams {
  /** The filter, in the console's filter language with the Logs fields. */
  q?: string
  /** RFC 3339, relative (`-5m`) or `reload`. */
  from?: string
  to?: string
}

/** One `entries` event: the lines, oldest first, as a page carries them. */
export type LogEntries = Pick<LogPage, 'items'>

declare module '@/lib/live/topics' {
  interface TopicMap {
    'logs.entries': { params: LogsTopicParams; events: { entries: LogEntries } }
    overview: { params: Record<string, never>; events: { state: OverviewState } }
  }
}

declareTopic('logs.entries', 'replay')
declareTopic('overview', 'compare')
