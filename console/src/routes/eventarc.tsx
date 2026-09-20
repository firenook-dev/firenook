import { createFileRoute } from '@tanstack/react-router'
import { SectionPlaceholder } from '@/components/section-placeholder'
import { SECTIONS } from '@/lib/services'

const section = SECTIONS.find((candidate) => candidate.to === '/eventarc')
if (!section) throw new Error('The eventarc section is missing from the registry')

export const Route = createFileRoute('/eventarc')({
  component: () => <SectionPlaceholder section={section} />,
})
