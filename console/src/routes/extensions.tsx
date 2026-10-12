import { createFileRoute } from '@tanstack/react-router'
import { SectionFrame } from '@/components/console/section-gate'
import { UnbuiltSection } from '@/components/section-placeholder'
import { ExtensionsPage } from '@/extensions/components/extensions-page'
import { extensionsSearch } from '@/extensions/search'
import { extensions } from '@/lib/sections/extensions'

// Every instance of every extension in firebase.json, and one of them in
// full: its source and offline readiness, its configuration with the file
// each value comes from, the functions it adds, the events it publishes
// and its own notes. Every view of it is a link (`../extensions/search.ts`).
// Until the section's journeys pass (`built` in its registry file) the
// route keeps its honest placeholder.
export const Route = createFileRoute('/extensions')({
  validateSearch: extensionsSearch,
  component: ExtensionsRoute,
})

function ExtensionsRoute() {
  if (!extensions.built) return <UnbuiltSection section={extensions} />
  return (
    <SectionFrame section="extensions">
      <ExtensionsPage />
    </SectionFrame>
  )
}
