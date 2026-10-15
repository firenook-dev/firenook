// "Publish again" (PS-14, PS-07b): messages the history still keeps,
// published to their topic once more — every subscription and function on it
// gets them again, which runs code, so it asks first (`r` never publishes on
// its own). One message or a thousand is one `pubsub.publish` job: its
// progress is in the strip above the list, in every tab, and any of them can
// stop it.

import { Button, Dialog } from '@cloudflare/kumo'
import { PaperPlaneTiltIcon, XIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { errorText } from '@/lib/error-text'
import type { BulkTarget } from '@/api/generated/BulkTarget'
import { formatNumber } from '@/lib/format'
import { toast } from '@/lib/toasts'
import { startPublishJob } from '../api'
import { shortName } from '../names'

export interface AgainRequest {
  target: BulkTarget
  /** How many messages it names (the selection's count, or a query's total). */
  count: number
}

export function PublishAgainDialog({
  request,
  topic,
  onOpenChange,
  onStarted,
}: {
  request: AgainRequest | null
  /** The topic's full name. */
  topic: string
  onOpenChange: (open: boolean) => void
  onStarted?: () => void
}) {
  const queryClient = useQueryClient()
  const topicId = shortName(topic)
  const again = useMutation({
    mutationFn: (target: BulkTarget) => startPublishJob({ topic, target }),
    onSuccess: (job) => {
      queryClient.setQueryData(['jobs', job.id], job)
      toast({ key: `pubsub-again-${job.id}`, title: job.title })
      onOpenChange(false)
      onStarted?.()
    },
  })
  const count = request?.count ?? 0
  const what = count === 1 ? 'this message' : `these ${formatNumber(count)} messages`
  return (
    <Dialog.Root
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) again.reset()
        onOpenChange(open)
      }}
    >
      <Dialog size="base" className="p-6">
        <div className="contents" data-testid="publish-again">
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">
              Publish {count === 1 ? 'again' : `${formatNumber(count)} again`}
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
            />
          </div>
          <Dialog.Description className="text-kumo-subtle">
            Publishes {what} to <span className="font-mono text-[0.9em]">{topicId}</span> again,
            with the same data, attributes and ordering key and a new id each. Every subscription
            and function on {topicId} receives {count === 1 ? 'it' : 'them'} again, so a function
            runs its code again.
          </Dialog.Description>
          {again.isError && (
            <p className="mt-3 mb-0 text-[13px] text-kumo-danger" data-testid="publish-again-error">
              {errorText(again.error)}
            </p>
          )}
          <form
            className="mt-5 flex justify-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (request) again.mutate(request.target)
            }}
          >
            <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              icon={<PaperPlaneTiltIcon />}
              loading={again.isPending}
              autoFocus
              data-testid="publish-again-confirm"
            >
              Publish {count === 1 ? 'again' : formatNumber(count)}
            </Button>
          </form>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
