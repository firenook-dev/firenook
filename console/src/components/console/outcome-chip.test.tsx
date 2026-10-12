import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type InvocationOutcome,
  type OutcomeClass,
  OutcomeChip,
  elapsedText,
  invocationChip,
} from './outcome-chip'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** The chip as drawn: its word, tone, face and the class it was given. */
function drawn(testId: string) {
  const chip = screen.getByTestId(testId)
  return {
    word: chip.textContent,
    tone: chip.getAttribute('data-tone'),
    mono: chip.className.includes('font-mono'),
    outcome: chip.closest('[data-outcome]')?.getAttribute('data-outcome'),
  }
}

describe('an invocation outcome', () => {
  // Compute spec §5.0: word, tone and class per outcome.
  const table: Array<[InvocationOutcome, OutcomeClass, string, string]> = [
    ['succeeded', 'succeeded', 'Succeeded', 'success'],
    ['allowed', 'succeeded', 'Allowed', 'success'],
    ['blocked', 'succeeded', 'Blocked', 'warning'],
    ['clientError', 'failed', 'Client error', 'warning'],
    ['failed', 'failed', 'Failed', 'danger'],
    ['timedOut', 'failed', 'Timed out', 'danger'],
    ['crashed', 'failed', 'Crashed', 'danger'],
    ['notStarted', 'failed', 'Not started', 'danger'],
    ['paused', 'skipped', 'Paused', 'neutral'],
    ['removed', 'skipped', 'Removed', 'neutral'],
  ]

  it.each(table)('%s reads "%s"', (outcome, outcomeClass, word, tone) => {
    render(<OutcomeChip outcome={outcome} outcomeClass={outcomeClass} testId="chip" />)
    expect(drawn('chip')).toEqual({ word, tone, mono: false, outcome: outcomeClass })
  })

  it('shows the HTTP status of a URL invocation as a figure in the data face', () => {
    expect(invocationChip({ outcome: 'succeeded', status: 200 })).toEqual({
      word: '200',
      tone: 'success',
      mono: true,
    })
    expect(invocationChip({ outcome: 'clientError', status: 404 })).toEqual({
      word: '404',
      tone: 'warning',
      mono: true,
    })
    render(<OutcomeChip outcome="failed" outcomeClass="failed" status={500} testId="chip" />)
    expect(drawn('chip')).toEqual({ word: '500', tone: 'danger', mono: true, outcome: 'failed' })
  })

  it("writes a callable's status code as data, amber for a client's mistake and red for the server's", () => {
    expect(
      invocationChip({ outcome: 'callableError', callableStatus: 'INVALID_ARGUMENT' }),
    ).toEqual({
      word: 'INVALID_ARGUMENT',
      tone: 'warning',
      mono: true,
    })
    expect(
      invocationChip({ outcome: 'callableError', callableStatus: 'PERMISSION_DENIED' }).tone,
    ).toBe('warning')
    expect(invocationChip({ outcome: 'callableError', callableStatus: 'INTERNAL' }).tone).toBe(
      'danger',
    )
    expect(invocationChip({ outcome: 'callableError', callableStatus: 'UNKNOWN' }).tone).toBe(
      'danger',
    )
    expect(invocationChip({ outcome: 'callableError' })).toEqual({
      word: 'UNKNOWN',
      tone: 'danger',
      mono: true,
    })
  })

  it('counts up while it runs, beside a breathing neutral dot', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-10-12T06:00:01.200Z'))
    render(
      <OutcomeChip
        outcome={null}
        outcomeClass="running"
        startedAt="2026-10-12T06:00:00Z"
        testId="chip"
      />,
    )
    const chip = screen.getByTestId('chip')
    expect(chip).toHaveTextContent('Running')
    expect(chip).toHaveAttribute('data-tone', 'neutral')
    expect(chip.querySelector('[data-part="pulse"]')).not.toBeNull()
    expect(chip.closest('[data-outcome]')).toHaveAttribute('data-outcome', 'running')
    expect(chip.parentElement).toHaveTextContent(/^Running1 s$/)
    expect(elapsedText(59_900)).toBe('59 s')
    expect(elapsedText(62_000)).toBe('1 min 2 s')
    expect(elapsedText(-5)).toBe('0 s')
  })
})

describe("another section's outcome", () => {
  it('takes its own word and tone: a delivery, an attempt, an Auth call', () => {
    render(
      <>
        <OutcomeChip word="delivered" tone="success" testId="delivered" />
        <OutcomeChip word="running" tone="brand" pulse testId="running" />
        <OutcomeChip word="503" tone="danger" mono testId="attempt" />
        <OutcomeChip word="auth/user-not-found" tone="danger" mono testId="auth" />
        <OutcomeChip
          word="skipped"
          tone="neutral"
          detail="Background triggers were paused, so the event was dropped, not queued."
          testId="skipped"
        />
      </>,
    )
    expect(drawn('delivered')).toMatchObject({ word: 'delivered', tone: 'success', mono: false })
    expect(drawn('running').tone).toBe('brand')
    expect(screen.getByTestId('running').querySelector('[data-part="pulse"]')).not.toBeNull()
    expect(drawn('attempt')).toMatchObject({ word: '503', tone: 'danger', mono: true })
    expect(drawn('auth')).toMatchObject({ word: 'auth/user-not-found', mono: true })
    expect(drawn('skipped')).toMatchObject({ word: 'skipped', tone: 'neutral' })
  })
})
