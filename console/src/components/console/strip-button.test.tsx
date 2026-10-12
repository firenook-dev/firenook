import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CopyStripButton, StripButton } from './strip-button'

afterEach(cleanup)

describe('a strip button', () => {
  it('reports a state only where it has one', () => {
    render(
      <>
        <StripButton label="JSON" on />
        <StripButton label="Off" on={false} />
        <StripButton label="Remove" />
      </>,
    )
    expect(screen.getByRole('button', { name: 'JSON' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Remove' })).not.toHaveAttribute('aria-pressed')
  })

  it('acts when pressed and not when disabled', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <>
        <StripButton label="Move up" onClick={onClick} title="Move up" />
        <StripButton label="Move down" onClick={onClick} disabled title="Already last" />
      </>,
    )
    await user.click(screen.getByRole('button', { name: 'Move up' }))
    await user.click(screen.getByRole('button', { name: 'Move down' }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('copies, and says so', async () => {
    const user = userEvent.setup()
    render(
      <CopyStripButton value={() => 'data.items[0]'} label="Copy the path">
        path
      </CopyStripButton>,
    )
    await user.click(screen.getByRole('button', { name: 'Copy the path' }))
    expect(await navigator.clipboard.readText()).toBe('data.items[0]')
    expect(screen.getByRole('button', { name: 'Copied' })).toHaveTextContent('path')
  })
})
