// Run, for a schedule: what it runs on (the expression, in words beside a
// cron line, and the zone), when it runs next (the next five, in its zone
// and on this clock), whether its clock runs it (paused, or an expression
// the engine cannot evaluate) with Pause and Resume, how its last run went
// and its recent ticks (a skipped one says why) — and Run now, the same
// tick the clock makes, through Pub/Sub's scheduler. The scheduler's view
// is Pub/Sub's (`GET /pubsub/schedules`, live on `pubsub.schedules`).
// Without Pub/Sub nothing runs it on time, and Run now sends the functions
// shell's schedule envelope straight to the function.

import { Button, Text, Tooltip } from '@cloudflare/kumo'
import { PauseIcon, PlayIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ApiError } from '@/api/client'
import type { Page } from '@/api/generated/Page'
import type { FunctionDetail } from '@/api/generated/compute/FunctionDetail'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import type { PubsubSchedule } from '@/api/generated/messaging/PubsubSchedule'
import type { PubsubScheduleRun } from '@/api/generated/messaging/PubsubScheduleRun'
import { statusQuery } from '@/api/queries'
import { EntityLink } from '@/components/console/entity-link'
import { OutcomeChip } from '@/components/console/outcome-chip'
import { RequiresNotice } from '@/components/console/requires-notice'
import { SendButton } from '@/components/console/request/send-button'
import { sectionStatus } from '@/components/console/section-gate'
import { StatusDot } from '@/components/kit'
import { useNow } from '@/lib/clock'
import { errorText } from '@/lib/error-text'
import { clockOrDate, clockTime, formatNumber } from '@/lib/format'
import { toast } from '@/lib/toasts'
import { deliveryDetail, functionMark } from '@/pubsub/states'
import { functionKeys } from '../api'
import { type BackendDefinition, buildTestEvent } from '../envelopes'
import { sendTestEvent } from '../invoke-stream'
import { chipStatus } from '../kinds'
import {
  describeSchedule,
  localTime,
  nextRunExact,
  nextRunText,
  notAutomaticText,
  scheduleState,
  stateLook,
  zoneTime,
} from '../schedule-text'
import {
  pauseSchedule,
  runSchedule,
  schedulesKey,
  useSchedule,
  useSchedulesLive,
} from '../schedules'
import { lastSegment } from '../trigger-text'
import { FormRow, RunAnswer, RunError, RunFooter, useNextInvocation } from './run-parts'

/** When it runs next, in its zone, and the countdown, crossed out while paused. */
function NextRun({ schedule }: { schedule: PubsubSchedule }) {
  const at = schedule.nextRunAt
  const countdown = useNow('second', (now) => (at ? nextRunText(at, now) : ''))
  if (!at) return <span className="text-[13px] text-kumo-subtle">The scheduler has not said</span>
  return (
    <Tooltip
      content={nextRunExact(at, schedule.evaluatedIn)}
      render={
        <span
          className={`flex min-w-0 items-baseline gap-1.5 ${schedule.paused ? 'line-through' : ''}`}
          data-testid="schedule-next"
        >
          <span className="font-mono text-[12px] text-kumo-default tabular-nums">
            {zoneTime(at, schedule.evaluatedIn)}
          </span>
          <span className="text-[12px] text-kumo-subtle">({countdown})</span>
        </span>
      }
    />
  )
}

/** How one run went: skipped, published (no delivery recorded), or its delivery's outcome. */
function RunOutcome({ run }: { run: PubsubScheduleRun }) {
  if (run.skipped) return <OutcomeChip word="skipped" tone="neutral" detail={run.skipped} />
  if (!run.delivery)
    return (
      <OutcomeChip
        word="published"
        tone="neutral"
        detail="The tick was published; no delivery to the function is recorded for it."
      />
    )
  const look = functionMark(run.delivery.mark)
  const detail = deliveryDetail(run.delivery)
  return (
    <OutcomeChip
      word={look.word}
      tone={look.tone}
      pulse={run.delivery.mark === 'running'}
      {...(detail ? { detail } : {})}
    />
  )
}

/** The runs the scheduler keeps: the latest, newest first, then the first since start. */
function RecentRuns({
  schedule,
  onOpenInvocation,
}: {
  schedule: PubsubSchedule
  onOpenInvocation: (id: string) => void
}) {
  const runs = [...schedule.lastRuns, ...(schedule.firstRun ? [schedule.firstRun] : [])]
  const kept = runs.length
  // Not run yet: the Last run row says so.
  if (schedule.runs === 0) return null
  return (
    <section className="grid gap-1" aria-label="Runs" data-testid="schedule-runs">
      <h4 className="m-0 text-[12px] font-normal text-kumo-subtle">
        {`${formatNumber(schedule.runs)} ${schedule.runs === 1 ? 'run' : 'runs'} since the engine started${schedule.runs > kept ? `; the first and the ${formatNumber(schedule.lastRuns.length)} latest are kept` : ''}`}
      </h4>
      {kept > 0 && (
        <ul className="m-0 grid list-none divide-y divide-kumo-hairline p-0">
          {runs.map((run, index) => {
            const error = run.delivery?.mark === 'failed' ? deliveryDetail(run.delivery) : undefined
            const invocation = run.delivery?.invocation?.key
            return (
              <li
                // A run has no id of its own: its time and what started it,
                // and the first one apart from the latest.
                key={`${index === schedule.lastRuns.length ? 'first' : 'latest'}-${run.at}-${run.trigger}`}
                className="grid gap-0.5 py-1.5"
                data-testid="schedule-tick"
                data-trigger={run.trigger}
                data-mark={run.skipped ? 'skipped' : (run.delivery?.mark ?? 'published')}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="shrink-0 font-mono text-[12px] whitespace-nowrap text-kumo-default tabular-nums">
                    {clockOrDate(run.at)}
                  </span>
                  <span className="w-14 shrink-0 text-[12px] whitespace-nowrap text-kumo-subtle">
                    {run.trigger === 'console' ? 'Run now' : 'Clock'}
                  </span>
                  <RunOutcome run={run} />
                  {run.messageId && (
                    <span className="flex min-w-0 items-center gap-1 text-[12px] text-kumo-subtle">
                      tick
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
                  {invocation && (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="ml-auto"
                      onClick={() => onOpenInvocation(invocation)}
                      data-testid="schedule-run-invocation"
                    >
                      Invocation ›
                    </Button>
                  )}
                </div>
                {run.skipped && (
                  <p
                    className="m-0 text-[12px] text-kumo-subtle"
                    data-testid="schedule-run-skipped"
                  >
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
          })}
        </ul>
      )}
    </section>
  )
}

/** The next five runs, in the zone the scheduler evaluates and on this machine's clock. */
function Upcoming({ schedule }: { schedule: PubsubSchedule }) {
  return (
    <section className="grid gap-1" aria-label="Next runs" data-testid="schedule-upcoming">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="text-left text-[11px] text-kumo-subtle">
            <th className="pb-0.5 font-normal">Next runs in {schedule.evaluatedIn}</th>
            <th className="pb-0.5 text-right font-normal">On this clock</th>
          </tr>
        </thead>
        <tbody className={schedule.paused ? 'text-kumo-subtle line-through' : ''}>
          {schedule.upcoming.map((at) => (
            <tr key={at} data-testid="schedule-upcoming-run">
              <td className="py-0.5 font-mono text-kumo-default tabular-nums">
                {zoneTime(at, schedule.evaluatedIn)}
              </td>
              <td className="py-0.5 text-right font-mono text-kumo-subtle tabular-nums">
                {localTime(at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/** Whether the clock runs it, and the switch that pauses or resumes it. */
function Clock({ project, schedule }: { project: string; schedule: PubsubSchedule }) {
  const queryClient = useQueryClient()
  const state = scheduleState(schedule)
  const look = stateLook(state)
  const pause = useMutation({
    mutationFn: (paused: boolean) => pauseSchedule(schedule.functionId, paused),
    onSuccess: (answer) => {
      queryClient.setQueryData<Page<PubsubSchedule>>(schedulesKey(project), (page) =>
        page
          ? {
              ...page,
              items: page.items.map((item) =>
                item.functionId === answer.functionId ? answer : item,
              ),
            }
          : page,
      )
      toast({
        key: `functions-schedule-${answer.functionId}`,
        title: answer.paused ? `Paused ${answer.functionName}` : `Resumed ${answer.functionName}`,
        description: answer.paused
          ? 'Its clock skips every tick until you resume it; Run now still runs it.'
          : answer.nextRunAt
            ? `It runs next ${nextRunText(answer.nextRunAt, Date.now())}.`
            : undefined,
      })
    },
    onError: (error) =>
      toast({
        key: `functions-schedule-${schedule.functionId}`,
        title: 'Could not change the schedule',
        description: errorText(error),
        tone: 'danger',
      }),
  })
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="inline-flex" data-testid="schedule-state" data-state={state}>
        <StatusDot tone={look.tone} label={look.word} />
      </span>
      {schedule.automatic && (
        <Button
          variant="secondary"
          size="xs"
          icon={schedule.paused ? <PlayIcon /> : <PauseIcon />}
          loading={pause.isPending}
          onClick={() => pause.mutate(!schedule.paused)}
          data-testid="schedule-pause"
        >
          {schedule.paused ? 'Resume' : 'Pause'}
        </Button>
      )}
    </span>
  )
}

/** A Run now's answer: the scheduler's tick (Pub/Sub), or the invocation it made directly. */
type Ran =
  | { via: 'pubsub'; run: PubsubScheduleRun }
  | { via: 'direct'; started?: InvocationSummary; finished?: InvocationSummary }

export function ScheduleForm({
  project,
  detail,
  onOpenInvocation,
}: {
  project: string
  detail: FunctionDetail
  onOpenInvocation: (id: string) => void
}) {
  const summary = detail.summary
  const declared = detail.schedule
  const status = useQuery(statusQuery)
  const pubsubReady = sectionStatus(status.data?.sections, 'pubsub').state === 'ready'
  const viaPubsub = declared?.pubsub ?? false
  const { schedule } = useSchedule(project, summary.id, viaPubsub && pubsubReady)
  useSchedulesLive(viaPubsub && pubsubReady && project ? project : undefined)
  const expression = schedule?.expression ?? declared?.expression ?? summary.trigger.schedule ?? ''
  const words = describeSchedule(expression)
  const zone = schedule?.timeZone ?? declared?.timeZone ?? summary.trigger.timeZone ?? null
  const topic = schedule?.topic ?? declared?.topic

  const [ran, setRan] = useState<Ran | null>(null)
  // The tick's invocation, followed from the moment Run now was pressed.
  const [awaiting, setAwaiting] = useState<((invocation: InvocationSummary) => boolean) | null>(
    null,
  )
  const awaited = useNextInvocation(summary.id, awaiting)
  const run = useMutation({
    mutationFn: async (): Promise<Ran> => {
      setRan(null)
      setAwaiting(null)
      if (viaPubsub) {
        const started = Date.now() - 1000
        const tick = await runSchedule(summary.id)
        if (!tick.skipped)
          setAwaiting(
            () => (invocation: InvocationSummary) =>
              invocation.kind === 'schedule' && Date.parse(invocation.startedAt) >= started,
          )
        return { via: 'pubsub', run: tick }
      }
      // No scheduler: the functions shell's schedule envelope, to the function alone.
      const envelope = buildTestEvent(detail.definition as BackendDefinition, project, {})
      let answer: Extract<Ran, { via: 'direct' }> = { via: 'direct' }
      const outcome = await sendTestEvent(
        summary.id,
        {
          body: envelope.body,
          headers: Object.entries(envelope.headers ?? {}).map(([name, value]) => ({
            name,
            value,
          })),
        },
        {
          onFrame: (frame) => {
            if (frame.frame === 'started') answer = { ...answer, started: frame.invocation }
            if (frame.frame === 'finished') answer = { ...answer, finished: frame.invocation }
            setRan(answer)
          },
        },
      )
      if (outcome.failed) throw new Error(outcome.failed)
      return answer
    },
    onSuccess: setRan,
  })

  // A finished run is the function's last: read its detail again.
  const queryClient = useQueryClient()
  const ended = ran?.via === 'direct' ? ran.finished?.id : awaited?.id
  useEffect(() => {
    if (ended)
      void queryClient.invalidateQueries({ queryKey: functionKeys.detail(project, summary.id) })
  }, [ended, queryClient, project, summary.id])
  const last = summary.stats.last
  const shown =
    ran?.via === 'direct'
      ? (ran.finished ?? ran.started)
      : ran?.via === 'pubsub'
        ? awaited
        : undefined
  const failure = run.error

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="schedule-form">
      <div className="grid shrink-0 gap-2.5 px-5 py-3">
        <FormRow label="Schedule">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span
              className="font-mono text-[12px] text-kumo-default"
              data-testid="schedule-expression"
            >
              {expression}
            </span>
            {words && words !== expression && (
              <span className="text-[12px] text-kumo-subtle" data-testid="schedule-words">
                {words}
              </span>
            )}
          </span>
        </FormRow>
        <FormRow label="Time zone">
          <span className="text-[13px] text-kumo-default" data-testid="schedule-zone">
            {zone ? (
              <>
                Declared <span className="font-mono text-[12px]">{zone}</span>
              </>
            ) : schedule ? (
              <>
                None declared · evaluated in{' '}
                <span className="font-mono text-[12px]">{schedule.evaluatedIn}</span>
              </>
            ) : (
              'None declared'
            )}
          </span>
        </FormRow>
        {schedule && (
          <>
            <FormRow label="Next run">
              {schedule.automatic ? (
                <NextRun schedule={schedule} />
              ) : (
                <span className="text-[13px] text-kumo-warning" data-testid="schedule-problem">
                  {notAutomaticText(schedule.problem)}
                </span>
              )}
            </FormRow>
            <FormRow label="Clock">
              <Clock project={project} schedule={schedule} />
            </FormRow>
          </>
        )}
        <FormRow label="Last run">
          {last ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="font-mono text-[12px] text-kumo-default">
                {clockTime(last.startedAt, 'second')}
              </span>
              <OutcomeChip
                outcome={last.outcome}
                outcomeClass={last.outcomeClass}
                status={chipStatus(last)}
                callableStatus={last.callableStatus ?? undefined}
                startedAt={last.startedAt}
              />
            </span>
          ) : (
            <span className="text-[13px] text-kumo-subtle">Not run since the engine started</span>
          )}
        </FormRow>
        {schedule?.paused && (
          <Text size="sm">
            <span data-testid="schedule-paused-note">
              Paused, so its clock skips every tick until you resume it; Run now still runs it.
            </span>
          </Text>
        )}
        {schedule && schedule.sharesTopicWith.length > 0 && (
          <Text size="sm">
            <span className="text-kumo-warning">
              Shares its topic with {schedule.sharesTopicWith.join(', ')}: functions of one name in
              two regions publish to one schedule topic in this engine, so each tick runs both.
            </span>
          </Text>
        )}
        {topic && viaPubsub && (
          <Text size="xs" variant="secondary">
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              Each tick is a message on
              <EntityLink
                entity={{ kind: 'pubsub.topic', key: topic, label: lastSegment(topic) }}
                testId="schedule-topic"
              />
            </span>
          </Text>
        )}
        <RequiresNotice
          section="pubsub"
          for={`${summary.name} to run on its schedule`}
          testId="schedule-requires"
        />
        {schedule && schedule.automatic && schedule.upcoming.length > 0 && (
          <Upcoming schedule={schedule} />
        )}
        {schedule && <RecentRuns schedule={schedule} onOpenInvocation={onOpenInvocation} />}
        {failure && (
          <RunError
            message={failure instanceof ApiError ? failure.message : errorText(failure)}
            fix={failure instanceof ApiError ? failure.fix : undefined}
          />
        )}
        {ran?.via === 'pubsub' && (
          <p className="m-0 text-[13px] text-kumo-default" data-testid="schedule-run-result">
            {ran.run.skipped ? (
              <span className="text-kumo-warning">Nothing ran: {ran.run.skipped}</span>
            ) : (
              <span className="flex min-w-0 flex-wrap items-center gap-1">
                Published its tick
                {ran.run.messageId && topic && (
                  <EntityLink
                    entity={{
                      kind: 'pubsub.message',
                      key: `${topic}|${ran.run.messageId}`,
                      label: `message ${ran.run.messageId}`,
                    }}
                    testId="schedule-run-message-result"
                  />
                )}
                {!awaited && <span className="text-kumo-subtle">· waiting for the run…</span>}
              </span>
            )}
          </p>
        )}
      </div>
      <RunFooter
        primary={
          <SendButton
            label="Run now"
            onSend={() => run.mutate()}
            pending={run.isPending}
            testId="schedule-run"
          />
        }
      />
      {shown && (
        <RunAnswer
          project={project}
          invocation={shown}
          finished={shown.outcome === null ? undefined : shown}
          onOpen={onOpenInvocation}
        />
      )}
    </div>
  )
}
