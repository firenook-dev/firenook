// Authentication's running jobs — a bulk change, an import, a delete —
// said on the Users page while they run, however the page was reached: a
// reload, or another tab that started them, re-attaches through
// `GET /jobs?section=auth` and the `jobs` topic. Each shows its progress and
// Cancel (which stops it between chunks); one that finishes while the page
// is open says how it ended, once, under the toast policy.

import { Button } from '@cloudflare/kumo'
import { useEffect, useRef } from 'react'
import { SectionBanner } from '@/components/console/section-banner'
import { jobProgress } from '@/components/console/danger-confirm'
import { type Job, cancelJob, useJobs } from '@/lib/jobs'
import { toast } from '@/lib/toasts'

/** The word a job's items are counted with, by its kind (`auth.disable` → "disabled"). */
export function jobVerb(kind: string): string {
  const verb = kind.replace(/^auth\./, '')
  switch (verb) {
    case 'disable':
      return 'disabled'
    case 'enable':
      return 'enabled'
    case 'verify':
      return 'verified'
    case 'revoke':
      return 'revoked'
    case 'import':
      return 'imported'
    case 'delete':
      return 'deleted'
    default:
      return 'changed'
  }
}

/** Toasts each Auth job that finishes while the page is open. */
function useJobEndings(jobs: readonly Job[]) {
  const seen = useRef(new Map<string, Job['state']>())
  useEffect(() => {
    for (const job of jobs) {
      const before = seen.current.get(job.id)
      seen.current.set(job.id, job.state)
      // News only for a job this page saw running.
      if (before !== 'running' || job.state === 'running') continue
      const progress = jobProgress(job, jobVerb(job.kind))
      toast({
        key: `job:${job.id}`,
        title:
          job.state === 'done'
            ? `${job.title}: done`
            : job.state === 'cancelled'
              ? `${job.title}: cancelled`
              : `${job.title}: failed`,
        description: job.state === 'failed' && job.message ? job.message : progress,
        tone: job.state === 'done' ? 'success' : job.state === 'cancelled' ? 'warning' : 'danger',
      })
    }
  }, [jobs])
}

export function AuthJobs() {
  const jobs = useJobs('auth')
  useJobEndings(jobs)
  const running = jobs.filter((job) => job.state === 'running')
  if (running.length === 0) return null
  return (
    <>
      {running.map((job) => (
        <SectionBanner
          key={job.id}
          tone="info"
          testId="auth-job"
          action={
            <Button
              variant="secondary"
              size="xs"
              onClick={() => void cancelJob(job.id)}
              data-testid="auth-job-cancel"
            >
              Cancel
            </Button>
          }
        >
          {job.title}: <span className="tabular-nums">{jobProgress(job, jobVerb(job.kind))}</span>
        </SectionBanner>
      ))}
    </>
  )
}
