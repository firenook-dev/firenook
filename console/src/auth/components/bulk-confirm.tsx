// Confirming a change to many users that destroys nothing — disable,
// enable, verify, revoke: the engine's dry run first, so the confirmation
// states the real numbers ("Disable 1,204 users? 3 are already
// disabled."), then the job, through the console's one confirmation in
// its neutral tone (the primary button, no bin), which follows the job's
// progress, failures and Cancel.

import { useMutation, useQuery } from '@tanstack/react-query'
import type { BulkTarget } from '@/api/generated/BulkTarget'
import { DangerConfirm } from '@/components/console/danger-confirm'
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
  const error = start.isError
    ? refusal(start.error)
    : preview.isError
      ? refusal(preview.error)
      : undefined
  return (
    <DangerConfirm
      open={open}
      onOpenChange={(next) => {
        if (!next) start.reset()
        onOpenChange(next)
      }}
      tone="neutral"
      title={words.title(preview.data?.matched ?? count)}
      description={
        preview.data ? previewSentence(verb, preview.data) : 'Counting what would change…'
      }
      consequences={[words.explains]}
      {...(jobId ? { jobId } : {})}
      progressVerb={words.done}
      {...(error ? { error } : {})}
      pending={start.isPending}
      onConfirm={() => start.mutate()}
      testId="bulk-confirm"
    />
  )
}
