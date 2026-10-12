import { createFileRoute } from '@tanstack/react-router'
import { UnbuiltSection } from '@/components/section-placeholder'
import { functions } from '@/lib/sections/functions'

export const Route = createFileRoute('/functions')({
  component: () => <UnbuiltSection section={functions} />,
})
