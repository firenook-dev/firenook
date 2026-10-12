// Confirming a change to many users that destroys nothing — disable,
// enable, verify, revoke: the engine's dry run first, so the dialog states
// the real numbers ("Disable 1,204 users? 3 are already disabled."), then
// the job, with its progress, its first failures as user links and Cancel.

import { Button, Dialog, Text } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { BulkTarget } from '@/api/generated/BulkTarget'
import { EntityLink } from '@/components/console/entity-link'
import { jobProgress } from '@/components/console/danger-confirm'
import { cancelJob, useJob } from '@/lib/jobs'
import { formatNumber } from '@/lib/format'
import { previewBulk, startBulk } from '../api'
import { type SimpleVerb, VERB_WORDS, previewSentence } from '../bulk'
import { refusal } from '../user-actions'

export function BulkConfirm({
  open,
  onOpenChange,
  project,
  verb,
  target,
  count,
  jobId,
  onStarted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: string
  verb: SimpleVerb
  target: BulkTarget
  /** How many the selection names (before the dry run answers). */
  count: number
  /** The job this confirm started, once it has. */
  jobId: string | undefined
  onStarted: (jobId: string) => void
}) {
  const words = VERB_WORDS[verb]
  const preview = useQuery({
    queryKey: ['auth', project, 'bulk-preview', verb, JSON.stringify(target)],
    queryFn: ({ signal }) => previewBulk(project, verb, { target }, signal),
    enabled: open && jobId === undefined,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
  const start = useMutation({
    mutationFn: () => startBulk(project, verb, { target }),
    onSuccess: (job) => onStarted(job.id),
  })
  const job = useJob(jobId)
  const running = start.isPending || job?.state === 'running'
  const finished = job !== undefined && job.state !== 'running'
  const close = (next: boolean) => {
    if (!next && running) return
    onOpenChange(next)
  }
  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog size="base" className="p-6">
        <div className="contents" data-testid="bulk-confirm">
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">
              {words.title(preview.data?.matched ?? count)}
            </Dialog.Title>
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
          <Dialog.Description className="text-kumo-subtle">
            {preview.data ? previewSentence(verb, preview.data) : 'Counting what would change…'}{' '}
            {words.explains}
          </Dialog.Description>
          {preview.isError && (
            <p className="mt-2 text-[13px] text-kumo-danger">{refusal(preview.error)}</p>
          )}
          {job && (
            <div className="mt-3 grid gap-1" data-testid="bulk-confirm-progress">
              <Text variant="secondary" size="sm">
                {jobProgress(job, words.done)}
              </Text>
              {job.errors.length > 0 && (
                <ul className="grid max-h-40 gap-1 overflow-auto rounded-md bg-kumo-tint p-2 text-[12px]">
                  {job.errors.map((item, index) => (
                    <li
                      // One key can fail twice, so its place keeps the rows apart.
                      // oxlint-disable-next-line react/no-array-index-key
                      key={`${item.key}-${index}`}
                      className="grid gap-0.5"
                    >
                      <EntityLink entity={{ kind: 'auth.user', key: item.key }} />
                      <span className="text-kumo-subtle">{item.message}</span>
                    </li>
                  ))}
                  {job.errorCount > job.errors.length && (
                    <li className="text-kumo-subtle">
                      and {formatNumber(job.errorCount - job.errors.length)} more like these
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}
          {start.isError && (
            <p className="mt-2 text-[13px] text-kumo-danger" data-testid="bulk-confirm-error">
              {refusal(start.error)}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            {job?.state === 'running' ? (
              <Button
                variant="secondary"
                onClick={() => void cancelJob(job.id)}
                data-testid="bulk-confirm-cancel"
              >
                Cancel
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => close(false)}>
                {finished ? 'Close' : 'Cancel'}
              </Button>
            )}
            {!finished && (
              <Button
                variant="primary"
                onClick={() => start.mutate()}
                loading={running}
                disabled={
                  preview.isPending || preview.isError || (preview.data?.matched ?? 0) === 0
                }
                data-testid="bulk-confirm-go"
              >
                {words.button}
              </Button>
            )}
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
