// "Data": take the emulators' data out, or start clean, without a terminal.
// One card, two halves. A snapshot downloads as a zip of a standard export
// (`--import` reads it) or is saved on the engine's machine; a reset
// removes one section's data, or all of it, picked from a menu that says
// what each holds. Each is a suite job: one runs at a time, every tab sees
// its progress, and it carries on if this tab goes away. While one runs,
// every control that would start another waits, and says why.

import { Button, Loader, Tooltip } from '@cloudflare/kumo'
import { lazy, Suspense, useState } from 'react'
import { DownloadSimpleIcon, FloppyDiskIcon } from '@phosphor-icons/react'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { Job } from '@/api/generated/Job'
import { CopyField } from '@/components/console/copy-button'
import { UNSTOPPABLE_JOBS } from '@/components/shell/jobs-watch'
import { useNow } from '@/lib/clock'
import { clockTime, formatDuration, formatNumber } from '@/lib/format'
import { cancelJob } from '@/lib/jobs'
import { CLEAR_JOB, EXPORT_JOB, SNAPSHOT_JOB } from '../api'
import { linkedReset, resettableSections } from '../model'
import type { OverviewDialog } from '../search'
import {
  type SnapshotView,
  listedLabels,
  snapshotServices,
  snapshotSize,
  useSnapshotFlow,
} from '../snapshot'
import { ResetButton } from './reset-button'
import type { ResetTarget } from './reset-dialog'
import { LINK_CLASS } from './text-link'

// The two dialogs load when one is first asked for: their checkboxes,
// radios and confirmation are not part of the Overview's first paint, and
// the landing route is the one every visit starts on. Once loaded, each
// stays mounted and is opened and shut by `open`, as every dialog is.
const SaveSnapshotDialog = lazy(() =>
  import('./save-snapshot-dialog').then((module) => ({ default: module.SaveSnapshotDialog })),
)
const ResetDialog = lazy(() =>
  import('./reset-dialog').then((module) => ({ default: module.ResetDialog })),
)
// The reset menu's code follows the first paint; until it has arrived the
// card draws the same button, so nothing moves when it does.
const ResetMenu = lazy(() =>
  import('./reset-menu').then((module) => ({ default: module.ResetMenu })),
)

/** Whether a dialog has been asked for on this page: from then on it stays mounted. */
function useAsked(open: boolean): boolean {
  const [asked, setAsked] = useState(open)
  if (open && !asked) setAsked(true)
  return asked || open
}

const IMPORT_COMMAND = 'firenook emulators:start --import <folder>'

export function DataSection({
  status,
  project,
  dialog,
  section,
  reset,
  onDialog,
  onReset,
}: {
  status: ConsoleStatus
  project: string
  /** The dialog the address opens (`?dialog=`). */
  dialog: OverviewDialog | undefined
  /** The section a `?dialog=reset` link names (`?section=`), when it names one. */
  section: string | undefined
  /** The reset this page opened from a row (not in the address). */
  reset: ResetTarget | undefined
  onDialog: (dialog: OverviewDialog | undefined) => void
  onReset: (target: ResetTarget | undefined) => void
}) {
  const snapshot = useSnapshotFlow(project)
  const resettable = resettableSections(status)
  const saveAsked = useAsked(dialog === 'save')
  const running = snapshot.running
  // `?dialog=reset` opens the section it names, else the one there is, or all of them.
  const resetTarget: ResetTarget | undefined =
    reset ?? (dialog === 'reset' ? linkedReset(resettable, section) : undefined)
  const resetAsked = useAsked(resetTarget !== undefined)

  return (
    <section
      id="overview-data"
      className="grid gap-3"
      aria-labelledby="overview-data-title"
      data-testid="overview-data-section"
    >
      <div className="flex h-8 items-center">
        <h2 id="overview-data-title" className="text-[16px] leading-6 font-semibold">
          Data
        </h2>
      </div>
      <DataCard status={status} snapshot={snapshot} onDialog={onDialog} onReset={onReset} />

      <Suspense fallback={null}>
        {saveAsked && (
          <SaveSnapshotDialog
            open={dialog === 'save'}
            onOpenChange={(open) => {
              if (!open) onDialog(undefined)
            }}
            status={status}
            running={running}
          />
        )}
        {resetAsked && (
          <ResetDialog
            open={resetTarget !== undefined}
            onOpenChange={(open) => {
              if (!open) {
                onReset(undefined)
                if (dialog === 'reset') onDialog(undefined)
              }
            }}
            target={resetTarget}
            sections={resettable}
            status={status}
            snapshotting={running?.kind === SNAPSHOT_JOB}
            onSnapshot={() => void snapshot.start()}
          />
        )}
      </Suspense>
    </section>
  )
}

/**
 * The Data card, drawn from what it is given: the page hands it its
 * snapshot flow, the design system a fixed one. Pressing a control asks the
 * page (`onDialog`, `onReset`) or the flow (`start`, `download`); the card
 * holds no state of its own.
 */
export function DataCard({
  status,
  snapshot,
  onDialog,
  onReset,
}: {
  status: ConsoleStatus
  snapshot: SnapshotView
  onDialog: (dialog: OverviewDialog | undefined) => void
  onReset: (target: ResetTarget | undefined) => void
}) {
  const resettable = resettableSections(status)
  const running = snapshot.running
  const services = snapshotServices(status)
  const busy = running ? `A data job is running: ${running.title}` : undefined

  return (
    <div
      className="grid min-w-0 overflow-hidden rounded-lg bg-kumo-base shadow-xs ring ring-kumo-line"
      data-testid="overview-data-card"
    >
      <div className="grid min-w-0 gap-3 px-5 py-4" data-testid="overview-snapshot">
        <Part
          title="Snapshot"
          about={
            services.length > 0
              ? `${listedLabels(services)}, as a standard export the engine can start from.`
              : 'No service this engine runs keeps data a snapshot could hold.'
          }
        />
        {services.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                icon={<DownloadSimpleIcon />}
                loading={snapshot.starting}
                disabled={running !== undefined}
                title={busy}
                onClick={() => void snapshot.start()}
                data-testid="overview-snapshot-download"
              >
                Download
              </Button>
              <Button
                variant="ghost"
                icon={<FloppyDiskIcon />}
                disabled={running !== undefined}
                title={busy}
                onClick={() => onDialog('save')}
                data-testid="overview-snapshot-save"
              >
                Save on the engine&apos;s machine…
              </Button>
            </div>
            <SnapshotState snapshot={snapshot} />
            <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-kumo-subtle">
              Start from one with
              <CopyField value={IMPORT_COMMAND} className="text-kumo-default" />
            </p>
          </>
        )}
      </div>

      <div
        className="grid min-w-0 gap-3 border-t border-kumo-hairline px-5 py-4"
        data-testid="overview-reset"
      >
        <Part
          title="Reset"
          about={
            resettable.length > 0
              ? 'Delete a section’s data without restarting the engine. Rules, code and configuration stay.'
              : 'None of the sections this engine runs can be reset from the console.'
          }
        />
        {resettable.length > 0 && (
          <div className="flex">
            <Suspense fallback={<ResetButton disabled={running !== undefined} title={busy} />}>
              <ResetMenu sections={resettable} busy={busy} onReset={onReset} />
            </Suspense>
          </div>
        )}
        {running?.kind === CLEAR_JOB && <JobLine job={running} />}
      </div>
    </div>
  )
}

/** A half of the card: its name and one sentence on what it does. */
function Part({ title, about }: { title: string; about: string }) {
  return (
    <div className="grid gap-0.5">
      <h3 className="text-[14px] leading-5 font-medium text-kumo-default">{title}</h3>
      <p className="text-[13px] leading-5 text-kumo-subtle">{about}</p>
    </div>
  )
}

/**
 * What the snapshot is doing now: preparing or saving on the engine's
 * machine, ready to download, downloaded, refused or failed.
 */
function SnapshotState({ snapshot }: { snapshot: SnapshotView }) {
  const { running, job, ready, taken, refusal, file } = snapshot
  if (running?.kind === SNAPSHOT_JOB || running?.kind === EXPORT_JOB)
    return <JobLine job={running} />
  if (refusal)
    return (
      <div
        className="grid gap-0.5 text-[12px]"
        role="alert"
        data-testid="overview-snapshot-refused"
      >
        <span className="text-kumo-danger">{refusal.message}</span>
        {'fix' in refusal && typeof refusal.fix === 'string' && (
          <span className="text-kumo-subtle">{refusal.fix}</span>
        )}
      </div>
    )
  if (ready)
    return (
      <p
        className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] text-kumo-default"
        data-testid="overview-snapshot-ready"
      >
        <span>Snapshot ready</span>
        <span className="text-kumo-subtle">·</span>
        <span className="text-kumo-subtle">{snapshotSize(ready)}</span>
        {file.data && (
          <>
            <span className="text-kumo-subtle">·</span>
            <Tooltip
              content="The engine keeps the newest snapshot for 10 minutes, or until it is downloaded."
              render={
                <span className="text-kumo-subtle">
                  until {clockTime(file.data.expiresAt, 'minute')}
                </span>
              }
            />
          </>
        )}
        <span className="text-kumo-subtle">·</span>
        <button
          type="button"
          className={LINK_CLASS}
          onClick={snapshot.download}
          data-testid="overview-snapshot-ready-download"
        >
          Download
        </button>
      </p>
    )
  if (taken)
    return (
      <p className="text-[12px] text-kumo-subtle" data-testid="overview-snapshot-taken">
        Snapshot downloaded · {snapshotSize(taken)}
      </p>
    )
  if (job?.kind === SNAPSHOT_JOB && job.state === 'failed')
    return (
      <p className="text-[12px] text-kumo-danger" data-testid="overview-snapshot-failed">
        The last snapshot was not prepared:{' '}
        {job.message ?? job.errors[0]?.message ?? 'the job failed.'}
      </p>
    )
  return null
}

/** A suite job on its way: a spinner, what it has done so far, and Cancel when it can stop. */
function JobLine({ job }: { job: Job }) {
  const now = useNow('second')
  const elapsed = formatDuration(Math.max(0, now - Date.parse(job.startedAt)))
  const text =
    job.kind === SNAPSHOT_JOB
      ? `Preparing a snapshot… ${elapsed}`
      : job.kind === EXPORT_JOB
        ? `${job.title}… ${elapsed}`
        : `${job.title}: ${formatNumber(job.done)}${job.total === null ? '' : ` of ${formatNumber(job.total)}`} deleted · ${elapsed}`
  return (
    <div
      className="flex min-w-0 items-center gap-2 text-[12px] text-kumo-subtle"
      data-testid="overview-job"
    >
      <Loader size="sm" />
      <span className="min-w-0 truncate">{text}</span>
      {!UNSTOPPABLE_JOBS.has(job.kind) && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void cancelJob(job.id)}
          className="ml-auto"
          data-testid="overview-job-cancel"
        >
          Cancel
        </Button>
      )}
    </div>
  )
}
