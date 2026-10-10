import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_LIMIT,
  anyElided,
  documentBytes,
  formatBytes,
  nameBytes,
  sizeReading,
} from './size'
import type { FsValue } from './value'

/** What one named field adds to a document, the fixed parts taken off. */
const field = (name: string, value: FsValue) =>
  documentBytes('', { [name]: value }) - documentBytes('', {})
/** What one value costs, its one-character field name taken off too. */
const size = (value: FsValue) => field('f', value) - 2

describe("Google's own worked example", () => {
  // From the storage-size page: `users/jeff/tasks/my_task_id` holding
  // four fields, which Google totals at 147 bytes — 44 for the name, 71
  // for the fields, 32 over. Every line of their breakdown is checked,
  // not just the total, so a rule that is wrong in two places that
  // cancel out still fails.
  const path = 'users/jeff/tasks/my_task_id'
  const fields: Record<string, FsValue> = {
    type: { type: 'string', value: 'Personal' },
    done: { type: 'boolean', value: false },
    priority: { type: 'number', value: 1, integer: true },
    description: { type: 'string', value: 'Learn Cloud Firestore' },
  }

  it('prices the document name at 44 bytes', () => {
    expect(nameBytes(path)).toBe(44)
  })

  it('prices each field as Google prices it', () => {
    expect(field('type', fields.type!)).toBe(14)
    expect(field('done', fields.done!)).toBe(6)
    expect(field('priority', fields.priority!)).toBe(17)
    expect(field('description', fields.description!)).toBe(34)
  })

  it('totals the document at 147 bytes', () => {
    expect(documentBytes(path, fields)).toBe(147)
  })
})

describe('the size of a value', () => {
  it('gives a number eight bytes however it reads', () => {
    expect(size({ type: 'number', value: 1, integer: true })).toBe(8)
    expect(size({ type: 'number', value: 1e300, integer: false })).toBe(8)
  })

  it('gives a boolean and a null one byte', () => {
    expect(size({ type: 'boolean', value: true })).toBe(1)
    expect(size({ type: 'null' })).toBe(1)
  })

  it('gives a timestamp eight and a geopoint sixteen', () => {
    expect(size({ type: 'timestamp', value: '2026-09-20T09:00:00.000000Z' })).toBe(8)
    expect(size({ type: 'geopoint', latitude: 1.5, longitude: 2.5 })).toBe(16)
  })

  it('counts a string in UTF-8 bytes, not characters', () => {
    expect(size({ type: 'string', value: 'abc' })).toBe(4)
    // Four characters, twelve UTF-8 bytes: a rule written over `.length`
    // would say five.
    expect(size({ type: 'string', value: '日本語で' })).toBe(13)
  })

  it('counts bytes as what the base64 decodes to', () => {
    expect(size({ type: 'bytes', base64: 'aGVsbG8=' })).toBe(5)
    expect(size({ type: 'bytes', base64: 'aGk=' })).toBe(2)
  })

  it('prices a reference as the name of what it points at', () => {
    expect(size({ type: 'reference', value: 'users/u1', path: 'users/u1' })).toBe(
      nameBytes('users/u1'),
    )
  })

  it('gives a vector eight bytes a dimension, not the map it is written as', () => {
    expect(size({ type: 'vector', values: [0.1, 0.2, 0.3] })).toBe(24)
  })

  it('sums an array and charges nothing for the brackets', () => {
    expect(
      size({ type: 'array', items: [{ type: 'boolean', value: true }, { type: 'null' }] }),
    ).toBe(2)
  })

  it('charges a map for its keys as well as its values, and no 32 of its own', () => {
    // `{ a: true }` is one key of one character — two bytes — and one
    // boolean. A map carrying the document's 32 would say 35.
    expect(size({ type: 'map', fields: { a: { type: 'boolean', value: true } } })).toBe(3)
  })

  it('nests', () => {
    const inner: FsValue = { type: 'map', fields: { a: { type: 'boolean', value: true } } }
    expect(size({ type: 'array', items: [inner, inner] })).toBe(6)
  })
})

describe('what the footer says', () => {
  it('writes small documents in bytes and bigger ones in kilobytes', () => {
    expect(formatBytes(147)).toBe('147 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(12_700)).toBe('12.4 KB')
    expect(formatBytes(900_000)).toBe('879 KB')
  })

  it('keeps hundredths of a megabyte, where the limit is', () => {
    expect(formatBytes(DOCUMENT_LIMIT)).toBe('1.00 MB')
    expect(formatBytes(DOCUMENT_LIMIT + 40_000)).toBe('1.04 MB')
  })

  it('is quiet until the document is nearly full', () => {
    expect(sizeReading(1000).tone).toBe('quiet')
    expect(sizeReading(DOCUMENT_LIMIT * 0.89).tone).toBe('quiet')
    expect(sizeReading(DOCUMENT_LIMIT * 0.95).tone).toBe('crowded')
    expect(sizeReading(DOCUMENT_LIMIT).tone).toBe('crowded')
    expect(sizeReading(DOCUMENT_LIMIT + 1).tone).toBe('over')
  })

  it('says how full only once that is worth knowing', () => {
    // A real document measured for this is 472 bytes: as a share that
    // reads "0%", which says nothing the size did not.
    expect(sizeReading(472).text).toBe('472 B')
    expect(sizeReading(900_000).text).toBe('879 KB')
    expect(sizeReading(996_148).text).toBe('973 KB · 95%')
    expect(sizeReading(DOCUMENT_LIMIT).text).toBe('1.00 MB · 100%')
  })

  it('never lets a document over the line read as 100%', () => {
    expect(sizeReading(DOCUMENT_LIMIT + 1).text).toBe('1.00 MB · 101%')
    expect(sizeReading(1_100_066).text).toBe('1.05 MB · 105%')
  })

  it('says the engine and Firestore disagree once it is over', () => {
    expect(sizeReading(DOCUMENT_LIMIT + 1).title).toContain('Firestore will reject it')
    expect(sizeReading(1000).title).not.toContain('reject')
    expect(sizeReading(1000).title).toContain('1,048,576 bytes a document may hold')
  })

  it('says at least, where part of the document never arrived', () => {
    const reading = sizeReading(500, true)
    expect(reading.text).toBe('≥ 500 B')
    expect(reading.title).toContain('the real size is larger')
  })
})

describe('anyElided', () => {
  it('finds a cut-short value however deep it is', () => {
    expect(anyElided({ a: { type: 'string', value: 'x' } })).toBe(false)
    expect(anyElided({ a: { type: 'string', value: 'x', elided: 10 } })).toBe(true)
    expect(
      anyElided({
        a: {
          type: 'array',
          items: [{ type: 'map', fields: { b: { type: 'bytes', base64: '', elided: 2 } } }],
        },
      }),
    ).toBe(true)
  })
})
