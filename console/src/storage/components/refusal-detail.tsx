// "See why" for a refusal the Files page met as a client: the rules kit's
// refusal popover (`src/rules/refusal-detail.tsx`) with the explanation the
// refusal itself carried (the engine re-ran the request with every
// expression's value and sent it beside the 403), so it never dead-ends
// once the decision has left the engine's window; the same request in the
// Rules page's playground; and the decision on the Rules page while the
// engine still holds it.

import { useQuery } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { RefusalDetail as RulesRefusal } from '@/rules/refusal-detail'
import type { StorageErrorExtras } from '../api'
import { useFiles } from '../files-state'
import { rulesScope, storageRulesQuery } from '../queries'
import { useRulesPageLink, useTryInPlayground } from '../rules-link'
import { STORAGE_READS } from '../rules-page/decision-detail'

/** The rules source in force for the bucket on screen, and one line of it. */
export function useRulesText(): {
  source: string | undefined
  line: (n: number) => string | undefined
} {
  const files = useFiles()
  const scope = rulesScope(files.buckets, files.bucket)
  const rules = useQuery({
    ...storageRulesQuery(files.project, scope),
    enabled: !files.admin && files.buckets.rulesMode !== null,
  })
  const source = rules.data?.source
  const lines = source?.split('\n')
  return { source, line: (n) => lines?.[n - 1]?.trim() || undefined }
}

export function RefusalDetail({
  extras,
  trigger,
}: {
  extras: StorageErrorExtras
  /** The control that opens it ("See why"). */
  trigger: ReactElement
}) {
  const files = useFiles()
  const { source } = useRulesText()
  const rules = useRulesPageLink()
  const tryIt = useTryInPlayground()
  const decision = extras.decision ?? undefined
  const request = extras.request ?? undefined
  return (
    <RulesRefusal
      trigger={trigger}
      explanation={
        !extras.noRuleset && extras.evaluation && source !== undefined
          ? { result: extras.evaluation, rules: source, readFunctions: STORAGE_READS }
          : undefined
      }
      said={
        extras.noRuleset ? (
          <>
            No rules govern <span className="font-mono text-[0.9em]">gs://{files.bucket}</span>, so
            the emulator refuses every client request to it, the Admin SDK included.
          </>
        ) : extras.line ? (
          `Line ${extras.line} of the rules refused it.`
        ) : (
          'No allow matched, so the rules refused it by default.'
        )
      }
      onTry={
        tryIt && request
          ? () => tryIt(request, { decision, defaultBucket: files.buckets.defaultBucket })
          : undefined
      }
      onOpenRules={
        rules && decision
          ? () =>
              rules({
                ...(files.buckets.rulesMode === 'perBucket'
                  ? { bucket: request?.bucket ?? files.bucket }
                  : {}),
                panel: 'decisions',
                decision,
                ...(extras.line ? { line: extras.line } : {}),
              })
          : undefined
      }
    />
  )
}
