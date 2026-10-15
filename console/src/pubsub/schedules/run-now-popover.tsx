// Run now (SC-03): the schedule's tick, published now through the same path
// the clock takes (`ScheduleControl::run`, which the Functions section's Run
// now calls too). It runs the function's code, so it asks first, beside the
// row or the button — `r` opens the question, Enter answers it — and a
// refusal (background triggers paused) is said there with its fix.

import { useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { PubsubSchedule } from '@/api/generated/messaging/PubsubSchedule'
import { toast } from '@/lib/toasts'
import { useConfirmPopover } from '@/components/console/confirm-popover'
import { runSchedule } from '../api'
import { pubsubKeys } from '../queries'

export type RunNowSubject = Pick<PubsubSchedule, 'functionId' | 'functionName' | 'paused'>

/** The question's words. */
export function runNowText(schedule: RunNowSubject): { title: string; description: string } {
  return {
    title: `Run ${schedule.functionName} now?`,
    description: schedule.paused
      ? 'It runs your function’s code once. Its schedule stays paused.'
      : 'It runs your function’s code once, beside its schedule.',
  }
}

/** The Run now question for a page's schedules: `ask(schedule, anchor)`; `element` mounted once. */
export function useRunNow(project: string): {
  ask: (schedule: RunNowSubject, anchor: Element | null) => void
  element: ReactNode
} {
  const queryClient = useQueryClient()
  const confirm = useConfirmPopover()
  return {
    ask: (schedule, anchor) =>
      confirm.ask({
        ...runNowText(schedule),
        confirm: 'Run now',
        anchor,
        testId: 'pubsub-run-now',
        run: async () => {
          const run = await runSchedule({ functionId: schedule.functionId })
          void queryClient.invalidateQueries({ queryKey: pubsubKeys.schedules(project) })
          toast({
            key: `pubsub-schedule-${schedule.functionId}`,
            title: `Ran ${schedule.functionName}`,
            description: run.messageId
              ? `Its tick is message ${run.messageId}.`
              : (run.skipped ?? undefined),
            tone: run.messageId ? 'success' : 'warning',
          })
        },
      }),
    element: confirm.element,
  }
}
