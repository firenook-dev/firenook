// Functions' registry entry: its two pages, the two badges the engine
// publishes for it, and where a function, an invocation or a codebase opens
// when another section's payload points at one (an `EntityRef` the engine
// built) or ⌘K's engine search finds one. Compute exports no link builder:
// every link here goes through `routes`. What ⌘K offers from anywhere is in
// `./functions-actions.ts`.

import { LightningIcon } from '@phosphor-icons/react'
import type { ConsoleSection } from '../services'

export const functions: ConsoleSection = {
  id: 'functions',
  to: '/functions',
  label: 'Functions',
  services: ['functions'],
  area: 'compute',
  icon: LightningIcon,
  summary:
    'Every function by codebase with its trigger and health, invoke HTTP and callable functions as any user, send test events or do the real thing, and every invocation with its own logs, replay and timing.',
  // Each badge sits on the page it is about, so the page that shows the
  // failures is the one that marks them seen. None on the section itself:
  // a section's own badges are marked seen on every one of its pages.
  pages: [
    {
      to: '/functions',
      // Not "Functions" again under Functions: the page lists all of them,
      // as its panel's first row and its toolbar say.
      label: 'All functions',
      exact: true,
      badges: ['functions.load'],
      keywords: 'codebases triggers workers environment secrets',
    },
    {
      to: '/functions/invocations',
      label: 'Invocations',
      badges: ['functions.failed'],
      keywords: 'runs executions history calls',
    },
  ],
  searchLabels: { 'functions.function': 'Functions' },
  routes: {
    'functions.function': (id) => ({ to: '/functions', search: { function: id } }),
    'functions.invocation': (id) => ({ to: '/functions/invocations', search: { invocation: id } }),
    // Key: an Invocations filter (`function:us-central1-processOrder`).
    'functions.invocations': (q) => ({ to: '/functions/invocations', search: { q } }),
    'functions.codebase': (codebase) => ({ to: '/functions', search: { codebase } }),
  },
}
