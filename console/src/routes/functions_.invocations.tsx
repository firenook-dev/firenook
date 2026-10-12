import { createFileRoute } from '@tanstack/react-router'
import { SectionFrame } from '@/components/console/section-gate'
import { UnbuiltSection } from '@/components/section-placeholder'
import { FunctionsStarting } from '@/functions/components/functions-page'
import { InvocationsPage } from '@/functions/components/invocations-page'
import { invocationsSearch } from '@/functions/search'
import { functions } from '@/lib/sections/functions'

// Functions › Invocations: every invocation of every function, live, with
// the engine's filter and one opened in the inspector. The section keeps
// its placeholder until its journeys pass (`built` in its registry file).
export const Route = createFileRoute('/functions_/invocations')({
  validateSearch: invocationsSearch,
  component: InvocationsRoute,
})

function InvocationsRoute() {
  if (!functions.built) return <UnbuiltSection section={functions} />
  return (
    <SectionFrame section="functions" skeleton={<FunctionsStarting />}>
      <InvocationsPage />
    </SectionFrame>
  )
}
