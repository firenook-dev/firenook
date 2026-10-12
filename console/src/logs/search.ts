// The Logs page's address: every view of the log is a link — the filter,
// the window, the line in the inspector, where "new since your last visit"
// begins, and whether the feed is paused. Nothing else is read: a param of
// another tool's making (`fn=`, `exec=`, `function=`) is not a filter, and
// a Google Emulator UI `q` is rewritten by the route (`legacy.ts`).
//
// The route file imports this (its schema is in the first route's bundle),
// so it holds zod only.

import { z } from 'zod'
import { zFlag } from '@/lib/search-params'

export const logsSearchSchema = z.object({
  // The filter, in the console's filter language with the Logs fields, e.g.
  // `level:error function:us-central1-hello -"heartbeat ok" payload.orderId:"o_1" /timed? out/i`.
  q: z.string().optional(),
  // The window: RFC 3339 or relative (`-5m`); `from=reload` is since the
  // last Functions reload. Absent: every line the engine keeps.
  from: z.string().optional(),
  to: z.string().optional(),
  // The line in the inspector, by its engine cursor; a line not on screen
  // opens the list paused around it.
  entry: z.string().optional(),
  // Lines after this cursor follow a "New since your last visit" marker (the badge's link).
  since: z.string().optional(),
  // The feed holds still; only in the URL while it does.
  paused: zFlag,
})

export type LogsSearch = z.infer<typeof logsSearchSchema>
