// Every destructive action in the console asks here, one way: what goes,
// what it sets off (the functions that will run for it, or that none
// will), and how to get it back. A generic "Are you sure?" says none of
// that, which is the official UI's answer and the reason this exists.
//
// The trigger line is computed, never written by the caller: from
// `useTriggersFor`'s answer and whether background triggers are delivered
// at all. While that answer is unknown — Functions starting, not answered
// yet — there is no line: "No function listens" is only ever said
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
  progress,
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
  /** How far work the page runs itself has got, when it is not a job ("12 of 40 deleted…"). */
  progress?: ReactNode
  error?: string
  pending: boolean
  onConfirm: () => void
  testId?: string
}) {
  const status = useQuery(statusQuery)
  const job = useJob(jobId)
  const running = pending || job?.state === 'running'
  const line = triggerLine(triggers?.answer, triggers?.times ?? 0, status.data?.backgroundTriggers)
  const [typed, setTyped] = useState('')
  const [cancelling, setCancelling] = useState(false)
  // Each opening starts afresh: nothing typed, no failures unfolded.
  const [session, setSession] = useState(0)

  const close = (next: boolean) => {
    // A running job is stopped with Cancel, not by dismissing the dialog:
    // Escape or a click outside would leave it running unseen.
    if (!next && running) return
    if (!next) {
      setTyped('')
      setCancelling(false)
      setSession((count) => count + 1)
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
        <DangerConfirmBody
          key={session}
          inDialog
          title={title}
          description={description}
          line={line}
          consequences={consequences}
          confirmText={confirmText}
          typed={typed}
          onTypedChange={setTyped}
          option={option}
          job={job}
          progressVerb={progressVerb}
          progress={progress}
          error={error}
          pending={pending}
          cancelling={cancelling}
          onCancel={() => void cancel()}
          onConfirm={onConfirm}
          testId={testId}
        />
      </Dialog>
    </Dialog.Root>
  )
}

/**
 * What the confirmation says and offers, without the dialog around it:
 * DangerConfirm draws it in its dialog, and a design-system card draws it
 * at rest in a frame of its own (`inDialog` false) at any point of a job it
 * is handed — so a card shows the real confirmation, never a copy.
 */
export function DangerConfirmBody({
  inDialog = false,
  title,
  description,
  line,
  consequences = NO_CONSEQUENCES,
  confirmText,
  typed = '',
  onTypedChange,
  option,
  job,
  progressVerb = 'deleted',
  progress,
  error,
  pending = false,
  cancelling = false,
  onCancel,
  onConfirm,
  testId = 'danger-confirm',
}: {
  /** Inside DangerConfirm's dialog (its title, description and close are the dialog's), or framed on its own. */
  inDialog?: boolean
  title: string
  description: ReactNode
  /** The trigger line (`triggerLine`), or nothing when the answer is not known. */
  line?: TriggerLine | undefined
  consequences?: readonly ReactNode[]
  confirmText?: string | undefined
  typed?: string
  onTypedChange?: (typed: string) => void
  option?: { label: string; checked: boolean; onChange: (checked: boolean) => void } | undefined
  /** The job the confirm started, as it stands. */
  job?: Job | undefined
  progressVerb?: string
  /** Progress of work that is not a job, said under the description while it runs. */
  progress?: ReactNode
  error?: string | undefined
  pending?: boolean
  cancelling?: boolean
  onCancel?: () => void
  onConfirm?: () => void
  testId?: string
}) {
  const [showErrors, setShowErrors] = useState(false)
  const running = pending || job?.state === 'running'
  const finished = job !== undefined && job.state !== 'running'
  const confirmed = confirmText === undefined || typed === confirmText
  const closeButton = (
    <Button
      variant="ghost"
      shape="square"
      icon={<XIcon />}
      aria-label="Close"
      disabled={running}
      onClick={inDialog ? undefined : onCancel}
    />
  )
  const contents = (
    // Kumo's Dialog drops a test id; the contents carry it.
    <div className="contents" data-testid={testId}>
      <div className="mb-3 flex items-start justify-between gap-4">
        {inDialog ? (
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
        ) : (
          <h3 className="text-lg font-semibold text-kumo-default">{title}</h3>
        )}
        {inDialog ? (
          <Dialog.Close aria-label="Close" disabled={running} render={closeButton} />
        ) : (
          closeButton
        )}
      </div>
      {inDialog ? (
        <Dialog.Description className="text-kumo-subtle">{description}</Dialog.Description>
      ) : (
        <p className="text-[14px] text-kumo-subtle">{description}</p>
      )}
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
            Type <span className="font-mono text-[0.9em] text-kumo-default">{confirmText}</span> to
            confirm
          </Text>
          <Input
            size="sm"
            value={typed}
            onChange={(event) => onTypedChange?.(event.target.value)}
            readOnly={onTypedChange === undefined}
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
      {!job && progress !== undefined && progress !== null && (
        <div className="mt-3" data-testid={`${testId}-progress`}>
          <Text variant="secondary" size="sm">
            {progress}
          </Text>
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
          onClick={onCancel}
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
  )
  if (inDialog) return contents
  // At rest outside a dialog: the dialog's own surface, as a frame.
  return (
    <div className="w-[512px] max-w-full rounded-xl bg-kumo-base p-6 shadow-lg ring ring-kumo-line">
      {contents}
    </div>
  )
}

/** The trigger line's items (`<li>`s for a list): each function and how often it runs, or why none does. */
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
