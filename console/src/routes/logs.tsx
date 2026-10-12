import { createFileRoute, redirect } from '@tanstack/react-router'
import { SectionFrame } from '@/components/console/section-gate'
import { UnbuiltSection } from '@/components/section-placeholder'
import { logs } from '@/lib/sections/logs'
import { LogsPage } from '@/logs/components/logs-page'
import { logsSearchSchema } from '@/logs/search'

// Every view of the log is a link (`logs/search.ts`).
export const Route = createFileRoute('/logs')({
  validateSearch: logsSearchSchema,
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
