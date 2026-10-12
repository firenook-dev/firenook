import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StatusDot, type StatusTone } from './status-dot'

afterEach(cleanup)

describe('a status dot', () => {
  it('fills every tone with a colour that exists as a fill', () => {
    const fills: Record<StatusTone, string> = {
      success: 'bg-kumo-success',
      warning: 'bg-kumo-warning',
      danger: 'bg-kumo-danger',
      neutral: 'bg-kumo-interact',
      brand: 'bg-kumo-brand',
    }
    for (const [tone, fill] of Object.entries(fills) as [StatusTone, string][]) {
      render(<StatusDot tone={tone} label={tone} testId={tone} />)
      const dot = screen.getByTestId(tone).querySelector('[aria-hidden] > span')
      expect(dot?.className).toContain(fill)
    }
  })

  it('pulses only when asked, and never under reduced motion', () => {
    render(<StatusDot tone="neutral" label="Running" pulse testId="running" />)
    const pulse = screen.getByTestId('running').querySelector('[data-part="pulse"]')
    expect(pulse?.className).toContain('animate-ping')
    expect(pulse?.className).toContain('motion-reduce:hidden')
    render(<StatusDot tone="success" label="Done" testId="done" />)
    expect(screen.getByTestId('done').querySelector('[data-part="pulse"]')).toBeNull()
  })
})
