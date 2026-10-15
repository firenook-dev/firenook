// A scheduled function's trigger cell in the overview: when its clock
// ticks next, counting down on the one clock, or the clock's state when it
// does not tick (paused, an expression the engine cannot evaluate, Pub/Sub
// not running), then the schedule itself (`0 9 * * 1 (every Monday at
// 09:00) · Europe/Paris`). The lead costs the table no column: names,
// errors and p95 keep their room beside the open panel. It reads Pub/Sub's
// scheduler (`GET /pubsub/schedules`), which the overview keeps live on
// `pubsub.schedules` while it lists a scheduled function.

import { Tooltip } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import type { FunctionSummary } from '@/api/generated/compute/FunctionSummary'
import type { FunctionsSnapshot } from '@/api/generated/compute/FunctionsSnapshot'
import type { PubsubSchedule } from '@/api/generated/messaging/PubsubSchedule'
import { statusQuery } from '@/api/queries'
import { sectionStatus } from '@/components/console/section-gate'
import { useNow } from '@/lib/clock'
import { nextRunExact, nextRunText, notAutomaticText } from '../schedule-text'
import { useSchedule, useSchedulesLive } from '../schedules'
import { triggerText } from '../trigger-text'
import { useFunctionsProject } from '../use-functions'

/** Whether Pub/Sub, and so its scheduler, runs: `ready`, `starting` or `absent`. */
function usePubsubState() {
  const status = useQuery(statusQuery)
  return sectionStatus(status.data?.sections, 'pubsub').state
}

/** Holds `pubsub.schedules` while the overview lists a scheduled function and Pub/Sub runs. */
export function useOverviewSchedules(snapshot: FunctionsSnapshot): void {
  const project = useFunctionsProject()
  const ready = usePubsubState() === 'ready'
  const any = snapshot.functions.some((summary) => summary.kind === 'schedule')
  useSchedulesLive(ready && any && project !== '' ? project : undefined)
}

type Lead = { text: string; state: string; tone: string; title: string }

/** What leads the cell: the countdown, or the state the clock is in. */
function leadOf(
  schedule: PubsubSchedule | undefined,
  pubsub: ReturnType<typeof usePubsubState>,
  countdown: string,
): Lead {
  if (pubsub === 'absent')
    return {
      text: 'Not on time',
      state: 'no-pubsub',
      tone: 'text-kumo-subtle',
      title: 'Pub/Sub is not running, so nothing runs it on time; Run now still runs it.',
    }
  if (!schedule) return { text: '', state: 'unknown', tone: '', title: '' }
  if (!schedule.automatic)
    return {
      text: 'Not automatic',
      state: 'not-automatic',
      tone: 'text-kumo-warning',
      title: notAutomaticText(schedule.problem),
    }
  if (schedule.paused)
    return {
      text: 'Paused',
      state: 'paused',
      tone: 'text-kumo-subtle',
      title: 'Its clock skips every tick until you resume it; Run now still runs it.',
    }
  if (!schedule.nextRunAt) return { text: '', state: 'unknown', tone: '', title: '' }
  return {
    text: countdown,
    state: 'running',
    tone: 'text-kumo-default',
    title: `Next: ${nextRunExact(schedule.nextRunAt, schedule.evaluatedIn)}`,
  }
}

export function ScheduleTrigger({ summary }: { summary: FunctionSummary }) {
  const project = useFunctionsProject()
  const pubsub = usePubsubState()
  const { schedule } = useSchedule(project, summary.id, pubsub === 'ready')
  const at = schedule?.nextRunAt ?? null
  const countdown = useNow('second', (now) => (at ? nextRunText(at, now, 'minute') : ''))
  const lead = leadOf(schedule, pubsub, countdown)
  const text = triggerText(summary)
  return (
    <Tooltip
      content={lead.title ? `${text} — ${lead.title}` : text}
      render={
        <span className="flex min-w-0 items-baseline gap-1.5">
          {lead.text && (
            <>
              <span
                className={`shrink-0 font-sans text-[12px] tabular-nums ${lead.tone}`}
                data-testid="overview-next"
                data-state={lead.state}
              >
                {lead.text}
              </span>
              <span className="shrink-0 text-kumo-inactive" aria-hidden>
                ·
              </span>
            </>
          )}
          <span className="min-w-0 truncate text-kumo-default" data-testid="overview-trigger">
            {text}
          </span>
        </span>
      }
    />
  )
}
