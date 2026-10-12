import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CopyButton, CopyField } from './copy-button'
import { RelativeTime, exactTime } from './relative-time'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('a relative time', () => {
  it('reads as words with the instant behind it', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-10-12T06:03:00Z'))
    render(<RelativeTime iso="2026-10-12T06:00:00Z" prefix="Created" testId="when" />)
    const time = screen.getByTestId('when')
    expect(time).toHaveTextContent('Created 3 min ago')
    expect(time).toHaveAttribute('datetime', '2026-10-12T06:00:00Z')
    expect(exactTime('2026-10-12T06:00:00.250Z')).toMatch(/ local · 2026-10-12 06:00:00 UTC$/)
    expect(exactTime('not a time')).toBe('not a time')
  })
})

describe('copying', () => {
  it('writes the value and answers with the tick', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const onRow = vi.fn()
    render(
      // A copy inside a clickable row copies without opening it.
      <div onClick={onRow}>
        <CopyButton value="u_9f3k2" label="Copy the uid" testId="copy" />
      </div>,
    )
    const button = screen.getByTestId('copy')
    expect(button).toHaveAccessibleName('Copy the uid')
    await userEvent.click(button)
    expect(writeText).toHaveBeenCalledWith('u_9f3k2')
    expect(onRow).not.toHaveBeenCalled()
    expect(button).toHaveAttribute('data-copied', 'true')
    expect(button).toHaveAccessibleName('Copied')
  })

  it('sets a value in the data face unless told it is English', () => {
    render(
      <>
        <CopyField value="gs://demo.appspot.com/a.png" testId="field" />
        <CopyField value="Ada Lovelace" mono={false} testId="name" />
      </>,
    )
    expect(screen.getByTestId('field').className).toContain('font-mono')
    expect(screen.getByTestId('name').className).not.toContain('font-mono')
  })
})
