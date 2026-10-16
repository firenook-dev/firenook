// A scheduled function's schedule as Pub/Sub's scheduler runs it: when it
// runs next (the next five), in which zone, whether its clock is paused,
// and its runs (the first, and the nineteen latest, each with its tick's
// message and how the function's delivery of it went). The engine keeps
// this in Pub/Sub, because a tick is a publish to the function's schedule
// topic; the Functions section reads it here: the overview's Next run and
// a scheduled function's Schedule tab.
//
// `GET /pubsub/schedules` answers every schedule at once (a project holds a
// handful); `pubsub.schedules` keeps it live: a frame patches the states it
// names at once and the list is read again shortly after, for the runs and
// their outcomes. Run now, Pause and Resume are the scheduler's own
// (`/pubsub/schedule/run|pause|resume`), the same tick the clock makes.

import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { apiGet, apiSend } from '@/api/client'
import type { Page } from '@/api/generated/Page'
import type { PubsubSchedule } from '@/api/generated/messaging/PubsubSchedule'
import type { PubsubScheduleBody } from '@/api/generated/messaging/PubsubScheduleBody'
import type { PubsubScheduleRun } from '@/api/generated/messaging/PubsubScheduleRun'
import type { PubsubSchedulesFrame } from '@/api/generated/messaging/PubsubSchedulesFrame'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { declareTopic } from '@/lib/live/topics'
import { createInvalidator, useLiveTopic } from '@/lib/live/use-live-topic'

declare module '@/lib/live/topics' {
  interface TopicMap {
    'pubsub.schedules': {
      params: { project?: string }
      events: { schedules: PubsubSchedulesFrame }
    }
  }
}

declareTopic('pubsub.schedules', 'compare')

/** Every schedule of `project`, under Pub/Sub's keys: a reset of Pub/Sub reads it again. */
export const schedulesKey = (project: string) => ['pubsub', project, 'schedules'] as const

export function getSchedules(project: string, signal?: AbortSignal): Promise<Page<PubsubSchedule>> {
  return apiGet('/pubsub/schedules', { project }, signal)
}

/** Publishes the schedule's tick now, as its clock would (it runs the function's code). */
export function runSchedule(functionId: string): Promise<PubsubScheduleRun> {
  const body: PubsubScheduleBody = { functionId }
  return apiSend('POST', '/pubsub/schedule/run', body)
}

/** Stops (true) or restarts (false) the schedule's clock; Run now works either way. */
export function pauseSchedule(functionId: string, paused: boolean): Promise<PubsubSchedule> {
  const body: PubsubScheduleBody = { functionId }
  return apiSend('POST', paused ? '/pubsub/schedule/pause' : '/pubsub/schedule/resume', body)
}

export const schedulesQuery = (project: string) =>
  queryOptions({
    queryKey: schedulesKey(project),
    queryFn: ({ signal }) => getSchedules(project, signal),
    enabled: project !== '',
  })

/** One function's schedule from the list, while Pub/Sub runs (`enabled`). */
export function useSchedule(
  project: string,
  functionId: string,
  enabled = true,
): { schedule: PubsubSchedule | undefined; pending: boolean; error: unknown } {
  const query = useQuery({
    ...schedulesQuery(project),
    enabled: enabled && project !== '',
    select: (page) => page.items.find((item) => item.functionId === functionId),
  })
  return { schedule: query.data, pending: query.isPending && enabled, error: query.error }
}

/** A schedules frame's states put into the cached list (the runs come with the next read). */
export function applySchedulesFrame(
  page: Page<PubsubSchedule>,
  frame: PubsubSchedulesFrame,
): Page<PubsubSchedule> {
  const states = new Map(frame.schedules.map((state) => [state.functionId, state]))
  let changed = false
  const items = page.items.map((schedule) => {
    const state = states.get(schedule.functionId)
    if (!state) return schedule
    changed = true
    return {
      ...schedule,
      paused: state.paused,
      automatic: state.automatic,
      nextRunAt: state.nextRunAt,
      runs: state.runs,
    }
  })
  return changed ? { ...page, items } : page
}

/**
 * Holds `pubsub.schedules` while a page shows schedules (`project` undefined:
 * not now): each frame patches the list's states at once and reads the
 * list again shortly after, for the runs and their outcomes.
 */
export function useSchedulesLive(project: string | undefined): SubscriptionStatus {
  const client = useQueryClient()
  const [invalidator] = useState(() =>
    createInvalidator((key) => void client.invalidateQueries({ queryKey: key }), 250),
  )
  useEffect(() => () => invalidator.dispose(), [invalidator])
  return useLiveTopic('pubsub.schedules', project ? { project } : null, {
    onSchedules: (frame) => {
      if (!project) return
      const key = schedulesKey(project)
      client.setQueryData<Page<PubsubSchedule>>(key, (page) =>
        page ? applySchedulesFrame(page, frame) : page,
      )
      invalidator.push([key])
    },
    onReset: () => {
      if (project) invalidator.flush([schedulesKey(project)])
    },
  })
}
