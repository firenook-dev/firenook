import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthActivityPage } from '@/api/generated/auth/AuthActivityPage'
import type { AuthActivitySummary } from '@/api/generated/auth/AuthActivitySummary'
import type { AuthMessage } from '@/api/generated/auth/AuthMessage'
import type { AuthMessagePage } from '@/api/generated/auth/AuthMessagePage'
import type { LiveChannel, SubscribeOptions, TopicListener } from '@/lib/live/channel'
import { type FeedRow, type FeedStore, createFeedStore } from '@/lib/live/feed-store'
import {
  applyActivityBatch,
  applyInboxBatch,
  readUsersWindow,
  useActivityFeed,
  useInboxFeed,
} from './live'

function call(id: number, extra: Partial<AuthActivitySummary> = {}): AuthActivitySummary {
  return {
    id,
    at: new Date(Date.UTC(2026, 9, 12, 10, 0, id)).toISOString(),
    durationMicros: 1_000,
    project: 'demo-auth',
    tenant: null,
    caller: 'client',
    origin: null,
    credential: 'apiKey',
    client: null,
    method: 'POST',
    path: '/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword',
    operation: 'identitytoolkit.accounts.signInWithPassword',
    kind: 'sign-in',
    identifier: `user${id}@example.test`,
    provider: 'password',
    uid: `u_${id}`,
    newUser: false,
    status: 200,
    error: null,
    steps: [],
    moreSteps: 0,
    ...extra,
  }
}

function message(id: number, extra: Partial<AuthMessage> = {}): AuthMessage {
  return {
    id,
    at: new Date(Date.UTC(2026, 9, 12, 10, 0, id)).toISOString(),
    tenant: null,
    kind: 'smsSignIn',
    channel: 'sms',
    to: '+15550100',
    newEmail: null,
    uid: 'u_1',
    code: String(100_000 + id),
    link: null,
    continueUrl: null,
    delivery: 'sent',
    origin: null,
    used: false,
    usedAt: null,
    activity: id + 1_000,
    usedBy: null,
    text: `To sign in, use the code ${100_000 + id}.`,
    ...extra,
  }
}

/** The rows of a store, oldest first, as their keys (a gap row as `gap:<missed>`). */
function rows<T extends { id: number }>(store: FeedStore<T>): string[] {
  const out: string[] = []
  for (let index = 0; index < store.size(); index += 1) {
    const row = store.at(index) as FeedRow<T>
    if (row.kind === 'item') out.push(String(row.item.id))
    else if (row.kind === 'gap') out.push(`gap:${row.missed}`)
    else out.push(`marker:${row.key}`)
  }
  return out
}

describe('an auth.users window', () => {
  it('names each uid once, says what changed, and which tokens it makes stale', () => {
    const window = readUsersWindow({
      tenant: null,
      changes: [
        { uid: 'u_1', change: 'created', fields: [] },
        { uid: 'u_2', change: 'updated', fields: ['lastLoginAt', 'displayName'] },
        { uid: 'u_3', change: 'updated', fields: ['customAttributes'] },
        { uid: 'u_4', change: 'deleted', fields: [] },
        { uid: 'u_5', change: 'updated', fields: ['emailVerified', 'photoUrl'] },
      ],
    })
    expect(window.uids).toEqual(['u_1', 'u_2', 'u_3', 'u_4', 'u_5'])
    expect(window.created).toEqual(['u_1'])
    expect(window.updated).toEqual(['u_2', 'u_3', 'u_5'])
    expect(window.deleted).toEqual(['u_4'])
    expect(window.claimsChanged).toBe(true)
    // A sign-in or a new display name leaves the token's claims as they were.
    expect(window.staleTokens).toEqual(['u_3', 'u_4', 'u_5'])
  })

  it('does not say claims changed when no entry set them', () => {
    expect(
      readUsersWindow({
        tenant: 'acme',
        changes: [{ uid: 'u_1', change: 'updated', fields: ['disabled'] }],
      }),
    ).toMatchObject({ claimsChanged: false, staleTokens: ['u_1'] })
  })
})

describe('feed batches', () => {
  it('push calls in order, and a clear empties the list', () => {
    const store = createFeedStore<AuthActivitySummary>({ max: 3, key: (item) => String(item.id) })
    expect(
      applyActivityBatch(store, {
        items: [
          { kind: 'call', summary: call(1) },
          { kind: 'call', summary: call(2) },
        ],
      }),
    ).toEqual({ items: 2, cleared: false })
    expect(rows(store)).toEqual(['1', '2'])
    expect(
      applyActivityBatch(store, {
        items: [
          { kind: 'call', summary: call(3) },
          { kind: 'cleared' },
          { kind: 'call', summary: call(4) },
        ],
      }),
    ).toEqual({ items: 2, cleared: true })
    expect(rows(store)).toEqual(['4'])
  })

  it('keep a feed within its capacity, the oldest leaving first', () => {
    const store = createFeedStore<AuthActivitySummary>({ max: 3, key: (item) => String(item.id) })
    applyActivityBatch(store, {
      items: [1, 2, 3, 4, 5].map((id) => ({ kind: 'call' as const, summary: call(id) })),
    })
    expect(rows(store)).toEqual(['3', '4', '5'])
  })

  it('mark a used code where it stands, and leave one the inbox does not hold', () => {
    const store = createFeedStore<AuthMessage>({ max: 10, key: (item) => String(item.id) })
    applyInboxBatch(store, {
      items: [1, 2, 3].map((id) => ({ kind: 'issued' as const, message: message(id) })),
    })
    expect(
      applyInboxBatch(store, {
        items: [
          { kind: 'used', id: 2, usedAt: '2026-10-12T10:05:00Z', usedBy: 77 },
          { kind: 'used', id: 99, usedAt: '2026-10-12T10:05:00Z', usedBy: 78 },
        ],
      }),
    ).toEqual({ items: 1, cleared: false })
    expect(rows(store)).toEqual(['1', '2', '3'])
    const used = store.at(1)
    expect(used?.kind === 'item' && used.item).toMatchObject({
      id: 2,
      used: true,
      usedAt: '2026-10-12T10:05:00Z',
      usedBy: 77,
      code: '100002',
    })
    expect(applyInboxBatch(store, { items: [{ kind: 'cleared' }] })).toEqual({
      items: 0,
      cleared: true,
    })
    expect(store.size()).toBe(0)
  })
})

// ------------------------------------------------------------------ the feed hooks

/** A channel that records subscriptions and lets a test speak for the engine. */
function fakeChannel() {
  const subscriptions: Array<{
    topic: string
    params: Record<string, unknown>
    options: SubscribeOptions | undefined
    listener: TopicListener
    active: boolean
  }> = []
  const restarts = new Set<() => void>()
  const channel: LiveChannel = {
    subscribe(topic, params, listener, options) {
      const entry = {
        topic,
        params: params as Record<string, unknown>,
        options,
        listener,
        active: true,
      }
      subscriptions.push(entry)
      return () => {
        entry.active = false
      }
    },
    onEngineRestart(callback) {
      restarts.add(callback)
      return () => restarts.delete(callback)
    },
    retry: () => {},
  }
  const active = () => subscriptions.filter((entry) => entry.active)
  return {
    channel,
    subscriptions,
    active,
    emit(name: string, data: unknown, cursor = 'c') {
      for (const entry of active()) entry.listener.onEvent(name, data, cursor)
    },
    reset(missed: number | null) {
      for (const entry of active()) entry.listener.onReset('gap', missed)
    },
    restart() {
      for (const callback of restarts) callback()
    },
  }
}

type Pages = (url: URL) => unknown

let pages: Pages
let client: QueryClient
const asked: URL[] = []

function answer(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  asked.length = 0
  vi.stubGlobal('fetch', (input: string) => {
    const url = new URL(input, 'http://console.test')
    asked.push(url)
    return Promise.resolve(answer(pages(url)))
  })
})

afterEach(() => {
  // Unmounted first, so no refresh a test left behind reaches past its stub.
  cleanup()
  client.clear()
  vi.unstubAllGlobals()
})

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)

function activityPage(
  ids: number[],
  liveAfter: string,
  nextCursor: string | null = null,
): AuthActivityPage {
  return {
    items: ids.map((id) => call(id)),
    nextCursor,
    prevCursor: null,
    total: { count: ids.length, exact: true },
    scanned: null,
    facets: { errors: 0, newUsers: 0, kinds: [], callers: [] },
    bodiesRetained: true,
    liveAfter,
  }
}

describe('useActivityFeed', () => {
  it('fills the feed from the first page and follows the live tail after it', async () => {
    pages = () => activityPage([12, 11, 10], '0000000a.40', 'older-1')
    const fake = fakeChannel()
    const { result } = renderHook(
      () =>
        useActivityFeed({
          project: 'demo-auth',
          scope: { kind: 'all' },
          q: '',
          includeConsole: false,
          channel: fake.channel,
        }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(rows(result.current.store)).toEqual(['10', '11', '12'])
    expect(result.current.hasOlder).toBe(true)
    expect(result.current.bodiesRetained).toBe(true)
    expect(asked[0]?.searchParams.get('project')).toBe('demo-auth')
    expect(asked[0]?.searchParams.get('limit')).toBe('100')
    expect(fake.active()).toEqual([
      expect.objectContaining({
        topic: 'auth.activity',
        params: { project: 'demo-auth', console: false },
        options: { after: '0000000a.40' },
      }),
    ])
    act(() => fake.emit('calls', { items: [{ kind: 'call', summary: call(13) }] }))
    expect(rows(result.current.store)).toEqual(['10', '11', '12', '13'])
    act(() => fake.reset(3_120))
    expect(rows(result.current.store)).toEqual(['10', '11', '12', '13', 'gap:3120'])
  })

  it('reads older pages into the front, as far as the engine keeps them', async () => {
    pages = (url) =>
      url.searchParams.get('cursor') === 'older-1'
        ? activityPage([9, 8], '0000000a.40', null)
        : activityPage([12, 11, 10], '0000000a.40', 'older-1')
    const fake = fakeChannel()
    const { result } = renderHook(
      () =>
        useActivityFeed({
          project: 'demo-auth',
          scope: { kind: 'project' },
          q: 'is:error',
          includeConsole: true,
          channel: fake.channel,
        }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(asked[0]?.searchParams.get('tenant')).toBe('(none)')
    expect(asked[0]?.searchParams.get('q')).toBe('is:error')
    expect(asked[0]?.searchParams.get('console')).toBe('true')
    act(() => result.current.loadOlder())
    await waitFor(() => expect(result.current.hasOlder).toBe(false))
    expect(rows(result.current.store)).toEqual(['8', '9', '10', '11', '12'])
    expect(asked.filter((url) => url.searchParams.get('cursor') === 'older-1')).toHaveLength(1)
  })

  it('starts again for a new filter: no tail until its first page, which it follows from', async () => {
    pages = (url) =>
      url.searchParams.get('q') === 'is:error'
        ? activityPage([7], '0000000a.90')
        : activityPage([12, 11], '0000000a.40')
    const fake = fakeChannel()
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) =>
        useActivityFeed({
          project: 'demo-auth',
          scope: { kind: 'all' },
          q,
          includeConsole: false,
          channel: fake.channel,
        }),
      { wrapper, initialProps: { q: '' } },
    )
    await waitFor(() => expect(result.current.ready).toBe(true))
    rerender({ q: 'is:error' })
    expect(result.current.ready).toBe(false)
    expect(fake.active()).toEqual([])
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(rows(result.current.store)).toEqual(['7'])
    expect(fake.active()).toEqual([
      expect.objectContaining({
        params: { project: 'demo-auth', q: 'is:error', console: false },
        options: { after: '0000000a.90' },
      }),
    ])
    // The first filter's subscription is gone; the new one carries on.
    expect(fake.subscriptions[0]?.active).toBe(false)
    act(() => fake.emit('calls', { items: [{ kind: 'call', summary: call(8) }] }))
    expect(rows(result.current.store)).toEqual(['7', '8'])
  })

  it('a clear empties the feed and leaves nothing older to read', async () => {
    pages = () => activityPage([2, 1], '0000000a.4', 'older-1')
    const fake = fakeChannel()
    const { result } = renderHook(
      () =>
        useActivityFeed({
          project: 'demo-auth',
          scope: { kind: 'all' },
          q: '',
          includeConsole: false,
          channel: fake.channel,
        }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => fake.emit('calls', { items: [{ kind: 'cleared' }] }))
    expect(result.current.store.size()).toBe(0)
    expect(result.current.hasOlder).toBe(false)
  })

  it('after an engine restart shows only the new engine, from its own first page', async () => {
    let engine = 'a'
    pages = () =>
      engine === 'a' ? activityPage([3, 2, 1], '0000000a.3') : activityPage([1], '0000000b.1')
    const fake = fakeChannel()
    const { result } = renderHook(
      () =>
        useActivityFeed({
          project: 'demo-auth',
          scope: { kind: 'all' },
          q: '',
          includeConsole: false,
          channel: fake.channel,
        }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.ready).toBe(true))
    engine = 'b'
    await act(async () => {
      // What the shell does on a restart: every query again, then the callbacks.
      void client.invalidateQueries()
      fake.restart()
      await Promise.resolve()
    })
    await waitFor(() => expect(fake.active()[0]?.options).toEqual({ after: '0000000b.1' }))
    expect(rows(result.current.store)).toEqual(['1'])
    expect(fake.active()).toHaveLength(1)
  })
})

function messagePage(ids: number[], liveAfter: string): AuthMessagePage {
  return {
    items: ids.map((id) => message(id)),
    nextCursor: null,
    prevCursor: null,
    total: { count: ids.length, exact: true },
    scanned: null,
    facets: { unused: ids.length, returned: 0, restored: 0, kinds: [] },
    liveAfter,
  }
}

describe('useInboxFeed', () => {
  it('pushes issued messages, marks used ones in place, and follows after the first page', async () => {
    pages = () => messagePage([3, 2, 1], '0000000a.6')
    const fake = fakeChannel()
    const { result } = renderHook(
      () =>
        useInboxFeed({
          project: 'demo-auth',
          scope: { kind: 'tenant', tenant: 'acme' },
          q: '-is:used',
          channel: fake.channel,
        }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(asked[0]?.pathname).toBe('/console/api/v1/auth/messages')
    expect(asked[0]?.searchParams.get('tenant')).toBe('acme')
    expect(fake.active()[0]).toMatchObject({
      topic: 'auth.inbox',
      params: { project: 'demo-auth', tenant: 'acme', q: '-is:used' },
      options: { after: '0000000a.6' },
    })
    act(() =>
      fake.emit('messages', {
        items: [
          { kind: 'issued', message: message(4) },
          { kind: 'used', id: 1, usedAt: '2026-10-12T10:09:00Z', usedBy: 9 },
        ],
      }),
    )
    expect(rows(result.current.store)).toEqual(['1', '2', '3', '4'])
    const first = result.current.store.at(0)
    expect(first?.kind === 'item' && first.item.used).toBe(true)
  })
})
