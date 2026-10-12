import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LEVEL_FLOOR, LevelStrip } from './level-strip'

afterEach(cleanup)

/** The pixel height of each series drawn in bucket `index`, bottom first. */
function segments(index: number) {
  const column = document.querySelector(`[data-index="${index}"]`)
  return Array.from(column?.children ?? []).map((child) => ({
    series: child.getAttribute('data-series'),
    height: Number.parseFloat((child as HTMLElement).style.height),
  }))
}

describe('level strip', () => {
  it('lays a tick per bucket under the bars, so quiet minutes still read as time', () => {
    render(
      <LevelStrip
        buckets={[
          [0, 0, 0],
          [0, 0, 0],
          [0, 2, 0],
        ]}
        height={20}
        label="Warnings and errors per minute, last hour"
        testId="strip"
      />,
    )
    expect(screen.getByTestId('level-strip-ground').children).toHaveLength(3)
    expect(screen.getByRole('img', { name: 'Warnings and errors per minute, last hour' })).toBe(
      screen.getByTestId('strip'),
    )
    expect(segments(0)).toEqual([])
    expect(segments(2)).toEqual([{ series: 'Warnings', height: 20 }])
  })

  it('draws a lone error beside a busy bucket as a bar, not a hairline', () => {
    render(
      <LevelStrip
        buckets={[
          [400, 0, 0],
          [0, 0, 1],
          [398, 1, 1],
        ]}
        height={24}
        label="Lines over the window, by level"
      />,
    )
    expect(segments(1)).toEqual([{ series: 'Errors', height: LEVEL_FLOOR }])
    // In a full bucket the floor comes off the rest: it keeps the strip's height.
    expect(segments(2)).toEqual([
      { series: 'Info and debug', height: 24 - 2 * LEVEL_FLOOR },
      { series: 'Warnings', height: LEVEL_FLOOR },
      { series: 'Errors', height: LEVEL_FLOOR },
    ])
  })
})
