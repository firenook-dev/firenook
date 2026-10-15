// Purge (S15): every message waiting at a subscription is acknowledged now,
// as a seek to now does, and what is published after arrives as usual. It
// is destructive, so it asks through `DangerConfirm`, saying whether the
// subscription keeps what it acknowledges; the toast says what is left, as
// the engine counts it.

import { Button, Tooltip } from '@cloudflare/kumo'
import { BroomIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { errorText } from '@/lib/error-text'
import { formatNumber } from '@/lib/format'
import { toast } from '@/lib/toasts'
import { purgeSubscription } from '../api'
import { shortName } from '../names'
import { pubsubKeys } from '../queries'

/** "The 3 messages waiting now are acknowledged", or that nothing waits. */
export function purgeSentence(waiting: number): string {
  if (waiting === 0)
    return 'Nothing is waiting now; messages published from now on arrive as usual.'
  return `The ${formatNumber(waiting)} ${waiting === 1 ? 'message' : 'messages'} waiting now ${waiting === 1 ? 'is' : 'are'} acknowledged, as if a subscriber had acked ${waiting === 1 ? 'it' : 'them'}; messages published from now on arrive as usual.`
}

/** What a purge left: "0 messages available, 3 acknowledged". */
export function purgedText(available: number, acked: number): string {
  return `${formatNumber(available)} ${available === 1 ? 'message' : 'messages'} available, ${formatNumber(acked)} acknowledged`
}

/** Row one's Purge… for the subscription in view, and the confirmation it opens. */
export function PurgeButton({
  project,
  subscription,
  retainAcked,
  waiting,
}: {
  project: string
  /** The subscription's full name. */
  subscription: string
  /** It keeps acknowledged messages (`retainAckedMessages`). */
  retainAcked: boolean
  /** Messages waiting at it now. */
  waiting: number
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const id = shortName(subscription)
  const purge = useMutation({
    mutationFn: () => purgeSubscription({ name: subscription }),
    onSuccess: (result) => {
      setOpen(false)
      toast({
        key: `pubsub-purge-${subscription}`,
        title: `Purged ${id}`,
        description: purgedText(result.available, result.acked),
        tone: 'success',
      })
      void queryClient.invalidateQueries({
        queryKey: pubsubKeys.subscriptionBacklog(project, subscription),
      })
      void queryClient.invalidateQueries({
        queryKey: pubsubKeys.subscription(project, subscription),
      })
    },
  })
  return (
    <>
      <Tooltip
        content={`Acknowledge everything waiting at ${id} now`}
        render={
          <Button
            variant="secondary"
            size="sm"
            icon={<BroomIcon />}
            onClick={() => {
              purge.reset()
              setOpen(true)
            }}
            data-testid="pubsub-purge"
          >
            Purge…
          </Button>
        }
      />
      <DangerConfirm
        open={open}
        onOpenChange={setOpen}
        title={`Purge ${id}`}
        description={purgeSentence(waiting)}
        consequences={[
          retainAcked
            ? 'The subscription keeps acknowledged messages: they stay in its backlog, listed as acked.'
            : 'The subscription does not keep acknowledged messages, so they do not come back.',
        ]}
        {...(purge.isError ? { error: errorText(purge.error) } : {})}
        pending={purge.isPending}
        onConfirm={() => purge.mutate()}
        testId="pubsub-purge-confirm"
      />
    </>
  )
}
