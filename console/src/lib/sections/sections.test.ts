import { describe, expect, it } from 'vitest'
import { firestore } from './firestore'
import { parentPath, splitKey } from './keys'
import { linkToLogs } from './logs'

describe('entity keys', () => {
  it('split at the first bar, so the last part may hold one', () => {
    expect(splitKey('(default)|users/u1')).toEqual(['(default)', 'users/u1'])
    expect(splitKey('demo.appspot.com|a|b.png')).toEqual(['demo.appspot.com', 'a|b.png'])
    expect(splitKey('|u_9f3k2')).toEqual(['', 'u_9f3k2'])
  })

  it('split a task at its first three bars', () => {
    expect(splitKey('demo|us-central1|mail|t|1', 4)).toEqual(['demo', 'us-central1', 'mail', 't|1'])
    expect(splitKey('demo|us-central1', 4)).toEqual(['demo', 'us-central1'])
  })

  it('name a document’s parent collection', () => {
    expect(parentPath('users/u1/orders/o1')).toBe('users/u1/orders')
    expect(parentPath('users/u1')).toBe('users')
  })
})

const route = (kind: string, key: string) => firestore.routes?.[kind]?.(key)

describe('where Firestore things open', () => {
  it('a collection at its path, the default database left out of the link', () => {
    expect(route('firestore.collection', '(default)|users/*/orders')).toEqual({
      to: '/firestore',
      search: { db: undefined, path: 'users/*/orders' },
    })
    expect(route('firestore.collection', 'orders-db|products')).toEqual({
      to: '/firestore',
      search: { db: 'orders-db', path: 'products' },
    })
  })

  it('a document in its collection with the inspector open on it', () => {
    expect(route('firestore.document', '(default)|users/u1/orders/o|1')).toEqual({
      to: '/firestore',
      search: { db: undefined, path: 'users/u1/orders', doc: 'users/u1/orders/o|1' },
    })
  })

  it('a rules decision on the rules page', () => {
    expect(route('firestore.decision', '(default)|r-42')).toEqual({
      to: '/firestore/rules',
      search: { db: undefined, panel: 'decisions', decision: 'r-42' },
    })
  })

  it('pre-lists the denials badge on the rules page and offers no search row', () => {
    expect(firestore.pages?.[1]?.badges).toEqual(['firestore.rules', 'firestore.denials'])
    expect(firestore.searchLink).toBeNull()
  })
})

describe('links into Logs', () => {
  it('write q with the canonical keys, in order, and pass the rest as params', () => {
    expect(
      linkToLogs({
        level: 'error',
        function: 'us-central1-hello',
        execution: 'e1',
        since: 'c9',
        from: '-1h',
      }),
    ).toEqual({
      to: '/logs',
      search: {
        q: 'function:us-central1-hello execution:e1 level:error',
        from: '-1h',
        since: 'c9',
      },
    })
  })

  it('quote a value the grammar would split, and drop empty fields', () => {
    expect(linkToLogs({ service: 'my service', instance: '', entry: 'x' })).toEqual({
      to: '/logs',
      search: { q: 'service:"my service"', entry: 'x' },
    })
    expect(linkToLogs({ function: 'say "hi"' }).search?.q).toBe('function:"say \\"hi\\""')
  })

  it('leads to Logs itself when nothing is asked for', () => {
    expect(linkToLogs({})).toEqual({ to: '/logs' })
  })
})
