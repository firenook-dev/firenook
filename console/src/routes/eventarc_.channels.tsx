import { createFileRoute } from '@tanstack/react-router'
import { SectionFrame } from '@/components/console/section-gate'
import { UnbuiltSection } from '@/components/section-placeholder'
import { ChannelsPage } from '@/eventarc/components/channels-page'
import { channelsSearch } from '@/eventarc/search'
import { eventarc } from '@/lib/sections/eventarc'

// Eventarc › Channels: who publishes what to whom on every channel in use,
// and what does not line up. Until the section's journeys pass (`built` in
// its registry file) the route keeps its honest placeholder.
export const Route = createFileRoute('/eventarc_/channels')({
  validateSearch: channelsSearch,
  component: ChannelsRoute,
})

function ChannelsRoute() {
  if (!eventarc.built) return <UnbuiltSection section={eventarc} />
  return (
    <SectionFrame section="eventarc">
      <ChannelsPage />
    </SectionFrame>
  )
}
