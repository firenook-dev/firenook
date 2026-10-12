// The Overview's server data: the engine's `overview` state (notices,
// recent problems, the last hour, the log's totals), how the engine was
// started, what the console's buffers hold, and the data jobs the page
// starts (a snapshot to download, a reset). Section figures are not here:
// they are each section's `SectionStatus.summary`, on the `shell` topic.
//
// Nothing polls. The state is replaced by the `overview` topic while the
// page is mounted; the engine details are fixed for an engine run; the
// buffers are read when their row is shown and on its refresh button; a
// job moves on the foundation's `jobs` topic (`useJobs('suite')`).
//
// The route's loader imports this file, and route loaders are in the first
// route's bundle: it holds queries and calls only, never a component.

import { type QueryClient, queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { API_BASE, ApiError, apiGet, apiSend } from '@/api/client'
import type { Job } from '@/api/generated/Job'
import type { MemoryReport } from '@/api/generated/MemoryReport'
import type { OverviewEngineDetails } from '@/api/generated/observe/OverviewEngineDetails'
import type { OverviewSnapshotFile } from '@/api/generated/observe/OverviewSnapshotFile'
import type { OverviewSnapshotRequest } from '@/api/generated/observe/OverviewSnapshotRequest'
import type { OverviewState } from '@/api/generated/observe/OverviewState'
import { download } from '@/lib/download'
import { jobKey, mergeJob, sectionJobsKey, useJobs } from '@/lib/jobs'
import type { LiveChannel, SubscriptionStatus } from '@/lib/live/channel'
import { liveChannel } from '@/lib/live/channel'
import { useLiveTopic } from '@/lib/live/use-live-topic'
import { useConsoleProject } from '@/lib/project'
import '@/observe/live'

/**
 * The Overview's query keys: the section id first, then the project (the
 * configured one: the Overview never takes `?project=`). Invalidating
 * `state(project)` by prefix reaches every other key.
 */
export const overviewKeys = {
  state: (project: string) => ['overview', project] as const,
  engine: (project: string) => ['overview', project, 'engine'] as const,
  memory: (project: string) => ['overview', project, 'memory'] as const,
  snapshot: (project: string, id: string) => ['overview', project, 'snapshot', id] as const,
}

/** `GET /overview`; afterwards the `overview` topic replaces it (`useOverviewLive`). */
export const overviewQuery = (project: string) =>
  queryOptions({
    queryKey: overviewKeys.state(project),
    queryFn: ({ signal }) => apiGet<OverviewState>('/overview', undefined, signal),
    // The topic keeps it current while the page is mounted; a restart
    // invalidates every query.
    staleTime: Number.POSITIVE_INFINITY,
  })

/** `GET /overview/engine`: how this engine was started, fixed for its run. */
export const engineQuery = (project: string) =>
  queryOptions({
    queryKey: overviewKeys.engine(project),
    queryFn: ({ signal }) => apiGet<OverviewEngineDetails>('/overview/engine', undefined, signal),
    staleTime: Number.POSITIVE_INFINITY,
  })

/**
 * `GET /status/memory`: the console's buffers against their budget. Read
 * when the engine section is shown (enable the query then) and again on
 * its refresh button (`refetch`); never on a timer. Always stale, so each
 * time the row is shown again it reads afresh.
 */
export const memoryQuery = (project: string) =>
  queryOptions({
    queryKey: overviewKeys.memory(project),
    queryFn: ({ signal }) => apiGet<MemoryReport>('/status/memory', undefined, signal),
    staleTime: 0,
  })

/**
 * `GET /overview/snapshots/{id}`: a prepared snapshot the engine still
 * keeps. It never changes; a `not-found` means the engine let it go (it
 * keeps the newest one for 10 minutes, and a download takes it), so it is
 * not asked again.
 */
export const snapshotFileQuery = (project: string, id: string) =>
  queryOptions({
    queryKey: overviewKeys.snapshot(project, id),
    queryFn: ({ signal }) =>
      apiGet<OverviewSnapshotFile>(
        `/overview/snapshots/${encodeURIComponent(id)}`,
        undefined,
        signal,
      ),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

/**
 * Keeps `['overview', project]` current from the `overview` topic while
 * mounted (one engine subscription for the whole browser; the engine sends
 * the state on open and at most twice a second while it changes). Waits
 * for the project to be known.
 */
export function useOverviewLive(
  project: string,
  channel: LiveChannel = liveChannel,
): SubscriptionStatus {
  const client = useQueryClient()
  return useLiveTopic(
    'overview',
    project ? {} : null,
    {
      onState: (state) => client.setQueryData(overviewKeys.state(project), state),
      // A subscription that waited without a state is told to reload.
      onReset: () =>
        void client.invalidateQueries({ queryKey: overviewKeys.state(project), exact: true }),
    },
    channel,
  )
}

/** The Overview's state for the page: the query, kept current by the topic. */
export function useOverview() {
  const { project } = useConsoleProject()
  const live = useOverviewLive(project)
  const state = useQuery({ ...overviewQuery(project), enabled: project !== '' })
  return { project, state, live }
}

/** The job kind a snapshot is prepared as. */
export const SNAPSHOT_JOB = 'suite.snapshot'

/** What a finished `suite.snapshot` job produced (`Job.result`). */
export interface SnapshotResult {
  /** The snapshot's own id (128 random bits, not the job's id): what the file routes take. */
  snapshot: string
  files: number
  bytes: number
}

const SNAPSHOT_ID = /^[0-9a-f]{32}$/

/** The snapshot a finished `suite.snapshot` job names; `undefined` for any other job or state. */
export function snapshotResult(job: Job | undefined): SnapshotResult | undefined {
  if (job?.kind !== SNAPSHOT_JOB || job.state !== 'done') return undefined
  const result = job.result
  if (typeof result !== 'object' || result === null) return undefined
  const { snapshot, files, bytes } = result as Record<string, unknown>
  if (typeof snapshot !== 'string' || !SNAPSHOT_ID.test(snapshot)) return undefined
  if (typeof files !== 'number' || typeof bytes !== 'number') return undefined
  return { snapshot, files, bytes }
}

/** The newest job of `kind` among `jobs` (the engine lists them newest first; this does not rely on it). */
export function latestJob(jobs: readonly Job[], kind: string): Job | undefined {
  let latest: Job | undefined
  for (const job of jobs)
    if (job.kind === kind && (!latest || Date.parse(job.startedAt) > Date.parse(latest.startedAt)))
      latest = job
  return latest
}

/**
 * The `suite.*` job running now, if any: the engine runs one at a time, so
 * while it runs every reset and download control waits ("A data job is
 * running: <its title>"), as the engine would answer `409 conflict` anyway.
 */
export function runningSuiteJob(jobs: readonly Job[]): Job | undefined {
  return jobs.find((job) => job.state === 'running' && job.kind.startsWith('suite.'))
}

/** A job the page just started, put where `useJob` and `useJobs('suite')` read it. */
function remember(client: QueryClient, job: Job): Job {
  client.setQueryData(jobKey(job.id), job)
  client.setQueryData<Job[]>(sectionJobsKey(job.section), (list) => mergeJob(list ?? [], job))
  return job
}

/**
 * `POST /overview/snapshots`: starts preparing a snapshot of `targets`
 * (`firestore`, `auth`, `storage`; every service this engine runs when
 * absent) and answers the `suite.snapshot` job at once. Refused before any
 * job starts when there is not enough free space (`failed-precondition`,
 * with both figures) or another data job runs (`conflict`).
 */
export async function prepareSnapshot(
  client: QueryClient,
  targets?: readonly string[],
): Promise<Job> {
  const body: OverviewSnapshotRequest = targets ? { targets: [...targets] } : {}
  return remember(client, await apiSend<Job>('POST', '/overview/snapshots', body))
}

/** Where the browser downloads a prepared snapshot from (the engine streams the zip once). */
export function snapshotDownloadUrl(id: string): string {
  return `${API_BASE}/overview/snapshots/${encodeURIComponent(id)}/download`
}

/**
 * Hands a prepared snapshot to the browser's own download manager: an
 * `<a download>` the engine streams into, nothing held in the page. The
 * engine serves it once, so the file query is dropped.
 */
export async function downloadSnapshot(
  client: QueryClient,
  project: string,
  id: string,
): Promise<void> {
  await download(snapshotDownloadUrl(id))
  client.removeQueries({ queryKey: overviewKeys.snapshot(project, id), exact: true })
}

/** `DELETE /overview/snapshots/{id}`: lets a prepared snapshot go before it expires. */
export async function discardSnapshot(
  client: QueryClient,
  project: string,
  id: string,
): Promise<void> {
  try {
    await apiSend<unknown>('DELETE', `/overview/snapshots/${encodeURIComponent(id)}`, {})
  } catch (error) {
    // Already gone is what was asked for.
    if (!(error instanceof ApiError && error.code === 'not-found')) throw error
  }
  client.removeQueries({ queryKey: overviewKeys.snapshot(project, id), exact: true })
}

/**
 * The page's snapshot: the newest `suite.snapshot` job the engine lists
 * (running, or finished in the last 10 minutes, so a reload or another tab
 * finds it), what it produced, and whether the engine still keeps that
 * file (`file.data`; a `not-found` error once it is gone).
 */
export function useSnapshot(project: string) {
  const jobs = useJobs('suite')
  const job = latestJob(jobs, SNAPSHOT_JOB)
  const result = snapshotResult(job)
  const file = useQuery({
    ...snapshotFileQuery(project, result?.snapshot ?? ''),
    enabled: result !== undefined && project !== '',
  })
  return { jobs, job, result, file, running: runningSuiteJob(jobs) }
}

/** `POST /suite/clear`'s body: the sections, the project id when more than one, triggers on request. */
export interface ClearRequest {
  sections: readonly string[]
  /** The project id, exactly; needed when more than one section is named. */
  confirm?: string
  /** Run Functions triggers for what is removed (Firestore's reset offers it). */
  runTriggers?: boolean
}

/**
 * `POST /suite/clear`: one `suite.clear` job removing every named section's
 * data, in sidebar order; the dialog follows it by id (`DangerConfirm`'s
 * `jobId`) and every tab toasts its end (`JobsWatch`).
 */
export async function startClear(client: QueryClient, request: ClearRequest): Promise<Job> {
  const body = {
    sections: [...request.sections],
    ...(request.confirm === undefined ? {} : { confirm: request.confirm }),
    ...(request.runTriggers ? { runTriggers: true } : {}),
  }
  return remember(client, await apiSend<Job>('POST', '/suite/clear', body))
}
