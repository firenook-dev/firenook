import { describe, expect, it } from 'vitest'
import {
  changedKeys,
  decidingLines,
  decodeDecision,
  filterDecisions,
  fromRulesValue,
  linesRun,
} from './decisions'

const RULES = "rules_version = '2';\nservice cloud.firestore {}\n"

function frame(overrides: Record<string, unknown>) {
  return JSON.stringify({
    requestId: 'r-1',
    time: '2026-09-20T09:00:00Z',
    outcome: 'deny',
    rules: RULES,
    rulesReleaseKey: 'projects/p/releases/cloud.firestore-HASH123',
    granularAllowOutcomes: [{ line: 5, outcome: false }],
    rulesContext: {
      method: 'get',
      path: '/databases/(default)/documents/users/u1',
      request: {
        mapValue: {
          fields: {
            auth: {
              mapValue: {
                fields: {
                  uid: { stringValue: 'u9' },
                  token: {
                    mapValue: {
                      fields: {
                        email: { stringValue: 'ada@example.test' },
                        admin: { boolValue: true },
                        firebase: {
                          mapValue: {
                            fields: { sign_in_provider: { stringValue: 'password' } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            inTransaction: { boolValue: false },
          },
        },
      },
      resource: {
        mapValue: {
          fields: {
            data: { mapValue: { fields: { name: { stringValue: 'Ada' } } } },
            __name__: { pathValue: { segments: [] } },
            id: { stringValue: 'u1' },
          },
        },
      },
    },
    ...overrides,
  })
}

describe('a rules decision', () => {
  it('decodes a read: who, the document, the lines and the rules that decided it', () => {
    const decision = decodeDecision(frame({}))
    expect(decision).toMatchObject({
      requestId: 'r-1',
      outcome: 'deny',
      method: 'get',
      path: 'users/u1',
      database: '(default)',
      uid: 'u9',
      lines: [{ line: 5, outcome: false }],
      rules: RULES,
      rulesHash: 'HASH123',
      before: { name: { type: 'string', value: 'Ada' } },
      after: undefined,
      changedKeys: undefined,
    })
    expect(decision?.token?.admin).toEqual({ type: 'boolean', value: true })
    expect(decision?.token?.firebase).toMatchObject({ type: 'map' })
  })

  it('decodes an update with the document it would leave and the fields it changes', () => {
    const decision = decodeDecision(
      frame({
        rulesContext: {
          method: 'update',
          path: '/databases/(default)/documents/users/u1',
          request: {
            mapValue: {
              fields: {
                auth: { nullValue: null },
                resource: {
                  mapValue: {
                    fields: {
                      data: {
                        mapValue: {
                          fields: {
                            name: { stringValue: 'Ada' },
                            seats: { intValue: '11' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          resource: {
            mapValue: {
              fields: {
                data: {
                  mapValue: {
                    fields: { name: { stringValue: 'Ada' }, plan: { stringValue: 'free' } },
                  },
                },
              },
            },
          },
        },
      }),
    )
    expect(decision?.uid).toBeUndefined()
    expect(decision?.after).toEqual({
      name: { type: 'string', value: 'Ada' },
      seats: { type: 'number', value: 11, integer: true },
    })
    expect(decision?.changedKeys).toEqual(['plan', 'seats'])
  })

  it('reads a missing document as null and the undefined marker as no resource', () => {
    const decision = decodeDecision(frame({}).replace('"resource":{"mapValue"', '"resource":{"x"'))
    expect(decision?.before).toBeNull()
    const create = decodeDecision(
      JSON.stringify({
        requestId: 'c',
        outcome: 'allow',
        rulesContext: {
          method: 'create',
          path: '/databases/(default)/documents/users/new',
          request: { mapValue: { fields: { resource: { nullValue: null } } } },
          resource: { undefined: {} },
        },
      }),
    )
    expect(create?.before).toBeNull()
    expect(create?.after).toBeNull()
  })

  it('refuses what is not a decision', () => {
    expect(decodeDecision('not json')).toBeUndefined()
    expect(decodeDecision('{"hello":true}')).toBeUndefined()
  })

  it('converts every rules value type', () => {
    expect(fromRulesValue({ floatValue: 'NaN' })).toMatchObject({ type: 'number', integer: false })
    expect(fromRulesValue({ timestampValue: '2026-01-01T00:00:00Z' })).toEqual({
      type: 'timestamp',
      value: '2026-01-01T00:00:00Z',
    })
    expect(
      fromRulesValue({
        pathValue: {
          segments: ['databases', '(default)', 'documents', 'users', 'u1'].map((simple) => ({
            simple,
          })),
        },
      }),
    ).toMatchObject({ type: 'reference', path: 'users/u1' })
    expect(fromRulesValue({ listValue: { values: [{ intValue: 1 }, { undefined: {} }] } })).toEqual(
      { type: 'array', items: [{ type: 'number', value: 1, integer: true }] },
    )
    expect(fromRulesValue({ undefined: {} })).toBeUndefined()
  })
})

describe('reading decisions', () => {
  const base = decodeDecision(frame({}))!
  const allowed = { ...base, requestId: 'a', outcome: 'allow' as const, path: 'products/p1' }
  const anonymous = { ...base, requestId: 'b', uid: undefined, path: 'users/u1/orders/o1' }
  const other = { ...base, requestId: 'c', database: 'analytics' }
  const all = [base, allowed, anonymous, other]

  it('narrows by database, path prefix, user and verdict', () => {
    expect(filterDecisions(all, '(default)', {}).map((d) => d.requestId)).toEqual(['r-1', 'a', 'b'])
    expect(filterDecisions(all, '(default)', { path: 'users/u1' }).map((d) => d.requestId)).toEqual(
      ['r-1', 'b'],
    )
    // `users/u1` is not a prefix of `users/u10`.
    expect(
      filterDecisions([{ ...base, path: 'users/u10' }], '(default)', { path: 'users/u1' }),
    ).toEqual([])
    expect(filterDecisions(all, '(default)', { uid: '' }).map((d) => d.requestId)).toEqual(['b'])
    expect(filterDecisions(all, '(default)', { denied: true }).map((d) => d.requestId)).toEqual([
      'r-1',
      'b',
    ])
    expect(filterDecisions(all, '(default)', { text: 'PRODUCTS' }).map((d) => d.requestId)).toEqual(
      ['a'],
    )
    expect(
      filterDecisions(all, '(default)', { text: 'anonymous' }).map((d) => d.requestId),
    ).toEqual(['b'])
  })

  it('names the lines that decided it, each once, with how often it ran', () => {
    const lines = [
      { line: 5, outcome: false },
      { line: 9, outcome: true },
      { line: 5, outcome: false },
    ]
    expect(decidingLines({ outcome: 'deny', lines })).toEqual([5])
    expect(decidingLines({ outcome: 'allow', lines })).toEqual([9])
    expect(linesRun({ lines })).toEqual([
      { line: 5, outcome: false, times: 2 },
      { line: 9, outcome: true, times: 1 },
    ])
  })

  it('finds the fields a write changes', () => {
    expect(
      changedKeys(
        { a: { type: 'number', value: 1, integer: true }, b: { type: 'null' } },
        {
          a: { type: 'number', value: 2, integer: true },
          b: { type: 'null' },
          c: { type: 'null' },
        },
      ),
    ).toEqual(['a', 'c'])
    expect(changedKeys(null, { a: { type: 'null' } })).toEqual(['a'])
  })
})
