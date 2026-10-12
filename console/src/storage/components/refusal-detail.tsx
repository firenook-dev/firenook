// "See why" for a refusal the page met as a client: the explanation the
// refusal itself carried (the engine re-ran the request with every
// expression's value and sent it beside the 403), so it never dead-ends
// once the decision has left the engine's window; the same request in the
// Rules page's playground, to change the rules (or the request) until it
// goes through; and the decision on the Rules page while the engine still
// holds it.

import { Button, Popover, Text } from '@cloudflare/kumo'
import { ArrowSquareOutIcon, FlaskIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { PanelTitle } from '@/components/kit'
import { ExplanationView } from '@/rules/explanation-view'
import type { StorageErrorExtras } from '../api'
import { useFiles } from '../files-state'
import { rulesScope, storageRulesQuery } from '../queries'
import { useRulesPageLink, useTryInPlayground } from '../rules-link'

/** Storage's rules read Firestore documents as `firestore.get()` and `firestore.exists()`. */
export const STORAGE_READ_FUNCTIONS: readonly [string, string] = [
  'firestore.get()',
  'firestore.exists()',
]

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
    <Popover>
      <Popover.Trigger render={trigger} />
      <Popover.Content className="grid w-[560px] max-w-[calc(100vw-2rem)] gap-3">
        {/* Kumo's Popover.Content passes no data attributes on: the test id sits inside. */}
        <div className="contents" data-testid="refusal-detail">
          <PanelTitle>Why the rules refused it</PanelTitle>
          {extras.noRuleset ? (
            <Text size="sm" variant="secondary">
              No rules govern <span className="font-mono text-[0.9em]">gs://{files.bucket}</span>,
              so the emulator refuses every client request to it, the Admin SDK included.
            </Text>
          ) : extras.evaluation && source !== undefined ? (
            <div className="max-h-[50vh] overflow-auto">
              <ExplanationView
                result={extras.evaluation}
                rules={source}
                readFunctions={STORAGE_READ_FUNCTIONS}
              />
            </div>
          ) : (
            <Text size="sm" variant="secondary">
              {extras.line
                ? `Line ${extras.line} of the rules refused it.`
                : 'No allow matched, so the rules refused it by default.'}
            </Text>
          )}
          {((tryIt && request) || (rules && decision)) && (
            <div className="flex flex-wrap justify-end gap-2">
              {tryIt && request && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<FlaskIcon />}
                  onClick={() =>
                    tryIt(request, { decision, defaultBucket: files.buckets.defaultBucket })
                  }
                  data-testid="refusal-try"
                >
                  Try in the playground
                </Button>
              )}
              {rules && decision && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<ArrowSquareOutIcon />}
                  onClick={() =>
                    rules({
                      ...(files.buckets.rulesMode === 'perBucket'
                        ? { bucket: request?.bucket ?? files.bucket }
                        : {}),
                      panel: 'decisions',
                      decision,
                      ...(extras.line ? { line: extras.line } : {}),
                    })
                  }
                  data-testid="refusal-open-rules"
                >
                  Open on the Rules page
                </Button>
              )}
            </div>
          )}
        </div>
      </Popover.Content>
    </Popover>
  )
}
