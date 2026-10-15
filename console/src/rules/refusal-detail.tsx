// "See why" for a request the rules refused, where it was refused: the
// Files page's upload, download or listing, the data page's read as a user.
// One popover on every page: the explanation (every condition that ran and
// the value each part had), the same request in the Rules page's
// playground, to change the rules (or the request) until it goes through,
// and the decision on the Rules page while the engine still holds it. Each
// page says where its explanation comes from: Storage's refusal carries it
// beside the 403; Firestore's is the newest matching decision, run again.

import { Button, Popover, Text } from '@cloudflare/kumo'
import { ArrowSquareOutIcon, FlaskIcon } from '@phosphor-icons/react'
import type { ReactElement, ReactNode } from 'react'
import { PanelTitle } from '@/components/kit'
import { type ExplainedResult, ExplanationView } from './explanation-view'

export function RefusalDetail({
  trigger,
  open,
  onOpenChange,
  explanation,
  pending = false,
  said,
  onTry,
  onOpenRules,
  openLabel = 'Open on the Rules page',
}: {
  /** The control that opens it ("See why"). */
  trigger: ReactElement
  open?: boolean | undefined
  onOpenChange?: ((open: boolean) => void) | undefined
  /** Why, condition by condition, when the page has the result and the rules it ran against. */
  explanation?:
    | { result: ExplainedResult; rules: string; readFunctions?: readonly [string, string] }
    | undefined
  /** The explanation is on its way. */
  pending?: boolean
  /** What the popover says without an explanation: the line that refused it, a bucket nobody serves. */
  said: ReactNode
  /** Put the request in the playground and go there. */
  onTry?: (() => void) | undefined
  /** Open the decision on the Rules page. */
  onOpenRules?: (() => void) | undefined
  openLabel?: string
}) {
  return (
    <Popover
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      <Popover.Trigger render={trigger} />
      <Popover.Content className="grid w-[560px] max-w-[calc(100vw-2rem)] gap-3">
        {/* Kumo's Popover.Content passes no data attributes on: the test id sits inside. */}
        <div className="contents" data-testid="refusal-detail">
          <PanelTitle>Why the rules refused it</PanelTitle>
          {explanation ? (
            <div className="max-h-[50vh] overflow-auto">
              <ExplanationView
                result={explanation.result}
                rules={explanation.rules}
                readFunctions={explanation.readFunctions}
              />
            </div>
          ) : pending ? (
            <Text size="sm" variant="secondary">
              Running it again for the values…
            </Text>
          ) : (
            <Text size="sm" variant="secondary">
              {said}
            </Text>
          )}
          {(onTry || onOpenRules) && (
            <div className="flex flex-wrap justify-end gap-2">
              {onTry && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<FlaskIcon />}
                  onClick={onTry}
                  data-testid="refusal-try"
                >
                  Try in the playground
                </Button>
              )}
              {onOpenRules && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<ArrowSquareOutIcon />}
                  onClick={onOpenRules}
                  data-testid="refusal-open-rules"
                >
                  {openLabel}
                </Button>
              )}
            </div>
          )}
        </div>
      </Popover.Content>
    </Popover>
  )
}
