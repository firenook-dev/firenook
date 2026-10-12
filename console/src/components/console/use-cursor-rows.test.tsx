import { QueryClient, QueryClientProvider, useInfiniteQuery } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { BatchGetRequest } from '@/api/generated/BatchGetRequest'
import type { BatchGetResponse } from '@/api/generated/BatchGetResponse'
import type { Page } from '@/api/generated/Page'
import {
  type CursorPageParam,
  type CursorPages,
  MAX_PAGES,
  batchRequest,
  cursorPagesOptions,
  followOffset,
  patchRows,
  useCursorRows,
} from './use-cursor-rows'

interface Row {
  id: string
  value: number
}

const rowKey = (row: Row) => row.id

/** A page as the engine writes one: cursors are positions here. */
function page(items: Row[], start: number, total: number): Page<Row> {
  return {
    items,
    nextCursor: start + items.length < total ? String(start + items.length) : null,
    prevCursor: start > 0 ? String(start) : null,
    total: { count: total, exact: true },
    scanned: null,
  }
}

function pages(list: Array<[number, number]>, total = 1_000): CursorPages<Row> {
  return {
    pages: list.map(([start, length]) =>
      page(
        Array.from({ length }, (_, index) => ({ id: `r${start + index}`, value: start + index })),
        start,
        total,
      ),
    ),
    pageParams: list.map(([start]) => (start === 0 ? {} : { cursor: String(start) })),
  }
}

describe('the window offset', () => {
  it('is 0 at the start of the list', () => {
    expect(followOffset(undefined, pages([[0, 100]])).offset).toBe(0)
  })

  it('adds the rows of the pages dropped from the front', () => {
    const before = followOffset(
      undefined,
      pages([
        [0, 100],
        [100, 100],
      ]),
    )
    const after = followOffset(
      { ...before, offset: 0 },
      pages([
        [100, 100],
        [200, 100],
      ]),
    )
    expect(after.offset).toBe(100)
    const further = followOffset(
      after,
      pages([
        [200, 100],
        [300, 100],
      ]),
    )
    expect(further.offset).toBe(200)
  })

  it('takes away the rows of the pages read in at the front', () => {
    const moved = followOffset(
      { params: ['c:200'], lengths: [100], offset: 200 },
      {
        ...pages([
          [100, 100],
          [200, 100],
        ]),
        pageParams: [{ before: '200' }, { cursor: '200' }],
      },
    )
    expect(moved.offset).toBe(100)
  })

  it('knows a page with no prevCursor starts the list, however it was reached', () => {
    const back: CursorPages<Row> = { ...pages([[0, 100]]), pageParams: [{ before: '100' }] }
    expect(followOffset({ params: ['c:100'], lengths: [100], offset: 100 }, back).offset).toBe(0)
  })
})

describe('patching rows from a batch read', () => {
  const data = pages([
    [0, 3],
    [3, 3],
  ])

  it('patches a loaded row in place and leaves untouched pages as they were', () => {
    const answer: BatchGetResponse<Row> = {
      items: [{ key: 'r4', row: { id: 'r4', value: 40 }, page: 1 }],
    }
    const result = patchRows(data, answer, rowKey)
    expect(result.data.pages[0]).toBe(data.pages[0])
    expect(result.data.pages[1]?.items.map((row) => row.value)).toEqual([3, 40, 5])
    expect(result.updated).toEqual(['r4'])
    expect(result.refetch).toEqual([])
  })

  it('drops a row the engine says is gone', () => {
    const result = patchRows(data, { items: [{ key: 'r1', row: null, page: null }] }, rowKey)
    expect(result.data.pages[0]?.items.map(rowKey)).toEqual(['r0', 'r2'])
  })

  it('reads again the one page a new row falls in, and ignores one outside the window', () => {
    const result = patchRows(
      data,
      {
        items: [
          { key: 'new', row: { id: 'new', value: 1.5 }, page: 0 },
          { key: 'far', row: { id: 'far', value: 999 }, page: null },
        ],
      },
      rowKey,
    )
    expect(result.data).toBe(data)
    expect(result.refetch).toEqual([0])
  })

  it('asks with the window’s page starts, its end, filter and order', () => {
    expect(batchRequest(data, ['r1'], 'is:disabled', 'createdAt:desc')).toEqual({
      keys: ['r1'],
      q: 'is:disabled',
      sort: 'createdAt:desc',
      pageStarts: [null, '3'],
      windowEnd: '6',
    })
    expect(batchRequest(pages([[0, 3]], 3), ['r1'], undefined, '')).toEqual({
      keys: ['r1'],
      pageStarts: [null],
    })
  })
})

/** An engine list in memory: positions as cursors, a batch read that places rows in pages. */
function fakeEngine(count: number, size = 100) {
  const all: Row[] = Array.from({ length: count }, (_, index) => ({
    id: `r${String(index).padStart(5, '0')}`,
    value: index,
  }))
  const fetchPage = vi.fn(async (param: CursorPageParam): Promise<Page<Row>> => {
    let start = 0
    let end = size
    if (param.cursor !== undefined) {
      start = Number(param.cursor)
      end = start + size
    } else if (param.before !== undefined) {
      end = Number(param.before)
      start = Math.max(0, end - size)
    }
    return page(all.slice(start, end), start, all.length)
  })
  const batchGet = vi.fn(async (request: BatchGetRequest): Promise<BatchGetResponse<Row>> => {
    const starts = request.pageStarts.map((start) => (start === null ? 0 : Number(start)))
    const end = request.windowEnd === undefined ? all.length : Number(request.windowEnd)
    return {
      items: request.keys.map((key) => {
        const index = all.findIndex((row) => row.id === key)
        const row = all[index] ?? null
        let at: number | null = null
        if (index !== -1 && index < end)
          starts.forEach((start, position) => {
            if (index >= start) at = position
          })
        return { key, row, page: row ? at : null }
      }),
    }
  })
  return { all, fetchPage, batchGet }
}

function mount(engine: Pick<ReturnType<typeof fakeEngine>, 'fetchPage' | 'batchGet'>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const key = ['test', 'rows']
  const view = renderHook(
    () => {
      const query = useInfiniteQuery(cursorPagesOptions(key, engine.fetchPage))
      return useCursorRows(query, {
        queryKey: key,
        fetchPage: engine.fetchPage,
        rowKey,
        batchGet: engine.batchGet,
      })
    },
    { wrapper },
  )
  return { ...view, client }
}

describe('useCursorRows', () => {
  it('reads the first page, its total and whether there is more', async () => {
    const { result } = mount(fakeEngine(250))
    await waitFor(() => expect(result.current.rows).toHaveLength(100))
    expect(result.current.rowOffset).toBe(0)
    expect(result.current.hasMore).toBe(true)
    expect(result.current.hasPrevious).toBe(false)
    expect(result.current.total).toEqual({ count: 250, exact: true })
  })

  it('slides a window of at most twenty pages, and knows where it is in the list', async () => {
    const { result } = mount(fakeEngine(2_500))
    await waitFor(() => expect(result.current.rows).toHaveLength(100))
    for (let loaded = 1; loaded <= MAX_PAGES; loaded += 1) {
      act(() => result.current.loadMore())
      // oxlint-disable-next-line no-await-in-loop -- each page follows the one before it
      await waitFor(() =>
        expect(result.current.rows.length + result.current.rowOffset).toBe((loaded + 1) * 100),
      )
    }
    expect(result.current.rows).toHaveLength(2_000)
    expect(result.current.rowOffset).toBe(100)
    expect(result.current.rows[0]?.id).toBe('r00100')
    expect(result.current.hasPrevious).toBe(true)
    act(() => result.current.loadPrevious())
    await waitFor(() => expect(result.current.rowOffset).toBe(0))
    expect(result.current.rows[0]?.id).toBe('r00000')
    expect(result.current.rows).toHaveLength(2_000)
  })

  it('patches the rows a live event names, in one batch read per 120 ms', async () => {
    const engine = fakeEngine(250)
    const { result } = mount(engine)
    await waitFor(() => expect(result.current.rows).toHaveLength(100))
    const fetched = engine.fetchPage.mock.calls.length
    engine.all[5] = { id: 'r00005', value: 5_000 }
    act(() => {
      result.current.applyKeys(['r00005'])
      result.current.applyKeys(['r00005'])
    })
    await waitFor(() => expect(result.current.rows[5]?.value).toBe(5_000))
    expect(engine.batchGet).toHaveBeenCalledTimes(1)
    expect(engine.batchGet.mock.calls[0]?.[0].keys).toEqual(['r00005'])
    expect(result.current.flashes.get('r00005')).toBe('updated')
    // Patched in place: no page was read again.
    expect(engine.fetchPage).toHaveBeenCalledTimes(fetched)
  })

  it('drops a deleted row, and reads again only the page a created one falls in', async () => {
    const engine = fakeEngine(250)
    const { result } = mount(engine)
    await waitFor(() => expect(result.current.rows).toHaveLength(100))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.rows).toHaveLength(200))
    engine.all.splice(7, 1)
    act(() => result.current.applyKeys(['r00007']))
    await waitFor(() => expect(result.current.rows.some((row) => row.id === 'r00007')).toBe(false))
    const fetched = engine.fetchPage.mock.calls.length
    engine.all.splice(150, 0, { id: 'r00149b', value: 149.5 })
    act(() => result.current.applyKeys(['r00149b']))
    await waitFor(() => expect(result.current.rows.some((row) => row.id === 'r00149b')).toBe(true))
    expect(engine.fetchPage).toHaveBeenCalledTimes(fetched + 1)
    expect(engine.fetchPage.mock.calls.at(-1)?.[0]).toEqual({ cursor: '100' })
    expect(result.current.flashes.get('r00149b')).toBe('created')
  })

  it('starts again from page one past a thousand keys', async () => {
    const engine = fakeEngine(2_500)
    const { result } = mount(engine)
    await waitFor(() => expect(result.current.rows).toHaveLength(100))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.rows).toHaveLength(200))
    const calls = engine.fetchPage.mock.calls.length
    act(() => result.current.applyKeys(Array.from({ length: 1_001 }, (_, index) => `k${index}`)))
    await waitFor(() => expect(result.current.rows).toHaveLength(100))
    expect(engine.batchGet).not.toHaveBeenCalled()
    expect(engine.fetchPage.mock.calls.slice(calls).map((call) => call[0])).toEqual([{}])
  })

  it('keeps every row of a page whose created rows push others past the page size', async () => {
    const engine = keyedEngine(250)
    const { result } = mount(engine)
    await waitFor(() => expect(result.current.rows).toHaveLength(100))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.rows).toHaveLength(200))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.rows).toHaveLength(250))
    const fetched = engine.fetchPage.mock.calls.length
    // Forty-one rows that sort into the first page.
    const created = Array.from(
      { length: 41 },
      (_, index) => `r00000-${String(index).padStart(2, '0')}`,
    )
    engine.add(created)
    act(() => result.current.applyKeys(created))
    await waitFor(() => expect(result.current.rows).toHaveLength(291))
    const ids = result.current.rows.map(rowKey)
    expect(new Set(ids).size).toBe(291)
    expect(ids).toEqual(engine.ids())
    // The first page from its start, and the rows just above the second.
    expect(engine.fetchPage.mock.calls.slice(fetched).map((call) => call[0])).toEqual([
      {},
      { before: 'r00100' },
    ])
    expect(result.current.hasMore).toBe(false)
    expect(result.current.flashes.get('r00000-40')).toBe('created')
  })

  it('leaves to the next page the rows a page read again reaches into', async () => {
    const engine = keyedEngine(250)
    const { result } = mount(engine)
    await waitFor(() => expect(result.current.rows).toHaveLength(100))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.rows).toHaveLength(200))
    // Three rows of the first page go and one arrives, in one batch.
    engine.remove(['r00010', 'r00011', 'r00012'])
    engine.add(['r00050-a'])
    act(() => result.current.applyKeys(['r00010', 'r00011', 'r00012', 'r00050-a']))
    await waitFor(() => expect(result.current.rows.some((row) => row.id === 'r00050-a')).toBe(true))
    const ids = result.current.rows.map(rowKey)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(engine.ids().slice(0, ids.length))
    expect(ids).toHaveLength(198)
  })
})

/** One page of a sorted list, its cursors the keys at its edges. */
const pageOf = (rows: Row[], from: number, to: number): Page<Row> => {
  const items = rows.slice(from, to)
  return {
    items,
    nextCursor: to < rows.length ? (items.at(-1)?.id ?? null) : null,
    prevCursor: from > 0 ? (items[0]?.id ?? null) : null,
    total: { count: rows.length, exact: true },
    scanned: null,
  }
}

/** An engine list in memory with key cursors, as the engines write them: a page after a key or before one. */
function keyedEngine(count: number, size = 100) {
  let all: Row[] = Array.from({ length: count }, (_, index) => ({
    id: `r${String(index).padStart(5, '0')}`,
    value: index,
  }))
  const sorted = () => all.toSorted((left, right) => (left.id < right.id ? -1 : 1))
  const fetchPage = vi.fn(async (param: CursorPageParam): Promise<Page<Row>> => {
    const rows = sorted()
    if (param.before !== undefined) {
      const end = rows.filter((row) => row.id < (param.before as string)).length
      return pageOf(rows, Math.max(0, end - size), end)
    }
    const start =
      param.cursor === undefined
        ? 0
        : rows.filter((row) => row.id <= (param.cursor as string)).length
    return pageOf(rows, start, start + size)
  })
  const batchGet = vi.fn(async (request: BatchGetRequest): Promise<BatchGetResponse<Row>> => ({
    items: request.keys.map((key) => {
      const row = all.find((candidate) => candidate.id === key) ?? null
      let at: number | null = null
      if (row && (request.windowEnd === undefined || key <= request.windowEnd))
        request.pageStarts.forEach((start, position) => {
          if (start === null || key >= start) at = position
        })
      return { key, row, page: row ? at : null }
    }),
  }))
  return {
    fetchPage,
    batchGet,
    add: (ids: readonly string[]) => {
      all = [...all, ...ids.map((id) => ({ id, value: -1 }))]
    },
    remove: (ids: readonly string[]) => {
      all = all.filter((row) => !ids.includes(row.id))
    },
    ids: () => sorted().map(rowKey),
  }
}
