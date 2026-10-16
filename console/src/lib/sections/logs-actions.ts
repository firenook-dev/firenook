// What ⌘K offers from anywhere for Logs. Only the palette reads it
// (`lib/palette-actions.ts`), so these icons stay off the first route. The
// suite-wide actions (a snapshot, a reset, the environment block) are the
// palette's own Suite group, not a section's.

import { WarningCircleIcon, WarningIcon } from '@phosphor-icons/react'
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
]
