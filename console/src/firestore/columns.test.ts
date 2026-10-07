import { describe, expect, it } from 'vitest'
import { inferColumns } from './columns'
import type { FsDocument, FsValue } from './value'

function document(fields: Record<string, FsValue>, id = 'd1'): FsDocument {
  return { path: `c/${id}`, id, collection: 'c', fields }
}

const string = (value: string): FsValue => ({ type: 'string', value })
const boolean = (value: boolean): FsValue => ({ type: 'boolean', value })
const number = (value: number): FsValue => ({ type: 'number', value, integer: true })

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
    expect(columns[0]?.mixed).toEqual({ string: 2, number: 1 })
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
