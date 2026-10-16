import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { z } from 'zod'
import { SectionFrame } from '@/components/console/section-gate'
import { TasksPage } from '@/tasks/components/tasks-page'
import { TasksStarting } from '@/tasks/components/tasks-starting'

// Every view of the Cloud Tasks page is a link: the queue, its tab, the
// open task and its inspector tab, the switches, the filter and an open
// dialog (messaging spec §4.2).

// A task id is decimal, and the router reads `?task=12` as the number 12
// (it parses every value as JSON first), so a value may arrive either way;
// the page reads them as strings (`useTasksSearch`). A filter of digits
// alone arrives as a number too. (`z.custom` rather than a union: the same
// check without zod's union code in the first route.)
const zText = z
  .custom<string | number>((value) => typeof value === 'string' || typeof value === 'number')
  .optional()

const searchSchema = z.object({
  // The shell scope (useConsoleProject): the project whose queues are
  // shown, absent for the configured one.
  project: z.string().optional(),
  // A queue by its id; `location` only when two locations of the project
  // register that id. The page resolves both to the engine's queue key.
  queue: z.string().optional(),
  location: z.string().optional(),
  // The queue's tab.
  view: z.enum(['tasks', 'history', 'config']).optional(),
  // The console's task id (decimal) open in the inspector, pending or finished.
  task: zText,
  // The inspector's tab.
  tab: z.enum(['payload', 'request', 'attempts']).optional(),
  // The Tasks tab's state switch and History's outcome switch.
  state: z.enum(['pending', 'held', 'running', 'backoff']).optional(),
  outcome: z.enum(['succeeded', 'failed', 'cancelled', 'deleted', 'purged', 'replaced']).optional(),
  // The shared grammar: name:, is:generated, is:console, words in the payload.
  q: zText,
  // The Enqueue dialog.
  new: z.enum(['task']).optional(),
  // With new=task: the task (pending or finished) whose body and headers fill it.
  prefill: zText,
})
const DEFAULTS = {} as const // every parameter is absent by default

export type TasksSearch = z.infer<typeof searchSchema>

export const Route = createFileRoute('/tasks')({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(DEFAULTS)] },
  component: () => (
    <SectionFrame section="tasks" skeleton={<TasksStarting />}>
      <TasksPage />
    </SectionFrame>
  ),
})
