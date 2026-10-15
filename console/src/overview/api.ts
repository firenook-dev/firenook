// The Overview's server data: the engine's `overview` state (notices,
// recent problems, the last hour, the log's totals), how the engine was
// started, and the data jobs the page starts (a snapshot to download or to
// save on the engine's machine, a reset). Section figures are not here:
// they are each section's `SectionStatus.summary`, on the `shell` topic.
//
// Nothing polls. The state is replaced by the `overview` topic while the
// page is mounted; the engine details are fixed for an engine run; a job
// moves on the foundation's `jobs` topic (`useJobs('suite')`).
//
// The route's loader reads `queries.ts` alone (it is in the first route's
// bundle); this file is the page's.

import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import { API_BASE, ApiError, apiGet, apiSend } from '@/api/client'
import type { ExportDestination } from '@/api/generated/ExportDestination'
import type { Job } from '@/api/generated/Job'
import type { OverviewSnapshotRequest } from '@/api/generated/observe/OverviewSnapshotRequest'
import { download } from '@/lib/download'
import { jobKey, mergeJob, sectionJobsKey, useJobs } from '@/lib/jobs'
import type { LiveChannel, SubscriptionStatus } from '@/lib/live/channel'
import { liveChannel } from '@/lib/live/channel'
import { useLiveTopic } from '@/lib/live/use-live-topic'
import { useConsoleProject } from '@/lib/project'
import '@/observe/live'
import { overviewKeys, overviewQuery, snapshotFileQuery } from './queries'

export { engineQuery, overviewKeys, overviewQuery, snapshotFileQuery } from './queries'

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

/**
 * `GET /suite/destinations`: the folders on the engine's machine a snapshot
 * may be saved to, each with why the engine refuses it now, when it does.
 * Read when the save dialog opens.
 */
export const destinationsQuery = {
  queryKey: ['suite', 'destinations'] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    apiGet<ExportDestination[]>('/suite/destinations', undefined, signal),
}

/** The job kind a snapshot is prepared as. */
export const SNAPSHOT_JOB = 'suite.snapshot'

/** The job kind a snapshot is saved on the engine's machine as. */
export const EXPORT_JOB = 'suite.export'

/** The job kind a reset runs as. */
export const CLEAR_JOB = 'suite.clear'

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

/**
 * The later of two states of one job. The `jobs` topic can deliver a short
 * job's end before the request that started it has answered, and the
 * answer (still `running`) must not put the job back to running for good.
 */
export function laterJob(known: Job | undefined, answer: Job): Job {
  if (!known || known.id !== answer.id) return answer
  if (known.state !== 'running' && answer.state === 'running') return known
  if (known.state === answer.state && known.done > answer.done) return known
  return answer
}

/** A job the page just started, put where `useJob` and `useJobs('suite')` read it. */
function remember(client: QueryClient, job: Job): Job {
  const known =
    client.getQueryData<Job>(jobKey(job.id)) ??
    client.getQueryData<Job[]>(sectionJobsKey(job.section))?.find((entry) => entry.id === job.id)
  const later = laterJob(known, job)
  client.setQueryData(jobKey(job.id), later)
  client.setQueryData<Job[]>(sectionJobsKey(job.section), (list) => mergeJob(list ?? [], later))
  return later
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

const NONE: ReadonlySet<string> = new Set()

/**
 * The page's snapshot: the newest `suite.snapshot` job the engine lists
 * (running, or finished in the last 10 minutes, so a reload or another tab
 * finds it), what it produced, and whether the engine still keeps that
 * file (`file.data`; a `not-found` error once it is gone). A snapshot this
 * tab has downloaded (`downloaded`, by snapshot id) is not asked about
 * again: the engine serves the file once.
 */
export function useSnapshot(project: string, downloaded: ReadonlySet<string> = NONE) {
  const jobs = useJobs('suite')
  const job = latestJob(jobs, SNAPSHOT_JOB)
  const result = snapshotResult(job)
  const file = useQuery({
    ...snapshotFileQuery(project, result?.snapshot ?? ''),
    enabled: result !== undefined && project !== '' && !downloaded.has(result.snapshot),
  })
  return { jobs, job, result, file, running: runningSuiteJob(jobs) }
}

/** `POST /suite/export`'s body: a destination the engine lists, the services (all when absent), and a yes to replace. */
export interface SaveRequest {
  destination: string
  targets?: readonly string[]
  overwrite?: boolean
}

/**
 * `POST /suite/export`: starts saving a snapshot on the engine's machine
 * and answers the `suite.export` job at once; its result names the folder
 * written. Refused before any job starts when the folder already holds
 * files (`already-exists`, until `overwrite`) or another data job runs
 * (`conflict`).
 */
export async function saveSnapshot(client: QueryClient, request: SaveRequest): Promise<Job> {
  const body = {
    destination: request.destination,
    ...(request.targets ? { targets: [...request.targets] } : {}),
    ...(request.overwrite ? { overwrite: true } : {}),
  }
  return remember(client, await apiSend<Job>('POST', '/suite/export', body))
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
