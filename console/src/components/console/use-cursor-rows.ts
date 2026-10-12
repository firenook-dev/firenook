// Cursor pages into the rows a `DataTable` shows: a sliding window of at most
// twenty pages, with rows the live channel names patched in place.
//
// The window. `cursorPagesOptions` keeps `maxPages: 20`, so scrolling past
// either end loads the next or previous page and drops one at the other end
// (`getPreviousPageParam` reads `prevCursor`). The table needs to know where
// the window starts in the whole list — for `aria-rowindex`, the footer's
// "rows 1,901–3,900" and the scroll correction when a page is dropped — and
// TanStack does not say, so the offset is followed here from the page
// parameters: a first page that moved forward added the dropped pages' rows,
// one that moved back took the new pages' rows away, and a first page with no
// `prevCursor` is the start of the list.
//
// The patches (foundation §7.11). A live event names keys; they are batched
// for 120 ms and read again in one `:batchGet` with the window's filter,
// order and page starts. A key whose row is loaded is patched where it is; a
// key the engine says is gone (deleted, or no longer matching) leaves; a new
// key the engine places in a loaded page refetches that page alone — asking,
// when another loaded page follows it, for its rows, the new ones and the
// next page's first row, and reading the rows just above the next page too
// when that still falls short, so it ends where the next one starts and no
// row falls between them; a new key outside the window is left for the
// scroll to find. More than 1,000 keys in
// one window, a `reset`, an `end` or an engine restart start again from page
// one. Nothing is patched while a page is being fetched — a page that left
// before the change and lands after it would undo the patch — so the batch
// waits for the fetch.

import {
  type InfiniteData,
  type QueryKey,
  type UseInfiniteQueryResult,
  infiniteQueryOptions,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { BatchGetRequest } from '@/api/generated/BatchGetRequest'
import type { BatchGetResponse } from '@/api/generated/BatchGetResponse'
import type { Page } from '@/api/generated/Page'
import type { Total } from '@/api/generated/Total'
import { liveChannel } from '@/lib/live/channel'

/** Where a page starts: the first page has neither. */
export interface CursorPageParam {
  cursor?: string
  before?: string
  /**
   * How many rows a page read again should hold: its own, the new ones the
   * engine placed in it and the next loaded page's first row, so it still
   * reaches where that page starts. Only on a page read again with a loaded
   * page after it; never kept in the page parameters. A fetcher passes it as
   * the request's limit; one that ignores it reads its usual page.
   */
  limit?: number
}

export type CursorPages<T> = InfiniteData<Page<T>, CursorPageParam>

/** The window every list keeps (foundation §7.11): 2,000 rows at the default page size. */
export const MAX_PAGES = 20
/** Keys named in one batch past which the window starts again rather than patching. */
export const RESET_KEYS = 1_000
/** The most keys one `:batchGet` may name. */
export const BATCH_KEYS = 500
/** How long keys are collected before they are read again, ms. */
export const BATCH_MS = 120
/** How long a patched or created row flashes, ms (the `row-flash` animation's length). */
export const FLASH_MS = 1_600

/** `maxPages: 20`, `getNextPageParam` from `nextCursor`, `getPreviousPageParam` from `prevCursor`. */
export function cursorPagesOptions<T>(
  key: QueryKey,
  fetchPage: (page: CursorPageParam, signal: AbortSignal) => Promise<Page<T>>,
) {
  return infiniteQueryOptions<Page<T>, Error, CursorPages<T>, QueryKey, CursorPageParam>({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => fetchPage(pageParam, signal),
    initialPageParam: {} as CursorPageParam,
    getNextPageParam: (last: Page<T>): CursorPageParam | undefined =>
      last.nextCursor ? { cursor: last.nextCursor } : undefined,
    getPreviousPageParam: (first: Page<T>): CursorPageParam | undefined =>
      first.prevCursor ? { before: first.prevCursor } : undefined,
    maxPages: MAX_PAGES,
  })
}

function paramKey(param: CursorPageParam | undefined): string {
  if (!param) return ''
  return param.cursor !== undefined
    ? `c:${param.cursor}`
    : param.before !== undefined
      ? `b:${param.before}`
      : ''
}

/** What the window offset is followed from: the page parameters and how many rows each page held. */
export interface WindowTrack {
  params: readonly string[]
  lengths: readonly number[]
  offset: number
}

/** The window's new offset, from where it was and the pages it holds now. */
export function followOffset<T>(
  previous: WindowTrack | undefined,
  data: CursorPages<T>,
): WindowTrack {
  const params = data.pageParams.map(paramKey)
  const lengths = data.pages.map((page) => page.items.length)
  const first = data.pages[0]
  // The start of the list is where the offset is known for certain.
  if (!first || first.prevCursor === null || params[0] === '') return { params, lengths, offset: 0 }
  if (!previous || previous.params.length === 0) return { params, lengths, offset: 0 }
  if (previous.params[0] === params[0]) return { params, lengths, offset: previous.offset }
  // Moved forward: pages dropped from the front.
  const dropped = previous.params.indexOf(params[0] ?? '')
  if (dropped > 0) {
    let offset = previous.offset
    for (let index = 0; index < dropped; index += 1) offset += previous.lengths[index] ?? 0
    return { params, lengths, offset }
  }
  // Moved back: pages read in at the front.
  const added = params.indexOf(previous.params[0] ?? '')
  if (added > 0) {
    let offset = previous.offset
    for (let index = 0; index < added; index += 1) offset -= lengths[index] ?? 0
    return { params, lengths, offset: Math.max(0, offset) }
  }
  return { params, lengths, offset: 0 }
}

/** How a batch read changes the loaded pages. */
export interface PatchResult<T> {
  /** The pages with patched rows in place and gone rows removed; the same object when nothing changed. */
  data: CursorPages<T>
  /** Indexes of loaded pages a new row falls in: each is fetched again alone. */
  refetch: number[]
  /** How many new rows each page of `refetch` gains, by page index. */
  arriving: ReadonlyMap<number, number>
  updated: string[]
}

/** Applies a `:batchGet` answer to the loaded pages. Pages without a touched row keep their identity. */
export function patchRows<T>(
  data: CursorPages<T>,
  answer: BatchGetResponse<T>,
  rowKey: (row: T) => string,
): PatchResult<T> {
  const where = new Map<string, number>()
  data.pages.forEach((page, index) => {
    for (const row of page.items) where.set(rowKey(row), index)
  })
  const replace = new Map<string, T | null>()
  const arriving = new Map<number, number>()
  for (const item of answer.items) {
    if (where.has(item.key)) replace.set(item.key, item.row)
    else if (item.row !== null && item.page !== null && item.page < data.pages.length)
      arriving.set(item.page, (arriving.get(item.page) ?? 0) + 1)
  }
  const refetch = [...arriving.keys()]
  if (replace.size === 0) return { data, refetch, arriving, updated: [] }
  const updated: string[] = []
  const pages = data.pages.map((page) => {
    if (!page.items.some((row) => replace.has(rowKey(row)))) return page
    return {
      ...page,
      items: page.items.flatMap((row) => {
        const key = rowKey(row)
        if (!replace.has(key)) return [row]
        const next = replace.get(key) ?? null
        if (next === null) return []
        updated.push(key)
        return [next]
      }),
    }
  })
  return { data: { ...data, pages }, refetch, arriving, updated }
}

/** The `:batchGet` body for `keys` against the loaded window. */
export function batchRequest<T>(
  data: CursorPages<T>,
  keys: readonly string[],
  q: string | undefined,
  sort: string | undefined,
): BatchGetRequest {
  const last = data.pages.at(-1)
  return {
    keys: [...keys],
    ...(q ? { q } : {}),
    ...(sort ? { sort } : {}),
    pageStarts: data.pages.map((page) => page.prevCursor),
    ...(last?.nextCursor ? { windowEnd: last.nextCursor } : {}),
  }
}

export interface CursorRows<T> {
  rows: T[]
  rowOffset: number
  hasMore: boolean
  hasPrevious: boolean
  loadMore: () => void
  loadPrevious: () => void
  total: Total | undefined
  scanned: number | undefined
  /** Feed it the keys of an invalidation event; batched per 120 ms. */
  applyKeys: (keys: readonly string[]) => void
  /** reset / end / engine restart: back to page 1, the table keeping its anchor row where it can. */
  reset: () => void
  /** Rows this hook patched or brought in, for `DataTable`'s `flashes`. */
  flashes: ReadonlyMap<string, 'created' | 'updated'>
}

export function useCursorRows<T>(
  query: UseInfiniteQueryResult<CursorPages<T>>,
  options: {
    /** The query's key: what is patched in place and reset. */
    queryKey: QueryKey
    /** The page fetcher given to `cursorPagesOptions`, to read one page again alone. */
    fetchPage: (page: CursorPageParam, signal: AbortSignal) => Promise<Page<T>>
    rowKey: (row: T) => string
    /** The section's `POST …:batchGet`, called with the keys a live event named (§7.11). */
    batchGet: (request: BatchGetRequest, signal: AbortSignal) => Promise<BatchGetResponse<T>>
    q?: string | undefined
    sort?: string | undefined
  },
): CursorRows<T> {
  const queryClient = useQueryClient()
  const data = query.data
  const [track, setTrack] = useState<{ data: CursorPages<T> | undefined; window: WindowTrack }>({
    data: undefined,
    window: { params: [], lengths: [], offset: 0 },
  })
  let windowTrack = track.window
  if (data !== track.data) {
    windowTrack = data ? followOffset(track.window, data) : { params: [], lengths: [], offset: 0 }
    setTrack({ data, window: windowTrack })
  }

  const [flashes, setFlashes] = useState<ReadonlyMap<string, 'created' | 'updated'>>(new Map())
  const latest = useRef({ query, options })
  useEffect(() => {
    latest.current = { query, options }
  })

  const pending = useRef(new Set<string>())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flashAt = useRef(new Map<string, number>())
  const controller = useRef<AbortController | undefined>(undefined)

  const reset = () => {
    pending.current.clear()
    clearTimeout(timer.current)
    timer.current = undefined
    controller.current?.abort()
    void queryClient.resetQueries({ queryKey: latest.current.options.queryKey, exact: true })
  }

  const flash = (keys: readonly string[], kind: 'created' | 'updated') => {
    if (keys.length === 0) return
    const now = Date.now()
    for (const key of keys) flashAt.current.set(key, now)
    setFlashes((current) => {
      const next = new Map(current)
      for (const key of keys) next.set(key, kind)
      return next
    })
    if (flashTimer.current !== undefined) return
    const expire = () => {
      flashTimer.current = undefined
      const before = Date.now() - FLASH_MS
      const gone: string[] = []
      for (const [key, at] of flashAt.current) if (at <= before) gone.push(key)
      for (const key of gone) flashAt.current.delete(key)
      if (gone.length > 0)
        setFlashes((current) => {
          const next = new Map(current)
          for (const key of gone) next.delete(key)
          return next
        })
      if (flashAt.current.size > 0) flashTimer.current = setTimeout(expire, FLASH_MS / 4)
    }
    flashTimer.current = setTimeout(expire, FLASH_MS / 4)
  }

  const flush = async () => {
    timer.current = undefined
    const { query: current, options: opts } = latest.current
    const loaded = queryClient.getQueryData<CursorPages<T>>(opts.queryKey)
    if (!loaded || pending.current.size === 0) {
      pending.current.clear()
      return
    }
    // A page in flight would land over the patch with what it read before.
    if (current.isFetching) {
      timer.current = setTimeout(() => void flush(), BATCH_MS)
      return
    }
    const keys = [...pending.current]
    pending.current.clear()
    if (keys.length > RESET_KEYS) {
      reset()
      return
    }
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    try {
      const chunks: string[][] = []
      for (let start = 0; start < keys.length; start += BATCH_KEYS)
        chunks.push(keys.slice(start, start + BATCH_KEYS))
      const answers = await Promise.all(
        chunks.map((chunk) =>
          opts.batchGet(batchRequest(loaded, chunk, opts.q, opts.sort), abort.signal),
        ),
      )
      const items = answers.flatMap((answer) => answer.items)
      if (abort.signal.aborted) return
      const now = queryClient.getQueryData<CursorPages<T>>(opts.queryKey)
      if (!now) return
      // The window may have slid while the read was out: page indexes are
      // only meaningful against the pages they were asked about.
      const samePages =
        now.pages.length === loaded.pages.length &&
        now.pageParams.every(
          (param, index) => paramKey(param) === paramKey(loaded.pageParams[index]),
        )
      const patched = patchRows(
        now,
        {
          items: samePages
            ? items
            : items.map((item) => ({ key: item.key, row: item.row, page: null })),
        },
        opts.rowKey,
      )
      if (patched.data !== now) queryClient.setQueryData(opts.queryKey, patched.data)
      flash(patched.updated, 'updated')
      for (const index of patched.refetch)
        void refetchPage(index, patched.arriving.get(index) ?? 0, abort.signal)
    } catch {
      if (abort.signal.aborted) return
      // The rows could not be read again: what the window holds can no
      // longer be trusted, so it is read again whole.
      void queryClient.invalidateQueries({ queryKey: opts.queryKey, exact: true })
    }
  }

  /**
   * Reads one loaded page again and puts it in its place; its new rows
   * flash. A page is the rows from its own start up to where the next
   * loaded page starts, which a page read from its start at its usual size
   * may not reach: rows created in it push its last rows past the page size,
   * and those are in no other loaded page. So a page with another loaded
   * after it asks for its rows, the `arriving` ones and one more (the next
   * page's first row, where the two meet). When the read still stops short
   * of the next page (a fetcher that ignores the limit, more rows than were
   * counted, a page cut by size), the rows just above that page are read
   * too (`before` its start) and the two reads joined; rows past the next
   * page's start (some were deleted) are left to it. A range too long for
   * both reads to meet starts the window again from page one.
   */
  const refetchPage = async (index: number, arriving: number, signal: AbortSignal) => {
    const { options: opts } = latest.current
    const before = queryClient.getQueryData<CursorPages<T>>(opts.queryKey)
    const param = before?.pageParams[index]
    if (!before || param === undefined) return
    const held = before.pages[index]?.items.length ?? 0
    const followed = index < before.pages.length - 1
    const head = await opts.fetchPage(
      followed && arriving > 0 ? { ...param, limit: held + arriving + 1 } : param,
      signal,
    )
    if (signal.aborted) return
    const following = before.pages[index + 1]
    let page = head
    if (following && following.items.length > 0) {
      const keys = head.items.map(opts.rowKey)
      const first = following.items[0] as T
      const into = keys.indexOf(opts.rowKey(first))
      if (into !== -1) page = { ...head, items: head.items.slice(0, into) }
      else if (head.nextCursor !== null && following.prevCursor !== null) {
        const tail = await opts.fetchPage({ before: following.prevCursor }, signal)
        if (signal.aborted) return
        const last = keys.at(-1)
        const join = tail.items.findIndex((row) => opts.rowKey(row) === last)
        if (join === -1 && tail.prevCursor !== null && keys.length > 0) {
          reset()
          return
        }
        const seen = new Set(keys)
        page = {
          ...head,
          items: [...head.items, ...tail.items.filter((row) => !seen.has(opts.rowKey(row)))],
        }
      }
      // The page still ends where the next one starts.
      page = { ...page, nextCursor: before.pages[index]?.nextCursor ?? page.nextCursor }
    }
    const now = queryClient.getQueryData<CursorPages<T>>(opts.queryKey)
    if (!now || paramKey(now.pageParams[index]) !== paramKey(param)) return
    const known = new Set(now.pages[index]?.items.map(opts.rowKey) ?? [])
    queryClient.setQueryData<CursorPages<T>>(opts.queryKey, {
      ...now,
      pages: now.pages.map((existing, at) => (at === index ? page : existing)),
    })
    flash(
      page.items.map(opts.rowKey).filter((key) => !known.has(key)),
      'created',
    )
  }

  const applyKeys = (keys: readonly string[]) => {
    for (const key of keys) pending.current.add(key)
    if (pending.current.size > RESET_KEYS) {
      reset()
      return
    }
    timer.current ??= setTimeout(() => void flush(), BATCH_MS)
  }

  // An engine restart makes every cursor meaningless: start again.
  const restart = useRef(reset)
  useEffect(() => {
    restart.current = reset
  })
  useEffect(() => liveChannel.onEngineRestart(() => restart.current()), [])

  useEffect(
    () => () => {
      clearTimeout(timer.current)
      clearTimeout(flashTimer.current)
      controller.current?.abort()
    },
    [],
  )

  const pages = data?.pages ?? []
  const rows = pages.flatMap((page) => page.items)
  const newest = pages.at(-1)
  return {
    rows,
    rowOffset: windowTrack.offset,
    hasMore: Boolean(query.hasNextPage),
    hasPrevious: Boolean(query.hasPreviousPage),
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchingPreviousPage)
        void query.fetchNextPage()
    },
    loadPrevious: () => {
      if (query.hasPreviousPage && !query.isFetchingPreviousPage && !query.isFetchingNextPage)
        void query.fetchPreviousPage()
    },
    total: newest?.total ?? pages[0]?.total ?? undefined,
    scanned: newest?.scanned ?? undefined,
    applyKeys,
    reset,
    flashes,
  }
}
