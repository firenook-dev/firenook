// The Schemas page's text handling: definitions shown indented and compared
// by what they say, the parser's reason placed in the text, the templates,
// and a topic's revision window in words.

import { describe, expect, it } from 'vitest'
import {
  SCHEMA_TEMPLATES,
  checkLine,
  checkMarks,
  normalDefinition,
  offsetAt,
  prettyDefinition,
  sameDefinition,
} from './schema-text'
import { revisionWindow } from './used-by-list'

const failed = (overrides: Partial<Parameters<typeof checkMarks>[1] & object> = {}) => ({
  ok: false,
  engineMessage: 'Could not parse schema definition',
  reason: null,
  line: null,
  column: null,
  ...overrides,
})

describe('definitions', () => {
  it('are shown indented, and compared by what they say', () => {
    const stored = '{"type":"record","name":"A","fields":[]}'
    expect(prettyDefinition(stored)).toBe(
      '{\n  "type": "record",\n  "name": "A",\n  "fields": []\n}',
    )
    expect(sameDefinition(stored, prettyDefinition(stored))).toBe(true)
    expect(sameDefinition(stored, stored.replace('"A"', '"B"'))).toBe(false)
    // Text that is not JSON is kept as it is, and compared trimmed.
    expect(prettyDefinition('{ nope')).toBe('{ nope')
    expect(normalDefinition('  { nope \n')).toBe('{ nope')
  })

  it('start from templates the engine accepts as JSON', () => {
    for (const template of SCHEMA_TEMPLATES) {
      const value = JSON.parse(template.definition) as { type: string }
      expect(value.type).toBe('record')
    }
    expect(SCHEMA_TEMPLATES.map((template) => template.id)).toEqual([
      'record',
      'enum',
      'union',
      'nested',
    ])
  })
})

describe('the parser’s reason, in the text', () => {
  it('marks a JSON syntax error at its line and column', () => {
    const text = '{"type": "record",\n "name": }'
    const marks = checkMarks(text, failed({ reason: 'expected value', line: 2, column: 10 }))
    expect(marks).toEqual([
      {
        from: offsetAt(text, 2, 10),
        to: offsetAt(text, 2, 10) + 1,
        severity: 'error',
        message: 'expected value',
      },
    ])
    expect(text.slice(marks[0]?.from ?? 0)).toBe('}')
    expect(checkLine(failed({ reason: 'expected value', line: 2, column: 10 }))).toBe(
      'expected value (line 2, column 10)',
    )
  })

  it('marks the quoted name an Avro reason ends with', () => {
    const text = '{"fields":[{"name":"x","type":"strin"}]}'
    const marks = checkMarks(text, failed({ reason: 'Unknown primitive type: strin' }))
    expect(marks).toHaveLength(1)
    expect(text.slice(marks[0]?.from, marks[0]?.to)).toBe('"strin"')
    expect(checkLine(failed({ reason: 'Unknown primitive type: strin' }))).toBe(
      'Unknown primitive type: strin',
    )
  })

  it('marks nothing it cannot place, and nothing when it parses', () => {
    expect(checkMarks('{}', failed({ reason: 'Fields must be an array' }))).toEqual([])
    expect(checkMarks('{}', { ...failed(), ok: true })).toEqual([])
    expect(checkLine({ ...failed(), ok: true })).toBeUndefined()
    expect(checkLine(failed())).toBe('Could not parse schema definition')
  })
})

describe('a topic’s revision window', () => {
  it('reads as a range, an open end, or any', () => {
    expect(revisionWindow({ firstRevisionId: 'aaaa1111', lastRevisionId: 'bbbb2222' })).toBe(
      'aaaa1111 – bbbb2222',
    )
    expect(revisionWindow({ firstRevisionId: 'aaaa1111', lastRevisionId: null })).toBe(
      'from aaaa1111',
    )
    expect(revisionWindow({ firstRevisionId: null, lastRevisionId: 'bbbb2222' })).toBe(
      'up to bbbb2222',
    )
    expect(revisionWindow({ firstRevisionId: null, lastRevisionId: null })).toBe('any')
  })
})
