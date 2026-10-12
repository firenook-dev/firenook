import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FunctionCodebaseEntry } from '@/api/generated/compute/FunctionCodebaseEntry'
import type { FunctionStats } from '@/api/generated/compute/FunctionStats'
import type { FunctionSummary } from '@/api/generated/compute/FunctionSummary'
import type { FunctionsLiveBatch } from '@/api/generated/compute/FunctionsLiveBatch'
import type { FunctionsSnapshot } from '@/api/generated/compute/FunctionsSnapshot'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import type { InvocationView } from '@/api/generated/compute/InvocationView'
import type { TopicListener } from '@/lib/live/channel'
import { testStatus } from '@/test/status'

const fake = vi.hoisted(() => {
  const subscriptions: Array<{
    topic: string
    params: object
    listener: TopicListener
    after: string | undefined
    active: boolean
  }> = []
  return {
    subscriptions,
    active: () => subscriptions.filter((entry) => entry.active),
    channel: {
      subscribe(
        topic: string,
        params: object,
        listener: TopicListener,
        options?: { after?: string | undefined },
      ) {
        const entry = { topic, params, listener, after: options?.after, active: true }
        subscriptions.push(entry)
        return () => {
          entry.active = false
        }
      },
      onEngineRestart: () => () => {},
      retry: () => {},
    },
  }
})

const toasts = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('@/lib/live/channel', async (original) => ({
  ...(await original<typeof import('@/lib/live/channel')>()),
  liveChannel: fake.channel,
}))

vi.mock('@/lib/toasts', () => ({
  toast: (options: Record<string, unknown>) => toasts.push(options),
}))

const { useLiveStatus } = await import('@/lib/live/channel')
const { functionKeys } = await import('./api')
const {
  REPLAY_WINDOW_MS,
  applyBatch,
  applyBatchEffects,
  functionName,
  inventoryKeys,
  isCatchingUp,
  reloadToast,
  useCodebaseLog,
  useFunctionsEvents,
  useInvocationLive,
  withLines,
} = await import('./live')

const PROJECT = 'demo-console'

const stats = (runs: number, failures = 0): FunctionStats => ({
  runs,
  failures,
  inFlight: 0,
  last: null,
  p50Ms: 2,
  p95Ms: 9,
})

const fn = (id: string, codebase = 'default'): FunctionSummary => ({
  id,
  name: functionName(id),
  entryPoint: functionName(id),
  region: 'us-central1',
  platform: 'gcfv2',
  codebase,
  extensionInstance: codebase === 'greeter' ? 'greeter' : null,
  extension: null,
  kind: 'http',
  trigger: {
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
  },
  status: 'receiving',
  statusReason: null,
  service: null,
  url: null,
  timeoutSeconds: 60,
  secrets: [],
  stats: stats(0),
})

const codebase = (id: string, overrides: Partial<FunctionCodebaseEntry['codebase']> = {}) => ({
  codebase: {
    id,
    kind: id === 'greeter' ? ('extension' as const) : ('user' as const),
    directory: id,
    runtime: 'nodejs22',
    state: 'ready' as const,
    servingPrevious: false,
    error: null,
    loads: 1,
    loadedAt: '2026-10-12T06:00:00.000Z',
    loadMs: 412,
    loadingSince: null,
    functionCount: 1,
    notLoaded: [],
    envFiles: ['.env'],
    lastChange: null,
    stale: null,
    worker: {
      state: 'stopped' as const,
      pid: null,
      node: null,
      startedAt: null,
      startMs: null,
      restarts: 0,
      lastExit: null,
      exitedAt: null,
      inspectPort: null,
      inFlight: 0,
    },
    ...overrides,
  },
  instance: null,
})

const snapshot = (): FunctionsSnapshot => ({
  phase: 'running',
  projectId: PROJECT,
  address: 'http://127.0.0.1:5001',
  debugging: false,
  codebases: [codebase('default'), codebase('greeter')],
  functions: [
    fn('us-central1-api'),
    fn('us-central1-onOrder'),
    fn('us-central1-ext-greeter-greet', 'greeter'),
  ],
  liveCursor: 'f.10',
})

const batch = (overrides: Partial<FunctionsLiveBatch> = {}): FunctionsLiveBatch => ({
  items: [],
  changes: [],
  stats: [],
  burst: null,
  ...overrides,
})

const reloaded = (
  codebaseId: string,
  diff: Partial<{ added: string[]; removed: string[]; changed: string[] }> = {},
) => ({
  kind: 'inventory' as const,
  codebase: codebaseId,
  diff: { added: [], removed: [], changed: [], ...diff },
  loads: 2,
})

describe('what a window does to the snapshot', () => {
  it('replaces stats with the absolute figures, so a window applied twice changes nothing', () => {
    const before = snapshot()
    const window = batch({ stats: [{ functionId: 'us-central1-api', stats: stats(5, 1) }] })
    const once = applyBatch(before, window)
    expect(once.functions[0]?.stats).toEqual(stats(5, 1))
    expect(once.functions[1]).toBe(before.functions[1])
    expect(applyBatch(once, window)).toEqual(once)
  })

  it('replaces a codebase whole, appends a new one, and is the same object when nothing changed', () => {
    const before = snapshot()
    expect(
      applyBatch(before, batch({ stats: [{ functionId: 'us-central1-gone', stats: stats(1) }] })),
    ).toBe(before)
    const loading = codebase('default', {
      state: 'loading',
      loadingSince: '2026-10-12T06:01:00.000Z',
    })
    const after = applyBatch(
      before,
      batch({
        changes: [
          { kind: 'codebase', codebase: loading },
          { kind: 'codebase', codebase: codebase('jobs') },
        ],
      }),
    )
    expect(after.codebases.map((entry) => [entry.codebase.id, entry.codebase.state])).toEqual([
      ['default', 'loading'],
      ['greeter', 'ready'],
      ['jobs', 'ready'],
    ])
  })
})

describe('a completed load', () => {
  it('makes stale every detail of its codebase, the added and removed ones, matches, triggers and channels', () => {
    const keys = inventoryKeys(
      PROJECT,
      snapshot(),
      reloaded('default', { added: ['us-central1-new'] }),
    )
    expect(keys).toEqual([
      ['functions', PROJECT, 'snapshot'],
      ['functions', PROJECT, 'match'],
      ['functions', PROJECT, 'triggers'],
      ['eventarc', PROJECT, 'channels'],
      ['functions', PROJECT, 'detail', 'us-central1-new'],
      ['functions', PROJECT, 'detail', 'us-central1-api'],
      ['functions', PROJECT, 'detail', 'us-central1-onOrder'],
    ])
  })

  it("of an extension's codebase also makes its instance in Extensions stale", () => {
    const keys = inventoryKeys(PROJECT, snapshot(), reloaded('greeter'))
    expect(keys).toContainEqual(['extensions', PROJECT, 'instances'])
    expect(keys).toContainEqual(['extensions', PROJECT, 'instance', 'greeter'])
    expect(keys).toContainEqual(['functions', PROJECT, 'detail', 'us-central1-ext-greeter-greet'])
  })

  it('is toasted every time, by name, even when no function changed', () => {
    expect(reloadToast(reloaded('app'))).toEqual({
      key: 'functions.reload.app',
      title: 'app reloaded',
      description: 'No function changes.',
    })
    expect(
      reloadToast(
        reloaded('jobs', {
          added: ['us-central1-a', 'us-central1-b', 'europe-west1-c', 'us-central1-d'],
          changed: ['us-central1-api'],
        }),
      ).description,
    ).toBe('4 added (a, b, c and 1 more), 1 changed (api).')
  })

  it('is news only while the channel has been live for a moment', () => {
    expect(isCatchingUp({ status: 'live', since: 10_000 }, 10_000 + REPLAY_WINDOW_MS)).toBe(false)
    expect(isCatchingUp({ status: 'live', since: 10_000 }, 10_100)).toBe(true)
    expect(isCatchingUp({ status: 'reconnecting', since: 0 }, 60_000)).toBe(true)
  })
})

describe('applying a window to the cache', () => {
  let client: QueryClient

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    })
    toasts.length = 0
  })

  it('patches the snapshot, invalidates what a load changed and toasts it, marked when catching up', async () => {
    client.setQueryData(functionKeys.snapshot(PROJECT), snapshot())
    client.setQueryData(functionKeys.detail(PROJECT, 'us-central1-api'), { stale: false })
    const window = batch({
      changes: [reloaded('default')],
      stats: [{ functionId: 'us-central1-api', stats: stats(3) }],
    })
    const inventory = applyBatchEffects(client, PROJECT, window, {
      toasts: true,
      live: { status: 'live', since: 0 },
    })
    expect(inventory).toHaveLength(1)
    expect(
      client.getQueryData<FunctionsSnapshot>(functionKeys.snapshot(PROJECT))?.functions[0]?.stats
        .runs,
    ).toBe(3)
    expect(
      client.getQueryState(functionKeys.detail(PROJECT, 'us-central1-api'))?.isInvalidated,
    ).toBe(true)
    expect(toasts).toEqual([
      expect.objectContaining({
        key: 'functions.reload.default',
        title: 'default reloaded',
        replayed: false,
      }),
    ])
    applyBatchEffects(client, PROJECT, window, {
      toasts: true,
      live: { status: 'live', since: Date.now() },
    })
    expect(toasts.at(-1)).toMatchObject({ replayed: true })
  })

  it('raises nothing for a window of rows and stats alone', () => {
    applyBatchEffects(
      client,
      PROJECT,
      batch({ stats: [{ functionId: 'us-central1-api', stats: stats(1) }] }),
      {
        toasts: true,
        live: { status: 'live', since: 0 },
      },
    )
    expect(toasts).toEqual([])
  })
})

const row = (id: string): InvocationSummary => ({
  id,
  seq: 1,
  functionId: 'us-central1-api',
  codebase: 'default',
  kind: 'http',
  origin: 'client',
  cause: { type: 'http', method: 'GET', path: '/' },
  summary: 'GET /',
  startedAt: '2026-10-12T06:00:00.000Z',
  durationMs: 2,
  outcome: 'succeeded',
  outcomeClass: 'succeeded',
  status: 200,
  callableStatus: null,
  cold: false,
  attempt: 1,
  eventId: null,
  replayOf: null,
  logCount: 0,
  error: null,
})

const logLine = (index: number) => ({
  index,
  at: '2026-10-12T06:00:00.010Z',
  offsetMs: 10,
  level: 'info' as const,
  message: `line ${index}`,
  kind: null,
  fields: null,
  afterFinish: false,
})

describe('the hooks', () => {
  let client: QueryClient
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    })
    client.setQueryData(['status'], testStatus())
    fake.subscriptions.length = 0
    toasts.length = 0
    useLiveStatus.setState({ status: 'live', since: 0 })
  })

  it('subscribes after the snapshot cursor and hands the rows, the burst and the loads to the page', () => {
    client.setQueryData(functionKeys.snapshot(PROJECT), snapshot())
    const items: string[][] = []
    const bursts: number[] = []
    const loads: string[] = []
    renderHook(
      () =>
        useFunctionsEvents(
          { function: 'us-central1-api', q: 'outcome:failed' },
          {
            after: 'f.10',
            onItems: (rows) => items.push(rows.map((entry) => entry.id)),
            onBurst: (count) => bursts.push(count),
            onInventory: (change) => loads.push(change.codebase),
          },
        ),
      { wrapper },
    )
    expect(fake.active()).toEqual([
      expect.objectContaining({
        topic: 'functions.events',
        params: { function: 'us-central1-api', q: 'outcome:failed' },
        after: 'f.10',
      }),
    ])
    act(() =>
      fake.active()[0]?.listener.onEvent(
        'batch',
        batch({
          items: [row('a3f9c1-1'), row('a3f9c1-2')],
          burst: 1_840,
          changes: [reloaded('default')],
        }),
        'f.11',
      ),
    )
    expect(items).toEqual([['a3f9c1-1', 'a3f9c1-2']])
    expect(bursts).toEqual([1_840])
    expect(loads).toEqual(['default'])
    expect(toasts).toHaveLength(1)
  })

  it('reloads the section on a reset and tells the page', () => {
    client.setQueryData(functionKeys.snapshot(PROJECT), snapshot())
    const resets: Array<[string, number | null]> = []
    renderHook(
      () => useFunctionsEvents({}, { onReset: (reason, missed) => resets.push([reason, missed]) }),
      {
        wrapper,
      },
    )
    act(() => fake.active()[0]?.listener.onReset('gap', 312))
    expect(client.getQueryState(functionKeys.snapshot(PROJECT))?.isInvalidated).toBe(true)
    expect(resets).toEqual([['gap', 312]])
  })

  it('follows a running invocation in its cached view, each line once', () => {
    const view = {
      detail: { summary: row('a3f9c1-9'), logs: [] },
      refs: [],
    } as unknown as InvocationView
    const finished: string[] = []
    renderHook(
      () => useInvocationLive('a3f9c1-9', { onFinished: (summary) => finished.push(summary.id) }),
      {
        wrapper,
      },
    )
    const listener = fake.active()[0]?.listener
    expect(fake.active()[0]).toMatchObject({
      topic: 'functions.invocation',
      params: { id: 'a3f9c1-9' },
    })
    act(() => listener?.onEvent('snapshot', view, undefined))
    act(() => listener?.onEvent('log', [logLine(0), logLine(1)], undefined))
    act(() => listener?.onEvent('log', [logLine(1), logLine(2)], undefined))
    const key = functionKeys.invocation(PROJECT, 'a3f9c1-9')
    expect(
      client.getQueryData<InvocationView>(key)?.detail.logs.map((entry) => entry.index),
    ).toEqual([0, 1, 2])
    act(() => listener?.onEvent('finished', { ...row('a3f9c1-9'), durationMs: 40 }, undefined))
    expect(client.getQueryData<InvocationView>(key)?.detail.summary.durationMs).toBe(40)
    expect(finished).toEqual(['a3f9c1-9'])
  })

  it('subscribes to a codebase log after its cursor, and not without a codebase', () => {
    const lines: number[] = []
    const { rerender } = renderHook(
      ({ name }: { name: string | null }) =>
        useCodebaseLog(name, { after: 'f.20', onLines: (window) => lines.push(window.length) }),
      { wrapper, initialProps: { name: null as string | null } },
    )
    expect(fake.subscriptions).toEqual([])
    rerender({ name: 'app' })
    expect(fake.active()).toEqual([
      expect.objectContaining({
        topic: 'functions.codebase-log',
        params: { codebase: 'app' },
        after: 'f.20',
      }),
    ])
    act(() => fake.active()[0]?.listener.onEvent('lines', { items: [] }, 'f.21'))
    expect(lines).toEqual([])
  })
})

describe('lines of a view', () => {
  it('append in order and never twice', () => {
    const view = { detail: { logs: [{ index: 0 }] }, refs: [] } as unknown as InvocationView
    expect(withLines(view, [{ index: 0 }] as never)).toBe(view)
    expect(withLines(view, [{ index: 0 }, { index: 1 }] as never).detail.logs).toHaveLength(2)
  })
})
