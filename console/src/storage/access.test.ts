import { describe, expect, it } from 'vitest'
import type { StorageEntry } from '@/api/generated/storage/StorageEntry'
import type { StorageListPage } from '@/api/generated/storage/StorageListPage'
import { accessGroups, mayRead } from './access'

const file = (name: string): StorageEntry => ({
  type: 'file',
  name,
  size: 1,
  contentType: null,
  contentEncoding: null,
  updated: '2026-10-01T00:00:00Z',
  timeCreated: '2026-10-01T00:00:00Z',
  generation: '1',
  tokens: 0,
  metadataKeys: [],
  metadataCount: 0,
})

function page(items: StorageEntry[]): StorageListPage {
  return {
    bucket: 'b',
    prefix: '',
    totals: { folders: 0, files: items.length, bytes: 0, filtered: false },
    placeholder: false,
    revision: 1,
    decision: null,
    stale: false,
    changesSince: 0,
    items,
    nextCursor: null,
    prevCursor: null,
    total: null,
    scanned: null,
  }
}

describe('the access check, batched', () => {
  it('asks once per page for its files, at most 200 names a request', () => {
    const big = Array.from({ length: 450 }, (_, index) => file(`f${index}`))
    const groups = accessGroups([
      page([
        file('a'),
        {
          type: 'folder',
          prefix: 'd/',
          objects: 1,
          bytes: 1,
          folders: 0,
          changedAt: null,
          empty: false,
        },
      ]),
      page(big),
    ])
    expect(groups.map((group) => group.length)).toEqual([1, 200, 200, 50])
    expect(groups[0]).toEqual(['a'])
  })

  it('draws a file as Admin, and as a client only once the rules allow it', () => {
    expect(mayRead(undefined, 'a')).toBe(true)
    const access = new Map([
      ['a', [{ method: 'get' as const, outcome: 'allow' as const, line: 4 }]],
      ['b', [{ method: 'get' as const, outcome: 'deny' as const, line: 5 }]],
    ])
    expect(mayRead(access, 'a')).toBe(true)
    expect(mayRead(access, 'b')).toBe(false)
    expect(mayRead(access, 'c')).toBeUndefined()
  })
})
