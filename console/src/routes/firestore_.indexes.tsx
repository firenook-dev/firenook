import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { z } from 'zod'
import { SectionFrame } from '@/components/console/section-gate'
import { IndexesPage } from '@/firestore/indexes-page/indexes-page'

// The indexes of one database, as a page of their own: the file they are
// declared in, the ones the app's queries needed, and what the file
// declares. The database is a link, as on the Rules page.
const searchSchema = z.object({
  db: z.string().optional(),
})

export const Route = createFileRoute('/firestore_/indexes')({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams({})] },
  component: IndexesRoute,
})

// The index files belong to the emulator's own project, as the rules do:
// this page shows no other project's.
function IndexesRoute() {
  return (
    <SectionFrame section="firestore" projectScope={false}>
      <IndexesPage />
    </SectionFrame>
  )
}
