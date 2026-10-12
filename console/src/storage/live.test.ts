import type { QueryKey } from '@tanstack/react-query'
import { hashKey } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StorageObjectsChanged } from '@/api/generated/storage/StorageObjectsChanged'
import { resumeOf } from '@/lib/live/topics'
import { createInvalidator } from '@/lib/live/use-live-topic'
import { THROTTLE_MS, invalidationKeys, resetsList, touchedCount, touchedRows } from './live'
import { storageKeys } from './queries'

afterEach(() => vi.useRealTimers())

function batch(names: string[], extra: Partial<StorageObjectsChanged> = {}): StorageObjectsChanged {
  return {
    revision: 9,
    changes: names.map((name) => ({ name, kind: 'created' })),
    folders: [],
    truncated: false,
    sessions: [],
    indexReady: false,
    ...extra,
  }
}

const has = (keys: QueryKey[], key: QueryKey) => keys.some((item) => hashKey(item) === hashKey(key))

describe('the storage topics', () => {
  it('resume as the engine serves them', () => {
    expect(resumeOf('storage.objects')).toBe('replay')
    expect(resumeOf('storage.rules')).toBe('compare')
    expect(resumeOf('storage.decisions')).toBe('replay')
  })
})

describe('the rows a window touched', () => {
  const window = batch([
    'users/u1/avatar.png',
    'users/top.txt',
    'users/u1/bio.md',
    'public/logo.png',
    'users/',
    'users/drafts/',
  ])

  it('in a folder: the file itself, or the subfolder holding it, each once', () => {
    expect(touchedRows(window, { prefix: 'users/', flat: false })).toEqual([
      'users/u1/',
      'users/top.txt',
      'users/drafts/',
    ])
    expect(touchedRows(window, { prefix: '', flat: false })).toEqual(['users/', 'public/'])
  })

  it('only the kind the list shows', () => {
    expect(touchedRows(window, { prefix: 'users/', flat: false, kind: 'folders' })).toEqual([
      'users/u1/',
      'users/drafts/',
    ])
    expect(touchedRows(window, { prefix: 'users/', flat: false, kind: 'files' })).toEqual([
      'users/top.txt',
    ])
  })

  it('everything under a folder, without markers, in a flat list', () => {
    expect(touchedRows(window, { prefix: 'users/', flat: true })).toEqual([
      'users/u1/avatar.png',
      'users/top.txt',
      'users/u1/bio.md',
    ])
  })

  it('keeps empty segments as folders of their own', () => {
    expect(
      touchedRows(batch(['misc//double.png', '/lead.png']), { prefix: '', flat: false }),
    ).toEqual(['misc/', '/'])
    expect(touchedRows(batch(['misc//double.png']), { prefix: 'misc/', flat: false })).toEqual([
      'misc//',
    ])
  })

  it('counts the names inside a view’s scope, for its stale count', () => {
    expect(touchedCount(window, { prefix: 'users/', flat: false })).toBe(4)
    expect(touchedCount(window, { prefix: '', flat: true })).toBe(6)
  })

  it('starts a list again under a window too big to list', () => {
    const big = batch([], { truncated: true, folders: ['users/u1/'] })
    expect(resetsList(big, { prefix: 'users/', flat: false })).toBe(true)
    expect(resetsList(big, { prefix: 'users/u1/photos/', flat: false })).toBe(true)
    expect(resetsList(big, { prefix: 'public/', flat: false })).toBe(false)
    expect(
      resetsList(batch([], { truncated: true, folders: [''] }), { prefix: 'public/', flat: true }),
    ).toBe(true)
    expect(resetsList(window, { prefix: 'users/', flat: false })).toBe(false)
  })
})

describe('what a window refreshes besides the lists', () => {
  it('the buckets, every folder the names sit in, the objects themselves and the access checks', () => {
    const keys = invalidationKeys('demo', 'b', batch(['users/u1/avatar.png']))
    expect(has(keys, storageKeys.buckets('demo'))).toBe(true)
    for (const folder of ['', 'users/', 'users/u1/']) {
      expect(has(keys, storageKeys.folder('demo', 'b', folder))).toBe(true)
      expect(has(keys, storageKeys.tree('demo', 'b', folder))).toBe(true)
      expect(has(keys, storageKeys.profile('demo', 'b', folder))).toBe(true)
    }
    expect(has(keys, storageKeys.objectAnyone('demo', 'b', 'users/u1/avatar.png'))).toBe(true)
    expect(has(keys, storageKeys.activity('demo', 'b', 'users/u1/avatar.png'))).toBe(true)
    expect(has(keys, storageKeys.eventsOf('demo', 'b', 'users/u1/avatar.png'))).toBe(true)
    expect(has(keys, storageKeys.accessOf('demo', 'b'))).toBe(true)
    expect(has(keys, storageKeys.sessions('demo', 'b'))).toBe(false)
  })

  it('the sessions when an upload session moved, and the counts once the index is built', () => {
    const keys = invalidationKeys('demo', 'b', batch([], { sessions: ['s1'], indexReady: true }))
    expect(has(keys, storageKeys.sessions('demo', 'b'))).toBe(true)
    expect(has(keys, storageKeys.objectsOf('demo', 'b'))).toBe(true)
    expect(has(keys, storageKeys.foldersOf('demo', 'b'))).toBe(true)
    expect(has(keys, storageKeys.treeOf('demo', 'b'))).toBe(true)
  })

  it('whole kinds of the bucket under a window too big to list', () => {
    const keys = invalidationKeys('demo', 'b', batch([], { truncated: true, folders: ['users/'] }))
    expect(has(keys, storageKeys.foldersOf('demo', 'b'))).toBe(true)
    expect(has(keys, storageKeys.treeOf('demo', 'b'))).toBe(true)
    expect(has(keys, [...storageKeys.bucket('demo', 'b'), 'object'])).toBe(true)
  })

  it('a folder at most once per 250 ms under a sustained burst, and once after the last window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const folder = storageKeys.folder('demo', 'b', 'users/')
    const refreshed: number[] = []
    const throttle = createInvalidator((key) => {
      if (hashKey(key) === hashKey(folder)) refreshed.push(Date.now())
    }, THROTTLE_MS)
    // A window every 100 ms for 5 s, each touching a new file under users/.
    let last = 0
    for (let index = 0; index < 50; index += 1) {
      last = Date.now()
      throttle.push(invalidationKeys('demo', 'b', batch([`users/f${index}.png`])))
      vi.advanceTimersByTime(100)
    }
    vi.advanceTimersByTime(THROTTLE_MS * 4)
    expect(refreshed.length).toBeGreaterThanOrEqual(15)
    expect(refreshed.length).toBeLessThanOrEqual(21)
    // The first window refreshes at once; the last one's refresh comes after it.
    expect(refreshed[0]).toBe(0)
    expect(refreshed.at(-1)).toBeGreaterThan(last)
    throttle.dispose()
  })
})
