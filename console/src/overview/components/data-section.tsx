// "Data": take the emulators' data out, or start clean, without a terminal.
// A snapshot downloads as a zip of a standard export (`--import` reads it)
// or is saved on the engine's machine; a reset removes one section's data,
// or all of it. Each is a suite job: one runs at a time, every tab sees its
// progress, and it carries on if this tab goes away. While one runs, every
// control that would start another waits, and says why.

import { Button, Loader, Tooltip } from '@cloudflare/kumo'
import {
  ArrowCounterClockwiseIcon,
  DownloadSimpleIcon,
  FloppyDiskIcon,
} from '@phosphor-icons/react'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { Job } from '@/api/generated/Job'
import { CopyField } from '@/components/console/copy-button'
import { useNow } from '@/lib/clock'
import { formatClock, formatDuration, formatNumber } from '@/lib/format'
import { cancelJob } from '@/lib/jobs'
import { SNAPSHOT_JOB } from '../api'
import { holdsNothing, resettableSections } from '../model'
import type { OverviewDialog } from '../search'
import { type SnapshotView, snapshotSize, useSnapshotFlow } from '../snapshot'
import { ResetDialog, type ResetTarget } from './reset-dialog'
import { SaveSnapshotDialog } from './save-snapshot-dialog'
import { SnapshotDialog } from './snapshot-dialog'
import { listedLabels, snapshotServices } from './snapshot-targets'
import { LINK_CLASS } from './text-link'

const IMPORT_COMMAND = 'firenook emulators:start --import <folder>'

export function DataSection({
  status,
  project,
  dialog,
  reset,
  onDialog,
  onReset,
}: {
  status: ConsoleStatus
  project: string
  /** The dialog the address opens (`?dialog=`). */
  dialog: OverviewDialog | undefined
  /** The reset this page opened from a row (not in the address). */
  reset: ResetTarget | undefined
  onDialog: (dialog: OverviewDialog | undefined) => void
  onReset: (target: ResetTarget | undefined) => void
}) {
  const snapshot = useSnapshotFlow(project)
  const resettable = resettableSections(status)
  const running = snapshot.running
  // `?dialog=reset` names no section: the one there is, or all of them.
  const resetTarget: ResetTarget | undefined =
    reset ??
    (dialog === 'reset'
      ? resettable.length === 1 && resettable[0]
        ? { kind: 'section', id: resettable[0].section.id }
        : { kind: 'everything' }
      : undefined)

  return (
    <section
      className="grid gap-3"
      aria-labelledby="overview-data-title"
      data-testid="overview-data-section"
    >
      <h2 id="overview-data-title" className="text-lg font-semibold">
        Data
      </h2>
      <DataCards status={status} snapshot={snapshot} onDialog={onDialog} onReset={onReset} />

      <SnapshotDialog
        open={dialog === 'snapshot'}
        onOpenChange={(open) => {
          if (!open) {
            onDialog(undefined)
            snapshot.clearRefusal()
          }
        }}
        status={status}
        running={running}
        starting={snapshot.starting}
        refusal={snapshot.refusal}
        onStart={snapshot.start}
      />
      <SaveSnapshotDialog
        open={dialog === 'save'}
        onOpenChange={(open) => {
          if (!open) onDialog(undefined)
        }}
        status={status}
        running={running}
      />
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
    </section>
  )
}

/**
 * The Snapshot and Reset cards, drawn from what they are given: the page
 * hands them its snapshot flow, the design system a fixed one. Pressing a
 * control asks the page (`onDialog`, `onReset`) or the flow (`start`,
 * `download`); the cards hold no state of their own.
 */
export function DataCards({
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
    <div className="grid gap-3 md:grid-cols-2">
      <article
        className="flex min-w-0 flex-col gap-3 rounded-lg bg-kumo-base px-5 py-4 shadow-xs ring ring-kumo-line"
        data-testid="overview-snapshot"
      >
        <div className="grid gap-1">
          <h3 className="text-[14px] font-semibold">Snapshot</h3>
          <p className="text-[13px] text-kumo-subtle">
            {services.length > 0
              ? `${listedLabels(services)}, as a standard export the engine imports at start.`
              : 'No service this engine runs keeps data a snapshot could hold.'}
          </p>
        </div>
        {services.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                icon={<DownloadSimpleIcon />}
                loading={snapshot.starting}
                disabled={running !== undefined}
                title={busy}
                onClick={() => void snapshot.start()}
                data-testid="overview-snapshot-download"
              >
                Download snapshot
              </Button>
              <Button
                variant="secondary"
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
            <p className="mt-auto flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 pt-1 text-[12px] text-kumo-subtle">
              Start from one with
              <CopyField value={IMPORT_COMMAND} className="text-kumo-default" />
            </p>
          </>
        )}
      </article>

      <article
        className="flex min-w-0 flex-col gap-3 rounded-lg bg-kumo-base px-5 py-4 shadow-xs ring ring-kumo-line"
        data-testid="overview-reset"
      >
        <div className="grid gap-1">
          <h3 className="text-[14px] font-semibold">Reset</h3>
          <p className="text-[13px] text-kumo-subtle">
            {resettable.length > 0
              ? 'Delete a section’s data without restarting the engine. Rules, Functions code and configuration stay.'
              : 'None of the sections this engine runs can be reset from the console.'}
          </p>
        </div>
        {resettable.length > 0 && (
          <div
            className="grid grid-cols-[max-content_minmax(0,1fr)_max-content] items-center gap-x-4 gap-y-1"
            data-testid="overview-reset-rows"
          >
            {resettable.map(({ section, status: entry }) => (
              <div
                key={section.id}
                className="contents"
                data-testid={`overview-reset-${section.id}`}
              >
                <span className="text-[13px] text-kumo-default">{section.label}</span>
                <span className="truncate font-mono text-[12px] text-kumo-subtle">
                  {entry.summary?.headline ?? ''}
                </span>
                {holdsNothing(entry.summary) ? (
                  <span className="px-2 text-[12px] text-kumo-subtle">Empty</span>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<ArrowCounterClockwiseIcon className="text-kumo-danger" />}
                    disabled={running !== undefined}
                    title={busy}
                    onClick={() => onReset({ kind: 'section', id: section.id })}
                    data-testid={`overview-reset-${section.id}-open`}
                  >
                    <span className="text-kumo-danger">Reset…</span>
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
        {resettable.length > 1 && (
          <div className="flex justify-end border-t border-kumo-hairline pt-2">
            <Button
              variant="ghost"
              size="sm"
              icon={<ArrowCounterClockwiseIcon className="text-kumo-danger" />}
              disabled={running !== undefined}
              title={busy}
              onClick={() => onReset({ kind: 'everything' })}
              data-testid="overview-reset-everything"
            >
              <span className="text-kumo-danger">Reset everything…</span>
            </Button>
          </div>
        )}
        {running && running.kind !== SNAPSHOT_JOB && <JobLine job={running} />}
      </article>
    </div>
  )
}

/** What the snapshot is doing now: preparing, ready to download, downloaded, refused or failed. */
function SnapshotState({ snapshot }: { snapshot: SnapshotView }) {
  const { running, job, ready, taken, refusal, file } = snapshot
  if (running?.kind === SNAPSHOT_JOB) return <JobLine job={running} />
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
                  until {formatClock(file.data.expiresAt, 'time').slice(0, 5)}
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

/** A suite job on its way: a spinner, what it has done so far, and Cancel. */
function JobLine({ job }: { job: Job }) {
  const now = useNow('second')
  const elapsed = formatDuration(Math.max(0, now - Date.parse(job.startedAt)))
  const text =
    job.kind === SNAPSHOT_JOB
      ? `Preparing a snapshot… ${elapsed}`
      : `${job.title}: ${formatNumber(job.done)}${job.total === null ? '' : ` of ${formatNumber(job.total)}`} deleted · ${elapsed}`
  return (
    <div
      className="flex min-w-0 items-center gap-2 text-[12px] text-kumo-subtle"
      data-testid="overview-job"
    >
      <Loader size="sm" />
      <span className="min-w-0 truncate">{text}</span>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => void cancelJob(job.id)}
        className="ml-auto"
        data-testid="overview-job-cancel"
      >
        Cancel
      </Button>
    </div>
  )
}
