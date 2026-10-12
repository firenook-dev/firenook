import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { z } from 'zod'
import { InboxPage } from '@/auth/components/inbox-page'
import { SectionFrame } from '@/components/console/section-gate'
import { UnbuiltSection } from '@/components/section-placeholder'
import { auth } from '@/lib/sections/auth'
import { zFlag } from '@/lib/search-params'

// Every view of the Inbox is a link: the project and tenant it shows, its
// filter, the message open in the reader, and whether the feed is paused.
const searchSchema = z.object({
  /** The shell's project scope; absent: the configured project. */
  project: z.string().optional(),
  /** Absent: every tenant. `(none)`: project-level messages only. Otherwise a tenant id. */
  tenant: z.string().optional(),
  /** The filter, in the console's shared grammar. */
  q: z.string().optional(),
  /** The message open in the reader. */
  message: z.coerce.number().int().optional(),
  /** The feed is paused (stored only while paused). */
  paused: zFlag,
})

export const Route = createFileRoute('/auth_/inbox')({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams({})] },
  component: InboxRoute,
})

function InboxRoute() {
  // The section's placeholder until its journeys pass.
  if (!auth.built) return <UnbuiltSection section={auth} />
  return (
    <SectionFrame section="auth">
      <InboxPage />
    </SectionFrame>
  )
}
