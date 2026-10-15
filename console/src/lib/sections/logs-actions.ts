// What ⌘K offers from anywhere for Logs, and the Overview's suite-wide
// actions (a snapshot, a reset, the environment block): the Overview has
// no registry of its own. Only the palette reads it
// (`lib/palette-actions.ts`), so these icons stay off the first route.

import {
  ArrowCounterClockwiseIcon,
  PlugsConnectedIcon,
  WarningCircleIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import type { SectionAction } from '../services'
import { linkToLogs } from './logs'

export const logsActions: readonly SectionAction[] = [
  {
    id: 'logs.errors',
    title: 'Open logs: errors only',
    description: 'Every error line from every service',
    keywords: 'logs errors failures level',
    icon: WarningCircleIcon,
    link: linkToLogs({ level: 'error' }),
  },
  {
    id: 'logs.problems',
    title: 'Open logs: problems',
    description: 'Errors, function failures and rules denials, kept longer than other lines',
    keywords: 'logs problems denials failures timeouts',
    icon: WarningIcon,
    link: { to: '/logs', search: { q: 'is:problem' } },
  },
  {
    id: 'overview.reset',
    title: 'Reset data…',
    description: 'Delete the data of one section or of all of them',
    keywords: 'reset clear delete wipe data',
    icon: ArrowCounterClockwiseIcon,
    link: { to: '/', search: { dialog: 'reset' } },
  },
  {
    id: 'overview.env',
    title: 'Environment variables for your app',
    description: 'The variables the Admin SDKs and gcloud clients read to find the emulators',
    keywords: 'environment variables env connect admin sdk emulator host',
    icon: PlugsConnectedIcon,
    link: { to: '/', search: { connect: 'env' } },
  },
]
