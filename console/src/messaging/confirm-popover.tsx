// "Run onOrderPlaced again with message 1187? It runs your function's
// code." "Run order-1 now? It runs processOrder's code." A step that runs
// user code — a function given one message again, a schedule's tick now, a
// task sent past its queue's pause or enqueued again — asks first, in a
// popover beside what it acts on (the row, or the button pressed), never a
// dialog that takes the screen, and never on a key alone: `r` opens it,
// Enter confirms (messaging spec §4.6, §4.9). One popover per page, asked
// for by whoever needs it; Pub/Sub and Cloud Tasks share it.

import { Button, Popover } from '@cloudflare/kumo'
import { type ReactNode, useState } from 'react'
import { ApiError } from '@/api/client'
import { PanelTitle } from '@/components/kit'

export interface ConfirmRequest {
  /** "Run nightlyCleanup now?" */
  title: string
  /** "It runs your function's code." */
  description: ReactNode
  /** The button's word: "Run now", "Run again", "Enqueue again". */
  confirm: string
  /** What the popover hangs off: a row, or the control pressed; the page's middle when gone. */
  anchor: Element | null
  run: () => Promise<unknown>
  testId?: string
}

/** An engine refusal as its message and then its fix; anything else as its message. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.fix ? `${error.message} ${error.fix}` : error.message
  return error instanceof Error ? error.message : String(error)
}

/** The row of a `DataTable` (its `testId`) by its key, for a popover to hang off. */
export function rowElement(tableTestId: string, key: string): Element | null {
  return document.querySelector(`[data-testid="${tableTestId}"] [data-key="${CSS.escape(key)}"]`)
}

export function useConfirmPopover(): {
  ask: (request: ConfirmRequest) => void
  element: ReactNode
} {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const close = () => {
    setRequest(null)
    setPending(false)
    setError(undefined)
  }
  const confirm = async () => {
    if (!request || pending) return
    setPending(true)
    setError(undefined)
    try {
      await request.run()
      close()
    } catch (failure) {
      setPending(false)
      setError(errorText(failure))
    }
  }
  const testId = request?.testId ?? 'confirm-popover'
  const element = (
    <Popover
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !pending) close()
      }}
    >
      <Popover.Content
        anchor={request?.anchor ?? undefined}
        side="bottom"
        align="start"
        className="w-[320px] max-w-[calc(100vw-2rem)]"
      >
        <div
          className="grid gap-2"
          data-testid={testId}
          onKeyDown={(event) => {
            // Enter confirms wherever focus is in the popover, but on Cancel.
            if (event.key !== 'Enter' || event.defaultPrevented) return
            if (event.target instanceof HTMLElement && event.target.dataset.role === 'cancel')
              return
            event.preventDefault()
            void confirm()
          }}
        >
          <PanelTitle>{request?.title}</PanelTitle>
          <p className="m-0 text-[13px] text-kumo-subtle">{request?.description}</p>
          {error && (
            <p
              className="m-0 text-[13px] text-kumo-danger"
              role="alert"
              data-testid={`${testId}-error`}
            >
              {error}
            </p>
          )}
          <div className="mt-1 flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={close}
              data-role="cancel"
              data-testid={`${testId}-cancel`}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              // Enter confirms: the one key a confirmation should answer to.
              autoFocus
              loading={pending}
              onClick={() => void confirm()}
              data-testid={`${testId}-confirm`}
            >
              {request?.confirm}
            </Button>
          </div>
        </div>
      </Popover.Content>
    </Popover>
  )
  return {
    ask: (next) => {
      setError(undefined)
      setPending(false)
      setRequest(next)
    },
    element,
  }
}
