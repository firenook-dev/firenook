// Running something again re-runs its side effects, so a key never does it
// without asking: `r` on an invocation or an event opens this, and its
// Replay button is the confirmation. (A footer's Replay button is a
// deliberate click and needs no second one.) Functions and Eventarc share
// it, each with its own words.

import { Button, Checkbox, Dialog, Text } from '@cloudflare/kumo'
import { ArrowCounterClockwiseIcon, XIcon } from '@phosphor-icons/react'

export function ReplayConfirm({
  open,
  onOpenChange,
  title,
  description,
  option,
  pending,
  error,
  onConfirm,
  testId = 'replay-confirm',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** "Replay #1,284?", "Publish event #212 again with a new id?". */
  title: string
  /** What running it again does. */
  description: string
  /** A choice that changes what Replay does ("Keep the id"). */
  option?: { label: string; checked: boolean; onChange: (checked: boolean) => void } | undefined
  pending: boolean
  error?: string | undefined
  onConfirm: () => void
  testId?: string
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return
        onOpenChange(next)
      }}
    >
      <Dialog size="base" className="p-6">
        <div className="contents" data-testid={testId}>
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              disabled={pending}
              render={
                <Button
                  variant="ghost"
                  shape="square"
                  icon={<XIcon />}
                  aria-label="Close"
                  disabled={pending}
                />
              }
            />
          </div>
          <Dialog.Description className="text-kumo-subtle">{description}</Dialog.Description>
          {option && (
            <div className="mt-4">
              <Checkbox
                checked={option.checked}
                onCheckedChange={(checked) => option.onChange(Boolean(checked))}
                label={option.label}
                disabled={pending}
              />
            </div>
          )}
          {error && (
            <div className="mt-3" data-testid={`${testId}-error`}>
              <Text variant="error" size="sm">
                {error}
              </Text>
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<ArrowCounterClockwiseIcon />}
              onClick={onConfirm}
              loading={pending}
              autoFocus
              data-testid={`${testId}-confirm`}
            >
              Replay
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
