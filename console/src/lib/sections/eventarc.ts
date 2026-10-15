// Eventarc's registry entry: the events page and the channels page, the
// publish action ⌘K offers from anywhere, and where an event or a channel
// opens when another section's payload points at one (an `EntityRef`: an
// invocation's cause, an extension's channel).
//
// Firebase Alerts would add a third page, `/eventarc/alerts`, only together
// with the engine delivering alerts (compute spec §3.5); this engine does
// not yet, so there is no page, route or nav entry for it.
//
// Built: its journeys (`e2e/eventarc.spec.ts`) pass against a real engine.

import { PaperPlaneTiltIcon, ShareNetworkIcon } from '@phosphor-icons/react'
import type { ConsoleSection } from '../services'

export const eventarc: ConsoleSection = {
  id: 'eventarc',
  to: '/eventarc',
  label: 'Eventarc',
  services: ['eventarc'],
  area: 'messaging',
  icon: ShareNetworkIcon,
  summary:
    'Every event on every channel with the trigger each one reached or missed, publish a custom event, and who publishes and who listens.',
  pages: [
    { to: '/eventarc', label: 'Events', exact: true, keywords: 'cloudevents deliveries' },
    {
      to: '/eventarc/channels',
      label: 'Channels',
      keywords: 'publishers subscribers triggers topology',
    },
  ],
  actions: [
    {
      id: 'eventarc.publish',
      title: 'Publish an event',
      keywords: 'cloudevent custom send',
      icon: PaperPlaneTiltIcon,
      link: { to: '/eventarc', search: { new: 'event' } },
    },
  ],
  routes: {
    'eventarc.event': (id) => ({ to: '/eventarc', search: { event: id } }),
    'eventarc.channel': (name) => ({ to: '/eventarc', search: { channel: name } }),
  },
}
