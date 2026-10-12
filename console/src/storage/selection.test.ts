import { beforeEach, describe, expect, it } from 'vitest'
import type { StorageEntry } from '@/api/generated/storage/StorageEntry'
import {
  resetFileSelection,
  selectionFigures,
  selectionTarget,
  useFileSelection,
} from './selection'

const file = (name: string, size: number): StorageEntry => ({
  type: 'file',
  name,
  size,
  contentType: null,
  contentEncoding: null,
  updated: '2026-10-01T00:00:00Z',
  timeCreated: '2026-10-01T00:00:00Z',
  generation: '1',
  tokens: 1,
  metadataKeys: [],
  metadataCount: 0,
})
const folder = (prefix: string, bytes: number | null): StorageEntry => ({
  type: 'folder',
  prefix,
  objects: bytes === null ? null : 3,
  bytes,
  folders: 0,
  changedAt: null,
  empty: false,
})

describe('what a selection reaches', () => {
  beforeEach(() => useFileSelection.setState({ scope: '', checked: new Set(), everything: false }))

  it('names the ticked keys, or the listing itself for everything it matches', () => {
    const scope = { bucket: 'b', prefix: 'users/', flat: true, q: 'type:image/*' }
    expect(selectionTarget(new Set(['users/a.png', 'users/u1/']), false, scope)).toEqual({
      by: 'keys',
      keys: ['users/a.png', 'users/u1/'],
    })
    expect(selectionTarget(new Set(['users/a.png']), true, scope)).toEqual({
      by: 'query',
      q: 'type:image/*',
      scope: { bucket: 'b', prefix: 'users/', flat: true },
    })
  })

  it('adds up what the ticked rows hold, unknown while a folder is still counted', () => {
    const rows = [file('a.png', 10), file('b.png', 5), folder('u1/', 100), folder('u2/', null)]
    expect(selectionFigures(rows, new Set(['a.png', 'u1/']))).toEqual({
      files: 1,
      folders: 1,
      bytes: 110,
      bytesKnown: true,
    })
    expect(selectionFigures(rows, new Set(['u2/'])).bytesKnown).toBe(false)
  })

  it('lets the ticks go when the listing changes', () => {
    resetFileSelection('b|users/')
    useFileSelection.getState().set(new Set(['users/a.png']), true)
    resetFileSelection('b|users/')
    expect(useFileSelection.getState().checked.size).toBe(1)
    resetFileSelection('b|public/')
    expect(useFileSelection.getState()).toMatchObject({ checked: new Set(), everything: false })
  })
})
