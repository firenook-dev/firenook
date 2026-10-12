import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventarcEventSummary } from '@/api/generated/compute/EventarcEventSummary'
import type { TopicListener } from '@/lib/live/channel'
import { testStatus } from '@/test/status'

const fake = vi.hoisted(() => {
  const subscriptions: Array<{
    topic: string
    params: object
    listener: TopicListener
    after: string | undefined
  }> = []
  return {
    subscriptions,
    channel: {
      subscribe(
        topic: string,
        params: object,
        listener: TopicListener,
        options?: { after?: string | undefined },
      ) {
        subscriptions.push({ topic, params, listener, after: options?.after })
        return () => {}
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

const { eventarcKeys } = await import('./api')
const { useEventarcEvents } = await import('./live')

let client: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } } })
  client.setQueryData(['status'], testStatus())
  fake.subscriptions.length = 0
})

describe('following the events', () => {
  it('subscribes after the first page, hands the rows over and reads the channels again', () => {
    client.setQueryData(eventarcKeys.channels('demo-console'), { channels: [] })
    const rows: string[] = []
    const bursts: number[] = []
    renderHook(
      () =>
        useEventarcEvents(
          { channel: 'google', q: 'delivery:failed' },
          {
            after: 'e.40',
            onItems: (items) => rows.push(...items.map((item) => item.id)),
            onBurst: (count) => bursts.push(count),
          },
        ),
      { wrapper },
    )
    const subscription = fake.subscriptions[0]
    expect(subscription).toMatchObject({
      topic: 'eventarc.events',
      params: { channel: 'google', q: 'delivery:failed' },
      after: 'e.40',
    })
    act(() =>
      subscription?.listener.onEvent(
        'batch',
        { items: [{ id: 'a3f9c1-3' } as EventarcEventSummary], burst: 12 },
        'e.41',
      ),
    )
    expect(rows).toEqual(['a3f9c1-3'])
    expect(bursts).toEqual([12])
    expect(client.getQueryState(eventarcKeys.channels('demo-console'))?.isInvalidated).toBe(true)
  })

  it('reloads the section on a reset', () => {
    client.setQueryData(eventarcKeys.channels('demo-console'), { channels: [] })
    const resets: string[] = []
    renderHook(() => useEventarcEvents({}, { onReset: (reason) => resets.push(reason) }), {
      wrapper,
    })
    act(() => fake.subscriptions[0]?.listener.onReset('lagged', null))
    expect(resets).toEqual(['lagged'])
    expect(client.getQueryState(eventarcKeys.channels('demo-console'))?.isInvalidated).toBe(true)
  })
})
