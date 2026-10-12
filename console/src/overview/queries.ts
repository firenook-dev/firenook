// The Overview's queries: its keys and what each reads. The route's loader
// imports this file, and route loaders are in the first route's bundle, so
// it holds query options alone; the topic, the jobs and the downloads are
// in `api.ts`, which only the page's own chunk loads.

import { queryOptions } from '@tanstack/react-query'
import { apiGet } from '@/api/client'
import type { MemoryReport } from '@/api/generated/MemoryReport'
import type { OverviewEngineDetails } from '@/api/generated/observe/OverviewEngineDetails'
import type { OverviewSnapshotFile } from '@/api/generated/observe/OverviewSnapshotFile'
import type { OverviewState } from '@/api/generated/observe/OverviewState'

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
