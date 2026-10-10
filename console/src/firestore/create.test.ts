import { describe, expect, it } from 'vitest'
import { generateId, parseImport, validateId } from './create'
import { recentsKey, useRecents } from './recents'
import { fromJson } from './value'

describe('creating documents', () => {
  it('mints auto ids like the SDKs', () => {
    const id = generateId()
    expect(id).toMatch(/^[A-Za-z0-9]{20}$/)
    expect(generateId()).not.toBe(id)
  })

  it('rejects the ids Firestore rejects', () => {
    expect(validateId('invoices', 'collection')).toBeUndefined()
    expect(validateId('', 'collection')).toMatch(/required/)
    expect(validateId('a/b', 'document')).toMatch(/slash/)
    expect(validateId('..', 'document')).toMatch(/\.\./)
    expect(validateId('__name__', 'document')).toMatch(/reserved/)
    expect(validateId('x'.repeat(1501), 'document')).toMatch(/1,500/)
  })
})

describe('importing JSON', () => {
  it('reads an object keyed by id, an array, and NDJSON', () => {
    expect(parseImport('{"a": {"x": 1}, "b": {"y": 2}}')).toEqual([
      { id: 'a', fields: { x: 1 } },
      { id: 'b', fields: { y: 2 } },
    ])
    expect(parseImport('[{"x": 1}, {"x": 2}]')).toEqual([
      { id: undefined, fields: { x: 1 } },
      { id: undefined, fields: { x: 2 } },
    ])
    expect(parseImport('{"x": 1}\n{"x": 2}\n')).toEqual([
      { id: undefined, fields: { x: 1 } },
      { id: undefined, fields: { x: 2 } },
    ])
  })

  it('says what is wrong', () => {
    expect(() => parseImport('')).toThrow(/Paste/)
    expect(() => parseImport('42')).toThrow(/Expected/)
    expect(() => parseImport('{"a": 1}')).toThrow(/fields of a/)
    expect(() => parseImport('{"x": 1}\nnope')).toThrow(/Line 2/)
  })

  it('promotes ISO 8601 strings to timestamps only when asked', () => {
    const iso = '2026-09-20T09:00:00Z'
    expect(fromJson({ at: iso })).toEqual({
      type: 'map',
      fields: { at: { type: 'string', value: iso } },
    })
    expect(fromJson({ at: iso, note: 'not 2026-09-20T09:00:00Z' }, { timestamps: true })).toEqual({
      type: 'map',
      fields: {
        at: { type: 'timestamp', value: '2026-09-20T09:00:00.000Z' },
        note: { type: 'string', value: 'not 2026-09-20T09:00:00Z' },
      },
    })
  })
})

describe('recent paths', () => {
  it('keeps the latest twelve per database, newest first, without duplicates', () => {
    const store = useRecents.getState()
    store.load(recentsKey('demo', '(default)'))
    for (let index = 0; index < 14; index += 1) store.record(`c${index}`, 'collection')
    store.record('c3', 'document')
    const items = useRecents.getState().items
    expect(items).toHaveLength(12)
    expect(items[0]).toMatchObject({ path: 'c3', kind: 'document' })
    expect(items.filter((item) => item.path === 'c3')).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem(recentsKey('demo', '(default)')) ?? '[]')).toHaveLength(
      12,
    )
  })
})
