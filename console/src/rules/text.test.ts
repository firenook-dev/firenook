import { describe, expect, it } from 'vitest'
import {
  RulesCompileError,
  describeDiagnostic,
  lineCount,
  offsetOf,
  ruleLine,
  rulesFailure,
} from './text'

const at = (line: number, column: number) => ({
  severity: 'error',
  message: "expected '{'",
  line,
  column,
})

describe('the gutter', () => {
  it('numbers one line for empty text, not none', () => {
    expect(lineCount('')).toBe(1)
  })

  it('counts the lines a ruleset has', () => {
    expect(lineCount('a\nb\nc')).toBe(3)
  })

  it('counts a trailing newline as the line it opens', () => {
    expect(lineCount('a\n')).toBe(2)
  })
})

describe('placing a diagnostic in the text', () => {
  const source = 'rules_version = ;\nservice cloud.firestore {\n  match /x {\n'

  it('finds the first line from its column alone', () => {
    expect(offsetOf(source, at(1, 17))).toBe(16)
  })

  it('counts the newlines before a later line', () => {
    // Line 1 is 17 characters, so line 2 starts at 18; line 2 is 25, so
    // line 3 starts at 44, and column 3 is two further in.
    expect(offsetOf(source, at(2, 1))).toBe(18)
    expect(offsetOf(source, at(3, 3))).toBe(46)
  })

  it('clamps past the end rather than throwing, because a hint can be stale', () => {
    expect(offsetOf(source, at(99, 99))).toBe(source.length)
    expect(offsetOf('short', at(1, 500))).toBe('short'.length)
  })

  it('treats a column of zero as the start of the line', () => {
    expect(offsetOf(source, at(2, 0))).toBe(18)
  })
})

describe('the line a diagnostic reads as', () => {
  it('leads with where, then what', () => {
    expect(describeDiagnostic(at(3, 17))).toBe("3:17 expected '{'")
  })
})

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, statusText: 'Bad Request' })

describe('a rules call that failed', () => {
  it('is a compile error, with its places, when the engine names them', async () => {
    const diagnostics = [
      {
        severity: 'error',
        message: "expected '{'",
        line: 3,
        column: 17,
        from: 40,
        to: 40,
        code: null,
      },
    ]
    const error = await rulesFailure(
      answer(400, {
        error: { code: 'invalid-argument', message: 'The rules do not compile.' },
        diagnostics,
      }),
    )
    expect(error).toBeInstanceOf(RulesCompileError)
    expect((error as RulesCompileError).diagnostics).toEqual(diagnostics)
    expect(error.message).toBe('The rules do not compile.')
  })

  it('is the console error otherwise, code and fix kept', async () => {
    const error = await rulesFailure(
      answer(409, {
        error: { code: 'conflict', message: 'Not written.', fix: 'Check the file is writable.' },
      }),
    )
    expect(error).not.toBeInstanceOf(RulesCompileError)
    expect(error).toMatchObject({
      status: 409,
      code: 'conflict',
      fix: 'Check the file is writable.',
    })
  })

  it('keeps the status line when the body is not JSON', async () => {
    const error = await rulesFailure(
      new Response('<html>', { status: 502, statusText: 'Bad Gateway' }),
    )
    expect(error.message).toBe('502 Bad Gateway')
  })
})

describe('a line of the rules', () => {
  it('is trimmed, and empty past the end', () => {
    expect(ruleLine('a\n   allow read;  \n', 2)).toBe('allow read;')
    expect(ruleLine('a', 9)).toBe('')
  })
})
