import { describe, expect, it } from 'vitest'
import {
  RESERVED_KEY,
  changeCount,
  changedFields,
  draftOf,
  draftProblems,
  fieldSuggestions,
  patchOf,
  uploadMetadataOf,
} from './metadata-draft'

const object = {
  contentType: 'image/png',
  cacheControl: 'public, max-age=3600',
  contentDisposition: null,
  contentEncoding: null,
  contentLanguage: null,
  customMetadata: { ownerUid: 'u1', source: 'camera' },
}

describe('the metadata draft', () => {
  it('starts as the object is, custom keys in order', () => {
    const draft = draftOf(object)
    expect(draft.fields.contentType).toBe('image/png')
    expect(draft.fields.contentDisposition).toBe('')
    expect(draft.custom.map((row) => [row.key, row.value])).toEqual([
      ['ownerUid', 'u1'],
      ['source', 'camera'],
    ])
  })

  it('patches only what changed, clearing an emptied field with null', () => {
    const base = draftOf(object)
    const draft = {
      ...base,
      fields: { ...base.fields, cacheControl: 'public, max-age=600', contentType: '' },
    }
    const patch = patchOf(base, draft)
    expect(patch).toEqual({ cacheControl: 'public, max-age=600', contentType: null })
    expect(changeCount(patch)).toBe(2)
    expect([...changedFields(patch)]).toEqual(['contentType', 'cacheControl'])
    expect(patchOf(base, base)).toEqual({})
  })

  it('renames a key as the old one removed and the new one set', () => {
    const base = draftOf(object)
    const draft = {
      ...base,
      custom: base.custom.map((row) => (row.key === 'source' ? { ...row, key: 'origin' } : row)),
    }
    expect(patchOf(base, draft).customMetadata).toEqual({ origin: 'camera', source: null })
    expect(changeCount(patchOf(base, draft))).toBe(2)
  })

  it('says what blocks Save on the row it is on', () => {
    const base = draftOf(object)
    const draft = {
      ...base,
      custom: [
        ...base.custom,
        { id: 'a', key: 'ownerUid', value: 'u2', enabled: true },
        { id: 'b', key: '', value: 'orphan', enabled: true },
        { id: 'c', key: RESERVED_KEY, value: 'x', enabled: true },
        { id: 'd', key: 'k'.repeat(1_025), value: 'x', enabled: true },
      ],
    }
    const problems = draftProblems(draft)
    expect(problems.get('a')).toMatch(/already a key/)
    expect(problems.get('b')).toMatch(/needs a key/)
    expect(problems.get('c')).toMatch(/Details/)
    expect(problems.get('d')).toMatch(/1,024 bytes/)
    expect(draftProblems(base).size).toBe(0)
  })

  it('carries everything into an upload of new bytes', () => {
    const base = draftOf(object)
    expect(uploadMetadataOf(base)).toEqual({
      contentType: 'image/png',
      cacheControl: 'public, max-age=3600',
      contentDisposition: undefined,
      contentEncoding: undefined,
      contentLanguage: undefined,
      customMetadata: { ownerUid: 'u1', source: 'camera' },
    })
  })

  it('suggests one list for each field wherever metadata is typed', () => {
    expect(fieldSuggestions('cacheControl')).toContain('no-store')
    expect(fieldSuggestions('contentDisposition')).toEqual(['inline', 'attachment'])
    expect(fieldSuggestions('contentEncoding')).toEqual(['gzip', 'br', 'deflate', 'identity'])
    expect(fieldSuggestions('contentLanguage')).toEqual([])
    // Without a file, the common types alone; with one, its own first.
    expect(fieldSuggestions('contentType')[0]).toBe('image/png')
    expect(
      fieldSuggestions('contentType', { name: 'notes.csv', sniffed: null }).slice(0, 2),
    ).toEqual(['text/csv', 'image/png'])
  })
})
