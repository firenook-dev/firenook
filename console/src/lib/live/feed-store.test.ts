import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type FeedRow, createFeedStore } from './feed-store'

interface Line {
  id: string
  text: string
}

const line = (id: string, text = id): Line => ({ id, text })
const lines = (...ids: string[]) => ids.map((id) => line(id))

function rows(store: { size(): number; at(index: number): FeedRow<Line> | undefined }): string[] {
  const out: string[] = []
  for (let index = 0; index < store.size(); index += 1) {
    const row = store.at(index)
    if (!row) out.push('?')
    else if (row.kind === 'item') out.push(row.item.text)
    else if (row.kind === 'gap') out.push(`gap:${row.missed ?? 'n'}/${row.kept}`)
    else out.push(`marker:${row.key}`)
  }
  return out
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the feed store', () => {
  it('evicts the oldest past max, counts what it dropped and reads by index after wrapping', () => {
    const store = createFeedStore<Line>({ max: 3, key: (item) => item.id })
    store.push(lines('a', 'b', 'c', 'd'))
    store.push(lines('e'))
    expect(rows(store)).toEqual(['c', 'd', 'e'])
    expect(store.dropped()).toBe(2)
    expect(store.indexOf('d')).toBe(1)
    expect(store.indexOf('a')).toBe(-1)
    // Many more than the starting capacity, wrapping the ring several times.
    store.push(Array.from({ length: 50 }, (_, index) => line(`n${index}`)))
    expect(rows(store)).toEqual(['n47', 'n48', 'n49'])
    expect(store.at(3)).toBeUndefined()
    store.clear()
    expect(store.size()).toBe(0)
    expect(store.dropped()).toBe(0)
  })

  it('tells its readers once per frame however many pushes arrive', async () => {
    const store = createFeedStore<Line>({ max: 10_000, key: (item) => item.id })
    const heard = vi.fn()
    store.subscribe(heard)
    for (let index = 0; index < 1_000; index += 1) store.push([line(`l${index}`)])
    expect(heard).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(20)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(store.version()).toBe(1_000)
  })

  it('hands its readers one figures object per change, the same one until the next', () => {
    const store = createFeedStore<Line>({ max: 2, key: (item) => item.id, pausedMode: 'freeze' })
    const empty = store.snapshot()
    expect(empty).toEqual({ size: 0, version: 0, dropped: 0, pending: 0 })
    expect(store.snapshot()).toBe(empty)
    store.push(lines('a', 'b', 'c'))
    const filled = store.snapshot()
    expect(filled).toEqual({ size: 2, version: 1, dropped: 1, pending: 0 })
    expect(filled).not.toBe(empty)
    expect(store.snapshot()).toBe(filled)
    store.pause()
    store.push(lines('d'))
    expect(store.snapshot()).toEqual({ size: 2, version: 3, dropped: 1, pending: 1 })
  })

  it('upserts in place, keeping the position, and appends what it does not know', () => {
    const store = createFeedStore<Line>({ max: 10, key: (item) => item.id })
    store.push(lines('a', 'b', 'c'))
    store.upsert([line('b', 'b finished'), line('d')])
    expect(rows(store)).toEqual(['a', 'b finished', 'c', 'd'])
    // A replay overlapping what is shown never lists an item twice.
    store.push([line('c', 'c again')])
    expect(rows(store)).toEqual(['a', 'b finished', 'c again', 'd'])
  })

  it('prepends older rows at the front, and the keys still find them', () => {
    const store = createFeedStore<Line>({ max: 10, key: (item) => item.id })
    store.push(lines('d', 'e'))
    store.prepend(lines('a', 'b', 'c'))
    expect(rows(store)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(store.indexOf('d')).toBe(3)
    store.prepend(lines('c'))
    expect(store.size()).toBe(5)
  })

  it('swaps the newest row for a repeat group', () => {
    const store = createFeedStore<Line>({ max: 10, key: (item) => item.id })
    store.push(lines('a', 'b'))
    store.replaceLast(line('b×3', 'b ×3'))
    expect(rows(store)).toEqual(['a', 'b ×3'])
    expect(store.indexOf('b')).toBe(-1)
    expect(store.indexOf('b×3')).toBe(1)
  })

  it('never counts markers as items, and evicts them in their turn', () => {
    const store = createFeedStore<Line>({ max: 2, key: (item) => item.id })
    store.push(lines('a'))
    store.marker({ kind: 'marker', key: 'restart', text: 'Engine restarted' })
    store.push(lines('b'))
    expect(rows(store)).toEqual(['a', 'marker:restart', 'b'])
    store.push(lines('c'))
    // `a` went first; the marker is now the oldest row.
    expect(rows(store)).toEqual(['marker:restart', 'b', 'c'])
    store.push(lines('d'))
    expect(rows(store)).toEqual(['c', 'd'])
  })

  it('a gap row says how much was missed and is never evicted before older rows', () => {
    const store = createFeedStore<Line>({ max: 3, key: (item) => item.id })
    store.push(lines('a', 'b'))
    store.gap(3120, 10_000)
    store.gap(null, 10_000)
    store.push(lines('c'))
    expect(rows(store)).toEqual(['a', 'b', 'gap:3120/10000', 'gap:n/10000', 'c'])
    store.push(lines('d'))
    expect(rows(store)).toEqual(['b', 'gap:3120/10000', 'gap:n/10000', 'c', 'd'])
  })

  it("'buffer' holds everything while paused up to the cap, then evicts and says which", () => {
    const store = createFeedStore<Line>({ max: 2, pauseMax: 4, key: (item) => item.id })
    const evicted: string[][] = []
    store.onEvict((keys) => evicted.push([...keys]))
    store.push(lines('a', 'b'))
    store.pause()
    store.push(lines('c', 'd'))
    expect(rows(store)).toEqual(['a', 'b', 'c', 'd'])
    expect(evicted).toEqual([])
    store.push(lines('e'))
    expect(rows(store)).toEqual(['b', 'c', 'd', 'e'])
    expect(evicted).toEqual([['a']])
    store.resume()
    expect(rows(store)).toEqual(['d', 'e'])
    expect(evicted.at(-1)).toEqual(['b', 'c'])
  })

  it("'freeze' counts pushes while paused instead of appending them", () => {
    const store = createFeedStore<Line>({ max: 10, key: (item) => item.id, pausedMode: 'freeze' })
    store.push(lines('a'))
    store.pause()
    store.push(lines('b', 'c'))
    store.push(lines('d'))
    expect(rows(store)).toEqual(['a'])
    expect(store.pending()).toBe(3)
    store.resume()
    expect(store.pending()).toBe(0)
    store.push(lines('e'))
    expect(rows(store)).toEqual(['a', 'e'])
  })
})
