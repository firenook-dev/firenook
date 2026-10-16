// A queue in the URL, and back (messaging spec §4.2, U-17). The engine
// addresses a queue by its opaque key (`queue:{project}-{location}-{id}`,
// which cannot be split back); a link names it the way a developer does —
// its id, under the page's project, with `location` only when two
// locations of the project register that id. The page resolves the id to
// the key from its queue list, which carries the stored parts, and tidies
// a link that says more than it needs (a `tasks.queue` link always names
// the location and the project, because a registry cannot know either).

import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'

/** The search parameters that name a queue. */
export interface QueueSearch {
  queue?: string | undefined
  location?: string | undefined
}

/** What the page's parameters name, resolved against the project's queues. */
export interface ResolvedQueue {
  /** The queue shown; undefined when nothing is named or nothing matches. */
  queue: TasksQueue | undefined
  /** The id names a queue in more than one location and the link did not say which. */
  ambiguous: boolean
  /** A queue was named that the list does not hold (not registered, or another project). */
  missing: boolean
}

/** Queues of the list registered under `id`, in location order. */
export function queuesNamed(queues: readonly TasksQueue[], id: string): TasksQueue[] {
  return queues
    .filter((queue) => queue.id === id)
    .toSorted((a, b) => a.location.localeCompare(b.location))
}

/** Whether `id` alone is ambiguous in the list: two or more locations register it. */
export function needsLocation(queues: readonly TasksQueue[], id: string): boolean {
  return queuesNamed(queues, id).length > 1
}

/**
 * The queue a link's `queue` and `location` name. An ambiguous id without
 * a location takes the first location (in order), and says so, so the page
 * can write the location into the link.
 */
export function resolveQueue(queues: readonly TasksQueue[], search: QueueSearch): ResolvedQueue {
  const id = search.queue
  if (id === undefined || id === '') return { queue: undefined, ambiguous: false, missing: false }
  const named = queuesNamed(queues, id)
  if (search.location) {
    const exact = named.find((queue) => queue.location === search.location)
    return { queue: exact, ambiguous: false, missing: exact === undefined }
  }
  return { queue: named[0], ambiguous: named.length > 1, missing: named.length === 0 }
}

/** The parameters that name `queue` and nothing more: `location` only when its id is ambiguous. */
export function queueAddress(queues: readonly TasksQueue[], queue: TasksQueue): QueueSearch {
  return needsLocation(queues, queue.id)
    ? { queue: queue.id, location: queue.location }
    : { queue: queue.id, location: undefined }
}

/**
 * The tidy-up a link needs once the queue list is known: `undefined` when
 * the link is already as short as it can be, else the parameters to
 * replace (a location that disambiguates nothing goes; an ambiguous id
 * gains the location it resolved to; `project` naming the configured
 * project goes, since the page shows that project without it).
 */
export function tidyAddress(options: {
  queues: readonly TasksQueue[]
  search: QueueSearch & { project?: string | undefined }
  configured: string | undefined
}): (QueueSearch & { project?: string | undefined }) | undefined {
  const { queues, search, configured } = options
  const patch: QueueSearch & { project?: string | undefined } = {}
  let changed = false
  if (search.project !== undefined && configured !== undefined && search.project === configured) {
    patch.project = undefined
    changed = true
  }
  const resolved = resolveQueue(queues, search)
  if (resolved.queue) {
    const tidy = queueAddress(queues, resolved.queue)
    if (tidy.location !== search.location) {
      patch.location = tidy.location
      changed = true
    }
  }
  return changed ? patch : undefined
}

/** A queue's name in the panel and the toolbar: its id, with its location when the id is ambiguous. */
export function queueLabel(queues: readonly TasksQueue[], queue: TasksQueue): string {
  return needsLocation(queues, queue.id) ? `${queue.id} · ${queue.location}` : queue.id
}

/** The queue's resource name, as Cloud Tasks writes it. */
export function queueResourceName(queue: Pick<TasksQueue, 'project' | 'location' | 'id'>): string {
  return `projects/${queue.project}/locations/${queue.location}/queues/${queue.id}`
}
