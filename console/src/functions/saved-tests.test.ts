import { beforeEach, describe, expect, it } from 'vitest'
import { emptyInvokeDraft } from './invoke-request'
import {
  SAVED_PER_FUNCTION,
  deleteTest,
  exportTests,
  importTests,
  readTestsFile,
  saveTest,
  savedTests,
} from './saved-tests'

const draft = emptyInvokeDraft()

describe('saved tests', () => {
  beforeEach(() => localStorage.clear())

  it('saves by name, newest first, and replaces a name', () => {
    expect(saveTest('p', 'f', { name: 'one', kind: 'request', draft })).toEqual({ ok: true })
    expect(saveTest('p', 'f', { name: 'two', kind: 'request', draft })).toEqual({ ok: true })
    expect(
      saveTest('p', 'f', { name: 'one', kind: 'request', draft: { ...draft, path: '/x' } }),
    ).toEqual({ ok: true })
    expect(savedTests('p', 'f').map((test) => test.name)).toEqual(['one', 'two'])
    expect(savedTests('p', 'f')[0]?.draft).toMatchObject({ path: '/x' })
    deleteTest('p', 'f', 'two')
    expect(savedTests('p', 'f').map((test) => test.name)).toEqual(['one'])
    expect(savedTests('p', 'other')).toBe(savedTests('p', 'other'))
  })

  it('refuses past the caps, saying which', () => {
    for (let index = 0; index < SAVED_PER_FUNCTION; index += 1)
      saveTest('p', 'f', { name: `t${index}`, kind: 'request', draft })
    expect(saveTest('p', 'f', { name: 'one more', kind: 'request', draft })).toEqual({
      refused: expect.stringContaining('50 saved tests') as string,
    })
    const huge = { ...draft, body: { kind: 'text' as const, text: 'x'.repeat(1_100_000) } }
    expect(saveTest('p', 'g', { name: 'huge', kind: 'request', draft: huge })).toEqual({
      refused: expect.stringContaining('1 MB') as string,
    })
    expect(saveTest('p', 'g', { name: '  ', kind: 'request', draft })).toEqual({
      refused: 'Name the test.',
    })
  })

  it('exports and imports a file, merged by name', () => {
    saveTest('p', 'f', { name: 'mine', kind: 'request', draft })
    const file = exportTests('f', [
      {
        name: 'shared',
        kind: 'callable',
        draft: {
          kind: 'callable',
          data: '{}',
          identity: { kind: 'owner' },
          appCheck: { kind: 'none' },
          stream: false,
        },
        savedAt: '',
      },
    ])
    expect(JSON.parse(file)).toMatchObject({
      version: 1,
      function: 'f',
      saved: [{ name: 'shared', kind: 'callable' }],
    })
    expect(importTests('p', 'f', file)).toEqual({ imported: 1 })
    expect(savedTests('p', 'f').map((test) => test.name)).toEqual(['shared', 'mine'])
  })

  it("refuses a file that is not this function's export", () => {
    expect(readTestsFile('nope', 'f')).toEqual({ refused: 'The file is not JSON.' })
    expect(readTestsFile('{"version":2}', 'f')).toEqual({
      refused: 'The file is not a version 1 saved-tests export.',
    })
    expect(readTestsFile('{"version":1,"function":"g","saved":[]}', 'f')).toEqual({
      refused: 'The file holds tests for g, not f.',
    })
    expect(
      readTestsFile(
        '{"version":1,"function":"f","saved":[{"name":"x","kind":"bad","draft":{"kind":"request"}}]}',
        'f',
      ),
    ).toEqual({
      refused: 'x has an unknown kind.',
    })
  })
})
