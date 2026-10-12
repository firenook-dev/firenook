// Builders for the Functions section's unit tests: a function, a codebase,
// a snapshot and an invocation in the engine's shapes, with every field a
// test does not name set to a quiet default. Test-only.

import type { FunctionCodebaseEntry } from '@/api/generated/compute/FunctionCodebaseEntry'
import type { FunctionDetail } from '@/api/generated/compute/FunctionDetail'
import type { FunctionKind } from '@/api/generated/compute/FunctionKind'
import type { FunctionsSnapshot } from '@/api/generated/compute/FunctionsSnapshot'
import type { FunctionSummary } from '@/api/generated/compute/FunctionSummary'
import type { FunctionTrigger } from '@/api/generated/compute/FunctionTrigger'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'

export const PROJECT = 'demo-test'

export function trigger(fields: Partial<FunctionTrigger> = {}): FunctionTrigger {
  return {
    eventType: null,
    resource: null,
    database: null,
    document: null,
    matchType: null,
    bucket: null,
    topic: null,
    channel: null,
    filters: {},
    pathPatterns: {},
    schedule: null,
    timeZone: null,
    blockingEvent: null,
    invoker: [],
    retry: null,
    ...fields,
  }
}

export function summary(
  name: string,
  kind: FunctionKind = 'http',
  fields: Partial<FunctionSummary> = {},
): FunctionSummary {
  const id = `us-central1-${name}`
  return {
    id,
    name,
    entryPoint: name,
    region: 'us-central1',
    platform: 'gcfv2',
    codebase: 'default',
    extensionInstance: null,
    extension: null,
    kind,
    trigger: trigger(),
    status: 'receiving',
    statusReason: null,
    service: null,
    url:
      kind === 'http' || kind === 'callable' || kind === 'blocking'
        ? `http://127.0.0.1:5001/${PROJECT}/us-central1/${name}`
        : null,
    timeoutSeconds: 60,
    secrets: [],
    stats: { runs: 0, failures: 0, inFlight: 0, last: null, p50Ms: null, p95Ms: null },
    ...fields,
  }
}

export function codebase(
  id: string,
  fields: Partial<FunctionCodebaseEntry['codebase']> = {},
): FunctionCodebaseEntry {
  return {
    instance: null,
    codebase: {
      id,
      kind: 'user',
      directory: id,
      runtime: 'nodejs22',
      state: 'ready',
      servingPrevious: false,
      error: null,
      loads: 1,
      loadedAt: '2026-10-12T06:00:00.000Z',
      loadMs: 410,
      loadingSince: null,
      functionCount: 0,
      notLoaded: [],
      envFiles: ['.env'],
      lastChange: { added: [], removed: [], changed: [] },
      stale: null,
      worker: {
        state: 'running',
        pid: 4242,
        node: '22.11.0',
        startedAt: '2026-10-12T06:00:01.000Z',
        startMs: 200,
        restarts: 0,
        lastExit: null,
        exitedAt: null,
        inspectPort: null,
        inFlight: 0,
      },
      ...fields,
    },
  }
}

export function snapshot(
  functions: readonly FunctionSummary[],
  codebases: readonly FunctionCodebaseEntry[] = [
    codebase('default', { functionCount: functions.length }),
  ],
): FunctionsSnapshot {
  return {
    phase: 'running',
    projectId: PROJECT,
    address: 'http://127.0.0.1:5001',
    debugging: false,
    codebases: [...codebases],
    functions: [...functions],
    liveCursor: 'c-1',
  }
}

export function invocation(
  seq: number,
  fields: Partial<InvocationSummary> = {},
): InvocationSummary {
  return {
    id: `a3f9c1-${seq}`,
    seq,
    functionId: 'us-central1-api',
    codebase: 'default',
    kind: 'http',
    origin: 'console',
    cause: { type: 'http', method: 'GET', path: '/hello' },
    summary: 'GET /hello',
    startedAt: '2026-10-12T06:02:11.284Z',
    durationMs: 2.6,
    outcome: 'succeeded',
    outcomeClass: 'succeeded',
    status: 200,
    callableStatus: null,
    cold: false,
    attempt: 1,
    eventId: null,
    replayOf: null,
    logCount: 1,
    error: null,
    ...fields,
  }
}

export function detail(of: FunctionSummary, fields: Partial<FunctionDetail> = {}): FunctionDetail {
  return {
    summary: of,
    keys: [{ key: of.id, generation: null, enabled: true, stale: false }],
    environment: { files: ['.env'], variables: [], inherited: 12, editable: true },
    params: [],
    declared: [],
    schedule: null,
    taskQueue: null,
    blocking: null,
    definition: { name: of.name },
    ...fields,
  }
}
