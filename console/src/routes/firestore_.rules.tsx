import { createFileRoute } from '@tanstack/react-router'
import type { z } from 'zod'
import { SectionFrame } from '@/components/console/section-gate'
import { RulesPage } from '@/firestore/rules-page/rules-page'
import { rulesPageSearch } from '@/rules/search'

// The security rules of one database, as a page of their own: the editor,
// and beside it what the rules decided, a playground, saved tests and the
// collections they govern. Every view of it is a link, in the rules kit's
// one schema (`db`, the panel, the decision, how the decisions are
// narrowed, `pick` and `line`), the one Storage's rules page reads too.
const searchSchema = rulesPageSearch('db', {
  panel: ['decisions', 'playground', 'tests', 'collections'],
})

export type RulesSearch = z.infer<typeof searchSchema>

export const Route = createFileRoute('/firestore_/rules')({
  validateSearch: searchSchema,
  component: RulesRoute,
})

// The rules belong to the emulator's own project: this page shows no other
// project's, so the shell's banner offers the fix rather than a switch.
function RulesRoute() {
  return (
    <SectionFrame section="firestore" projectScope={false}>
      <RulesPage />
    </SectionFrame>
  )
}
