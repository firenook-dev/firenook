import { describe, expect, it } from 'vitest'
import type { MissingIndexItem } from '@/api/generated/firestore/MissingIndexItem'
import type { MissingIndexQuery } from '@/api/generated/firestore/MissingIndexQuery'
import {
  type DeclaredIndexList,
  databaseFile,
  describeFields,
  describeOverride,
  describeQuery,
  describeTarget,
  entryKey,
  entryOf,
  formatEntry,
  missingFile,
  modeWord,
  neededIn,
  stillMissing,
} from './indexes'

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
    expect(stillMissing({ strict: false, indexes: items, unlisted: 0, files: [] })).toHaveLength(3)
  })
})

describe('the Indexes page', () => {
  it('lists what one database needed, and its file', () => {
    const list = {
      strict: false,
      indexes: [item(), item({ database: 'eu', declared: true })],
      unlisted: 0,
      files: [],
    }
    expect(neededIn(list, '(default)')).toHaveLength(1)
    expect(neededIn(list, 'eu')[0]?.declared).toBe(true)
    expect(neededIn(undefined, 'eu')).toEqual([])
    const declared: DeclaredIndexList = {
      strict: false,
      databases: [
        {
          database: '(default)',
          path: '/app/firestore.indexes.json',
          problem: null,
          revision: 'abc',
          indexes: [],
          fieldOverrides: [],
        },
      ],
    }
    expect(databaseFile(declared, '(default)')?.revision).toBe('abc')
    expect(databaseFile(declared, 'eu')).toBeUndefined()
  })

  it('names an edit by the entry the file writes', () => {
    const missing = item()
    expect(entryOf(missing)).toEqual({ section: 'indexes', entry: missing.entry })
    expect(entryKey(missing.entry)).toBe(JSON.stringify(missing.entry))
  })

  it('says fields and overrides in a line', () => {
    expect(describeFields(item().fields)).toBe('status \u2191, total \u2193')
    expect(modeWord({ mode: 'arrayContains', dimension: null })).toBe('array-contains')
    expect(modeWord({ mode: 'vector', dimension: 768 })).toBe('vector 768')
    expect(describeOverride({ indexes: [] })).toBe('Not indexed')
    expect(
      describeOverride({
        indexes: [
          { scope: 'collection', mode: 'ascending', dimension: null },
          { scope: 'collection', mode: 'arrayContains', dimension: null },
          { scope: 'collectionGroup', mode: 'descending', dimension: null },
        ],
      }),
    ).toBe('\u2191 array-contains, collection group \u2193')
  })
})
