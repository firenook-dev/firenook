import { describe, expect, it } from 'vitest'
import { generateId, parseImport, validateId } from './create'
import { draftsFromJson, draftsToJson } from './components/field-editor'
import { inferScalar } from './components/inline-cell-editor'
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

describe('field drafts and JSON', () => {
  it('round-trips drafts through JSON and keeps types JSON cannot express', () => {
    const drafts = [
      { name: 'at', type: 'timestamp' as const, text: '2026-09-20T09:00:00.000Z', dirty: false },
      { name: 'ref', type: 'reference' as const, text: 'users/u1', dirty: false },
      { name: 'n', type: 'number' as const, text: '3', dirty: false },
    ]
    const json = draftsToJson(drafts)
    expect(json).toEqual({ at: '2026-09-20T09:00:00.000Z', ref: 'users/u1', n: 3 })
    const back = draftsFromJson(JSON.stringify({ ...json, n: 4, extra: true }), drafts)
    expect(back.drafts.map((draft) => [draft.name, draft.type, draft.dirty])).toEqual([
      ['at', 'timestamp', false],
      ['ref', 'reference', false],
      ['n', 'number', true],
      ['extra', 'boolean', true],
    ])
    expect(back.gone).toEqual([])
    expect(draftsFromJson('{"at": "2026-09-20T09:00:00.000Z"}', drafts).gone).toEqual(['ref', 'n'])
    expect(() => draftsFromJson('[1]', drafts)).toThrow(/object/)
  })

  it('infers a scalar type for a cell with no type yet', () => {
    expect(inferScalar('true')).toEqual({ type: 'boolean', value: true })
    expect(inferScalar('12')).toEqual({ type: 'number', value: 12, integer: true })
    expect(inferScalar('1.5')).toEqual({ type: 'number', value: 1.5, integer: false })
    expect(inferScalar('null')).toEqual({ type: 'null' })
    expect(inferScalar('2026-09-20T09:00:00Z')).toEqual({
      type: 'timestamp',
      value: '2026-09-20T09:00:00.000Z',
    })
    expect(inferScalar('hello 12')).toEqual({ type: 'string', value: 'hello 12' })
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
