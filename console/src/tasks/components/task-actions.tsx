// What can be done to one task, the same from the row menu, a key, the
// inspector's footer and ⌘K (TK-33, TK-34, TK-35, TK-61): Run now and
// Enqueue again ask first beside what was pressed (they run the handler);
// Delete goes through `DangerConfirm`; Stop retrying acts at once, since
// it only takes away. Each answer is a toast with the engine's own words.

import { useMutation } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { toast } from '@/lib/toasts'
import { deleteTask, enqueueAgain, runTask, stopTask } from '../api'
import { useTasksSearch } from '../search'
import { errorText } from '@/lib/error-text'
import { type ConfirmRequest, useConfirmPopover } from '@/components/console/confirm-popover'

/** A task as the actions name it. */
export interface TaskSubject {
  id: string
  /** What a person calls it: `order-1`, `auto·8812`. */
  label: string
  generated: boolean
}

export interface TaskActions {
  /** Asks, then sends a pending, held or backoff task now. */
  run: (task: TaskSubject, anchor: Element | null) => void
  /** Takes a task in backoff out of its slot (cancelled), or stops after the attempt in flight. */
  stop: (task: TaskSubject) => void
  /** Opens the confirmation for deleting one task. */
  remove: (task: TaskSubject) => void
  /** Asks, then enqueues the task again: same body and headers, a new generated name. */
  again: (task: TaskSubject, anchor: Element | null) => void
  /** Opens Enqueue filled from the task. */
  edit: (taskId: string) => void
  /** Opens the task in the inspector. */
  open: (taskId: string) => void
  /** Asks something else first, in the same popover (Run n now…). */
  confirm: (request: ConfirmRequest) => void
  /** The popover and the dialog these open; render it once. */
  element: ReactNode
}

/** The handler a queue dispatches to, for the sentences: "processOrder's code". */
export function handlerName(queue: TasksQueue): string {
  return queue.function ? `${queue.function.name}'s code` : 'the handler at its URL'
}

export function useTaskActions(queue: TasksQueue): TaskActions {
  const { update } = useTasksSearch()
  const confirm = useConfirmPopover()
  const [deleting, setDeleting] = useState<TaskSubject | null>(null)
  const removal = useMutation({
    mutationFn: (task: TaskSubject) => deleteTask({ queue: queue.key, id: task.id }),
    onSuccess: (_, task) => {
      setDeleting(null)
      toast({ key: `tasks-delete-${task.id}`, title: `Deleted ${task.label}`, tone: 'success' })
    },
  })
  const element = (
    <>
      {confirm.element}
      <DangerConfirm
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null)
            removal.reset()
          }
        }}
        title={deleting ? `Delete ${deleting.label}` : 'Delete the task'}
        description="It leaves the queue for History, as deleted."
        consequences={[
          'A request already in flight keeps running; its answer is not recorded.',
          ...(deleting?.generated
            ? ['The Cloud Tasks API cannot delete an auto-named task; the console can.']
            : ['Its name stays reserved until the emulator stops.']),
        ]}
        {...(removal.error ? { error: errorText(removal.error) } : {})}
        pending={removal.isPending}
        onConfirm={() => deleting && removal.mutate(deleting)}
        testId="task-delete"
      />
    </>
  )
  return {
    run: (task, anchor) =>
      confirm.ask({
        title: `Run ${task.label} now?`,
        description: `It runs ${handlerName(queue)}, past the queue's rate limit and a pause.`,
        confirm: 'Run now',
        anchor,
        testId: 'run-confirm',
        run: async () => {
          const result = await runTask({ queue: queue.key, id: task.id })
          toast({
            key: `tasks-run-${task.id}`,
            title: result.started ? `Running ${task.label}` : `${task.label} is already starting`,
            description: result.message,
            tone: result.started ? 'success' : 'info',
          })
        },
      }),
    stop: (task) => {
      stopTask({ queue: queue.key, id: task.id }).then(
        (row) =>
          toast({
            key: `tasks-stop-${task.id}`,
            title: row.stopRequested
              ? `${task.label} stops after its attempt in flight`
              : `Stopped retrying ${task.label}`,
            description: row.stopRequested
              ? 'A request in flight cannot be aborted; if it fails, it is not retried.'
              : 'It is in History as cancelled.',
            tone: 'success',
          }),
        (error: unknown) =>
          toast({
            key: `tasks-stop-${task.id}`,
            title: `Could not stop ${task.label}`,
            description: errorText(error),
            tone: 'danger',
          }),
      )
    },
    remove: (task) => {
      removal.reset()
      setDeleting(task)
    },
    again: (task, anchor) =>
      confirm.ask({
        title: `Enqueue ${task.label} again?`,
        description: `The same body and headers under a new generated name. It runs ${handlerName(queue)}.`,
        confirm: 'Enqueue again',
        anchor,
        testId: 'again-confirm',
        run: async () => {
          const row = await enqueueAgain({ queue: queue.key, id: task.id })
          toast({
            key: `tasks-again-${task.id}`,
            title: `Enqueued again as auto·${row.shortName.slice(-4)}`,
            tone: 'success',
            action: { label: 'Open', run: () => update({ task: row.id, view: 'tasks' }) },
          })
        },
      }),
    edit: (taskId) => update({ new: 'task', prefill: taskId }),
    open: (taskId) => update({ task: taskId }),
    confirm: confirm.ask,
    element,
  }
}
