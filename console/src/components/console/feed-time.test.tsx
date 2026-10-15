import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeedTime, otherForms } from './feed-time'

const CLOCK_KEY = 'firenook.console.clock-format'

/** Another tab choosing a clock format, which every tab follows. */
function chooseClock(format: string | null) {
  if (format === null) localStorage.removeItem(CLOCK_KEY)
  else localStorage.setItem(CLOCK_KEY, format)
  window.dispatchEvent(new StorageEvent('storage', { key: CLOCK_KEY }))
}

afterEach(() => {
  cleanup()
  act(() => chooseClock(null))
  vi.useRealTimers()
})

describe('a feed row’s time', () => {
  const at = new Date(2026, 9, 12, 14, 2, 11, 348)
  const iso = at.toISOString()

  it('follows the console-wide clock format', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // On a whole second, as the shared clock reads it.
    vi.setSystemTime(at.getTime() + 3_652)
    render(<FeedTime iso={iso} testId="when" />)
    const time = screen.getByTestId('when')
    expect(time).toHaveTextContent('14:02:11.348')
    expect(time).toHaveAttribute('datetime', iso)
    act(() => chooseClock('relative'))
    expect(time).toHaveTextContent('3 s ago')
    act(() => chooseClock('utc'))
    expect(time).toHaveTextContent(iso)
  })

  it('shows the other forms on hover, and a dash for a time it does not have', () => {
    expect(otherForms(iso, at.getTime() + 300_000)).toBe(
      `14:02:11.348 local · ${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC · 5 min ago`,
    )
    render(<FeedTime iso={null} testId="none" />)
    expect(screen.getByTestId('none')).toHaveAccessibleName('No time')
  })
})
