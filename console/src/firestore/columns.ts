// Columns come from the documents on screen: every top-level field, ordered
// by how many documents carry it, with the type each document gives it. A
// field whose type differs between documents is the classic Firestore bug
// (a timestamp here, a string there); the header says so.

import type { FirestoreValueType, FsDocument } from './value'

export interface InferredColumn {
  field: string
  /** The type most documents use. */
  type: FirestoreValueType
  /** Documents (of those loaded) that carry the field. */
  present: number
  /** Type → count, when more than one type was seen. */
  mixed?: Partial<Record<FirestoreValueType, number>> | undefined
  /** Hint for the initial width, px. */
  width: number
}

const WIDTHS: Record<FirestoreValueType, number> = {
  string: 200,
  number: 120,
  boolean: 96,
  timestamp: 200,
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
    let type: FirestoreValueType = 'string'
    let best = -1
    for (const [candidate, count] of entry.types) {
      present += count
      if (count > best) {
        best = count
        type = candidate
      }
    }
    // Wide enough for the header (name in 12 px mono plus the type badge).
    const width = Math.max(WIDTHS[type], 28 + field.length * 7.3 + 72)
    const column: InferredColumn = { field, type, present, width: Math.round(width) }
    if (entry.types.size > 1) column.mixed = Object.fromEntries(entry.types)
    columns.push(column)
  }
  const order = new Map([...seen].map(([field, entry]) => [field, entry.order]))
  columns.sort(
    (a, b) => b.present - a.present || (order.get(a.field) ?? 0) - (order.get(b.field) ?? 0),
  )
  return columns
}
