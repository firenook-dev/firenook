import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { z } from 'zod'
import { SectionFrame } from '@/components/console/section-gate'
import { SchemasPage } from '@/pubsub/schemas/schemas-page'

// Every view of the Schemas page is a link: the schema, the main area's tab,
// and the create dialog.
//
// The router reads a query value as JSON first, so an id of digits arrives
// as a number; ids are strings whatever they look like.
const text = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((value) => String(value))
  .optional()

const searchSchema = z.object({
  // The shell scope (useConsoleProject), absent for the configured project.
  project: text,
  // A schema id under the project above, or a full name that travelled whole.
  schema: text,
  // The main area's tab.
  view: z.enum(['definition', 'used-by']).optional(),
  new: z.enum(['schema']).optional(),
})

/** Every parameter is absent by default, so a link carries only what differs. */
const DEFAULTS = {} as const

export type SchemasSearch = z.infer<typeof searchSchema>

export const Route = createFileRoute('/pubsub_/schemas')({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(DEFAULTS)] },
  component: PubsubSchemasRoute,
})

function PubsubSchemasRoute() {
  return (
    <SectionFrame section="pubsub">
      <SchemasPage />
    </SectionFrame>
  )
}
