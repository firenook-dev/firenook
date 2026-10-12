// Suite jobs (`suite.*`: a reset, a snapshot being prepared) said in every
// tab, a tab opened after the job started included: the shell mounts this
// lazily, it re-attaches through `GET /jobs?section=suite` and follows the
// `jobs` topic. One toast per job, replaced in place as it moves, under the
// one toast policy. A job that had already finished before this tab saw it
// is not announced: that news is old.

import { useEffect, useRef } from 'react'
import { type Job, cancelJob, useJobs } from '@/lib/jobs'
import { formatNumber } from '@/lib/format'
import { type ToastOptions, toast } from '@/lib/toasts'

/** "1,204 of 5,000 · 3 skipped · 2 failed". */
export function jobProgress(job: Job): string {
  const parts = [
    job.total === null
      ? `${formatNumber(job.done)} done`
      : `${formatNumber(job.done)} of ${formatNumber(job.total)}`,
  ]
  if (job.skipped > 0) parts.push(`${formatNumber(job.skipped)} skipped`)
  if (job.errorCount > 0) parts.push(`${formatNumber(job.errorCount)} failed`)
  return parts.join(' · ')
}

/**
 * Why a job failed: the engine's own reason for the whole job ("The engine
 * stopped."), else its first failed item's, else how far it got.
 */
export function jobFailure(job: Job): string {
  return job.message ?? job.errors[0]?.message ?? jobProgress(job)
}

/** The toast for a suite job that has ended, as this watch says it. */
export function jobEndToast(job: Job): ToastOptions {
  const key = `job:${job.id}`
  if (job.state === 'done')
    return { key, title: `${job.title}: done`, description: jobProgress(job), tone: 'success' }
  if (job.state === 'cancelled')
    return {
      key,
      title: `${job.title}: cancelled`,
      description: jobProgress(job),
      tone: 'warning',
    }
  return { key, title: `${job.title}: failed`, description: jobFailure(job), tone: 'danger' }
}

export function JobsWatch() {
  const jobs = useJobs('suite')
  // What this tab has said about each job: its state and progress.
  const said = useRef(new Map<string, string>())
  useEffect(() => {
    for (const job of jobs) {
      const mark = `${job.state}:${job.done}:${job.skipped}:${job.errorCount}`
      const before = said.current.get(job.id)
      if (before === mark) continue
      said.current.set(job.id, mark)
      if (before === undefined && job.state !== 'running') continue
      const key = `job:${job.id}`
      if (job.state === 'running') {
        toast({
          key,
          title: job.title,
          description: jobProgress(job),
          tone: 'info',
          action: { label: 'Cancel', run: () => void cancelJob(job.id) },
        })
      } else {
        toast(jobEndToast(job))
      }
    }
  }, [jobs])
  return null
}
