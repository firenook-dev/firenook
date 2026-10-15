import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { z } from 'zod'
import { SectionFrame } from '@/components/console/section-gate'
import { SchemasPage } from '@/pubsub/schemas/schemas-page'

// Every view of the Schemas page is a link: the schema, the revision shown
// or diffed, the main area's tab, the test panel, and the create dialog.
//
// The router reads a query value as JSON first, so a revision id of digits
// arrives as a number; ids are strings whatever they look like.
const text = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((value) => String(value))
  .optional()

const searchSchema = z.object({
  // The shell scope (useConsoleProject), absent for the configured project.
  project: text,
  // A schema id under the project above, or a full name that travelled whole.
  schema: text,
  // A revision shown read-only in the editor; absent: the latest, editable.
  revision: text,
  // A revision diffed against the editor's text.
  diff: text,
  // The main area's tab.
  view: z.enum(['definition', 'revisions', 'used-by']).optional(),
  // The side panel's tool.
  panel: z.enum(['test']).optional(),
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
