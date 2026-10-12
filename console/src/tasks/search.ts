// The Cloud Tasks page's search parameters, read and written through the
// console's one hook (defaults never in the address). Task ids are decimal
// and the router reads `?task=12` as a number, so the ids and the filter
// are read back as strings here, and an id is written as the number it is,
// which keeps the address `?task=12` rather than a quoted string.

import { useRouteSearch } from '@/lib/search-params'
import type { TasksSearch } from '@/routes/tasks'

export type TasksView = NonNullable<TasksSearch['view']>

/** The parameters as the page reads them: ids and the filter as strings. */
export type TasksParams = Omit<TasksSearch, 'task' | 'prefill' | 'q'> & {
  task?: string | undefined
  prefill?: string | undefined
  q?: string | undefined
}

const text = (value: string | number | undefined) =>
  value === undefined ? undefined : String(value)

/** An id as the address writes it: a number when it is one exactly, else the text. */
export function idParam(id: string | undefined): string | number | undefined {
  if (id === undefined) return undefined
  return /^[1-9]\d{0,14}$/.test(id) ? Number(id) : id
}

export function readSearch(search: TasksSearch): TasksParams {
  return { ...search, task: text(search.task), prefill: text(search.prefill), q: text(search.q) }
}

export function writeSearch(patch: Partial<TasksParams>): Partial<TasksSearch> {
  const out: Partial<TasksSearch> = { ...patch } as Partial<TasksSearch>
  if ('task' in patch) out.task = idParam(patch.task)
  if ('prefill' in patch) out.prefill = idParam(patch.prefill)
  return out
}

export function useTasksSearch(): {
  search: TasksParams
  update: (patch: Partial<TasksParams>, options?: { replace?: boolean }) => void
} {
  const { search, update } = useRouteSearch<TasksSearch>('/tasks', '/tasks')
  return {
    search: readSearch(search),
    update: (patch, options) => update(writeSearch(patch), options),
  }
}
