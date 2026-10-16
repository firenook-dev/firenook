import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DurationText, coldText, durationText } from './duration-text'

afterEach(cleanup)

describe('a duration', () => {
  it("is the console's duration at every boundary", () => {
    expect(durationText(0.4)).toBe('0.4 ms')
    expect(durationText(2.6)).toBe('2.6 ms')
    expect(durationText(10)).toBe('10 ms')
    expect(durationText(840)).toBe('840 ms')
    expect(durationText(999.6)).toBe('1.0 s')
    expect(durationText(1_240)).toBe('1.2 s')
    expect(durationText(12_400)).toBe('12 s')
    expect(durationText(62_000)).toBe('1 min 2 s')
    expect(durationText(null)).toBeUndefined()
    expect(durationText(undefined)).toBeUndefined()
    expect(durationText(Number.NaN)).toBeUndefined()
  })

  it('says a cold start, with the worker start time when it is known', () => {
    expect(coldText(812)).toBe('This call started the worker (812 ms).')
    expect(coldText(null)).toBe('This call started the worker.')
  })

  it('draws the figure in the data face, a placeholder while running, and the cold word', () => {
    render(
      <>
        <DurationText ms={8.1} testId="warm" />
        <DurationText ms={null} testId="running" />
        <DurationText ms={820} cold workerStartMs={812} testId="cold" />
      </>,
    )
    const warm = screen.getByTestId('warm')
    expect(warm).toHaveTextContent('8.1 ms')
    expect(warm.querySelector('.font-mono')).toHaveClass('text-[11px]', 'tabular-nums')
    expect(screen.getByTestId('running')).toHaveTextContent('–')
    expect(screen.getByLabelText('No duration yet')).toBeInTheDocument()
    const cold = screen.getByTestId('cold')
    expect(cold).toHaveTextContent('820 mscold')
    expect(cold.querySelector('[data-part="cold"]')).toHaveClass('text-kumo-subtle')
    expect(warm.querySelector('[data-part="cold"]')).toBeNull()
  })
})
