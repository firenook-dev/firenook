import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIMIT,
  QueryParseError,
  effectiveOrder,
  documentAsCode,
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

describe('a document copied as code', () => {
  const scope = { project: 'demo', database: '(default)', origin: 'http://127.0.0.1:8080' }
  // Every type whose JSON shape is a lie about what Firestore holds.
  const fields = {
    seen: { timestampValue: '2026-08-31T09:45:54.604Z' },
    where: { geoPointValue: { latitude: -1.2921, longitude: 36.8219 } },
    owner: { referenceValue: `${ROOT}/users/u1` },
    blob: { bytesValue: 'aGk=' },
    balance: { doubleValue: 269 },
    count: { integerValue: '785' },
    nested: {
      mapValue: { fields: { at: { timestampValue: '2026-01-02T03:04:05.000Z' } } },
    },
  }

  // It used to print the plain JSON beside the REST fields, so running
  // the snippet wrote a different document than the one it was copied
  // from: a timestamp came back a string, a geopoint a map, a reference
  // a path. The types are the whole reason to copy a real document
  // rather than ask somebody to write the call from memory.
  it('writes back the types it was copied from', () => {
    const web = documentAsCode('web', 'users/u1', fields, scope)
    expect(web).toContain('Timestamp.fromDate(new Date("2026-08-31T09:45:54.604Z"))')
    expect(web).toContain('new GeoPoint(-1.2921, 36.8219)')
    expect(web).toContain('doc(db, "users/u1")')
    expect(web).toContain('Bytes.fromBase64String("aGk=")')
    // Nested as well as top level: a map used to flatten to JSON whole.
    expect(web).toContain('"at": Timestamp.fromDate(new Date("2026-01-02T03:04:05.000Z"))')
    // And not as the bare value it used to be — the ISO string is only
    // allowed inside the constructor that makes it a timestamp again.
    expect(web).not.toContain('"seen": "2026-')
    expect(web).not.toContain('"latitude"')
    expect(web).not.toContain('"owner": "users/u1"')
  })

  // The snippet opens with an import line that covers what it uses.
  it('imports the constructors it reaches for, and no others', () => {
    expect(documentAsCode('web', 'users/u1', fields, scope)).toContain(
      'import { doc, setDoc, Timestamp, GeoPoint, Bytes } from "firebase/firestore";',
    )
    expect(documentAsCode('web', 'users/u1', { name: { stringValue: 'Ada' } }, scope)).toContain(
      'import { doc, setDoc } from "firebase/firestore";',
    )
  })

  // One type cannot survive the trip, so it is named rather than lost:
  // JavaScript has a single number type, and a double that happens to be
  // whole goes back to Firestore as an integer. Dart has two and does
  // not need telling.
  it('says which field a JavaScript dialect cannot write back', () => {
    const admin = documentAsCode('admin', 'users/u1', fields, scope)
    expect(admin).toContain('// balance holds a double with no fractional part.')
    expect(admin).not.toContain('count holds')
    const flutter = documentAsCode('flutter', 'users/u1', fields, scope)
    expect(flutter).toContain('269.0')
    expect(flutter).not.toContain('holds a double')
    expect(flutter).toContain("'where': GeoPoint(-1.2921, 36.8219)")
  })

  // The REST dialect was always typed, because it is the wire shape.
  it('leaves the REST call as the wire shape', () => {
    const rest = documentAsCode('rest', 'users/u1', fields, scope)
    expect(rest).toContain('"timestampValue":"2026-08-31T09:45:54.604Z"')
    expect(rest).toContain('curl -sS -X PATCH')
  })
})
