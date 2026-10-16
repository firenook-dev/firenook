import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MaskedValue, maskedText } from './masked-value'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('a masked value', () => {
  it('reads as dots and a length', () => {
    expect(maskedText(88)).toBe('•••• (88 characters)')
    expect(maskedText(1)).toBe('•••• (1 character)')
    expect(maskedText(12_000)).toBe('•••• (12,000 characters)')
    expect(maskedText(undefined)).toBe('••••••••')
    render(<MaskedValue value="s3cr3t-hash" label="Show the hash" copyable testId="hash" />)
    expect(screen.getByTestId('hash-masked')).toHaveTextContent('•••• (11 characters)')
    expect(screen.queryByText('s3cr3t-hash')).not.toBeInTheDocument()
  })

  it('shows a value it holds at once, and is copied only then', async () => {
    const user = userEvent.setup()
    render(<MaskedValue value="s3cr3t-hash" label="Show the hash" copyable testId="hash" />)
    expect(screen.queryByTestId('hash-copy')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show the hash' }))
    expect(screen.getByTestId('hash-value')).toHaveTextContent('s3cr3t-hash')
    await user.click(screen.getByTestId('hash-copy'))
    expect(await navigator.clipboard.readText()).toBe('s3cr3t-hash')
    await user.click(screen.getByRole('button', { name: 'Hide the hash' }))
    expect(screen.queryByText('s3cr3t-hash')).not.toBeInTheDocument()
    expect(screen.queryByTestId('hash-copy')).not.toBeInTheDocument()
  })

  it('asks the engine only when pressed: pending, then the value', async () => {
    let answer: ((value: string) => void) | undefined
    const reveal = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          answer = resolve
        }),
    )
    const user = userEvent.setup()
    render(<MaskedValue length={40} reveal={reveal} label="Show the secret" testId="secret" />)
    expect(reveal).not.toHaveBeenCalled()
    expect(screen.getByTestId('secret-masked')).toHaveTextContent('•••• (40 characters)')
    await user.click(screen.getByRole('button', { name: 'Show the secret' }))
    expect(reveal).toHaveBeenCalledOnce()
    expect(screen.getByTestId('secret-masked')).toHaveTextContent('Revealing…')
    await act(async () => answer?.('the-secret'))
    expect(screen.getByTestId('secret-value')).toHaveTextContent('the-secret')
    // Hidden and shown again, it does not ask twice.
    await user.click(screen.getByRole('button', { name: 'Hide the secret' }))
    await user.click(screen.getByRole('button', { name: 'Show the secret' }))
    expect(reveal).toHaveBeenCalledOnce()
    expect(screen.getByTestId('secret-value')).toHaveTextContent('the-secret')
  })

  it('says a failed reveal in place, and tries again', async () => {
    const reveal = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(new Error('The secret manager is not running.'))
      .mockResolvedValueOnce('second-time')
    const user = userEvent.setup()
    render(<MaskedValue reveal={reveal} label="Show the secret" copyable testId="secret" />)
    await user.click(screen.getByRole('button', { name: 'Show the secret' }))
    expect(await screen.findByTestId('secret-error')).toHaveTextContent(
      'The secret manager is not running.',
    )
    expect(screen.queryByTestId('secret-copy')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('secret-reveal'))
    expect(await screen.findByTestId('secret-value')).toHaveTextContent('second-time')
  })

  it('follows its owner when the owner keeps whether it is shown', async () => {
    const onRevealedChange = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <MaskedValue
        value="abc"
        label="Show the value"
        revealed={false}
        onRevealedChange={onRevealedChange}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Show the value' }))
    expect(onRevealedChange).toHaveBeenCalledWith(true)
    expect(screen.queryByText('abc')).not.toBeInTheDocument()
    rerender(
      <MaskedValue
        value="abc"
        label="Show the value"
        revealed
        onRevealedChange={onRevealedChange}
      />,
    )
    expect(screen.getByText('abc')).toBeInTheDocument()
  })
})
