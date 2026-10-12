import { createFileRoute } from '@tanstack/react-router'
import { UnbuiltSection } from '@/components/section-placeholder'
import { eventarc } from '@/lib/sections/eventarc'

export const Route = createFileRoute('/eventarc')({
  component: () => <UnbuiltSection section={eventarc} />,
})
