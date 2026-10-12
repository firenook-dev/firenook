// Eventarc's registry entry. The compute stream fills in its pages, actions,
// routes and search labels when it builds the section; until its journeys
// pass it stays `built: false` and shows the placeholder.

import { ShareNetworkIcon } from '@phosphor-icons/react'
import type { ConsoleSection } from '../services'

export const eventarc: ConsoleSection = {
  id: 'eventarc',
  to: '/eventarc',
  label: 'Eventarc',
  services: ['eventarc'],
  area: 'messaging',
  icon: ShareNetworkIcon,
  built: false,
  summary: 'Channels and triggers, publish a custom event, and trace its delivery.',
}
