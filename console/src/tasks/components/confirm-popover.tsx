// "Run order-1 now? It runs processOrder's code." A step that runs user
// code, or enqueues it again, asks first — in a popover beside what it acts
// on (the row, or the button pressed), never a dialog that takes the
// screen, and never on a key alone: `r` opens it, Enter confirms
// (messaging spec §4.6, §4.9). One popover per page, asked for by whoever
// needs it.

import { Button, Popover } from '@cloudflare/kumo'
import { type ReactNode, useState } from 'react'
import { PanelTitle } from '@/components/kit'
import { errorText } from '../errors'

export interface ConfirmRequest {
  /** "Run order-1 now?" */
  title: string
  /** "It runs processOrder's code." */
  description: ReactNode
  /** The button's word: "Run now", "Enqueue again". */
  confirm: string
  /** What the popover hangs off: a row, or the control pressed; the page's middle when gone. */
  anchor: Element | null
  run: () => Promise<unknown>
  testId?: string
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
