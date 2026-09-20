import { createFileRoute } from '@tanstack/react-router'
import { SectionPlaceholder } from '@/components/section-placeholder'
import { SECTIONS } from '@/lib/services'

const section = SECTIONS.find((candidate) => candidate.to === '/logs')
if (!section) throw new Error('The logs section is missing from the registry')

export const Route = createFileRoute('/logs')({
  component: () => <SectionPlaceholder section={section} />,
})
