// The words and tones a Cloud Tasks row speaks in: where a task is, which
// attempt it is on, what its last attempt answered, how it finished. One
// file, so the table, the inspector and the history say the same thing the
// same way, in the console's dot vocabulary: a breathing
// dot for what is in flight, warning for backoff, success and danger for
// outcomes, neutral for everything else.

import type { TasksAttempt } from '@/api/generated/messaging/TasksAttempt'
import type { TasksOutcome } from '@/api/generated/messaging/TasksOutcome'
import type { TasksTaskRow } from '@/api/generated/messaging/TasksTaskRow'
import type { TasksTaskState } from '@/api/generated/messaging/TasksTaskState'
import type { StatusTone } from '@/components/kit'
import { formatDuration, formatNumber } from '@/lib/format'

/** A word, its tone, and whether the word is data (a status figure: the data face). */
export interface Chip {
  word: string
  tone: StatusTone
  mono: boolean
  /** One sentence for a tooltip: why the word. */
  detail?: string | undefined
}

/**
 * The tone of each state's dot: amber for a task waiting out a failure,
 * neutral for everything else — a running task breathes instead (the
 * console's running chip), since the ember accent beside a red 500 reads
 * as a second failure.
 */
export function stateTone(state: TasksTaskState): StatusTone {
  return state === 'backoff' ? 'warning' : 'neutral'
}

/** What each state means, for the state word's tooltip (TK-23). */
export const STATE_DETAIL: Record<TasksTaskState, string> = {
  pending:
    'Waiting for a dispatch slot and a token from the bucket, or for the queue to be resumed.',
  held: 'Scheduled for later, and the queue holds scheduled tasks until their time (console only).',
  dispatching: 'It has a slot; its attempt is sent on the next tick.',
  running: 'Its request is in flight.',
  backoff: 'Its last attempt failed; it waits out the backoff before the next one.',
  finished: 'It left the queue; History has it.',
}

/**
 * Seconds as a config or a backoff holds them: `4 s`, `0.5 s`, `1 min 5 s`,
 * `1 h` — whole seconds without a decimal, fractions as written.
 */
export function secondsText(seconds: number): string {
  if (seconds < 60) {
    const text = Number.isInteger(seconds) ? String(seconds) : String(Number(seconds.toFixed(2)))
    return `${text} s`
  }
  return formatDuration(Math.round(seconds) * 1000)
}

/**
 * "in 4 s", "in 1 min 5 s", "now": a countdown to an instant, by the
 * second (a running clock rounds every value it passes, so whole seconds).
 */
export function countdownText(at: string, now: number): string {
  const due = Date.parse(at)
  if (Number.isNaN(due)) return at
  const seconds = Math.ceil((due - now) / 1000)
  if (seconds <= 0) return 'now'
  return `in ${secondsText(seconds)}`
}

/** The state cell's words: `pending · #3`, `held · due in 59 min`, `backoff`. */
export function stateWord(
  row: Pick<TasksTaskRow, 'state' | 'position' | 'dueAt' | 'nextAttemptAt'>,
  now: number,
): string {
  if (row.state === 'pending')
    return row.position === null ? 'pending' : `pending · #${formatNumber(row.position)}`
  if (row.state === 'held')
    return row.dueAt === null ? 'held' : `held · due ${countdownText(row.dueAt, now)}`
  return row.state
}

/**
 * The backoff a task in backoff is waiting out, in whole seconds: from its
 * last attempt to its next (the attempt's own few milliseconds round away).
 * Undefined when it is not waiting.
 */
export function backoffSeconds(
  task: Pick<TasksTaskRow, 'state' | 'lastAttemptAt' | 'nextAttemptAt'>,
): number | undefined {
  if (task.state !== 'backoff' || !task.lastAttemptAt || !task.nextAttemptAt) return undefined
  const last = Date.parse(task.lastAttemptAt)
  const next = Date.parse(task.nextAttemptAt)
  if (Number.isNaN(last) || Number.isNaN(next) || next <= last) return undefined
  return Math.round((next - last) / 1000)
}

/** A response for reading: JSON laid out two spaces, anything else as it came. */
export function readableResponse(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return text
  }
}

/** `2 of 4`; `2` when maxRetrySeconds bounds the runs instead; `—` before the first attempt. */
export function attemptText(row: Pick<TasksTaskRow, 'attempt' | 'maxRuns'>): string {
  if (row.attempt === 0) return '—'
  return row.maxRuns === null
    ? formatNumber(row.attempt)
    : `${formatNumber(row.attempt)} of ${formatNumber(row.maxRuns)}`
}

/** Why `of 4` when maxAttempts says 3: the quirk, said where the figure is. */
export function attemptDetail(maxRuns: number | null): string {
  if (maxRuns === null)
    return 'maxRetrySeconds is set, so the emulator keeps retrying past maxAttempts until that much time has passed.'
  return `The emulator runs a failing task maxAttempts + 1 times (${formatNumber(maxRuns)} here): it checks the limit before it counts the attempt, as the official emulator does.`
}

/**
 * The short word for a request that got no answer, from the error text
 * the emulator recorded (node-fetch's words, kept as the official emulator
 * logs them).
 */
export function errorWord(error: string): string {
  if (/ECONNREFUSED/.test(error)) return 'refused'
  if (/AbortError|aborted|timed out|timeout/i.test(error)) return 'timed out'
  if (/Only absolute URLs|Invalid URL|relative URL/i.test(error)) return 'invalid URL'
  if (/ENOTFOUND|EAI_AGAIN/.test(error)) return 'no such host'
  if (/ECONNRESET|socket hang up/i.test(error)) return 'reset'
  return 'failed'
}

/** What an answer's status says: 2xx success, anything else danger. */
export function statusTone(status: number): StatusTone {
  return status >= 200 && status < 300 ? 'success' : 'danger'
}

/** A row's last result: the status the handler answered, or the error word; null before any attempt. */
export function lastResult(status: number | null, error: string | null | undefined): Chip | null {
  if (status !== null) return { word: String(status), tone: statusTone(status), mono: true }
  if (error) return { word: errorWord(error), tone: 'danger', mono: false, detail: error }
  return null
}

/** One attempt's chip: its status, or the error word with the error in the tooltip. */
export function attemptChip(attempt: Pick<TasksAttempt, 'status' | 'error'>): Chip {
  return (
    lastResult(attempt.status, attempt.error) ?? {
      word: 'no answer',
      tone: 'danger',
      mono: false,
    }
  )
}

/** Whether an attempt raised the execution count, in words (S20a). */
export function executionText(attempt: Pick<TasksAttempt, 'countedExecution' | 'status'>): string {
  if (attempt.countedExecution) return 'counted as an execution'
  if (attempt.status !== null && attempt.status >= 500) return 'not counted as an execution (5xx)'
  if (attempt.status !== null && attempt.status < 300) return 'not counted as an execution'
  return 'not counted as an execution (no answer)'
}

/** How a finished task left its queue, as History's chip says it. */
export function outcomeChip(outcome: TasksOutcome): Chip {
  switch (outcome) {
    case 'succeeded':
      return { word: 'succeeded', tone: 'success', mono: false }
    case 'failed':
      return {
        word: 'failed',
        tone: 'danger',
        mono: false,
        detail: 'It ran out of retries.',
      }
    case 'cancelled':
      return {
        word: 'cancelled',
        tone: 'neutral',
        mono: false,
        detail: 'You stopped its retries.',
      }
    case 'deleted':
      return {
        word: 'deleted',
        tone: 'neutral',
        mono: false,
        detail: 'Deleted before it finished, over the API or from the console.',
      }
    case 'purged':
      return { word: 'purged', tone: 'neutral', mono: false, detail: 'Removed by a purge.' }
    case 'replaced':
      return {
        word: 'replaced',
        tone: 'neutral',
        mono: false,
        detail: 'Dropped when the queue re-registered with new options.',
      }
  }
}

/** The outcomes, in the History switch's order. */
export const OUTCOMES: readonly TasksOutcome[] = [
  'succeeded',
  'failed',
  'cancelled',
  'deleted',
  'purged',
  'replaced',
]

/** The states the Tasks switch narrows to, in its order. */
export const STATE_FILTERS = ['pending', 'held', 'running', 'backoff'] as const
export type StateFilter = (typeof STATE_FILTERS)[number]

/** A generated name as a row shows it: `auto·8812`, the end of the emulator's number. */
export function displayName(row: Pick<TasksTaskRow, 'generated' | 'shortName'>): string {
  return row.generated ? `auto·${row.shortName.slice(-4)}` : row.shortName
}

/** Why a generated name looks the way it does (its tooltip, with the full name). */
export function generatedDetail(name: string): string {
  return `${name} — the emulator generated this name with a leading slash, so the Cloud Tasks API can never delete the task; the console can.`
}
