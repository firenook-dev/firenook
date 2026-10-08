import { describe, expect, it } from 'vitest'
import { describeTypes, inferColumns } from './columns'
import type { FsDocument, FsValue } from './value'

function document(fields: Record<string, FsValue>, id = 'd1'): FsDocument {
  return { path: `c/${id}`, id, collection: 'c', fields }
}

const string = (value: string): FsValue => ({ type: 'string', value })
const boolean = (value: boolean): FsValue => ({ type: 'boolean', value })
const number = (value: number): FsValue => ({ type: 'number', value, integer: true })
const timestamp = (value: string): FsValue => ({ type: 'timestamp', value })
const nothing = (): FsValue => ({ type: 'null' })

describe('inferColumns', () => {
  it('orders columns by how many documents carry the field', () => {
    const columns = inferColumns([
      document({ rare: string('x'), common: string('a') }, 'd1'),
      document({ common: string('b') }, 'd2'),
      document({ common: string('c') }, 'd3'),
    ])
    expect(columns.map((column) => column.field)).toEqual(['common', 'rare'])
    expect(columns[0]?.present).toBe(3)
  })

  it('reports a field whose type differs between documents', () => {
    const columns = inferColumns([
      document({ createdAt: string('2026-01-01T00:00:00Z') }, 'd1'),
      document({ createdAt: string('2026-01-02T00:00:00Z') }, 'd2'),
      document({ createdAt: number(3) }, 'd3'),
    ])
    expect(columns[0]?.type).toBe('string')
    expect(columns[0]?.mixed).toBe(true)
    expect(columns[0]?.holds).toEqual({ string: 2, number: 1 })
    expect(describeTypes(columns[0]!.holds!)).toBe('string ×2, number ×1')
  })

  // Firestore has no schema: a field is whatever each document says it is,
  // and `null` is a value in its own right, not a missing one. An optional
  // field is written that way on purpose, so that `== null` can find it.
  it("reads a column's type from the documents that hold a value", () => {
    const columns = inferColumns([
      document({ authorizedAt: timestamp('2026-01-01T00:00:00Z') }, 'd1'),
      document({ authorizedAt: nothing() }, 'd2'),
      document({ authorizedAt: nothing() }, 'd3'),
    ])
    // Two of three are null, and the column is still a timestamp column.
    expect(columns[0]?.type).toBe('timestamp')
    expect(columns[0]?.mixed).toBeUndefined()
    expect(columns[0]?.holds).toEqual({ timestamp: 1, null: 2 })
  })

  it('calls a column null only when there is nothing else to call it', () => {
    const columns = inferColumns([
      document({ codeHash: nothing() }, 'd1'),
      document({ codeHash: nothing() }, 'd2'),
    ])
    expect(columns[0]?.type).toBe('null')
    expect(columns[0]?.mixed).toBeUndefined()
    expect(columns[0]?.holds).toBeUndefined()
  })

  it('still marks a column that holds two real types beside its nulls', () => {
    const columns = inferColumns([
      document({ amount: number(1) }, 'd1'),
      document({ amount: string('two') }, 'd2'),
      document({ amount: nothing() }, 'd3'),
    ])
    expect(columns[0]?.mixed).toBe(true)
    expect(columns[0]?.holds).toEqual({ number: 1, string: 1, null: 1 })
  })

  it('leaves room for a short name under a long type badge', () => {
    // `ok` is two characters but its `boolean` badge is not, and a header
    // that truncates to `o…` tells the reader nothing.
    const [column] = inferColumns([document({ ok: boolean(true) })])
    expect(column?.width).toBeGreaterThanOrEqual(120)
  })

  it('stops a long field name from widening its column without end', () => {
    const long = 'aVeryLongFieldNameThatGoesOnAndOnForQuiteAWhileIndeed'
    const [column] = inferColumns([document({ [long]: string('yes') })])
    // Uncapped this measured 480 px, for a three-character value.
    expect(column?.width).toBe(320)
  })

  it('still gives each type its own comfortable width', () => {
    const columns = inferColumns([
      document({ at: { type: 'timestamp', value: '2026-01-01T00:00:00Z' }, flag: boolean(false) }),
    ])
    const widths = Object.fromEntries(columns.map((column) => [column.field, column.width]))
    // A timestamp needs more room than a boolean whatever the names are.
    expect(widths.at).toBeGreaterThan(widths.flag ?? 0)
  })
})
