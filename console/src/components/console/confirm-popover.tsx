// "Run onOrderPlaced again with message 1187? It runs your function's
// code." "Replay #1,284?" "Publish event #212 again with a new id?" A step
// that runs the app's code again — a function given one message again, a
// schedule's tick now, a task sent past its queue's pause or enqueued
// again, an invocation, an event or an Auth call replayed — asks first, in
// a popover beside what it acts on (the row, or the button pressed; the
// page's upper middle when that is gone), never a dialog that takes the
// screen, and never on a key alone: `r` opens it, Enter confirms. The
// words are the caller's and say plainly what runs again: whatever the
// function writes is written again, every trigger that listens runs again.
// Destroying data is `DangerConfirm`'s, a dialog.
//
// Two ways to use it: `ConfirmPopover` with the page holding `open` (it
// also takes an option, "Keep the id"), or `useConfirmPopover()`, whose
// `ask(request)` opens the page's one popover for whoever needs it.

import { Button, Checkbox, Popover } from '@cloudflare/kumo'
import { type ReactNode, useState } from 'react'
import { PanelTitle } from '@/components/kit'
import { errorText } from '@/lib/error-text'

export interface ConfirmPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** "Run nightlyCleanup now?" */
  title: string
  /** "It runs your function's code." */
  description: ReactNode
  /** The button's word: "Run now", "Run again", "Replay". */
  confirm: string
  /** What the popover hangs off: a row, or the control pressed; the page's upper middle when absent. */
  anchor?: Element | null | undefined
  /** A choice that changes what runs ("Keep the id"). */
  option?: { label: string; checked: boolean; onChange: (checked: boolean) => void } | undefined
  /**
   * Runs it. The popover waits while the promise is pending, closes once
   * it resolves, and says why when it rejects (`errorText`).
   */
  run: () => Promise<unknown> | void
  /** The popover's test id; its parts are `-description`, `-cancel`, `-confirm`, `-error`. */
  testId?: string | undefined
}

/** What `useConfirmPopover().ask` takes: everything but the open state. */
export type ConfirmRequest = Omit<ConfirmPopoverProps, 'open' | 'onOpenChange'>

/** The row of a `DataTable` or `FeedList` (its `testId`) by its key, for a popover to hang off. */
export function rowElement(containerTestId: string, key: string): Element | null {
  return document.querySelector(
    `[data-testid="${containerTestId}"] [data-key="${CSS.escape(key)}"]`,
  )
}

/** Where a popover whose control is gone opens: a third of the way down the middle of the page. */
const PAGE_MIDDLE = {
  getBoundingClientRect: () =>
    DOMRect.fromRect({ x: window.innerWidth / 2, y: window.innerHeight / 3, width: 0, height: 0 }),
}

export function ConfirmPopover({
  open,
  onOpenChange,
  title,
  description,
  confirm,
  anchor,
  option,
  run,
  testId = 'confirm-popover',
}: ConfirmPopoverProps) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  // Opened again: nothing of the last time shows.
  const [shown, setShown] = useState(open)
  if (open !== shown) {
    setShown(open)
    if (open) {
      setPending(false)
      setError(undefined)
    }
  }
  const go = async () => {
    if (pending) return
    setPending(true)
    setError(undefined)
    try {
      await run()
      setPending(false)
      onOpenChange(false)
    } catch (failure) {
      setPending(false)
      setError(errorText(failure))
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return
        onOpenChange(next)
      }}
    >
      <Popover.Content
        anchor={anchor ?? PAGE_MIDDLE}
        side="bottom"
        align="start"
        className="w-[320px] max-w-[calc(100vw-2rem)]"
      >
        <div
          className="grid gap-2"
          data-testid={testId}
          onKeyDown={(event) => {
            // Enter confirms wherever focus is in the popover, but on Cancel
            // and on the option, which Enter would otherwise both tick and run.
            if (event.key !== 'Enter' || event.defaultPrevented) return
            if (event.target instanceof HTMLElement && event.target.closest('[data-role]')) return
            event.preventDefault()
            void go()
          }}
        >
          <PanelTitle>{title}</PanelTitle>
          <p className="m-0 text-[13px] text-kumo-subtle" data-testid={`${testId}-description`}>
            {description}
          </p>
          {option && (
            <div data-role="option">
              <Checkbox
                checked={option.checked}
                onCheckedChange={(checked) => option.onChange(Boolean(checked))}
                label={option.label}
                disabled={pending}
              />
            </div>
          )}
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
              onClick={() => onOpenChange(false)}
              disabled={pending}
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
              onClick={() => void go()}
              data-testid={`${testId}-confirm`}
            >
              {confirm}
            </Button>
          </div>
        </div>
      </Popover.Content>
    </Popover>
  )
}

/** The page's one confirmation popover, opened by `ask` for whoever needs it. */
export function useConfirmPopover(): {
  ask: (request: ConfirmRequest) => void
  element: ReactNode
} {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  // The request stays drawn while the popover closes; `open` is what changes.
  const [open, setOpen] = useState(false)
  // Each ask is a popover of its own: nothing pending or failed carries over.
  const [asked, setAsked] = useState(0)
  const element = request ? (
    <ConfirmPopover key={asked} {...request} open={open} onOpenChange={setOpen} />
  ) : null
  return {
    ask: (next) => {
      setRequest(next)
      setAsked((count) => count + 1)
      setOpen(true)
    },
    element,
  }
}
