import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FunctionsLiveBatch } from '@/api/generated/compute/FunctionsLiveBatch'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import type { TopicListener } from '@/lib/live/channel'
import { testStatus } from '@/test/status'
import { invocation } from '../fixtures.test-support'

// What a Run form waits for after doing the real thing: the next finished
// invocation of its function that the action caused. The form follows the
// function from the moment it opens, so an invocation that finished before
// the action's request returned is not missed.

const fake = vi.hoisted(() => {
  const subscriptions: Array<{
    topic: string
    params: object
    listener: TopicListener
    active: boolean
  }> = []
  return {
    subscriptions,
    active: () => subscriptions.filter((entry) => entry.active),
    channel: {
      subscribe(topic: string, params: object, listener: TopicListener) {
        const entry = { topic, params, listener, active: true }
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

vi.mock('@/lib/live/channel', async (original) => ({
  ...(await original<typeof import('@/lib/live/channel')>()),
  liveChannel: fake.channel,
}))

const { useNextInvocation } = await import('./run-parts')

const batch = (items: InvocationSummary[]): FunctionsLiveBatch => ({
  items,
  changes: [],
  stats: [],
  burst: null,
})

describe('the invocation a Run form waits for', () => {
  let client: QueryClient
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )

  beforeEach(() => {
    client = new QueryClient()
    client.setQueryData(['status'], testStatus())
    fake.subscriptions.length = 0
  })

  const render = () =>
    renderHook(
      ({ matches }: { matches: ((invocation: InvocationSummary) => boolean) | null }) =>
        useNextInvocation('us-central1-api', matches),
      { wrapper, initialProps: { matches: null as ((i: InvocationSummary) => boolean) | null } },
    )

  it('follows the function from the start, before anything is asked for', () => {
    render()
    expect(fake.active()).toEqual([
      expect.objectContaining({
        topic: 'functions.events',
        params: { function: 'us-central1-api' },
      }),
    ])
  })

  it('finds one that finished before the action said what it waits for', () => {
    const { result, rerender } = render()
    act(() => fake.active()[0]!.listener.onEvent('batch', batch([invocation(7)]), 'f.1'))
    expect(result.current).toBeUndefined()
    rerender({ matches: (candidate) => candidate.seq === 7 })
    expect(result.current?.id).toBe('a3f9c1-7')
  })

  it('takes the next finished match, never a running one or another', () => {
    const { result, rerender } = render()
    rerender({ matches: (candidate) => candidate.seq === 9 })
    const listener = fake.active()[0]!.listener
    act(() =>
      listener.onEvent(
        'batch',
        batch([invocation(8), invocation(9, { outcome: null, outcomeClass: 'running' })]),
        'f.2',
      ),
    )
    expect(result.current).toBeUndefined()
    act(() => listener.onEvent('batch', batch([invocation(9)]), 'f.3'))
    expect(result.current?.outcome).toBe('succeeded')
    // Waiting for nothing again says nothing.
    rerender({ matches: null })
    expect(result.current).toBeUndefined()
  })
})
