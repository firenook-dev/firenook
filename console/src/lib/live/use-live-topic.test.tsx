import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangeBatch } from '@/api/generated/ChangeBatch'
import type { LiveChannel, TopicListener } from './channel'
import { createInvalidator, useInvalidateOn, useLiveTopic } from './use-live-topic'

/** A channel that records subscriptions and lets a test speak for the engine. */
function fakeChannel() {
  const subscriptions: Array<{
    topic: string
    params: object
    listener: TopicListener
    active: boolean
  }> = []
  const channel: LiveChannel = {
    subscribe(topic, params, listener) {
      const entry = { topic, params, listener, active: true }
      subscriptions.push(entry)
      return () => {
        entry.active = false
      }
    },
    onEngineRestart: () => () => {},
    retry: () => {},
  }
  const active = () => subscriptions.filter((entry) => entry.active)
  return { channel, subscriptions, active }
}

const batch: ChangeBatch = { revision: 1, commitTime: '2026-10-12T00:00:00Z', changes: [] }

let client: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)

beforeEach(() => {
  client = new QueryClient()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useLiveTopic', () => {
  it('reads its handlers through a ref, so a re-render does not subscribe again', () => {
    const fake = fakeChannel()
    const seen: string[] = []
    const { rerender } = renderHook(
      ({ tag }: { tag: string }) =>
        useLiveTopic(
          'firestore.changes',
          { database: '(default)' },
          { onChange: () => seen.push(tag) },
          fake.channel,
        ),
      { initialProps: { tag: 'first' }, wrapper },
    )
    rerender({ tag: 'second' })
    expect(fake.subscriptions).toHaveLength(1)
    act(() => fake.active()[0]?.listener.onEvent('change', batch, 'e.1'))
    expect(seen).toEqual(['second'])
  })

  it('subscribes again when the parameters change by value, and not at all for null', () => {
    const fake = fakeChannel()
    const { rerender } = renderHook(
      ({ database }: { database: string | null }) =>
        useLiveTopic(
          'firestore.changes',
          database === null ? null : { database },
          {},
          fake.channel,
        ),
      { initialProps: { database: null as string | null }, wrapper },
    )
    expect(fake.subscriptions).toHaveLength(0)
    rerender({ database: '(default)' })
    rerender({ database: '(default)' })
    expect(fake.subscriptions).toHaveLength(1)
    rerender({ database: 'other' })
    expect(fake.subscriptions).toHaveLength(2)
    expect(fake.active().map((entry) => entry.params)).toEqual([{ database: 'other' }])
  })

  it('starts at the cursor it is given, and a later cursor does not subscribe again', () => {
    const started: Array<string | undefined> = []
    const fake = fakeChannel()
    const channel: LiveChannel = {
      ...fake.channel,
      subscribe(topic, params, listener, options) {
        started.push(options?.after)
        return fake.channel.subscribe(topic, params, listener)
      },
    }
    const { rerender } = renderHook(
      ({ after }: { after: string }) =>
        useLiveTopic('firestore.changes', { database: '(default)' }, {}, channel, { after }),
      { initialProps: { after: 'e.4' }, wrapper },
    )
    rerender({ after: 'e.9' })
    expect(started).toEqual(['e.4'])
  })

  it("answers this subscription's status: ended or refused, else the channel's", () => {
    const fake = fakeChannel()
    const { result } = renderHook(
      () => useLiveTopic('firestore.rules', { database: '(default)' }, {}, fake.channel),
      { wrapper },
    )
    expect(result.current).toBe('paused')
    act(() => fake.active()[0]?.listener.onState?.('ended'))
    expect(result.current).toBe('ended')
    act(() => fake.active()[0]?.listener.onState?.('active'))
    expect(result.current).toBe('paused')
    act(() => fake.active()[0]?.listener.onState?.('refused'))
    expect(result.current).toBe('refused')
  })
})

describe('useInvalidateOn', () => {
  it('invalidates on the leading edge, then once per window, and once after the last event', async () => {
    vi.useFakeTimers()
    const invalidate = vi.fn()
    const invalidator = createInvalidator(invalidate, 120)
    invalidator.push([['auth', 'p', 'users']])
    expect(invalidate).toHaveBeenCalledTimes(1)
    // A sustained burst: one event every 10 ms for half a second.
    for (let step = 0; step < 50; step += 1) {
      // Time passes between events, one step at a time.
      // oxlint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(10)
      invalidator.push([['auth', 'p', 'users']])
    }
    const during = invalidate.mock.calls.length
    expect(during).toBeGreaterThanOrEqual(4)
    expect(during).toBeLessThanOrEqual(6)
    await vi.advanceTimersByTimeAsync(120)
    expect(invalidate).toHaveBeenCalledTimes(during + 1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(invalidate).toHaveBeenCalledTimes(during + 1)
  })

  it('names each key once per event and keeps keys apart', () => {
    vi.useFakeTimers()
    const invalidate = vi.fn()
    const invalidator = createInvalidator(invalidate, 120)
    invalidator.push([
      ['auth', 'p', 'users'],
      ['auth', 'p', 'users'],
      ['auth', 'p', 'tenants'],
    ])
    expect(invalidate.mock.calls).toEqual([[['auth', 'p', 'users']], [['auth', 'p', 'tenants']]])
  })

  it('invalidates the reset keys on reset and on end', () => {
    const fake = fakeChannel()
    const spy = vi.spyOn(client, 'invalidateQueries')
    renderHook(
      () =>
        useInvalidateOn(
          'firestore.changes',
          { database: '(default)' },
          { keys: () => [['fs', '(default)', 'page']], resetKeys: [['fs', '(default)']] },
          fake.channel,
        ),
      { wrapper },
    )
    const listener = fake.active()[0]?.listener
    act(() => listener?.onEvent('change', batch, 'e.1'))
    expect(spy).toHaveBeenLastCalledWith({ queryKey: ['fs', '(default)', 'page'] })
    act(() => listener?.onReset('gap', 12))
    expect(spy).toHaveBeenLastCalledWith({ queryKey: ['fs', '(default)'] })
    spy.mockClear()
    act(() => listener?.onEnd({ code: 'unavailable', message: 'gone' }))
    expect(spy).toHaveBeenCalledWith({ queryKey: ['fs', '(default)'] })
  })
})
