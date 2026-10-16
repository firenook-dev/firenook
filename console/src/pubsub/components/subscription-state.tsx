// The inspector's top block on a subscription's tab (S8): what the open
// message is at this subscription — its state, its place in the delivery
// order, the attempt (of the dead-letter policy's maximum), the lease
// counting down — and the two things the console can do to it there:
// acknowledge it, or end its lease now.

import { Button } from '@cloudflare/kumo'
import { ArrowCounterClockwiseIcon, CheckIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import type { PubsubBacklogRow } from '@/api/generated/messaging/PubsubBacklogRow'
import { StatusDot } from '@/components/kit'
import { useNow } from '@/lib/clock'
import { formatNumber } from '@/lib/format'
import { shortName } from '../names'
import { messageQuery } from '../queries'
import { atSubscriptionText, backlogState, countdownText, subscriptionTone } from '../states'

export function SubscriptionState({
  project,
  topic,
  subscription,
  id,
  row,
  maxDeliveries,
  onAck,
  onRelease,
}: {
  project: string
  topic: string
  /** The subscription's full name. */
  subscription: string
  id: string
  /** The message's backlog row, when it is loaded (patched live); else the message's own record. */
  row: PubsubBacklogRow | undefined
  /** The dead-letter policy's maximum, when there is one. */
  maxDeliveries: number | undefined
  /** Without them the block only reads (the Push tab: nothing holds a lease there). */
  onAck?: (() => void) | undefined
  onRelease?: (() => void) | undefined
}) {
  const message = useQuery(messageQuery(project, topic, id))
  const at = message.data?.subscriptions.find((entry) => entry.subscription === subscription)
  const state = row?.state ?? at?.state
  const leased = state === 'outstanding'
  const now = useNow(leased || state === 'pushing' ? 'second' : 'minute')
  const attempts = row?.attempts ?? at?.attempts ?? 0
  const lease = row?.leaseExpiresAt ?? at?.leaseExpiresAt ?? null

  let tone = subscriptionTone(at?.state ?? 'available')
  let word = at ? atSubscriptionText(at, now, maxDeliveries) : undefined
  if (row) {
    const look = backlogState(row, now)
    tone = look.tone
    word = row.state === 'outstanding' ? 'outstanding' : look.word
  }
  const waiting = state === 'available' || state === 'outstanding' || state === 'pushing'

  return (
    <section
      className="grid gap-1.5 border-b border-kumo-hairline px-4 py-3 text-[13px]"
      data-testid="pubsub-subscription-state"
    >
      <p className="m-0 text-[12px] text-kumo-subtle">
        on <span className="font-mono text-kumo-default">{shortName(subscription)}</span>
      </p>
      {word === undefined ? (
        <p className="m-0 text-kumo-subtle">
          {message.isPending ? 'Reading…' : 'Not in this subscription’s backlog.'}
        </p>
      ) : (
        <>
          <StatusDot tone={tone} label={word} testId="pubsub-subscription-state-word" />
          <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[12px]">
            {row?.place != null && (
              <>
                <dt className="text-kumo-subtle">Place</dt>
                <dd className="m-0 font-mono tabular-nums">
                  #{formatNumber(row.place)} in the delivery order
                </dd>
              </>
            )}
            {attempts > 0 && (
              <>
                <dt className="text-kumo-subtle">Attempt</dt>
                <dd
                  className="m-0 font-mono tabular-nums"
                  data-testid="pubsub-subscription-attempt"
                >
                  {maxDeliveries !== undefined
                    ? `${formatNumber(attempts)} of ${formatNumber(maxDeliveries)}`
                    : formatNumber(attempts)}
                </dd>
              </>
            )}
            {leased && lease && (
              <>
                <dt className="text-kumo-subtle">Lease</dt>
                <dd className="m-0 font-mono tabular-nums" data-testid="pubsub-subscription-lease">
                  {countdownText(lease, now) === 'expired'
                    ? 'expired'
                    : `ends in ${countdownText(lease, now).replace(' left', '')}`}
                </dd>
              </>
            )}
            {row?.blockedBy && (
              <>
                <dt className="text-kumo-subtle">Key</dt>
                <dd className="m-0">
                  waits for <span className="font-mono">{row.blockedBy}</span>
                </dd>
              </>
            )}
          </dl>
          {waiting && onAck && (
            <div className="mt-1 flex gap-2">
              <Button
                variant="secondary"
                size="xs"
                icon={<CheckIcon />}
                onClick={onAck}
                data-testid="pubsub-subscription-ack"
              >
                Ack
              </Button>
              {leased && onRelease && (
                <Button
                  variant="secondary"
                  size="xs"
                  icon={<ArrowCounterClockwiseIcon />}
                  onClick={onRelease}
                  data-testid="pubsub-subscription-release"
                >
                  Return
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
