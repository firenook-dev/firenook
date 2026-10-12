import { createFileRoute } from '@tanstack/react-router'
import { UnbuiltSection } from '@/components/section-placeholder'
import { tasks } from '@/lib/sections/tasks'

export const Route = createFileRoute('/tasks')({
  component: () => <UnbuiltSection section={tasks} />,
})
