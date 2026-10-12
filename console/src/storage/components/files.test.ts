import { describe, expect, it } from 'vitest'
import type { StorageBucket } from '@/api/generated/storage/StorageBucket'
import type { StorageEntry } from '@/api/generated/storage/StorageEntry'
import type { StorageFolderEntry } from '@/api/generated/storage/StorageFolderEntry'
import { bucketFigures } from './bucket-picker'
import { gridGeometry } from './file-grid'
import { fileRows, metadataPreview, rowRead } from './file-list'
import { folderLabel, folderTitle } from './folder-tree'
import { bucketNameProblem } from './open-bucket-dialog'
import { pictureUrl } from './thumbnail'

const folder: StorageFolderEntry = {
  prefix: 'users/',
  objects: 900,
  bytes: 20 * 1024 * 1024,
  folders: 120,
  changedAt: '2026-10-12T09:57:00Z',
  empty: false,
}

describe('the folder tree', () => {
  it('names a folder by its last segment, an empty one as (empty)', () => {
    expect(folderLabel('users/u1/')).toBe('u1')
    expect(folderLabel('a//')).toBe('(empty)')
  })

  it('says what is under a folder in its tooltip', () => {
    expect(folderTitle(folder, Date.parse('2026-10-12T10:00:00Z'))).toBe(
      'users/ · 900 files · 20.0 MB · 120 folders · last change 3 min ago',
    )
    expect(folderTitle({ ...folder, objects: null })).toBe('users/ · counting what is under it')
  })
})

describe('the bucket picker', () => {
  const bucket: StorageBucket = {
    name: 'demo.appspot.com',
    isDefault: true,
    configured: true,
    served: true,
    rulesFile: 'storage.rules',
    objects: 1204,
    bytes: 38 * 1024 * 1024,
    inFlight: { uploads: 0, bytes: 0 },
  }

  it('gives each bucket its figures, the bytes in flight and whether rules serve it', () => {
    expect(bucketFigures(bucket)).toBe('default · 1,204 · 38.0 MB')
    expect(
      bucketFigures({
        ...bucket,
        isDefault: false,
        served: false,
        objects: null,
        inFlight: { uploads: 1, bytes: 48 * 1024 * 1024 },
      }),
    ).toBe('— · 48.0 MB in flight · no rules')
  })

  it('accepts only names a bucket can have', () => {
    expect(bucketNameProblem('demo-media')).toBeUndefined()
    expect(bucketNameProblem('')).toBeUndefined()
    expect(bucketNameProblem('ab')).toMatch(/3 to 222/)
    expect(bucketNameProblem('Upper')).toMatch(/lowercase/)
  })
})

const file: StorageEntry = {
  type: 'file',
  name: 'users/u1/avatar.png',
  size: 2_519_221,
  contentType: 'image/png',
  contentEncoding: null,
  updated: '2026-10-01T00:00:00Z',
  timeCreated: '2026-10-01T00:00:00Z',
  generation: '7',
  tokens: 1,
  metadataKeys: ['ownerUid', 'source', 'x'],
  metadataCount: 3,
}

const lineText = () => undefined

describe('the list', () => {
  it('previews custom keys as a container does', () => {
    expect(metadataPreview(['ownerUid', 'source'], 3)).toBe('{ ownerUid, +2 }')
    expect(metadataPreview(['ownerUid'], 1)).toBe('{ ownerUid }')
    expect(metadataPreview([], 0)).toBe('')
  })

  it('names rows relative to the folder in a flat listing', () => {
    const [row] = fileRows([file], {
      prefix: 'users/',
      flat: true,
      access: undefined,
      lineText: () => undefined,
    })
    expect(row?.label).toBe('u1/avatar.png')
    expect(row?.key).toBe('users/u1/avatar.png')
    expect(row && rowRead(row)).toBe(true)
  })

  it('draws a client’s row only once the rules allow it', () => {
    const [pending] = fileRows([file], { prefix: '', flat: false, access: new Map(), lineText })
    expect(pending && rowRead(pending)).toBeUndefined()
    const [refused] = fileRows([file], {
      prefix: '',
      flat: false,
      access: new Map([
        [file.name, [{ method: 'get' as const, outcome: 'deny' as const, line: 5 }]],
      ]),
      lineText,
    })
    expect(refused && rowRead(refused)).toBe(false)
  })
})

describe('the grid', () => {
  it('fits as many 176 px columns as the width allows', () => {
    expect(gridGeometry(1000).columns).toBe(5)
    expect(gridGeometry(200).columns).toBe(1)
    const { tile, row } = gridGeometry(1000)
    expect(row).toBe(Math.round((tile * 3) / 4) + 1 + 46 + 8)
  })

  it('draws small images and SVGs as they are and thumbnails the rest', () => {
    expect(pictureUrl('b', { ...file, size: 1000 })).toContain('/storage/object/media?')
    expect(pictureUrl('b', { ...file, contentType: 'image/svg+xml' })).toContain('/object/media?')
    expect(pictureUrl('b', file)).toContain('/storage/object/thumbnail?')
    expect(pictureUrl('b', file)).toContain('w=320')
    expect(
      pictureUrl('b', { ...file, contentType: 'application/json', name: 'a.json' }),
    ).toBeUndefined()
  })
})
