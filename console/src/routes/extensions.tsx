import { createFileRoute } from '@tanstack/react-router'
import { SectionFrame } from '@/components/console/section-gate'
import { ExtensionsPage } from '@/extensions/components/extensions-page'
import { extensionsSearch } from '@/extensions/search'

// Every instance of every extension in firebase.json, and one of them in
// full: its source and offline readiness, its configuration with the file
// each value comes from, the functions it adds, the events it publishes
// and its own notes. Every view of it is a link (`../extensions/search.ts`).
export const Route = createFileRoute('/extensions')({
  validateSearch: extensionsSearch,
  component: ExtensionsRoute,
})

function ExtensionsRoute() {
  return (
    <SectionFrame section="extensions">
      <ExtensionsPage />
    </SectionFrame>
  )
}
