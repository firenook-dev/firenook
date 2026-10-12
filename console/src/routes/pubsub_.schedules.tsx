import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { z } from 'zod'
import { SectionFrame } from '@/components/console/section-gate'
import { SectionPlaceholder } from '@/components/section-placeholder'
import { pubsub } from '@/lib/sections/pubsub'
import { SchedulesPage } from '@/pubsub/schedules/schedules-page'

// The Schedules page: the schedule open in the inspector is the link.
const searchSchema = z.object({
  // The function id, `us-central1-nightlyCleanup`.
  schedule: z
    .union([z.string(), z.number()])
    .transform((value) => String(value))
    .optional(),
})

/** Every parameter is absent by default, so a link carries only what differs. */
const DEFAULTS = {} as const

export type SchedulesSearch = z.infer<typeof searchSchema>

export const Route = createFileRoute('/pubsub_/schedules')({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(DEFAULTS)] },
  component: PubsubSchedulesRoute,
})

function PubsubSchedulesRoute() {
  return (
    <SectionFrame section="pubsub">
      {pubsub.built ? <SchedulesPage /> : <SectionPlaceholder section={pubsub} />}
    </SectionFrame>
  )
}
