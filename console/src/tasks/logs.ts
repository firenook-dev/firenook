// Where an attempt's logs are: Logs filtered by the queue's function and
// the invocation the attempt caused, or the attempt's own second when that
// invocation is not known (foundation `linkToLogs`, never a hand-spelled
// URL). Like every link between sections, it exists only while this engine
// runs Logs; otherwise the attempt shows no Logs link.

import { useQuery } from '@tanstack/react-query'
import type { TasksAttempt } from '@/api/generated/messaging/TasksAttempt'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import { statusQuery } from '@/api/queries'
import { linkToLogs } from '@/lib/sections/logs'
import type { SectionLink } from '@/lib/services'

/** Whether Logs can be linked to now: it is part of this engine. */
export function useLogsLinkable(): boolean {
  const status = useQuery(statusQuery)
  return status.data?.sections.find((section) => section.id === 'logs')?.state !== 'absent'
}

/** Logs for one attempt; undefined when the queue dispatches to no function this engine runs. */
export function attemptLogs(
  queue: Pick<TasksQueue, 'function'>,
  attempt: Pick<TasksAttempt, 'startedAt' | 'durationMs' | 'invocation'>,
): SectionLink | undefined {
  const fn = queue.function?.functionId
  if (fn === undefined) return undefined
  if (attempt.invocation) return linkToLogs({ function: fn, execution: attempt.invocation.key })
  const started = Date.parse(attempt.startedAt)
  if (Number.isNaN(started)) return linkToLogs({ function: fn })
  return linkToLogs({
    function: fn,
    from: new Date(started - 1000).toISOString(),
    to: new Date(started + attempt.durationMs + 1000).toISOString(),
  })
}
