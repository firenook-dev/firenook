// Deleting many users: the ticked ones, every match of the filter, every
// user of the tenant, or the sample users — through the foundation's
// DangerConfirm, which names the functions the delete runs (`user.delete`,
// once per user), says how to get them back and, past 100 users, asks for
// the number to be typed. A delete that would run triggers is limited to
// 10,000 users; every user of the tenant, and the sample users, may go
// without triggers instead — the emulator's own delete-all, and the default
// for sample users, whose import fired none. The delete is a job: progress,
// failures and Cancel come from it.

import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { BulkTarget } from '@/api/generated/BulkTarget'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { formatNumber } from '@/lib/format'
import { previewBulk, startBulk } from '../api'
import {
  TRIGGERED_DELETE_LIMIT,
  TYPE_TO_CONFIRM_OVER,
  VERB_WORDS,
  deleteRefusal,
  needsDryRun,
  withoutTriggersOffer,
} from '../bulk'
import { refusal } from '../user-actions'
import { useAccountTriggers } from '../user-triggers'

export function BulkDeleteDialog({
  open,
  onOpenChange,
  project,
  tenant,
  target,
  count,
  title,
  jobId,
  onStarted,
  testId = 'bulk-delete',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: string
  tenant: string | undefined
  target: BulkTarget
  /** How many the target names before the dry run answers. */
  count: number
  /** The dialog's own words, when it is a named delete ("Delete sample users"). */
  title?: string | undefined
  jobId: string | undefined
  onStarted: (jobId: string) => void
  testId?: string
}) {
  const offer = withoutTriggersOffer(target)
  const [withoutTriggers, setWithoutTriggers] = useState(offer === 'default')
  // Each opening starts from the target's own default.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setWithoutTriggers(offer === 'default')
  }
  const triggers = useAccountTriggers(tenant, 'user.delete')
  const preview = useQuery({
    queryKey: ['auth', project, 'bulk-preview', 'delete', JSON.stringify(target)],
    queryFn: ({ signal }) => previewBulk(project, 'delete', { target, triggers: true }, signal),
    enabled: open && jobId === undefined && needsDryRun(target),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
  const matched = preview.data?.matched ?? count
  const start = useMutation({
    mutationFn: () => startBulk(project, 'delete', { target, triggers: !withoutTriggers }),
    onSuccess: (job) => onStarted(job.id),
  })
  const limited = deleteRefusal(matched, !withoutTriggers)
  const consequences = [
    VERB_WORDS.delete.explains,
    ...(withoutTriggers
      ? ['No user.delete event fires for them: the emulator’s own delete-all.']
      : matched > TRIGGERED_DELETE_LIMIT
        ? [limited]
        : []),
  ]
  return (
    <DangerConfirm
      open={open}
      onOpenChange={(next) => {
        if (!next) start.reset()
        onOpenChange(next)
      }}
      title={title ?? VERB_WORDS.delete.title(matched)}
      description={
        preview.isPending && needsDryRun(target) && jobId === undefined
          ? 'Counting the users this deletes…'
          : `Deletes ${formatNumber(matched)} ${matched === 1 ? 'user' : 'users'} as deleteUsers() does.`
      }
      {...(withoutTriggers ? {} : { triggers: { answer: triggers, times: matched } })}
      consequences={consequences}
      {...(matched > TYPE_TO_CONFIRM_OVER ? { confirmText: formatNumber(matched) } : {})}
      {...(offer === 'off'
        ? {}
        : {
            option: {
              label: 'Delete without triggers',
              checked: withoutTriggers,
              onChange: setWithoutTriggers,
            },
          })}
      {...(jobId ? { jobId } : {})}
      progressVerb="deleted"
      {...(start.isError
        ? { error: refusal(start.error) }
        : preview.isError
          ? { error: refusal(preview.error) }
          : {})}
      pending={start.isPending}
      onConfirm={() => start.mutate()}
      testId={testId}
    />
  )
}
