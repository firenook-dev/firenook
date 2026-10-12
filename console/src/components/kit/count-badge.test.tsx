import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CountBadge } from './count-badge'

afterEach(cleanup)

describe('a count badge', () => {
  it('carries its sentence, and draws an attention ring inside the pill', () => {
    render(<CountBadge count={2} tone="attention" label="2 new errors" testId="errors" />)
    const badge = screen.getByRole('img', { name: '2 new errors' })
    expect(badge.textContent).toBe('2')
    // A nav item clips its label row at the pill's height: an outer ring was cut.
    expect(badge.className.split(' ')).toEqual(expect.arrayContaining(['ring', 'ring-inset']))
  })
})
