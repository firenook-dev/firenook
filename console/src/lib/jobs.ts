// Bulk work the engine runs for a section (foundation spec §7.20): a job's
// state comes from `GET /jobs/{id}` once and then from the `jobs` topic,
// which patches the cached job as it moves, so nothing polls. A reloaded
// page finds the jobs its section started through `GET /jobs?section=`.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiGet, apiSend } from '@/api/client'
import type { Job } from '@/lib/live/contract'
import { useLiveTopic } from '@/lib/live/use-live-topic'
import { queryClient } from '@/lib/query'

export type { Job, JobError, JobState } from '@/lib/live/contract'

export const jobKey = (id: string) => ['jobs', id] as const
export const sectionJobsKey = (section: string) => ['jobs', 'section', section] as const

/** `list` with `job` in its place (or added, newest first), in one new array. */
export function mergeJob(list: readonly Job[], job: Job): Job[] {
  const at = list.findIndex((known) => known.id === job.id)
  if (at === -1) return [job, ...list]
  const next = [...list]
  next[at] = job
  return next
}

/** A job's live state: the `jobs` topic patches ['jobs', id]; GET /jobs/{id} on mount. */
export function useJob(id: string | undefined): Job | undefined {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: jobKey(id ?? ''),
    queryFn: ({ signal }) => apiGet<Job>(`/jobs/${encodeURIComponent(id ?? '')}`, {}, signal),
    enabled: id !== undefined,
    // The topic keeps it current; a refetch would only repeat it.
    staleTime: Number.POSITIVE_INFINITY,
  })
  const job = id === undefined ? undefined : query.data
  useLiveTopic('jobs', job ? { section: job.section } : null, {
    onJob: (next) => {
      if (next.id === id) client.setQueryData(jobKey(next.id), next)
    },
    onReset: () => {
      if (id !== undefined) void client.invalidateQueries({ queryKey: jobKey(id) })
    },
  })
  return job
}

/** The section's running jobs and those finished in the last 10 minutes (GET /jobs?section=), so a
 *  reloaded page re-attaches to the job it started. */
export function useJobs(section: string): readonly Job[] {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: sectionJobsKey(section),
    queryFn: async ({ signal }) =>
      (await apiGet<{ jobs: Job[] }>('/jobs', { section }, signal)).jobs,
    staleTime: Number.POSITIVE_INFINITY,
    // An engine without the jobs routes has no jobs to list; asking again
    // would only repeat the 404.
    retry: (failures, error) =>
      failures < 1 && !(error instanceof ApiError && error.code === 'not-found'),
  })
  useLiveTopic(
    'jobs',
    { section },
    {
      onJob: (job) => {
        client.setQueryData(jobKey(job.id), job)
        client.setQueryData<Job[]>(sectionJobsKey(section), (list) => mergeJob(list ?? [], job))
      },
      onReset: () => void client.invalidateQueries({ queryKey: sectionJobsKey(section) }),
    },
  )
  return query.data ?? NO_JOBS
}

const NO_JOBS: readonly Job[] = []

/** Asks the engine to stop a job between batches; answers its state then. */
export async function cancelJob(id: string): Promise<Job> {
  const job = await apiSend<Job>('POST', `/jobs/${encodeURIComponent(id)}/cancel`, {})
  queryClient.setQueryData(jobKey(job.id), job)
  return job
}
