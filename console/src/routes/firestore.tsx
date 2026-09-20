import { createFileRoute } from '@tanstack/react-router'
import { SectionPlaceholder } from '@/components/section-placeholder'
import { SECTIONS } from '@/lib/services'

const section = SECTIONS.find((candidate) => candidate.to === '/firestore')
if (!section) throw new Error('The firestore section is missing from the registry')

export const Route = createFileRoute('/firestore')({
  component: () => <SectionPlaceholder section={section} />,
})
