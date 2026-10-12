import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FunctionsLiveBatch } from '@/api/generated/compute/FunctionsLiveBatch'
import type { InvocationsResult } from '@/api/generated/compute/InvocationsResult'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import type { TopicListener } from '@/lib/live/channel'
import { testStatus } from '@/test/status'
import { invocation } from '../fixtures.test-support'

// The invocation list's feed against the topic contract: seeded from the
// engine's newest page, followed after that page's cursor, a running row
// replaced by its finished self in place, a burst said as one marker row
// whose Show reads the page again, and a reset that missed rows said as a
// gap row. The channel is a stand-in; the engine's topic is tested in Rust.

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

vi.mock('@/lib/live/channel', async (original) => ({
  ...(await original<typeof import('@/lib/live/channel')>()),
  liveChannel: fake.channel,
}))

vi.mock('@/lib/toasts', () => ({ toast: () => undefined }))

const { useLiveStatus } = await import('@/lib/live/channel')
const { useInvocationFeed } = await import('./invocation-list')

const PROJECT = 'demo-console'

const page = (items: InvocationSummary[], cursor = 'f.5'): InvocationsResult => ({
  page: {
    items,
    nextCursor: null,
    prevCursor: null,
    total: { count: items.length, exact: true },
    scanned: null,
  },
  liveCursor: cursor,
})

const batch = (overrides: Partial<FunctionsLiveBatch> = {}): FunctionsLiveBatch => ({
  items: [],
  changes: [],
  stats: [],
  burst: null,
  ...overrides,
})

/** What the store holds, oldest first: item ids and the other rows' words. */
function rows(store: ReturnType<typeof useInvocationFeed>['store']): string[] {
  return Array.from({ length: store.size() }, (_, index) => {
    const row = store.at(index)
    if (row?.kind === 'item') return `${row.item.id} ${row.item.outcome ?? 'running'}`
    if (row?.kind === 'marker') return `marker ${row.text}`
    return `gap ${row?.missed ?? 'unknown'}`
  })
}

describe('the invocation feed', () => {
  let client: QueryClient
  let pages: InvocationsResult[]
  let asked: string[]
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(['status'], testStatus({ projectId: PROJECT }))
    fake.subscriptions.length = 0
    useLiveStatus.setState({ status: 'live', since: 0 })
    pages = []
    asked = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      asked.push(String(input))
      const next = pages.shift()
      return new Response(JSON.stringify(next), {
        status: next ? 200 : 500,
        headers: { 'content-type': 'application/json' },
      })
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const render = (q = '') =>
    renderHook(
      () =>
        useInvocationFeed({
          project: PROJECT,
          q,
          params: q === '' ? {} : { q },
        }),
      { wrapper },
    )

  it('starts from the newest page and follows after its cursor, a running row finishing in place', async () => {
    pages.push(page([invocation(2), invocation(1)], 'f.5'))
    const { result } = render('outcome:failed')
    await waitFor(() => expect(rows(result.current.store)).toHaveLength(2))
    // The page is newest first; the feed holds them oldest first.
    expect(rows(result.current.store)).toEqual(['a3f9c1-1 succeeded', 'a3f9c1-2 succeeded'])
    expect(asked.find((url) => url.includes('/functions/invocations'))).toContain(
      'q=outcome%3Afailed',
    )
    expect(result.current.total).toBe(2)
    expect(fake.active()).toEqual([
      expect.objectContaining({
        topic: 'functions.events',
        params: { q: 'outcome:failed' },
        after: 'f.5',
      }),
    ])
    const listener = fake.active()[0]!.listener
    const running = invocation(3, { outcome: null, outcomeClass: 'running', durationMs: null })
    act(() => listener.onEvent('batch', batch({ items: [running] }), 'f.6'))
    await waitFor(() => expect(rows(result.current.store)).toHaveLength(3))
    act(() => listener.onEvent('batch', batch({ items: [invocation(3)] }), 'f.7'))
    await waitFor(() =>
      expect(rows(result.current.store)).toEqual([
        'a3f9c1-1 succeeded',
        'a3f9c1-2 succeeded',
        'a3f9c1-3 succeeded',
      ]),
    )
  })

  it('says a burst as one row, whose Show reads the newest page again', async () => {
    pages.push(page([invocation(1)]))
    const { result } = render()
    await waitFor(() => expect(rows(result.current.store)).toHaveLength(1))
    const listener = fake.active()[0]!.listener
    act(() => listener.onEvent('batch', batch({ items: [invocation(60)], burst: 1_840 }), 'f.6'))
    await waitFor(() =>
      expect(rows(result.current.store)).toEqual([
        'a3f9c1-1 succeeded',
        'a3f9c1-60 succeeded',
        'marker 1,840 more',
      ]),
    )
    const marker = result.current.store.at(2)
    expect(marker?.kind === 'marker' && marker.action?.label).toBe('Show')
    pages.push(page([invocation(1900), invocation(1899)], 'f.9'))
    act(() => {
      if (marker?.kind === 'marker') marker.action?.run()
    })
    await waitFor(() =>
      expect(rows(result.current.store)).toEqual([
        'a3f9c1-1899 succeeded',
        'a3f9c1-1900 succeeded',
      ]),
    )
    expect(asked.filter((url) => url.includes('/functions/invocations'))).toHaveLength(2)
  })

  it('says rows a reset missed as a gap row, and keeps the rest', async () => {
    pages.push(page([invocation(1)]))
    const { result } = render()
    await waitFor(() => expect(rows(result.current.store)).toHaveLength(1))
    act(() => fake.active()[0]!.listener.onReset('gap', 312))
    await waitFor(() =>
      expect(rows(result.current.store)).toEqual(['a3f9c1-1 succeeded', 'gap 312']),
    )
  })
})
