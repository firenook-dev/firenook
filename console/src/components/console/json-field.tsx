// Every editor in the console that takes JSON — a request body, a message's
// data, a custom identity's claims, a task's payload — is this: the code
// editor (its own lazy chunk), Format, and what is wrong with the text said
// in words under it, with the line and column, on every keystroke.
//
// Format lays the text out again without reading it into JavaScript and
// back: `JSON.parse` would turn `12345678901234567890` into
// `12345678901234567000` and `3.0` into `3`, and a Format button that
// changes a value is worse than none. It re-indents the tokens as they
// were typed.

import { Button, Tooltip } from '@cloudflare/kumo'
import { useEffect, useRef } from 'react'
import { CodeEditor } from '@/components/code-editor'

export type JsonParse =
  | { ok: true; value: unknown }
  | { ok: false; message: string; line: number; column: number }

/** Thrown inside the scanner: what was expected, and the offset it was not found at. */
class Problem {
  readonly message: string
  readonly at: number
  constructor(message: string, at: number) {
    this.message = message
    this.at = at
  }
}

/** Line and column (both from 1) of a UTF-16 offset. */
function position(text: string, at: number): { line: number; column: number } {
  let line = 1
  let start = 0
  for (let index = 0; index < at && index < text.length; index += 1)
    if (text[index] === '\n') {
      line += 1
      start = index + 1
    }
  return { line, column: at - start + 1 }
}

const SPACE = new Set([' ', '\t', '\n', '\r'])

/**
 * Checks `text` is JSON and says where it is not, in words a person can act
 * on. The browser's own messages differ by engine and some carry no
 * position at all, so the grammar is walked here; JSON.parse then reads the
 * value.
 */
function scan(text: string): void {
  let at = 0
  const skip = () => {
    while (SPACE.has(text[at] ?? '')) at += 1
  }
  const string = () => {
    const open = at
    at += 1
    for (;;) {
      const character = text[at]
      if (character === undefined) throw new Problem('This string is not closed.', open)
      if (character === '"') {
        at += 1
        return
      }
      if (character === '\\') {
        const escape = text[at + 1]
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at + 2, at + 6)))
            throw new Problem('A \\u escape takes four hex digits.', at)
          at += 6
        } else if (escape !== undefined && '"\\/bfnrt'.includes(escape)) at += 2
        else throw new Problem('This escape is not one JSON knows.', at)
        continue
      }
      if (character.charCodeAt(0) < 0x20)
        throw new Problem('A line break or tab inside a string has to be written \\n or \\t.', at)
      at += 1
    }
  }
  const number = () => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at))
    if (!match || match[0] === '-' || match[0] === '')
      throw new Problem('This is not a number JSON can write.', at)
    at += match[0].length
  }
  const value = (): void => {
    skip()
    const character = text[at]
    if (character === undefined) throw new Problem('A value is missing here.', at)
    if (character === '{') {
      at += 1
      skip()
      if (text[at] === '}') {
        at += 1
        return
      }
      let comma = -1
      for (;;) {
        skip()
        if (text[at] !== '"')
          throw text[at] === '}' && comma !== -1
            ? new Problem('Remove this comma: no key follows it before the }.', comma)
            : new Problem('A key goes here, in double quotes.', at)
        string()
        skip()
        if (text[at] !== ':') throw new Problem('A colon goes after the key.', at)
        at += 1
        value()
        skip()
        if (text[at] === ',') {
          comma = at
          at += 1
          continue
        }
        if (text[at] === '}') {
          at += 1
          return
        }
        throw new Problem('A comma or the closing } goes here.', at)
      }
    }
    if (character === '[') {
      at += 1
      skip()
      if (text[at] === ']') {
        at += 1
        return
      }
      let comma = -1
      for (;;) {
        skip()
        if (text[at] === ']' && comma !== -1)
          throw new Problem('Remove this comma: no value follows it before the ].', comma)
        value()
        skip()
        if (text[at] === ',') {
          comma = at
          at += 1
          continue
        }
        if (text[at] === ']') {
          at += 1
          return
        }
        throw new Problem('A comma or the closing ] goes here.', at)
      }
    }
    if (character === '"') return string()
    if (character === '-' || (character >= '0' && character <= '9')) return number()
    for (const word of ['true', 'false', 'null'])
      if (text.startsWith(word, at)) {
        at += word.length
        return
      }
    if (character === "'") throw new Problem('JSON strings take double quotes.', at)
    throw new Problem(
      'A value goes here: an object, array, string, number, true, false or null.',
      at,
    )
  }
  value()
  skip()
  if (at < text.length) throw new Problem('There is more after the end of the JSON.', at)
}

/**
 * What the text is: the value, or what is wrong and where. Empty text is
 * no value (`undefined`), which a body editor takes as "no body".
 */
export function parseJsonText(text: string): JsonParse {
  if (text.trim() === '') return { ok: true, value: undefined }
  try {
    scan(text)
  } catch (thrown) {
    if (!(thrown instanceof Problem)) throw thrown
    return { ok: false, message: thrown.message, ...position(text, thrown.at) }
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (error) {
    // The walk above and the browser disagree; say what the browser said.
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      line: 1,
      column: 1,
    }
  }
}

/**
 * The same JSON laid out with two spaces, every literal exactly as typed —
 * or `undefined` when it is not JSON yet.
 */
export function formatJsonText(text: string): string | undefined {
  if (text.trim() === '' || !parseJsonText(text).ok) return undefined
  let out = ''
  let depth = 0
  let at = 0
  const newline = () => `\n${'  '.repeat(depth)}`
  while (at < text.length) {
    const character = text[at] as string
    if (SPACE.has(character)) {
      at += 1
      continue
    }
    if (character === '"') {
      let end = at + 1
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
      out += text.slice(at, end + 1)
      at = end + 1
      continue
    }
    if (character === '{' || character === '[') {
      // An empty container stays on its line: `{}`, `[]`.
      let next = at + 1
      while (SPACE.has(text[next] ?? '')) next += 1
      const close = character === '{' ? '}' : ']'
      if (text[next] === close) {
        out += character + close
        at = next + 1
        continue
      }
      depth += 1
      out += character + newline()
      at += 1
      continue
    }
    if (character === '}' || character === ']') {
      depth -= 1
      out += newline() + character
      at += 1
      continue
    }
    if (character === ',') {
      out += `,${newline()}`
      at += 1
      continue
    }
    if (character === ':') {
      out += ': '
      at += 1
      continue
    }
    // A number or a word, copied as it stands.
    let end = at
    while (
      end < text.length &&
      !SPACE.has(text[end] as string) &&
      !',:{}[]"'.includes(text[end] as string)
    )
      end += 1
    out += text.slice(at, end)
    at = end
  }
  return out
}

/** One editor line: the console's `leading-5`. */
const LINE = '1.25rem'
/** The editor's own padding above and below its text. */
const PADDING = '16px'

export function JsonField({
  value,
  onChange,
  onParsed,
  minLines = 4,
  maxLines = 16,
  readOnly = false,
  autoFocus = false,
  completeKeys,
  ariaLabel,
  testId,
}: {
  value: string
  onChange: (text: string) => void
  /** The parsed value or what is wrong with it, each time the text changes. */
  onParsed?: ((result: JsonParse) => void) | undefined
  minLines?: number | undefined
  maxLines?: number | undefined
  readOnly?: boolean | undefined
  autoFocus?: boolean | undefined
  /**
   * The top-level keys completion offers, read on each completion — the
   * custom claim keys users carry, say (`useClaimKeys().now`).
   */
  completeKeys?: (() => readonly string[]) | undefined
  ariaLabel: string
  testId?: string | undefined
}) {
  const parsed = parseJsonText(value)
  const formatted = readOnly ? undefined : formatJsonText(value)
  // Reported once per text, the first included: a caller that loads a body
  // learns whether it parses without waiting for a keystroke.
  const reported = useRef<string | undefined>(undefined)
  const report = useRef(onParsed)
  useEffect(() => {
    report.current = onParsed
  })
  useEffect(() => {
    if (reported.current === value) return
    reported.current = value
    report.current?.(parseJsonText(value))
  }, [value])
  const ids = testId ?? 'json-field'

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={`${ids}-field`}>
      <div
        className={`flex flex-col overflow-hidden rounded-md ring focus-within:ring-kumo-focus ${
          parsed.ok ? 'ring-kumo-line' : 'ring-kumo-danger'
        }`}
        // Measured in lines, which a class cannot count.
        style={{
          minHeight: `calc(${minLines} * ${LINE} + ${PADDING})`,
          maxHeight: `calc(${maxLines} * ${LINE} + ${PADDING})`,
        }}
      >
        <CodeEditor
          value={value}
          onChange={onChange}
          readOnly={readOnly}
          autoFocus={autoFocus}
          ariaLabel={ariaLabel}
          testId={testId}
          jsonCompletion={completeKeys ? { keys: completeKeys } : undefined}
        />
      </div>
      {(!parsed.ok || !readOnly) && (
        <div className="flex min-h-6 items-start gap-2">
          {!parsed.ok && (
            <p
              className="m-0 min-w-0 flex-1 text-[12px] leading-5 text-kumo-danger"
              role="status"
              data-testid={`${ids}-error`}
            >
              Line {parsed.line}, column {parsed.column}: {parsed.message}
            </p>
          )}
          {!readOnly && (
            <span className="ml-auto shrink-0">
              <Tooltip
                content={
                  formatted === undefined
                    ? 'Nothing to lay out until it is JSON'
                    : 'Lay it out again, two spaces; every value stays as typed'
                }
                render={
                  <span className="inline-flex">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={formatted === undefined || formatted === value}
                      onClick={() => formatted !== undefined && onChange(formatted)}
                      data-testid={`${ids}-format`}
                    >
                      Format JSON
                    </Button>
                  </span>
                }
              />
            </span>
          )}
        </div>
      )}
    </div>
  )
}
