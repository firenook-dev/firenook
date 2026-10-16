import { createFileRoute } from '@tanstack/react-router'
import { SectionFrame } from '@/components/console/section-gate'
import { EventsPage } from '@/eventarc/components/events-page'
import { eventsSearch } from '@/eventarc/search'

// Every Eventarc event on every channel, live, with the trigger each one
// reached or the filter that kept it out; publishing a custom event with a
// preview of who it would reach. Every view of it is a link
// (`../eventarc/search.ts`).
export const Route = createFileRoute('/eventarc')({
  validateSearch: eventsSearch,
  component: EventarcRoute,
})

function EventarcRoute() {
  return (
    <SectionFrame section="eventarc">
      <EventsPage />
    </SectionFrame>
  )
}
