import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { SectionFrame } from '@/components/console/section-gate'
import { RulesPage } from '@/firestore/rules-page/rules-page'

// The security rules of one database, as a page of their own: the editor,
// and beside it what the rules decided, a playground, saved tests and the
// collections they govern. Every view of it is a link.
const searchSchema = z.object({
  db: z.string().optional(),
  // The panel beside the editor.
  panel: z.enum(['decisions', 'playground', 'tests', 'collections']).optional(),
  // A decision opened from the list or from a denied read ("See why").
  decision: z.string().optional(),
  // Narrowing the decisions: a path prefix, a uid, denials only.
  path: z.string().optional(),
  uid: z.string().optional(),
  denied: z.boolean().optional(),
  // Only the decisions the draft in the editor would turn around.
  flips: z.boolean().optional(),
  // Open the newest denial the narrowing matches, once, then forget it:
  // what "See why" on the data page asks for.
  pick: z.boolean().optional(),
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
