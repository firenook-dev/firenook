import { createFileRoute } from '@tanstack/react-router'
import { SectionPlaceholder } from '@/components/section-placeholder'
import { SECTIONS } from '@/lib/services'

const section = SECTIONS.find((candidate) => candidate.to === '/pubsub')
if (!section) throw new Error('The pubsub section is missing from the registry')

export const Route = createFileRoute('/pubsub')({
  component: () => <SectionPlaceholder section={section} />,
})
