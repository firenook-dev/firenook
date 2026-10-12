import { describe, expect, it } from 'vitest'
import type { StorageProfile } from '@/api/generated/storage/StorageProfile'
import { type GoldenFile, runGoldenCases } from '@/lib/filter-golden'
import cases from './filter-cases.json'
import { STORAGE_FILTER_FIELDS, filterFields, typeSuggestions } from './filter'

describe('Storage’s filter fields, held to the engine’s cases', () => {
  it('declare exactly the fields the cases file holds', () => {
    expect(STORAGE_FILTER_FIELDS).toEqual(cases.fields)
  })
  runGoldenCases({
    ...(cases as unknown as GoldenFile),
    fields: STORAGE_FILTER_FIELDS as unknown as GoldenFile['fields'],
  })
})

const profile: StorageProfile = {
  bucket: 'b',
  prefix: '',
  objects: 4,
  bytes: 10,
  maxSize: 5,
  typicalSize: 4,
  contentTypes: [
    { contentType: 'image/png', objects: 2, bytes: 4 },
    { contentType: 'image/jpeg', objects: 1, bytes: 3 },
    { contentType: 'text/csv', objects: 1, bytes: 3 },
  ],
  metadataKeys: ['ownerUid', 'source'],
  childFolders: [],
  sampled: false,
}

describe('what the filter completes from the folder', () => {
  it('offers a family before its types when it holds more than one', () => {
    expect(typeSuggestions(profile, '')).toEqual(['image/*', 'image/png', 'image/jpeg', 'text/csv'])
    expect(typeSuggestions(profile, 'te')).toEqual(['text/csv'])
    expect(typeSuggestions(undefined, '')).toEqual([])
  })

  it('suggests the folder’s custom keys after meta.', async () => {
    const meta = filterFields(undefined, profile).find((field) => field.key === 'meta')
    expect(await meta?.suggest?.('own')).toEqual(['ownerUid'])
  })
})
