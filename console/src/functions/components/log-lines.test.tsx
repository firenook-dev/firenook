import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FunctionLogLine } from '@/api/generated/compute/FunctionLogLine'
import { createFeedStore } from '@/lib/live/feed-store'
import { scrollTo, stubLayout } from '@/test/layout'
import { giveListsALayout } from '@/test/virtual'
import {
  LogLines,
  MINUTE_OFFSET_MS,
  canOpen,
  fieldsOf,
  lineKey,
  offsetColumns,
  offsetText,
  returnsBefore,
} from './log-lines'

giveListsALayout({ row: 24 })

afterEach(() => {
  cleanup()
})

const line = (index: number, overrides: Partial<FunctionLogLine> = {}): FunctionLogLine => ({
  index,
  at: '2026-10-12T06:09:09.126Z',
  offsetMs: index * 4,
  level: 'info',
  message: `line ${index}`,
  kind: null,
  fields: null,
  afterFinish: false,
  ...overrides,
})

/** A store holding these lines, as a page fills one from the engine's record. */
function storeOf(lines: readonly FunctionLogLine[]) {
  const store = createFeedStore<FunctionLogLine>({ max: 1_000, key: lineKey })
  store.push(lines)
  return store
}

/** The store tells its readers once a frame; a test lets that frame pass. */
async function frame() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

describe('the pieces of a line', () => {
  it('writes offsets from the start of the invocation', () => {
    expect(offsetText(0)).toBe('+0 ms')
    expect(offsetText(12)).toBe('+12 ms')
    expect(offsetText(2.6)).toBe('+2.6 ms')
    expect(offsetText(1_240)).toBe('+1.2 s')
  })

  it('sizes the time column for offsets, wider only once one reads in minutes', () => {
    // The narrow column holds 7 characters: every offset under a minute fits.
    for (const ms of [0, 9.9, 999, 1_240, 9_949, 59_499]) {
      expect(offsetText(ms).length).toBeLessThanOrEqual(7)
      expect(offsetColumns(ms, true)).toBe('grid-cols-[52px_44px_minmax(0,1fr)_auto]')
    }
    expect(offsetText(MINUTE_OFFSET_MS)).toBe('+1 min')
    expect(offsetColumns(MINUTE_OFFSET_MS, true)).toBe('grid-cols-[84px_44px_minmax(0,1fr)_auto]')
    expect(offsetText(3_599_000)).toHaveLength(12)
    // No level column while there is no level word to put in it.
    expect(offsetColumns(12, false)).toBe(
      'grid-cols-[52px_minmax(0,1fr)_auto] [&>[data-part=level]]:hidden',
    )
    expect(offsetColumns(61_000, false)).toBe(
      'grid-cols-[84px_minmax(0,1fr)_auto] [&>[data-part=level]]:hidden',
    )
  })

  it('opens fields worth opening, and cut lines only where rows are one line each', () => {
    expect(fieldsOf(line(0, { fields: { orderId: 'o_1' } }))).toEqual({ orderId: 'o_1' })
    expect(fieldsOf(line(0, { fields: {} }))).toBeUndefined()
    expect(fieldsOf(line(0, { fields: ['a'] }))).toBeUndefined()
    const stack = line(1, { message: 'Error: boom\n    at handler (index.js:4:11)' })
    expect(canOpen(stack, false)).toBe(true)
    expect(canOpen(stack, true)).toBe(false)
    expect(canOpen(line(2), false)).toBe(false)
  })

  it('puts the divider above the first line printed after the invocation returned, once', () => {
    const store = storeOf([line(0), line(1, { afterFinish: true }), line(2, { afterFinish: true })])
    expect([0, 1, 2].map((index) => returnsBefore(store, index))).toEqual([false, true, false])
    const late = storeOf([line(5, { afterFinish: true })])
    expect(returnsBefore(late, 0)).toBe(true)
  })
})

describe("an invocation's lines", () => {
  it('draws each line with its offset and level, the late ones under the divider, quieter', () => {
    const store = storeOf([
      line(0, { message: 'hello from api' }),
      line(1, { level: 'warn', message: 'cart is empty', offsetMs: 12 }),
      line(2, {
        level: 'error',
        message: 'Error: boom\n    at handler (index.js:4:11)',
        kind: 'function.error',
      }),
      line(3, { message: 'cleanup done', afterFinish: true, offsetMs: 1_240 }),
    ])
    render(<LogLines ariaLabel="Logs of #1,284" store={store} mode="invocation" />)
    const rows = screen.getAllByTestId('log-line')
    expect(rows).toHaveLength(4)
    expect(rows[1]?.querySelector('[data-part="time"]')).toHaveTextContent('+12 ms')
    expect(rows[1]).toHaveAttribute('data-level', 'warn')
    // Never cut: the whole stack is there without opening the row.
    expect(rows[2]?.querySelector('[data-part="message"]')).toHaveTextContent(
      'at handler (index.js:4:11)',
    )
    expect(screen.getAllByTestId('log-returned')).toHaveLength(1)
    expect(screen.getByTestId('log-returned')).toHaveTextContent('After it returned')
    expect(rows[3]?.querySelector('[data-part="time"]')).toHaveTextContent('+1.2 s')
    expect(rows[3]?.querySelector('[data-part="message"]')).toHaveClass('text-kumo-subtle')
    expect(screen.getByRole('log', { name: 'Logs of #1,284' })).toHaveAttribute('aria-live', 'off')
    // Every row on the offset template, so the messages line up.
    for (const row of rows) expect(row).toHaveClass('grid-cols-[52px_44px_minmax(0,1fr)_auto]')
  })

  it('gives the message the level column while every line is info, and every row together', async () => {
    const store = storeOf([line(0), line(1, { offsetMs: 61_000, afterFinish: true })])
    render(<LogLines ariaLabel="Logs" store={store} mode="invocation" />)
    for (const row of screen.getAllByTestId('log-line'))
      expect(row).toHaveClass('grid-cols-[84px_minmax(0,1fr)_auto]', '[&>[data-part=level]]:hidden')
    // The first line with a level word brings the column back for all of them.
    act(() => store.push([line(2, { level: 'warn', offsetMs: 62_000 })]))
    await frame()
    const rows = screen.getAllByTestId('log-line')
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row).toHaveClass('grid-cols-[84px_44px_minmax(0,1fr)_auto]')
      expect(row).not.toHaveClass('[&>[data-part=level]]:hidden')
    }
  })

  it("opens a structured entry's fields as a tree", () => {
    const store = storeOf([
      line(0, { message: 'order placed', fields: { orderId: 'o_123', total: 42 } }),
    ])
    render(<LogLines ariaLabel="Logs" store={store} mode="invocation" />)
    const open = screen.getByRole('button', { name: 'Show the fields' })
    expect(screen.queryByTestId('log-fields')).toBeNull()
    fireEvent.click(open)
    expect(screen.getByRole('button', { name: 'Hide the fields' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(within(screen.getByTestId('log-fields')).getByText(/o_123/)).toBeInTheDocument()
  })

  it('ends in a breathing dot while it runs, and says when nothing was printed', () => {
    render(<LogLines ariaLabel="Logs" store={storeOf([line(0)])} mode="invocation" running />)
    expect(screen.getByTestId('log-running')).toHaveTextContent('Still running')
    cleanup()
    render(<LogLines ariaLabel="Logs" store={storeOf([])} mode="invocation" running />)
    expect(screen.getByTestId('log-lines-empty')).toHaveTextContent('Nothing printed yet.')
    cleanup()
    render(<LogLines ariaLabel="Logs" store={storeOf([])} mode="invocation" />)
    expect(screen.getByTestId('log-lines-empty')).toHaveTextContent('Nothing was printed.')
  })
})

describe("a codebase's load log", () => {
  it("writes the console's clock, one line each, and opens a cut message", () => {
    const store = storeOf([
      line(0, { message: 'compute fixture loaded' }),
      line(1, { message: 'Error: no\n  at a\n  at b' }),
    ])
    render(<LogLines ariaLabel="Load log of app" store={store} mode="codebase" />)
    const rows = screen.getAllByTestId('log-line')
    expect(rows[0]?.querySelector('[data-part="time"]')?.textContent).not.toMatch(/^\+/)
    // The clock keeps the shared row's own, wider time column.
    expect(rows[0]).toHaveClass('grid-cols-[104px_44px_minmax(0,1fr)_auto]')
    expect(rows[1]?.querySelector('[data-part="message"]')).toHaveTextContent(/^Error: no$/)
    const open = screen.getByRole('button', { name: 'Show the whole message' })
    expect(open).toHaveTextContent('+2 lines')
    fireEvent.click(open)
    // The cut lines open under the message, in its column.
    expect(screen.getByTestId('log-opened')).toHaveTextContent('at a at b')
    expect(screen.getByTestId('log-opened')).toHaveClass(
      'grid-cols-[104px_44px_minmax(0,1fr)_auto]',
    )
    expect(screen.getByRole('button', { name: 'Show one line' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.queryByTestId('log-returned')).toBeNull()
  })

  it('says a gap and a marker in their own rows', async () => {
    const store = storeOf([line(0)])
    render(<LogLines ariaLabel="Load log" store={store} mode="codebase" />)
    act(() => {
      store.gap(312, 200)
      store.marker({ kind: 'marker', key: 'restart', text: 'The engine restarted.' })
    })
    await frame()
    expect(screen.getByTestId('feed-gap')).toHaveTextContent('312 entries were missed here')
    expect(screen.getByTestId('feed-marker')).toHaveTextContent('The engine restarted.')
  })

  it('holds still while paused, counting new lines, and jumps back on asking', async () => {
    const store = storeOf([line(0), line(1)])
    const onFollowChange = vi.fn()
    const { rerender } = render(
      <LogLines
        ariaLabel="Load log"
        store={store}
        mode="codebase"
        follow
        onFollowChange={onFollowChange}
      />,
    )
    rerender(
      <LogLines
        ariaLabel="Load log"
        store={store}
        mode="codebase"
        follow={false}
        onFollowChange={onFollowChange}
      />,
    )
    act(() => store.push([line(2), line(3), line(4)]))
    await frame()
    const pill = screen.getByTestId('jump-to-latest')
    expect(pill).toHaveTextContent('3 new · Jump to latest')
    fireEvent.click(pill)
    expect(onFollowChange).toHaveBeenCalledWith(true)
  })
})

describe('a long log', () => {
  it('draws only what is on screen', () => {
    const lines = Array.from({ length: 2_000 }, (_, index) => line(index))
    render(<LogLines ariaLabel="Logs" store={storeOf(lines)} mode="invocation" />)
    const drawn = screen.getAllByTestId('log-line').length
    expect(drawn).toBeGreaterThan(0)
    expect(drawn).toBeLessThan(80)
  })

  it('holds still once the reader scrolls up, without a page to hold it', async () => {
    const restore = stubLayout({ height: 240 })
    try {
      const store = storeOf(Array.from({ length: 50 }, (_, index) => line(index)))
      render(<LogLines ariaLabel="Logs" store={store} mode="codebase" />)
      const scroller = screen.getByTestId('log-lines-list-scroll')
      act(() => {
        fireEvent.wheel(scroller)
        scrollTo(scroller, 0)
      })
      act(() => store.push([line(50), line(51)]))
      await frame()
      expect(screen.getByTestId('jump-to-latest')).toHaveTextContent('2 new · Jump to latest')
    } finally {
      restore()
    }
  })

  it('takes no keys: the page around it keeps them', () => {
    render(<LogLines ariaLabel="Logs" store={storeOf([line(0), line(1)])} mode="codebase" />)
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(document.querySelector('[data-testid="feed-row"][aria-selected="true"]')).toBeNull()
    expect(screen.getAllByTestId('feed-row')[0]).toHaveClass('select-text')
  })
})
