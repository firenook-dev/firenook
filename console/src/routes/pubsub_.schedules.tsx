import { createFileRoute } from '@tanstack/react-router'
import { UnbuiltSection } from '@/components/section-placeholder'
import { pubsub } from '@/lib/sections/pubsub'

// Pub/Sub's Schedules page, behind the section's placeholder until it is built.
export const Route = createFileRoute('/pubsub_/schedules')({
  component: () => <UnbuiltSection section={pubsub} />,
})
