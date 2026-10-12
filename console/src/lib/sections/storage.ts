// Storage's registry entry. The storage stream fills in its pages, badges,
// actions, routes and search labels when it builds the section; until its
// journeys pass it stays `built: false` and shows the placeholder. Buckets
// are not per project, so there is no `projectScope`.

import { HardDrivesIcon } from '@phosphor-icons/react'
import type { ConsoleSection } from '../services'

export const storage: ConsoleSection = {
  id: 'storage',
  to: '/storage',
  label: 'Storage',
  services: ['storage'],
  area: 'data',
  icon: HardDrivesIcon,
  built: false,
  summary:
    'Bucket switcher, folder browser with previews, metadata editor, and native rules reload.',
}
