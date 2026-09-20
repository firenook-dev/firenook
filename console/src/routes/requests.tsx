import { createFileRoute } from '@tanstack/react-router'
import { SectionPlaceholder } from '@/components/section-placeholder'
import { SECTIONS } from '@/lib/services'

const section = SECTIONS.find((candidate) => candidate.to === '/requests')
if (!section) throw new Error('The requests section is missing from the registry')

export const Route = createFileRoute('/requests')({
  component: () => <SectionPlaceholder section={section} />,
})
