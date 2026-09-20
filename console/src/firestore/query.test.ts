import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIMIT,
  QueryParseError,
  effectiveOrder,
  parseQuery,
  printQuery,
  queryAsCode,
  toStructuredQuery,
} from './query'

const ROOT = 'projects/demo/databases/(default)/documents'

describe('the workbench query text', () => {
  it('parses the SDK chain and prints it back identically', () => {
    const text = 'where("status", "==", "paid").orderBy("createdAt", "desc").limit(50)'
    const query = parseQuery(text)
    expect(query).toEqual({
      where: [{ field: 'status', op: '==', value: { type: 'string', value: 'paid' } }],
      orderBy: [{ field: 'createdAt', direction: 'desc' }],
      limit: 50,
    })
    expect(printQuery(query)).toBe(text)
  })

  it('accepts a pasted modular SDK snippet and every literal kind', () => {
    const query = parseQuery(`query(collection(db, "orders"),
      where("total", ">=", 9.5),
      where("tags", "array-contains-any", ["vip", "beta"]),
      where("customer", "==", doc("users/u1")),
      where("createdAt", "<", Timestamp("2026-09-20T00:00:00Z")),
      where("active", "==", true),
      where("bio", "==", null),
      orderBy("total"),
      limit(10))`)
    expect(query.where.map((clause) => clause.op)).toEqual([
      '>=',
      'array-contains-any',
      '==',
      '<',
      '==',
      '==',
    ])
    expect(query.where[1]?.value).toEqual({
      type: 'array',
      items: [
        { type: 'string', value: 'vip' },
        { type: 'string', value: 'beta' },
      ],
    })
    expect(query.where[2]?.value).toEqual({
      type: 'reference',
      value: 'users/u1',
      path: 'users/u1',
    })
    expect(query.where[3]?.value).toEqual({ type: 'timestamp', value: '2026-09-20T00:00:00.000Z' })
    expect(query.orderBy).toEqual([{ field: 'total', direction: 'asc' }])
    expect(query.limit).toBe(10)
  })

  it('names the problem and where it is', () => {
    expect(() => parseQuery('where("a", "~", 1)')).toThrow(QueryParseError)
    expect(() => parseQuery('where("a", "==", 1')).toThrow(/Expected \)/)
    expect(() => parseQuery('orderBy(1)')).toThrow(/must be a string/)
    expect(() => parseQuery('limit(0)')).toThrow(/positive/)
    expect(() => parseQuery('nope()')).toThrow(/Unknown clause nope/)
  })

  it('always orders by __name__ last so cursors are exact', () => {
    expect(effectiveOrder({ where: [], orderBy: [], limit: DEFAULT_LIMIT })).toEqual([
      { field: '__name__', direction: 'asc' },
    ])
    expect(
      effectiveOrder({ where: [], orderBy: [{ field: 'a', direction: 'desc' }], limit: 1 }),
    ).toEqual([
      { field: 'a', direction: 'desc' },
      { field: '__name__', direction: 'desc' },
    ])
  })

  it('encodes the REST structured query with unary filters for null and a cursor', () => {
    const query = parseQuery('where("bio", "==", null).where("plan", "in", ["pro", "team"])')
    const structured = toStructuredQuery('users', false, query, ROOT, [
      { referenceValue: `${ROOT}/users/u1` },
    ])
    expect(structured.from).toEqual([{ collectionId: 'users', allDescendants: false }])
    expect(structured.where).toEqual({
      compositeFilter: {
        op: 'AND',
        filters: [
          { unaryFilter: { op: 'IS_NULL', field: { fieldPath: 'bio' } } },
          {
            fieldFilter: {
              field: { fieldPath: 'plan' },
              op: 'IN',
              value: { arrayValue: { values: [{ stringValue: 'pro' }, { stringValue: 'team' }] } },
            },
          },
        ],
      },
    })
    expect(structured.orderBy).toEqual([
      { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
    ])
    expect(structured.startAt).toEqual({
      values: [{ referenceValue: `${ROOT}/users/u1` }],
      before: false,
    })
    expect(structured.limit).toBe(DEFAULT_LIMIT)
  })

  it('quotes field path segments that need it', () => {
    const structured = toStructuredQuery(
      'users',
      false,
      parseQuery('orderBy("address.zip-code")'),
      ROOT,
    )
    expect(structured.orderBy?.[0]?.field.fieldPath).toBe('address.`zip-code`')
  })

  it('writes the query as code for every target', () => {
    const query = parseQuery('where("status", "==", "paid").orderBy("createdAt", "desc").limit(5)')
    const scope = { project: 'demo', database: '(default)', origin: 'http://127.0.0.1:8080' }
    expect(queryAsCode('web', 'users/u1/orders', false, query, scope)).toContain(
      'collection(db, "users/u1/orders")',
    )
    expect(queryAsCode('admin', 'orders', true, query, scope)).toContain(
      'db.collectionGroup("orders")',
    )
    expect(queryAsCode('flutter', 'orders', false, query, scope)).toContain(
      ".where('status', isEqualTo: 'paid')",
    )
    const rest = queryAsCode('rest', 'users/u1/orders', false, query, scope)
    expect(rest).toContain('documents/users/u1:runQuery')
    expect(rest).toContain('"limit":5')
  })
})
