import { describe, expect, it } from 'vitest'
import { formatBytes } from '@/lib/format'
import { folderCompletions } from './folder-field'
import { decisionParams, emptyText, rowExtras } from './decisions'
import { storageRulesSearch } from './rules-search'

describe('narrowing the decisions', () => {
  it('becomes the topic’s parameters, which the engine evaluates; absent filters are left out', () => {
    expect(decisionParams('demo.appspot.com', {})).toEqual({ bucket: 'demo.appspot.com' })
    expect(decisionParams(undefined, {})).toEqual({})
    expect(
      decisionParams('b', { path: 'users/', uid: 'u1', denied: true, method: 'create' }),
    ).toEqual({ bucket: 'b', path: 'users/', uid: 'u1', denied: true, method: 'create' })
    // An exact name is a value like any other: the engine tells a folder by its slash.
    expect(decisionParams('b', { path: 'users/u1/a.png', denied: false, uid: '' })).toEqual({
      bucket: 'b',
      path: 'users/u1/a.png',
    })
  })

  it('is the rules kit’s schema, with the bucket and a line', () => {
    expect(
      storageRulesSearch.parse({
        bucket: 'demo-media',
        panel: 'folders',
        path: 'users/',
        denied: true,
        method: 'list',
        line: 6,
      }),
    ).toEqual({
      bucket: 'demo-media',
      panel: 'folders',
      path: 'users/',
      denied: true,
      method: 'list',
      line: 6,
    })
    expect(storageRulesSearch.safeParse({ panel: 'collections' }).success).toBe(false)
    expect(storageRulesSearch.safeParse({ line: 0 }).success).toBe(false)
  })
})

describe('a Storage decision’s row', () => {
  it('names another bucket, and what an upload proposed', () => {
    const decision = { bucket: 'demo-media', size: 7_340_032, contentType: 'video/quicktime' }
    const proposed = `${formatBytes(7_340_032)} video/quicktime`
    expect(rowExtras(decision, 'demo.appspot.com')).toEqual(['gs://demo-media', proposed])
    expect(rowExtras({ ...decision, bucket: 'demo.appspot.com' }, 'demo.appspot.com')).toEqual([
      proposed,
    ])
    expect(rowExtras({ bucket: 'b', size: null, contentType: null }, undefined)).toEqual([])
  })

  it('says why an empty list is empty', () => {
    expect(emptyText(true)).toContain('only client requests appear here')
    expect(emptyText(false)).toContain('No rules govern this bucket')
  })
})

describe('folder completion', () => {
  it('offers the folders under what is typed that continue it', () => {
    const children = ['u_ada', 'u_grace', 'public', 'U_Upper']
    expect(folderCompletions('users/u_', children)).toEqual([
      'users/u_ada/',
      'users/u_grace/',
      'users/U_Upper/',
    ])
    expect(folderCompletions('pu', children)).toEqual(['public/'])
    // Typed up to a slash: the folders inside it.
    expect(folderCompletions('users/', ['u_ada'])).toEqual(['users/u_ada/'])
  })
})
