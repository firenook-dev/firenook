// What ⌘K offers from anywhere for Pub/Sub. Only the palette reads it
// (`lib/palette-actions.ts`), so these icons stay off the first route.

import { ArrowsDownUpIcon, PaperPlaneTiltIcon, PlusIcon } from '@phosphor-icons/react'
import type { SectionAction } from '../services'

export const pubsubActions: readonly SectionAction[] = [
  {
    id: 'pubsub.new-topic',
    title: 'Create a topic',
    icon: PlusIcon,
    link: { to: '/pubsub', search: { new: 'topic' } },
  },
  {
    id: 'pubsub.publish',
    title: 'Publish a message',
    icon: PaperPlaneTiltIcon,
    link: { to: '/pubsub', search: { new: 'message' } },
  },
  {
    id: 'pubsub.new-schema',
    title: 'Create a schema',
    icon: PlusIcon,
    link: { to: '/pubsub/schemas', search: { new: 'schema' } },
  },
  {
    id: 'pubsub.setup',
    title: 'Export or import the Pub/Sub setup',
    keywords: 'topics subscriptions schemas file',
    icon: ArrowsDownUpIcon,
    link: { to: '/pubsub', search: { dialog: 'setup' } },
  },
]
