// What ⌘K offers from anywhere for Eventarc. Only the palette reads it
// (`lib/palette-actions.ts`), so its icon stays off the first route.

import { PaperPlaneTiltIcon } from '@phosphor-icons/react'
import type { SectionAction } from '../services'

export const eventarcActions: readonly SectionAction[] = [
  {
    id: 'eventarc.publish',
    title: 'Publish an event',
    keywords: 'cloudevent custom send',
    icon: PaperPlaneTiltIcon,
    link: { to: '/eventarc', search: { new: 'event' } },
  },
]
