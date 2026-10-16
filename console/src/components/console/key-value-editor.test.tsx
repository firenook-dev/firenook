import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  KeyValueEditor,
  type KeyValueRow,
  rowProblems,
  rowsToText,
  textToRows,
} from './key-value-editor'

afterEach(cleanup)

const row = (key: string, value: string, enabled = true): KeyValueRow => ({
  id: `${key}=${value}`,
  key,
  value,
  enabled,
})
const strip = (rows: readonly KeyValueRow[]) => rows.map(({ id: _id, ...rest }) => rest)

describe('rows and text', () => {
  it('write a row per line, and `// ` keeps a row without sending it', () => {
    const rows = [
      row('content-type', 'application/json'),
      row('x-trace', 'abc123'),
      row('x-debug', '1', false),
    ]
    const text = rowsToText(rows)
    expect(text).toBe('content-type: application/json\nx-trace: abc123\n// x-debug: 1')
    const back = textToRows(text)
    expect(back.problems).toEqual([])
    expect(strip(back.rows)).toEqual(strip(rows))
  })

  it('split at the first colon, so a value may hold more', () => {
    expect(strip(textToRows('location: https://example.test:8080/a').rows)).toEqual([
      { key: 'location', value: 'https://example.test:8080/a', enabled: true },
    ])
  })

  it('say which lines they cannot read, by number, and keep the rest', () => {
    const read = textToRows('a: 1\n\nnot a pair\n: no key\n//   \nb: 2')
    expect(strip(read.rows)).toEqual([
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: '2', enabled: true },
    ])
    expect(read.problems).toEqual([
      { line: 3, message: 'Line 3 has no colon; write it as key: value.' },
      { line: 4, message: 'Line 4 has no key before its colon.' },
    ])
  })
})

describe('what is wrong with a row', () => {
  it('says a key twice, a value with no key, and a refused key, on the row', () => {
    const rows = [
      row('x-trace', 'a'),
      row('x-trace', 'b'),
      row('x-trace', 'c', false),
      row('', 'orphan'),
      row('bad key', 'x'),
    ]
    const problems = rowProblems(rows, (key) =>
      /\s/.test(key) ? 'A header name has no spaces.' : undefined,
    )
    expect(problems.get('x-trace=a')).toBeUndefined()
    expect(problems.get('x-trace=b')).toBe('x-trace appears twice; both are sent.')
    // A switched-off row is not sent, so it is not a duplicate.
    expect(problems.get('x-trace=c')).toBeUndefined()
    expect(problems.get('=orphan')).toBe('This row needs a key.')
    expect(problems.get('bad key=x')).toBe('A header name has no spaces.')
  })
})

const NONE: KeyValueRow[] = []

function Headers({ initial = NONE }: { initial?: KeyValueRow[] }) {
  const [rows, setRows] = useState<KeyValueRow[]>(initial)
  return (
    <>
      <KeyValueEditor
        label="Headers"
        rows={rows}
        onChange={setRows}
        allowDisable
        testId="headers"
      />
      <output data-testid="rows">{JSON.stringify(strip(rows))}</output>
    </>
  )
}

describe('the key-value editor', () => {
  it('adds a row from the add line and keeps typing in it; Tab goes on to its value', async () => {
    const user = userEvent.setup()
    render(<Headers />)
    await user.click(screen.getByTestId('headers-add-key'))
    await user.keyboard('x-a')
    const key = screen.getByTestId('headers-key')
    expect(key).toHaveFocus()
    expect(key).toHaveValue('x-a')
    await user.tab()
    expect(screen.getByTestId('headers-value')).toHaveFocus()
    await user.keyboard('1')
    expect(screen.getByTestId('rows')).toHaveTextContent(
      '[{"key":"x-a","value":"1","enabled":true}]',
    )
    expect(screen.getByRole('heading', { name: 'Headers · 1' })).toBeInTheDocument()
  })

  it('says a duplicate on its row, and switches a row off without removing it', async () => {
    const user = userEvent.setup()
    render(<Headers initial={[row('x-trace', 'a'), row('x-trace', 'b')]} />)
    expect(screen.getByTestId('headers-problem')).toHaveTextContent('x-trace appears twice')
    await user.click(screen.getAllByRole('checkbox')[1] as HTMLElement)
    expect(screen.queryByTestId('headers-problem')).not.toBeInTheDocument()
    expect(screen.getByTestId('rows')).toHaveTextContent('"enabled":false')
  })

  it('edits as text, keeps the text open while a line does not read, and goes back to rows', async () => {
    const user = userEvent.setup()
    render(<Headers initial={[row('a', '1')]} />)
    await user.click(screen.getByTestId('headers-bulk'))
    const text = screen.getByTestId('headers-text')
    expect(text).toHaveValue('a: 1')
    await user.clear(text)
    await user.type(text, 'a: 1{Enter}oops{Enter}// b: 2')
    expect(screen.getByTestId('headers-text-problem')).toHaveTextContent('Line 2 has no colon')
    expect(screen.getByTestId('headers-rows')).toBeDisabled()
    expect(screen.getByTestId('rows')).toHaveTextContent(
      '[{"key":"a","value":"1","enabled":true},{"key":"b","value":"2","enabled":false}]',
    )
    await user.clear(text)
    await user.type(text, 'a: 1{Enter}// b: 2')
    await user.click(screen.getByTestId('headers-rows'))
    expect(screen.getAllByTestId('headers-row')).toHaveLength(2)
  })
})
