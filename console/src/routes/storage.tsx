import { createFileRoute } from '@tanstack/react-router'
import { UnbuiltSection } from '@/components/section-placeholder'
import { storage } from '@/lib/sections/storage'

export const Route = createFileRoute('/storage')({
  component: () => <UnbuiltSection section={storage} />,
})
