import { describe, expect, it } from 'vitest'
import { arrangeColumns, coverage, describeTypes, foldRare, inferColumns } from './columns'
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

describe('the shape of a collection whose documents disagree', () => {
  it('counts out of the documents loaded, not the placeholders for missing ones', () => {
    const placeholder: FsDocument = { ...document({}, 'gone'), missing: true }
    const [column] = inferColumns([
      document({ name: string('a') }, 'd1'),
      document({ name: string('b') }, 'd2'),
      placeholder,
    ])
    expect(column?.present).toBe(2)
    expect(column?.of).toBe(2)
    expect(coverage(column!)).toBeUndefined()
  })

  it('says how much of the page has a field, rounding down', () => {
    expect(coverage({ present: 10, of: 100 })).toBe('10%')
    expect(coverage({ present: 999, of: 1000 })).toBe('99%')
    expect(coverage({ present: 1, of: 1000 })).toBe('<1%')
    expect(coverage({ present: 4, of: 4 })).toBeUndefined()
  })

  it('makes room in the header for that share', () => {
    const [full] = inferColumns([document({ referredBy: string('u1') }, 'd1')])
    const sparse = inferColumns([
      document({ referredBy: string('u1') }, 'd1'),
      document({ other: string('x') }, 'd2'),
    ]).find((column) => column.field === 'referredBy')
    expect(sparse!.width).toBeGreaterThanOrEqual(full!.width)
  })

  it('names tied columns the way a person counts', () => {
    const columns = inferColumns([
      document({ field10: string('a'), field2: string('b'), field1: string('c') }),
    ])
    expect(columns.map((column) => column.field)).toEqual(['field1', 'field2', 'field10'])
  })
})

describe('arrangeColumns', () => {
  const page = (...shapes: string[][]) =>
    inferColumns(
      shapes.map((fields, index) =>
        document(Object.fromEntries(fields.map((field) => [field, string('x')])), `d${index}`),
      ),
    )

  it('keeps the first reading commonest first', () => {
    const { columns } = arrangeColumns(page(['name', 'email'], ['name']), [])
    expect(columns.map((column) => column.field)).toEqual(['name', 'email'])
  })

  // Measured: twenty documents on a second page brought three new fields,
  // and ordering by count put them in the middle, under the reader's eye.
  it('puts fields the next page brings at the end, however common they are', () => {
    const first = arrangeColumns(page(['name', 'fullName'], ['name']), [])
    const second = arrangeColumns(
      page(['name', 'fullName'], ['name', 'plan'], ['name', 'plan'], ['name', 'plan']),
      first.order,
    )
    expect(second.columns.map((column) => column.field)).toEqual(['name', 'fullName', 'plan'])
  })

  it('hands back the same order when nothing is new, so a caller can tell', () => {
    const first = arrangeColumns(page(['a', 'b']), [])
    const again = arrangeColumns(page(['b', 'a'], ['a']), first.order)
    expect(again.order).toBe(first.order)
  })

  it('brings a field back where it was after a filter took it away', () => {
    const first = arrangeColumns(page(['a', 'b', 'c']), [])
    const filtered = arrangeColumns(page(['a', 'c']), first.order)
    expect(filtered.columns.map((column) => column.field)).toEqual(['a', 'c'])
    const back = arrangeColumns(page(['a', 'b', 'c']), filtered.order)
    expect(back.columns.map((column) => column.field)).toEqual(['a', 'b', 'c'])
  })
})

describe('foldRare', () => {
  // The collection that broke the grid: forty documents, each with its own
  // fifteen user ids as top-level keys, and an owner every one of them has.
  const keyedByUser = () =>
    inferColumns(
      Array.from({ length: 40 }, (_, at) =>
        document(
          {
            owner: string(`u${at}`),
            ...Object.fromEntries(
              Array.from({ length: 15 }, (_unused, key) => [`uid_${at}_${key}`, boolean(true)]),
            ),
          },
          `p${at}`,
        ),
      ),
    )

  it('folds the fields only one document has, once there are too many columns', () => {
    const { shown, folded } = foldRare(keyedByUser())
    expect(shown.map((column) => column.field)).toEqual(['owner'])
    expect(folded).toHaveLength(600)
  })

  it('folds nothing while the columns can still be read', () => {
    const few = inferColumns([
      document({ name: string('a'), legacy: string('b') }, 'd1'),
      ...Array.from({ length: 30 }, (_, at) => document({ name: string('a') }, `n${at}`)),
    ])
    expect(foldRare(few).folded).toEqual([])
  })

  it('keeps a field one document in ten has, even among many', () => {
    const docs = Array.from({ length: 100 }, (_, at) =>
      document(
        Object.fromEntries([
          ...Array.from({ length: 30 }, (_unused, key) => [`common${key}`, string('x')]),
          ...(at % 10 === 0 ? [['sometimes', string('y')]] : []),
          ...(at === 0 ? [['once', string('z')]] : []),
        ]),
        `d${at}`,
      ),
    )
    const { shown, folded } = foldRare(inferColumns(docs))
    expect(shown.some((column) => column.field === 'sometimes')).toBe(true)
    expect(folded.map((column) => column.field)).toEqual(['once'])
  })
})
