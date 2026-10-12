import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionParam } from '@/api/generated/compute/ExtensionParam'
import { ParamRow } from './param-row'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const GREETING: ExtensionParam = {
  param: 'GREETING_TEMPLATE',
  label: 'Greeting template',
  description: null,
  type: 'string',
  required: true,
  immutable: false,
  default: null,
  example: null,
  options: [],
  validationRegex: '^.*\\{name\\}.*$',
  validationErrorMessage: 'Include {name}.',
  value: 'Hello {name}',
  provided: true,
  source: 'file',
  file: 'extensions/greeter.env',
  problem: null,
  unchecked: null,
}

function edit(value: string, problem: string | undefined) {
  return render(
    <ParamRow
      param={GREETING}
      editing
      value={value}
      problem={problem}
      onChange={() => undefined}
      reveal={() => Promise.resolve('')}
    />,
  )
}

describe('a parameter being edited', () => {
  it('marks a value that fails its check as invalid, without a deprecated Kumo variant', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    edit('Hello', 'Include {name}.')
    const input = screen.getByTestId('param-input')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input.className).toContain('ring-kumo-danger')
    expect(screen.getByRole('alert')).toHaveTextContent('Include {name}.')
    expect(warn.mock.calls.flat().join(' ')).not.toContain('deprecated')
  })

  it('leaves a value that passes unmarked', () => {
    edit('Hi {name}', undefined)
    const input = screen.getByTestId('param-input')
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(input.className).not.toContain('ring-kumo-danger')
  })
})
