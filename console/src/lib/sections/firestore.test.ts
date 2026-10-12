import { describe, expect, it } from 'vitest'
import { firestore } from './firestore'

const route = (kind: string, key: string) => firestore.routes?.[kind]?.(key)

describe('where a refused list opens', () => {
  it('a collection group opens as the group of its collection id', () => {
    expect(route('firestore.collection', '(default)|**/orders')).toEqual({
      to: '/firestore',
      search: { db: undefined, path: 'orders', group: true },
    })
    // The page's group runs from the root: one scoped under a document
    // opens the whole group.
    expect(route('firestore.collection', 'shop|users/u_1/**/orders')).toEqual({
      to: '/firestore',
      search: { db: 'shop', path: 'orders', group: true },
    })
  })

  it('a collection path or a schema pattern opens as it is', () => {
    expect(route('firestore.collection', '(default)|users/u_1/orders')).toEqual({
      to: '/firestore',
      search: { db: undefined, path: 'users/u_1/orders' },
    })
    expect(route('firestore.collection', '(default)|users/*/orders')).toEqual({
      to: '/firestore',
      search: { db: undefined, path: 'users/*/orders' },
    })
    // A wildcard that is not the group's (malformed) is passed through.
    expect(route('firestore.collection', '(default)|**')).toEqual({
      to: '/firestore',
      search: { db: undefined, path: '**' },
    })
  })
})
