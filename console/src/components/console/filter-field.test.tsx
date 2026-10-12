import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { contextAt } from '@/lib/filter'
import { dispatchShortcut } from '@/lib/shortcuts'
import {
  FilterField,
  type FilterFieldSpec,
  applyCompletion,
  staticCompletions,
} from './filter-field'

afterEach(cleanup)

const FIELDS: FilterFieldSpec[] = [
  {
    key: 'provider',
    aliases: ['p'],
    kind: 'enum',
    help: 'Sign-in provider',
    values: ['password', 'google.com', 'phone'],
    valueAliases: { google: 'google.com' },
  },
  { key: 'is', kind: 'enum', help: 'Account state', values: ['disabled', 'anonymous'] },
  { key: 'created', kind: 'time', help: 'When it was created' },
  { key: 'email', kind: 'text', help: 'Email address' },
  { key: 'data', kind: 'path', help: 'A field of the payload', prefixes: ['data.'] },
]

describe('what completes where', () => {
  it('offers keys with their help at a key, path prefixes among them', () => {
    const items = staticCompletions(contextAt('', 0), FIELDS)
    expect(items.map((item) => item.label)).toEqual([
      'provider:',
      'is:',
      'created:',
      'email:',
      'data.',
    ])
    expect(items[0]?.detail).toBe('Sign-in provider')
    const alias = staticCompletions(contextAt('p', 1), FIELDS)
    expect(alias.map((item) => item.label)).toEqual(['provider:'])
  })

  it('offers an enum’s values, matched by value or alias, and starting times for a time', () => {
    const values = staticCompletions(contextAt('provider:goo', 12), FIELDS)
    expect(values).toEqual([
      { label: 'google.com', insert: 'google.com', detail: 'also google', role: 'value' },
    ])
    expect(staticCompletions(contextAt('created:-', 9), FIELDS).map((item) => item.label)).toEqual([
      '-15m',
      '-1h',
      '-24h',
      '-7d',
    ])
    expect(staticCompletions(contextAt('email:a', 7), FIELDS)).toEqual([])
  })

  it('puts a key in with its separator and a value in with a space after it', () => {
    const key = contextAt('ada pro', 7)
    expect(
      applyCompletion('ada pro', key, { label: 'provider:', insert: 'provider', role: 'key' }),
    ).toEqual({ text: 'ada provider:', caret: 13 })
    const value = contextAt('provider:go', 11)
    expect(
      applyCompletion('provider:go', value, { label: 'x', insert: 'google.com', role: 'value' }),
    ).toEqual({ text: 'provider:google.com ', caret: 20 })
    // A value that needs quotes gets them.
    const spaced = contextAt('email:', 6)
    expect(applyCompletion('email:', spaced, { label: 'x', insert: 'a b', role: 'value' })).toEqual(
      {
        text: 'email:"a b" ',
        caret: 12,
      },
    )
    // An existing separator is kept, not doubled.
    const existing = contextAt('prov:x', 2)
    expect(
      applyCompletion('prov:x', existing, { label: 'provider:', insert: 'provider', role: 'key' }),
    ).toEqual({ text: 'provider:x', caret: 9 })
  })
})

function Users({
  initial = '',
  fields = FIELDS,
}: {
  initial?: string
  fields?: FilterFieldSpec[]
}) {
  const [q, setQ] = useState(initial)
  return (
    <>
      <FilterField
        value={q}
        onChange={setQ}
        fields={fields}
        placeholder="Filter users"
        ariaLabel="Filter users"
        testId="users-filter"
      />
      <output data-testid="q">{q}</output>
      <button type="button" onClick={() => setQ('is:disabled')}>
        Only disabled
      </button>
    </>
  )
}

const input = () => screen.getByTestId('users-filter-input') as HTMLInputElement
const completions = () =>
  screen.queryAllByTestId('users-filter-completion').map((row) => row.textContent)

describe('the filter field', () => {
  it('completes a key, then its value, from the keyboard', async () => {
    const user = userEvent.setup()
    render(<Users />)
    await user.click(input())
    expect(completions()).toHaveLength(5)
    await user.keyboard('pro')
    expect(completions()).toEqual(['provider:Sign-in provider'])
    await user.keyboard('{Enter}')
    expect(input()).toHaveValue('provider:')
    expect(completions()).toEqual(['password', 'google.comalso google', 'phone'])
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(input()).toHaveValue('provider:google.com ')
    expect(screen.getByTestId('q')).toHaveTextContent('provider:google.com')
    expect(completions()).toEqual([])
  })

  it('draws each term on a tinted ground under its text', async () => {
    render(<Users initial="provider:google -is:disabled ada" />)
    const grounds = screen.getByTestId('users-filter').querySelectorAll('.bg-kumo-fill')
    expect(Array.from(grounds, (ground) => ground.textContent)).toEqual([
      'provider:google',
      '-is:disabled',
    ])
  })

  it('says what is wrong under the field once the caret leaves it, the span underlined', async () => {
    const user = userEvent.setup()
    render(<Users />)
    await user.click(input())
    await user.keyboard('foo:bar')
    // Still typing that item: nothing said yet.
    expect(screen.queryByTestId('users-filter-error')).not.toBeInTheDocument()
    await user.keyboard(' ')
    expect(screen.getByTestId('users-filter-error')).toHaveTextContent(
      'Unknown filter "foo:". Use provider, is, created, email or data.…; quote it to search for the text.',
    )
    expect(screen.getByTestId('users-filter-box')).toHaveAttribute('data-invalid', 'true')
    expect(input()).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByTestId('users-filter').querySelector('.decoration-wavy')?.textContent).toBe(
      'foo:bar',
    )
  })

  it('says what the engine refused of a text the same way, while the field holds it', async () => {
    const user = userEvent.setup()
    const refusal = {
      text: 'ada /(?=x)/',
      message: 'This regular expression uses look-around `(?=`.',
      from: 4,
      to: 11,
    }
    render(
      <FilterField
        value="ada /(?=x)/"
        onChange={() => undefined}
        fields={FIELDS}
        regex
        refusal={refusal}
        placeholder="Filter lines"
        ariaLabel="Filter lines"
        testId="lines"
      />,
    )
    expect(screen.getByTestId('lines-error')).toHaveTextContent(refusal.message)
    expect(screen.getByTestId('lines-box')).toHaveAttribute('data-invalid', 'true')
    expect(screen.getByTestId('lines').querySelector('.decoration-wavy')?.textContent).toBe(
      '/(?=x)/',
    )
    await user.click(screen.getByTestId('lines-input'))
    await user.keyboard('{End} ')
    await user.click(document.body)
    expect(screen.queryByTestId('lines-error')).not.toBeInTheDocument()
  })

  it('takes a value from elsewhere, and ignores its own echo', async () => {
    const user = userEvent.setup()
    render(<Users />)
    await user.click(input())
    await user.keyboard('ada')
    expect(input()).toHaveValue('ada')
    await user.click(screen.getByRole('button', { name: 'Only disabled' }))
    expect(input()).toHaveValue('is:disabled')
  })

  it('adds what `suggest` knows, when it answers', async () => {
    const user = userEvent.setup()
    const suggest = vi.fn((prefix: string) =>
      Promise.resolve(
        ['ada@example.test', 'grace@example.test'].filter((email) => email.startsWith(prefix)),
      ),
    )
    const fields: FilterFieldSpec[] = [
      ...FIELDS.filter((field) => field.key !== 'email'),
      { key: 'email', kind: 'text', help: 'Email address', suggest },
    ]
    render(<Users fields={fields} />)
    await user.click(input())
    await user.keyboard('email:gr')
    expect(await screen.findByText('grace@example.test')).toBeInTheDocument()
    expect(suggest).toHaveBeenLastCalledWith('gr')
    await user.keyboard('{ArrowDown}{Enter}')
    expect(input()).toHaveValue('email:grace@example.test ')
  })

  it('clears with its ×, and `/` focuses it', async () => {
    const user = userEvent.setup()
    render(<Users initial="ada" />)
    await user.click(screen.getByRole('button', { name: 'Clear the filter' }))
    expect(screen.getByTestId('q')).toBeEmptyDOMElement()
    input().blur()
    act(() => {
      dispatchShortcut(new KeyboardEvent('keydown', { key: '/' }))
    })
    expect(input()).toHaveFocus()
  })
})
