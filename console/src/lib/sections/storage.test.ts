import { describe, expect, it } from 'vitest'
import { shownPages } from '../services'
import { storage } from './storage'

const storageRoute = (kind: string, key: string) => storage.routes?.[kind]?.(key)

describe('where Storage things open', () => {
  it('an object in its folder with the inspector open on it, empty segments kept', () => {
    expect(storageRoute('storage.object', 'demo.appspot.com|users/u1/avatar.png')).toEqual({
      to: '/storage',
      search: { bucket: 'demo.appspot.com', path: 'users/u1/', object: 'users/u1/avatar.png' },
    })
    expect(storageRoute('storage.object', 'demo-media|a//b|c.png')).toEqual({
      to: '/storage',
      search: { bucket: 'demo-media', path: 'a//', object: 'a//b|c.png' },
    })
    expect(storageRoute('storage.object', 'demo-media|top.png')).toEqual({
      to: '/storage',
      search: { bucket: 'demo-media', path: undefined, object: 'top.png' },
    })
  })

  it('a folder at its path, the root as no path', () => {
    expect(storageRoute('storage.folder', 'demo-media|banners/')).toEqual({
      to: '/storage',
      search: { bucket: 'demo-media', path: 'banners/' },
    })
    expect(storageRoute('storage.folder', 'demo-media|')).toEqual({
      to: '/storage',
      search: { bucket: 'demo-media', path: undefined },
    })
  })

  it('a rules decision on the rules page, single-file mode naming no bucket', () => {
    expect(storageRoute('storage.decision', '*|s1834')).toEqual({
      to: '/storage/rules',
      search: { bucket: undefined, panel: 'decisions', decision: 's1834' },
    })
    expect(storageRoute('storage.decision', 'demo-media|s7')).toEqual({
      to: '/storage/rules',
      search: { bucket: 'demo-media', panel: 'decisions', decision: 's7' },
    })
  })

  it('lists Files and Rules, the rules page carrying the rules badge', () => {
    expect(storage.pages?.map((page) => [page.to, page.label])).toEqual([
      ['/storage', 'Files'],
      ['/storage/rules', 'Rules'],
    ])
    expect(storage.pages?.[0]?.exact).toBe(true)
    expect(storage.pages?.[1]?.badges).toEqual(['storage.rules'])
  })

  it('stays unbuilt until its journeys pass, so the nav shows none of its pages yet', () => {
    expect(storage.built).toBe(false)
    expect(shownPages(storage)).toBeUndefined()
    expect(storage.projectScope).toBeUndefined()
  })
})
