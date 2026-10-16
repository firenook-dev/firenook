import { createFileRoute } from '@tanstack/react-router'
import { SectionFrame } from '@/components/console/section-gate'
import { FunctionsPage, FunctionsStarting } from '@/functions/components/functions-page'
import { functionsSearch } from '@/functions/search'

// Every function by codebase, one codebase, or one function with its
// invocations and its Run, Trigger and Environment tabs: every view is a
// link (compute spec §4.3).
export const Route = createFileRoute('/functions')({
  validateSearch: functionsSearch,
  component: FunctionsRoute,
})

function FunctionsRoute() {
  return (
    <SectionFrame section="functions" skeleton={<FunctionsStarting />}>
      <FunctionsPage />
    </SectionFrame>
  )
}
