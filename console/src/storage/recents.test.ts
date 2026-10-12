import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECENTS_LIMIT, recentsKey, useStorageRecents, withRecent } from './recents'

describe('recents per project and bucket', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    useStorageRecents.setState({ key: '', items: [] })
    localStorage.clear()
  })

  it('keeps twelve, the most recent first, each once', () => {
    let items = withRecent([], 'a/', 'folder', 1)
    for (let index = 0; index < 20; index += 1)
      items = withRecent(items, `f${index}`, 'file', index)
    expect(items).toHaveLength(RECENTS_LIMIT)
    expect(items[0]?.path).toBe('f19')
    items = withRecent(items, 'f15', 'file', 99)
    expect(items[0]).toEqual({ path: 'f15', kind: 'file', at: 99 })
    expect(items.filter((item) => item.path === 'f15')).toHaveLength(1)
  })

  it('remembers them in this browser under the project and bucket', () => {
    const key = recentsKey('demo', 'demo.appspot.com')
    expect(key).toBe('firenook.console.storage-recents.demo.demo.appspot.com')
    useStorageRecents.getState().load(key)
    useStorageRecents.getState().record('users/', 'folder')
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
    useStorageRecents.getState().record('x.png', 'file')
    expect(useStorageRecents.getState().items.map((item) => item.path)).toEqual(['x.png'])
  })
})
