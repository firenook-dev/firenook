// "Replay #1,284?" — what `r` asks before running an invocation again: a
// replay re-runs whatever the handler does, so the key always asks. (The
// detail's Replay button is the confirmation itself.)

import { Button, Dialog } from '@cloudflare/kumo'
import { ArrowCounterClockwiseIcon, XIcon } from '@phosphor-icons/react'
import { formatNumber } from '@/lib/format'

export function ReplayConfirm({
  open,
  onOpenChange,
  seq,
  pending,
  onReplay,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The invocation's number, as the console writes it (`#1,284`). */
  seq: number
  pending: boolean
  onReplay: () => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <Dialog size="base" className="p-6">
        <div className="contents" data-testid="replay-confirm">
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">
              Replay #{formatNumber(seq)}?
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
            />
          </div>
          <Dialog.Description className="text-kumo-subtle">
            The handler runs again with the same request, against the code loaded now; whatever it
            writes is written again.
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<ArrowCounterClockwiseIcon />}
              loading={pending}
              onClick={onReplay}
              data-testid="replay-confirm-replay"
            >
              Replay
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
