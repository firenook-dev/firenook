// The Extensions section's conversation with the engine: every route of
// `/console/api/v1/extensions` (compute spec §7.4), the keys they are cached
// under, and the query options the pages read them through. Keys are
// `['extensions', project, …]`, refreshed by `extensions.changes`
// (`./live.ts`) and by a reload of the instance's codebase in Functions.

import { queryOptions } from '@tanstack/react-query'
import { API_BASE, ApiError, apiGet, apiSend, parseErrorBody } from '@/api/client'
import type { ExtensionInstanceDetail } from '@/api/generated/compute/ExtensionInstanceDetail'
import type { ExtensionParamProblem } from '@/api/generated/compute/ExtensionParamProblem'
import type { ExtensionReconfigureRequest } from '@/api/generated/compute/ExtensionReconfigureRequest'
import type { ExtensionReconfigureResult } from '@/api/generated/compute/ExtensionReconfigureResult'
import type { ExtensionRevealedValue } from '@/api/generated/compute/ExtensionRevealedValue'
import type { ExtensionVendorResult } from '@/api/generated/compute/ExtensionVendorResult'
import type { ExtensionsSnapshot } from '@/api/generated/compute/ExtensionsSnapshot'

const enc = encodeURIComponent

/** Every query key of the section. */
export const extensionKeys = {
  all: (project: string) => ['extensions', project] as const,
  /** `GET /extensions/instances`: every instance, the dropped ones, the emulated APIs. */
  instances: (project: string) => ['extensions', project, 'instances'] as const,
  instance: (project: string, id: string) => ['extensions', project, 'instance', id] as const,
}

/** Every instance with its source and state, the instances left out, whether the suite is offline. */
export function getInstances(signal?: AbortSignal): Promise<ExtensionsSnapshot> {
  return apiGet<ExtensionsSnapshot>('/extensions/instances', undefined, signal)
}

/** One instance: its params with the file each value came from, functions, APIs, events, docs. */
export function getInstance(id: string, signal?: AbortSignal): Promise<ExtensionInstanceDetail> {
  return apiGet<ExtensionInstanceDetail>(`/extensions/instances/${enc(id)}`, undefined, signal)
}

/** A secret param's value, read from `extensions/<id>.secret.local` when asked. Never cached. */
export async function revealParam(
  id: string,
  param: string,
  signal?: AbortSignal,
): Promise<string> {
  const revealed = await apiGet<ExtensionRevealedValue>(
    `/extensions/instances/${enc(id)}/secrets/${enc(param)}`,
    undefined,
    signal,
  )
  return revealed.value
}

export const instancesQuery = (project: string) =>
  queryOptions({
    queryKey: extensionKeys.instances(project),
    queryFn: ({ signal }) => getInstances(signal),
    staleTime: Number.POSITIVE_INFINITY,
  })

export const instanceQuery = (project: string, id: string) =>
  queryOptions({
    queryKey: extensionKeys.instance(project, id),
    queryFn: ({ signal }) => getInstance(id, signal),
    staleTime: Number.POSITIVE_INFINITY,
  })

/**
 * The engine refused a reconfigure because of the values: every
 * unacceptable one at once, as `problems` beside the error.
 */
export class ReconfigureRefused extends ApiError {
  readonly problems: readonly ExtensionParamProblem[]

  constructor(error: ApiError, problems: readonly ExtensionParamProblem[]) {
    super(error.status, error.message, error.code, error.fix)
    this.name = 'ReconfigureRefused'
    this.problems = problems
  }
}

function problemsOf(body: unknown): ExtensionParamProblem[] {
  if (typeof body !== 'object' || body === null) return []
  const problems = (body as { problems?: unknown }).problems
  if (!Array.isArray(problems)) return []
  return problems.filter(
    (problem): problem is ExtensionParamProblem =>
      typeof problem === 'object' &&
      problem !== null &&
      typeof (problem as ExtensionParamProblem).param === 'string' &&
      typeof (problem as ExtensionParamProblem).message === 'string',
  )
}

/**
 * Writes the values to the file that set each one (secrets to
 * `extensions/<id>.secret.local`) and reloads the instance in place, once.
 * Unacceptable values are thrown as `ReconfigureRefused` with every
 * problem; values that do not load put every file back and answer
 * `conflict` with the load error.
 */
export async function reconfigureInstance(
  id: string,
  request: ExtensionReconfigureRequest,
  signal?: AbortSignal,
): Promise<ExtensionReconfigureResult> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}/extensions/instances/${enc(id)}/reconfigure`, {
      method: 'POST',
      signal: signal ?? null,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-firenook-console': '1',
      },
      body: JSON.stringify(request),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new ApiError(0, `The engine did not answer: ${reason}`, 'network')
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  if (response.ok) return body as ExtensionReconfigureResult
  const parsed = parseErrorBody(
    response.status,
    body,
    `${response.status} ${response.statusText}`.trim(),
  )
  const error = new ApiError(response.status, parsed.message, parsed.code, parsed.fix)
  const problems = problemsOf(body)
  throw problems.length > 0 ? new ReconfigureRefused(error, problems) : error
}

/** Loads the instance again from its source and parameter files; a failed load answers `conflict`. */
export function reloadInstance(id: string): Promise<ExtensionInstanceDetail> {
  return apiSend<ExtensionInstanceDetail>('POST', `/extensions/instances/${enc(id)}/reload`, {})
}

/**
 * Copies a registry extension's source into `extensions/.sources` (exactly
 * `firenook ext:vendor`) and reloads the instance from it.
 */
export function vendorInstance(id: string): Promise<ExtensionVendorResult> {
  return apiSend<ExtensionVendorResult>('POST', `/extensions/instances/${enc(id)}/vendor`, {})
}
