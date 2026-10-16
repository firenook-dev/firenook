// The Functions section's conversation with the engine: every route of
// `/console/api/v1/functions` (compute spec §7.3), the query keys they are
// cached under, and the query options the pages read them through.
//
// Keys are `['functions', project, kind, …]` (foundation §4.4), so the
// section's live topic (`./live.ts`) refreshes them by prefix and nothing
// else does. What carries a `liveCursor` — the snapshot, the first page of
// invocations, a codebase's load log — is kept until the topic says it
// changed (`staleTime: Infinity`): its cursor and its state were read in one
// lock, so a page subscribes `after` that cursor and misses nothing.
//
// The calls that stream an invocation's answer (Invoke, a test event, a
// replay) are in `./invoke-stream.ts`.

import { queryOptions } from '@tanstack/react-query'
import { API_BASE, apiGet, apiSend } from '@/api/client'
import type { FunctionDetail } from '@/api/generated/compute/FunctionDetail'
import type { FunctionEnvEditRequest } from '@/api/generated/compute/FunctionEnvEditRequest'
import type { FunctionEnvEditResult } from '@/api/generated/compute/FunctionEnvEditResult'
import type { FunctionLoadLog } from '@/api/generated/compute/FunctionLoadLog'
import type { FunctionMatchRequest } from '@/api/generated/compute/FunctionMatchRequest'
import type { FunctionMatchResult } from '@/api/generated/compute/FunctionMatchResult'
import type { FunctionRestartResult } from '@/api/generated/compute/FunctionRestartResult'
import type { FunctionRevealedValue } from '@/api/generated/compute/FunctionRevealedValue'
import type { FunctionsSnapshot } from '@/api/generated/compute/FunctionsSnapshot'
import type { InvocationView } from '@/api/generated/compute/InvocationView'
import type { InvocationsResult } from '@/api/generated/compute/InvocationsResult'

/** The engine keeps this many finished invocations (`MonitorLimits.invocations`). */
export const INVOCATIONS_KEPT = 2_000

/** Invocations per page: the engine's default and the list's step. */
export const INVOCATION_PAGE = 200

const enc = encodeURIComponent

/** Every query key of the section, by what it holds. */
export const functionKeys = {
  /** Everything of the section: what a `reset` invalidates. */
  all: (project: string) => ['functions', project] as const,
  /** `GET /functions`: every function, codebase and figure the section draws on arrival. */
  snapshot: (project: string) => ['functions', project, 'snapshot'] as const,
  /** Every function's detail: what a reload of their codebase invalidates. */
  details: (project: string) => ['functions', project, 'detail'] as const,
  detail: (project: string, id: string) => ['functions', project, 'detail', id] as const,
  /** Every list of invocations, whatever its filter. */
  invocations: (project: string) => ['functions', project, 'invocations'] as const,
  /** The newest page of invocations matching `q` (`''` for all), with the cursor its feed resumes from. */
  invocationPage: (project: string, q: string) => ['functions', project, 'invocations', q] as const,
  invocation: (project: string, id: string) => ['functions', project, 'invocation', id] as const,
  /** Every explanation of who fires and why not: what a reload invalidates. */
  match: (project: string) => ['functions', project, 'match'] as const,
  matchOf: (project: string, request: FunctionMatchRequest) =>
    ['functions', project, 'match', request] as const,
  /** Who fires for a resource (`lib/triggers.ts`'s key, which every section's chip shares). */
  triggers: (project: string) => ['functions', project, 'triggers'] as const,
  codebaseLog: (project: string, codebase: string) =>
    ['functions', project, 'codebase-log', codebase] as const,
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** Every function by codebase, their figures, and where `functions.events` resumes for them. */
export function getFunctions(signal?: AbortSignal): Promise<FunctionsSnapshot> {
  return apiGet<FunctionsSnapshot>('/functions', undefined, signal)
}

/** One function: its keys, environment, params, declared options and kind's facts. */
export function getFunction(id: string, signal?: AbortSignal): Promise<FunctionDetail> {
  return apiGet<FunctionDetail>(`/functions/${enc(id)}`, undefined, signal)
}

/**
 * A page of invocations, newest first, filtered by `q` in the invocation
 * grammar. The first page (no `cursor`) carries the `liveCursor` the feed
 * subscribes after; `page.nextCursor` asks for the older ones.
 */
export function getInvocations(
  options: { q?: string | undefined; cursor?: string | undefined; limit?: number | undefined },
  signal?: AbortSignal,
): Promise<InvocationsResult> {
  return apiGet<InvocationsResult>(
    '/functions/invocations',
    {
      q: options.q === '' ? undefined : options.q,
      cursor: options.cursor,
      limit: options.limit,
    },
    signal,
  )
}

/** One invocation and what it points at in other sections; `not-found` once it is no longer kept. */
export function getInvocation(id: string, signal?: AbortSignal): Promise<InvocationView> {
  return apiGet<InvocationView>(`/functions/invocations/${enc(id)}`, undefined, signal)
}

/** A codebase's load log (the last 200 lines the Monitor keeps) and where `functions.codebase-log` resumes. */
export function getCodebaseLog(codebase: string, signal?: AbortSignal): Promise<FunctionLoadLog> {
  return apiGet<FunctionLoadLog>(`/functions/codebases/${enc(codebase)}/log`, undefined, signal)
}

/**
 * The value of a sensitive header an invocation was called with, read in
 * the engine when asked. Never cached: `MaskedValue` holds it while shown.
 */
export async function revealHeader(
  invocation: string,
  name: string,
  signal?: AbortSignal,
): Promise<string> {
  const revealed = await apiGet<FunctionRevealedValue>(
    `/functions/invocations/${enc(invocation)}/headers/${enc(name)}`,
    undefined,
    signal,
  )
  return revealed.value
}

/** A `.secret.local` value of a codebase, read from the file when asked. Never cached. */
export async function revealSecret(
  codebase: string,
  key: string,
  signal?: AbortSignal,
): Promise<string> {
  const revealed = await apiGet<FunctionRevealedValue>(
    `/functions/codebases/${enc(codebase)}/secrets/${enc(key)}`,
    undefined,
    signal,
  )
  return revealed.value
}

/**
 * Where an invocation's recorded request or response body downloads from:
 * the bytes as kept, with their content type, as an attachment (a link,
 * `lib/download.ts`; nothing is held in memory).
 */
export function invocationBodyUrl(invocation: string, part: 'request' | 'response'): string {
  return `${API_BASE}/functions/invocations/${enc(invocation)}/body/${part}`
}

/** Per function, whether it fires for a document, an object, a topic… and why not (the Trigger tab, the publish preview). */
export function matchTriggers(
  request: FunctionMatchRequest,
  signal?: AbortSignal,
): Promise<FunctionMatchResult> {
  return apiSend<FunctionMatchResult>(
    'POST',
    '/functions/match',
    request,
    signal === undefined ? undefined : { signal },
  )
}

// ── Query options ─────────────────────────────────────────────────────────

/** The snapshot, kept current by `functions.events` (patched and invalidated, never polled). */
export const functionsSnapshotQuery = (project: string) =>
  queryOptions({
    queryKey: functionKeys.snapshot(project),
    queryFn: ({ signal }) => getFunctions(signal),
    staleTime: Number.POSITIVE_INFINITY,
  })

/** One function's detail; a reload of its codebase invalidates it. */
export const functionDetailQuery = (project: string, id: string) =>
  queryOptions({
    queryKey: functionKeys.detail(project, id),
    queryFn: ({ signal }) => getFunction(id, signal),
    staleTime: Number.POSITIVE_INFINITY,
  })

/** The newest invocations matching `q`, and the cursor their feed resumes from. */
export const invocationPageQuery = (project: string, q: string) =>
  queryOptions({
    queryKey: functionKeys.invocationPage(project, q),
    queryFn: ({ signal }) => getInvocations({ q, limit: INVOCATION_PAGE }, signal),
    staleTime: Number.POSITIVE_INFINITY,
  })

/**
 * One invocation. A finished one changes only by a line printed after it
 * returned, so it is read again when reopened; a running one is followed
 * on `functions.invocation`.
 */
export const invocationQuery = (project: string, id: string) =>
  queryOptions({
    queryKey: functionKeys.invocation(project, id),
    queryFn: ({ signal }) => getInvocation(id, signal),
    retry: false,
  })

/** A codebase's load log, followed after its cursor on `functions.codebase-log`. */
export const codebaseLogQuery = (project: string, codebase: string) =>
  queryOptions({
    queryKey: functionKeys.codebaseLog(project, codebase),
    queryFn: ({ signal }) => getCodebaseLog(codebase, signal),
    staleTime: Number.POSITIVE_INFINITY,
  })

/** An explanation of who fires for a change; a reload invalidates every one. */
export const matchQuery = (project: string, request: FunctionMatchRequest) =>
  queryOptions({
    queryKey: functionKeys.matchOf(project, request),
    queryFn: ({ signal }) => matchTriggers(request, signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

// ── Changes ───────────────────────────────────────────────────────────────

/**
 * Writes `.env*` / `.secret.local` changes for a user codebase and reloads
 * it; a reload that fails puts every file back and answers `conflict` with
 * the load error.
 */
export function editEnv(
  codebase: string,
  request: FunctionEnvEditRequest,
): Promise<FunctionEnvEditResult> {
  return apiSend<FunctionEnvEditResult>(
    'POST',
    `/functions/codebases/${enc(codebase)}/edit-env`,
    request,
  )
}

/** Re-runs discovery for a codebase (and picks up `.env` edits); progress arrives on `functions.events`. */
export async function reloadCodebase(codebase: string): Promise<void> {
  await apiSend<unknown>('POST', `/functions/codebases/${enc(codebase)}/reload`, {})
}

/** Stops and starts a codebase's worker; answers how many calls in flight it dropped. */
export function restartWorker(codebase: string): Promise<FunctionRestartResult> {
  return apiSend<FunctionRestartResult>('POST', `/functions/codebases/${enc(codebase)}/restart`, {})
}

/** Empties the engine's record of invocations; function stats reset with it. */
export async function clearInvocations(): Promise<void> {
  await apiSend<undefined>('DELETE', '/functions/invocations', {})
}
