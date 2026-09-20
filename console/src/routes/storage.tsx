import { createFileRoute } from '@tanstack/react-router'
import { SectionPlaceholder } from '@/components/section-placeholder'
import { SECTIONS } from '@/lib/services'

const section = SECTIONS.find((candidate) => candidate.to === '/storage')
if (!section) throw new Error('The storage section is missing from the registry')

export const Route = createFileRoute('/storage')({
  component: () => <SectionPlaceholder section={section} />,
})
