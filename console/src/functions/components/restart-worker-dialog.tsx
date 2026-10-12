// "Restart the worker for app?" — the codebase view's and the ⋯ menu's
// Restart worker. A worker serves every function of its codebase, so the
// dialog says how many calls are in flight right now (live, from the
// snapshot) and what happens to them; Restart stops the Node process and
// the next call starts a fresh one.

import { Button, Dialog, Text } from '@cloudflare/kumo'
import { ArrowClockwiseIcon, XIcon } from '@phosphor-icons/react'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/api/client'
import { formatCount } from '@/lib/format'
import { toast } from '@/lib/toasts'
import { restartWorker } from '../api'

export function RestartWorkerDialog({
  open,
  onOpenChange,
  codebase,
  inFlight,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  codebase: string
  /** Calls the worker is serving now. */
  inFlight: number
}) {
  const [error, setError] = useState<string | undefined>(undefined)
  const restart = useMutation({
    mutationFn: () => restartWorker(codebase),
    onSuccess: (result) => {
      setError(undefined)
      onOpenChange(false)
      toast({
        key: `functions.restart.${codebase}`,
        title: `Restarted the ${codebase} worker`,
        description:
          result.dropped > 0
            ? `${formatCount(result.dropped, { one: 'call in flight was', other: 'calls in flight were' })} dropped.`
            : 'The next call starts it.',
        tone: 'success',
      })
    },
    onError: (failure) =>
      setError(
        failure instanceof ApiError ? failure.message : 'The worker could not be restarted.',
      ),
  })
  const close = (next: boolean) => {
    if (!next && restart.isPending) return
    if (!next) setError(undefined)
    onOpenChange(next)
  }
  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog size="base" className="p-6">
        <div className="contents" data-testid="restart-worker-dialog">
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">
              Restart the worker for <span className="font-mono">{codebase}</span>?
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
            />
          </div>
          <Dialog.Description className="text-kumo-subtle">
            The Node process that serves every function of {codebase} stops, and the next call
            starts a new one with the code and environment loaded now.
          </Dialog.Description>
          <p className="mt-3 text-[14px] text-kumo-default" data-testid="restart-in-flight">
            {inFlight === 0
              ? 'No calls are in flight.'
              : `${formatCount(inFlight, { one: 'call is', other: 'calls are' })} in flight. Calls in flight end with a dropped connection.`}
          </p>
          {error && (
            <div className="mt-2">
              <Text variant="error" size="sm">
                {error}
              </Text>
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => close(false)} disabled={restart.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<ArrowClockwiseIcon />}
              loading={restart.isPending}
              onClick={() => restart.mutate()}
              data-testid="restart-worker-confirm"
            >
              Restart
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
