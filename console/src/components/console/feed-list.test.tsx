import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { type ComponentProps, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type FeedStore, createFeedStore } from '@/lib/live/feed-store'
import { dispatchShortcut } from '@/lib/shortcuts'
import { press, scrollTo, stubLayout } from '@/test/layout'
import { FeedList, gapText, itemsAfter, useFeedPending } from './feed-list'

interface Line {
  id: string
  text: string
}

const rowKey = (line: Line) => line.id
const lines = (count: number, from = 0): Line[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `l${from + index}`,
    text: `line ${from + index}`,
  }))

/** Lets the store's once-a-frame notification arrive. */
async function frame() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
}

type FeedProps = Partial<ComponentProps<typeof FeedList<Line>>> & {
  store: FeedStore<Line>
  startPaused?: boolean
}

/** A page holding the feed's state the way Logs holds it: follow, selection, expansion. */
function Feed({ store, startPaused = false, ...props }: FeedProps) {
  const [follow, setFollow] = useState(!startPaused)
  const [selected, setSelected] = useState<string | undefined>()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const pending = useFeedPending(store, !follow, rowKey)
  return (
    <>
      <span data-testid="pending">{pending}</span>
      <span data-testid="following">{String(follow)}</span>
      <FeedList<Line>
        ariaLabel="Lines"
        store={store}
        order="newest-last"
        rowHeight={28}
        rowKey={rowKey}
        renderRow={(line) => <span>{line.text}</span>}
        renderExpanded={(line) => <pre data-testid="expanded">{line.text} in full</pre>}
        expanded={expanded}
        onToggleExpanded={(key, open) =>
          setExpanded((current) => {
            const next = new Set(current)
            if (open) next.add(key)
            else next.delete(key)
            return next
          })
        }
        selectedKey={selected}
        onSelect={(line) => setSelected(line.id)}
        follow={follow}
        onFollowChange={setFollow}
        empty={<p>Nothing yet</p>}
        {...props}
      />
    </>
  )
}

let restore: () => void
beforeEach(() => {
  restore = stubLayout({ height: 320 })
})
afterEach(() => {
  cleanup()
  restore()
})

const scroller = () => screen.getByTestId('feed-scroll')
const selected = () => document.querySelector('[data-testid="feed-row"][aria-selected="true"]')
const shown = () => screen.getAllByTestId('feed-row').map((row) => row.dataset.key)
const key = (name: string, init: KeyboardEventInit = {}) =>
  act(() => {
    dispatchShortcut(press(name, init))
  })
/** The reader's own scroll: a wheel, then the position. */
const readerScrolls = (top: number) =>
  act(() => {
    fireEvent.wheel(scroller())
    scrollTo(scroller(), top)
  })

describe('what it says', () => {
  it('words a gap with the count the engine gave, or without one from another run', () => {
    expect(gapText(3_120, 10_000)).toBe(
      '3,120 entries were missed here; the engine keeps the last 10,000.',
    )
    expect(gapText(1, 500)).toBe('1 entry was missed here; the engine keeps the last 500.')
    expect(gapText(null, 10_000)).toBe('Entries from an earlier run were missed here.')
  })

  it('counts the items after a row, markers left out', () => {
    const store = createFeedStore<Line>({ max: 100, key: rowKey })
    store.push(lines(3))
    store.marker({ kind: 'marker', key: 'restart', text: 'Engine restarted' })
    store.push(lines(2, 3))
    expect(itemsAfter(store, 'l1')).toBe(3)
    expect(itemsAfter(store, undefined)).toBe(5)
    expect(itemsAfter(store, 'gone')).toBe(5)
  })
})

describe('FeedList', () => {
  it('is a log that is not read aloud, oldest first when the newest is last', async () => {
    const store = createFeedStore<Line>({ max: 100, key: rowKey })
    render(<Feed store={store} />)
    expect(screen.getByText('Nothing yet')).toBeInTheDocument()
    act(() => store.push(lines(5)))
    await frame()
    const log = screen.getByRole('log', { name: 'Lines' })
    expect(log).toHaveAttribute('aria-live', 'off')
    expect(shown()).toEqual(['l0', 'l1', 'l2', 'l3', 'l4'])
  })

  it('draws only the rows on screen, each its fixed height', async () => {
    const store = createFeedStore<Line>({ max: 10_000, key: rowKey })
    store.push(lines(5_000))
    render(<Feed store={store} />)
    await frame()
    expect(shown().length).toBeLessThan(60)
    expect(screen.getAllByTestId('feed-row')[0]?.style.height).toBe('28px')
  })

  it('follows: each frame of new rows keeps the view at the live edge', async () => {
    const store = createFeedStore<Line>({ max: 10_000, key: rowKey })
    render(<Feed store={store} />)
    act(() => store.push(lines(100)))
    await frame()
    expect(scroller().scrollTop).toBe(100 * 28)
    act(() => store.push(lines(50, 100)))
    await frame()
    expect(scroller().scrollTop).toBe(150 * 28)
    // The browser tells the virtualizer it scrolled; happy-dom does not.
    act(() => scroller().dispatchEvent(new Event('scroll')))
    expect(shown()).toContain('l149')
    expect(screen.getByTestId('following')).toHaveTextContent('true')
  })

  it('pauses when the reader scrolls away; the pill counts what arrived and jumps back', async () => {
    const store = createFeedStore<Line>({ max: 100, key: rowKey })
    render(<Feed store={store} />)
    act(() => store.push(lines(100)))
    await frame()
    readerScrolls(500)
    expect(screen.getByTestId('following')).toHaveTextContent('false')
    // Paused in buffer mode: nothing is evicted past `max` while the reader reads.
    act(() => store.push(lines(30, 100)))
    await frame()
    expect(store.size()).toBe(130)
    expect(scroller().scrollTop).toBe(500)
    expect(screen.getByTestId('pending')).toHaveTextContent('30')
    const pill = screen.getByTestId('jump-to-latest')
    expect(pill).toHaveTextContent('30 new · Jump to latest')
    fireEvent.click(pill)
    await frame()
    expect(screen.getByTestId('following')).toHaveTextContent('true')
    // Following again: the store trims back to `max` and the view is at the edge.
    expect(store.size()).toBe(100)
    expect(screen.queryByTestId('jump-to-latest')).toBeNull()
    expect(scroller().scrollTop).toBe(100 * 28)
  })

  it('counts from the newest row each time it pauses, not the first time', async () => {
    const store = createFeedStore<Line>({ max: 1_000, key: rowKey })
    render(<Feed store={store} />)
    act(() => store.push(lines(100)))
    await frame()
    readerScrolls(500)
    act(() => store.push(lines(5, 100)))
    await frame()
    expect(screen.getByTestId('pending')).toHaveTextContent('5')
    fireEvent.click(screen.getByTestId('jump-to-latest'))
    await frame()
    act(() => store.push(lines(10, 105)))
    await frame()
    expect(screen.getByTestId('pending')).toHaveTextContent('0')
    // Paused again: what arrived while it followed is not news.
    readerScrolls(500)
    act(() => store.push(lines(3, 115)))
    await frame()
    expect(screen.getByTestId('following')).toHaveTextContent('false')
    expect(screen.getByTestId('pending')).toHaveTextContent('3')
  })

  it('never pauses for its own scrolling, and follows again when the reader reaches the edge', async () => {
    const store = createFeedStore<Line>({ max: 1_000, key: rowKey })
    render(<Feed store={store} startPaused />)
    act(() => store.push(lines(100)))
    await frame()
    // A scroll nobody asked for (the list's own) changes nothing.
    act(() => scrollTo(scroller(), 100 * 28))
    expect(screen.getByTestId('following')).toHaveTextContent('false')
    readerScrolls(100 * 28)
    expect(screen.getByTestId('following')).toHaveTextContent('true')
  })

  it('in freeze mode counts what arrives instead of showing it', async () => {
    const store = createFeedStore<Line>({ max: 100, key: rowKey, pausedMode: 'freeze' })
    render(<Feed store={store} startPaused />)
    act(() => store.push(lines(10)))
    await frame()
    act(() => store.push(lines(3, 10)))
    await frame()
    expect(store.size()).toBe(0)
    expect(screen.getByTestId('pending')).toHaveTextContent('13')
  })

  it('keeps the reader’s row in place while older history pages in above it', async () => {
    const store = createFeedStore<Line>({ max: 1_000, key: rowKey })
    store.push(lines(100, 100))
    const loadMore = vi.fn()
    render(<Feed store={store} startPaused hasMore loadMore={loadMore} />)
    await frame()
    // Near the older edge: the page above is asked for.
    expect(loadMore).toHaveBeenCalled()
    act(() => scrollTo(scroller(), 30 * 28))
    act(() => store.prepend(lines(20, 80)))
    await frame()
    expect(scroller().scrollTop).toBe(50 * 28)
  })

  it('puts the newest first when asked, and holds the reader’s row as rows arrive on top', async () => {
    const store = createFeedStore<Line>({ max: 1_000, key: rowKey })
    store.push(lines(50))
    render(<Feed store={store} order="newest-first" startPaused />)
    await frame()
    expect(shown().slice(0, 3)).toEqual(['l49', 'l48', 'l47'])
    act(() => scrollTo(scroller(), 10 * 28))
    act(() => store.push(lines(5, 50)))
    await frame()
    expect(scroller().scrollTop).toBe(15 * 28)
  })

  it('holds the rows on screen still when paused at the top of a newest-first list', async () => {
    const store = createFeedStore<Line>({ max: 1_000, key: rowKey })
    store.push(lines(50))
    function Paused() {
      const [follow, setFollow] = useState(true)
      return (
        <>
          <button type="button" onClick={() => setFollow(false)}>
            Pause
          </button>
          <Feed store={store} order="newest-first" follow={follow} onFollowChange={setFollow} />
        </>
      )
    }
    render(<Paused />)
    await frame()
    // Never scrolled: the newest row is at the top, the view at 0.
    expect(scroller().scrollTop).toBe(0)
    expect(shown()[0]).toBe('l49')
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await frame()
    act(() => store.push(lines(5, 50)))
    await frame()
    // The five new rows went above the view; l49 is still the top row.
    expect(scroller().scrollTop).toBe(5 * 28)
  })

  it('draws a gap as one quiet line and a marker with its action', async () => {
    const store = createFeedStore<Line>({ max: 100, key: rowKey })
    const run = vi.fn()
    render(<Feed store={store} startPaused />)
    act(() => {
      store.push(lines(2))
      store.gap(3_120, 10_000)
      store.marker({
        kind: 'marker',
        key: 'paused',
        text: '1,204 lines arrived',
        action: { label: 'Load them', run },
      })
    })
    await frame()
    expect(screen.getByTestId('feed-gap')).toHaveTextContent(
      '⋯ 3,120 entries were missed here; the engine keeps the last 10,000.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Load them' }))
    expect(run).toHaveBeenCalled()
  })

  it('moves the selection with the arrows and j / k, expands with → and collapses with ←', async () => {
    const store = createFeedStore<Line>({ max: 100, key: rowKey })
    const onOpenTarget = vi.fn()
    render(<Feed store={store} startPaused onOpenTarget={onOpenTarget} />)
    act(() => store.push(lines(10)))
    await frame()
    key('ArrowDown')
    expect(selected()).toHaveAttribute('data-key', 'l0')
    key('j')
    key('j')
    expect(selected()).toHaveAttribute('data-key', 'l2')
    key('k')
    expect(selected()).toHaveAttribute('data-key', 'l1')
    key('ArrowRight')
    expect(screen.getByTestId('expanded')).toHaveTextContent('line 1 in full')
    // An expanded row is measured, not held to the fixed height.
    expect(selected()?.getAttribute('style')).not.toContain('height: 28px')
    key('ArrowLeft')
    expect(screen.queryByTestId('expanded')).toBeNull()
    key('o')
    expect(onOpenTarget).toHaveBeenCalledWith(expect.objectContaining({ id: 'l1' }))
  })

  it('jumps to the live edge and follows on End', async () => {
    const store = createFeedStore<Line>({ max: 1_000, key: rowKey })
    render(<Feed store={store} startPaused />)
    act(() => store.push(lines(200)))
    await frame()
    key('End')
    await frame()
    expect(screen.getByTestId('following')).toHaveTextContent('true')
    expect(scroller().scrollTop).toBe(200 * 28)
  })

  it('stays paused when a row it places for the URL lands at the live edge', async () => {
    const store = createFeedStore<Line>({ max: 1_000, key: rowKey })
    store.push(lines(100))
    function Opening() {
      const [open, setOpen] = useState<string | undefined>(undefined)
      return (
        <>
          <button type="button" onClick={() => setOpen('l97')}>
            Open
          </button>
          <Feed
            store={store}
            order="newest-first"
            startPaused
            scrollToKey={open === undefined ? undefined : { key: open }}
          />
        </>
      )
    }
    render(<Opening />)
    await frame()
    act(() => scrollTo(scroller(), 6 * 28))
    // The reader presses (a row, as it opens): the list then places the row,
    // near the newest, at the top of the view.
    fireEvent.pointerDown(scroller())
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await frame()
    expect(scroller().scrollTop).toBe(0)
    act(() => {
      scroller().dispatchEvent(new Event('scroll'))
    })
    expect(screen.getByTestId('following')).toHaveTextContent('false')
  })

  it('opens a row the URL names in the middle of the view', async () => {
    const store = createFeedStore<Line>({ max: 1_000, key: rowKey })
    store.push(lines(500))
    render(<Feed store={store} startPaused scrollToKey={{ key: 'l250' }} />)
    await frame()
    // Centred: its middle at the middle of the 320 px view.
    expect(scroller().scrollTop).toBe(250 * 28 - (320 - 28) / 2)
  })
})
