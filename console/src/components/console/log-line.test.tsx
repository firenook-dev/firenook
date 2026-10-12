import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LogLine, extraLines } from './log-line'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const pad = (value: number, width = 2) => String(value).padStart(width, '0')
const part = (row: HTMLElement, name: string) => row.querySelector(`[data-part="${name}"]`)

const AT = '2026-10-12T06:09:09.126Z'

/** Marks every `cart` in a text, as a page's search would. */
const mark = (text: string) =>
  text.split(/(cart)/).map((piece, index) =>
    piece === 'cart' ? (
      // oxlint-disable-next-line react/no-array-index-key -- the pieces of one fixed string
      <mark key={index}>{piece}</mark>
    ) : (
      piece
    ),
  )

describe('a log line', () => {
  it('writes the time in the console-wide clock format, or the offset it is given', () => {
    render(<LogLine time={AT} level="info" message="loading cart for u_9f3k2" data-testid="row" />)
    const local = new Date(AT)
    expect(part(screen.getByTestId('row'), 'time')).toHaveTextContent(
      `${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}.126`,
    )
    cleanup()
    render(<LogLine time={AT} timeText="+12 ms" level="info" message="hi" data-testid="row" />)
    expect(part(screen.getByTestId('row'), 'time')).toHaveTextContent('+12 ms')
  })

  it('follows the clock preference to UTC and to how long ago', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-10-12T06:09:13.200Z'))
    localStorage.setItem('firenook.console.clock-format', 'utc')
    window.dispatchEvent(new StorageEvent('storage', { key: 'firenook.console.clock-format' }))
    render(<LogLine time={AT} level="info" message="hi" data-testid="row" />)
    expect(part(screen.getByTestId('row'), 'time')).toHaveTextContent('2026-10-12T06:09:09.126Z')
    cleanup()
    localStorage.setItem('firenook.console.clock-format', 'relative')
    window.dispatchEvent(new StorageEvent('storage', { key: 'firenook.console.clock-format' }))
    render(<LogLine time={AT} level="info" message="hi" data-testid="row" />)
    expect(part(screen.getByTestId('row'), 'time')).toHaveTextContent('3 s ago')
    localStorage.removeItem('firenook.console.clock-format')
    window.dispatchEvent(new StorageEvent('storage', { key: 'firenook.console.clock-format' }))
  })

  it('names the level only when it is not info, with a rail for warnings and errors', () => {
    render(
      <>
        <LogLine time={AT} level="info" message="a" data-testid="info" />
        <LogLine time={AT} level="debug" message="b" data-testid="debug" />
        <LogLine time={AT} level="warn" message="c" data-testid="warn" />
        <LogLine time={AT} level="error" message="d" data-testid="error" />
      </>,
    )
    expect(part(screen.getByTestId('info'), 'level')).toHaveTextContent(/^$/)
    expect(part(screen.getByTestId('debug'), 'level')).toHaveTextContent('debug')
    expect(part(screen.getByTestId('debug'), 'message')?.className).toContain('text-kumo-subtle')
    expect(part(screen.getByTestId('warn'), 'level')?.className).toContain('before:bg-kumo-warning')
    expect(part(screen.getByTestId('error'), 'level')?.className).toContain('before:bg-kumo-danger')
    expect(part(screen.getByTestId('error'), 'level')?.className).toContain('text-kumo-danger')
    expect(part(screen.getByTestId('info'), 'level')?.className).not.toContain('before:')
    expect(screen.getByTestId('warn')).toHaveAttribute('data-level', 'warn')
  })

  it('draws a source as the quiet chip, and a node as given', () => {
    render(
      <>
        <LogLine time={AT} level="info" source="hello" message="a" data-testid="text" />
        <LogLine
          time={AT}
          level="info"
          source={<button type="button">fn</button>}
          message="b"
          data-testid="node"
        />
        <LogLine time={AT} level="info" message="c" data-testid="none" />
      </>,
    )
    const chip = part(screen.getByTestId('text'), 'source')?.firstElementChild
    expect(chip).toHaveTextContent('hello')
    expect(chip?.className).toContain('bg-kumo-tint')
    expect(part(screen.getByTestId('node'), 'source')?.querySelector('button')).toHaveTextContent(
      'fn',
    )
    expect(part(screen.getByTestId('none'), 'source')).toBeNull()
  })

  it('says how many more lines there are, the repeat count, and the trail', () => {
    const trace =
      "TypeError: cannot read 'id' of undefined\n    at handler (index.js:41:18)\n    at next (router.js:95:5)"
    render(
      <LogLine
        time={AT}
        level="error"
        message={trace}
        repeat={12}
        trail={<a href="#why">See why</a>}
        data-testid="row"
      />,
    )
    const row = screen.getByTestId('row')
    // At rest, the first line alone; the rest is counted.
    expect(part(row, 'message')?.textContent).toBe("TypeError: cannot read 'id' of undefined")
    expect(part(row, 'more')).toHaveTextContent('+2 lines')
    expect(part(row, 'repeat')).toHaveTextContent('×12')
    expect(part(row, 'trail')?.querySelector('a')).toHaveTextContent('See why')
    expect(row.className).toContain('h-[24px]')
    cleanup()
    render(
      <LogLine time={AT} level="info" message="one" lines={14} height={28} data-testid="row" />,
    )
    expect(part(screen.getByTestId('row'), 'more')).toHaveTextContent('+14 lines')
    expect(screen.getByTestId('row').className).toContain('h-[28px]')
  })

  it('opens to the whole message, wrapped, the later lines fainter, with its detail under it', () => {
    render(
      <LogLine
        time={AT}
        level="error"
        message={'first line\nsecond line'}
        expanded
        detail={<div data-testid="payload">{'{ cartId: "c_19" }'}</div>}
        data-testid="row"
      />,
    )
    const row = screen.getByTestId('row')
    const message = part(row, 'message')
    expect(message?.className).toContain('whitespace-pre-wrap')
    expect(message?.querySelector('.text-kumo-subtle')?.textContent).toBe('\nsecond line')
    expect(part(row, 'more')).toBeNull()
    expect(screen.getByTestId('payload')).toBeInTheDocument()
    expect(row).toHaveAttribute('data-expanded', 'true')
    expect(row.className).toContain('min-h-[24px]')
  })

  it('marks the page’s search in the message, on every line of it', () => {
    render(
      <LogLine
        time={AT}
        level="info"
        message={'loading cart\nthe cart is empty'}
        expanded
        highlight={mark}
        data-testid="row"
      />,
    )
    const message = part(screen.getByTestId('row'), 'message')
    expect(message?.querySelectorAll('mark')).toHaveLength(2)
    expect(message).toHaveTextContent('loading cart the cart is empty')
  })

  it('marks the cursor row the way the grid does', () => {
    render(<LogLine time={AT} level="info" message="a" selected data-testid="row" />)
    expect(screen.getByTestId('row').className).toContain(
      'shadow-[inset_2px_0_0_var(--color-kumo-brand)]',
    )
    expect(screen.getByTestId('row')).toHaveAttribute('data-selected', 'true')
  })

  it('counts the lines after the first', () => {
    expect(extraLines('one')).toBe(0)
    expect(extraLines('one\ntwo\nthree')).toBe(2)
  })
})
