// Every destructive action in the console asks here, one way: what goes,
// what it sets off (the functions that will run for it, or that none
// will), and how to get it back. A generic "Are you sure?" says none of
// that, which is the official UI's answer and the reason this exists.
//
// The trigger line is computed, never written by the caller: from
// `useTriggersFor`'s answer and whether background triggers are delivered
// at all. While that answer is unknown — compute not built, Functions
// starting — there is no line: "No function listens" is only ever said
// when the engine knows it. Bulk work is a job: its progress, skipped
// items, failures and Cancel come from the job itself.

import { Button, Checkbox, Dialog, Input, Text } from '@cloudflare/kumo'
import { TrashIcon, XIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import type { BackgroundTriggers } from '@/api/generated/BackgroundTriggers'
import { statusQuery } from '@/api/queries'
import { formatNumber } from '@/lib/format'
import { type Job, cancelJob, useJob } from '@/lib/jobs'
import type { TriggerFunction, TriggersAnswer } from '@/lib/triggers'
import { EntityLink } from './entity-link'

/** What the trigger line says, or nothing for an answer the engine does not have. */
export type TriggerLine =
  | { kind: 'functions'; functions: readonly TriggerFunction[]; times: number }
  | { kind: 'none' }
  | { kind: 'paused' }

export function triggerLine(
  answer: TriggersAnswer | undefined,
  times: number,
  background: Pick<BackgroundTriggers, 'enabled'> | undefined,
): TriggerLine | undefined {
  if (answer === undefined || answer === 'unknown' || answer === 'absent') return undefined
  if (answer.functions.length === 0) return { kind: 'none' }
  if (!answer.backgroundEnabled || background?.enabled === false) return { kind: 'paused' }
  return { kind: 'functions', functions: answer.functions, times }
}

/** "runs once", "runs 1,204 times". */
export function runsTimes(times: number): string {
  return times === 1 ? 'runs once' : `runs ${formatNumber(times)} times`
}

/** "412 of 1,204 deleted · 2 skipped · 3 failed", from the job. */
export function jobProgress(
  job: Pick<Job, 'done' | 'total' | 'skipped' | 'errorCount' | 'state'>,
  verb: string,
): string {
  const parts = [
    job.total === null
      ? `${formatNumber(job.done)} ${verb}`
      : `${formatNumber(job.done)} of ${formatNumber(job.total)} ${verb}`,
  ]
  if (job.skipped > 0) parts.push(`${formatNumber(job.skipped)} skipped`)
  if (job.errorCount > 0) parts.push(`${formatNumber(job.errorCount)} failed`)
  const text = parts.join(' · ')
  if (job.state === 'running') return `${text}…`
  if (job.state === 'cancelled') return `Stopped: ${text}`
  if (job.state === 'failed') return `Failed: ${text}`
  return `Done: ${text}`
}

const NO_CONSEQUENCES: readonly ReactNode[] = []

export function DangerConfirm({
  open,
  onOpenChange,
  title,
  description,
  triggers,
  consequences = NO_CONSEQUENCES,
  confirmText,
  option,
  jobId,
  progressVerb = 'deleted',
  error,
  pending,
  onConfirm,
  testId = 'danger-confirm',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** "Delete 3 users"; the button says the same. */
  title: string
  description: ReactNode
  /** The functions this would run (`useTriggersFor`'s answer) and how many items would fire them. */
  triggers?: { answer: TriggersAnswer; times: number }
  /** The way back, and anything else that is fixed. */
  consequences?: readonly ReactNode[]
  /** Type-to-confirm when set (a bucket, "everything"); case-sensitive. */
  confirmText?: string
  option?: { label: string; checked: boolean; onChange: (checked: boolean) => void }
  /** The job the confirm started: progress, failures and Cancel come from it. */
  jobId?: string
  /** The word for what the job did to each item ("deleted", "purged"). */
  progressVerb?: string
  error?: string
  pending: boolean
  onConfirm: () => void
  testId?: string
}) {
  const status = useQuery(statusQuery)
  const job = useJob(jobId)
  const running = pending || job?.state === 'running'
  const finished = job !== undefined && job.state !== 'running'
  const line = triggerLine(triggers?.answer, triggers?.times ?? 0, status.data?.backgroundTriggers)
  const [typed, setTyped] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const confirmed = confirmText === undefined || typed === confirmText

  const close = (next: boolean) => {
    // A running job is stopped with Cancel, not by dismissing the dialog:
    // Escape or a click outside would leave it running unseen.
    if (!next && running) return
    if (!next) {
      setTyped('')
      setShowErrors(false)
      setCancelling(false)
    }
    onOpenChange(next)
  }

  const cancel = async () => {
    if (job?.state === 'running' && jobId) {
      setCancelling(true)
      try {
        await cancelJob(jobId)
      } finally {
        setCancelling(false)
      }
      return
    }
    close(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog size="base" className="p-6">
        {/* Kumo's Dialog drops a test id; the contents carry it. */}
        <div className="contents" data-testid={testId}>
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              disabled={running}
              render={
                <Button
                  variant="ghost"
                  shape="square"
                  icon={<XIcon />}
                  aria-label="Close"
                  disabled={running}
                />
              }
            />
          </div>
          <Dialog.Description className="text-kumo-subtle">{description}</Dialog.Description>
          {(line || consequences.length > 0) && (
            <ul
              className="mt-3 grid list-disc gap-1 pl-5 text-[14px] text-kumo-subtle"
              data-testid={`${testId}-consequences`}
            >
              {line && <TriggerLineItem line={line} testId={testId} />}
              {consequences.map((consequence, index) => (
                <li
                  // The caller's sentences, fixed while the dialog is open: their order is their identity.
                  // oxlint-disable-next-line react/no-array-index-key
                  key={index}
                >
                  {consequence}
                </li>
              ))}
            </ul>
          )}
          {option && (
            <div className="mt-4">
              <Checkbox
                checked={option.checked}
                onCheckedChange={(checked) => option.onChange(Boolean(checked))}
                label={option.label}
                disabled={running || finished}
              />
            </div>
          )}
          {confirmText !== undefined && (
            <div className="mt-4 grid gap-1.5">
              <Text as="span" size="sm" variant="secondary">
                Type <span className="font-mono text-[0.9em] text-kumo-default">{confirmText}</span>{' '}
                to confirm
              </Text>
              <Input
                size="sm"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                aria-label={`Type ${confirmText} to confirm`}
                spellCheck={false}
                autoComplete="off"
                disabled={running || finished}
                className="w-full font-mono"
                data-testid={`${testId}-type`}
              />
            </div>
          )}
          {job && (
            <div className="mt-3 grid gap-1" data-testid={`${testId}-progress`}>
              <Text variant="secondary" size="sm">
                {jobProgress(job, progressVerb)}
                {job.errorCount > 0 && job.errors.length > 0 && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="rounded-sm text-kumo-link hover:underline focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:outline-none"
                      onClick={() => setShowErrors((shown) => !shown)}
                      aria-expanded={showErrors}
                      data-testid={`${testId}-why`}
                    >
                      {showErrors ? 'Hide why' : 'See why'}
                    </button>
                  </>
                )}
              </Text>
              {job.state === 'failed' && job.message && (
                <Text variant="error" size="sm">
                  {job.message}
                </Text>
              )}
              {showErrors && (
                <ul className="grid max-h-40 gap-1 overflow-auto rounded-md bg-kumo-tint p-2 text-[12px]">
                  {job.errors.map((item, index) => (
                    <li
                      // One key can fail twice (a retry), so its position keeps the rows apart.
                      // oxlint-disable-next-line react/no-array-index-key
                      key={`${item.key}-${index}`}
                      className="grid gap-0.5"
                    >
                      <span className="truncate font-mono text-kumo-default">{item.key}</span>
                      <span className="text-kumo-subtle">{item.message}</span>
                    </li>
                  ))}
                  {job.errorCount > job.errors.length && (
                    <li className="text-kumo-subtle">
                      and {formatNumber(job.errorCount - job.errors.length)} more like these
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}
          {error && (
            <div className="mt-2" data-testid={`${testId}-error`}>
              <Text variant="error" size="sm">
                {error}
              </Text>
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => void cancel()}
              loading={cancelling}
              data-testid={`${testId}-cancel`}
            >
              {finished ? 'Close' : 'Cancel'}
            </Button>
            {!finished && (
              <Button
                variant="destructive"
                icon={<TrashIcon />}
                onClick={onConfirm}
                loading={running}
                disabled={!confirmed}
                data-testid={`${testId}-confirm`}
              >
                {title}
              </Button>
            )}
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}

function TriggerLineItem({ line, testId }: { line: TriggerLine; testId: string }) {
  if (line.kind === 'none')
    return <li data-testid={`${testId}-triggers`}>No function listens to this.</li>
  if (line.kind === 'paused')
    return (
      <li data-testid={`${testId}-triggers`}>Background triggers are paused; no function runs.</li>
    )
  return (
    <>
      {line.functions.map((fn) => (
        <li
          key={`${fn.codebase}|${fn.functionId}|${fn.eventType}`}
          data-testid={`${testId}-triggers`}
        >
          <FunctionName fn={fn} /> {runsTimes(line.times)}.
        </li>
      ))}
    </>
  )
}

/** A function's name, linking to it once the Functions section shows it. */
function FunctionName({ fn }: { fn: TriggerFunction }) {
  // `us-central1-onUserDeleted` reads as the export the developer wrote.
  const name = fn.functionId.replace(/^[a-z]+-[a-z]+\d+-/, '')
  return <EntityLink entity={{ kind: 'functions.function', key: fn.functionId, label: name }} />
}
