import { describe, expect, it } from 'vitest'
import type { MissingIndexItem } from '@/api/generated/firestore/MissingIndexItem'
import type { MissingIndexQuery } from '@/api/generated/firestore/MissingIndexQuery'
import { describeQuery, describeTarget, formatEntry, missingFile, stillMissing } from './indexes'

const query = (patch: Partial<MissingIndexQuery> = {}): MissingIndexQuery => ({
  target: 'users/u1/orders',
  collectionGroup: false,
  filters: [{ field: 'status', op: '==' }],
  disjunction: false,
  orders: [{ field: 'total', descending: true }],
  ...patch,
})

const item = (patch: Partial<MissingIndexItem> = {}): MissingIndexItem => ({
  database: '(default)',
  collectionGroup: 'orders',
  scope: 'collection',
  fields: [
    { fieldPath: 'status', mode: 'ascending', dimension: null },
    { fieldPath: 'total', mode: 'descending', dimension: null },
  ],
  composite: true,
  section: 'indexes',
  entry: {
    collectionGroup: 'orders',
    queryScope: 'COLLECTION',
    fields: [
      { fieldPath: 'status', order: 'ASCENDING' },
      { fieldPath: 'total', order: 'DESCENDING' },
    ],
  },
  query: query(),
  queries: 3,
  firstSeen: '2026-11-11T01:00:00Z',
  lastSeen: '2026-11-11T01:02:00Z',
  declared: false,
  ...patch,
})

describe('the query that needed an index', () => {
  it('reads as the query line writes it, with its values left out', () => {
    expect(describeQuery(query())).toBe('where("status", "==", …).orderBy("total", "desc")')
    expect(describeQuery(query({ orders: [{ field: 'total', descending: false }] }))).toBe(
      'where("status", "==", …).orderBy("total")',
    )
  })

  it('names the fields of an or query in one or()', () => {
    expect(
      describeQuery(
        query({
          disjunction: true,
          filters: [
            { field: 'status', op: '==' },
            { field: 'owner', op: 'in' },
          ],
          orders: [],
        }),
      ),
    ).toBe('or(where("status", "==", …), where("owner", "in", …))')
  })

  it('says where it ran: a collection path, or every collection with that id', () => {
    expect(describeTarget(query())).toBe('users/u1/orders')
    expect(describeTarget(query({ target: 'orders', collectionGroup: true }))).toBe(
      'every "orders" collection',
    )
  })
})

describe('what the page copies', () => {
  it('copies an entry as the index file writes it', () => {
    expect(JSON.parse(formatEntry(item()))).toEqual(item().entry)
  })

  it('copies every index still missing in one database as an index file', () => {
    const override = item({
      section: 'fieldOverrides',
      composite: false,
      entry: { collectionGroup: 'lines', fieldPath: 'sku', indexes: [] },
    })
    const items = [
      item(),
      override,
      item({ declared: true, entry: { collectionGroup: 'declared' } }),
      item({ database: 'archive', entry: { collectionGroup: 'elsewhere' } }),
    ]
    expect(JSON.parse(missingFile(items, '(default)'))).toEqual({
      indexes: [item().entry],
      fieldOverrides: [override.entry],
    })
    expect(stillMissing({ strict: false, indexes: items, unlisted: 0, files: [] })).toHaveLength(
      3,
    )
  })
})
