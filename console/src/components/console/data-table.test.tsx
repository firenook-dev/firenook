import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePaletteProviders } from '@/lib/palette'
import { dispatchShortcut } from '@/lib/shortcuts'
import { press, scrollTo, stubLayout } from '@/test/layout'
import { useColumnWidths, useHiddenColumns } from './column-widths'
import {
  DataTable,
  type DataTableColumn,
  type DataTableProps,
  type DataTableSort,
  ariaRowCount,
  isDataName,
  nextSort,
  rangeKeys,
  useHiddenColumnCount,
} from './data-table'

interface User {
  uid: string
  email: string
  age: number
}

function users(count: number, from = 0): User[] {
  return Array.from({ length: count }, (_, index) => {
    const n = from + index
    return {
      uid: `u${String(n).padStart(4, '0')}`,
      email: `user${n}@example.test`,
      age: 20 + (n % 50),
    }
  })
}

const COLUMNS: DataTableColumn<User>[] = [
  {
    id: 'uid',
    header: 'uid',
    width: 160,
    pinned: true,
    cell: (row) => row.uid,
    copy: (row) => row.uid,
  },
  {
    id: 'email',
    header: 'Email',
    width: 240,
    sortable: true,
    cell: (row) => row.email,
    copy: (row) => row.email,
  },
  { id: 'age', header: 'Age', width: 80, align: 'end', cell: (row) => row.age },
]

type HarnessProps = Partial<DataTableProps<User>> & { rows: readonly User[]; select?: boolean }

/** A table with its selection held in state, as a page holds it. */
function Harness({ select = false, ...props }: HarnessProps) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [everything, setEverything] = useState(false)
  return (
    <DataTable<User>
      ariaLabel="Users"
      rowKey={(row) => row.uid}
      columns={COLUMNS}
      memoryKey="test.users"
      empty={<p>No users yet</p>}
      selection={
        select
          ? {
              checked,
              everything,
              onChange: (next, all) => {
                setChecked(next)
                setEverything(all)
              },
            }
          : undefined
      }
      {...props}
    />
  )
}

let restore: () => void
beforeEach(() => {
  restore = stubLayout({ height: 320 })
  localStorage.clear()
  useColumnWidths.setState({ widths: {} })
  useHiddenColumns.setState({ choices: {} })
  Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' })
})
afterEach(() => {
  cleanup()
  restore()
  vi.useRealTimers()
})

const grid = () => screen.getByRole('grid', { name: 'Users' })
const headerOf = (id: string) =>
  screen.getAllByRole('columnheader').find((element) => element.dataset.column === id)
const scroller = () => screen.getByTestId('data-table-scroll')
const rowsInDom = () => screen.getAllByTestId('data-row')
const cursorRow = () => document.querySelector('tr[data-cursor]')?.getAttribute('data-key')
const key = (name: string, init: KeyboardEventInit = {}) =>
  act(() => {
    dispatchShortcut(press(name, init))
  })

describe('what it decides on its own', () => {
  it('cycles a sort ascending, descending, then the list’s own order', () => {
    expect(nextSort(undefined, 'email')).toEqual({ column: 'email', direction: 'asc' })
    expect(nextSort({ column: 'email', direction: 'asc' }, 'email')).toEqual({
      column: 'email',
      direction: 'desc',
    })
    expect(nextSort({ column: 'email', direction: 'desc' }, 'email')).toBeUndefined()
    expect(nextSort({ column: 'email', direction: 'desc' }, 'uid')).toEqual({
      column: 'uid',
      direction: 'asc',
    })
  })

  it('counts the header in aria-rowcount, and says -1 when the whole is not known', () => {
    const base = { loaded: 100, rowOffset: 0, hasMore: false, hasPrevious: false }
    expect(ariaRowCount({ ...base, total: { count: 48_213, exact: true } })).toBe(48_214)
    expect(ariaRowCount({ ...base, total: undefined })).toBe(101)
    expect(ariaRowCount({ ...base, total: { count: 200_000, exact: false }, hasMore: true })).toBe(
      -1,
    )
    expect(ariaRowCount({ ...base, total: undefined, rowOffset: 1900, hasPrevious: true })).toBe(-1)
  })

  it('takes a shift-click’s range from the last row ticked', () => {
    const keys = ['a', 'b', 'c', 'd', 'e']
    expect(rangeKeys(keys, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeKeys(keys, 'd', 'a')).toEqual(['a', 'b', 'c', 'd'])
    expect(rangeKeys(keys, undefined, 'c')).toEqual(['c'])
    expect(rangeKeys(keys, 'gone', 'c')).toEqual(['c'])
  })

  it('sets a data name in the data face and English in the interface face', () => {
    expect(isDataName('uid')).toBe(true)
    expect(isDataName('__name__')).toBe(true)
    expect(isDataName('createdAt')).toBe(false)
    expect(isDataName('Last sign-in')).toBe(false)
  })
})

describe('DataTable', () => {
  it('virtualizes, and announces each row where it is in the whole list', () => {
    render(
      <Harness
        rows={users(2000, 1900)}
        rowOffset={1900}
        total={{ count: 48_213, exact: true }}
        hasMore
      />,
    )
    expect(grid()).toHaveAttribute('aria-rowcount', '48214')
    expect(rowsInDom().length).toBeLessThan(40)
    expect(rowsInDom()[0]).toHaveAttribute('aria-rowindex', '1902')
    expect(rowsInDom()[0]).toHaveAttribute('data-key', 'u1900')
    expect(within(grid()).getAllByRole('row')[0]).toHaveAttribute('aria-rowindex', '1')
  })

  it('sets the header’s data names in the data face and pins the pinned column', () => {
    render(<Harness rows={users(3)} />)
    const uid = screen.getAllByRole('columnheader').find((head) => head.dataset.column === 'uid')
    expect(uid?.querySelector('.font-mono')).toHaveTextContent('uid')
    const email = screen
      .getAllByRole('columnheader')
      .find((head) => head.dataset.column === 'email')
    expect(email?.querySelector('.font-sans')).toHaveTextContent('Email')
    const cell = rowsInDom()[0]?.querySelector('td[data-column="uid"]') as HTMLElement
    expect(cell.className).toContain('sticky')
    expect(cell.style.left).toBe('0px')
  })

  it('moves the cursor with the arrows, Home, End and a screen at a time, and the inspector follows', () => {
    const onCursorChange = vi.fn()
    const loadMore = vi.fn()
    render(
      <Harness rows={users(1000)} onCursorChange={onCursorChange} hasMore loadMore={loadMore} />,
    )
    key('ArrowDown')
    expect(cursorRow()).toBe('u0000')
    key('ArrowDown')
    expect(cursorRow()).toBe('u0001')
    expect(onCursorChange).toHaveBeenLastCalledWith(expect.objectContaining({ uid: 'u0001' }))
    // A screen is the rows under the 33 px header: (320 − 33) / 32 = 8.
    key('PageDown')
    expect(cursorRow()).toBe('u0009')
    key('PageUp')
    expect(cursorRow()).toBe('u0001')
    key('End')
    // The browser tells the virtualizer it scrolled; happy-dom does not.
    act(() => scrollTo(scroller(), scroller().scrollTop))
    expect(cursorRow()).toBe('u0999')
    // End loads on with the next page, and the last row is in view.
    expect(loadMore).toHaveBeenCalled()
    expect(scroller().scrollTop).toBe(33 + 1000 * 32 - 320)
    key('Home')
    act(() => scrollTo(scroller(), scroller().scrollTop))
    expect(cursorRow()).toBe('u0000')
    expect(scroller().scrollTop).toBe(0)
  })

  it('moves along the cells, and the cursor cell is the grid’s active descendant', () => {
    render(<Harness rows={users(5)} />)
    key('ArrowDown')
    key('ArrowRight')
    const active = () => document.getElementById(grid().getAttribute('aria-activedescendant') ?? '')
    expect(active()).toHaveAttribute('data-column', 'uid')
    key('ArrowRight')
    expect(active()).toHaveAttribute('data-column', 'email')
    expect(active()?.className).toContain('shadow-[inset_0_0_0_1.5px')
    key('ArrowLeft')
    key('ArrowLeft')
    // Left of the first column is the row itself.
    expect(active()?.tagName).toBe('TR')
  })

  it('opens on Enter, ticks on Space and every loaded row on ⌘A', () => {
    const onOpen = vi.fn()
    render(<Harness rows={users(30)} select onOpen={onOpen} />)
    key('ArrowDown')
    key('Enter')
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ uid: 'u0000' }))
    key(' ')
    expect(screen.getByRole('checkbox', { name: 'Select u0000' })).toBeChecked()
    expect(rowsInDom()[0]).toHaveAttribute('aria-selected', 'true')
    key('a', { metaKey: true })
    expect(screen.getByRole('checkbox', { name: 'Select u0005' })).toBeChecked()
    expect(grid()).toHaveAttribute('aria-multiselectable', 'true')
  })

  it('ticks a range with shift, and the header box ticks or clears every loaded row', () => {
    render(<Harness rows={users(10)} select />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select u0002' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select u0005' }), { shiftKey: true })
    for (const n of [2, 3, 4, 5])
      expect(screen.getByRole('checkbox', { name: `Select u000${n}` })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Select u0006' })).not.toBeChecked()
    const all = screen.getByRole('checkbox', { name: 'Select every loaded row' })
    fireEvent.click(all)
    expect(screen.getByRole('checkbox', { name: 'Select u0009' })).toBeChecked()
    fireEvent.click(all)
    expect(screen.getByRole('checkbox', { name: 'Select u0002' })).not.toBeChecked()
  })

  it('sorts from the headers an index backs, and says how', () => {
    function Sorted() {
      const [sort, setSort] = useState<DataTableSort | undefined>()
      return <Harness rows={users(5)} sort={sort} onSortChange={setSort} />
    }
    render(<Sorted />)
    expect(headerOf('email')).toHaveAttribute('aria-sort', 'none')
    expect(headerOf('age')).not.toHaveAttribute('aria-sort')
    expect(within(headerOf('age') as HTMLElement).queryByTestId('sort-header')).toBeNull()
    const button = within(headerOf('email') as HTMLElement).getByTestId('sort-header')
    fireEvent.click(button)
    expect(headerOf('email')).toHaveAttribute('aria-sort', 'ascending')
    fireEvent.click(button)
    expect(headerOf('email')).toHaveAttribute('aria-sort', 'descending')
    fireEvent.click(button)
    expect(headerOf('email')).toHaveAttribute('aria-sort', 'none')
  })

  it('opens a row on click, or only moves the cursor where the row says so', () => {
    const onOpen = vi.fn()
    render(
      <Harness
        rows={users(5)}
        onOpen={onOpen}
        rowClick={(row) => (row.uid === 'u0001' ? 'cursor' : 'open')}
      />,
    )
    fireEvent.click(rowsInDom()[1]?.querySelector('td[data-column="email"]') as Element)
    expect(onOpen).not.toHaveBeenCalled()
    expect(cursorRow()).toBe('u0001')
    expect(document.querySelector('td[data-cursor]')).toHaveAttribute('data-column', 'email')
    fireEvent.click(rowsInDom()[2]?.querySelector('td[data-column="email"]') as Element)
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ uid: 'u0002' }))
  })

  it('copies the cursor cell with ⌘C, or the row’s key off the cells', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<Harness rows={users(5)} />)
    key('ArrowDown')
    key('c', { metaKey: true })
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('u0000'))
    key('ArrowRight')
    key('ArrowRight')
    key('c', { metaKey: true })
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('user0@example.test'))
  })

  it('keeps the reader’s row in place when rows arrive above it, and counts them in the pill', () => {
    const onShowNew = vi.fn()
    const { rerender } = render(<Harness rows={users(100, 100)} onShowNew={onShowNew} />)
    act(() => scrollTo(scroller(), 640))
    rerender(<Harness rows={[...users(5, 95), ...users(100, 100)]} onShowNew={onShowNew} />)
    expect(scroller().scrollTop).toBe(640 + 5 * 32)
    const pill = screen.getByTestId('new-above')
    expect(pill).toHaveTextContent('5 new · Show')
    fireEvent.click(pill)
    expect(scroller().scrollTop).toBe(0)
    expect(onShowNew).toHaveBeenCalled()
    expect(screen.queryByTestId('new-above')).toBeNull()
  })

  it('keeps a row the keyboard revealed in view when the rows change before the scroll is reported', () => {
    const { rerender } = render(<Harness rows={users(1000)} />)
    act(() => scrollTo(scroller(), 900 * 32 + 12))
    // Home reveals the first row; the page renders again (a new array of
    // the same rows) before the browser reports that scroll.
    key('Home')
    rerender(<Harness rows={[...users(1000)]} />)
    expect(scroller().scrollTop).toBe(0)
    act(() => scrollTo(scroller(), scroller().scrollTop))
    expect(cursorRow()).toBe('u0000')
    key('End')
    const end = scroller().scrollTop
    rerender(<Harness rows={[...users(1000)]} />)
    expect(scroller().scrollTop).toBe(end)
  })

  it('shows rows that arrive at the very top: nothing is held there', () => {
    const { rerender } = render(<Harness rows={users(100, 100)} />)
    rerender(<Harness rows={[...users(5, 95), ...users(100, 100)]} />)
    expect(scroller().scrollTop).toBe(0)
    expect(screen.queryByTestId('new-above')).toBeNull()
  })

  it('takes the page’s own count for the pill when it keeps one', () => {
    render(<Harness rows={users(100)} newAbove={12} />)
    act(() => scrollTo(scroller(), 320))
    expect(screen.getByTestId('new-above')).toHaveTextContent('12 new · Show')
  })

  it('slides its window without moving the rows under the reader', () => {
    const { rerender } = render(<Harness rows={users(200)} rowOffset={0} hasMore />)
    act(() => scrollTo(scroller(), 150 * 32))
    // The first page (100 rows) dropped, the next one read in.
    rerender(<Harness rows={users(200, 100)} rowOffset={100} hasMore hasPrevious />)
    expect(scroller().scrollTop).toBe(50 * 32)
    act(() => scrollTo(scroller(), scroller().scrollTop))
    expect(document.querySelector('tr[data-key="u0150"]')).toHaveAttribute('aria-rowindex', '152')
    expect(screen.queryByTestId('new-above')).toBeNull()
  })

  it('asks for the next page near the end, and the page above near the top', () => {
    const loadMore = vi.fn()
    const loadPrevious = vi.fn()
    render(
      <Harness
        rows={users(200)}
        hasMore
        loadMore={loadMore}
        hasPrevious
        loadPrevious={loadPrevious}
      />,
    )
    // At the top: the page above.
    expect(loadPrevious).toHaveBeenCalled()
    expect(loadMore).not.toHaveBeenCalled()
    act(() => scrollTo(scroller(), 190 * 32))
    expect(loadMore).toHaveBeenCalled()
  })

  it('opens the cursor row’s menu on Shift+F10, destructive items last', async () => {
    const run = vi.fn()
    render(
      <Harness
        rows={users(5)}
        rowMenu={(row) => [
          { id: 'delete', label: 'Delete…', danger: true, run },
          { id: 'copy', label: `Copy ${row.uid}`, run },
          {
            id: 'disable',
            label: 'Disable…',
            disabled: 'Anonymous users cannot be disabled.',
            run,
          },
        ]}
      />,
    )
    key('ArrowDown')
    key('F10', { shiftKey: true })
    const menu = await screen.findByTestId('row-menu')
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(['Copy u0000', 'Disable…', 'Delete…'])
    expect(within(menu).getByRole('separator')).toBeInTheDocument()
    expect(screen.getByTestId('row-menu-disable')).toHaveAttribute('data-disabled')
    fireEvent.click(screen.getByTestId('row-menu-copy'))
    expect(run).toHaveBeenCalled()
  })

  it('offers the cursor row’s menu in ⌘K under its key', () => {
    render(
      <Harness
        rows={users(5)}
        rowMenu={(row) => [{ id: 'copy', label: `Copy ${row.uid}`, run: () => {} }]}
      />,
    )
    expect(usePaletteProviders.getState().providers['row-menu']).toBeUndefined()
    key('ArrowDown')
    const groups = usePaletteProviders.getState().providers['row-menu']?.('') ?? []
    expect(groups[0]?.label).toBe('u0000')
    expect(groups[0]?.items.map((item) => item.title)).toEqual(['Copy u0000'])
    cleanup()
    expect(usePaletteProviders.getState().providers['row-menu']).toBeUndefined()
  })

  it('opens the same menu on a right-click, the cursor moved there and the row not opened', async () => {
    const onOpen = vi.fn()
    render(
      <Harness
        rows={users(5)}
        onOpen={onOpen}
        rowMenu={() => [{ id: 'open', label: 'Open', run: () => {} }]}
      />,
    )
    fireEvent.contextMenu(rowsInDom()[3]?.querySelector('td[data-column="email"]') as Element, {
      clientX: 200,
      clientY: 150,
    })
    expect(cursorRow()).toBe('u0003')
    expect(await screen.findByTestId('row-menu-open')).toBeInTheDocument()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('hides a column from its menu and remembers it for the list', async () => {
    function Footered() {
      const hidden = useHiddenColumnCount('test.users', COLUMNS)
      return (
        <Harness rows={users(3)} footer={<span data-testid="hidden-count">{hidden.hidden}</span>} />
      )
    }
    render(<Footered />)
    fireEvent.click(screen.getByTestId('columns-menu'))
    fireEvent.click(await screen.findByTestId('column-toggle-age'))
    expect(screen.getAllByRole('columnheader').some((head) => head.dataset.column === 'age')).toBe(
      false,
    )
    expect(screen.getByTestId('hidden-count')).toHaveTextContent('1')
    expect(JSON.parse(localStorage.getItem('firenook.console.hidden-columns') ?? '{}')).toEqual({
      'test.users': { age: true },
    })
  })

  it('draws a column hidden by default only once it is shown', () => {
    const [uid, email, age] = COLUMNS as [
      DataTableColumn<User>,
      DataTableColumn<User>,
      DataTableColumn<User>,
    ]
    const columns = [uid, email, Object.assign({}, age, { hiddenByDefault: true })]
    render(<Harness rows={users(3)} columns={columns} />)
    expect(screen.getAllByRole('columnheader').some((head) => head.dataset.column === 'age')).toBe(
      false,
    )
    act(() => useHiddenColumns.getState().setHidden('test.users', 'age', false))
    expect(screen.getAllByRole('columnheader').some((head) => head.dataset.column === 'age')).toBe(
      true,
    )
  })

  it('uses a dragged width, remembered per list', () => {
    act(() => useColumnWidths.getState().set('test.users', 'email', 400))
    render(<Harness rows={users(3)} />)
    const cols = grid().querySelectorAll('col')
    // check column absent: uid, email, age, slack, tools.
    expect((cols[1] as HTMLElement).style.width).toBe('400px')
  })

  it('shows the empty state with no rows, and the header over a skeleton while loading', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Harness rows={[]} />)
    expect(screen.getByText('No users yet')).toBeInTheDocument()
    expect(screen.queryByRole('grid')).toBeNull()
    rerender(<Harness rows={[]} loading />)
    expect(grid()).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByTestId('table-skeleton')).toBeNull()
    act(() => vi.advanceTimersByTime(160))
    expect(screen.getByTestId('table-skeleton')).toBeInTheDocument()
  })

  it('flashes the rows the live channel touched, and follows the open row', () => {
    const { rerender } = render(
      <Harness rows={users(5)} flashes={new Map([['u0001', 'updated']])} onOpen={() => {}} />,
    )
    expect(rowsInDom()[1]?.className).toContain('row-flash')
    rerender(<Harness rows={users(5)} openKey="u0003" onOpen={() => {}} />)
    expect(cursorRow()).toBe('u0003')
    expect(screen.getByRole('button', { name: 'Open u0003' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('takes keys only while it has focus when told to', () => {
    const onCursorChange = vi.fn()
    render(<Harness rows={users(5)} keyboard="focus" onCursorChange={onCursorChange} />)
    key('ArrowDown')
    expect(onCursorChange).not.toHaveBeenCalled()
    fireEvent.keyDown(scroller(), { key: 'ArrowDown' })
    expect(cursorRow()).toBe('u0000')
  })
})
