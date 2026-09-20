import { createFileRoute } from '@tanstack/react-router'
import { SectionPlaceholder } from '@/components/section-placeholder'
import { SECTIONS } from '@/lib/services'

const section = SECTIONS.find((candidate) => candidate.to === '/auth')
if (!section) throw new Error('The auth section is missing from the registry')

export const Route = createFileRoute('/auth')({
  component: () => <SectionPlaceholder section={section} />,
})
