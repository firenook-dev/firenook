import { createFileRoute } from '@tanstack/react-router'
import { UnbuiltSection } from '@/components/section-placeholder'
import { extensions } from '@/lib/sections/extensions'

export const Route = createFileRoute('/extensions')({
  component: () => <UnbuiltSection section={extensions} />,
})
