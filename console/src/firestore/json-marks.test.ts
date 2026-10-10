import { describe, expect, it } from 'vitest'
import { nodesFrom, nodesFromJson, nodesToJson, parseNode } from './draft'
import { carriedTypes, inferredTypes, typeMarks } from './json-marks'
import { SEP, tidyJson, valueSpans } from './json-text'
import type { FsValue } from './value'

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
      'bytes',
      'double',
      'geopoint',
      'reference',
      'timestamp',
      'vector',
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
    expect(marks[0]?.message).toContain('A timestamp, not the string it looks like')
  })
})

const read = (text: string) => Object.fromEntries(inferredTypes(text))

/** The one field of a one-field document, parsed. */
const only = (text: string) => {
  const node = nodesFromJson(text, [])[0]!
  const parsed = parseNode(node)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.value
}

describe('inferredTypes', () => {
  it('reads a whole number written with a point as a double', () => {
    // The one `JSON.parse` destroys: 3.0 and 3 are the same number to
    // it, and different types to Firestore.
    expect(read('{"a": 3.0, "b": 3, "c": 1.5, "d": 3e2}')).toEqual({
      a: 'double',
      c: 'double',
      d: 'double',
    })
  })

  it('reads back the shapes this console writes', () => {
    expect(read('{"at": {"latitude": 1.5, "longitude": 2.5}}')).toEqual({ at: 'geopoint' })
    expect(read('{"v": {"__type__": "__vector__", "value": [0.1, 0.2]}}')).toEqual({
      v: 'vector',
    })
  })

  it('leaves a map alone that merely carries a latitude', () => {
    // Exactly two keys, both numbers, both in range. A map with a third
    // field is somebody's data, not this module's output.
    expect(read('{"m": {"latitude": 1, "longitude": 2, "label": "home"}}')).toEqual({})
    expect(read('{"m": {"latitude": 1, "longitude": "2"}}')).toEqual({})
    expect(read('{"m": {"latitude": 910, "longitude": 2}}')).toEqual({})
  })

  it('reads an ISO 8601 string as a timestamp, and nothing else as one', () => {
    expect(read('{"when": "2026-09-20T09:00:00.000Z", "what": "2026 was a year"}')).toEqual({
      when: 'timestamp',
    })
  })

  it('says nothing about text that is not a document yet', () => {
    expect(read('{"a": ')).toEqual({})
  })
})

describe('nodesFromJson, reading types out of the text', () => {
  it('authors a double, which was unreachable from this view', () => {
    expect(only('{"a": 3.0}')).toEqual({ type: 'number', value: 3, integer: false })
    expect(only('{"a": 3}')).toEqual({ type: 'number', value: 3, integer: true })
  })

  it('authors a geopoint, a vector and a timestamp', () => {
    expect(only('{"a": {"latitude": 1.5, "longitude": 2.5}}')).toEqual({
      type: 'geopoint',
      latitude: 1.5,
      longitude: 2.5,
    })
    expect(only('{"a": {"__type__": "__vector__", "value": [0.1, 0.2]}}')).toEqual({
      type: 'vector',
      values: [0.1, 0.2],
    })
    expect(only('{"a": "2026-09-20T09:00:00.000Z"}')).toEqual({
      type: 'timestamp',
      value: '2026-09-20T09:00:00.000Z',
    })
  })

  it('never retypes a field the rows already own', () => {
    // The guarantee that makes reading safe: a string that happens to
    // hold an instant, left alone, is still a string afterwards. The
    // rows are consulted before the text is read.
    const { nodes, text } = document({
      when: { type: 'string', value: '2026-09-20T09:00:00.000Z' },
    })
    const after = nodesFromJson(text, nodes)
    expect(after.map((node) => node.type)).toEqual(['string'])
  })

  it('round-trips three of the four through the text alone', () => {
    const { text } = document({
      when: { type: 'timestamp', value: '2026-09-20T09:00:00.000Z' },
      here: { type: 'geopoint', latitude: 1.5, longitude: 2.5 },
      embedding: { type: 'vector', values: [0.1, 0.2] },
    })
    // Not through the rows — through the text alone, which is what
    // pasting this document into an empty one would give.
    expect(nodesFromJson(text, []).map((node) => node.type)).toEqual([
      'timestamp',
      'geopoint',
      'vector',
    ])
  })

  it('cannot round-trip a whole double through the text, and the mark says so', () => {
    // `JSON.stringify` writes the double 269 as `269`, because to
    // JavaScript it is the same number — so a double can be *authored*
    // by typing `269.0`, but once the text is regenerated from the rows
    // the point is gone and only the row still knows. That is exactly
    // what the carried mark is for, and it is on this value.
    const { nodes, text } = document({ total: { type: 'number', value: 269, integer: false } })
    expect(text).toContain('269')
    expect(text).not.toContain('269.0')
    expect(nodesFromJson(text, [])[0]).toMatchObject({ type: 'number' })
    expect(parseNode(nodesFromJson(text, [])[0]!)).toMatchObject({ value: { integer: true } })
    // Through the rows, which is the path the editor actually takes, it
    // survives — and is marked as being carried rather than read.
    expect(parseNode(nodesFromJson(text, nodes)[0]!)).toMatchObject({ value: { integer: false } })
    expect(typeMarks(text, nodes)[0]?.message).toContain('only the saved field still knows')
  })
})

describe('typeMarks warns only where a warning is true', () => {
  // The distinction the message turns on, confirmed on the wire by
  // editing each of these and saving: a timestamp and a geopoint come
  // back as themselves, bytes and a reference come back as strings, and
  // a whole double comes back as an integer — even when the new value
  // is a perfectly good base64 string or document path.
  const held = 'The value is written so that it reads as one'
  const lost = 'only the saved field still knows'

  it('reassures where the text can hold the type on its own', () => {
    const { nodes, text } = document({
      when: { type: 'timestamp', value: '2026-09-20T09:00:00.000Z' },
    })
    const message = typeMarks(text, nodes)[0]?.message ?? ''
    expect(message).toContain('A timestamp, not the string it looks like')
    expect(message).toContain(held)
    expect(message).not.toContain(lost)
  })

  it('reassures a geopoint too, which is held by its shape', () => {
    const { nodes, text } = document({
      at: { type: 'geopoint', latitude: 1.5, longitude: 2.5 },
    })
    const message = typeMarks(text, nodes)[0]?.message ?? ''
    expect(message).toContain('A geopoint, not the map it looks like')
    expect(message).toContain(held)
  })

  it('warns where nothing but the saved field knows', () => {
    const { nodes, text } = document({ blob: { type: 'bytes', base64: 'aGk=' } })
    const message = typeMarks(text, nodes)[0]?.message ?? ''
    expect(message).toContain('Bytes, not the string they look like')
    expect(message).toContain(lost)
    expect(message).toContain('it saves as a string')
  })

  it('warns on a reference, and says what it would become', () => {
    const { nodes, text } = document({
      who: { type: 'reference', value: 'users/u1', path: 'users/u1' },
    })
    expect(typeMarks(text, nodes)[0]?.message).toContain('it saves as a string')
  })

  it('warns on a whole double, which comes back an integer', () => {
    const { nodes, text } = document({ total: { type: 'number', value: 269, integer: false } })
    expect(typeMarks(text, nodes)[0]?.message).toContain('it saves as an integer')
  })

  it('says the same thing for a value no field stands behind', () => {
    // No rows at all: the text alone is making it a timestamp, which
    // from the reader's side is the same situation and the same
    // sentence — the field it did or did not come from is not
    // something the JSON tab shows them.
    const marks = typeMarks('{"when": "2026-09-20T09:00:00.000Z"}', [])
    expect(marks).toHaveLength(1)
    expect(marks[0]?.message).toContain('A timestamp, not the string it looks like')
    expect(marks[0]?.message).toContain(held)
  })

  it('describes what the text will save as, not what the field used to be', () => {
    // The stored field is a timestamp; the value has been replaced with
    // a geopoint. Save takes the geopoint, so that is what the mark says.
    const { nodes } = document({ when: { type: 'timestamp', value: '2026-09-20T09:00:00.000Z' } })
    const marks = typeMarks('{\n  "when": {\n    "latitude": 1,\n    "longitude": 2\n  }\n}', nodes)
    expect(marks[0]?.message).toContain('A geopoint')
  })
})

describe('tidyJson', () => {
  it('lays the document out', () => {
    expect(tidyJson('{"a":1,"b":[2]}')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}')
  })

  it('keeps a double that reads whole, which stringify would flatten', () => {
    // Format and the tidying of a pasted document both run through
    // here, and both used to turn `3.0` into `3` before anything could
    // read the point — destroying the only evidence of the type.
    expect(tidyJson('{"a":3.0,"b":3,"c":1.5}')).toBe('{\n  "a": 3.0,\n  "b": 3,\n  "c": 1.5\n}')
  })

  it('puts the point back at the right value when several move', () => {
    expect(tidyJson('{"a":1.0,"b":"x","c":[2.0,3],"d":4.0}')).toBe(
      '{\n  "a": 1.0,\n  "b": "x",\n  "c": [\n    2.0,\n    3\n  ],\n  "d": 4.0\n}',
    )
  })

  it('says nothing about text that is not a document', () => {
    expect(tidyJson('{"a":')).toBeUndefined()
  })
})
