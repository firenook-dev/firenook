import { createFileRoute } from '@tanstack/react-router'
import { UnbuiltSection } from '@/components/section-placeholder'
import { pubsub } from '@/lib/sections/pubsub'

export const Route = createFileRoute('/pubsub')({
  component: () => <UnbuiltSection section={pubsub} />,
})
