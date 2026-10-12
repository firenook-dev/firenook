import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { TopicListener } from '@/lib/live/channel'
import { testStatus } from '@/test/status'

const fake = vi.hoisted(() => {
  const subscriptions: Array<{ topic: string; params: object; listener: TopicListener }> = []
  return {
    subscriptions,
    channel: {
      subscribe(topic: string, params: object, listener: TopicListener) {
        subscriptions.push({ topic, params, listener })
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

const { extensionKeys } = await import('./api')
const { useExtensionsChanges } = await import('./live')

describe('extensions.changes', () => {
  it('reads the list and each named instance again, and holds nothing when not enabled', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    })
    client.setQueryData(['status'], testStatus())
    client.setQueryData(extensionKeys.instances('demo-console'), { instances: [] })
    client.setQueryData(extensionKeys.instance('demo-console', 'greeter'), { summary: {} })
    client.setQueryData(extensionKeys.instance('demo-console', 'resize'), { summary: {} })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { rerender } = renderHook(({ on }: { on: boolean }) => useExtensionsChanges(on), {
      wrapper,
      initialProps: { on: false },
    })
    expect(fake.subscriptions).toEqual([])
    rerender({ on: true })
    expect(fake.subscriptions).toEqual([
      expect.objectContaining({ topic: 'extensions.changes', params: {} }),
    ])
    act(() =>
      fake.subscriptions[0]?.listener.onEvent('changed', { instanceIds: ['greeter'] }, undefined),
    )
    const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated
    expect(stale(extensionKeys.instances('demo-console'))).toBe(true)
    expect(stale(extensionKeys.instance('demo-console', 'greeter'))).toBe(true)
    expect(stale(extensionKeys.instance('demo-console', 'resize'))).toBe(false)
  })
})
