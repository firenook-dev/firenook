// Functions' registry entry. The compute stream fills in its pages, badges,
// actions, routes and search labels when it builds the section; until its
// journeys pass it stays `built: false` and shows the placeholder.

import { LightningIcon } from '@phosphor-icons/react'
import type { ConsoleSection } from '../services'

export const functions: ConsoleSection = {
  id: 'functions',
  to: '/functions',
  label: 'Functions',
  services: ['functions'],
  area: 'compute',
  icon: LightningIcon,
  built: false,
  summary:
    'Functions by codebase with trigger type, invoke HTTP and callable functions, inject background events, and follow each function’s log stream.',
}
