// Enqueue a task by hand (TK-40, TK-41, S23): the payload as the
// Admin SDK sends it (`{"data": …}`) or a raw JSON body, a task id with the
// reservation rule said where it bites, headers, a delay, a dispatch
// deadline and a URL. The engine builds the task through the same path the
// Tasks port uses and holds it to the port's 100 KiB, so the console cannot
// enqueue what no SDK could send; the size is measured here as it is typed,
// with the engine's own sentence, before the engine says it again.

import { Button, Dialog, Input, Radio, Select, Text, Tooltip } from '@cloudflare/kumo'
import { CaretDownIcon, CaretRightIcon, InfoIcon, XIcon } from '@phosphor-icons/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { type KeyboardEvent, type ReactNode, useState } from 'react'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import type { TasksTaskRow } from '@/api/generated/messaging/TasksTaskRow'
import { JsonField } from '@/components/console/json-field'
import { KeyValueEditor, type KeyValueRow, rowId } from '@/components/console/key-value-editor'
import { Kbd } from '@/components/kit'
import { formatBytes } from '@/lib/format'
import { enqueue } from '../api'
import { errorText } from '@/lib/error-text'
import {
  type EnqueueDraft,
  REQUEST_LIMIT,
  type SendAs,
  deadlineOf,
  delayOf,
  draftFrom,
  emptyDraft,
  enqueueBody,
  requestSize,
  sizeProblem,
  taskIdProblem,
  urlProblem,
} from '../payload'
import { queueLabel } from '../queue-address'
import { taskQuery } from '../queries'

/** Header rows as the editor holds them, from a draft's headers. */
function headerRows(headers: EnqueueDraft['headers']): KeyValueRow[] {
  return headers.map((header) => ({
    id: rowId(),
    key: header.name,
    value: header.value,
    enabled: true,
  }))
}

/** A disclosure that opens a row of the form: `▸ Headers · 2`. */
function Disclosure({
  label,
  detail,
  open,
  onToggle,
  testId,
}: {
  label: string
  detail?: ReactNode
  open: boolean
  onToggle: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      className="flex h-7 items-center gap-1.5 self-start rounded-md px-1 text-[13px] text-kumo-default outline-none hover:ink focus-visible:ring-2 focus-visible:ring-kumo-focus"
      aria-expanded={open}
      onClick={onToggle}
      data-testid={testId}
    >
      {open ? (
        <CaretDownIcon size={11} weight="bold" />
      ) : (
        <CaretRightIcon size={11} weight="bold" />
      )}
      {label}
      {detail && <span className="text-[12px] text-kumo-subtle">{detail}</span>}
    </button>
  )
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: ReactNode
  error?: string | undefined
  children: ReactNode
}) {
  return (
    <label className="grid content-start gap-1">
      <Text variant="secondary" size="sm" as="span">
        {label}
      </Text>
      {children}
      {error ? (
        <span className="text-[12px] text-kumo-danger">{error}</span>
      ) : hint ? (
        <span className="text-[12px] text-kumo-subtle">{hint}</span>
      ) : null}
    </label>
  )
}

function EnqueueForm({
  queues,
  initialQueue,
  project,
  prefill,
  onClose,
  onEnqueued,
  onShowConfig,
}: {
  queues: readonly TasksQueue[]
  initialQueue: TasksQueue | undefined
  project: string
  prefill: string | undefined
  onClose: () => void
  onEnqueued: (row: TasksTaskRow, queue: TasksQueue) => void
  onShowConfig: (queue: TasksQueue) => void
}) {
  const [key, setKey] = useState(initialQueue?.key ?? queues[0]?.key ?? '')
  const queue = queues.find((item) => item.key === key)
  const [draft, setDraft] = useState<EnqueueDraft>(emptyDraft)
  const [headers, setHeaders] = useState<KeyValueRow[]>([])
  const [showHeaders, setShowHeaders] = useState(false)
  const [showUrl, setShowUrl] = useState(false)

  // "Edit and enqueue a copy": filled once from the task, never its name.
  const source = useQuery({
    ...taskQuery(project, initialQueue?.key ?? '', prefill ?? ''),
    enabled: prefill !== undefined && initialQueue !== undefined,
  })
  const [filled, setFilled] = useState<string | undefined>(undefined)
  if (source.data && prefill !== undefined && filled !== prefill) {
    setFilled(prefill)
    const from = draftFrom(source.data)
    setDraft(from)
    setHeaders(headerRows(from.headers))
    setShowHeaders(from.headers.length > 0)
    setShowUrl(from.url !== '')
  }

  const withHeaders: EnqueueDraft = {
    ...draft,
    headers: headers
      .filter((row) => row.enabled && row.key.trim() !== '')
      .map((row) => ({ name: row.key.trim(), value: row.value })),
  }
  const parts = queue
    ? { project: queue.project, location: queue.location, id: queue.id }
    : undefined
  const size = parts ? requestSize(withHeaders, parts) : undefined
  const problems = {
    id: taskIdProblem(draft.id.trim()),
    delay: (() => {
      const checked = delayOf(draft.delay)
      return checked.ok ? undefined : checked.message
    })(),
    deadline: (() => {
      const checked = deadlineOf(draft.deadline)
      return checked.ok ? undefined : checked.message
    })(),
    url: urlProblem(draft.url),
  }
  const bodyProblem = size && !size.ok ? size.message : undefined
  const tooLarge = size?.ok ? sizeProblem(size.value) : undefined
  const blocked =
    !queue ||
    Boolean(
      problems.id || problems.delay || problems.deadline || problems.url || bodyProblem || tooLarge,
    )
  const delay = delayOf(draft.delay)
  const delayed = delay.ok && delay.value !== undefined

  const submit = useMutation({
    mutationFn: async () => {
      if (!queue) throw new Error('Pick a queue first.')
      return { row: await enqueue(enqueueBody(queue.key, withHeaders)), queue }
    },
    onSuccess: ({ row, queue: into }) => onEnqueued(row, into),
  })
  const send = () => {
    if (!blocked && !submit.isPending) submit.mutate()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    // Captured before the editor: ⌘↵ sends from anywhere in the form.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      event.stopPropagation()
      send()
    }
  }
  const set = (patch: Partial<EnqueueDraft>) => {
    submit.reset()
    setDraft((now) => ({ ...now, ...patch }))
  }

  return (
    <div
      className="flex max-h-[calc(100vh-6rem)] flex-col"
      onKeyDownCapture={onKeyDown}
      data-testid="enqueue-dialog"
    >
      <div className="mb-3 flex items-start justify-between gap-4">
        <Dialog.Title className="flex min-w-0 items-center gap-2 text-lg font-semibold">
          <span className="shrink-0">Enqueue a task in</span>
          {queues.length > 1 || !initialQueue ? (
            <Select
              size="sm"
              value={key}
              onValueChange={(next) => {
                submit.reset()
                setKey(String(next))
              }}
              renderValue={() => (
                <span className="truncate font-mono text-[13px]">
                  {queue ? queueLabel(queues, queue) : 'a queue'}
                </span>
              )}
              aria-label="Queue"
              className="min-w-0"
              data-testid="enqueue-queue"
            >
              {queues.map((item) => (
                <Select.Option key={item.key} value={item.key}>
                  <span className="font-mono text-[12px]">{queueLabel(queues, item)}</span>
                </Select.Option>
              ))}
            </Select>
          ) : (
            <span className="truncate font-mono text-[0.9em]">{queue?.id}</span>
          )}
        </Dialog.Title>
        <Dialog.Close
          aria-label="Close"
          render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
        />
      </div>
      <Dialog.Description className="text-kumo-subtle">
        Built as the Admin SDK’s{' '}
        <span className="font-mono text-[0.9em]">taskQueue().enqueue()</span> sends it, through the
        path the Tasks port uses. It runs{' '}
        {queue?.function ? `${queue.function.name}’s code` : 'the handler at the queue’s URL'}.
      </Dialog.Description>
      <div className="mt-4 grid min-h-0 gap-3 overflow-y-auto">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Text variant="secondary" size="sm" as="span">
            Payload
          </Text>
          <Radio
            orientation="horizontal"
            value={draft.sendAs}
            onValueChange={(value) => set({ sendAs: value as SendAs })}
          >
            <Radio.Legend className="sr-only">Send the payload as</Radio.Legend>
            <Radio.Item value="data" label="data, as the Admin SDK does" />
            <Radio.Item value="raw" label="Raw JSON body" />
          </Radio>
        </div>
        <JsonField
          value={draft.text}
          onChange={(text) => set({ text })}
          minLines={6}
          maxLines={14}
          autoFocus
          ariaLabel={draft.sendAs === 'data' ? 'The task’s data' : 'The raw body'}
          testId="enqueue-payload"
        />
        <div className="grid grid-cols-3 gap-3">
          <Field
            label="Task id"
            hint="Optional; a name used before in this run is refused"
            error={problems.id}
          >
            <Input
              size="sm"
              value={draft.id}
              onChange={(event) => set({ id: event.target.value })}
              placeholder="generated"
              spellCheck={false}
              autoComplete="off"
              className="font-mono"
              variant={problems.id ? 'error' : 'default'}
              data-testid="enqueue-id"
            />
          </Field>
          <Field label="Delay, seconds" hint="Sets scheduleTime" error={problems.delay}>
            <Input
              size="sm"
              value={draft.delay}
              onChange={(event) => set({ delay: event.target.value })}
              placeholder="0"
              inputMode="decimal"
              className="font-mono"
              variant={problems.delay ? 'error' : 'default'}
              data-testid="enqueue-delay"
            />
          </Field>
          <Field
            label="Dispatch deadline, seconds"
            hint="15 to 1800; 60 when empty"
            error={problems.deadline}
          >
            <Input
              size="sm"
              value={draft.deadline}
              onChange={(event) => set({ deadline: event.target.value })}
              placeholder="60"
              inputMode="numeric"
              className="font-mono"
              variant={problems.deadline ? 'error' : 'default'}
              data-testid="enqueue-deadline"
            />
          </Field>
        </div>
        {delayed && queue && (
          <p
            className="m-0 flex items-start gap-1.5 text-[13px] text-kumo-subtle"
            data-testid="enqueue-delay-note"
          >
            <InfoIcon size={14} className="mt-0.5 shrink-0" />
            {queue.holdScheduled ? (
              <span>
                {queue.id} holds scheduled tasks: this one waits as held until then; Run now
                releases it.
              </span>
            ) : (
              <span>
                The emulator runs a task as soon as a slot is free; a delay only sets
                X-CloudTasks-TaskETA.{' '}
                <button
                  type="button"
                  className="text-kumo-link underline-offset-2 hover:underline"
                  onClick={() => onShowConfig(queue)}
                >
                  Hold scheduled tasks
                </button>{' '}
                in Configuration to make it wait.
              </span>
            )}
          </p>
        )}
        <Disclosure
          label="Headers"
          detail={
            headers.filter((row) => row.key !== '').length > 0
              ? `· ${headers.filter((row) => row.key !== '').length}`
              : undefined
          }
          open={showHeaders}
          onToggle={() => setShowHeaders((open) => !open)}
          testId="enqueue-headers-toggle"
        />
        {showHeaders && (
          <KeyValueEditor
            label="Headers"
            rows={headers}
            onChange={(rows) => {
              submit.reset()
              setHeaders(rows)
            }}
            keyPlaceholder="name"
            valuePlaceholder="value"
            testId="enqueue-headers"
          />
        )}
        <Disclosure
          label="URL"
          detail={draft.url === '' ? '· the queue’s default' : undefined}
          open={showUrl}
          onToggle={() => setShowUrl((open) => !open)}
          testId="enqueue-url-toggle"
        />
        {showUrl && (
          <Field
            label="URL"
            hint={queue?.defaultUri ? `Empty: ${queue.defaultUri}` : undefined}
            error={problems.url}
          >
            <Input
              size="sm"
              value={draft.url}
              onChange={(event) => set({ url: event.target.value })}
              placeholder={queue?.defaultUri ?? 'https://…'}
              spellCheck={false}
              className="font-mono"
              variant={problems.url ? 'error' : 'default'}
              data-testid="enqueue-url"
            />
          </Field>
        )}
      </div>
      {(submit.error || tooLarge || bodyProblem) && (
        <p
          className="m-0 mt-3 text-[13px] text-kumo-danger"
          role="alert"
          data-testid="enqueue-error"
        >
          {submit.error ? errorText(submit.error) : (tooLarge ?? bodyProblem)}
        </p>
      )}
      <div className="mt-5 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">
          {size?.ok && (
            <Tooltip
              content="The JSON request the Admin SDK would send, which the Tasks port holds to 100 KiB."
              render={
                <span
                  className="cursor-default text-[12px] text-kumo-subtle tabular-nums"
                  data-testid="enqueue-size"
                >
                  {formatBytes(size.value)} of {formatBytes(REQUEST_LIMIT)}
                </span>
              }
            />
          )}
        </span>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Tooltip
          content={
            <span className="flex items-center gap-1.5">
              Enqueue <Kbd>⌘↵</Kbd>
            </span>
          }
          render={
            <Button
              variant="primary"
              onClick={send}
              loading={submit.isPending}
              disabled={blocked}
              data-testid="enqueue-submit"
            >
              Enqueue
            </Button>
          }
        />
      </div>
    </div>
  )
}

export function EnqueueDialog({
  open,
  onOpenChange,
  queues,
  queue,
  project,
  prefill,
  onEnqueued,
  onShowConfig,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  queues: readonly TasksQueue[]
  /** The queue on screen: the dialog's queue unless another is picked. */
  queue: TasksQueue | undefined
  project: string
  prefill: string | undefined
  onEnqueued: (row: TasksTaskRow, queue: TasksQueue) => void
  onShowConfig: (queue: TasksQueue) => void
}) {
  // A new form each time it opens: nothing of the last one leaks in.
  const [session, setSession] = useState(0)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setSession((now) => now + 1)
  }
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="p-6 sm:w-[720px]">
        {open && (
          <EnqueueForm
            key={`${session}|${queue?.key ?? ''}|${prefill ?? ''}`}
            queues={queues}
            initialQueue={queue}
            project={project}
            prefill={prefill}
            onClose={() => onOpenChange(false)}
            onEnqueued={onEnqueued}
            onShowConfig={onShowConfig}
          />
        )}
      </Dialog>
    </Dialog.Root>
  )
}
