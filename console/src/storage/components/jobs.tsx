// Storage's bulk work under the toolbar while it runs: each job's title
// (fixed when it started: "Delete users/ · 900 files · 20 MB"), how far it
// got, and Cancel; once it ends, a few seconds of what it did and, when
// items failed, why — a refusal's explanation came with it. The jobs are
// the foundation's: progress rides the `jobs` topic, and a reloaded page
// finds its running and recent jobs again (`GET /jobs?section=storage`).

import { Button, Popover, cn } from '@cloudflare/kumo'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { StorageBulkItemError } from '@/api/generated/storage/StorageBulkItemError'
import { jobProgress } from '@/components/console/danger-confirm'
import { SectionBanner } from '@/components/console/section-banner'
import { PanelTitle } from '@/components/kit'
import { useNow } from '@/lib/clock'
import { formatNumber } from '@/lib/format'
import { type Job, cancelJob, useJobs } from '@/lib/jobs'
import { useFiles } from '../files-state'
import { storageKeys } from '../queries'
import { RefusalDetail } from './refusal-detail'

/** How long a finished job's summary stays. */
const SUMMARY_MS = 4_000

/** The verb a job's progress says, by its kind. */
export function jobVerb(kind: string): string {
  if (kind === 'storage.move') return 'moved'
  if (kind === 'storage.copy') return 'copied'
  if (kind === 'storage.metadata') return 'changed'
  return 'deleted'
}

function Errors({ job }: { job: Job }) {
  return (
    <Popover>
      <Popover.Trigger
        render={
          <Button variant="ghost" size="xs" data-testid="job-see-why">
            See why
          </Button>
        }
      />
      <Popover.Content className="grid w-[480px] max-w-[calc(100vw-2rem)] gap-2">
        <PanelTitle>What did not go through</PanelTitle>
        <ul className="grid max-h-80 gap-1.5 overflow-y-auto">
          {job.errors.map((error, index) => {
            const detail = error.detail as StorageBulkItemError | undefined
            return (
              <li
                // One key can fail twice (a retry), so its place keeps the rows apart.
                // oxlint-disable-next-line react/no-array-index-key
                key={`${error.key}-${index}`}
                className="grid gap-0.5"
              >
                <span className="truncate font-mono text-[12px] text-kumo-default">
                  {error.key}
                </span>
                <span className="flex items-center gap-2 text-[12px] text-kumo-subtle">
                  {error.message}
                  {detail?.evaluation && (
                    <RefusalDetail
                      extras={{
                        decision: detail.decision,
                        evaluation: detail.evaluation,
                        request: detail.request,
                      }}
                      trigger={
                        <Button variant="ghost" size="xs">
                          Why
                        </Button>
                      }
                    />
                  )}
                </span>
              </li>
            )
          })}
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

function JobBanner({ job }: { job: Job }) {
  const running = job.state === 'running'
  const share = job.total ? job.done / job.total : 0
  return (
    <SectionBanner
      tone={job.state === 'failed' ? 'danger' : job.errorCount > 0 && !running ? 'warning' : 'info'}
      testId="storage-job"
      action={
        <span className="flex items-center gap-1">
          {job.errorCount > 0 && job.errors.length > 0 && <Errors job={job} />}
          {running && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void cancelJob(job.id)}
              data-testid="job-cancel"
            >
              Cancel
            </Button>
          )}
        </span>
      }
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className="min-w-0 truncate">{job.title}</span>
        <span
          className="shrink-0 text-[12px] text-kumo-subtle tabular-nums"
          data-testid="job-progress"
        >
          {jobProgress(job, jobVerb(job.kind))}
        </span>
        {running && job.total ? (
          <span className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-kumo-tint">
            <span
              className={cn('block h-full bg-kumo-brand')}
              style={{ width: `${Math.round(share * 100)}%` }}
            />
          </span>
        ) : null}
      </span>
    </SectionBanner>
  )
}

/** The banners of the jobs this page should show: running ones, and those just finished. */
export function StorageJobs() {
  const files = useFiles()
  const queryClient = useQueryClient()
  const jobs = useJobs('storage')
  // To the second only while a finished job's summary is on screen.
  const now = useNow(jobs.some((job) => job.state !== 'running') ? 'second' : 'minute')
  const running = jobs.filter((job) => job.state === 'running')
  const recent = jobs.filter(
    (job) =>
      job.state !== 'running' &&
      job.finishedAt !== null &&
      now - Date.parse(job.finishedAt) < SUMMARY_MS,
  )
  // Once a job ends, the figures and the tree of the bucket are read again:
  // the object changes already refreshed them; this is the backstop.
  const ended = jobs
    .filter((job) => job.state !== 'running')
    .map((job) => job.id)
    .join('|')
  useEffect(() => {
    if (ended === '') return
    void queryClient.invalidateQueries({
      queryKey: storageKeys.foldersOf(files.project, files.bucket),
    })
    void queryClient.invalidateQueries({
      queryKey: storageKeys.treeOf(files.project, files.bucket),
    })
    void queryClient.invalidateQueries({ queryKey: storageKeys.buckets(files.project) })
  }, [ended, queryClient, files.project, files.bucket])
  const banners = [...running, ...recent]
  if (banners.length === 0) return null
  return (
    <div className="grid shrink-0" data-testid="storage-jobs">
      {banners.map((job) => (
        <JobBanner key={job.id} job={job} />
      ))}
    </div>
  )
}
