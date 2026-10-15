// What ⌘K offers from anywhere for Functions. Only the palette reads it
// (`lib/palette-actions.ts`), so its icon stays off the first route.

import { ListIcon } from '@phosphor-icons/react'
import type { SectionAction } from '../services'

export const functionsActions: readonly SectionAction[] = [
  {
    id: 'functions.invocations',
    title: 'Show every invocation',
    keywords: 'runs executions history',
    icon: ListIcon,
    link: { to: '/functions/invocations' },
  },
]
