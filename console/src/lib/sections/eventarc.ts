// Eventarc's registry entry: the events page (a channel in scope shows who
// publishes to it and who listens, over its events), and where an event or
// a channel opens when another section's payload points at one (an
// `EntityRef`: an invocation's cause, an extension's channel).
// The publish action ⌘K offers from anywhere is in `./eventarc-actions.ts`.
//
// Firebase Alerts would add a third page, `/eventarc/alerts`, only together
// with the engine delivering alerts (compute spec §3.5); this engine does
// not yet, so there is no page, route or nav entry for it.

import { ShareNetworkIcon } from '@phosphor-icons/react'
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
    {
      to: '/eventarc',
      label: 'Events',
      exact: true,
      keywords: 'cloudevents deliveries channels publishers subscribers triggers topology',
    },
  ],
  routes: {
    'eventarc.event': (id) => ({ to: '/eventarc', search: { event: id } }),
    'eventarc.channel': (name) => ({ to: '/eventarc', search: { channel: name } }),
  },
}
