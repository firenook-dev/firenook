import { describe, expect, it } from 'vitest'
import { nodesFrom, nodesToJson } from './draft'
import { carriedTypes, typeMarks, valueSpans } from './json-marks'
import type { FsValue } from './value'

const SEP = '\u0000'

function document(fields: Record<string, FsValue>) {
  const nodes = nodesFrom(fields, true)
  return { nodes, text: JSON.stringify(nodesToJson(nodes), null, 2) }
}

/** The text a mark covers, which is the thing a reader sees underlined. */
function marked(fields: Record<string, FsValue>): string[] {
  const { nodes, text } = document(fields)
  return typeMarks(text, nodes).map((mark) => text.slice(mark.from, mark.to))
}

describe('valueSpans', () => {
  it('finds every value by path, nested and in arrays', () => {
    const text = '{\n  "a": 1,\n  "b": { "c": "x" },\n  "d": [true, null]\n}'
    const spans = valueSpans(text)
    const at = (path: string) => {
      const span = spans.get(path.split('.').join(SEP))
      return span ? text.slice(span.from, span.to) : undefined
    }
    expect(at('a')).toBe('1')
    expect(at('b')).toBe('{ "c": "x" }')
    expect(at('b.c')).toBe('"x"')
    expect(at('d')).toBe('[true, null]')
    expect(at('d.0')).toBe('true')
    expect(at('d.1')).toBe('null')
  })

  it('tells a key with a dot in it from a nested one', () => {
    // Joined on NUL, which no key can contain, so `{"a.b": 1}` and
    // `{"a": {"b": 2}}` cannot be mistaken for one another.
    const flat = valueSpans('{"a.b": 1}')
    const nested = valueSpans('{"a": {"b": 2}}')
    expect([...flat.keys()]).toEqual(['a.b'])
    expect([...nested.keys()].toSorted()).toEqual(['a', `a${SEP}b`].toSorted())
  })

  it('keeps what it read when the text stops making sense', () => {
    // The document is being typed. Everything up to the break is still
    // worth marking; the rest simply has no marks until it parses.
    const spans = valueSpans('{"a": 1, "b": ')
    expect(spans.get('a')).toEqual({ from: 6, to: 7 })
    expect(spans.has('b')).toBe(false)
  })

  it('reads a string with an escaped quote in it', () => {
    const text = String.raw`{"a": "say \"hi\"", "b": 2}`
    const spans = valueSpans(text)
    expect(text.slice(spans.get('a')!.from, spans.get('a')!.to)).toBe(String.raw`"say \"hi\""`)
    expect(text.slice(spans.get('b')!.from, spans.get('b')!.to)).toBe('2')
  })
})

describe('carriedTypes', () => {
  it('names the six types JSON cannot write down', () => {
    const { nodes } = document({
      when: { type: 'timestamp', value: '2026-09-20T09:00:00.000Z' },
      who: { type: 'reference', value: 'users/u1', path: 'users/u1' },
      blob: { type: 'bytes', base64: 'aGk=' },
      where: { type: 'geopoint', latitude: 1, longitude: 2 },
      embedding: { type: 'vector', values: [0.1, 0.2] },
      total: { type: 'number', value: 269, integer: false },
    })
    expect([...carriedTypes(nodes).values()].toSorted()).toEqual([
      'a double',
      'a geopoint',
      'a reference',
      'a timestamp',
      'a vector',
      'bytes',
    ])
  })

  it('leaves alone every value the text already says', () => {
    const { nodes } = document({
      name: { type: 'string', value: 'Ada' },
      seats: { type: 'number', value: 4, integer: true },
      // A double that does not read whole needs no help: JSON writes
      // 1.5 as a double too.
      rate: { type: 'number', value: 1.5, integer: false },
      on: { type: 'boolean', value: true },
      nothing: { type: 'null' },
    })
    expect(carriedTypes(nodes).size).toBe(0)
  })

  it('reaches values nested in maps and arrays', () => {
    const { nodes } = document({
      meta: {
        type: 'map',
        fields: { at: { type: 'timestamp', value: '2026-09-20T09:00:00.000Z' } },
      },
      seen: { type: 'array', items: [{ type: 'timestamp', value: '2026-09-21T09:00:00.000Z' }] },
    })
    expect([...carriedTypes(nodes).keys()]).toEqual([`meta${SEP}at`, `seen${SEP}0`])
  })
})

describe('typeMarks', () => {
  it('puts the mark on the value, not on the line or the field', () => {
    expect(
      marked({
        name: { type: 'string', value: 'Ada' },
        when: { type: 'timestamp', value: '2026-09-20T09:00:00.000Z' },
      }),
    ).toEqual(['"2026-09-20T09:00:00.000Z"'])
  })

  it('stops a container mark at the end of its first line', () => {
    // A geopoint is written as a two-key map over four lines. Underlining
    // all four to say one thing about the value they make up reads as
    // damage; the mark stops where the line does.
    expect(marked({ here: { type: 'geopoint', latitude: 1, longitude: 2 } })).toEqual(['{'])
  })

  it('says nothing about a document that carries nothing', () => {
    expect(marked({ name: { type: 'string', value: 'Ada' } })).toEqual([])
  })

  it('drops the mark while the value it describes is being retyped', () => {
    // The rows still say `when` is a timestamp, but the text no longer
    // has a `when` to mark. A mark at a stale offset would sit on some
    // other field's value.
    const { nodes } = document({ when: { type: 'timestamp', value: '2026-09-20T09:00:00.000Z' } })
    expect(typeMarks('{\n  "whe\n}', nodes)).toEqual([])
  })

  it('marks it again once the text agrees', () => {
    const { nodes, text } = document({
      when: { type: 'timestamp', value: '2026-09-20T09:00:00.000Z' },
    })
    const marks = typeMarks(text, nodes)
    expect(marks).toHaveLength(1)
    expect(marks[0]?.severity).toBe('info')
    expect(marks[0]?.message).toContain('Stays a timestamp')
  })
})
