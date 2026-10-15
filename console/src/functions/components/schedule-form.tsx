// Run, for a schedule: when it runs, in which zone, when it runs next and
// when it last did, whether the clock runs it at all — and Run now, the
// same publish the clock makes (or, without Pub/Sub, the CLI's schedule
// envelope straight to the trigger route).

import { Text } from '@cloudflare/kumo'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ApiError } from '@/api/client'
import type { FunctionBrokerResult } from '@/api/generated/compute/FunctionBrokerResult'
import type { FunctionDetail } from '@/api/generated/compute/FunctionDetail'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import { OutcomeChip, elapsedText } from '@/components/console/outcome-chip'
import { exactTime } from '@/components/console/relative-time'
import { RequiresNotice } from '@/components/console/requires-notice'
import { SendButton } from '@/components/console/request/send-button'
import { Link } from '@tanstack/react-router'
import { useNow } from '@/lib/clock'
import { useLinkTo } from '@/lib/links'
import { clockTime } from '@/lib/format'
import { functionKeys, runSchedule } from '../api'
import { chipStatus } from '../kinds'
import { lastSegment } from '../trigger-text'
import { FormRow, RunAnswer, RunError, RunFooter, useNextInvocation } from './run-parts'

/** "in 2 min 51 s", "now", or how long ago a time that has passed was. */
export function countdownText(at: string, now: number): string {
  const then = Date.parse(at)
  if (Number.isNaN(then)) return ''
  const ms = then - now
  if (Math.abs(ms) < 1000) return 'now'
  return ms > 0 ? `in ${elapsedText(ms)}` : `${elapsedText(-ms)} ago`
}

function NextRun({ at }: { at: string }) {
  const now = useNow('second')
  return (
    <span className="flex min-w-0 items-baseline gap-1.5" title={exactTime(at)}>
      <span className="font-mono text-[12px] text-kumo-default tabular-nums">
        {clockTime(at, 'second')}
      </span>
      <span className="text-[12px] text-kumo-subtle">({countdownText(at, now)})</span>
    </span>
  )
}

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
  const schedule = detail.schedule
  const client = useQueryClient()
  const [awaiting, setAwaiting] = useState<((invocation: InvocationSummary) => boolean) | null>(
    null,
  )
  const awaited = useNextInvocation(summary.id, awaiting)
  const run = useMutation({
    mutationFn: () => runSchedule(summary.id),
    onSuccess: (result: FunctionBrokerResult) => {
      if (result.transport === 'direct') return
      const started = Date.now() - 1000
      setAwaiting(
        () => (invocation: InvocationSummary) =>
          invocation.kind === 'schedule' && Date.parse(invocation.startedAt) >= started,
      )
    },
  })
  // A finished run moves the next one: read the detail again.
  useEffect(() => {
    if (awaited)
      void client.invalidateQueries({ queryKey: functionKeys.detail(project, summary.id) })
  }, [awaited, client, project, summary.id])

  const scheduleLink = useLinkTo(schedule?.scheduleRef ?? undefined)
  const last = summary.stats.last
  const direct = run.data?.transport === 'direct' ? (run.data.invocation ?? undefined) : undefined
  const shown = direct ?? awaited

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="schedule-form">
      <div className="grid shrink-0 gap-2.5 px-5 py-3">
        <FormRow label="Schedule">
          <span
            className="font-mono text-[12px] text-kumo-default"
            data-testid="schedule-expression"
          >
            {schedule?.expression ?? summary.trigger.schedule ?? ''}
          </span>
        </FormRow>
        <FormRow label="Time zone">
          <span className="text-[13px] text-kumo-default" data-testid="schedule-zone">
            {schedule?.evaluatedIn ? (
              <>
                Evaluated in <span className="font-mono text-[12px]">{schedule.evaluatedIn}</span>
              </>
            ) : schedule?.timeZone ? (
              <>
                Declared <span className="font-mono text-[12px]">{schedule.timeZone}</span>
              </>
            ) : (
              'None declared'
            )}
          </span>
        </FormRow>
        <FormRow label="Next run">
          {schedule?.nextRun ? (
            <NextRun at={schedule.nextRun} />
          ) : (
            <span className="text-[13px] text-kumo-subtle">
              {schedule?.automatic === false
                ? 'Not run automatically'
                : 'The scheduler has not said'}
            </span>
          )}
        </FormRow>
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
        {schedule && (
          <Text size="xs" variant="secondary">
            Runs through Pub/Sub topic{' '}
            <span className="font-mono">{lastSegment(schedule.topic)}</span>.
            {scheduleLink && (
              <>
                {' '}
                <Link
                  to={scheduleLink.to as never}
                  search={scheduleLink.search as never}
                  className="text-kumo-link hover:underline"
                  data-testid="schedule-link"
                >
                  {schedule.paused ? 'Paused in Pub/Sub ›' : 'Open in Pub/Sub ›'}
                </Link>
              </>
            )}
          </Text>
        )}
        {schedule && !schedule.automatic && (
          <Text size="sm">
            Not run automatically: {schedule.manualReason ?? 'the scheduler cannot evaluate it'}.
            Run it here.
          </Text>
        )}
        {schedule?.paused && (
          <Text size="sm">Paused in Pub/Sub, so the clock skips it; Run now still runs it.</Text>
        )}
        <RequiresNotice
          section="pubsub"
          for={`${summary.name} to run on its schedule`}
          testId="schedule-requires"
        />
        {run.error && (
          <RunError
            message={run.error instanceof ApiError ? run.error.message : String(run.error)}
            fix={run.error instanceof ApiError ? run.error.fix : undefined}
          />
        )}
        {run.data && run.data.transport !== 'direct' && (
          <p className="m-0 text-[13px] text-kumo-default" data-testid="schedule-run-result">
            Published
            {run.data.messageId ? (
              <>
                {' '}
                message <span className="font-mono text-[12px]">{run.data.messageId}</span>
              </>
            ) : null}{' '}
            to {run.data.topic ? lastSegment(run.data.topic) : 'its topic'}.
            {!awaited && <span className="text-kumo-subtle"> Waiting for the run…</span>}
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
