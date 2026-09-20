import { describe, expect, it } from 'vitest'
import { inferColumns } from './columns'
import { scopesTouched, useLive } from './live'
import { decodeFrame } from './requests'
import type { FsDocument } from './value'

describe('the live channel', () => {
  it('maps a commit to the query scopes it makes stale', () => {
    const touched = scopesTouched({
      revision: 9,
      commitTime: '2026-09-20T09:00:00Z',
      changes: [
        { database: '(default)', path: 'users/u1', kind: 'updated' },
        { database: '(default)', path: 'users/u1/orders/o1', kind: 'created' },
      ],
    })
    expect([...touched.collections]).toEqual(['users', 'users/u1/orders'])
    expect([...touched.documents]).toEqual(['users/u1', 'users/u1/orders/o1'])
    expect([...touched.parents]).toEqual(['users/u1'])
    expect(touched.structural).toBe(true)
  })

  it('flashes changed rows and expires them', () => {
    useLive.getState().recordBatch({
      revision: 1,
      commitTime: '2026-09-20T09:00:00Z',
      changes: [{ database: '(default)', path: 'users/u1', kind: 'deleted' }],
    })
    expect(useLive.getState().commits).toBe(1)
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
    expect(columns.map((column) => column.field)).toEqual(['type', 'createdAt', 'extra'])
    expect(columns[1]).toMatchObject({
      type: 'timestamp',
      present: 3,
      mixed: { timestamp: 2, string: 1 },
    })
    expect(columns[0]?.mixed).toBeUndefined()
  })
})

describe('the Requests feed', () => {
  it('decodes an evaluation frame into what the drawer shows', () => {
    const event = decodeFrame(
      JSON.stringify({
        requestId: 'r-1',
        time: '2026-09-20T09:00:00Z',
        outcome: 'deny',
        granularAllowOutcomes: [{ line: 5, outcome: false }],
        rulesContext: {
          method: 'get',
          path: '/databases/(default)/documents/users/u1',
          request: {
            mapValue: {
              fields: { auth: { mapValue: { fields: { uid: { stringValue: 'u9' } } } } },
            },
          },
        },
      }),
    )
    expect(event).toMatchObject({
      requestId: 'r-1',
      outcome: 'deny',
      method: 'get',
      path: 'users/u1',
      database: '(default)',
      uid: 'u9',
      lines: [{ line: 5, outcome: false }],
    })
    expect(decodeFrame('not json')).toBeUndefined()
    expect(decodeFrame('{"hello":true}')).toBeUndefined()
  })
})
