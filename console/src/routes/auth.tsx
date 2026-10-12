import { createFileRoute } from '@tanstack/react-router'
import { UnbuiltSection } from '@/components/section-placeholder'
import { auth } from '@/lib/sections/auth'

export const Route = createFileRoute('/auth')({
  component: () => <UnbuiltSection section={auth} />,
})
