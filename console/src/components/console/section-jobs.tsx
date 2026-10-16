// A section's bulk work under its toolbar while it runs: each job's title
// (fixed when it started: "Delete users/ · 900 files · 20 MB"), how far it
// got with a bar while the total is known, and Cancel; once it ends, a few
// seconds of what it did and, when items failed, which and why — a
// section's own explanation of one (Storage's rules decision) beside each.
// The jobs are the foundation's: progress rides the `jobs` topic, and a
// reloaded page, or another tab, finds its running and recent jobs again
// (`GET /jobs?section=`).

import { Button, Popover } from '@cloudflare/kumo'
import { type ReactNode, useEffect, useEffectEvent } from 'react'
import { PanelTitle } from '@/components/kit'
import { useNow } from '@/lib/clock'
import { formatNumber } from '@/lib/format'
import { type Job, type JobError, cancelJob, useJobs } from '@/lib/jobs'
import { jobProgress } from './danger-confirm'
import { type BannerTone, SectionBanner } from './section-banner'

/** How long a finished job's summary stays, ms. */
export const JOB_SUMMARY_MS = 4_000

export interface SectionJobsProps {
  /** The section whose jobs show. */
  section: string
  /** Only some of them (Pub/Sub: its publish runs). */
  filter?: ((job: Job) => boolean) | undefined
  /** The word its items are counted with, by kind: "deleted", "moved", "sent". */
  verb: (kind: string) => string
  /** How long a finished job's summary stays; 0 shows running jobs only. */
  summaryMs?: number | undefined
  /** A section's own explanation of one failed item, drawn after its message (a "Why" button). */
  why?: ((error: JobError) => ReactNode) | undefined
  /** Called when jobs end, with the ones that did (a page reads its lists again). */
  onEnded?: ((ended: readonly Job[]) => void) | undefined
  /** The word on the button that stops a running job. */
  cancelLabel?: string | undefined
  /**
   * Each banner's test id; the list is `<testId>s`, a banner's parts are
   * `-progress`, `-message` (why it failed or stopped), `-cancel` and
   * `-see-why`.
   */
  testId: string
}

/** A job's banner tone: danger once it failed, warning once it ended with failed items. */
export function jobTone(job: Pick<Job, 'state' | 'errorCount'>): BannerTone {
  if (job.state === 'failed') return 'danger'
  return job.errorCount > 0 && job.state !== 'running' ? 'warning' : 'info'
}

function Errors({ job, why, testId }: { job: Job; why: SectionJobsProps['why']; testId: string }) {
  return (
    <Popover>
      <Popover.Trigger
        render={
          <Button variant="ghost" size="xs" data-testid={`${testId}-see-why`}>
            See why
          </Button>
        }
      />
      <Popover.Content className="grid w-[480px] max-w-[calc(100vw-2rem)] gap-2">
        <PanelTitle>What did not go through</PanelTitle>
        <ul className="grid max-h-80 gap-1.5 overflow-y-auto">
          {job.errors.map((error, index) => (
            <li
              // One key can fail twice (a retry), so its place keeps the rows apart.
              // oxlint-disable-next-line react/no-array-index-key
              key={`${error.key}-${index}`}
              className="grid gap-0.5"
            >
              <span className="truncate font-mono text-[12px] text-kumo-default">{error.key}</span>
              <span className="flex items-center gap-2 text-[12px] text-kumo-subtle">
                {error.message}
                {why?.(error)}
              </span>
            </li>
          ))}
          {job.errorCount > job.errors.length && (
            <li className="text-[12px] text-kumo-subtle">
              and {formatNumber(job.errorCount - job.errors.length)} more like these
            </li>
          )}
        </ul>
      </Popover.Content>
    </Popover>
  )
}

function JobBanner({
  job,
  verb,
  why,
  cancelLabel,
  testId,
}: {
  job: Job
  verb: string
  why: SectionJobsProps['why']
  cancelLabel: string
  testId: string
}) {
  const running = job.state === 'running'
  const share = job.total ? job.done / job.total : 0
  return (
    <SectionBanner
      tone={jobTone(job)}
      testId={testId}
      action={
        <span className="flex items-center gap-1">
          {job.errorCount > 0 && job.errors.length > 0 && (
            <Errors job={job} why={why} testId={testId} />
          )}
          {running && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void cancelJob(job.id)}
              data-testid={`${testId}-cancel`}
            >
              {cancelLabel}
            </Button>
          )}
        </span>
      }
    >
      <span className="flex min-w-0 items-center gap-3" data-job={job.id}>
        <span className="min-w-0 truncate">{job.title}</span>
        <span
          className="shrink-0 text-[12px] text-kumo-subtle tabular-nums"
          data-testid={`${testId}-progress`}
        >
          {jobProgress(job, verb)}
        </span>
        {!running && job.message && (
          <span
            className="min-w-0 truncate text-[12px] text-kumo-default"
            data-testid={`${testId}-message`}
          >
            {job.message}
          </span>
        )}
        {running && job.total ? (
          <span className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-kumo-tint">
            <span
              className="block h-full bg-kumo-brand"
              style={{ width: `${Math.round(share * 100)}%` }}
            />
          </span>
        ) : null}
      </span>
    </SectionBanner>
  )
}

/** The banners of a section's jobs: those running, and those just finished. */
export function SectionJobs({
  section,
  filter,
  verb,
  summaryMs = JOB_SUMMARY_MS,
  why,
  onEnded,
  cancelLabel = 'Cancel',
  testId,
}: SectionJobsProps) {
  const all = useJobs(section)
  const jobs = filter ? all.filter(filter) : all
  // To the second only while a finished job's summary is on screen.
  const now = useNow(
    summaryMs > 0 && jobs.some((job) => job.state !== 'running') ? 'second' : 'minute',
  )
  const running = jobs.filter((job) => job.state === 'running')
  // `summaryMs` 0 draws running jobs only: the minute clock can be behind a
  // job that just ended, and a negative age is no summary to keep.
  const recent = jobs.filter(
    (job) =>
      summaryMs > 0 &&
      job.state !== 'running' &&
      job.finishedAt !== null &&
      now - Date.parse(job.finishedAt) < summaryMs,
  )
  const endedJobs = jobs.filter((job) => job.state !== 'running')
  const ended = endedJobs.map((job) => job.id).join('|')
  const announce = useEffectEvent(() => onEnded?.(endedJobs))
  useEffect(() => {
    if (ended !== '') announce()
  }, [ended])
  const banners = [...running, ...recent]
  if (banners.length === 0) return null
  return (
    <div className="grid shrink-0" data-testid={`${testId}s`}>
      {banners.map((job) => (
        <JobBanner
          key={job.id}
          job={job}
          verb={verb(job.kind)}
          why={why}
          cancelLabel={cancelLabel}
          testId={testId}
        />
      ))}
    </div>
  )
}
