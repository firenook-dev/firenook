import { createFileRoute } from '@tanstack/react-router'
import { UnbuiltSection } from '@/components/section-placeholder'
import { functions } from '@/lib/sections/functions'

// Functions › Invocations, a page of the Functions section: its honest
// placeholder until the section's journeys pass, so the nav's entry for it
// leads somewhere true.
export const Route = createFileRoute('/functions_/invocations')({
  component: () => <UnbuiltSection section={functions} />,
})
