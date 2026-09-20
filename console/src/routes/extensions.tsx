import { createFileRoute } from '@tanstack/react-router'
import { SectionPlaceholder } from '@/components/section-placeholder'
import { SECTIONS } from '@/lib/services'

const section = SECTIONS.find((candidate) => candidate.to === '/extensions')
if (!section) throw new Error('The extensions section is missing from the registry')

export const Route = createFileRoute('/extensions')({
  component: () => <SectionPlaceholder section={section} />,
})
