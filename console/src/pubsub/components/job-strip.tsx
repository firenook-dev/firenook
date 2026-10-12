// A publish that outlives its composer (PS-11): every running
// `pubsub.publish` job of the section, one line each above the message
// table, in every tab, found again after a reload (`GET /jobs?section=`),
// until it ends. A run that stopped when its tab hid would be a run nobody
// could trust, so the engine runs it, and any tab can stop it.

import { Button } from '@cloudflare/kumo'
import { StopIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { cancelJob, useJobs } from '@/lib/jobs'
import { formatNumber } from '@/lib/format'

export function JobStrip({ testId = 'pubsub-job-strip' }: { testId?: string }) {
  const jobs = useJobs('pubsub').filter(
    (job) => job.kind === 'pubsub.publish' && job.state === 'running',
  )
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set())
  if (jobs.length === 0) return null
  return (
    <div className="grid shrink-0" data-testid={testId}>
      {jobs.map((job) => (
        <div
          key={job.id}
          className="flex min-h-9 items-center gap-2 border-b border-kumo-line bg-kumo-tint px-3 py-1 text-[13px]"
          data-testid="pubsub-job"
          data-job={job.id}
        >
          <span className="relative flex size-2 shrink-0" aria-hidden>
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-kumo-brand motion-reduce:hidden" />
            <span className="relative inline-flex size-2 rounded-full bg-kumo-brand" />
          </span>
          <span className="min-w-0 flex-1 truncate text-kumo-default">
            {job.title} —{' '}
            <span className="font-mono text-[12px] tabular-nums" data-testid="pubsub-job-done">
              {formatNumber(job.done)}
            </span>{' '}
            sent
          </span>
          <Button
            variant="secondary"
            size="xs"
            icon={<StopIcon />}
            loading={stopping.has(job.id)}
            onClick={() => {
              setStopping((current) => new Set(current).add(job.id))
              void cancelJob(job.id).finally(() =>
                setStopping((current) => {
                  const next = new Set(current)
                  next.delete(job.id)
                  return next
                }),
              )
            }}
            data-testid="pubsub-job-stop"
          >
            Stop
          </Button>
        </div>
      ))}
    </div>
  )
}
