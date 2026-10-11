import { describe, expect, it } from 'vitest'
import {
  csvCell,
  csvColumns,
  csvField,
  csvRow,
  documentToJson,
  exportFilename,
  formatInfo,
} from './export'
import type { FsDocument } from './value'

const ROOT = 'projects/demo/databases/(default)/documents'

const document = (path: string, fields: FsDocument['fields']): FsDocument => ({
  path,
  id: path.slice(path.lastIndexOf('/') + 1),
  collection: path.slice(0, path.lastIndexOf('/')),
  fields,
  createTime: '2026-01-01T00:00:00Z',
  updateTime: '2026-01-01T00:00:00Z',
})

describe('what a file is called', () => {
  it('names it after the collection and the moment, with the right extension', () => {
    const at = new Date('2026-10-08T03:21:45.000Z')
    expect(exportFilename('users/u1/orders', 'json', at)).toBe(
      'users-u1-orders-2026-10-08-032145.json',
    )
    expect(exportFilename('users', 'ndjson', at)).toBe('users-2026-10-08-032145.ndjson')
    expect(exportFilename('users', 'csv', at)).toBe('users-2026-10-08-032145.csv')
  })

  it('falls back to a name when there is no collection', () => {
    expect(exportFilename('', 'json', new Date('2026-10-08T00:00:00Z'))).toMatch(/^firestore-/)
  })
})

describe('the JSON shapes', () => {
  const item = document('users/u1', {
    name: { type: 'string', value: 'Ada' },
    manager: { type: 'reference', value: `${ROOT}/users/u2`, path: 'users/u2' },
    seen: { type: 'timestamp', value: '2026-01-01T00:00:00Z' },
  })

  it('reads plainly by default, the way the SDK would surface it', () => {
    expect(documentToJson(item, { format: 'json', typed: false }, ROOT)).toEqual({
      name: 'Ada',
      manager: 'users/u2',
      seen: '2026-01-01T00:00:00Z',
    })
  })

  it('keeps every type when asked, because a reference has no plain form', () => {
    const typed = documentToJson(item, { format: 'json', typed: true }, ROOT) as Record<
      string,
      unknown
    >
    expect(typed.name).toEqual({ stringValue: 'Ada' })
    expect(typed.manager).toEqual({ referenceValue: `${ROOT}/users/u2` })
    expect(typed.seen).toEqual({ timestampValue: '2026-01-01T00:00:00Z' })
  })
})

describe('the CSV', () => {
  const documents = [
    document('users/u1', {
      name: { type: 'string', value: 'Ada' },
      address: {
        type: 'map',
        fields: { city: { type: 'string', value: 'London' } },
      },
      tags: { type: 'array', items: [{ type: 'string', value: 'alpha' }] },
    }),
    document('users/u2', {
      name: { type: 'string', value: 'Grace' },
      plan: { type: 'string', value: 'pro' },
    }),
  ]

  it('flattens nested maps to dotted columns, in first-seen order', () => {
    expect(csvColumns(documents)).toEqual(['name', 'address.city', 'tags', 'plan'])
  })

  it('leaves an array in one column rather than inventing a shape for it', () => {
    const fields = { tags: ['alpha', 'beta'] }
    expect(csvCell(fields, 'tags')).toBe('["alpha","beta"]')
  })

  it('writes an empty cell where a document has no such field', () => {
    expect(csvCell({ name: 'Grace' }, 'address.city')).toBe('')
    expect(csvCell({ name: 'Grace' }, 'plan')).toBe('')
  })

  it('reads a nested value through its dotted column', () => {
    expect(csvCell({ address: { city: 'London' } }, 'address.city')).toBe('London')
  })

  it('quotes only what has to be quoted, and doubles an inner quote', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('with,comma')).toBe('"with,comma"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('two\nlines')).toBe('"two\nlines"')
  })

  it('ends every row with a newline so lines concatenate into a file', () => {
    expect(csvRow(['a', 'b'])).toBe('a,b\n')
  })
})

describe('the formats offered', () => {
  it('always resolves to one, and each carries its own media type', () => {
    expect(formatInfo('json').mediaType).toBe('application/json')
    expect(formatInfo('ndjson').mediaType).toBe('application/x-ndjson')
    expect(formatInfo('csv').mediaType).toBe('text/csv')
  })
})
