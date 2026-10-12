// How retries read (TK-21, TK-22, TK-51): a task's remaining attempts with
// their earliest times, the attempts the engine kept and the ones it did
// not, and a queue's retry ladder. The engine computes the plan and the
// ladder with the dispatcher's own backoff and stop rule (`retry_plan`), so
// nothing here re-derives them; this file only words them.

import type { TasksLadderStep } from '@/api/generated/messaging/TasksLadderStep'
import type { TasksPlannedAttempt } from '@/api/generated/messaging/TasksPlannedAttempt'
import type { TasksQueueConfig } from '@/api/generated/messaging/TasksQueueConfig'
import { formatNumber } from '@/lib/format'
import { secondsText } from './states'

export { secondsText } from './states'

/** Rungs the engine plans at most (its `PLAN_LIMIT`). */
export const PLAN_LIMIT = 50

const pad = (value: number) => String(value).padStart(2, '0')

/** `10:02:31`, local: a planned time needs no milliseconds. */
export function clockTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** One rung of a task's plan, as the inspector lists it. */
export interface PlanRow {
  attempt: number
  /** `10:02:31`. */
  at: string
  /** `+4 s`: the backoff before it; empty for an attempt with none. */
  backoff: string
  last: boolean
}

export function planRows(plan: readonly TasksPlannedAttempt[]): PlanRow[] {
  return plan.map((planned) => ({
    attempt: planned.attempt,
    at: clockTime(planned.earliestAt),
    backoff: planned.backoffSeconds > 0 ? `+${secondsText(planned.backoffSeconds)}` : '',
    last: planned.last,
  }))
}

/** Whether the engine stopped planning before the dispatcher would stop (maxRetrySeconds keeps it going). */
export function planIsCut(plan: readonly { last: boolean }[]): boolean {
  return plan.length >= PLAN_LIMIT && !plan.some((planned) => planned.last)
}

/** "12 attempts in between not kept". */
export function omittedText(omitted: number): string {
  return `${formatNumber(omitted)} ${omitted === 1 ? 'attempt' : 'attempts'} in between not kept`
}

/** The ladder in one line: `1 → now · 2 → +1 s · 3 → +2 s · 4 → +4 s (last)`. */
export function ladderText(ladder: readonly TasksLadderStep[]): string {
  const rungs = ladder.map((step) => {
    const when =
      step.attempt === 1 && step.afterSeconds === 0 ? 'now' : `+${secondsText(step.backoffSeconds)}`
    return `${formatNumber(step.attempt)} → ${when}${step.last ? ' (last)' : ''}`
  })
  if (planIsCut(ladder)) rungs.push('…')
  return rungs.join(' · ')
}

/** How long a task that fails every time stays in its queue at least: `≤ 7 s`… */
export function ladderTotal(ladder: readonly TasksLadderStep[]): string {
  const last = ladder.at(-1)
  if (!last) return ''
  const total = secondsText(last.afterSeconds)
  return planIsCut(ladder) ? `${total} and on` : total
}

/**
 * The emulator's off-by-one, in one sentence, where the figure is shown:
 * `maxAttempts 3 runs a failing task 4 times: …`. With maxRetrySeconds the
 * count is not fixed, and it says that instead.
 */
export function maxAttemptsNote(
  config: Pick<TasksQueueConfig, 'maxAttempts' | 'maxRetrySeconds'>,
): string {
  const attempts = formatNumber(config.maxAttempts)
  if (config.maxRetrySeconds !== null && config.maxRetrySeconds !== 0)
    return `maxRetrySeconds ${secondsText(config.maxRetrySeconds)} keeps a failing task retrying past maxAttempts ${attempts} until that long has passed since its first attempt.`
  if (config.maxAttempts < 0)
    return `maxAttempts ${attempts} stops a failing task after its first attempt: the emulator compares the attempt with the limit as it is.`
  const runs = formatNumber(Math.floor(config.maxAttempts) + 1)
  return `maxAttempts ${attempts} runs a failing task ${runs} times: the emulator checks the limit before counting the attempt, as the official emulator does.`
}
