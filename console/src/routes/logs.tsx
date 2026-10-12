import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { SectionFrame } from '@/components/console/section-gate'
import { UnbuiltSection } from '@/components/section-placeholder'
import { zFlag } from '@/lib/search-params'
import { logs } from '@/lib/sections/logs'
import { LogsPage } from '@/logs/components/logs-page'

// Every view of the log is a link: the filter, the window, the line in the
// inspector, where "new since your last visit" begins, and whether the
// feed is paused.
const searchSchema = z.object({
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

export type LogsSearch = z.infer<typeof searchSchema>

export const Route = createFileRoute('/logs')({
  validateSearch: searchSchema,
  // A Google Emulator UI link (`?q=metadata.function.name="us-central1-hello"`)
  // opens the same view here: its query is written in ours, once, in place.
  // Only a query with a `key=value` pair can be one, and only then is the
  // reader loaded: it stays out of the first route's bundle.
  beforeLoad: async ({ search }) => {
    if (search.q === undefined || !search.q.includes('=')) return
    const { fromLegacyQuery } = await import('@/logs/legacy')
    const q = fromLegacyQuery(search.q)
    if (q !== undefined) throw redirect({ to: '/logs', search: { ...search, q }, replace: true })
  },
  component: LogsRoute,
})

// Logs stays behind its placeholder until its journeys pass (`built` in the
// registry): nothing is presented as available before it works.
function LogsRoute() {
  if (!logs.built) return <UnbuiltSection section={logs} />
  return (
    <SectionFrame section="logs">
      <LogsPage />
    </SectionFrame>
  )
}
