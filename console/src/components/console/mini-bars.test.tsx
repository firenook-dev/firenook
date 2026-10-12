import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MiniBars, maxTotal, stackHeights } from './mini-bars'

afterEach(cleanup)

const LEVELS = [
  { label: 'info', tone: 'neutral' },
  { label: 'warn', tone: 'warning' },
  { label: 'error', tone: 'danger' },
] as const

const bucket = (index: number) => document.querySelector(`[data-index="${index}"]`) as HTMLElement

/** The pixel height of each series in bucket `index`, bottom first. */
function segments(index: number) {
  const column = document.querySelector(`[data-index="${index}"]`)
  return Array.from(column?.children ?? []).map((child) => ({
    series: child.getAttribute('data-series'),
    height: Number.parseFloat((child as HTMLElement).style.height),
  }))
}

describe('mini bars', () => {
  it('stack the series and scale to the largest bucket', () => {
    render(
      <MiniBars
        buckets={[
          [10, 4, 2],
          [5, 0, 0],
          [0, 0, 0],
        ]}
        series={LEVELS}
        height={32}
        label="Log lines per minute"
        testId="bars"
      />,
    )
    expect(screen.getByTestId('bars')).toHaveAttribute('role', 'img')
    expect(screen.getByRole('img', { name: 'Log lines per minute' })).toBeInTheDocument()
    // The largest bucket fills the height; its series stack to exactly that.
    expect(segments(0)).toEqual([
      { series: 'info', height: 20 },
      { series: 'warn', height: 8 },
      { series: 'error', height: 4 },
    ])
    expect(segments(1)).toEqual([{ series: 'info', height: 10 }])
    expect(segments(2)).toEqual([])
  })

  it('keeps a bucket that holds anything at least one pixel tall', () => {
    expect(stackHeights([0, 0, 1], 10_000, 24)).toEqual([0, 0, 1])
    expect(stackHeights([0, 0, 0], 10, 24)).toEqual([0, 0, 0])
    expect(stackHeights([1, 1, 1], 3, 24).reduce((a, b) => a + b, 0)).toBe(24)
    expect(maxTotal([[1, 2], [5, 1], [0]])).toBe(6)
    expect(maxTotal([])).toBe(0)
  })

  it('draws a single series, the sparkline case', () => {
    render(
      <MiniBars
        buckets={[[3], [6], [0], [1]]}
        series={[{ label: 'publishes', tone: 'neutral' }]}
        height={20}
        label="Publishes per second, last minute"
      />,
    )
    expect(segments(1)).toEqual([{ series: 'publishes', height: 20 }])
    expect(segments(0)).toEqual([{ series: 'publishes', height: 10 }])
    expect(segments(3)[0]?.height).toBe(3)
  })

  it('reports a click as one bucket and a drag as the range it crossed', () => {
    const onPick = vi.fn()
    render(
      <MiniBars
        buckets={Array.from({ length: 6 }, (_, index) => [index + 1])}
        series={[{ label: 'lines', tone: 'neutral' }]}
        label="Lines"
        onPick={onPick}
        testId="bars"
      />,
    )
    fireEvent.pointerDown(bucket(2))
    fireEvent.pointerUp(window)
    expect(onPick).toHaveBeenLastCalledWith(2, 2)
    // Dragged right to left: the range comes back low to high, brushed while it is held.
    fireEvent.pointerDown(bucket(4))
    fireEvent.pointerEnter(bucket(3))
    fireEvent.pointerEnter(bucket(1))
    expect(bucket(2)).toHaveAttribute('data-brushed', 'true')
    expect(bucket(5)).not.toHaveAttribute('data-brushed')
    fireEvent.pointerUp(window)
    expect(onPick).toHaveBeenLastCalledWith(1, 4)
    expect(bucket(2)).not.toHaveAttribute('data-brushed')
  })

  it('picks from the keyboard: arrows move, Shift widens, Enter picks', async () => {
    const onPick = vi.fn()
    render(
      <MiniBars
        buckets={Array.from({ length: 5 }, () => [1])}
        series={[{ label: 'lines', tone: 'neutral' }]}
        label="Lines"
        tooltip={(index) => `minute ${index}`}
        onPick={onPick}
        testId="bars"
      />,
    )
    const strip = screen.getByRole('group', { name: 'Lines' })
    strip.focus()
    await userEvent.keyboard('{ArrowRight}')
    await userEvent.keyboard('{Shift>}{ArrowLeft}{ArrowLeft}{/Shift}')
    expect(screen.getByText('minute 2 to minute 4')).toBeInTheDocument()
    await userEvent.keyboard('{Enter}')
    expect(onPick).toHaveBeenLastCalledWith(2, 4)
    await userEvent.keyboard('{Home}{Enter}')
    expect(onPick).toHaveBeenLastCalledWith(0, 0)
  })
})
