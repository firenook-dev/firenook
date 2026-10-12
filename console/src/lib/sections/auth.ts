// Authentication's registry entry. The auth stream fills in its pages,
// badges, actions, routes and search labels when it builds the section;
// until its journeys pass it stays `built: false` and shows the placeholder.

import { UsersIcon } from '@phosphor-icons/react'
import type { ConsoleSection } from '../services'

export const auth: ConsoleSection = {
  id: 'auth',
  to: '/auth',
  label: 'Authentication',
  services: ['auth'],
  area: 'data',
  icon: UsersIcon,
  built: false,
  projectScope: true,
  summary:
    'Users table with real columns and actions, an inbox for every code and link the emulator would have sent, and a sign-in timeline with the exact error.',
}
