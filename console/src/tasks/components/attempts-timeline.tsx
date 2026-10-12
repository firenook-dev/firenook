// A task's attempts, the inspector's Attempts tab (TK-22, S20a): the first
// attempt and the nine latest — the first failure is often the telling one,
// so it is never the one dropped — with how many in between were not kept,
// then what comes next: the backoff and the attempt after it, or the
// request in flight. Each attempt says when, how long, what it answered,
// whether it counted as an execution, the first KiB of the response, and
// links to the invocation it caused and its logs.

import { Link } from '@tanstack/react-router'
import type { TasksAttempt } from '@/api/generated/messaging/TasksAttempt'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import type { TasksTaskDetail } from '@/api/generated/messaging/TasksTaskDetail'
import { EntityLink } from '@/components/console/entity-link'
import { OutcomeChip } from '@/components/console/outcome-chip'
import { useNow } from '@/lib/clock'
import { formatClock, formatDuration, formatNumber } from '@/lib/format'
import { attemptLogs, useLogsLinkable } from '../logs'
import { clockTime, omittedText } from '../retry-plan'
import {
  attemptChip,
  backoffSeconds,
  countdownText,
  executionText,
  readableResponse,
  secondsText,
} from '../states'

function AttemptRow({
  attempt,
  queue,
  logs,
}: {
  attempt: TasksAttempt
  queue: TasksQueue
  logs: boolean
}) {
  const chip = attemptChip(attempt)
  const link = logs ? attemptLogs(queue, attempt) : undefined
  return (
    <li className="grid gap-1 py-2" data-testid="attempt" data-attempt={attempt.attempt}>
      <div className="flex min-w-0 items-center gap-3">
        <span className="w-6 shrink-0 text-right font-mono text-[12px] text-kumo-default tabular-nums">
          {formatNumber(attempt.attempt)}
        </span>
        <span className="shrink-0 font-mono text-[12px] text-kumo-subtle tabular-nums">
          {formatClock(attempt.startedAt, 'time')}
        </span>
        <span className="shrink-0 font-mono text-[12px] text-kumo-subtle tabular-nums">
          {formatDuration(attempt.durationMs)}
        </span>
        <OutcomeChip
          word={chip.word}
          tone={chip.tone}
          mono={chip.mono}
          detail={chip.detail}
          testId="attempt-status"
        />
      </div>
      <div className="grid gap-1 pl-9">
        <span className="text-[12px] text-kumo-subtle">{executionText(attempt)}</span>
        {(attempt.response || attempt.error) && (
          <pre
            className="m-0 max-h-40 overflow-auto rounded bg-kumo-tint px-2 py-1 font-mono text-[12px] leading-5 break-words whitespace-pre-wrap text-kumo-default"
            data-testid="attempt-response"
          >
            {attempt.response ? readableResponse(attempt.response) : attempt.error}
          </pre>
        )}
        {(attempt.invocation || link) && (
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
            {attempt.invocation && (
              <span className="flex min-w-0 items-center gap-1.5" data-testid="attempt-invocation">
                <span className="text-kumo-subtle">Invocation</span>
                <EntityLink entity={attempt.invocation} />
              </span>
            )}
            {link && (
              <Link
                to={link.to as never}
                search={link.search as never}
                className="text-kumo-link underline-offset-2 hover:underline"
                data-testid="attempt-logs"
              >
                Logs
              </Link>
            )}
          </span>
        )}
      </div>
    </li>
  )
}

/** What comes after the last attempt, while the task is in a slot. */
function NextAttempt({ detail }: { detail: TasksTaskDetail }) {
  const now = useNow('second')
  const { task } = detail
  if (task.state === 'running')
    return (
      <li className="flex items-center gap-3 py-2" data-testid="attempt-next">
        <span className="w-6 shrink-0 text-right font-mono text-[12px] tabular-nums">
          {formatNumber(task.attempt)}
        </span>
        <OutcomeChip word="in flight" tone="neutral" pulse />
        {task.lastAttemptAt && (
          <span className="font-mono text-[12px] text-kumo-subtle tabular-nums">
            for{' '}
            {secondsText(Math.max(0, Math.floor((now - Date.parse(task.lastAttemptAt)) / 1000)))}
          </span>
        )}
      </li>
    )
  if (task.state !== 'backoff' && task.state !== 'dispatching') return null
  const next = detail.retryPlan[0]
  const at = task.nextAttemptAt ?? next?.earliestAt ?? null
  const waiting = backoffSeconds(task)
  return (
    <>
      {waiting !== undefined && (
        <li className="flex items-center gap-2 py-1 pl-9" data-testid="attempt-backoff">
          <span className="h-px flex-1 bg-kumo-hairline" />
          <span className="text-[11px] text-kumo-subtle">backoff {secondsText(waiting)}</span>
          <span className="h-px flex-1 bg-kumo-hairline" />
        </li>
      )}
      <li className="flex items-center gap-3 py-2" data-testid="attempt-next">
        <span className="w-6 shrink-0 text-right font-mono text-[12px] text-kumo-subtle tabular-nums">
          {formatNumber(next?.attempt ?? task.attempt + 1)}
        </span>
        <span className="text-[13px] text-kumo-subtle">
          {at ? (
            <>
              next at <span className="font-mono text-[12px]">{clockTime(at)}</span> ·{' '}
              {countdownText(at, now)}
            </>
          ) : (
            'next on the following tick'
          )}
        </span>
      </li>
    </>
  )
}

export function AttemptsTimeline({
  detail,
  queue,
}: {
  detail: TasksTaskDetail
  queue: TasksQueue
}) {
  const logs = useLogsLinkable()
  const [first, ...rest] = detail.attempts
  if (!first)
    return (
      <p className="m-0 px-5 py-3 text-[13px] text-kumo-subtle" data-testid="attempts-none">
        {detail.task.state === 'held'
          ? 'No attempt yet: the queue holds it until its schedule time.'
          : detail.finished
            ? 'It finished without an attempt.'
            : 'No attempt yet: it waits for a slot and a token.'}
      </p>
    )
  return (
    <ol
      className="m-0 grid list-none divide-y divide-kumo-hairline px-5 py-1"
      data-testid="attempts-timeline"
    >
      <AttemptRow attempt={first} queue={queue} logs={logs} />
      {detail.omittedAttempts > 0 && (
        <li className="py-1.5 pl-9 text-[12px] text-kumo-subtle" data-testid="attempts-omitted">
          … {omittedText(detail.omittedAttempts)}
        </li>
      )}
      {rest.map((attempt) => (
        <AttemptRow key={attempt.attempt} attempt={attempt} queue={queue} logs={logs} />
      ))}
      {!detail.finished && <NextAttempt detail={detail} />}
    </ol>
  )
}
