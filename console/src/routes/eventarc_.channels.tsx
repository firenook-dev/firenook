import { createFileRoute } from '@tanstack/react-router'
import { UnbuiltSection } from '@/components/section-placeholder'
import { eventarc } from '@/lib/sections/eventarc'

// Eventarc › Channels, a page of the Eventarc section: its honest
// placeholder until the section's journeys pass, so the nav's entry for it
// leads somewhere true.
export const Route = createFileRoute('/eventarc_/channels')({
  component: () => <UnbuiltSection section={eventarc} />,
})
