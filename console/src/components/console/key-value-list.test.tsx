import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeyValueList } from './key-value-list'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the key-value list', () => {
  it('lays labels and values in two columns, values in the data face', () => {
    render(
      <KeyValueList
        testId="facts"
        items={[
          { label: 'uid', value: 'u_9f3k2', copy: 'u_9f3k2', testId: 'uid' },
          { label: 'Created', value: '3 d ago', mono: false, hint: '2026-10-09T08:31:02Z' },
        ]}
      />,
    )
    const list = screen.getByTestId('facts')
    expect(list.tagName).toBe('DL')
    expect(screen.getByText('uid').tagName).toBe('DT')
    expect(screen.getByText('u_9f3k2').closest('dd')).toHaveClass('font-mono')
    expect(screen.getByText('3 d ago').closest('dd')).not.toHaveClass('font-mono')
  })

  it('copies a row that offers it, and has no copy for one that does not', async () => {
    const user = userEvent.setup()
    render(
      <KeyValueList
        items={[
          { label: 'uid', value: 'u_9f3k2', copy: 'u_9f3k2', testId: 'uid' },
          { label: 'Providers', value: 'password · google.com', testId: 'providers' },
        ]}
      />,
    )
    await user.click(screen.getByTestId('uid-copy'))
    expect(await navigator.clipboard.readText()).toBe('u_9f3k2')
    expect(screen.queryByTestId('providers-copy')).not.toBeInTheDocument()
  })

  it('masks a row until it is asked for', async () => {
    const user = userEvent.setup()
    render(
      <KeyValueList
        items={[
          { label: 'Password hash', value: 'aGFzaGVkLXBhc3N3b3Jk', masked: true, testId: 'hash' },
        ]}
      />,
    )
    expect(screen.getByTestId('hash')).toHaveTextContent('•••• (20 characters)')
    expect(screen.queryByTestId('hash-copy')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show Password hash' }))
    expect(screen.getByTestId('hash')).toHaveTextContent('aGFzaGVkLXBhc3N3b3Jk')
  })
})
