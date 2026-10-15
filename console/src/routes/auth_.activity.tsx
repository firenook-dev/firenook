import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { z } from 'zod'
import { ActivityPage } from '@/auth/components/activity-page'
import { SectionFrame } from '@/components/console/section-gate'
import { zFlag } from '@/lib/search-params'

// Every view of Activity is a link: the project and tenant it shows, its
// filter, the call open in the detail, whether the console's own edits are
// in, whether the feed is paused, and the side panel of tools.
const searchSchema = z.object({
  /** The shell's project scope; absent: the configured project. */
  project: z.string().optional(),
  /** Absent: every tenant. `(none)`: the project's own calls. Otherwise a tenant id. */
  tenant: z.string().optional(),
  /** The filter, in the console's shared grammar. */
  q: z.string().optional(),
  /** The call open in the detail. */
  entry: z.coerce.number().int().optional(),
  /** Include the console's own background edits (hidden by default). */
  console: zFlag,
  /** The feed is paused (stored only while paused). */
  paused: zFlag,
  /** The side panel of tools: Try a sign-in or Inspect a token. */
  panel: z.enum(['try', 'inspect']).optional(),
  /** Try a sign-in's method. */
  method: z
    .enum([
      'password',
      'signUp',
      'anonymous',
      'emailLink',
      'phone',
      'customToken',
      'federated',
      'refresh',
    ])
    .optional(),
})

export const Route = createFileRoute('/auth_/activity')({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams({})] },
  component: ActivityRoute,
})

function ActivityRoute() {
  return (
    <SectionFrame section="auth">
      <ActivityPage />
    </SectionFrame>
  )
}
