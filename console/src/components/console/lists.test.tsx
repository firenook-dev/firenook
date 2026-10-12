// The small list pieces: the count slot, the footer, the selection bar, the
// row menu, the pause button and the remembered column choices.

import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePaletteProviders } from '@/lib/palette'
import { dispatchShortcut } from '@/lib/shortcuts'
import { press } from '@/test/layout'
import {
  COLUMN_MAX,
  clampColumn,
  isColumnHidden,
  useColumnWidths,
  useHiddenColumns,
} from './column-widths'
import { MatchCount, matchCountTooltip } from './match-count'
import { PauseButton, pauseLabel } from './pause-button'
import {
  RowMenu,
  RowMenuButton,
  type RowMenuItem,
  menuOrder,
  rowMenuGroups,
  useRowMenuPalette,
} from './row-menu'
import { SelectionBar } from './selection-bar'
import { TableFooter, footerText } from './table-footer'

const USERS = { one: 'user', other: 'users' }

beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' })
})
afterEach(cleanup)

describe('MatchCount', () => {
  it('prints the figure alone, in a slot sized for the widest one', () => {
    render(<MatchCount total={{ count: 240, exact: true }} noun={USERS} widest="0,000,000" />)
    expect(screen.getByTestId('match-count')).toHaveTextContent('240 users')
    expect(screen.getByText('0,000,000').closest('[aria-hidden]')).toHaveClass('invisible')
    render(
      <MatchCount total={{ count: 1, exact: true }} noun={USERS} widest="0,000" testId="one" />,
    )
    expect(screen.getByTestId('one')).toHaveTextContent('1 user')
  })

  it('says when a scan budget stopped the count, and when counting stopped at a ceiling', () => {
    render(
      <MatchCount
        total={{ count: 18, exact: false }}
        scanned={200_000}
        noun={USERS}
        widest="000,000+"
      />,
    )
    expect(screen.getByTestId('match-count')).toHaveTextContent('200,000+ searched')
    expect(matchCountTooltip({ count: 18, exact: false }, USERS, 200_000)).toBe(
      'Searched 200,000 users so far and found 18; more are searched as you scroll.',
    )
    expect(matchCountTooltip({ count: 10_000, exact: false }, USERS, undefined)).toBe(
      'At least 10,000 users match; counting stopped there.',
    )
    expect(matchCountTooltip({ count: 240, exact: true }, USERS, undefined)).toBe(
      'Every user this filter matches, not only the rows loaded.',
    )
  })

  it('carries a detail, a stale view’s Refresh, and its empty, loading and failed states', () => {
    const onRefresh = vi.fn()
    const { rerender } = render(
      <MatchCount
        total={{ count: 240, exact: true }}
        noun={{ one: 'object', other: 'objects' }}
        widest="0,000"
        detail="38 MB"
        stale={{ count: 1_204, onRefresh }}
      />,
    )
    expect(screen.getByTestId('match-count')).toHaveTextContent('240 objects · 38 MB')
    fireEvent.click(screen.getByTestId('match-count-refresh'))
    expect(onRefresh).toHaveBeenCalled()
    expect(screen.getByTestId('match-count-refresh')).toHaveTextContent('1,204 changes · Refresh')
    rerender(<MatchCount total={undefined} noun={USERS} widest="0,000" loading />)
    expect(screen.getByTestId('match-count')).toHaveTextContent('…')
    rerender(<MatchCount total={undefined} noun={USERS} widest="0,000" failed />)
    expect(screen.getByTestId('match-count')).toHaveTextContent('Count unavailable')
    rerender(<MatchCount total={{ count: 3, exact: true }} noun={USERS} widest="0,000" hidden />)
    expect(screen.queryByTestId('match-count')).toBeNull()
    rerender(<MatchCount total={undefined} noun={USERS} widest="0,000" />)
    expect(screen.queryByTestId('match-count')).toBeNull()
  })
})

describe('TableFooter', () => {
  it('says what is loaded, or where the window is in the whole list', () => {
    expect(footerText({ loaded: 240, hasMore: true })).toBe('240 loaded · more on scroll')
    expect(footerText({ loaded: 12, hasMore: false })).toBe('12 loaded')
    expect(
      footerText({
        loaded: 2_000,
        rowOffset: 1_900,
        total: { count: 48_213, exact: true },
        hasMore: true,
      }),
    ).toBe('rows 1,901–3,900 of 48,213 · more on scroll')
    expect(
      footerText({
        loaded: 2_000,
        rowOffset: 100,
        total: { count: 9_000, exact: false },
        hasMore: false,
      }),
    ).toBe('rows 101–2,100 of 9,000+')
  })

  it('offers the hidden columns back and puts the actions at the right end', () => {
    const onShowAll = vi.fn()
    render(
      <TableFooter
        loaded={10}
        hasMore={false}
        hiddenColumns={2}
        onShowAll={onShowAll}
        noun={USERS}
        actions={<button type="button">Export</button>}
      />,
    )
    fireEvent.click(screen.getByTestId('show-all-columns'))
    expect(onShowAll).toHaveBeenCalled()
    expect(screen.getByTestId('show-all-columns')).toHaveTextContent('2 hidden columns · show all')
    expect(screen.getByRole('status', { name: 'Loaded users' })).toHaveTextContent('10 loaded')
  })
})

describe('SelectionBar', () => {
  it('counts the ticked rows and offers every match, named as matching under a filter', () => {
    const onSelectEverything = vi.fn()
    const onClear = vi.fn()
    const { rerender } = render(
      <SelectionBar
        count={3}
        total={{ count: 240, exact: true }}
        everything={false}
        filtered
        noun={USERS}
        detail="12.4 MB"
        onSelectEverything={onSelectEverything}
        onClear={onClear}
        actions={<button type="button">Delete 3</button>}
      />,
    )
    expect(screen.getByRole('toolbar', { name: 'Selected users' })).toBeInTheDocument()
    expect(screen.getByTestId('selection-count')).toHaveTextContent('3 selected')
    expect(screen.getByText('· 12.4 MB')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('select-everything'))
    expect(onSelectEverything).toHaveBeenCalled()
    expect(screen.getByTestId('select-everything')).toHaveTextContent('Select all 240 matching')
    fireEvent.click(screen.getByTestId('clear-selection'))
    expect(onClear).toHaveBeenCalled()
    rerender(
      <SelectionBar
        count={240}
        total={{ count: 240, exact: true }}
        everything
        filtered={false}
        noun={USERS}
        onSelectEverything={onSelectEverything}
        onClear={onClear}
        actions={null}
      />,
    )
    expect(screen.getByTestId('selection-count')).toHaveTextContent('All 240 selected')
    expect(screen.queryByTestId('select-everything')).toBeNull()
  })
})

describe('RowMenu', () => {
  const run = vi.fn()
  const ITEMS: RowMenuItem[] = [
    { id: 'delete', label: 'Delete…', danger: true, run },
    { id: 'copy', label: 'Copy uid', shortcut: 'Mod+c', run },
    { id: 'disable', label: 'Disable…', disabled: 'Already disabled.', run },
    { id: 'open', label: 'Open', run },
  ]

  it('lists the destructive items last, in the order given otherwise', () => {
    const { safe, danger } = menuOrder(ITEMS)
    expect(safe.map((item) => item.id)).toEqual(['copy', 'disable', 'open'])
    expect(danger.map((item) => item.id)).toEqual(['delete'])
  })

  it('offers the enabled items in ⌘K under the row’s name', () => {
    const groups = rowMenuGroups(ITEMS, 'u_9f3k2', '')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.label).toBe('u_9f3k2')
    expect(groups[0]?.items.map((item) => item.title)).toEqual(['Copy uid', 'Open', 'Delete…'])
    expect(
      rowMenuGroups(ITEMS, 'u_9f3k2', 'u_9f3 dele')[0]?.items.map((item) => item.title),
    ).toEqual(['Delete…'])
    expect(rowMenuGroups(ITEMS, 'u_9f3k2', 'nothing')).toEqual([])
  })

  it('registers the provider while there is a row, and takes it away after', () => {
    const { rerender, unmount } = renderHook(({ items }) => useRowMenuPalette(items, 'u_9f3k2'), {
      initialProps: { items: ITEMS as RowMenuItem[] | undefined },
    })
    expect(usePaletteProviders.getState().providers['row-menu']).toBeDefined()
    rerender({ items: undefined })
    expect(usePaletteProviders.getState().providers['row-menu']).toBeUndefined()
    unmount()
  })

  it('opens from its ⋯ button with the shortcut beside an item and the reason on a dimmed one', async () => {
    render(<RowMenuButton items={ITEMS} label="Actions for u_9f3k2" />)
    fireEvent.click(screen.getByRole('button', { name: 'Actions for u_9f3k2' }))
    const menu = await screen.findByTestId('row-menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Copy uid⌘C', 'Disable…', 'Open', 'Delete…'])
    expect(screen.getByTestId('row-menu-disable')).toHaveAttribute('data-disabled')
    fireEvent.click(screen.getByTestId('row-menu-open'))
    expect(run).toHaveBeenCalled()
  })

  it('opens at the pointer on a right-click of the row it wraps', async () => {
    render(
      <RowMenu items={ITEMS}>
        <div data-testid="line">a line</div>
      </RowMenu>,
    )
    fireEvent.contextMenu(screen.getByTestId('line'), { clientX: 40, clientY: 50 })
    expect(await screen.findByTestId('row-menu-copy')).toBeInTheDocument()
  })
})

describe('PauseButton', () => {
  it('says Pause, or Paused with what arrived, and flips on p', () => {
    expect(pauseLabel(false, 0)).toBe('Pause')
    expect(pauseLabel(true, 0)).toBe('Paused')
    expect(pauseLabel(true, 1_204)).toBe('Paused · 1,204 new')
    const onChange = vi.fn()
    render(<PauseButton paused={false} pending={0} onChange={onChange} />)
    const button = screen.getByTestId('pause-button')
    expect(button).toHaveAttribute('aria-pressed', 'false')
    act(() => {
      dispatchShortcut(press('p'))
    })
    expect(onChange).toHaveBeenCalledWith(true)
    fireEvent.click(button)
    expect(onChange).toHaveBeenCalledTimes(2)
  })
})

describe('remembered column choices', () => {
  it('keeps a dragged width inside the bounds, and a column’s own floor', () => {
    expect(clampColumn(10)).toBe(64)
    expect(clampColumn(10, 120)).toBe(120)
    expect(clampColumn(5_000)).toBe(COLUMN_MAX)
    act(() => useColumnWidths.getState().set('auth.users', 'email', 300.4))
    expect(useColumnWidths.getState().widths['auth.users']).toEqual({ email: 300 })
    act(() => useColumnWidths.getState().resetAll('auth.users'))
    expect(useColumnWidths.getState().widths['auth.users']).toBeUndefined()
  })

  it('hides by default until shown, and a choice holds against the default', () => {
    expect(isColumnHidden(undefined, { id: 'age', hiddenByDefault: true })).toBe(true)
    expect(isColumnHidden({ age: false }, { id: 'age', hiddenByDefault: true })).toBe(false)
    expect(isColumnHidden({ age: true }, { id: 'age' })).toBe(true)
    act(() => useHiddenColumns.getState().showAll('auth.users', ['age', 'email']))
    expect(useHiddenColumns.getState().choices['auth.users']).toEqual({ age: false, email: false })
  })
})
