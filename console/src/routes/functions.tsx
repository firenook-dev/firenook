import { createFileRoute } from '@tanstack/react-router'
import { SectionFrame } from '@/components/console/section-gate'
import { UnbuiltSection } from '@/components/section-placeholder'
import { FunctionsPage, FunctionsStarting } from '@/functions/components/functions-page'
import { functionsSearch } from '@/functions/search'
import { functions } from '@/lib/sections/functions'

// Every function by codebase, one codebase, or one function with its
// invocations and its Run, Trigger and Environment tabs: every view is a
// link (compute spec §4.3). The section keeps its placeholder until its
// journeys pass (`built` in its registry file).
export const Route = createFileRoute('/functions')({
  validateSearch: functionsSearch,
  component: FunctionsRoute,
})

function FunctionsRoute() {
  if (!functions.built) return <UnbuiltSection section={functions} />
  return (
    <SectionFrame section="functions" skeleton={<FunctionsStarting />}>
      <FunctionsPage />
    </SectionFrame>
  )
}
