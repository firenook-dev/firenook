import { describe, expect, it } from 'vitest'
import type { LogEntry } from '@/api/generated/observe/LogEntry'
import type { LogPage } from '@/api/generated/observe/LogPage'
import type { LiveChannel, SubscribeOptions, TopicListener } from '@/lib/live/channel'
import type { LogsView, PagePosition } from './api'
import { FEED_MAX, type FeedOpen, LogFeed, gapWords, pausedWords, topicParams } from './feed'
import type { LogItem } from './rows'

const EPOCH = 'e1'
const entry = (seq: number, over: Partial<LogEntry> = {}): LogEntry => ({
  cursor: `${EPOCH}.${seq}`,
  time: new Date(Date.UTC(2026, 9, 12, 4, 0, 0, seq)).toISOString(),
  level: 'info',
  service: 'functions',
  message: `line ${seq}`,
  ...over,
})
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => entry(from + index))
const page = (items: LogEntry[], over: Partial<LogPage> = {}): LogPage => ({
  items,
  older: null,
  newer: null,
  tail: items.at(-1)?.cursor ?? `${EPOCH}.0`,
  anchor: null,
  ...over,
})

interface Sub {
  topic: string
  params: object
  listener: TopicListener
  options: SubscribeOptions | undefined
  closed: boolean
}

function fakeChannel() {
  const subs: Sub[] = []
  const restarts = new Set<() => void>()
  const channel: LiveChannel = {
    subscribe(topic, params, listener, options) {
      const sub: Sub = { topic, params, listener, options, closed: false }
      subs.push(sub)
      return () => {
        sub.closed = true
      }
    },
    onEngineRestart(callback) {
      restarts.add(callback)
      return () => restarts.delete(callback)
    },
    retry: () => undefined,
  }
  const live = () => subs.filter((sub) => !sub.closed)
  return {
    channel,
    subs,
    live,
    /** Sends lines on the open subscription, the last one's cursor as the event's. */
    send(items: LogEntry[]) {
      const sub = live().at(-1)
      if (!sub) throw new Error('nothing subscribed')
      sub.listener.onEvent('entries', { items }, items.at(-1)?.cursor)
    },
    restart: () => {
      for (const callback of restarts) callback()
    },
  }
}

function fakeVisibility() {
  let hidden = false
  const listeners = new Set<() => void>()
  return {
    visibility: {
      hidden: () => hidden,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    set(next: boolean) {
      hidden = next
      for (const listener of listeners) listener()
    },
  }
}

/** A feed over a fake engine: `pages` answers each page request. */
function setup(
  pages: (view: LogsView, position: PagePosition) => LogPage,
  options: { keep?: boolean } = {},
) {
  const live = fakeChannel()
  const shown = fakeVisibility()
  const asked: PagePosition[] = []
  const feed = new LogFeed({
    channel: live.channel,
    visibility: shown.visibility,
    keepAcrossRestarts: () => options.keep ?? false,
    fetchPage: async (view, position) => {
      asked.push(position)
      return pages(view, position)
    },
  })
  const detach = feed.attach()
  return { feed, live, shown, asked, detach }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** What the store holds, as words: `line 3`, `×2 line 4`, `edge start`, `marker …`. */
function rows(feed: LogFeed): string[] {
  const out: string[] = []
  for (let index = 0; index < feed.store.size(); index += 1) {
    const row = feed.store.at(index)
    if (!row) continue
    if (row.kind === 'marker') out.push(`marker ${row.text}`)
    else if (row.kind === 'gap') out.push('gap')
    else out.push(describe_(row.item))
  }
  return out
}
function describe_(item: LogItem): string {
  if (item.kind === 'edge') return `edge ${item.edge}`
  return item.repeat > 1 ? `×${item.repeat} ${item.entry.message}` : item.entry.message
}

/** Pauses as the page does: the list freezes the store, the page tells the feed. */
function pause(feed: LogFeed) {
  feed.store.pause()
  feed.setPaused(true)
}
function resume(feed: LogFeed) {
  feed.store.resume()
  feed.setPaused(false)
}

const OPEN: FeedOpen = { view: { q: 'level:info' } }

describe('the Logs feed', () => {
  it('opens on the newest page, then subscribes after its tail', async () => {
    const { feed, live, asked } = setup(() => page(range(1, 3), { older: `${EPOCH}.1` }))
    feed.open(OPEN)
    expect(feed.getState().phase).toBe('loading')
    await settle()
    expect(asked).toEqual([{}])
    expect(rows(feed)).toEqual(['line 1', 'line 2', 'line 3'])
    expect(feed.getState()).toMatchObject({ phase: 'ready', mode: 'tail', hasMore: true })
    expect(live.live()).toHaveLength(1)
    expect(live.subs[0]).toMatchObject({
      topic: 'logs.entries',
      params: { q: 'level:info' },
      options: { after: `${EPOCH}.3` },
    })
    live.send([entry(4), entry(5)])
    expect(rows(feed)).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'line 5'])
  })

  it('says where the log begins above the first page, and nothing above no lines', async () => {
    const first = setup(() => page(range(1, 2)))
    first.feed.open(OPEN)
    await settle()
    expect(rows(first.feed)).toEqual(['edge start', 'line 1', 'line 2'])
    const empty = setup(() => page([]))
    empty.feed.open(OPEN)
    await settle()
    expect(rows(empty.feed)).toEqual([])
  })

  it('groups a line printed again and again, live too', async () => {
    const same = (seq: number) => entry(seq, { message: 'heartbeat ok' })
    const { feed, live } = setup(() => page([same(1), same(2)], { older: 'x' }))
    feed.open(OPEN)
    await settle()
    expect(rows(feed)).toEqual(['×2 heartbeat ok'])
    live.send([same(3), entry(4)])
    expect(rows(feed)).toEqual(['×3 heartbeat ok', 'line 4'])
  })

  it('freezes while paused: nothing is appended, and what arrived is counted', async () => {
    const { feed, live } = setup(() => page(range(1, 2), { older: 'x' }))
    feed.open(OPEN)
    await settle()
    pause(feed)
    live.send(range(3, 7))
    expect(rows(feed)).toEqual(['line 1', 'line 2'])
    expect(feed.store.pending()).toBe(5)
  })

  it('resumes by replaying from where it paused when at most 1,000 lines arrived', async () => {
    const { feed, live } = setup(() => page(range(1, 2), { older: 'x' }))
    feed.open(OPEN)
    await settle()
    pause(feed)
    live.send(range(3, 5))
    resume(feed)
    const replay = live.live()
    expect(replay).toHaveLength(1)
    expect(replay[0]?.options).toEqual({ after: `${EPOCH}.2` })
    live.send(range(3, 6))
    expect(rows(feed)).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'])
  })

  it('reopens at the newest page under a marker when more arrived than a replay carries', async () => {
    let tail = 2
    const { feed, live, asked } = setup((_, position) =>
      'before' in position && position.before
        ? page(range(1000, 1499), { older: null })
        : page(range(tail - 1, tail), { older: `${EPOCH}.${tail - 1}` }),
    )
    feed.open(OPEN)
    await settle()
    pause(feed)
    live.send(range(3, 1204))
    tail = 1204
    resume(feed)
    await settle()
    expect(asked.at(-1)).toEqual({})
    expect(rows(feed)).toEqual([`marker ${pausedWords(1202, false)}`, 'line 1203', 'line 1204'])
    expect(live.live().at(-1)?.options).toEqual({ after: `${EPOCH}.1204` })
    const marker = feed.store.at(0)
    expect(marker?.kind === 'marker' && marker.action?.label).toBe('Load them')
    if (marker?.kind === 'marker') marker.action?.run()
    await settle()
    expect(rows(feed)[0]).toBe('edge start')
    expect(rows(feed)).toContain(`marker ${pausedWords(1202, true)}`)
  })

  it('gives its subscription back at once when hidden, and resumes from its cursor when shown', async () => {
    const { feed, live, shown } = setup(() => page(range(1, 2), { older: 'x' }))
    feed.open(OPEN)
    await settle()
    live.send([entry(3)])
    shown.set(true)
    expect(live.live()).toHaveLength(0)
    expect(feed.getState().live).toBe('off')
    shown.set(false)
    expect(live.live()).toHaveLength(1)
    expect(live.live()[0]?.options).toEqual({ after: `${EPOCH}.3` })
  })

  it('opened while hidden, it subscribes only once shown', async () => {
    const { feed, live, shown } = setup(() => page(range(1, 2), { older: 'x' }))
    shown.set(true)
    feed.open(OPEN)
    await settle()
    expect(live.live()).toHaveLength(0)
    shown.set(false)
    expect(live.live()[0]?.options).toEqual({ after: `${EPOCH}.2` })
  })

  it('says how many lines a gap lost, or that they belong to an earlier run', async () => {
    const { feed, live } = setup(() => page(range(1, 2), { older: 'x' }))
    feed.open(OPEN)
    await settle()
    live.live()[0]?.listener.onReset('gap', 312)
    live.live()[0]?.listener.onReset('gap', null)
    expect(rows(feed).slice(-2)).toEqual([
      `marker ${gapWords('gap', 312)}`,
      `marker ${gapWords('gap', null)}`,
    ])
    expect(gapWords('gap', 312)).toBe(
      '312 lines were missed here; the engine keeps the newest 20,000.',
    )
    expect(gapWords('gap', null)).toBe('Lines from before the engine restarted are not shown.')
  })

  it('clears on an engine restart, or marks it when lines are kept across restarts', async () => {
    const cleared = setup(() => page(range(1, 2), { older: 'x' }))
    cleared.feed.open(OPEN)
    await settle()
    cleared.live.restart()
    expect(rows(cleared.feed)).toEqual([])
    const kept = setup(() => page(range(1, 2), { older: 'x' }), { keep: true })
    kept.feed.open(OPEN)
    await settle()
    kept.live.restart()
    expect(rows(kept.feed)).toEqual(['line 1', 'line 2', 'marker Engine restarted'])
  })

  it('drops the oldest rows at the cap while following, and loads older again after', async () => {
    const { feed, live } = setup(() => page(range(1, 10), { older: null }))
    feed.open(OPEN)
    await settle()
    expect(feed.getState().hasMore).toBe(false)
    live.send(range(11, FEED_MAX + 20))
    expect(feed.store.size()).toBe(FEED_MAX)
    expect(feed.getState().hasMore).toBe(true)
  })

  it('loads older pages at the top, and stops at the cap', async () => {
    const { feed, asked } = setup((_, position) =>
      'before' in position && position.before
        ? page(range(1, 3), { older: null })
        : page(range(4, 5), { older: `${EPOCH}.4` }),
    )
    feed.open(OPEN)
    await settle()
    feed.loadOlder()
    expect(feed.getState().loadingOlder).toBe(true)
    await settle()
    expect(asked.at(-1)).toEqual({ before: `${EPOCH}.4` })
    expect(rows(feed)).toEqual(['edge start', 'line 1', 'line 2', 'line 3', 'line 4', 'line 5'])
    expect(feed.getState()).toMatchObject({ hasMore: false, loadingOlder: false })

    const full = setup(() => page(range(1, FEED_MAX), { older: `${EPOCH}.1` }))
    full.feed.open(OPEN)
    await settle()
    full.feed.loadOlder()
    expect(rows(full.feed)[0]).toBe('edge cap')
    expect(full.feed.getState().hasMore).toBe(false)
  })

  it('opens around a line, paused and following nothing', async () => {
    const { feed, live, asked } = setup(() =>
      page(range(40, 60), { older: `${EPOCH}.40`, anchor: `${EPOCH}.50` }),
    )
    feed.open({ ...OPEN, entry: `${EPOCH}.50` })
    await settle()
    expect(asked).toEqual([{ around: `${EPOCH}.50` }])
    expect(feed.getState()).toMatchObject({
      mode: 'around',
      focus: { key: `${EPOCH}.50`, align: 'center', pause: true },
    })
    expect(live.live()).toHaveLength(0)
  })

  it('falls back to the newest lines when the line cannot be opened around', async () => {
    const { feed, asked } = setup((_, position) => {
      if ('around' in position) throw new Error('This line was logged by an earlier run.')
      return page(range(1, 2), { older: 'x' })
    })
    feed.open({ ...OPEN, entry: 'other.5' })
    await settle()
    await settle()
    expect(asked).toEqual([{ around: 'other.5' }, {}])
    expect(feed.getState().mode).toBe('tail')
  })

  it('puts "New since your last visit" before the first newer line', async () => {
    const { feed } = setup(() => page(range(1, 4), { older: 'x' }))
    feed.open({ ...OPEN, since: `${EPOCH}.2` })
    await settle()
    expect(rows(feed)).toEqual([
      'line 1',
      'line 2',
      'marker New since your last visit',
      'line 3',
      'line 4',
    ])
    expect(feed.getState().focus).toMatchObject({ key: '\u0000marker:since', pause: false })
  })

  it('keeps a cleared view: older lines are left out, and the edge says so', async () => {
    const { feed, live } = setup(() => page(range(1, 5), { older: 'x' }))
    feed.open({ ...OPEN, cleared: { cursor: `${EPOCH}.3`, at: '2026-10-12T04:00:00Z' } })
    await settle()
    expect(rows(feed)).toEqual(['edge cleared', 'line 4', 'line 5'])
    expect(feed.getState().hasMore).toBe(false)
    live.send([entry(6)])
    expect(rows(feed).at(-1)).toBe('line 6')
  })

  it('subscribes with only the parameters set, and stops when detached', async () => {
    expect(topicParams({ q: '  ' })).toEqual({})
    expect(topicParams({ q: 'x', from: '-5m', to: undefined })).toEqual({ q: 'x', from: '-5m' })
    const { feed, live, detach } = setup(() => page(range(1, 2)))
    feed.open(OPEN)
    await settle()
    detach()
    expect(live.live()).toHaveLength(0)
  })
})
