// Extensions' registry entry. The compute stream fills in its pages,
// actions, routes and search labels when it builds the section; until its
// journeys pass it stays `built: false` and shows the placeholder.

import { PuzzlePieceIcon } from '@phosphor-icons/react'
import type { ConsoleSection } from '../services'

export const extensions: ConsoleSection = {
  id: 'extensions',
  to: '/extensions',
  label: 'Extensions',
  services: ['functions'],
  area: 'compute',
  icon: PuzzlePieceIcon,
  built: false,
  summary:
    'Instances with their source and offline readiness, resolved parameters, and the functions each instance adds.',
}
