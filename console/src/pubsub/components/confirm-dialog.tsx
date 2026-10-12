// A question before something that cannot be taken back from another
// side: acknowledging or returning a message a subscriber holds the lease
// of — its own ack will fail or the message will arrive twice — and handing
// rows back to the backlog in bulk. Said once, with the consequence; Enter
// confirms. What is destroyed for good goes through `DangerConfirm` instead.

import { Button, Dialog, Text } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { jobProgress } from '@/components/console/danger-confirm'
import { cancelJob, useJob } from '@/lib/jobs'

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  danger = false,
  jobId,
  progressVerb = 'done',
  error,
  pending,
  onConfirm,
  testId = 'confirm-dialog',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  confirmLabel: string
  /** The confirming button in red: the action loses something. */
  danger?: boolean
  /** A job the confirm started: its progress, and Cancel stops it. */
  jobId?: string | undefined
  progressVerb?: string
  error?: string | undefined
  pending: boolean
  onConfirm: () => void
  testId?: string
}) {
  const job = useJob(jobId)
  const running = pending || job?.state === 'running'
  const finished = job !== undefined && job.state !== 'running'
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // A running job is stopped with Cancel, not by dismissing the dialog.
        if (!next && running) return
        onOpenChange(next)
      }}
    >
      <Dialog size="base" className="p-6">
        <div className="contents" data-testid={testId}>
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              disabled={running}
              render={
                <Button
                  variant="ghost"
                  shape="square"
                  icon={<XIcon />}
                  aria-label="Close"
                  disabled={running}
                />
              }
            />
          </div>
          <Dialog.Description className="text-kumo-subtle">{description}</Dialog.Description>
          {job && (
            <div className="mt-3" data-testid={`${testId}-progress`}>
              <Text variant="secondary" size="sm">
                {jobProgress(job, progressVerb)}
              </Text>
            </div>
          )}
          {error && (
            <p className="mt-3 mb-0 text-[13px] text-kumo-danger" data-testid={`${testId}-error`}>
              {error}
            </p>
          )}
          <form
            className="mt-5 flex justify-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (!running && !finished) onConfirm()
            }}
          >
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                if (job?.state === 'running' && jobId) void cancelJob(jobId)
                else onOpenChange(false)
              }}
              data-testid={`${testId}-cancel`}
            >
              {finished ? 'Close' : 'Cancel'}
            </Button>
            {!finished && (
              <Button
                variant={danger ? 'destructive' : 'primary'}
                type="submit"
                loading={running}
                autoFocus
                data-testid={`${testId}-confirm`}
              >
                {confirmLabel}
              </Button>
            )}
          </form>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
