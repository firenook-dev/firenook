import { createFileRoute } from '@tanstack/react-router'
import { SectionFrame } from '@/components/console/section-gate'
import { FunctionsStarting } from '@/functions/components/functions-page'
import { InvocationsPage } from '@/functions/components/invocations-page'
import { invocationsSearch } from '@/functions/search'

// Functions › Invocations: every invocation of every function, live, with
// the engine's filter and one opened in the inspector.
export const Route = createFileRoute('/functions_/invocations')({
  validateSearch: invocationsSearch,
  component: InvocationsRoute,
})

function InvocationsRoute() {
  return (
    <SectionFrame section="functions" skeleton={<FunctionsStarting />}>
      <InvocationsPage />
    </SectionFrame>
  )
}
