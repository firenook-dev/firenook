import { createFileRoute } from '@tanstack/react-router'
import { statusQuery } from '@/api/queries'
import { OverviewPage } from '@/overview/components/overview-page'
import { engineQuery, overviewQuery } from '@/overview/queries'
import { overviewSearchSchema } from '@/overview/search'

// The Overview: what runs, where, whether it is healthy, the newest
// problems, how to connect an app, the data and the engine. The status is
// awaited (everything on the page reads it); the overview state and the
// engine's configuration are fetched beside it, and a part whose request
// failed says so in its own place rather than failing the page.
export const Route = createFileRoute('/')({
  validateSearch: overviewSearchSchema,
  loader: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(statusQuery)
    await Promise.all([
      context.queryClient.prefetchQuery(overviewQuery(status.projectId)),
      context.queryClient.prefetchQuery(engineQuery(status.projectId)),
    ])
  },
  component: OverviewPage,
})
