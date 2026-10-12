import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { SectionFrame } from '@/components/console/section-gate'
import { FirestoreWorkbench } from '@/firestore/components/workbench'

// Every view of the workbench is a link: the path, the query, who it is
// viewed as, the open document and its tab all live here.
const searchSchema = z.object({
  db: z.string().optional(),
  path: z.string().optional(),
  q: z.string().optional(),
  group: z.boolean().optional(),
  as: z.string().optional(),
  doc: z.string().optional(),
  tab: z.enum(['fields', 'json']).optional(),
  // Another project the app used, shown instead of the emulator's own
  // (the shell's foreign-project banner links here with it).
  project: z.string().optional(),
  // The rules were a mode of this page once (`?view=rules`); they are a
  // page of their own now, and the old address still leads there.
  view: z.enum(['rules']).optional(),
})

export type FirestoreSearch = z.infer<typeof searchSchema>

export const Route = createFileRoute('/firestore')({
  validateSearch: searchSchema,
  beforeLoad: ({ search }) => {
    if (search.view === 'rules')
      throw redirect({ to: '/firestore/rules', search: { db: search.db }, replace: true })
  },
  component: FirestorePage,
})

function FirestorePage() {
  return (
    <SectionFrame section="firestore">
      <FirestoreWorkbench />
    </SectionFrame>
  )
}
