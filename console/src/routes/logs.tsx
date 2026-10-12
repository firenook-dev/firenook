import { createFileRoute } from '@tanstack/react-router'
import { UnbuiltSection } from '@/components/section-placeholder'
import { logs } from '@/lib/sections/logs'

export const Route = createFileRoute('/logs')({
  component: () => <UnbuiltSection section={logs} />,
})
