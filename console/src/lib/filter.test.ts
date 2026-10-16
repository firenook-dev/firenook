import { describe, expect, it } from 'vitest'
import {
  type FilterFieldDef,
  checkFilter,
  contextAt,
  fieldFor,
  filterTokens,
  filterValueText,
  parseBytes,
  parseDuration,
  parseFilter,
  parseNumber,
  parseTime,
  printFilter,
} from './filter'
import cases from './filter-cases.json'
import { type GoldenFile, runGoldenCases } from './filter-golden.test-support'

const golden = cases as GoldenFile

describe('the golden cases (filter-cases.json), as the engine runs them', () => {
  const count = runGoldenCases(golden)

  it('holds at least seventy cases, the ROADMAP line among them', () => {
    expect(count).toBeGreaterThanOrEqual(70)
    const roadmap = golden.cases.find((entry) => entry.name === 'roadmap-example')
    expect(roadmap?.text).toBe('provider:google -is:disabled ada')
  })
})

describe('the harness', () => {
  it('refuses a field the engine would refuse', () => {
    expect(() =>
      runGoldenCases({
        fields: [{ key: 'a', kind: 'text', valueAlias: {} } as never],
        cases: [],
      }),
    ).toThrow('unknown field "valueAlias"')
    expect(() => runGoldenCases({ fields: [{ key: 'a', kind: 'colour' }], cases: [] })).toThrow(
      'unknown kind colour',
    )
  })
})

const fields: FilterFieldDef[] = golden.fields.map((field) => ({
  ...field,
  kind: field.kind as FilterFieldDef['kind'],
}))

/** A query's items without their spans: what must survive printing and parsing again. */
const strip = <T extends { from: number; to: number }>(items: T[]) =>
  items.map(({ from: _from, to: _to, ...rest }) => rest)

describe('printFilter', () => {
  const texts = golden.cases
    .filter((entry) => entry.ok !== undefined)
    .map((entry) => ({ text: entry.text, regex: entry.regex ?? false }))

  it.each(texts)('writes $text back so that it parses to the same query', ({ text, regex }) => {
    const first = checkFilter(text, { fields, regex })
    if (!first.ok) throw new Error(first.error.message)
    const printed = printFilter(first.query, regex)
    const again = checkFilter(printed, { fields, regex })
    if (!again.ok) throw new Error(`${printed}: ${again.error.message}`)
    expect(strip(again.query.terms)).toEqual(strip(first.query.terms))
    expect(strip(again.query.words)).toEqual(strip(first.query.words))
    expect(strip(again.query.regexes)).toEqual(strip(first.query.regexes))
  })

  it('quotes only what would read back as something else', () => {
    const parsed = parseFilter('-"foo:bar" "-x" "a b" email:">x" uid:"" plain')
    if (!parsed.ok) throw new Error(parsed.error.message)
    expect(printFilter(parsed.query)).toBe('-"foo:bar" "-x" "a b" email:">x" uid:"" plain')
    expect(filterValueText('google.com')).toBe('google.com')
    expect(filterValueText('say "hi"')).toBe('"say \\"hi\\""')
  })
})

describe('contextAt', () => {
  it('reads a new item as a key with nothing typed yet', () => {
    expect(contextAt('', 0)).toEqual({
      kind: 'key',
      from: 0,
      to: 0,
      prefix: '',
      hasSeparator: false,
      negated: false,
    })
    expect(contextAt('ada ', 4)).toMatchObject({ kind: 'key', from: 4, prefix: '' })
  })

  it('reads a key being typed, its span and whether it has its separator', () => {
    expect(contextAt('-prov', 5)).toMatchObject({
      kind: 'key',
      from: 1,
      to: 5,
      prefix: 'prov',
      hasSeparator: false,
      negated: true,
    })
    expect(contextAt('provider:google', 4)).toMatchObject({
      kind: 'key',
      from: 0,
      to: 8,
      prefix: 'prov',
      hasSeparator: true,
    })
  })

  it('reads a value after the key and its operator, quote and all', () => {
    expect(contextAt('ada provider:goo', 16)).toEqual({
      kind: 'value',
      key: 'provider',
      op: 'eq',
      from: 13,
      to: 16,
      prefix: 'goo',
      quoted: false,
      negated: false,
    })
    expect(contextAt('created:>=-2', 12)).toMatchObject({
      kind: 'value',
      key: 'created',
      op: 'ge',
      from: 10,
      prefix: '-2',
    })
    expect(contextAt('email:"ada lo', 13)).toMatchObject({
      kind: 'value',
      from: 6,
      to: 13,
      prefix: 'ada lo',
      quoted: true,
    })
    expect(contextAt('level=', 6)).toMatchObject({ kind: 'value', key: 'level', prefix: '' })
  })

  it('tells a path key from any other key when it knows the fields', () => {
    const context = contextAt('DATA.us', 7, { fields })
    expect(context).toMatchObject({ kind: 'path', prefix: 'DATA.us' })
    expect(context.kind === 'path' && context.field.key).toBe('data')
    expect(contextAt('data', 4, { fields })).toMatchObject({ kind: 'key', prefix: 'data' })
  })

  it('reads plain text as a word, and a phrase or a regex as nothing to complete', () => {
    expect(contextAt('ada@exa', 7)).toMatchObject({ kind: 'word', prefix: 'ada@exa' })
    expect(contextAt('12:30', 2)).toMatchObject({ kind: 'word' })
    expect(contextAt('"ada lo', 5)).toEqual({ kind: 'none' })
    expect(contextAt('/time', 3, { regex: true })).toEqual({ kind: 'none' })
    expect(contextAt('/time', 3)).toMatchObject({ kind: 'word' })
  })

  it('counts in UTF-16, as an input element does', () => {
    expect(contextAt('火🔥 p:', 6)).toMatchObject({ kind: 'value', key: 'p', from: 6 })
  })
})

describe('filterTokens', () => {
  it('reads the items of a filter that does not parse, quotes and all', () => {
    expect(filterTokens('provider:google -is:"x y" "open ada')).toEqual([
      { from: 0, body: 0, to: 15, negated: false, kind: 'term', separator: 8 },
      { from: 16, body: 17, to: 25, negated: true, kind: 'term', separator: 19 },
      { from: 26, body: 26, to: 35, negated: false, kind: 'phrase' },
    ])
  })
})

describe('fieldFor', () => {
  it('finds a field by key, alias or path prefix, ignoring case', () => {
    expect(fieldFor('P', fields)?.key).toBe('provider')
    expect(fieldFor('createdAt', fields)?.key).toBe('created')
    expect(fieldFor('labels.attempt', fields)?.key).toBe('data')
    expect(fieldFor('nope', fields)).toBeUndefined()
  })
})

describe('the value parsers, as the engine compares values', () => {
  const now = Date.parse('2026-10-12T15:30:00Z')
  const at = (text: string) => {
    const value = parseTime(text, now)
    return value === null ? null : new Date(value).toISOString()
  }

  it('reads times', () => {
    expect(at('now')).toBe('2026-10-12T15:30:00.000Z')
    expect(at('Today')).toBe('2026-10-12T00:00:00.000Z')
    expect(at('-2h')).toBe('2026-10-12T13:30:00.000Z')
    expect(at('-1w')).toBe('2026-10-05T15:30:00.000Z')
    expect(at('2026-10-01')).toBe('2026-10-01T00:00:00.000Z')
    expect(at('2026-10-01T08:00:00+08:00')).toBe('2026-10-01T00:00:00.000Z')
    expect(at('2026-10-01 08:00:00.5z')).toBe('2026-10-01T08:00:00.500Z')
    for (const bad of ['2026-02-30', '-2', '-h', 'yesterday', '2026-10-1', '-1.5h', '-2é'])
      expect(at(bad), bad).toBeNull()
  })

  it('reads RFC 3339 exactly as the engine does', () => {
    // Any one byte between date and time; never a character of two.
    expect(at('2026-10-01x08:00:00Z')).not.toBeNull()
    expect(at('2026-10-01é08:00:00Z')).toBeNull()
    // Offsets under a day; minutes under an hour.
    expect(at('2026-10-01T08:00:00+24:00')).toBeNull()
    expect(at('2026-10-01T08:00:00+05:60')).toBeNull()
    // A leap second only where one can fall: the last second of a month, UTC.
    expect(at('2016-12-31T23:59:60Z')).not.toBeNull()
    expect(at('2016-12-30T23:59:60Z')).toBeNull()
    expect(at('2017-01-01T07:59:60+08:00')).not.toBeNull()
    expect(at('2026-10-01T24:00:00Z')).toBeNull()
  })

  it('refuses a relative time past the engine’s calendar', () => {
    expect(parseTime('-1000w', 0)).not.toBeNull()
    expect(parseTime('-1000000w', 0)).toBeNull()
    expect(parseTime('-99999999999999999999d', 0)).toBeNull()
  })

  it('reads sizes, durations and numbers', () => {
    expect(parseBytes('512')).toBe(512)
    expect(parseBytes('10KB')).toBe(10_240)
    expect(parseBytes('1.5mb')).toBe(1_572_864)
    expect(parseBytes('2GB')).toBe(2 * 1024 * 1024 * 1024)
    for (const bad of ['10 KB', '-1KB', 'KB', '1.2.3KB']) expect(parseBytes(bad), bad).toBeNull()
    expect(parseDuration('250ms')).toBe(250)
    expect(parseDuration('1.5m')).toBe(90_000)
    expect(parseDuration('2')).toBeNull()
    expect(parseDuration('99999999999999999999h')).toBeNull()
    expect(parseNumber('-2.5')).toBe(-2.5)
    for (const bad of ['2.', '.5', '1e3', '', '-']) expect(parseNumber(bad), bad).toBeNull()
  })
})
