import { createFileRoute } from '@tanstack/react-router'
import { SectionPlaceholder } from '@/components/section-placeholder'
import { SECTIONS } from '@/lib/services'

const section = SECTIONS.find((candidate) => candidate.to === '/tasks')
if (!section) throw new Error('The tasks section is missing from the registry')

export const Route = createFileRoute('/tasks')({
  component: () => <SectionPlaceholder section={section} />,
})
