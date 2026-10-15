// What ⌘K offers from anywhere for Cloud Tasks. Only the palette reads it
// (`lib/palette-actions.ts`), so its icon stays off the first route.

import { PlusIcon } from '@phosphor-icons/react'
import type { SectionAction } from '../services'

export const tasksActions: readonly SectionAction[] = [
  {
    id: 'tasks.enqueue',
    title: 'Enqueue a task',
    keywords: 'cloud tasks queue onTaskDispatched',
    icon: PlusIcon,
    link: { to: '/tasks', search: { new: 'task' } },
  },
]
