import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { z } from 'zod'
import { SettingsPage } from '@/auth/components/settings-page'
import { SectionFrame } from '@/components/console/section-gate'

// Every view of Settings is a link: the project, the card to bring into
// view, the tenant whose sign-in behaviour the first card shows, and the
// New tenant dialog.
const searchSchema = z.object({
  /** The shell's project scope; absent: the configured project. */
  project: z.string().optional(),
  /** The card brought into view once. */
  section: z.enum(['sign-in', 'tenants', 'hooks', 'data', 'connect']).optional(),
  /** The tenant whose sign-in behaviour the first card shows; absent: the project's. */
  tenant: z.string().optional(),
  /** Opens the New tenant dialog. */
  new: z.enum(['tenant']).optional(),
})

export const Route = createFileRoute('/auth_/settings')({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams({})] },
  component: SettingsRoute,
})

function SettingsRoute() {
  return (
    <SectionFrame section="auth">
      <SettingsPage />
    </SectionFrame>
  )
}
