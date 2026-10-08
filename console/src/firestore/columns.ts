// Columns come from the documents on screen: every top-level field, ordered
// by how many documents carry it, with the type each document gives it.
// Firestore has no columns and no schema — a field is whatever each
// document says it is — so these are a reading of the page, not a promise.
//
// A field that is a timestamp in one document and a string in the next is
// the classic Firestore bug, and the header says so. A field that is a
// timestamp or `null` is not that bug: it is an optional field written the
// way Firestore wants it written, so that `where(f, '==', null)` can find
// the unset ones. Null is the absence of a value, not a rival type, so the
// column's type is read from the values that have one and nulls never set
// the marker. Only when the column is nothing but nulls is `null` its
// type — which is the honest answer, there being nothing else to go on.

import type { FirestoreValueType, FsDocument } from './value'

export interface InferredColumn {
  field: string
  /** The type most documents give it, counting only those that hold a value. */
  type: FirestoreValueType
  /** Documents (of those loaded) that carry the field. */
  present: number
  /** Type → count, when the loaded documents do not all agree. Nulls included. */
  holds?: Partial<Record<FirestoreValueType, number>> | undefined
  /** Two or more documents hold *values* of different types — the bug worth a mark. */
  mixed?: boolean | undefined
  /** Hint for the initial width, px. */
  width: number
}

/** `timestamp ×17, null ×2`, commonest first — what the column actually holds. */
export function describeTypes(holds: Partial<Record<FirestoreValueType, number>>): string {
  return Object.entries(holds)
    .toSorted(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .map(([name, count]) => `${name} ×${count}`)
    .join(', ')
}

/**
 * How wide a header's own content needs to be, px: the cell's padding plus
 * the menu's gaps and sort caret (41 px measured), the field name in 12 px
 * mono, and the type badge, whose width follows the type's own name — a
 * two-letter field under a `boolean` badge needs more room than its value
 * ever will. Each term rounds up, because a header that truncates by a pixel
 * reads as a bug while a few pixels of slack reads as nothing at all.
 */
function headerWidth(field: string, type: FirestoreValueType): number {
  return 43 + field.length * 7.4 + 22 + type.length * 6.5
}

/**
 * A long field name stops widening its column here. The header truncates and
 * keeps its full name in a tooltip, which is a far better trade than one
 * 52-character name pushing every other column off the screen.
 */
const MAX_HEADER_WIDTH = 320

const WIDTHS: Record<FirestoreValueType, number> = {
  string: 200,
  number: 120,
  boolean: 96,
  timestamp: 236,
  reference: 220,
  geopoint: 160,
  map: 140,
  array: 120,
  bytes: 110,
  null: 90,
  vector: 120,
}

export function inferColumns(documents: readonly FsDocument[]): InferredColumn[] {
  const seen = new Map<string, { order: number; types: Map<FirestoreValueType, number> }>()
  for (const document of documents) {
    for (const [field, value] of Object.entries(document.fields)) {
      let entry = seen.get(field)
      if (!entry) {
        entry = { order: seen.size, types: new Map() }
        seen.set(field, entry)
      }
      entry.types.set(value.type, (entry.types.get(value.type) ?? 0) + 1)
    }
  }
  const columns: InferredColumn[] = []
  for (const [field, entry] of seen) {
    let present = 0
    let type: FirestoreValueType = 'null'
    let best = -1
    let valued = 0
    for (const [candidate, count] of entry.types) {
      present += count
      if (candidate === 'null') continue
      valued += 1
      if (count > best) {
        best = count
        type = candidate
      }
    }
    // Wide enough for the header, but the type's own width always wins and a
    // long name never grows the column past the cap.
    const width = Math.max(WIDTHS[type], Math.min(MAX_HEADER_WIDTH, headerWidth(field, type)))
    const column: InferredColumn = { field, type, present, width: Math.round(width) }
    if (entry.types.size > 1) column.holds = Object.fromEntries(entry.types)
    if (valued > 1) column.mixed = true
    columns.push(column)
  }
  const order = new Map([...seen].map(([field, entry]) => [field, entry.order]))
  columns.sort(
    (a, b) => b.present - a.present || (order.get(a.field) ?? 0) - (order.get(b.field) ?? 0),
  )
  return columns
}
