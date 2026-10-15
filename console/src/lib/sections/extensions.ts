// Extensions' registry entry: where an instance opens when another
// section's payload points at one (an `EntityRef`: a function's extension,
// an Eventarc publisher) or ⌘K's engine search finds one.
//
// Built: its journeys (`e2e/extensions.spec.ts`) pass against a real engine.

import { PuzzlePieceIcon } from '@phosphor-icons/react'
import type { ConsoleSection } from '../services'

export const extensions: ConsoleSection = {
  id: 'extensions',
  to: '/extensions',
  label: 'Extensions',
  services: ['functions'],
  area: 'compute',
  icon: PuzzlePieceIcon,
  summary:
    'Each instance with its source and offline readiness, its configuration and where every value comes from, the functions it adds and the events it emits; reconfigure and reload in place.',
  searchLabels: { 'extensions.instance': 'Extensions' },
  routes: {
    'extensions.instance': (id) => ({ to: '/extensions', search: { instance: id } }),
  },
}
