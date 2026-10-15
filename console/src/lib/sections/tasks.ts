// Cloud Tasks' registry entry: one page (queues in the panel, the queue on
// the right with its Tasks, Attempts, History and Configuration), its
// badge, and where a queue or a task opens. Its ⌘K action is in
// `./tasks-actions.ts`.

import { QueueIcon } from '@phosphor-icons/react'
import { queueSearch, taskSearch } from '@/messaging/links'
import type { ConsoleSection, SectionLink } from '../services'

/** The page itself when a key is not one this section knows. */
function open(search: Record<string, string>): SectionLink {
  return Object.keys(search).length === 0 ? { to: '/tasks' } : { to: '/tasks', search }
}

export const tasks: ConsoleSection = {
  id: 'tasks',
  to: '/tasks',
  label: 'Cloud Tasks',
  services: ['tasks'],
  area: 'messaging',
  icon: QueueIcon,
  summary:
    'Queues with their configuration and live counters, every pending and running task with its attempts, responses and next retry, every attempt as it happens, finished tasks with their outcome, enqueue by hand, run now, pause, hold and purge.',
  // `tasks.jobs` (run and delete jobs) is the engine's automatic gauge.
  badges: ['tasks.failed'],
  projectScope: true,
  searchLabels: { 'tasks.queue': 'Task queues', 'tasks.task': 'Tasks' },
  // The page's `q` filters one queue's tasks; with no queue in the link
  // there is nothing for it to filter, and the engine's hits already name
  // the queues and the tasks the text matches.
  searchLink: null,
  routes: {
    // Key: `<project>|<location>|<queue id>`, the parts the queue
    // registered with (the engine's queue key cannot be split back).
    'tasks.queue': (key) => open(queueSearch(key)),
    // Key: the queue's parts and `|<task id>`, the console's decimal id.
    'tasks.task': (key) => open(taskSearch(key)),
  },
}

/**
 * Another section's way into a queue it names (Functions' task form): its
 * Configuration (`config`: retries, rate limits, the retry ladder) or the
 * Enqueue dialog open on it (`enqueue`, the page's own `new=task`). `key`
 * is the queue's `tasks.queue` key, `<project>|<location>|<queue id>`; a
 * key that is not one opens the page.
 */
export function tasksQueueLink(key: string, where: 'config' | 'enqueue'): SectionLink {
  const search = queueSearch(key)
  if (search.queue === undefined) return { to: '/tasks' }
  return {
    to: '/tasks',
    search: where === 'config' ? { ...search, view: 'config' } : { ...search, new: 'task' },
  }
}
