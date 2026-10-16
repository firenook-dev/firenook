import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The hooks hold their topics through `useLiveTopic`; it is stood in for so
// what each event refreshes is what is tested. The channel itself has its
// own tests, and the journeys run the real one.
const live = vi.hoisted(() => ({
  status: 'live' as string,
  topics: [] as Array<{ topic: string; params: unknown; handlers: Record<string, unknown> }>,
}))

vi.mock('@/lib/live/use-live-topic', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/live/use-live-topic')>()),
  useLiveTopic: (topic: string, params: unknown, handlers: Record<string, unknown>) => {
    live.topics.push({ topic, params, handlers })
    return live.status
  },
}))

const { useStorageDecisionsLive, useStorageObjectsLive, useStorageRulesLive } =
  await import('./live')
const { storageKeys } = await import('./queries')

/** The handler the hook gave its topic last. */
function handler(topic: string, name: string): (...args: unknown[]) => void {
  const subscription = live.topics.findLast((item) => item.topic === topic)
  if (!subscription) throw new Error(`nothing subscribed to ${topic}`)
  return subscription.handlers[name] as (...args: unknown[]) => void
}

let client: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)

beforeEach(() => {
  client = new QueryClient()
  live.topics = []
  live.status = 'live'
})
afterEach(() => vi.useRealTimers())

const changed = (names: string[]) => ({
  revision: 3,
  changes: names.map((name) => ({ name, kind: 'metadata' })),
  folders: [],
  truncated: false,
  indexReady: false,
})

describe('storage.objects', () => {
  it('subscribes for the bucket, refreshes the keys a window names and hands it to the lists', () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const onChanged = vi.fn()
    renderHook(() => useStorageObjectsLive('demo', 'b', { onChanged }), { wrapper })
    expect(live.topics.at(-1)).toMatchObject({ topic: 'storage.objects', params: { bucket: 'b' } })
    const batch = changed(['users/a.png'])
    act(() => handler('storage.objects', 'onChanged')(batch))
    expect(onChanged).toHaveBeenCalledWith(batch)
    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey))
    expect(keys).toContain(
      JSON.stringify(storageKeys.object('demo', 'b', 'users/a.png', 'x').slice(0, 5)),
    )
    expect(keys).toContain(JSON.stringify(storageKeys.folder('demo', 'b', 'users/')))
  })

  it('holds nothing without a bucket', () => {
    renderHook(() => useStorageObjectsLive('demo', undefined), { wrapper })
    expect(live.topics.at(-1)?.params).toBeNull()
  })

  it('starts every query of the bucket again on a reset', () => {
    const reset = vi.spyOn(client, 'resetQueries')
    const onReset = vi.fn()
    renderHook(() => useStorageObjectsLive('demo', 'b', { onReset }), { wrapper })
    act(() => handler('storage.objects', 'onReset')('gap', 12))
    expect(reset).toHaveBeenCalledWith({ queryKey: storageKeys.bucket('demo', 'b') })
    expect(onReset).toHaveBeenCalledWith('gap', 12)
  })

  it('reads the buckets again once live when it read counts still being made', () => {
    client.setQueryData(storageKeys.buckets('demo'), {
      defaultBucket: 'b',
      rulesMode: 'single',
      buckets: [],
      indexReady: false,
    })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    renderHook(() => useStorageObjectsLive('demo', 'b'), { wrapper })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: storageKeys.buckets('demo') })
  })
})

describe('storage.rules', () => {
  it('reads the rules again only when the hash moved, and the history, coverage and buckets always', () => {
    client.setQueryData(storageKeys.rules('demo', '*'), { hash: 'h1', fileProblems: [] })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    renderHook(() => useStorageRulesLive('demo', '*'), { wrapper })
    expect(live.topics.at(-1)).toMatchObject({ topic: 'storage.rules', params: {} })
    act(() => handler('storage.rules', 'onRules')({ bucket: null, hash: 'h1', origin: 'console' }))
    const keys = () => invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey))
    expect(keys()).not.toContain(JSON.stringify(storageKeys.rules('demo', '*')))
    expect(keys()).toContain(JSON.stringify(storageKeys.rulesHistory('demo', '*')))
    expect(keys()).toContain(JSON.stringify(storageKeys.rulesCoverage('demo', '*')))
    expect(keys()).toContain(JSON.stringify(storageKeys.buckets('demo')))
    act(() => handler('storage.rules', 'onRules')({ bucket: null, hash: 'h2', origin: 'file' }))
    expect(keys()).toContain(JSON.stringify(storageKeys.rules('demo', '*')))
  })

  it('follows one bucket in per-bucket mode, and reads its file only when its problems differ', () => {
    client.setQueryData(storageKeys.rules('demo', 'media'), { hash: 'h', fileProblems: [] })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    renderHook(() => useStorageRulesLive('demo', 'media'), { wrapper })
    expect(live.topics.at(-1)?.params).toEqual({ bucket: 'media' })
    act(() => handler('storage.rules', 'onFile')({ bucket: 'media', problems: [] }))
    expect(invalidate).not.toHaveBeenCalled()
    act(() =>
      handler(
        'storage.rules',
        'onFile',
      )({
        bucket: 'media',
        problems: [
          { severity: 'error', message: 'x', line: 1, column: 1, from: 0, to: 0, code: null },
        ],
      }),
    )
    expect(invalidate).toHaveBeenCalledWith({ queryKey: storageKeys.rules('demo', 'media') })
  })
})

describe('storage.decisions', () => {
  it('feeds each batch, reads coverage at most once a second and marks impact stale', () => {
    vi.useFakeTimers()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const onDecisions = vi.fn()
    renderHook(() => useStorageDecisionsLive('demo', '*', { denied: true }, { onDecisions }), {
      wrapper,
    })
    expect(live.topics.at(-1)).toMatchObject({
      topic: 'storage.decisions',
      params: { denied: true },
    })
    const batch = {
      items: [{ id: 's1' }],
      window: { retained: 1, since: null, reRunnable: 1, omitted: 0 },
    }
    const coverage = () =>
      invalidate.mock.calls.filter(
        ([filters]) =>
          JSON.stringify(filters?.queryKey) ===
          JSON.stringify(storageKeys.rulesCoverage('demo', '*')),
      ).length
    act(() => {
      // Ten batches inside one second.
      for (let index = 0; index < 10; index += 1) {
        handler('storage.decisions', 'onDecisions')(batch)
        if (index < 9) vi.advanceTimersByTime(100)
      }
    })
    expect(onDecisions).toHaveBeenCalledTimes(10)
    // Once at once, once when the second ends, then quiet.
    expect(coverage()).toBe(1)
    act(() => vi.advanceTimersByTime(200))
    expect(coverage()).toBe(2)
    act(() => vi.advanceTimersByTime(3_000))
    expect(coverage()).toBe(2)
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: storageKeys.rulesImpactOf('demo', '*'),
      refetchType: 'none',
    })
  })

  it('holds nothing while diagnostics are off', () => {
    renderHook(() => useStorageDecisionsLive('demo', '*', null, { onDecisions: () => {} }), {
      wrapper,
    })
    expect(live.topics.at(-1)?.params).toBeNull()
  })
})
