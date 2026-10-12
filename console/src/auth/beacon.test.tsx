import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthMessage } from '@/api/generated/auth/AuthMessage'
import type { AuthMessagePage } from '@/api/generated/auth/AuthMessagePage'
import { tokenKey } from '@/lib/identity'
import type { LiveChannel, SubscribeOptions, TopicListener } from '@/lib/live/channel'
import { usePaletteProviders } from '@/lib/palette'
import { toast } from '@/lib/toasts'
import { testStatus } from '@/test/status'
import {
  Beacon,
  batchToasts,
  earlierPosition,
  foldLatest,
  latestItems,
  messageToast,
  onInbox,
  tokenScopes,
} from './beacon'
import { useToastsOn } from './messages'

vi.mock('@/lib/toasts', async (original) => ({
  ...(await original<typeof import('@/lib/toasts')>()),
  toast: vi.fn(),
}))

function message(id: number, extra: Partial<AuthMessage> = {}): AuthMessage {
  return {
    id,
    at: '2026-10-12T10:00:00Z',
    tenant: null,
    kind: 'smsSignIn',
    channel: 'sms',
    to: '+15550100',
    newEmail: null,
    uid: 'u_1',
    code: '482913',
    link: null,
    continueUrl: null,
    delivery: 'sent',
    origin: null,
    used: false,
    usedAt: null,
    activity: 3,
    usedBy: null,
    text: '',
    ...extra,
  }
}

const RESET = message(5, {
  kind: 'passwordReset',
  channel: 'email',
  to: 'ada@example.test',
  code: 'k3Jm',
  link: 'http://127.0.0.1:9099/emulator/action?mode=resetPassword&oobCode=k3Jm',
})

describe('the newest code and link', () => {
  it('keep the newest of each channel, so a replay of older ones changes nothing', () => {
    let latest = foldLatest(
      {},
      {
        items: [
          { kind: 'issued', message: message(2) },
          { kind: 'issued', message: RESET },
        ],
      },
    )
    expect(latest.sms?.id).toBe(2)
    expect(latest.email?.id).toBe(5)
    latest = foldLatest(latest, { items: [{ kind: 'issued', message: message(1) }] })
    expect(latest.sms?.id).toBe(2)
    latest = foldLatest(latest, {
      items: [{ kind: 'issued', message: message(9, { code: '111222' }) }],
    })
    expect(latest.sms?.code).toBe('111222')
  })

  it('mark one used, and forget both when the history is cleared', () => {
    let latest = foldLatest({}, { items: [{ kind: 'issued', message: RESET }] })
    latest = foldLatest(latest, {
      items: [{ kind: 'used', id: 5, usedAt: '2026-10-12T10:01:00Z', usedBy: 8 }],
    })
    expect(latest.email).toMatchObject({ id: 5, used: true, usedBy: 8 })
    expect(foldLatest(latest, { items: [{ kind: 'cleared' }] })).toEqual({})
  })

  it('are offered in ⌘K only while they can still be used', () => {
    const items = latestItems({ sms: message(2), email: RESET })
    expect(items.map((item) => [item.title, item.description])).toEqual([
      ['Copy the latest SMS code', '482913 for +15550100'],
      ['Open the latest email link', 'Password reset for ada@example.test'],
    ])
    expect(items[0]?.keywords).toContain('482913')
    expect(latestItems({ sms: message(2, { used: true }), email: RESET })).toHaveLength(1)
    expect(latestItems({})).toEqual([])
  })

  it('follow the feed from the earlier of the two pages read', () => {
    expect(earlierPosition('0000000a.40', '0000000a.7')).toBe('0000000a.7')
    expect(earlierPosition('0000000a.7', '0000000a.40')).toBe('0000000a.7')
    // Across an engine restart, the newer run's position is the one that holds.
    expect(earlierPosition('0000000a.40', '0000000b.2')).toBe('0000000b.2')
  })
})

describe('a toast for each new code or link', () => {
  const now = { highest: 4, quiet: false }

  it('is keyed by the message, with Copy for a code and Open and Copy link for a link', () => {
    const sms = messageToast(message(9), now)
    expect(sms).toMatchObject({
      key: 'auth.message.9',
      title: 'SMS code for +15550100: 482913',
      echo: false,
      replayed: false,
    })
    expect(sms?.action?.label).toBe('Copy')
    const link = messageToast(RESET, now)
    expect(link?.title).toBe('Password reset link for ada@example.test')
    expect([link?.action?.label, ...(link?.actions ?? []).map((action) => action.label)]).toEqual([
      'Open',
      'Copy link',
    ])
  })

  it('is an echo for the console’s own sends, and a replay for what the tab already knew or just after a reconnect', () => {
    expect(messageToast(message(9, { origin: 'write' }), now)?.echo).toBe(true)
    expect(messageToast(message(3), now)?.replayed).toBe(true)
    expect(messageToast(message(9), { highest: 4, quiet: true })?.replayed).toBe(true)
  })

  it('is never offered for a code found in saved state or a link handed back to its caller', () => {
    expect(messageToast(message(9, { delivery: 'restored', at: null }), now)).toBeUndefined()
    expect(messageToast({ ...RESET, delivery: 'returned' }, now)).toBeUndefined()
    expect(
      batchToasts(
        {
          items: [
            { kind: 'issued', message: message(9) },
            { kind: 'used', id: 9, usedAt: '2026-10-12T10:01:00Z', usedBy: 3 },
            { kind: 'issued', message: message(10, { delivery: 'restored' }) },
          ],
        },
        now,
      ).map((shown) => shown.key),
    ).toEqual(['auth.message.9'])
  })

  it('is not shown on the Inbox, which lists every message as it arrives', () => {
    expect(onInbox('/console/auth/inbox')).toBe(true)
    expect(onInbox('/console/auth/inbox/')).toBe(true)
    expect(onInbox('/console/auth')).toBe(false)
    expect(onInbox('/console/auth/activity')).toBe(false)
  })
})

describe('engine tokens kept fresh', () => {
  it('are followed per project and tenant that has one cached', () => {
    const client = new QueryClient()
    client.setQueryData(tokenKey('demo-auth', undefined, 'u_1'), { authorization: 'Bearer a' })
    client.setQueryData(tokenKey('demo-auth', undefined, 'u_2'), { authorization: 'Bearer b' })
    client.setQueryData(tokenKey('demo-auth', 'acme', 'u_3'), { authorization: 'Bearer c' })
    client.setQueryData(['auth', 'demo-auth', 'users', '', '', 'created:desc'], { pages: [] })
    expect(tokenScopes(client).split('\n')).toEqual(['demo-auth\u0000', 'demo-auth\u0000acme'])
    expect(tokenScopes(new QueryClient())).toBe('')
  })
})

// ------------------------------------------------------------------ mounted

function fakeChannel() {
  const subscriptions: Array<{
    topic: string
    params: Record<string, unknown>
    options: SubscribeOptions | undefined
    listener: TopicListener
    active: boolean
  }> = []
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
    onEngineRestart: () => () => {},
    retry: () => {},
  }
  const active = (topic: string) =>
    subscriptions.filter((entry) => entry.active && entry.topic === topic)
  return { channel, active }
}

function page(items: AuthMessage[], liveAfter: string): AuthMessagePage {
  return {
    items,
    nextCursor: null,
    prevCursor: null,
    total: { count: items.length, exact: true },
    scanned: null,
    facets: null,
    liveAfter,
  }
}

const palette = (query = '') =>
  usePaletteProviders.getState().providers['auth.beacon']?.(query) ?? []

describe('the beacon, mounted', () => {
  let client: QueryClient
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(['status'], testStatus({ projectId: 'demo-auth' }))
    vi.stubGlobal('fetch', (input: string) => {
      const url = new URL(input, 'http://console.test')
      const q = url.searchParams.get('q')
      const body = url.pathname.endsWith('/status')
        ? testStatus({ projectId: 'demo-auth' })
        : q === 'type:sms'
          ? page([message(2)], '0000000a.9')
          : page([RESET], '0000000a.6')
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    })
  })
  afterEach(() => {
    cleanup()
    client.clear()
    vi.unstubAllGlobals()
  })

  const mount = (channel: LiveChannel) =>
    render(
      <QueryClientProvider client={client}>
        <Beacon channel={channel} />
      </QueryClientProvider>,
    )

  it('offers the newest code and link, then follows the inbox after the earlier page', async () => {
    const fake = fakeChannel()
    mount(fake.channel)
    await waitFor(() => expect(fake.active('auth.inbox')).toHaveLength(1))
    expect(fake.active('auth.inbox')[0]).toMatchObject({
      params: {},
      options: { after: '0000000a.6' },
    })
    expect(palette()[0]?.items.map((item) => item.title)).toEqual([
      'Copy the latest SMS code',
      'Open the latest email link',
    ])
    act(() =>
      fake
        .active('auth.inbox')[0]
        ?.listener.onEvent(
          'messages',
          { items: [{ kind: 'issued', message: message(12, { code: '700700' }) }] },
          '0000000a.12',
        ),
    )
    expect(palette('700700')[0]?.items.map((item) => item.description)).toEqual([
      '700700 for +15550100',
    ])
  })

  it('drops a cached engine token when its user changes what the token carries', async () => {
    const fake = fakeChannel()
    mount(fake.channel)
    act(() => {
      client.setQueryData(tokenKey('demo-auth', 'acme', 'u_3'), { authorization: 'Bearer c' })
      client.setQueryData(tokenKey('demo-auth', 'acme', 'u_4'), { authorization: 'Bearer d' })
    })
    await waitFor(() => expect(fake.active('auth.users')).toHaveLength(1))
    expect(fake.active('auth.users')[0]?.params).toEqual({ project: 'demo-auth', tenant: 'acme' })
    act(() =>
      fake.active('auth.users')[0]?.listener.onEvent(
        'changed',
        {
          tenant: 'acme',
          changes: [
            { uid: 'u_3', change: 'updated', fields: ['customAttributes'] },
            { uid: 'u_4', change: 'updated', fields: ['lastLoginAt'] },
          ],
        },
        '7',
      ),
    )
    expect(client.getQueryData(tokenKey('demo-auth', 'acme', 'u_3'))).toBeUndefined()
    expect(client.getQueryData(tokenKey('demo-auth', 'acme', 'u_4'))).toBeDefined()
    // Once no token of that tenant is cached, nobody follows its users.
    act(() => client.removeQueries({ queryKey: ['auth', 'demo-auth', 'token', 'acme'] }))
    await waitFor(() => expect(fake.active('auth.users')).toHaveLength(0))
  })

  it('hands each new message the app caused to the toast policy, except on the Inbox or with toasts off', async () => {
    const shown = vi.mocked(toast)
    shown.mockClear()
    const fake = fakeChannel()
    mount(fake.channel)
    await waitFor(() => expect(fake.active('auth.inbox')).toHaveLength(1))
    const deliver = (id: number) =>
      act(() =>
        fake
          .active('auth.inbox')[0]
          ?.listener.onEvent(
            'messages',
            { items: [{ kind: 'issued', message: message(id, { code: `${id}0000` }) }] },
            `0000000a.${id}`,
          ),
      )
    deliver(20)
    expect(shown).toHaveBeenCalledTimes(1)
    expect(shown.mock.calls[0]?.[0]).toMatchObject({ key: 'auth.message.20', replayed: false })
    // What the tab already knew of comes again as a replay.
    deliver(20)
    expect(shown.mock.calls[1]?.[0]).toMatchObject({ key: 'auth.message.20', replayed: true })
    window.history.pushState({}, '', '/console/auth/inbox')
    deliver(21)
    expect(shown).toHaveBeenCalledTimes(2)
    window.history.pushState({}, '', '/console/auth')
    act(() => useToastsOn.getState().set(false))
    deliver(22)
    expect(shown).toHaveBeenCalledTimes(2)
    act(() => useToastsOn.getState().set(true))
    deliver(23)
    expect(shown).toHaveBeenCalledTimes(3)
    window.history.pushState({}, '', '/')
  })
})
