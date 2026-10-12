// One call to the Auth emulator: 32 px like every list. The time in the
// console-wide clock format, who called (a quiet chip; Try and Replay for
// the calls the developer asked the console to make), what it was, the
// identifier and the provider in the data face, how it ended — `ok` in the
// success tone, else the emulator's code in the danger tone with the name
// the SDK gives it — what it caused, and how long it took.

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
            {/* The code keeps its width; the SDK's name gives way. */}
            <span className="flex shrink-0">
              <OutcomeChip word={call.error.code} tone="danger" mono testId="activity-outcome" />
            </span>
            <span
              className="hidden truncate font-mono text-[11px] text-kumo-subtle @2xl:inline"
              data-testid="activity-sdk"
            >
              {sdkCode(call.error.code)}
            </span>
          </>
        ) : (
          <OutcomeChip word="ok" tone="success" mono testId="activity-outcome" />
        )}
      </span>
      <span className="hidden min-w-0 flex-[3] basis-0 items-center gap-1 overflow-hidden pr-3 @4xl:flex">
        {shown.map((chip) => (
          <span
            key={chip.text}
            className={`${QUIET_CHIP} ${chip.tone === 'danger' ? 'text-kumo-danger' : ''}`}
            data-testid="activity-step"
          >
            {chip.text}
          </span>
        ))}
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

export const ActivityRow = memo(ActivityRowView)
