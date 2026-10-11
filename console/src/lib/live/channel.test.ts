import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiErrorDetail } from '@/api/generated/ApiErrorDetail'
import {
  DEFAULT_TIMING,
  type LiveChannelInstance,
  type SubscriptionState,
  TIMING_KEY,
  type TopicListener,
  backoffDelay,
  createLiveChannel,
  readTiming,
} from './channel'
import { FakeBrowser, type FakeTab, settle } from './fakes.test-support'
import { LEADER_LOCK, TAB_LOCK_PREFIX } from './leader'

interface Recorded {
  events: Array<{ name: string; data: unknown; cursor: string | undefined }>
  resets: Array<{ reason: string; missed: number | null }>
  ends: Array<ApiErrorDetail | undefined>
  refused: ApiErrorDetail[]
  states: SubscriptionState[]
  listener: TopicListener
}

function record(): Recorded {
  const recorded: Omit<Recorded, 'listener'> = {
    events: [],
    resets: [],
    ends: [],
    refused: [],
    states: [],
  }
  return {
    ...recorded,
    listener: {
      onEvent: (name, data, cursor) => recorded.events.push({ name, data, cursor }),
      onReset: (reason, missed) => recorded.resets.push({ reason, missed }),
      onEnd: (error) => recorded.ends.push(error),
      onRefused: (error) => recorded.refused.push(error),
      onState: (state) => recorded.states.push(state),
    },
  }
}

const CHANGES = { database: '(default)' }
const GONE: ApiErrorDetail = { code: 'unavailable', message: 'Functions stopped.' }

let browser: FakeBrowser
let opened: LiveChannelInstance[] = []

function open(tab: FakeTab, options: Parameters<typeof createLiveChannel>[1] = {}) {
  const channel = createLiveChannel(tab.environment, options)
  opened.push(channel)
  return channel
}

/** One visible leader tab, connected, with `topics` subscribed. */
async function leaderWith(...topics: Array<[string, object]>) {
  const tab = browser.tab()
  const channel = open(tab)
  const recorded = topics.map(([topic, params]) => {
    const one = record()
    channel.subscribe(topic, params, one.listener)
    return one
  })
  await settle()
  browser.engine.hello()
  await settle()
  return { tab, channel, recorded }
}

beforeEach(() => {
  vi.useFakeTimers()
  browser = new FakeBrowser()
})

afterEach(() => {
  for (const channel of opened) channel.close()
  opened = []
  vi.useRealTimers()
})

describe('one channel per browser', () => {
  it('a hidden tab neither asks to lead nor connects until it is shown', async () => {
    const tab = browser.tab({ hidden: true })
    const channel = open(tab)
    channel.subscribe('firestore.changes', CHANGES, record().listener)
    await settle()
    expect(browser.locks.isHeld(LEADER_LOCK)).toBe(false)
    expect(browser.engine.sources).toHaveLength(0)
    expect(channel.status.getState().status).toBe('paused')

    tab.document.show()
    await settle()
    expect(browser.engine.sources).toHaveLength(1)
    expect(channel.status.getState()).toMatchObject({ status: 'connecting', leader: true })
    browser.engine.hello()
    await settle()
    expect(browser.engine.held()).toEqual([
      expect.objectContaining({ topic: 'firestore.changes', params: CHANGES }),
    ])
    expect(channel.status.getState().status).toBe('live')
  })

  it('subscribes only after hello, in one POST per microtask', async () => {
    const tab = browser.tab()
    const channel = open(tab)
    channel.subscribe('firestore.changes', CHANGES, record().listener)
    channel.subscribe('firestore.rules', CHANGES, record().listener)
    await settle()
    expect(browser.engine.posts).toHaveLength(0)
    browser.engine.hello()
    await settle()
    expect(browser.engine.posts).toHaveLength(1)
    expect(browser.engine.posts[0]?.add.map((add) => add.topic)).toEqual([
      'firestore.changes',
      'firestore.rules',
    ])
  })

  it('one tab leads three; the others ride its connection and get only their own events', async () => {
    const a = await leaderWith(['firestore.changes', CHANGES])
    const b = open(browser.tab())
    const c = open(browser.tab())
    const forB = record()
    const forC = record()
    b.subscribe('firestore.changes', CHANGES, forB.listener)
    c.subscribe('logs.entries', { q: 'level:error' }, forC.listener)
    await settle()
    expect(browser.engine.live()).toHaveLength(1)
    expect(a.channel.status.getState().leader).toBe(true)
    expect(b.status.getState()).toMatchObject({ leader: false, status: 'live' })
    // Feeds resume from each subscriber's own cursor: never shared.
    const held = browser.engine.held()
    expect(held.map((sub) => sub.topic)).toEqual([
      'firestore.changes',
      'firestore.changes',
      'logs.entries',
    ])
    const id = held[1]?.id ?? ''
    expect(id.startsWith(`${a.channel.tab}.`)).toBe(true)
    browser.engine.ev(id, 'change', 'e.1', { changes: [] })
    await settle()
    expect(forB.events).toEqual([{ name: 'change', data: { changes: [] }, cursor: 'e.1' }])
    expect(a.recorded[0]?.events).toEqual([])
    expect(forC.events).toEqual([])
  })

  it('state topics with equal parameters share one engine subscription, and a newcomer gets the state', async () => {
    const a = await leaderWith(['firestore.rules', { database: '(default)' }])
    browser.engine.ev(browser.engine.idOf('firestore.rules'), 'file', 'h1', { problems: [] })
    await settle()
    const b = open(browser.tab())
    const late = record()
    b.subscribe('firestore.rules', { database: '(default)' }, late.listener)
    await settle()
    expect(browser.engine.held().filter((sub) => sub.topic === 'firestore.rules')).toHaveLength(1)
    expect(late.events).toEqual([{ name: 'file', data: { problems: [] }, cursor: 'h1' }])
    browser.engine.ev(browser.engine.idOf('firestore.rules'), 'rules', 'h2', { hash: 'h2' })
    await settle()
    expect(a.recorded[0]?.events.map((event) => event.name)).toEqual(['file', 'rules'])
    expect(late.events.map((event) => event.name)).toEqual(['file', 'rules'])
  })

  it('a tick moves the cursor and calls no handler', async () => {
    const a = await leaderWith(['firestore.changes', CHANGES])
    browser.engine.ev(browser.engine.idOf('firestore.changes'), 'tick', 'e.9', null)
    await settle()
    expect(a.recorded[0]?.events).toEqual([])
    browser.engine.drop()
    browser.engine.hello()
    await settle()
    expect(browser.engine.posts.at(-1)?.add[0]?.after).toBe('e.9')
  })

  it('a leader hidden 20 s lets go, and a visible follower takes over with its cursors', async () => {
    const a = await leaderWith(['firestore.changes', CHANGES])
    const b = open(browser.tab())
    const mine = record()
    b.subscribe('firestore.changes', CHANGES, mine.listener)
    await settle()
    const first = browser.engine.last()
    browser.engine.ev(browser.engine.held()[1]?.id ?? '', 'change', 'e.7', { changes: [] })
    await settle()

    a.tab.document.hide()
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.releaseMs - 1)
    expect(first.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(first.closed).toBe(true)
    expect(a.channel.status.getState()).toMatchObject({ status: 'paused', leader: false })
    expect(b.status.getState().leader).toBe(true)
    expect(browser.engine.live()).toHaveLength(1)
    browser.engine.hello()
    await settle()
    const add = browser.engine.posts.at(-1)?.add ?? []
    expect(add).toEqual([expect.objectContaining({ topic: 'firestore.changes', after: 'e.7' })])
    expect(add[0]?.id.startsWith(`${b.tab}.`)).toBe(true)

    // Shown again, the old leader follows and resumes from its own cursor.
    a.tab.document.show()
    await settle()
    expect(browser.engine.held()).toHaveLength(2)
  })

  it('a tab that crashed has its subscriptions pruned', async () => {
    await leaderWith(['firestore.changes', CHANGES])
    const tab = browser.tab()
    const b = open(tab)
    b.subscribe('logs.entries', {}, record().listener)
    await settle()
    const id = browser.engine.idOf('logs.entries')
    // The browser frees a crashed tab's locks; it sends nothing on the way out.
    tab.relay?.close()
    browser.locks.forceRelease(`${TAB_LOCK_PREFIX}${b.tab}`)
    await settle()
    expect(browser.engine.posts.at(-1)?.remove).toEqual([id])
    expect(browser.engine.held().map((sub) => sub.topic)).toEqual(['firestore.changes'])
  })

  it('freeze and pagehide give the subscriptions back at once', async () => {
    const a = await leaderWith(['firestore.changes', CHANGES])
    a.tab.document.dispatchEvent(new Event('freeze'))
    await settle()
    expect(browser.engine.live()).toHaveLength(0)
    expect(a.channel.status.getState().status).toBe('paused')

    a.tab.document.dispatchEvent(new Event('resume'))
    await settle()
    expect(browser.engine.live()).toHaveLength(1)
    a.tab.window.dispatchEvent(new Event('pagehide'))
    await settle()
    expect(browser.engine.live()).toHaveLength(0)
  })

  it('the last subscriber leaving closes the connection after 5 s', async () => {
    const tab = browser.tab()
    const channel = open(tab)
    const unsubscribe = channel.subscribe('firestore.changes', CHANGES, record().listener)
    await settle()
    browser.engine.hello()
    await settle()
    unsubscribe()
    await settle()
    expect(browser.engine.posts.at(-1)?.remove).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(browser.engine.live()).toHaveLength(1)
    // A navigation within the wait keeps it.
    channel.subscribe('firestore.rules', CHANGES, record().listener)
    await vi.advanceTimersByTimeAsync(10)
    expect(browser.engine.live()).toHaveLength(1)
  })

  it('without Web Locks every visible tab leads itself', async () => {
    browser = new FakeBrowser(false)
    const a = open(browser.tab())
    const b = open(browser.tab())
    a.subscribe('firestore.changes', CHANGES, record().listener)
    b.subscribe('firestore.changes', CHANGES, record().listener)
    await settle()
    expect(browser.engine.live()).toHaveLength(2)
    expect(a.status.getState().leader).toBe(true)
    expect(b.status.getState().leader).toBe(true)
  })
})

describe('reconnecting and restarts', () => {
  it('a reconnect adds every subscription again from its last cursor', async () => {
    const a = await leaderWith(['firestore.changes', CHANGES])
    browser.engine.ev(browser.engine.idOf('firestore.changes'), 'change', 'e.5', { changes: [] })
    await settle()
    browser.engine.drop()
    await settle()
    expect(a.channel.status.getState().status).toBe('reconnecting')
    browser.engine.hello()
    await settle()
    expect(a.channel.status.getState().status).toBe('live')
    expect(browser.engine.posts.at(-1)?.add).toEqual([
      expect.objectContaining({ topic: 'firestore.changes', after: 'e.5' }),
    ])
  })

  it('a new engine instance drops the cursors, reloads and calls back once', async () => {
    const onRestart = vi.fn()
    const onRestarted = vi.fn()
    const tab = browser.tab()
    const channel = open(tab, { onRestart, onRestarted })
    const restarted = vi.fn()
    channel.onEngineRestart(restarted)
    channel.subscribe('firestore.changes', CHANGES, record().listener)
    await settle()
    browser.engine.hello()
    await settle()
    browser.engine.ev(browser.engine.idOf('firestore.changes'), 'change', 'e.5', { changes: [] })
    browser.engine.drop()
    browser.engine.instance = 'i2'
    browser.engine.hello()
    await settle()
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(restarted).toHaveBeenCalledTimes(1)
    expect(onRestarted).toHaveBeenCalledTimes(1)
    expect(onRestart.mock.invocationCallOrder[0]).toBeLessThan(
      restarted.mock.invocationCallOrder[0] ?? 0,
    )
    expect(browser.engine.posts.at(-1)?.add[0]?.after).toBeUndefined()
    expect(channel.status.getState()).toMatchObject({ instance: 'i2', engineUpdated: false })
  })

  it('a new instance of another build is an update: nothing reloads, the page asks to be reloaded', async () => {
    const onRestart = vi.fn()
    const tab = browser.tab()
    const channel = open(tab, { onRestart })
    channel.subscribe('firestore.changes', CHANGES, record().listener)
    await settle()
    browser.engine.hello()
    await settle()
    browser.engine.drop()
    browser.engine.instance = 'i2'
    browser.engine.engineRevision = 'r2'
    browser.engine.hello()
    await settle()
    expect(onRestart).not.toHaveBeenCalled()
    expect(channel.status.getState().engineUpdated).toBe(true)
  })

  it('a follower tab judges a restart for itself', async () => {
    await leaderWith(['firestore.changes', CHANGES])
    const onRestart = vi.fn()
    const b = open(browser.tab(), { onRestart })
    b.subscribe('firestore.rules', CHANGES, record().listener)
    await settle()
    browser.engine.drop()
    browser.engine.instance = 'i2'
    browser.engine.hello()
    await settle()
    expect(onRestart).toHaveBeenCalledTimes(1)
  })

  it('stopping says offline at once', async () => {
    const a = await leaderWith(['firestore.changes', CHANGES])
    const b = open(browser.tab())
    b.subscribe('firestore.rules', CHANGES, record().listener)
    await settle()
    browser.engine.last().emit('stopping', '{}')
    await settle()
    expect(a.channel.status.getState().status).toBe('offline')
    expect(b.status.getState().status).toBe('offline')
  })

  it('a closed stream at the engine limit is too many tabs', async () => {
    const a = await leaderWith(['firestore.changes', CHANGES])
    browser.engine.probe = { connections: 64, limit: 64 }
    browser.engine.fail()
    await settle()
    expect(a.channel.status.getState().status).toBe('too-many')
  })

  it('a closed stream is retried with backoff, and says offline after 30 s', async () => {
    const a = await leaderWith(['firestore.changes', CHANGES])
    browser.engine.probeFails = true
    browser.engine.fail()
    await settle()
    expect(a.channel.status.getState().status).toBe('reconnecting')
    const count = () => browser.engine.sources.length
    const before = count()
    // The tab's random source answers 0.5 after its id: no jitter.
    await vi.advanceTimersByTimeAsync(499)
    expect(count()).toBe(before)
    await vi.advanceTimersByTimeAsync(1)
    expect(count()).toBe(before + 1)
    browser.engine.fail()
    await settle()
    await vi.advanceTimersByTimeAsync(999)
    expect(count()).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(1)
    expect(count()).toBe(before + 2)
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.offlineMs)
    expect(a.channel.status.getState().status).toBe('offline')
    browser.engine.hello()
    await settle()
    expect(a.channel.status.getState().status).toBe('live')
  })

  it('a source that is not open within 5 s is taken over', async () => {
    const tab = browser.tab()
    const channel = open(tab)
    channel.subscribe('firestore.changes', CHANGES, record().listener)
    await settle()
    const first = browser.engine.last()
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.connectingMs)
    expect(first.closed).toBe(true)
    expect(channel.status.getState().status).toBe('reconnecting')
  })

  it('reads its timings from firenook.console.live-timing', async () => {
    const tab = browser.tab()
    tab.storage.set(TIMING_KEY, JSON.stringify({ releaseMs: 500, offlineMs: 1000 }))
    expect(readTiming({ getItem: (key) => tab.storage.get(key) ?? null })).toMatchObject({
      releaseMs: 500,
      connectingMs: DEFAULT_TIMING.connectingMs,
      offlineMs: 1000,
    })
    const channel = open(tab)
    channel.subscribe('firestore.changes', CHANGES, record().listener)
    await settle()
    browser.engine.hello()
    await settle()
    tab.document.hide()
    await vi.advanceTimersByTimeAsync(500)
    expect(browser.engine.live()).toHaveLength(0)
    expect(readTiming({ getItem: () => 'not json' })).toEqual(DEFAULT_TIMING)
  })

  it('backs off from 0.5 s doubling to 10 s, each within 20 %', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(attempt, () => 0.5))).toEqual([
      500, 1000, 2000, 4000, 8000, 10_000, 10_000,
    ])
    expect(backoffDelay(0, () => 0)).toBe(400)
    expect(backoffDelay(0, () => 1)).toBe(600)
    expect(backoffDelay(40, () => 1)).toBe(12_000)
  })
})

describe('one subscription', () => {
  it('reset and end reach only the subscription they name', async () => {
    const a = await leaderWith(['firestore.changes', CHANGES], ['logs.entries', {}])
    const [changes, logs] = a.recorded
    browser.engine.reset(browser.engine.idOf('firestore.changes'), 'gap', 3120)
    await settle()
    expect(changes?.resets).toEqual([{ reason: 'gap', missed: 3120 }])
    expect(logs?.resets).toEqual([])
    browser.engine.end(browser.engine.idOf('logs.entries'), undefined)
    await settle()
    expect(logs?.ends).toEqual([undefined])
    expect(logs?.states.at(-1)).toBe('finished')
    expect(changes?.ends).toEqual([])
  })

  it('ended with an error, it comes back by itself with backoff', async () => {
    const a = await leaderWith(['logs.entries', {}])
    const [logs] = a.recorded
    const first = browser.engine.idOf('logs.entries')
    browser.engine.end(first, GONE)
    await settle()
    expect(logs?.ends).toEqual([GONE])
    expect(logs?.states.at(-1)).toBe('ended')
    const posts = browser.engine.posts.length
    await vi.advanceTimersByTimeAsync(500)
    await settle()
    expect(browser.engine.posts).toHaveLength(posts + 1)
    const again = browser.engine.idOf('logs.entries')
    // A new engine subscription: ids are never reused on a connection.
    expect(again).not.toBe(first)
    expect(logs?.states.at(-1)).toBe('active')
  })

  it('a refused subscription says why', async () => {
    browser.engine.refuse.set('shell', {
      code: 'invalid-argument',
      message: 'No live topic named `shell`.',
    })
    const a = await leaderWith(['shell', {}], ['firestore.changes', CHANGES])
    const [shell, changes] = a.recorded
    expect(shell?.states.at(-1)).toBe('refused')
    expect(shell?.refused[0]?.message).toBe('No live topic named `shell`.')
    expect(changes?.states.at(-1)).toBe('active')
    // A refused subscription still keeps the tab connected: the connection
    // also says when the engine stops.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(browser.engine.live()).toHaveLength(1)
  })

  it('unsubscribing removes the engine subscription', async () => {
    const tab = browser.tab()
    const channel = open(tab)
    const stay = channel.subscribe('firestore.changes', CHANGES, record().listener)
    const leave = channel.subscribe('logs.entries', {}, record().listener)
    await settle()
    browser.engine.hello()
    await settle()
    const id = browser.engine.idOf('logs.entries')
    leave()
    await settle()
    expect(browser.engine.posts.at(-1)?.remove).toEqual([id])
    stay()
  })
})
