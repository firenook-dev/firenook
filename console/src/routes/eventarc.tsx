import { createFileRoute } from '@tanstack/react-router'
import { SectionFrame } from '@/components/console/section-gate'
import { UnbuiltSection } from '@/components/section-placeholder'
import { EventsPage } from '@/eventarc/components/events-page'
import { eventsSearch } from '@/eventarc/search'
import { eventarc } from '@/lib/sections/eventarc'

// Every Eventarc event on every channel, live, with the trigger each one
// reached or the filter that kept it out; publishing a custom event with a
// preview of who it would reach. Every view of it is a link
// (`../eventarc/search.ts`). Until the section's journeys pass (`built` in
// its registry file) the route keeps its honest placeholder.
export const Route = createFileRoute('/eventarc')({
  validateSearch: eventsSearch,
  component: EventarcRoute,
})

function EventarcRoute() {
  if (!eventarc.built) return <UnbuiltSection section={eventarc} />
  return (
    <SectionFrame section="eventarc">
      <EventsPage />
    </SectionFrame>
  )
}
