import { afterEach, describe, expect, it, vi } from 'vitest'
import { withRecent } from '@/lib/recents'
import { RECENTS_LIMIT, type StorageRecent, recentsKey, useStorageRecents } from './recents'

const options = {
  limit: RECENTS_LIMIT,
  same: (a: { path: string }, b: { path: string }) => a.path === b.path,
}

describe('recents per project and bucket', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    useStorageRecents.setState({ key: '', items: [] })
    localStorage.clear()
  })

  it('keeps twelve, the most recent first, each once', () => {
    let items = withRecent<StorageRecent>([], { path: 'a/', kind: 'folder' }, 1, options)
    for (let index = 0; index < 20; index += 1)
      items = withRecent(items, { path: `f${index}`, kind: 'file' }, index, options)
    expect(items).toHaveLength(RECENTS_LIMIT)
    expect(items[0]?.path).toBe('f19')
    items = withRecent(items, { path: 'f15', kind: 'file' }, 99, options)
    expect(items[0]).toEqual({ path: 'f15', kind: 'file', at: 99 })
    expect(items.filter((item) => item.path === 'f15')).toHaveLength(1)
  })

  it('remembers them in this browser under the project and bucket', () => {
    const key = recentsKey('demo', 'demo.appspot.com')
    expect(key).toBe('firenook.console.storage-recents.demo.demo.appspot.com')
    useStorageRecents.getState().load(key)
    useStorageRecents.getState().record({ path: 'users/', kind: 'folder' })
    useStorageRecents.setState({ key: '', items: [] })
    useStorageRecents.getState().load(key)
    expect(useStorageRecents.getState().items.map((item) => item.path)).toEqual(['users/'])
  })

  it('works for the page alone when storage refuses', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    useStorageRecents.getState().load('k')
    useStorageRecents.getState().record({ path: 'x.png', kind: 'file' })
    expect(useStorageRecents.getState().items.map((item) => item.path)).toEqual(['x.png'])
  })
})
