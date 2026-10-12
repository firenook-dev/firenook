import { describe, expect, it } from 'vitest'
import golden from './filter-cases.json'
import {
  type FieldSet,
  type FieldSpec,
  checkFilter,
  filterOutcome,
  parseBytes,
  parseDuration,
  parseFilter,
  parseNumber,
  parseTime,
} from './filter'

interface GoldenCase {
  name?: string
  text: string
  regex?: boolean
  ok?: { terms?: unknown[]; words?: unknown[]; regexes?: unknown[] }
  error?: { from: number; to: number; message: string }
  note?: string
}

const fields = golden.fields as FieldSpec[]
const cases = golden.cases as GoldenCase[]

/** The query as the golden file writes an `ok`: missing lists are empty. */
function expected(entry: GoldenCase) {
  if (entry.error) return { error: entry.error }
  return {
    ok: {
      terms: entry.ok?.terms ?? [],
      words: entry.ok?.words ?? [],
      regexes: entry.ok?.regexes ?? [],
    },
  }
}

describe('the golden file (shared with filter.rs)', () => {
  it('holds at least 70 cases, the ROADMAP example among them', () => {
    expect(cases.length).toBeGreaterThanOrEqual(70)
    expect(cases.find((entry) => entry.name === 'roadmap-example')?.text).toBe(
      'provider:google -is:disabled ada',
    )
    for (const entry of cases) expect(Boolean(entry.ok) !== Boolean(entry.error)).toBe(true)
  })

  it.each(cases.map((entry) => [entry.name ?? entry.text, entry] as const))('%s', (_, entry) => {
    const set: FieldSet = { fields, regex: entry.regex ?? golden.regex }
    expect(filterOutcome(entry.text, set)).toEqual(expected(entry))
  })
})

describe('values parse into what a section compares', () => {
  const now = Date.parse('2026-10-12T15:30:00Z')
  const at = (text: string) => {
    const instant = parseTime(text, now)
    return instant === undefined ? undefined : new Date(instant).toISOString()
  }

  it('reads times the way the engine does', () => {
    expect(at('now')).toBe('2026-10-12T15:30:00.000Z')
    expect(at('Today')).toBe('2026-10-12T00:00:00.000Z')
    expect(at('-2h')).toBe('2026-10-12T13:30:00.000Z')
    expect(at('-1w')).toBe('2026-10-05T15:30:00.000Z')
    expect(at('-90S')).toBe('2026-10-12T15:28:30.000Z')
    expect(at('2026-10-01')).toBe('2026-10-01T00:00:00.000Z')
    expect(at('2026-10-01T08:00:00+08:00')).toBe('2026-10-01T00:00:00.000Z')
    expect(at('2026-10-01t08:00:00.5z')).toBe('2026-10-01T08:00:00.500Z')
    // RFC 3339 allows any separator; the engine reads a space too.
    expect(at('2026-10-01 08:00:00Z')).toBe('2026-10-01T08:00:00.000Z')
    expect(at('0001-01-01')).toBe('0001-01-01T00:00:00.000Z')
    expect(at('2024-02-29')).toBe('2024-02-29T00:00:00.000Z')
    for (const bad of [
      '2026-02-30',
      '2025-02-29',
      '-2',
      '-h',
      '-',
      'yesterday',
      '2026-10-1',
      '-1.5h',
      '2026-10-01T24:00:00Z',
      '2026-10-01T08:00:00+24:00',
      '2026-10-01T08:00:00+08:60',
      '2026-10-01T08:00:00',
      '2026-10-01T08:00Z',
      '2026-10-01T08:00:00.Z',
      '٢٠٢٦-١٠-٠١',
      '-5é',
    ])
      expect(at(bad), bad).toBeUndefined()
  })

  it('takes a leap second only as the last instant of a month', () => {
    expect(at('2016-12-31T23:59:60Z')).toBe('2016-12-31T23:59:59.999Z')
    expect(at('2017-01-01T07:59:60+08:00')).toBe('2016-12-31T23:59:59.999Z')
    expect(at('2016-12-30T23:59:60Z')).toBeUndefined()
    expect(at('2016-12-31T23:58:60Z')).toBeUndefined()
  })

  it('keeps relative times inside the years the engine can hold', () => {
    expect(parseTime('-3000000d', 0)).toBeDefined()
    expect(parseTime('-5000000d', 0)).toBeUndefined()
    expect(parseTime('-99999999999999999999s', 0)).toBeUndefined()
  })

  it('reads sizes, durations and numbers', () => {
    expect(parseBytes('512')).toBe(512)
    expect(parseBytes('10KB')).toBe(10_240)
    expect(parseBytes('1.5mb')).toBe(1_572_864)
    expect(parseBytes('2GB')).toBe(2 * 1024 * 1024 * 1024)
    expect(parseBytes('10 KB')).toBeUndefined()
    expect(parseBytes('-1KB')).toBeUndefined()
    expect(parseBytes('KB')).toBeUndefined()
    expect(parseBytes('1PB')).toBeUndefined()
    expect(parseDuration('250ms')).toBe(250)
    expect(parseDuration('1.5m')).toBe(90_000)
    expect(parseDuration('2H')).toBe(7_200_000)
    expect(parseDuration('2')).toBeUndefined()
    expect(parseNumber('-2.5')).toBe(-2.5)
    expect(parseNumber('007')).toBe(7)
    expect(parseNumber('2.')).toBeUndefined()
    expect(parseNumber('.5')).toBeUndefined()
    expect(parseNumber('1e3')).toBeUndefined()
    expect(parseNumber('1.2.3')).toBeUndefined()
  })
})

describe('a list with its own fields', () => {
  it('says so when it has no filters at all', () => {
    expect(checkFilter('foo:bar', { fields: [] })).toEqual({
      ok: false,
      error: {
        message:
          'Unknown filter "foo:". This list has no filters; quote it to search for the text.',
        from: 0,
        to: 7,
      },
    })
  })

  it('reads the engine’s ListMeta fields as they arrive', () => {
    const set: FieldSet = {
      fields: [
        {
          key: 'state',
          aliases: [],
          kind: 'enum',
          help: 'Task state',
          values: ['queued', 'running', 'failed'],
          valueAliases: { error: 'failed', errored: 'failed' },
          prefixes: [],
        },
      ],
    }
    const result = checkFilter('state:Errored', set)
    expect(result.ok && result.query.terms[0]?.value).toBe('failed')
    const refused = checkFilter('state:done', set)
    expect(!refused.ok && refused.error.message).toBe(
      '"state:" is one of queued, running, failed (error, errored).',
    )
  })

  it('parses without validating, for tools that only need the spans', () => {
    const result = parseFilter('level:error -/x/ "a b"', true)
    expect(result.ok && result.query.regexes[0]).toMatchObject({ pattern: 'x', negated: true })
    expect(result.ok && result.query.terms[0]).toMatchObject({ key: 'level', from: 0, to: 11 })
  })
})
