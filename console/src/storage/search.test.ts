import { describe, expect, it } from 'vitest'
import {
  FILES_DEFAULTS,
  bucketPatch,
  filesSearch,
  pathPatch,
  sortOf,
  storageRulesSearch,
} from './search'

describe('the Files page’s search params', () => {
  it('read every param, folders ending in one slash and empty segments kept', () => {
    expect(
      filesSearch.parse({
        bucket: 'demo-media',
        path: 'banners',
        object: 'banners/b.png',
        tab: 'metadata',
        layout: 'grid',
        sort: 'size:desc',
        q: 'type:image/*',
        flat: true,
        as: 'anonymous',
        new: 'folder',
        dialog: 'quick-look',
      }),
    ).toEqual({
      bucket: 'demo-media',
      path: 'banners/',
      object: 'banners/b.png',
      tab: 'metadata',
      layout: 'grid',
      sort: 'size:desc',
      q: 'type:image/*',
      flat: true,
      as: 'anonymous',
      new: 'folder',
      dialog: 'quick-look',
    })
    expect(filesSearch.parse({ path: 'a//' }).path).toBe('a//')
    expect(filesSearch.parse({ path: '/' }).path).toBe('/')
  })

  it('drop an order on a column the listing does not sort by', () => {
    expect(filesSearch.parse({ sort: 'metadata:asc' }).sort).toBeUndefined()
    expect(filesSearch.parse({ sort: 'size' }).sort).toBeUndefined()
    expect(filesSearch.parse({ sort: 'updated:desc' }).sort).toBe('updated:desc')
  })

  it('refuse a tab, layout or dialog the page does not have', () => {
    expect(filesSearch.safeParse({ tab: 'json' }).success).toBe(false)
    expect(filesSearch.safeParse({ layout: 'table' }).success).toBe(false)
    expect(filesSearch.safeParse({ dialog: 'look' }).success).toBe(false)
  })

  it('leave the defaults out of the address', () => {
    expect(FILES_DEFAULTS).toEqual({ tab: 'details', layout: 'list', sort: 'name:asc' })
  })

  it('clear what belonged to the old bucket and keep the rest', () => {
    expect(bucketPatch('demo-media')).toEqual({
      bucket: 'demo-media',
      path: undefined,
      object: undefined,
      q: undefined,
      flat: undefined,
      dialog: undefined,
    })
  })

  it('clear the object, filter and dialog on another folder, keeping the scope', () => {
    const patch = pathPatch('users/')
    expect(patch).toEqual({ path: 'users/', object: undefined, q: undefined, dialog: undefined })
    expect('flat' in patch).toBe(false)
    expect(pathPatch('').path).toBeUndefined()
  })

  it('read an order, name ascending when none', () => {
    expect(sortOf(undefined)).toEqual({ column: 'name', direction: 'asc' })
    expect(sortOf('size:desc')).toEqual({ column: 'size', direction: 'desc' })
    expect(sortOf('nonsense')).toEqual({ column: 'name', direction: 'asc' })
  })
})

describe('the Rules page’s search params', () => {
  it('are the rules kit’s, with the bucket as their scope and a line', () => {
    expect(
      storageRulesSearch.parse({ bucket: 'demo-media', panel: 'folders', decision: 's7', line: 6 }),
    ).toEqual({ bucket: 'demo-media', panel: 'folders', decision: 's7', line: 6 })
    expect(storageRulesSearch.safeParse({ panel: 'collections' }).success).toBe(false)
  })
})
