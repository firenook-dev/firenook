// One scheduled function (S19, SC-02): its expression in words and the zone
// it is evaluated in, its next five runs in that zone and on this clock, how
// many times it has run since the start, and its runs — the first, kept for
// good, and the nineteen latest, with how many in between were not kept —
// each with what started it (the clock or the console), the message its
// tick was, how the function's delivery went, and its logs. The footer runs
// it now, pauses or resumes its clock, and opens its schedule topic.

import { Button, Tooltip } from '@cloudflare/kumo'
import { ArrowSquareOutIcon, PauseIcon, PlayIcon } from '@phosphor-icons/react'
import { useRef } from 'react'
import type { PubsubSchedule } from '@/api/generated/messaging/PubsubSchedule'
import type { PubsubScheduleRun } from '@/api/generated/messaging/PubsubScheduleRun'
import { EntityLink } from '@/components/console/entity-link'
import {
  Inspector,
  InspectorFooter,
  InspectorSection,
  InspectorTitle,
} from '@/components/console/inspector'
import { KeyValueList, type KeyValueItem } from '@/components/console/key-value-list'
import { OutcomeChip } from '@/components/console/outcome-chip'
import { RelativeTime } from '@/components/console/relative-time'
import { Kbd, StatusDot } from '@/components/kit'
import { formatNumber } from '@/lib/format'
import { useNavigate } from '@tanstack/react-router'
import { linkTo } from '@/lib/links'
import { DeliveryOutcome } from '../components/deliveries-table'
import { LogsLink } from '../components/message-inspector'
import { shortName } from '../names'
import {
  describeSchedule,
  localTime,
  notAutomaticText,
  scheduleState,
  stateLook,
  zoneTime,
} from '../schedule-text'
import { deliveryDetail } from '../states'

/** The minute either side of a run its logs are looked for in, when its invocation is not known. */
const LOG_WINDOW_MS = 60_000

/** Where a run's logs are: its invocation's, else the function's around the run. */
export function runLogs(
  schedule: Pick<PubsubSchedule, 'functionId'>,
  run: Pick<PubsubScheduleRun, 'at' | 'delivery'>,
): { function: string; execution?: string; from?: string; to?: string } {
  const invocation = run.delivery?.invocation?.key
  if (invocation) return { function: schedule.functionId, execution: invocation }
  const at = Date.parse(run.at)
  return {
    function: schedule.functionId,
    from: new Date(at - LOG_WINDOW_MS).toISOString(),
    to: new Date(at + LOG_WINDOW_MS).toISOString(),
  }
}

function RunRow({ schedule, run }: { schedule: PubsubSchedule; run: PubsubScheduleRun }) {
  const delivery = run.delivery
  const error = delivery?.mark === 'failed' ? deliveryDetail(delivery) : undefined
  return (
    <li
      className="grid gap-0.5 py-1.5"
      data-testid="schedule-run"
      data-trigger={run.trigger}
      data-mark={run.skipped ? 'skipped' : (delivery?.mark ?? 'published')}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <RelativeTime iso={run.at} className="w-20 shrink-0 text-kumo-default" />
        <span className="w-14 shrink-0 text-[12px] text-kumo-subtle">{run.trigger}</span>
        {run.skipped ? (
          <OutcomeChip word="skipped" tone="neutral" detail={run.skipped} />
        ) : delivery ? (
          <DeliveryOutcome row={delivery} />
        ) : (
          <OutcomeChip
            word="published"
            tone="neutral"
            detail="The tick was published; no delivery to the function is recorded for it."
          />
        )}
        {run.messageId && (
          <span className="flex min-w-0 items-center gap-1 text-[12px] text-kumo-subtle">
            message
            <EntityLink
              entity={{
                kind: 'pubsub.message',
                key: `${schedule.topic}|${run.messageId}`,
                label: run.messageId,
              }}
              testId="schedule-run-message"
            />
          </span>
        )}
        <span className="ml-auto">
          <LogsLink filter={runLogs(schedule, run)} testId="schedule-run-logs">
            Logs
          </LogsLink>
        </span>
      </div>
      {run.skipped && (
        <p className="m-0 text-[12px] text-kumo-subtle" data-testid="schedule-run-skipped">
          {run.skipped}
        </p>
      )}
      {error && (
        <p
          className="m-0 font-mono text-[12px] [overflow-wrap:anywhere] text-kumo-danger"
          data-testid="schedule-run-error"
        >
          {error}
        </p>
      )}
    </li>
  )
}

export function ScheduleInspector({
  schedule,
  onClose,
  onPrev,
  onNext,
  onRunNow,
  onPause,
  pausing,
}: {
  schedule: PubsubSchedule
  onClose: () => void
  onPrev?: (() => void) | undefined
  onNext?: (() => void) | undefined
  /** Asks to run it now, the question hung off `anchor`. */
  onRunNow: (anchor: Element | null) => void
  /** Pauses (true) or resumes (false) its clock. */
  onPause: (paused: boolean) => void
  pausing: boolean
}) {
  const navigate = useNavigate()
  const runButton = useRef<HTMLButtonElement>(null)
  const state = scheduleState(schedule)
  const look = stateLook(state)
  const description = describeSchedule(schedule.expression)
  const zone = schedule.evaluatedIn
  const topicLink = linkTo({ kind: 'pubsub.topic', key: schedule.topic })
  const kept = schedule.lastRuns.length + (schedule.firstRun ? 1 : 0)

  const facts: KeyValueItem[] = [
    {
      label: 'Schedule',
      value: (
        <span className="grid gap-0.5">
          <span>{schedule.expression}</span>
          {description && description !== schedule.expression && (
            <span className="font-sans text-[11px] text-kumo-subtle">{description}</span>
          )}
        </span>
      ),
      copy: schedule.expression,
      testId: 'schedule-expression',
    },
    {
      label: 'Evaluated in',
      value: schedule.timeZone ? zone : `${zone} (no time zone declared)`,
      testId: 'schedule-zone',
    },
    {
      label: 'Function',
      value: <EntityLink entity={{ ...schedule.functionRef, label: schedule.functionName }} />,
      copy: schedule.functionId,
    },
    { label: 'Region', value: schedule.region },
    {
      label: 'Topic',
      value: (
        <EntityLink
          entity={{ kind: 'pubsub.topic', key: schedule.topic, label: shortName(schedule.topic) }}
        />
      ),
      copy: schedule.topic,
    },
    ...(schedule.sharesTopicWith.length > 0
      ? [
          {
            label: 'Shares its topic with',
            value: (
              <span className="text-kumo-warning">
                {schedule.sharesTopicWith.map((id) => shortName(id)).join(', ')}
              </span>
            ),
            hint: 'Functions of one name in two regions publish to one schedule topic in this engine, so each tick runs both.',
          } satisfies KeyValueItem,
        ]
      : []),
  ]

  return (
    <Inspector
      widthKey="pubsub.schedule"
      title={<InspectorTitle value={schedule.functionId} />}
      meta={
        <span data-testid="schedule-inspector-state">
          <StatusDot tone={look.tone} label={look.word} />
        </span>
      }
      onClose={onClose}
      closeLabel="Close the schedule"
      noun="schedule"
      onPrev={onPrev}
      onNext={onNext}
      footer={
        <InspectorFooter
          tools={
            topicLink && (
              <Tooltip
                content={`Open ${shortName(schedule.topic)}: one message per tick`}
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<ArrowSquareOutIcon />}
                    onClick={() =>
                      void navigate({
                        to: topicLink.to as never,
                        search: topicLink.search as never,
                      })
                    }
                    data-testid="schedule-open-topic"
                  >
                    Open topic
                  </Button>
                }
              />
            )
          }
          primary={
            <>
              <Button
                variant="secondary"
                size="sm"
                icon={schedule.paused ? <PlayIcon /> : <PauseIcon />}
                loading={pausing}
                onClick={() => onPause(!schedule.paused)}
                data-testid="schedule-pause"
              >
                {schedule.paused ? 'Resume' : 'Pause'}
              </Button>
              <Tooltip
                content={
                  <span className="flex items-center gap-1.5">
                    Run it now; it asks first <Kbd>r</Kbd>
                  </span>
                }
                render={
                  <Button
                    ref={runButton}
                    variant="primary"
                    size="sm"
                    icon={<PlayIcon />}
                    onClick={() => onRunNow(runButton.current)}
                    data-testid="schedule-run-now"
                  >
                    Run now…
                  </Button>
                }
              />
            </>
          }
        />
      }
      testId="pubsub-schedule-inspector"
    >
      <InspectorSection title="Schedule">
        <KeyValueList items={facts} testId="schedule-facts" />
      </InspectorSection>
      <InspectorSection
        title="Next runs"
        count={state === 'not-automatic' ? 0 : schedule.upcoming.length}
        testId="schedule-upcoming"
      >
        {state === 'paused' && (
          <p className="m-0 mb-1 text-[13px] text-kumo-subtle" data-testid="schedule-paused-note">
            Paused: its clock skips these ticks until you resume it. Run now still works.
          </p>
        )}
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="text-left text-[11px] text-kumo-subtle">
              <th className="pb-0.5 font-normal">In {zone}</th>
              <th className="pb-0.5 text-right font-normal">On this clock</th>
            </tr>
          </thead>
          <tbody>
            {schedule.upcoming.map((at) => (
              <tr key={at} data-testid="schedule-upcoming-run">
                <td className="py-0.5 font-mono text-kumo-default tabular-nums">
                  {zoneTime(at, zone)}
                </td>
                <td className="py-0.5 text-right font-mono text-kumo-subtle tabular-nums">
                  {localTime(at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </InspectorSection>
      {state === 'not-automatic' && (
        <InspectorSection title="Not run by the clock" testId="schedule-problem">
          <p className="m-0 text-[13px] text-kumo-warning">{notAutomaticText(schedule.problem)}</p>
        </InspectorSection>
      )}
      <InspectorSection title="Runs" count={schedule.runs} testId="schedule-runs">
        <p className="m-0 mb-1 text-[13px] text-kumo-subtle">
          {formatNumber(schedule.runs)} since the emulator started
          {schedule.runs > kept
            ? `; the first and the ${formatNumber(schedule.lastRuns.length)} latest are kept`
            : ''}
          .
        </p>
        <ul className="m-0 grid list-none divide-y divide-kumo-hairline p-0">
          {schedule.lastRuns.map((run) => (
            <RunRow key={`${run.at}-${run.trigger}`} schedule={schedule} run={run} />
          ))}
          {schedule.omittedRuns > 0 && (
            <li className="py-1.5 text-[12px] text-kumo-subtle" data-testid="schedule-omitted">
              {formatNumber(schedule.omittedRuns)} {schedule.omittedRuns === 1 ? 'run' : 'runs'} in
              between not kept
            </li>
          )}
          {schedule.firstRun && (
            <RunRow
              key={`first-${schedule.firstRun.at}`}
              schedule={schedule}
              run={schedule.firstRun}
            />
          )}
        </ul>
      </InspectorSection>
    </Inspector>
  )
}
