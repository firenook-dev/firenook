import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TimingBar, timingSegments, timingSentence } from './timing-bar'

afterEach(cleanup)

const of = (worker: number | null, firstByte: number | null, total: number | null) => ({
  workerStartMs: worker,
  firstByteMs: firstByte,
  totalMs: total,
})

const parts = (
  worker: number | null,
  firstByte: number | null,
  total: number | null,
  running = false,
) =>
  timingSegments(of(worker, firstByte, total), running).segments.map((segment) => [
    segment.id,
    Math.round(segment.ms * 10) / 10,
  ])

describe('where the time went', () => {
  it('splits a call at the worker start and the first byte, each measured from the start', () => {
    expect(parts(null, 7.9, 8.1)).toEqual([
      ['wait', 7.9],
      ['body', 0.2],
    ])
    expect(parts(812, 819.9, 820.1)).toEqual([
      ['worker', 812],
      ['wait', 7.9],
      ['body', 0.2],
    ])
  })

  it('has no body for a background call, which ends at its answer', () => {
    expect(parts(null, 6, 6)).toEqual([['wait', 6]])
  })

  it('says a call never answered (a timeout, a crash), and one still running', () => {
    expect(parts(500, null, 60_500)).toEqual([
      ['worker', 500],
      ['unanswered', 60_000],
    ])
    expect(parts(null, 12, null, true)).toEqual([['wait', 12]])
    expect(timingSegments(of(null, 12, null), true).totalMs).toBeNull()
  })

  it('reads the bar aloud segment by segment, then the whole', () => {
    const { segments, totalMs } = timingSegments(of(812, 819.9, 820.1))
    expect(timingSentence(segments, totalMs)).toBe(
      'Worker start 812 ms, to first byte 7.9 ms, body 0.2 ms; 820 ms in all',
    )
    expect(timingSentence([], null)).toBe('Timing: still running')
  })
})

describe('the bar', () => {
  it('draws a box per segment, its label and figure under it, and the whole at the end', () => {
    render(<TimingBar timings={of(812, 819.9, 1_520)} />)
    const bar = screen.getByRole('img')
    expect([...bar.children].map((segment) => segment.getAttribute('data-segment'))).toEqual([
      'worker',
      'wait',
      'body',
    ])
    expect(bar).toHaveClass('bg-kumo-tint')
    const labels = screen.getByTestId('timing-bar')
    expect(labels).toHaveTextContent('Worker start812 ms')
    expect(labels).toHaveTextContent('To first byte7.9 ms')
    expect(labels).toHaveTextContent('Body700 ms')
    expect(labels.querySelector('[data-part="total"]')).toHaveTextContent('1.5 s')
  })

  it('says it is still running instead of a whole', () => {
    render(<TimingBar timings={of(null, 40, null)} running />)
    expect(screen.getByTestId('timing-bar').querySelector('[data-part="total"]')).toHaveTextContent(
      'Running',
    )
  })
})
