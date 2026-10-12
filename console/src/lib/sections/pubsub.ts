// Pub/Sub's registry entry. The messaging stream fills in its pages, badges,
// actions, routes and search labels when it builds the section; until its
// journeys pass it stays `built: false` and shows the placeholder.

import { BroadcastIcon } from '@phosphor-icons/react'
import type { ConsoleSection } from '../services'

export const pubsub: ConsoleSection = {
  id: 'pubsub',
  to: '/pubsub',
  label: 'Pub/Sub',
  services: ['pubsub'],
  area: 'messaging',
  icon: BroadcastIcon,
  built: false,
  projectScope: true,
  summary:
    'Topics and subscriptions, publish and pull messages, ack and seek, snapshots and schemas, delivery status to functions.',
}
