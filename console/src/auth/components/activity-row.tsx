// One call to the Auth emulator: 32 px like every list. The time in the
// console-wide clock format, who called (a quiet chip; Try and Replay for
// the calls the developer asked the console to make), what it was, the
// identifier and the provider in the data face, how it ended — `ok` in the
// success tone, else the emulator's code in the danger tone with the name
// the SDK gives it — what it caused, and how long it took.

import { Tooltip } from '@cloudflare/kumo'
import { memo } from 'react'
import type { AuthActivitySummary } from '@/api/generated/auth/AuthActivitySummary'
import { OutcomeChip } from '@/components/console/outcome-chip'
import { callerChip, latencyText, stepChips } from '../activity'
import { sdkCode } from '../errors'
import { callLabel } from '../operations'
import { type FeedMenuHandle, FeedMenuRow } from './feed-menu'
import { FeedTime } from './feed-time'
import { QUIET_CHIP } from './message-row'

/** At most this many step chips; the rest are counted. */
const CHIPS = 3

function ActivityRowView({
  call,
  handle,
}: {
  call: AuthActivitySummary
  handle: { readonly current: FeedMenuHandle }
}) {
  const caller = callerChip(call)
  const asked = call.origin === 'try' || call.origin === 'replay'
  const chips = stepChips(call.steps, call.moreSteps)
  const shown = chips.slice(0, CHIPS)
  const hidden = chips.length - shown.length
  return (
    <FeedMenuRow rowKey={String(call.id)} label={`Actions for call ${call.id}`} handle={handle}>
      <FeedTime iso={call.at} className="w-[92px] shrink-0 pl-3 text-left" />
      <span className="flex w-[68px] shrink-0 items-center pl-2">
        <span
          className={`${QUIET_CHIP} ${asked ? 'text-kumo-default' : ''}`}
          data-testid="activity-caller"
        >
          {caller}
        </span>
      </span>
      <span
        className="min-w-28 flex-[3] basis-0 truncate pr-3 text-[12px] text-kumo-default"
        data-testid="activity-operation"
      >
        {callLabel(call)}
      </span>
      <span
        className="min-w-20 flex-[2] basis-0 truncate pr-3 font-mono text-[12px] text-kumo-default"
        data-testid="activity-identifier"
      >
        {call.identifier ?? call.uid ?? ''}
      </span>
      {/* What gives way as the list narrows (an open detail beside it):
          the steps first, then the provider, then the SDK's name. */}
      <span className="hidden w-24 shrink-0 truncate pr-3 font-mono text-[11px] text-kumo-subtle @3xl:block">
        {call.provider ?? ''}
      </span>
      <span className="flex min-w-36 flex-[3] basis-0 items-center gap-2 overflow-hidden pr-3">
        {call.error ? (
          <>
            {/* The code takes the room it needs and the SDK's name only what
                is left (its basis is zero), so the name gives way first; a
                code longer than the cell ends in an ellipsis. The whole of
                both is in the tooltip. */}
            <span className="flex min-w-0">
              <OutcomeChip
                word={call.error.code}
                tone="danger"
                mono
                shrink
                detail={`${call.error.code} · ${sdkCode(call.error.code)}`}
                testId="activity-outcome"
              />
            </span>
            <span
              className="hidden min-w-0 flex-1 basis-0 truncate font-mono text-[11px] text-kumo-subtle @2xl:inline"
              data-testid="activity-sdk"
            >
              {sdkCode(call.error.code)}
            </span>
          </>
        ) : (
          <OutcomeChip word="ok" tone="success" mono testId="activity-outcome" />
        )}
      </span>
      <span className="hidden min-w-0 flex-[3] basis-0 items-center gap-1 pr-3 @4xl:flex">
        {/* One line of whole chips: a chip that does not fit wraps out of
            sight rather than being cut mid-word; every step is in the
            tooltip. */}
        <StepChips chips={shown} all={chips} />
        {hidden > 0 && (
          <span className="shrink-0 font-mono text-[11px] text-kumo-subtle">+{hidden}</span>
        )}
      </span>
      <span
        className="w-16 shrink-0 pr-1 text-right font-mono text-[11px] text-kumo-subtle tabular-nums"
        data-testid="activity-latency"
      >
        {latencyText(call.durationMicros)}
      </span>
    </FeedMenuRow>
  )
}

function StepChips({
  chips,
  all,
}: {
  chips: ReturnType<typeof stepChips>
  all: ReturnType<typeof stepChips>
}) {
  if (chips.length === 0) return null
  const line = (
    <span
      className="flex h-4.5 min-w-0 flex-wrap items-center gap-x-1 overflow-hidden"
      aria-label={all.map((chip) => chip.text).join(', ')}
      data-testid="activity-steps"
    >
      {chips.map((chip) => (
        <span
          key={chip.text}
          className={`${QUIET_CHIP} ${chip.tone === 'danger' ? 'text-kumo-danger' : ''}`}
          data-testid="activity-step"
        >
          {chip.text}
        </span>
      ))}
    </span>
  )
  if (all.length === 1) return line
  return <Tooltip content={all.map((chip) => chip.text).join(' · ')} render={line} />
}

export const ActivityRow = memo(ActivityRowView)
