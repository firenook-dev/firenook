// The delivery trace of one event: every trigger that listens for its type
// on its channel, and what each did with it — the invocation it ran (how
// it ended, how long it took, a link to it in Functions), or the filter
// that kept it out, attribute by attribute. An event nobody listens for
// says so, with the type it probably meant.

import { Button, Tooltip } from '@cloudflare/kumo'
import type { EntityRef } from '@/api/generated/EntityRef'
import type { EventarcDelivery } from '@/api/generated/compute/EventarcDelivery'
import type { EventarcDeliveryRefs } from '@/api/generated/compute/EventarcDeliveryRefs'
import type { EventarcFilterMismatch } from '@/api/generated/compute/EventarcFilterMismatch'
import { EntityLink } from '@/components/console/entity-link'
import { OutcomeChip, invocationChip } from '@/components/console/outcome-chip'
import { DurationText } from '@/compute/duration-text'
import { formatNumber } from '@/lib/format'

/** A function id's short name: `onGreeted` for `us-central1-onGreeted`. */
export function functionShortName(id: string): string {
  const region = /^[a-z]+-[a-z]+\d+-/.exec(id)
  return region ? id.slice(region[0].length) : id
}

/** An invocation id's figure, as the console writes it: `#1,330` for `a3f9c1-1330`. */
export function invocationFigure(id: string): string {
  const seq = Number(id.slice(id.lastIndexOf('-') + 1))
  return Number.isFinite(seq) && seq > 0 ? `#${formatNumber(seq)}` : id
}

/** Why a filter kept an event out, in words: one clause per attribute. */
export function mismatchText(mismatches: readonly EventarcFilterMismatch[]): string {
  return mismatches
    .map((mismatch) =>
      mismatch.actual === null
        ? `the event has no ${mismatch.attribute}, the trigger wants ${mismatch.expected}`
        : `${mismatch.attribute} is ${mismatch.actual}, the trigger wants ${mismatch.expected}`,
    )
    .join('; ')
}

export function DeliveryList({
  deliveries,
  refs,
  unheard,
  eventType,
  suggestions,
  onUseType,
}: {
  deliveries: readonly EventarcDelivery[]
  refs: readonly EventarcDeliveryRefs[]
  unheard: boolean
  eventType: string
  /** Types heard on the channel close to an unheard one, nearest first. */
  suggestions: readonly string[]
  /** Publish the event again with a suggested type (the drawer, filled). */
  onUseType: (type: string) => void
}) {
  if (deliveries.length === 0)
    return (
      <div className="grid gap-1.5 text-[13px]" data-testid="deliveries-unheard">
        <p className="m-0 text-kumo-default">
          {unheard ? (
            <>
              No trigger listens for <span className="font-mono text-[12px]">{eventType}</span> on
              this channel.
            </>
          ) : (
            'No trigger was asked to take it.'
          )}
        </p>
        {suggestions.length > 0 && (
          <p className="m-0 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-kumo-subtle">
            Did you mean
            {suggestions.map((type, index) => (
              <span key={type} className="flex items-center gap-1">
                {index > 0 && <span>or</span>}
                <span className="font-mono text-[12px] text-kumo-default" data-testid="near-miss">
                  {type}
                </span>
                {index === suggestions.length - 1 && <span className="-ml-1">?</span>}
              </span>
            ))}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onUseType(suggestions[0] ?? eventType)}
              data-testid="near-miss-publish"
            >
              Publish it as that
            </Button>
          </p>
        )}
      </div>
    )
  return (
    <ul className="m-0 grid list-none gap-0.5 p-0" data-testid="delivery-list">
      {deliveries.map((delivery, index) => (
        <DeliveryRow
          key={delivery.triggerKey}
          delivery={delivery}
          refs={refs[index] ?? { function: null, invocation: null }}
        />
      ))}
    </ul>
  )
}

function DeliveryRow({
  delivery,
  refs,
}: {
  delivery: EventarcDelivery
  refs: EventarcDeliveryRefs
}) {
  const name = delivery.functionId ? functionShortName(delivery.functionId) : delivery.triggerKey
  const fn: EntityRef | null = refs.function ? { ...refs.function, label: name } : null
  const invocation: EntityRef | null =
    refs.invocation && delivery.invocationId
      ? { ...refs.invocation, label: invocationFigure(delivery.invocationId) }
      : null
  return (
    <li
      className="grid grid-cols-[minmax(0,148px)_minmax(0,1fr)] items-start gap-x-3 rounded-md px-2 py-1.5 -mx-2 hover:ink"
      data-testid="delivery"
      data-function={delivery.functionId ?? undefined}
      data-matched={delivery.matched ? '' : undefined}
    >
      <span className="min-w-0 pt-px">
        {fn ? (
          <EntityLink entity={fn} testId="delivery-function" />
        ) : (
          <Tooltip
            content="Registered through the Eventarc emulator's own route by a tool"
            render={
              <span className="block truncate font-mono text-[12px] text-kumo-default">{name}</span>
            }
          />
        )}
      </span>
      {delivery.matched ? (
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
          {delivery.outcome === null && delivery.invocationId === null ? (
            <span className="text-[12px] text-kumo-subtle" data-testid="delivery-outcome">
              Matched, not run
            </span>
          ) : delivery.outcome === null ? (
            <OutcomeChip outcome={null} outcomeClass="running" testId="delivery-outcome" />
          ) : (
            <OutcomeChip
              {...invocationChip({ outcome: delivery.outcome })}
              testId="delivery-outcome"
            />
          )}
          <DurationText ms={delivery.durationMs} placeholder="" />
          {invocation && (
            <span className="ml-auto">
              <EntityLink entity={invocation} testId="delivery-invocation" />
            </span>
          )}
        </span>
      ) : (
        <span className="grid min-w-0 gap-0.5 text-[12px]" data-testid="delivery-filtered">
          <span className="text-kumo-warning">Filtered out</span>
          <span className="font-mono break-words text-kumo-subtle">
            {mismatchText(delivery.mismatches)}
          </span>
        </span>
      )}
    </li>
  )
}
