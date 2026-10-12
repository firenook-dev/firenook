// The ring every feed keeps (log lines, invocations, delivery attempts,
// decisions). A feed can take ten thousand items a second, so the store is
// not React state: it is a bounded deque outside React, read by index from
// a virtualized list, that tells its readers at most once per animation
// frame however many items arrived.
//
// Rows are items, gap rows ("3,120 entries were missed") and markers ("Engine
// restarted", "1,204 lines arrived while paused · Load them"). Only items
// count against `max`; every row leaves from the front, oldest first, so a
// gap row is never evicted before the rows older than it.

import { useSyncExternalStore } from 'react'

export type FeedRow<T> =
  | { kind: 'item'; item: T }
  | { kind: 'gap'; missed: number | null; kept: number }
  /** A row that is not an item: "Engine restarted", "50 more starts in this burst", "1,204 lines arrived while paused · Load them". */
  | { kind: 'marker'; key: string; text: string; action?: { label: string; run: () => void } }

export interface FeedStore<T> {
  push(items: readonly T[]): void
  /** Replaces items by key in place (the row keeps its position) and appends unknown keys:
   *  an invocation running → finished, an Inbox message marked used, a push streak. */
  upsert(items: readonly T[]): void
  /** Older rows at the front (a "Load older" page); the reader's anchor does not move. */
  prepend(items: readonly T[]): void
  /** Swaps the newest row (×N repeat groups). */
  replaceLast(item: T): void
  /** A marker row at the end; never counted as an item, evicted like one. */
  marker(row: Extract<FeedRow<T>, { kind: 'marker' }>): void
  /** On `reset`: keeps what it has and appends a gap row ("3,120 entries were missed; the engine keeps the last 10,000"), then the retained window follows. */
  gap(missed: number | null, kept: number): void
  /** While the reader is paused. 'buffer': no eviction up to `pauseMax`; past it, evicts and reports the
   *  evicted rows' keys so the list corrects its offset. 'freeze': pushes are counted, not appended. */
  pause(): void
  resume(): void
  /** Pushes counted while paused in 'freeze' mode (the pill's number). */
  pending(): number
  clear(): void
  size(): number
  /** 0 is the oldest kept. */
  at(index: number): FeedRow<T> | undefined
  indexOf(key: string): number
  /** How many items were evicted since the last clear. */
  dropped(): number
  /** Called with the keys evicted from the front while paused (and when `resume` trims). */
  onEvict(listener: (keys: readonly string[]) => void): () => void
  subscribe(listener: () => void): () => void
  version(): number
  /** The figures readers draw from, one object per change (`useFeed` hands it out). */
  snapshot(): FeedSnapshot
}

/**
 * A feed's figures at one change. The store itself is mutable and outside
 * React, so a component reads these from the object `useFeed` returns,
 * never by calling the store while it renders: the React compiler keeps a
 * call's answer for as long as its arguments are the same objects, and the
 * store is always the same object.
 */
export interface FeedSnapshot {
  size: number
  version: number
  dropped: number
  pending: number
}

/** Non-item rows a feed keeps at most, so markers alone can never grow it without bound. */
const MAX_OTHER_ROWS = 1_000

/** A key for a row that is not an item; never a key an item could have. */
function rowKey<T>(row: FeedRow<T>, itemKey: (item: T) => string, seq: number): string {
  if (row.kind === 'item') return itemKey(row.item)
  if (row.kind === 'marker') return `\u0000marker:${row.key}`
  return `\u0000gap:${seq}`
}

/** Runs `notify` once per animation frame, however often it is asked for. */
function frameScheduler(notify: () => void) {
  let scheduled = false
  const frame =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (run: () => void) => setTimeout(run, 16)
  return () => {
    if (scheduled) return
    scheduled = true
    frame(() => {
      scheduled = false
      notify()
    })
  }
}

export function createFeedStore<T>(options: {
  max: number
  pauseMax?: number
  key: (item: T) => string
  pausedMode?: 'freeze' | 'buffer'
}): FeedStore<T> {
  const { max, key } = options
  const pauseMax = Math.max(options.pauseMax ?? 50_000, max)
  const pausedMode = options.pausedMode ?? 'buffer'

  // A deque over a power-of-two ring: row `i` (0 = oldest) lives at
  // `(start + i) & mask`. `start` is an absolute sequence number, which also
  // gives every row a position that survives evictions and prepends.
  let capacity = 16
  let slots: Array<FeedRow<T> | undefined> = Array.from({ length: capacity })
  let start = 0
  let count = 0
  let items = 0
  let others = 0
  const index = new Map<string, number>()
  let evicted = 0
  let paused = false
  let counted = 0
  let changes = 0
  let figures: FeedSnapshot = { size: 0, version: 0, dropped: 0, pending: 0 }
  const listeners = new Set<() => void>()
  const evictListeners = new Set<(keys: readonly string[]) => void>()
  const schedule = frameScheduler(() => {
    for (const listener of listeners) listener()
  })

  const slot = (seq: number) => seq & (capacity - 1)
  const rowAt = (seq: number) => slots[slot(seq)]

  function grow() {
    const next: Array<FeedRow<T> | undefined> = Array.from({ length: capacity * 2 })
    for (let offset = 0; offset < count; offset += 1)
      next[(start + offset) & (capacity * 2 - 1)] = rowAt(start + offset)
    slots = next
    capacity *= 2
  }

  function changed() {
    changes += 1
    schedule()
  }

  function tally(row: FeedRow<T>, by: 1 | -1) {
    if (row.kind === 'item') items += by
    else others += by
  }

  function append(row: FeedRow<T>) {
    if (count === capacity) grow()
    const seq = start + count
    slots[slot(seq)] = row
    count += 1
    tally(row, 1)
    index.set(rowKey(row, key, seq), seq)
  }

  function evictFront(): string {
    const seq = start
    const row = rowAt(seq)
    slots[slot(seq)] = undefined
    start += 1
    count -= 1
    if (!row) return ''
    tally(row, -1)
    const name = rowKey(row, key, seq)
    if (index.get(name) === seq) index.delete(name)
    if (row.kind === 'item') evicted += 1
    return name
  }

  /** Evicts from the front down to `limit` items; reports the keys while paused. */
  function trim(limit: number, report: boolean) {
    const gone: string[] = []
    // `evictFront` lowers the counts the loop reads.
    for (;;) {
      if (count === 0 || (items <= limit && others <= MAX_OTHER_ROWS)) break
      gone.push(evictFront())
    }
    if (report && gone.length > 0) for (const listener of evictListeners) listener(gone)
  }

  function settle() {
    if (!paused) trim(max, false)
    else if (pausedMode === 'buffer') trim(pauseMax, true)
  }

  function appendItems(list: readonly T[]) {
    if (list.length === 0) return
    if (paused && pausedMode === 'freeze') {
      counted += list.length
      changed()
      return
    }
    for (const item of list) {
      const existing = index.get(key(item))
      // A key already kept is the same item again (a replay overlapping
      // what is shown): it is updated where it is, never listed twice.
      if (existing !== undefined && rowAt(existing)?.kind === 'item')
        slots[slot(existing)] = { kind: 'item', item }
      else append({ kind: 'item', item })
    }
    settle()
    changed()
  }

  return {
    push: appendItems,
    upsert(list) {
      const fresh: T[] = []
      let replaced = false
      for (const item of list) {
        const existing = index.get(key(item))
        if (existing !== undefined && rowAt(existing)?.kind === 'item') {
          slots[slot(existing)] = { kind: 'item', item }
          replaced = true
        } else fresh.push(item)
      }
      if (replaced) changed()
      appendItems(fresh)
    },
    prepend(list) {
      if (list.length === 0) return
      // Oldest first in `list`; written front-to-back so it stays that way.
      for (let offset = list.length - 1; offset >= 0; offset -= 1) {
        const item = list[offset] as T
        if (index.has(key(item))) continue
        if (count === capacity) grow()
        start -= 1
        count += 1
        const row: FeedRow<T> = { kind: 'item', item }
        slots[slot(start)] = row
        tally(row, 1)
        index.set(key(item), start)
      }
      // Older rows were asked for: they are not evicted to make room for
      // themselves, but the feed stays bounded from the newest end's view.
      changed()
    },
    replaceLast(item) {
      if (count === 0) {
        appendItems([item])
        return
      }
      const seq = start + count - 1
      const previous = rowAt(seq)
      if (previous) {
        const name = rowKey(previous, key, seq)
        if (index.get(name) === seq) index.delete(name)
        tally(previous, -1)
      }
      const row: FeedRow<T> = { kind: 'item', item }
      slots[slot(seq)] = row
      tally(row, 1)
      index.set(key(item), seq)
      changed()
    },
    marker(row) {
      const existing = index.get(rowKey(row, key, 0))
      if (existing !== undefined) slots[slot(existing)] = row
      else append(row)
      settle()
      changed()
    },
    gap(missed, kept) {
      append({ kind: 'gap', missed, kept })
      settle()
      changed()
    },
    pause() {
      if (paused) return
      paused = true
      changed()
    },
    resume() {
      if (!paused) return
      paused = false
      counted = 0
      trim(max, true)
      changed()
    },
    pending: () => counted,
    clear() {
      slots = Array.from({ length: 16 })
      capacity = 16
      start = 0
      count = 0
      items = 0
      others = 0
      index.clear()
      evicted = 0
      counted = 0
      changed()
    },
    size: () => count,
    at: (position) =>
      position >= 0 && position < count && Number.isInteger(position)
        ? rowAt(start + position)
        : undefined,
    indexOf(name) {
      const seq = index.get(name)
      return seq === undefined ? -1 : seq - start
    },
    dropped: () => evicted,
    onEvict(listener) {
      evictListeners.add(listener)
      return () => {
        evictListeners.delete(listener)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    version: () => changes,
    snapshot() {
      if (figures.version !== changes)
        figures = { size: count, version: changes, dropped: evicted, pending: counted }
      return figures
    },
  }
}

/** Re-renders at most once per animation frame, with the figures of the latest change. */
export function useFeed<T>(store: FeedStore<T>): FeedSnapshot {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
}
