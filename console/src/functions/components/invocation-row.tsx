// One invocation as a 32 px line, the way every compute list draws it: how
// it ended (the engine's outcome and class, never derived here), what it
// was in words (`POST /orders`, `orders/o_123 created`, `task 81 ·
// attempt 2`), how long it took with the cold mark, who caused it, and
// when. On the Invocations page the line leads with the time and names the
// function and its kind, since rows of every function sit together.
//
// A `memo` component like the grid's rows: the feed re-renders a row only
// when its invocation object changes (a running row finishing).

import { Tooltip, cn } from '@cloudflare/kumo'
import { memo } from 'react'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import { OutcomeChip } from '@/components/console/outcome-chip'
import { RelativeTime, exactTime } from '@/components/console/relative-time'
import { type RowMenuItem, RowMenu } from '@/components/console/row-menu'
import { DurationText } from '@/compute/duration-text'
import { KindBadge } from '@/compute/kind-badge'
import { type ClockFormat, formatClock } from '@/lib/format'

/** Who caused an invocation, as the row says it. */
export const ORIGIN_WORDS: Readonly<Record<InvocationSummary['origin'], string>> = {
  console: 'console',
  replay: 'replay',
  emulator: 'emulator',
  client: 'client',
}

/** `us-central1-api` → `us-central1`. */
export function regionOfId(id: string): string {
  return /^([a-z]+-[a-z]+\d+)-/.exec(id)?.[1] ?? ''
}

/** `us-central1-api` → `api`. */
export function shortFunction(id: string): string {
  return id.replace(/^[a-z]+-[a-z]+\d+-/, '')
}

/** The summary as two parts: an HTTP method (shown quieter) and the rest. */
export function summaryParts(invocation: Pick<InvocationSummary, 'cause' | 'summary'>): {
  method?: string
  rest: string
} {
  if (invocation.cause.type === 'http') {
    const space = invocation.summary.indexOf(' ')
    if (space > 0)
      return {
        method: invocation.summary.slice(0, space),
        rest: invocation.summary.slice(space + 1),
      }
  }
  return { rest: invocation.summary }
}

/** The chip's tooltip: the error's first line, when it failed. */
function outcomeDetail(invocation: InvocationSummary): string | undefined {
  return invocation.error ?? undefined
}

function Summary({ invocation }: { invocation: InvocationSummary }) {
  const parts = summaryParts(invocation)
  return (
    <span
      className="min-w-0 flex-1 truncate font-mono text-[12px] text-kumo-default"
      data-testid="invocation-summary"
    >
      {parts.method && <span className="text-kumo-subtle">{parts.method} </span>}
      {parts.rest}
    </span>
  )
}

function InvocationRowInner({
  invocation,
  variant,
  clock,
  menu,
}: {
  invocation: InvocationSummary
  /** `function`: one function's list. `all`: the Invocations page, with time, function and kind. */
  variant: 'function' | 'all'
  clock: ClockFormat
  menu: readonly RowMenuItem[]
}) {
  const chip = (
    <span className="flex w-[124px] shrink-0 items-center overflow-hidden">
      <OutcomeChip
        outcome={invocation.outcome}
        outcomeClass={invocation.outcomeClass}
        status={invocation.status ?? undefined}
        callableStatus={invocation.callableStatus ?? undefined}
        startedAt={invocation.startedAt}
        detail={outcomeDetail(invocation)}
        testId="invocation-outcome"
      />
    </span>
  )
  const duration = (
    <span className="flex w-[84px] shrink-0 justify-end">
      <DurationText
        ms={invocation.durationMs}
        cold={invocation.cold}
        testId="invocation-duration"
      />
    </span>
  )
  const origin = (
    <span
      className="w-[64px] shrink-0 truncate text-[12px] text-kumo-subtle"
      data-testid="invocation-origin"
    >
      {ORIGIN_WORDS[invocation.origin]}
    </span>
  )
  return (
    <RowMenu items={menu}>
      <div
        className="group @container flex h-8 min-w-0 flex-1 items-center gap-3 px-3"
        data-testid="invocation-row"
        data-id={invocation.id}
        data-outcome={invocation.outcomeClass}
      >
        {variant === 'all' ? (
          <>
            <Tooltip
              content={exactTime(invocation.startedAt)}
              render={
                <span
                  className="w-[92px] shrink-0 font-mono text-[11px] text-kumo-subtle tabular-nums"
                  data-testid="invocation-time"
                >
                  {formatClock(invocation.startedAt, clock)}
                </span>
              }
            />
            <span
              className="w-[112px] shrink-0 truncate font-mono text-[12px] text-kumo-default @min-[860px]:w-[150px]"
              data-testid="invocation-function"
            >
              {shortFunction(invocation.functionId)}
            </span>
            <span className="hidden w-[78px] shrink-0 @min-[760px]:flex">
              <KindBadge kind={invocation.kind} tooltip={false} />
            </span>
            <Summary invocation={invocation} />
            <span className="hidden @min-[680px]:contents">{origin}</span>
            {chip}
            {duration}
          </>
        ) : (
          <>
            {chip}
            <Summary invocation={invocation} />
            {duration}
            {origin}
            <span className={cn('flex w-[76px] shrink-0 justify-end text-kumo-subtle')}>
              <RelativeTime iso={invocation.startedAt} className="text-kumo-subtle" />
            </span>
          </>
        )}
      </div>
    </RowMenu>
  )
}

export const InvocationRow = memo(InvocationRowInner)

/** The column header of the Invocations page's list (the function page's list has none). */
export function InvocationsHeader() {
  return (
    <div
      className="@container flex h-8 items-center gap-3 px-3 text-[12px] text-kumo-strong"
      data-testid="invocations-header"
    >
      <span className="w-[92px] shrink-0">Time</span>
      <span className="w-[112px] shrink-0 @min-[860px]:w-[150px]">Function</span>
      <span className="hidden w-[78px] shrink-0 @min-[760px]:block">Kind</span>
      <span className="min-w-0 flex-1 truncate">Summary</span>
      <span className="hidden w-[64px] shrink-0 @min-[680px]:block">Origin</span>
      <span className="w-[124px] shrink-0">Outcome</span>
      <span className="w-[84px] shrink-0 text-right">Duration</span>
    </div>
  )
}
