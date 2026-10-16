import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonField, type JsonParse, formatJsonText, parseJsonText } from './json-field'

afterEach(cleanup)

describe('reading JSON text', () => {
  it('gives the value, or what is wrong with the line and column', () => {
    expect(parseJsonText('{"a": [1, 2]}')).toEqual({ ok: true, value: { a: [1, 2] } })
    expect(parseJsonText('  ')).toEqual({ ok: true, value: undefined })
    expect(parseJsonText('{\n  "a": 1\n  "b": 2\n}')).toEqual({
      ok: false,
      message: 'A comma or the closing } goes here.',
      line: 3,
      column: 3,
    })
    expect(parseJsonText('{"a": 1,}')).toMatchObject({
      ok: false,
      message: 'Remove this comma: no key follows it before the }.',
      column: 8,
    })
    expect(parseJsonText('[1,\n]')).toMatchObject({
      message: 'Remove this comma: no value follows it before the ].',
      line: 1,
      column: 3,
    })
    expect(parseJsonText("{'a': 1}")).toMatchObject({
      message: 'A key goes here, in double quotes.',
    })
    expect(parseJsonText('["open')).toMatchObject({
      message: 'This string is not closed.',
      column: 2,
    })
    expect(parseJsonText('[1] x')).toMatchObject({
      message: 'There is more after the end of the JSON.',
    })
    expect(parseJsonText('{"a": tru}')).toMatchObject({ ok: false, column: 7 })
    expect(parseJsonText('"\\q"')).toMatchObject({ message: 'This escape is not one JSON knows.' })
  })

  it('lays JSON out again without changing a single value', () => {
    expect(
      formatJsonText('{"id":12345678901234567890,"n":3.0,"e":[],"o":{},"s":"a, b: {c}"}'),
    ).toBe(
      '{\n  "id": 12345678901234567890,\n  "n": 3.0,\n  "e": [],\n  "o": {},\n  "s": "a, b: {c}"\n}',
    )
    expect(formatJsonText('[1,[2,{"k":"\\"q\\""}]]')).toBe(
      '[\n  1,\n  [\n    2,\n    {\n      "k": "\\"q\\""\n    }\n  ]\n]',
    )
    expect(formatJsonText('{"a":')).toBeUndefined()
    expect(formatJsonText('')).toBeUndefined()
  })
})

function Body({ initial, onParsed }: { initial: string; onParsed: (result: JsonParse) => void }) {
  const [text, setText] = useState(initial)
  return (
    <JsonField value={text} onChange={setText} onParsed={onParsed} ariaLabel="Body" testId="body" />
  )
}

describe('the JSON field', () => {
  it('reports what the text is from the start and says a problem under the editor', async () => {
    const onParsed = vi.fn()
    render(<Body initial='{"a": 1,}' onParsed={onParsed} />)
    expect(onParsed).toHaveBeenCalledWith({
      ok: false,
      message: 'Remove this comma: no key follows it before the }.',
      line: 1,
      column: 8,
    })
    expect(screen.getByTestId('body-error')).toHaveTextContent(
      'Line 1, column 8: Remove this comma: no key follows it before the }.',
    )
    expect(screen.getByTestId('body-format')).toBeDisabled()
  })

  it('formats on request and reports the new text once', async () => {
    const user = userEvent.setup()
    const onParsed = vi.fn()
    render(<Body initial='{"a":[1,2]}' onParsed={onParsed} />)
    expect(onParsed).toHaveBeenCalledTimes(1)
    await user.click(screen.getByTestId('body-format'))
    expect(await screen.findByText(/"a": \[/)).toBeInTheDocument()
    expect(onParsed).toHaveBeenCalledTimes(2)
    expect(onParsed).toHaveBeenLastCalledWith({ ok: true, value: { a: [1, 2] } })
    expect(screen.getByTestId('body-format')).toBeDisabled()
  })
})
