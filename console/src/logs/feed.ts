// The Logs feed: the lines on screen, kept by a feed store outside React,
// read from the engine and followed on the `logs.entries` topic.
//
// - Open: the newest 500 matching lines (`GET /logs/entries`), then the topic
//   subscribed after that page's `tail` — no gap, no duplicate. A line the
//   URL names (`entry=`) opens the lines around it instead, paused: the
//   context is why the developer came. `since=` (the badge's link) puts a
//   "New since your last visit" marker before the first newer line.
// - Older lines load as the reader reaches the top (`before=`), up to the
//   20,000 rows the page holds; the top says where the log begins, where it
//   stopped loading, or where the view was cleared.
// - Paused freezes: nothing is appended (the store counts what arrives).
//   Resuming replays what arrived when it is at most 1,000 lines, otherwise
//   reopens at the newest page under "1,204 lines arrived while paused".
// - A hidden tab gives its subscription back at once, keeping the cursor,
//   and takes it again from there when shown: nothing is parsed while
//   nobody looks.
// - An engine restart (the channel's `onEngineRestart`) clears the feed —
//   or, when the developer keeps lines across restarts, marks the moment —
//   and the new run's lines replay through the same subscription from its
//   first: the page is not fetched again, so nothing shows twice.
// - A gap (`reset gap`, `missed`) is a row that says how many lines left
//   the engine before they reached this view.
//
// The controller is plain TypeScript with its collaborators handed in, so
// the tests drive it with a fake channel and a fake document; `useLogFeed`
// wires it to the page.

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ApiErrorDetail } from '@/api/generated/ApiErrorDetail'
import type { LogEntry } from '@/api/generated/observe/LogEntry'
import type { LogPage } from '@/api/generated/observe/LogPage'
import type { ResetReason } from '@/api/generated/live/ResetReason'
import { formatNumber } from '@/lib/format'
import type { LiveChannel, SubscriptionState, TopicListener } from '@/lib/live/channel'
import { type FeedStore, createFeedStore } from '@/lib/live/feed-store'
import type { LogEntries, LogsTopicParams } from '@/observe/live'
import '@/observe/live'
import { type LogsView, type PagePosition, fetchLogPage } from './api'
import { type LogItem, edgeItem, groupLines, isAfter, itemKey, lineItem } from './rows'
import type { ClearedAt } from './store'

/** Rows the page holds at most. */
export const FEED_MAX = 20_000
/** Lines that arrived while paused that a resume replays; more reopen at the newest page. */
export const RESUME_REPLAY_MAX = 1_000
/** Lines a second above which a following feed draws new rows unwrapped. */
export const FAST_RATE = 100
/** Lines after the "New since your last visit" marker past which the feed opens paused on it. */
const SINCE_IN_VIEW = 30

/** The engine's ring, for the words of a gap. */
const ENGINE_KEEPS = 20_000

/** What to open: the view, and a line or a mark to open at. */
export interface FeedOpen {
  view: LogsView
  /** A line to open around (`entry=`), paused. */
  entry?: string | undefined
  /** Put "New since your last visit" before the lines after this cursor (`since=`). */
  since?: string | undefined
  /** Where the view was cleared: older lines are not shown. */
  cleared?: ClearedAt | undefined
  /** Lines that arrived while paused, too many to replay: said above the newest page. */
  missed?: number | undefined
}

/** The feed's state, one object per change. */
export interface LogFeedState {
  phase: 'loading' | 'ready' | 'failed'
  error: unknown
  /** `around`: a page around one line, not following anything. */
  mode: 'tail' | 'around'
  /** A row to put in view once (the line opened by `entry`, the since marker), and whether to pause there. */
  focus: { key: string; align: 'center' | 'start'; pause: boolean } | undefined
  /** Older lines can be loaded at the top. */
  hasMore: boolean
  loadingOlder: boolean
  /** This page's subscription: `off` while it holds none (around, hidden, closed). */
  live: SubscriptionState | 'off'
  /** What the engine said when it ended or refused the subscription. */
  liveError: ApiErrorDetail | undefined
  /** Lines are arriving faster than `FAST_RATE` a second. */
  fast: boolean
  /** Where the view is cleared, while it is. */
  cleared: ClearedAt | undefined
  /** Bumps with every open, so a page can tell one view's state from the next. */
  generation: number
}

export interface LogFeedDeps {
  channel: LiveChannel
  fetchPage?: (view: LogsView, position: PagePosition, signal: AbortSignal) => Promise<LogPage>
  /** Whether the page is hidden, and a way to hear when that changes. */
  visibility: { hidden: () => boolean; subscribe: (listener: () => void) => () => void }
  /** "Keep lines across engine restarts", read at the restart. */
  keepAcrossRestarts: () => boolean
  /** Lines arrived: the counts on screen are behind. */
  onLines?: () => void
  now?: () => number
}

/** The topic's parameters for a view: only what is set (the engine denies anything else). */
export function topicParams(view: LogsView): LogsTopicParams {
  const params: LogsTopicParams = {}
  if (view.q.trim() !== '') params.q = view.q
  if (view.from) params.from = view.from
  if (view.to) params.to = view.to
  return params
}

/** The words of a gap row. */
export function gapWords(reason: ResetReason, missed: number | null): string {
  if (missed === null) return 'Lines from before the engine restarted are not shown.'
  const lines = `${formatNumber(missed)} ${missed === 1 ? 'line was' : 'lines were'} missed here`
  return reason === 'lagged'
    ? `${lines}; the console fell behind the engine.`
    : `${lines}; the engine keeps the newest ${formatNumber(ENGINE_KEEPS)}.`
}

/** The marker's words for lines that arrived while paused. */
export function pausedWords(count: number, loaded: boolean): string {
  const lines = `${formatNumber(count)} ${count === 1 ? 'line' : 'lines'}`
  return loaded
    ? `Following resumed here; ${lines} had arrived while paused`
    : `${lines} arrived while paused`
}

const INITIAL: LogFeedState = {
  phase: 'loading',
  error: undefined,
  mode: 'tail',
  focus: undefined,
  hasMore: false,
  loadingOlder: false,
  live: 'off',
  liveError: undefined,
  fast: false,
  cleared: undefined,
  generation: 0,
}

export class LogFeed {
  readonly store: FeedStore<LogItem>
  private readonly deps: LogFeedDeps
  private snapshot: LogFeedState = INITIAL
  private readonly listeners = new Set<() => void>()
  private view: LogsView = { q: '' }
  private generation = 0
  private abort: AbortController | undefined
  private olderAbort: AbortController | undefined
  private unsubscribe: (() => void) | undefined
  /** The newest line the engine has sent this view (a page's tail, then each event's). */
  private cursor: string | undefined
  /** The subscription was given back while the page was hidden. */
  private released = false
  private paused = false
  /** Lines that arrived while paused (the store counts them too, but forgets on resume). */
  private pausedCount = 0
  /** The cursor at the moment of pausing: a resume replays from here. */
  private pauseCursor: string | undefined
  private dropped = 0
  private markers = 0
  private arrivals: { at: number; count: number }[] = []

  constructor(deps: LogFeedDeps) {
    this.deps = deps
    this.store = createFeedStore<LogItem>({ max: FEED_MAX, key: itemKey, pausedMode: 'freeze' })
  }

  /**
   * Listens for engine restarts and the page being hidden; the returned
   * function stops listening and stops the feed (`open` starts it again).
   */
  attach(): () => void {
    const stopRestart = this.deps.channel.onEngineRestart(() => this.restarted())
    const stopVisibility = this.deps.visibility.subscribe(() => this.visibilityChanged())
    return () => {
      stopRestart()
      stopVisibility()
      this.generation += 1
      this.abort?.abort()
      this.olderAbort?.abort()
      this.stopFollowing()
    }
  }

  // The state, for `useSyncExternalStore`.
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getState = () => this.snapshot

  private set(patch: Partial<LogFeedState>) {
    let changed = false
    for (const [key, value] of Object.entries(patch))
      if (this.snapshot[key as keyof LogFeedState] !== value) changed = true
    if (!changed) return
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Opens a view: what it matches, newest last, then what arrives. */
  open(request: FeedOpen): void {
    this.generation += 1
    const generation = this.generation
    this.abort?.abort()
    this.olderAbort?.abort()
    this.stopFollowing()
    this.view = request.view
    this.cursor = undefined
    this.pausedCount = 0
    this.pauseCursor = undefined
    this.store.clear()
    this.dropped = 0
    const around = request.entry !== undefined
    this.set({
      phase: 'loading',
      error: undefined,
      mode: around ? 'around' : 'tail',
      focus: undefined,
      hasMore: false,
      loadingOlder: false,
      live: 'off',
      liveError: undefined,
      cleared: request.cleared,
      generation,
    })
    const abort = new AbortController()
    this.abort = abort
    const fetchPage = this.deps.fetchPage ?? fetchLogPage
    const position: PagePosition = around ? { around: request.entry ?? '' } : {}
    fetchPage(request.view, position, abort.signal).then(
      (page) => {
        if (generation !== this.generation) return
        if (around) this.showAround(page, request.entry ?? '')
        else this.showTail(page, request)
      },
      (error: unknown) => {
        if (generation !== this.generation || abort.signal.aborted) return
        // A line the engine cannot open around (from an earlier run) still
        // leaves the newest lines to read; the inspector says why.
        if (around) {
          this.open({ ...request, entry: undefined })
          return
        }
        this.set({ phase: 'failed', error })
      },
    )
  }

  /** Writes rows while the store is frozen by a pause (a page is not "what arrived"). */
  private unfrozen(write: () => void) {
    if (this.paused) this.store.resume()
    write()
    if (this.paused) this.store.pause()
  }

  private rowsOf(entries: readonly LogEntry[], cleared: ClearedAt | undefined) {
    const kept = cleared
      ? entries.filter((entry) => isAfter(entry.cursor, cleared.cursor))
      : entries
    return { rows: groupLines(kept).rows, crossed: kept.length < entries.length }
  }

  private showTail(page: LogPage, request: FeedOpen) {
    const { rows, crossed } = this.rowsOf(page.items, request.cleared)
    let focus: LogFeedState['focus']
    this.unfrozen(() => {
      // Above the newest page, when what arrived while paused reaches further back than it.
      if (request.missed !== undefined && page.older !== null) this.pausedMarker(request.missed)
      if (request.since !== undefined) {
        const split = rows.findIndex(
          (row) => row.kind === 'line' && isAfter(row.entry.cursor, request.since ?? ''),
        )
        const at = split === -1 ? rows.length : split
        this.store.push(rows.slice(0, at))
        this.store.marker({ kind: 'marker', key: 'since', text: 'New since your last visit' })
        this.store.push(rows.slice(at))
        const after = rows.length - at
        focus = { key: '\u0000marker:since', align: 'start', pause: after > SINCE_IN_VIEW }
      } else this.store.push(rows)
    })
    const edge = request.cleared && (crossed || page.older === null) ? 'cleared' : undefined
    if (edge) this.store.prepend([edgeItem(edge)])
    // Where the log begins says something only above lines: with none, the
    // page says why nothing matches instead.
    else if (page.older === null && rows.length > 0) this.store.prepend([edgeItem('start')])
    this.cursor = page.tail
    this.set({
      phase: 'ready',
      hasMore: edge === undefined && page.older !== null,
      focus,
    })
    this.follow()
  }

  private showAround(page: LogPage, entry: string) {
    const { rows } = this.rowsOf(page.items, undefined)
    this.unfrozen(() => this.store.push(rows))
    if (page.older === null) this.store.prepend([edgeItem('start')])
    const anchor = page.anchor ?? entry
    const row = rows.find(
      (item) =>
        item.kind === 'line' &&
        (item.entry.cursor === anchor || (item.repeat > 1 && item.last.cursor === anchor)),
    )
    this.set({
      phase: 'ready',
      hasMore: page.older !== null,
      focus: row ? { key: row.key, align: 'center', pause: true } : undefined,
    })
  }

  /** Subscribes after the newest line this view has, unless it should not follow now. */
  private follow() {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.snapshot.mode !== 'tail' || this.snapshot.phase !== 'ready') return
    if (this.deps.visibility.hidden()) {
      this.released = true
      this.set({ live: 'off' })
      return
    }
    this.released = false
    const generation = this.generation
    const listener: TopicListener = {
      onEvent: (name, data, cursor) => {
        if (generation !== this.generation || name !== 'entries') return
        if (cursor) this.cursor = cursor
        this.ingest((data as LogEntries).items)
      },
      onReset: (reason, missed) => {
        if (generation !== this.generation || reason === 'rebuilt') return
        this.markers += 1
        this.store.marker({
          kind: 'marker',
          key: `gap:${this.markers}`,
          text: gapWords(reason, missed),
        })
      },
      onEnd: (error) => {
        if (generation !== this.generation) return
        this.set({ liveError: error })
      },
      onRefused: (error) => {
        if (generation !== this.generation) return
        this.set({ liveError: error })
      },
      onState: (state) => {
        if (generation !== this.generation) return
        this.set(state === 'active' ? { live: state, liveError: undefined } : { live: state })
      },
    }
    this.unsubscribe = this.deps.channel.subscribe(
      'logs.entries',
      topicParams(this.view),
      listener,
      this.cursor === undefined ? undefined : { after: this.cursor },
    )
  }

  private stopFollowing() {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  /** The newest row of the feed, when it is a line (what a repeat would grow). */
  private newestRow(): LogItem | undefined {
    const row = this.store.at(this.store.size() - 1)
    return row?.kind === 'item' ? row.item : undefined
  }

  private ingest(entries: readonly LogEntry[]) {
    const cleared = this.snapshot.cleared
    const lines = cleared
      ? entries.filter((entry) => isAfter(entry.cursor, cleared.cursor))
      : entries
    if (lines.length === 0) return
    this.noteRate(lines.length)
    if (this.paused) {
      // Frozen: the store counts them and keeps nothing.
      this.pausedCount += lines.length
      this.store.push(lines.map(lineItem))
    } else {
      const { replaced, rows } = groupLines(lines, this.newestRow())
      if (replaced) this.store.replaceLast(replaced)
      this.store.push(rows)
      const dropped = this.store.dropped()
      // Following at the cap, the oldest rows leave: older lines can be
      // loaded again from the new oldest.
      if (dropped > this.dropped) {
        this.dropped = dropped
        if (!this.snapshot.hasMore) this.set({ hasMore: true })
      }
    }
    this.deps.onLines?.()
  }

  private noteRate(count: number) {
    const now = this.now()
    this.arrivals.push({ at: now, count })
    while (this.arrivals.length > 0 && (this.arrivals[0]?.at ?? now) < now - 1000)
      this.arrivals.shift()
    const rate = this.arrivals.reduce((total, arrival) => total + arrival.count, 0)
    this.set({ fast: rate > FAST_RATE })
  }

  /** Follow and pause, as the list says (`FeedList`'s `follow`, the URL's `paused`). */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return
    this.paused = paused
    if (paused) {
      this.pausedCount = 0
      this.pauseCursor = this.cursor
      return
    }
    // A page around one line follows nothing; the page opens the newest
    // lines when it is asked to follow again.
    if (this.snapshot.mode === 'around') return
    const count = this.pausedCount
    this.pausedCount = 0
    if (count === 0 || this.snapshot.phase !== 'ready') return
    if (count <= RESUME_REPLAY_MAX) {
      // The ring still has them: replay from where the pause began.
      this.cursor = this.pauseCursor
      this.follow()
      return
    }
    this.reopenAfterPause(count)
  }

  /** Too much arrived to replay: the newest page, under a marker that can load what came before. */
  private reopenAfterPause(count: number) {
    this.open({ view: this.view, cleared: this.snapshot.cleared, missed: count })
  }

  private pausedMarker(count: number) {
    const generation = this.generation
    this.store.marker({
      kind: 'marker',
      key: 'paused',
      text: pausedWords(count, false),
      action: {
        label: 'Load them',
        run: () => {
          if (generation !== this.generation) return
          this.loadOlder()
          this.store.marker({ kind: 'marker', key: 'paused', text: pausedWords(count, true) })
        },
      },
    })
  }

  /** The oldest line's cursor in the feed. */
  private oldestCursor(): string | undefined {
    for (let index = 0; index < this.store.size(); index += 1) {
      const row = this.store.at(index)
      if (row?.kind === 'item' && row.item.kind === 'line') return row.item.entry.cursor
    }
    return undefined
  }

  /** Older lines at the top, as the reader reaches it. */
  readonly loadOlder = () => {
    const state = this.snapshot
    if (!state.hasMore || state.loadingOlder || state.phase !== 'ready') return
    if (this.store.size() >= FEED_MAX) {
      this.store.prepend([edgeItem('cap')])
      this.set({ hasMore: false })
      return
    }
    const before = this.oldestCursor()
    if (before === undefined) {
      this.set({ hasMore: false })
      return
    }
    const generation = this.generation
    const abort = new AbortController()
    this.olderAbort = abort
    this.set({ loadingOlder: true })
    const fetchPage = this.deps.fetchPage ?? fetchLogPage
    fetchPage(this.view, { before }, abort.signal).then(
      (page) => {
        if (generation !== this.generation) return
        const { rows, crossed } = this.rowsOf(page.items, this.snapshot.cleared)
        this.store.prepend(rows)
        const edge =
          this.snapshot.cleared && crossed ? 'cleared' : page.older === null ? 'start' : undefined
        if (edge) this.store.prepend([edgeItem(edge)])
        this.set({ loadingOlder: false, hasMore: edge === undefined })
      },
      () => {
        if (generation !== this.generation) return
        // A cursor of an earlier run, or an engine that went away: there is
        // nothing older to read now.
        this.set({ loadingOlder: false, hasMore: false })
      },
    )
  }

  /**
   * The newest line this view has heard of, shown or held back by a pause:
   * where "Clear view" draws its line.
   */
  newestCursor(): string | undefined {
    if (this.cursor !== undefined) return this.cursor
    const row = this.newestRow()
    return row?.kind === 'line' ? row.last.cursor : undefined
  }

  private restarted() {
    // The channel dropped every cursor: the new run replays from its first line.
    this.cursor = undefined
    this.pauseCursor = undefined
    this.pausedCount = 0
    if (this.snapshot.mode === 'around' || this.snapshot.phase !== 'ready') {
      this.open({ view: this.view })
      return
    }
    if (this.deps.keepAcrossRestarts()) {
      this.markers += 1
      this.store.marker({
        kind: 'marker',
        key: `restart:${this.markers}`,
        text: 'Engine restarted',
      })
    } else {
      this.store.clear()
      this.dropped = 0
    }
    this.set({ cleared: undefined, hasMore: false })
  }

  private visibilityChanged() {
    if (this.deps.visibility.hidden()) {
      if (!this.unsubscribe) return
      // Given back at once, not after the channel's 20 s: a hidden tab must
      // not collect lines it would flush in one frame when shown.
      this.stopFollowing()
      this.released = true
      this.set({ live: 'off' })
      return
    }
    if (this.released) this.follow()
  }
}

/** The browser's visibility, as the feed hears it. */
const documentVisibility: LogFeedDeps['visibility'] = {
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  subscribe: (listener) => {
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  },
}

/**
 * The page's feed: created once, opened again whenever `request` names
 * another view (by value), told when the list pauses and resumes.
 */
export function useLogFeed(
  request: FeedOpen | null,
  paused: boolean,
  options: Omit<LogFeedDeps, 'visibility'> & { visibility?: LogFeedDeps['visibility'] },
): { feed: LogFeed; state: LogFeedState } {
  const [feed] = useState(
    () => new LogFeed({ ...options, visibility: options.visibility ?? documentVisibility }),
  )
  useEffect(() => feed.attach(), [feed])
  const key = request === null ? null : JSON.stringify(request)
  useEffect(() => {
    if (key === null) return
    feed.open(JSON.parse(key) as FeedOpen)
  }, [feed, key])
  useEffect(() => {
    feed.setPaused(paused)
  }, [feed, paused])
  const state = useSyncExternalStore(feed.subscribe, feed.getState, feed.getState)
  return { feed, state }
}
