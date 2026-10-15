import { createFileRoute } from '@tanstack/react-router'
import { SectionFrame } from '@/components/console/section-gate'
import { ChannelsPage } from '@/eventarc/components/channels-page'
import { channelsSearch } from '@/eventarc/search'

// Eventarc › Channels: who publishes what to whom on every channel in use,
// and what does not line up.
export const Route = createFileRoute('/eventarc_/channels')({
  validateSearch: channelsSearch,
  component: ChannelsRoute,
})

function ChannelsRoute() {
  return (
    <SectionFrame section="eventarc">
      <ChannelsPage />
    </SectionFrame>
  )
}
