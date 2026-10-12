import { describe, expect, it } from 'vitest'
import type { ChangeBatch } from '@/api/generated/ChangeBatch'
import { inferColumns } from './columns'
import { patchPages, queryFields, scopesTouched, staleQuery, useLive } from './live'
import { FS } from './queries'
import type { FsDocument } from './value'

const batch = (changes: ChangeBatch['changes'], extra: Partial<ChangeBatch> = {}): ChangeBatch => ({
  revision: 9,
  commitTime: '2026-09-20T09:00:00Z',
  changes,
  ...extra,
})

describe('the live channel', () => {
  it('maps a window of commits to the query scopes it makes stale', () => {
    const touched = scopesTouched([
      batch([
        { database: '(default)', path: 'users/u1', kind: 'updated' },
        { database: '(default)', path: 'users/u1/orders/o1', kind: 'created' },
      ]),
    ])
    expect([...touched.collections]).toEqual(['users/u1/orders'])
    expect([...touched.updated]).toEqual(['users/u1'])
    expect([...touched.documents]).toEqual(['users/u1', 'users/u1/orders/o1'])
    expect([...touched.parents]).toEqual(['users/u1'])
    expect(touched.structural).toBe(true)
  })

  it('refetches the window for a create rather than patching an update beside it', () => {
    const touched = scopesTouched([
      batch([{ database: '(default)', path: 'users/u1', kind: 'updated' }]),
      batch([{ database: '(default)', path: 'users/u2', kind: 'created' }]),
    ])
    expect([...touched.collections]).toEqual(['users'])
    expect(touched.updated.size).toBe(0)
  })

  it('treats a truncated commit as every page of the collections it names', () => {
    const touched = scopesTouched([
      batch([], {
        truncated: true,
        collections: [{ database: '(default)', path: 'teams/t1/members' }],
      }),
    ])
    expect([...touched.collections]).toEqual(['teams/t1/members'])
    expect([...touched.parents]).toEqual(['teams/t1'])
    const stale = staleQuery('(default)', touched)
    expect(stale([FS, '(default)', 'page', 'teams/t1/members', false, '', ''])).toBe(true)
    expect(stale([FS, '(default)', 'page', 'members', true, '', ''])).toBe(true)
    expect(stale([FS, '(default)', 'doc', 'teams/t1/members/m9', ''])).toBe(true)
    expect(stale([FS, '(default)', 'subcollections', 'teams/t1', ''])).toBe(true)
  })

  it('leaves the pages an update can patch alone, but refreshes filtered counts and the document', () => {
    const stale = staleQuery(
      '(default)',
      scopesTouched([batch([{ database: '(default)', path: 'users/u1', kind: 'updated' }])]),
    )
    expect(stale([FS, '(default)', 'page', 'users', false, '', ''])).toBe(false)
    expect(stale([FS, '(default)', 'count', 'users', false, 'limit(1)', ''])).toBe(false)
    expect(
      stale([FS, '(default)', 'count', 'users', false, 'where("plan", "==", "pro").limit(1)', '']),
    ).toBe(true)
    expect(stale([FS, '(default)', 'doc', 'users/u1', ''])).toBe(true)
    expect(stale([FS, '(default)', 'schema', ''])).toBe(false)
    expect(stale([FS, 'other', 'doc', 'users/u1', ''])).toBe(false)
  })

  it('patches a page in place and drops a document that is gone', () => {
    const first = document('users/a', { plan: { type: 'string', value: 'free' } })
    const second = document('users/b', { plan: { type: 'string', value: 'free' } })
    const untouched = { documents: [document('users/z', {})], readTime: 't' }
    const data = {
      pages: [{ documents: [first, second], readTime: 't' }, untouched],
      pageParams: [undefined, undefined],
    }
    const renamed = document('users/a', {
      plan: { type: 'string', value: 'free' },
      name: { type: 'string', value: 'Ada' },
    })
    const patched = patchPages(
      data,
      new Set(['users/a', 'users/b']),
      new Map([['users/a', renamed]]),
      ['plan'],
    )
    expect(patched?.pages[0]?.documents).toEqual([renamed])
    // A page with nothing touched keeps its identity, so its rows do not re-render.
    expect(patched?.pages[1]).toBe(untouched)
  })

  it('refuses to patch a document that moved on a field the query reads', () => {
    const before = document('users/a', { plan: { type: 'string', value: 'free' } })
    const after = document('users/a', { plan: { type: 'string', value: 'pro' } })
    const data = { pages: [{ documents: [before], readTime: 't' }], pageParams: [undefined] }
    expect(
      patchPages(data, new Set(['users/a']), new Map([['users/a', after]]), ['plan']),
    ).toBeUndefined()
    expect(queryFields('where("plan", "==", "pro").orderBy("lastSeen", "desc")')).toEqual([
      'plan',
      'lastSeen',
    ])
    expect(queryFields('')).toEqual([])
  })

  it('flashes changed rows and expires them', () => {
    useLive
      .getState()
      .recordBatch(batch([{ database: '(default)', path: 'users/u1', kind: 'deleted' }]))
    expect(useLive.getState().flashes.get('users/u1')?.kind).toBe('deleted')
    useLive.getState().expireFlashes(Date.now() + 1)
    expect(useLive.getState().flashes.size).toBe(0)
  })
})

const document = (path: string, fields: FsDocument['fields']): FsDocument => ({
  path,
  id: path.split('/').at(-1) ?? path,
  collection: 'events',
  fields,
})

describe('column inference', () => {
  it('orders columns by how many documents carry them and flags mixed types', () => {
    const columns = inferColumns([
      document('events/a', {
        type: { type: 'string', value: 'x' },
        createdAt: { type: 'timestamp', value: '2026-09-20T09:00:00Z' },
      }),
      document('events/b', {
        type: { type: 'string', value: 'y' },
        createdAt: { type: 'string', value: '2026-09-20T09:00:00Z' },
        extra: { type: 'boolean', value: true },
      }),
      document('events/c', {
        type: { type: 'string', value: 'z' },
        createdAt: { type: 'timestamp', value: '2026-09-20T09:00:00Z' },
      }),
    ])
    // Tied on count, so named in the order a person counts.
    expect(columns.map((column) => column.field)).toEqual(['createdAt', 'type', 'extra'])
    expect(columns[0]).toMatchObject({
      type: 'timestamp',
      present: 3,
      mixed: true,
      holds: { timestamp: 2, string: 1 },
    })
    expect(columns[1]?.mixed).toBeUndefined()
  })
})
