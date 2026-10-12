// One Eventarc event as a 32 px row, the way every list of events draws
// it — the Events page and an extension's Events tab: when it arrived, its
// type, who published it, its subject, and what became of it in one phrase
// ("2 delivered · 1 filtered out", "Unheard"). The deliveries carry the
// colour; the rest is data in the data face, quiet.

import { Tooltip, cn } from '@cloudflare/kumo'
import type { EventarcEventSummary } from '@/api/generated/compute/EventarcEventSummary'
import { StatusDot, type StatusTone } from '@/components/kit'
import { type ClockFormat, formatClock } from '@/lib/format'
import { exactTime } from '@/components/console/relative-time'

/** What became of an event, as a phrase and the tone of its dot. */
export function deliveryText(event: EventarcEventSummary): {
  text: string
  tone: StatusTone
  pulse: boolean
  detail: string
} {
  if (event.error !== null)
    return {
      text: 'Not read',
      tone: 'danger',
      pulse: false,
      detail: `The emulator could not read the event: ${event.error}`,
    }
  if (event.unheard)
    return {
      text: 'Unheard',
      tone: 'warning',
      pulse: false,
      detail: 'No trigger listens for this type on this channel.',
    }
  const parts: string[] = []
  if (event.delivered > 0) parts.push(`${event.delivered} delivered`)
  if (event.failed > 0) parts.push(`${event.failed} failed`)
  if (event.pending > 0) parts.push(`${event.pending} running`)
  if (event.filtered > 0) parts.push(`${event.filtered} filtered out`)
  const text = parts.length > 0 ? parts.join(' · ') : 'No delivery'
  const tone: StatusTone =
    event.failed > 0
      ? 'danger'
      : event.pending > 0
        ? 'neutral'
        : event.delivered === 0
          ? 'warning'
          : 'success'
  const detail =
    event.failed > 0
      ? 'A handler failed; open the event to see which and why.'
      : event.delivered === 0 && event.filtered > 0
        ? 'Every trigger for this type filtered it out; open the event to see which attribute did not match.'
        : event.pending > 0
          ? 'A handler is still running.'
          : 'Every trigger whose filters it matched ran it.'
  return { text, tone, pulse: event.pending > 0, detail }
}

/** Who published it: the extension instance, the console, a replay, or an app. */
export function publisherText(event: EventarcEventSummary): string {
  if (event.publisher) return `${event.publisher} (extension)`
  if (event.origin === 'console') return 'console'
  if (event.origin === 'replay') return 'replay'
  return event.source ?? 'app'
}

/**
 * The columns' widths, shared by the header and the rows, so they line up.
 * In a narrow list (an inspector open beside it) the publisher and the
 * subject give way, so the type and the deliveries keep their room; the
 * list that holds them is an `@container` (`EVENT_LIST`).
 */
export const EVENT_COLUMNS =
  'grid w-full grid-cols-[96px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,184px)] items-center gap-x-3 px-3 @max-[640px]:grid-cols-[88px_minmax(0,1fr)_minmax(0,176px)]'

/** What gives way in a narrow list. */
const NARROW_HIDDEN = '@max-[640px]:hidden'

/** The element around a list of event rows: the container its columns answer to. */
export const EVENT_LIST = '@container flex min-h-0 min-w-0 flex-1 flex-col'

/** The header over a list of events. */
export function EventHeader() {
  return (
    <div className={cn(EVENT_COLUMNS, 'h-7 whitespace-nowrap [&>*]:truncate')} role="row">
      <span role="columnheader">Time</span>
      <span role="columnheader">Type</span>
      <span role="columnheader" className={NARROW_HIDDEN}>
        Published by
      </span>
      <span role="columnheader" className={NARROW_HIDDEN}>
        Subject
      </span>
      <span role="columnheader">Deliveries</span>
    </div>
  )
}

/** One event's cells; the list draws the row around them. */
export function EventCells({
  event,
  clock,
  now,
}: {
  event: EventarcEventSummary
  clock: ClockFormat
  now: number
}) {
  const delivery = deliveryText(event)
  return (
    <div className={EVENT_COLUMNS} data-testid="event-cells" data-event={event.id}>
      <Tooltip
        content={exactTime(event.receivedAt)}
        render={
          <span className="truncate font-mono text-[11px] text-kumo-subtle tabular-nums">
            {formatClock(event.receivedAt, clock, now)}
          </span>
        }
      />
      <span className="truncate font-mono text-[12px] text-kumo-default" data-testid="event-type">
        {event.eventType}
      </span>
      <span className={cn('truncate font-mono text-[12px] text-kumo-subtle', NARROW_HIDDEN)}>
        {publisherText(event)}
      </span>
      <span className={cn('truncate font-mono text-[12px] text-kumo-subtle', NARROW_HIDDEN)}>
        {event.subject ?? '–'}
      </span>
      <Tooltip
        content={delivery.detail}
        render={
          <span className="flex min-w-0" data-testid="event-deliveries" data-tone={delivery.tone}>
            <StatusDot
              tone={delivery.tone}
              label={delivery.text}
              pulse={delivery.pulse}
              className="min-w-0 truncate"
            />
          </span>
        }
      />
    </div>
  )
}
