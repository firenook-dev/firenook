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

  it('keeps its width, and ends its word in an ellipsis only when let shrink', () => {
    render(<StatusDot tone="danger" label="INVALID_LOGIN_CREDENTIALS" testId="fixed" />)
    const fixed = screen.getByTestId('fixed')
    expect(fixed.className).toContain('shrink-0')
    expect(screen.getByText('INVALID_LOGIN_CREDENTIALS').className).toContain('truncate')
    render(
      <StatusDot
        tone="danger"
        label="BLOCKING_FUNCTION_ERROR_RESPONSE"
        className="min-w-0 shrink"
        testId="shrinks"
      />,
    )
    const shrinks = screen.getByTestId('shrinks')
    expect(shrinks.className).toContain('min-w-0')
    expect(shrinks.className.split(' ')).not.toContain('shrink-0')
  })
})
