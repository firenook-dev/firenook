import { createFileRoute } from '@tanstack/react-router'
import { SectionPlaceholder } from '@/components/section-placeholder'
import { SECTIONS } from '@/lib/services'

const section = SECTIONS.find((candidate) => candidate.to === '/functions')
if (!section) throw new Error('The functions section is missing from the registry')

export const Route = createFileRoute('/functions')({
  component: () => <SectionPlaceholder section={section} />,
})
