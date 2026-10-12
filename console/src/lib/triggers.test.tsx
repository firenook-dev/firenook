import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FunctionTriggersResult } from '@/api/generated/compute/FunctionTriggersResult'
import type { FunctionsLiveBatch } from '@/api/generated/compute/FunctionsLiveBatch'
import { sectionEntry, testStatus } from '@/test/status'
import type { TopicListener } from './live/channel'

/** The live channel, as the engine's side of it: subscriptions recorded, events spoken for. */
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

/** Whether the Functions section is built, as its registry says. */
const registry = vi.hoisted(() => ({ built: true }))

vi.mock('./live/channel', async (original) => ({
  ...(await original<typeof import('./live/channel')>()),
  liveChannel: fake.channel,
}))

vi.mock('./sections/functions', async (original) => {
  const actual = await original<typeof import('./sections/functions')>()
  return {
    functions: {
      ...actual.functions,
      get built() {
        return registry.built
      },
    },
  }
})

const { useTriggersFor } = await import('./triggers')

const onOrderCreated = {
  functionId: 'us-central1-onOrderCreated',
  codebase: 'default',
  eventType: 'providers/cloud.firestore/eventTypes/document.create',
  kind: 'firestore' as const,
  function: { kind: 'functions.function', key: 'us-central1-onOrderCreated' },
}

const answer: FunctionTriggersResult = { functions: [onOrderCreated], backgroundEnabled: true }

const RESOURCE = '(default)|orders/o_1'

let client: QueryClient
let asked: string[]

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function withFunctions(state: 'ready' | 'starting' | 'absent', enabled = true) {
  client.setQueryData(
    ['status'],
    testStatus({
      sections: [sectionEntry('functions', { state })],
      backgroundTriggers: { enabled, since: null, dropped: [] },
    }),
  )
}

function batch(changes: FunctionsLiveBatch['changes']): FunctionsLiveBatch {
  return { items: [], changes, stats: [], burst: null }
}

const reload = batch([
  {
    kind: 'inventory',
    codebase: 'default',
    diff: { added: [], removed: [], changed: [] },
    loads: 2,
  },
])

beforeEach(() => {
  // The status is the shell's to keep current (the `shell` topic): a test
  // sets it, and nothing refetches it.
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  asked = []
  fake.subscriptions.length = 0
  registry.built = true
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      // The status is the shell's: a test without one has an engine that has not answered yet.
      if (url.endsWith('/status')) return new Promise<Response>(() => {})
      asked.push(url)
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('which functions fire for a resource', () => {
  it('asks the engine once per resource and keeps the answer', async () => {
    withFunctions('ready')
    const first = renderHook(() => useTriggersFor('firestore', RESOURCE), { wrapper })
    const second = renderHook(() => useTriggersFor('firestore', RESOURCE), { wrapper })
    await waitFor(() => expect(first.result.current).not.toBe('unknown'))
    expect(first.result.current).toEqual({ functions: [onOrderCreated], backgroundEnabled: true })
    expect(second.result.current).toEqual(first.result.current)
    expect(asked).toEqual([
      '/console/api/v1/functions/triggers?service=firestore&resource=%28default%29%7Corders%2Fo_1',
    ])
    first.rerender()
    second.unmount()
    const third = renderHook(() => useTriggersFor('firestore', RESOURCE), { wrapper })
    expect(third.result.current).not.toBe('unknown')
    expect(asked).toHaveLength(1)
  })

  it('narrows to one kind of change, and asks again for another resource', async () => {
    withFunctions('ready')
    const created = renderHook(() => useTriggersFor('firestore', RESOURCE, 'created'), { wrapper })
    const other = renderHook(() => useTriggersFor('storage', 'demo.appspot.com|a b.png'), {
      wrapper,
    })
    await waitFor(() => expect(created.result.current).not.toBe('unknown'))
    await waitFor(() => expect(other.result.current).not.toBe('unknown'))
    expect(asked.toSorted()).toEqual([
      '/console/api/v1/functions/triggers?service=firestore&resource=%28default%29%7Corders%2Fo_1&event=created',
      '/console/api/v1/functions/triggers?service=storage&resource=demo.appspot.com%7Ca+b.png',
    ])
  })

  it('is unknown while the Functions section is not built, and asks nothing', () => {
    registry.built = false
    withFunctions('ready')
    const { result } = renderHook(() => useTriggersFor('firestore', RESOURCE), { wrapper })
    expect(result.current).toBe('unknown')
    expect(asked).toEqual([])
    expect(fake.subscriptions).toEqual([])
  })

  it('is unknown while Functions start, then asks once they are ready', async () => {
    withFunctions('starting')
    const { result } = renderHook(() => useTriggersFor('firestore', RESOURCE), { wrapper })
    expect(result.current).toBe('unknown')
    expect(asked).toEqual([])
    act(() => withFunctions('ready'))
    await waitFor(() => expect(result.current).not.toBe('unknown'))
    expect(asked).toHaveLength(1)
  })

  it('is unknown before the engine has answered, and for no resource', () => {
    const before = renderHook(() => useTriggersFor('firestore', RESOURCE), { wrapper })
    expect(before.result.current).toBe('unknown')
    before.unmount()
    withFunctions('ready')
    const none = renderHook(() => useTriggersFor('firestore', undefined), { wrapper })
    expect(none.result.current).toBe('unknown')
    expect(asked).toEqual([])
  })

  it('is absent when the suite runs no Functions, built or not', () => {
    withFunctions('absent')
    expect(renderHook(() => useTriggersFor('auth', ''), { wrapper }).result.current).toBe('absent')
    registry.built = false
    expect(renderHook(() => useTriggersFor('auth', ''), { wrapper }).result.current).toBe('absent')
    expect(asked).toEqual([])
  })

  it('says whether background triggers are delivered from the live status', async () => {
    withFunctions('ready')
    const { result } = renderHook(() => useTriggersFor('firestore', RESOURCE), { wrapper })
    await waitFor(() => expect(result.current).not.toBe('unknown'))
    act(() => withFunctions('ready', false))
    await waitFor(() =>
      expect(result.current).toEqual({ functions: [onOrderCreated], backgroundEnabled: false }),
    )
    expect(asked).toHaveLength(1)
  })
})

describe('keeping the answers current', () => {
  it('holds one inventory-only subscription for every caller, while any is mounted', async () => {
    withFunctions('ready')
    const one = renderHook(() => useTriggersFor('firestore', RESOURCE), { wrapper })
    const two = renderHook(() => useTriggersFor('pubsub', 'projects/demo/topics/emails'), {
      wrapper,
    })
    await waitFor(() => expect(two.result.current).not.toBe('unknown'))
    expect(fake.active()).toEqual([
      expect.objectContaining({ topic: 'functions.events', params: { changesOnly: true } }),
    ])
    one.unmount()
    expect(fake.active()).toHaveLength(1)
    two.unmount()
    expect(fake.active()).toEqual([])
  })

  it('asks again after a codebase reloads, not for other changes', async () => {
    withFunctions('ready')
    const { result } = renderHook(() => useTriggersFor('firestore', RESOURCE), { wrapper })
    await waitFor(() => expect(result.current).not.toBe('unknown'))
    const listener = fake.active()[0]?.listener
    const codebase = batch([
      {
        kind: 'codebase',
        codebase: {
          codebase: {
            id: 'default',
            kind: 'user',
            directory: 'functions',
            runtime: 'nodejs22',
            state: 'loading',
            servingPrevious: false,
            error: null,
            loads: 1,
            loadedAt: null,
            loadMs: null,
            loadingSince: '2026-10-12T06:00:00.000Z',
            functionCount: 1,
            notLoaded: [],
            envFiles: [],
            lastChange: null,
            stale: null,
            worker: {
              state: 'stopped',
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
          },
          instance: null,
        },
      },
    ])
    act(() => listener?.onEvent('batch', codebase, 'f.2'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(asked).toHaveLength(1)
    act(() => listener?.onEvent('batch', reload, 'f.3'))
    await waitFor(() => expect(asked).toHaveLength(2))
  })

  it('asks again when the subscription missed changes or ended', async () => {
    withFunctions('ready')
    const { result } = renderHook(() => useTriggersFor('firestore', RESOURCE), { wrapper })
    await waitFor(() => expect(result.current).not.toBe('unknown'))
    const listener = fake.active()[0]?.listener
    act(() => listener?.onReset('gap', null))
    await waitFor(() => expect(asked).toHaveLength(2))
    act(() => listener?.onEnd({ code: 'unavailable', message: 'Functions stopped.' }))
    await waitFor(() => expect(asked).toHaveLength(3))
  })
})
