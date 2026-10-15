// Enqueue, for a task queue function: the queue as the Cloud Tasks emulator
// holds it (its key, retries, rate limits, why it refused the queue when it
// did, a link to it in Cloud Tasks) and a task with a JSON payload, enqueued
// through Cloud Tasks' console path so the retries and headers are the real
// ones. There is
// no delay field unless the queue holds scheduled tasks: Cloud Tasks here
// runs a task at once whatever its schedule time, as the official emulator.

import { Input, Text } from '@cloudflare/kumo'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/api/client'
import type { FunctionDetail } from '@/api/generated/compute/FunctionDetail'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import { EntityLink } from '@/components/console/entity-link'
import { JsonField, parseJsonText } from '@/components/console/json-field'
import { RequiresNotice } from '@/components/console/requires-notice'
import { SendButton } from '@/components/console/request/send-button'
import { enqueue as enqueueTask } from '@/tasks/api'
import { type TaskDraft, useRunDraft } from '../run-drafts'
import { statusReasonText } from '../trigger-text'
import { FormRow, RunAnswer, RunError, RunFooter, useNextInvocation } from './run-parts'

/** A queue option in words: `maxAttempts 3`, the set ones only. */
export function optionsText(value: unknown): string {
  if (value === null || typeof value !== 'object') return ''
  return Object.entries(value)
    .filter(([, item]) => item !== null && item !== undefined)
    .map(([key, item]) => `${key} ${String(item)}`)
    .join(' · ')
}

export function TaskForm({
  project,
  detail,
  onOpenInvocation,
}: {
  project: string
  detail: FunctionDetail
  onOpenInvocation: (id: string) => void
}) {
  const summary = detail.summary
  const queue = detail.taskQueue
  const [draft, setDraft] = useRunDraft<TaskDraft>(project, summary.id, () => ({
    kind: 'task',
    payload: '{\n  "url": "a.png"\n}',
    runAfter: '',
  }))
  const [awaiting, setAwaiting] = useState<((invocation: InvocationSummary) => boolean) | null>(
    null,
  )
  const awaited = useNextInvocation(summary.id, awaiting)
  const parsed = parseJsonText(draft.payload)
  const runAfter = draft.runAfter.trim() === '' ? null : Number(draft.runAfter)
  const problem = !parsed.ok
    ? 'The payload does not parse as JSON.'
    : runAfter !== null && (!Number.isInteger(runAfter) || runAfter < 0)
      ? 'Run after is a whole number of seconds.'
      : undefined
  // Cloud Tasks' own console enqueue (`POST /tasks/tasks`): the task the
  // Admin SDK's `enqueue(payload)` sends, held to the wire's limits.
  const enqueue = useMutation({
    mutationFn: () => {
      if (!queue) throw new Error('This function has no task queue.')
      return enqueueTask({
        queue: queue.queue,
        data: JSON.stringify(parsed.ok ? parsed.value : null),
        scheduleDelaySeconds: queue.holdScheduled && runAfter ? runAfter : null,
      })
    },
    onSuccess: (row) => {
      const short = row.shortName
      setAwaiting(
        () => (invocation: InvocationSummary) =>
          invocation.cause.type === 'task' &&
          (invocation.cause.task === short || invocation.cause.task.endsWith(`/${short}`)),
      )
    },
  })
  // The task in Cloud Tasks: its key is the queue's parts and the task's id.
  const enqueued = enqueue.data
  const taskRef =
    enqueued && queue?.queueRef
      ? {
          kind: 'tasks.task',
          key: `${queue.queueRef.key}|${enqueued.id}`,
          label: enqueued.shortName,
        }
      : undefined
  if (summary.status === 'ignored')
    return (
      <div className="px-5 py-4" data-testid="task-form-ignored">
        <Text size="sm">
          {summary.statusReason
            ? statusReasonText(summary.statusReason)
            : 'The emulator does not deliver tasks to this function.'}{' '}
          A task would not reach it.
        </Text>
      </div>
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="task-form">
      <div className="grid shrink-0 gap-2.5 px-5 py-3">
        {queue && (
          <>
            <FormRow label="Queue">
              <span
                className="min-w-0 truncate font-mono text-[12px] text-kumo-default"
                data-testid="task-queue"
              >
                {queue.queue}
              </span>
              {queue.queueRef && (
                <EntityLink
                  entity={{ ...queue.queueRef, label: 'Open in Cloud Tasks' }}
                  testId="task-queue-link"
                />
              )}
            </FormRow>
            <FormRow label="Retries">
              <span className="font-mono text-[12px] text-kumo-default">
                {optionsText(queue.retryConfig) || 'defaults'}
              </span>
            </FormRow>
            <FormRow label="Rate">
              <span className="font-mono text-[12px] text-kumo-default">
                {optionsText(queue.rateLimits) || 'defaults'}
              </span>
            </FormRow>
            {queue.refused && (
              <RunError message={`The Cloud Tasks emulator refused this queue: ${queue.refused}`} />
            )}
          </>
        )}
        <RequiresNotice section="tasks" for="Enqueueing a task" testId="task-requires" />
        <div className="grid gap-1">
          <span className="text-[12px] text-kumo-subtle">Payload</span>
          <JsonField
            value={draft.payload}
            onChange={(payload) => setDraft({ ...draft, payload })}
            minLines={4}
            maxLines={14}
            ariaLabel="Payload"
            testId="task-payload"
          />
          <span className="text-[11px] text-kumo-subtle">
            Your function receives it as request.data, as the Admin SDK sends it.
          </span>
        </div>
        {queue?.holdScheduled ? (
          <FormRow
            label="Run after"
            hint="The queue holds scheduled tasks, so the task waits this long."
          >
            <Input
              size="sm"
              className="w-28 font-mono"
              value={draft.runAfter}
              onChange={(event) => setDraft({ ...draft, runAfter: event.target.value })}
              placeholder="0"
              aria-label="Run after, in seconds"
              inputMode="numeric"
            />
            <span className="text-[12px] text-kumo-subtle">s</span>
          </FormRow>
        ) : (
          <Text size="xs" variant="secondary">
            Cloud Tasks here runs a task at once whatever its schedule time, as the official
            emulator does.
          </Text>
        )}
        {problem && (
          <Text size="xs" variant="error">
            {problem}
          </Text>
        )}
        {enqueue.error && (
          <RunError
            message={
              enqueue.error instanceof ApiError ? enqueue.error.message : String(enqueue.error)
            }
            fix={enqueue.error instanceof ApiError ? enqueue.error.fix : undefined}
          />
        )}
        {enqueued && (
          <p
            className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 text-[13px] text-kumo-default"
            data-testid="task-result"
          >
            Enqueued task
            {taskRef ? (
              <EntityLink entity={taskRef} />
            ) : (
              <span className="font-mono text-[12px]">{enqueued.shortName}</span>
            )}
            {!awaited && <span className="text-kumo-subtle">Waiting for the dispatch…</span>}
          </p>
        )}
      </div>
      <RunFooter
        primary={
          <SendButton
            label="Enqueue"
            onSend={() => enqueue.mutate()}
            pending={enqueue.isPending}
            disabled={problem !== undefined || !queue}
            testId="task-enqueue"
          />
        }
      />
      {awaited && (
        <RunAnswer
          project={project}
          invocation={awaited}
          finished={awaited}
          onOpen={onOpenInvocation}
        />
      )}
    </div>
  )
}
