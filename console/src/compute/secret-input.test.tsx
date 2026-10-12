import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretInput } from './secret-input'

afterEach(cleanup)

function Harness({ initial = '', invalid = false }: { initial?: string; invalid?: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <SecretInput
      value={value}
      onChange={setValue}
      label="API token"
      placeholder="Type the secret"
      invalid={invalid}
      testId="secret"
    />
  )
}

describe('a secret typed into a form', () => {
  it('is masked until the eye shows it, and only a shown value can be copied', () => {
    render(<Harness initial="tok-456" />)
    const input = screen.getByTestId('secret')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAccessibleName('API token')
    expect(screen.queryByTestId('secret-copy')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show the value' }))
    expect(input).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Hide the value' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByTestId('secret-copy')).toHaveAccessibleName('Copy the value')

    fireEvent.click(screen.getByRole('button', { name: 'Hide the value' }))
    expect(input).toHaveAttribute('type', 'password')
    expect(screen.queryByTestId('secret-copy')).toBeNull()
  })

  it('offers no copy for an empty field, shown or not', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Show the value' }))
    expect(screen.queryByTestId('secret-copy')).toBeNull()
    fireEvent.change(screen.getByTestId('secret'), { target: { value: 'm1' } })
    expect(screen.getByTestId('secret')).toHaveValue('m1')
    expect(screen.getByTestId('secret-copy')).toBeInTheDocument()
  })

  it('copies the shown value', async () => {
    const user = userEvent.setup()
    render(<Harness initial="tok-456" />)
    await user.click(screen.getByRole('button', { name: 'Show the value' }))
    await user.click(screen.getByTestId('secret-copy'))
    expect(await navigator.clipboard.readText()).toBe('tok-456')
  })

  it('says a refused value with the danger ring, and never as a browser password', () => {
    render(<Harness initial="x" invalid />)
    const input = screen.getByTestId('secret')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('autocomplete', 'new-password')
    cleanup()
    render(<Harness initial="x" />)
    expect(screen.getByTestId('secret')).not.toHaveAttribute('aria-invalid')
  })
})
