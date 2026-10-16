// The queue list kept current by `tasks.counters` frames: each frame carries
// the queues whose counters changed after the subscriber's revision (all of
// the project's when it opens) and replaces their counters in the cached
// list, only when it is newer than the list, which takes its revision. A
// frame naming a queue the list does not hold says it registered
// meanwhile; the caller reads the list again.

import type { TasksCountersFrame } from '@/api/generated/messaging/TasksCountersFrame'
import type { TasksQueueCounters } from '@/api/generated/messaging/TasksQueueCounters'
import type { TasksQueueList } from '@/api/generated/messaging/TasksQueueList'
import { createLiveFrameLog } from '@/messaging/frames'

/** The frames of the last ten seconds, by project, for a re-read list to catch up with. */
export const countersLog = createLiveFrameLog<TasksCountersFrame>()

export interface AppliedQueueCounters {
  list: TasksQueueList
  unknown: boolean
}

/** Applies one frame to the queue list (see the file's note). */
export function applyQueueCounters(
  list: TasksQueueList,
  frame: TasksCountersFrame,
): AppliedQueueCounters {
  if (frame.revision <= list.revision) return { list, unknown: false }
  const changed = new Map<string, TasksQueueCounters>(frame.queues.map((q) => [q.key, q]))
  const seen = new Set<string>()
  const items = list.items.map((queue) => {
    const counters = changed.get(queue.key)
    if (!counters) return queue
    seen.add(queue.key)
    return { ...queue, counters }
  })
  const unknown = frame.queues.some((queue) => !seen.has(queue.key))
  return { list: { ...list, items, revision: frame.revision }, unknown }
}

/** The list caught up with the frames that arrived while it was being read. */
export function catchUpQueues(
  list: TasksQueueList,
  frames: readonly TasksCountersFrame[],
): TasksQueueList {
  let caught = list
  for (const frame of frames) caught = applyQueueCounters(caught, frame).list
  return caught
}
