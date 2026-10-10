// Columns come from the documents on screen: every top-level field, ordered
// by how many documents carry it, with the type each document gives it.
// Firestore has no columns and no schema — a field is whatever each
// document says it is — so these are a reading of the page, not a promise.
//
// Three things follow from that, and each was measured before it was
// built, on a collection of three shapes and on one keyed by user id.
//
// A reading of the page changes as the page grows. Twenty documents on the
// second page brought three new fields, and ordering by count slotted them
// in at positions five to seven — under the reader's eye, mid-scroll. So
// the order is decided once per collection and new fields join at the end
// (`arrangeColumns`).
//
// A column is not a promise that a document has the field. `referredBy`
// was in 10 of 100 documents and nothing on screen said so; the header now
// does (`coverage`), and the cell of a document without it says "not set"
// rather than looking like a value that happens to be empty.
//
// And a field is not always a column. A collection keyed by user id —
// `{uid_8f2: true, uid_k1x: true, ...}` — had 601 fields over 40 documents,
// 585 of every row's 601 cells empty and frames of up to 950 ms. Fields
// that almost no document has are folded into one column once there are
// too many to read (`foldRare`), and every one of them is a click away.
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
  /**
   * Documents loaded, which is what `present` is out of. A placeholder for
   * a missing ancestor holds no fields by definition, so it is not counted:
   * one would make every field of the collection look optional.
   */
  of: number
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
function headerWidth(field: string, type: FirestoreValueType, sparse: boolean): number {
  return 43 + field.length * 7.4 + 22 + type.length * 6.5 + (sparse ? COVERAGE_WIDTH : 0)
}

/** The share a sparse header adds after its badge, `25%` and its gap, px. */
const COVERAGE_WIDTH = 34

/**
 * How much of the page has this field, when not all of it does: `25%`, or
 * `<1%` for a field one document in a thousand has. Rounded down, so a
 * field 999 documents of 1,000 carry never reads as all of them.
 */
export function coverage(column: Pick<InferredColumn, 'present' | 'of'>): string | undefined {
  if (column.of === 0 || column.present >= column.of) return undefined
  const share = (column.present / column.of) * 100
  return share < 1 ? '<1%' : `${Math.floor(share)}%`
}

/** `field2` before `field10`, which is how a person counts. */
const NATURAL = new Intl.Collator('en', { numeric: true })

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
  const seen = new Map<string, { types: Map<FirestoreValueType, number> }>()
  let of = 0
  for (const document of documents) {
    if (document.missing) continue
    of += 1
    for (const [field, value] of Object.entries(document.fields)) {
      let entry = seen.get(field)
      if (!entry) {
        entry = { types: new Map() }
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
    const width = Math.max(
      WIDTHS[type],
      Math.min(MAX_HEADER_WIDTH, headerWidth(field, type, present < of)),
    )
    const column: InferredColumn = { field, type, present, of, width: Math.round(width) }
    if (entry.types.size > 1) column.holds = Object.fromEntries(entry.types)
    if (valued > 1) column.mixed = true
    columns.push(column)
  }
  // Ties are named in the order a person counts. They used to keep the
  // order the engine listed them in, which is byte order, so a collection
  // of `field0` to `field11` read `field0, field1, field10, field11, field2`.
  columns.sort((a, b) => b.present - a.present || NATURAL.compare(a.field, b.field))
  return columns
}

/**
 * The columns in the order this collection has been showing them, with any
 * field it has not shown before at the end.
 *
 * `remembered` is every field the collection has had a column for, in
 * order, including ones the documents loaded right now do not have — so a
 * field a filter took away comes back where it was, not at the end. The
 * order handed back is that list with the newcomers appended, and it is
 * the very array passed in when nothing is new, so a caller can tell "no
 * change" by identity.
 *
 * The first reading of a collection has nothing to remember and keeps
 * `inferColumns`' order, commonest first.
 */
export function arrangeColumns(
  columns: readonly InferredColumn[],
  remembered: readonly string[],
): { columns: InferredColumn[]; order: readonly string[] } {
  const byField = new Map(columns.map((column) => [column.field, column]))
  const known = new Set(remembered)
  const added = columns.filter((column) => !known.has(column.field)).map((column) => column.field)
  const order = added.length === 0 ? remembered : [...remembered, ...added]
  const arranged: InferredColumn[] = []
  for (const field of order) {
    const column = byField.get(field)
    if (column) arranged.push(column)
  }
  return { columns: arranged, order }
}

/** Past this many columns, the ones almost no document has stop being columns. */
export const FOLD_AFTER = 24

/** A field no more than this share of the page has is rare. */
const RARE_SHARE = 0.05

/**
 * Splits off the fields too rare to be worth a column, once there are too
 * many columns to read.
 *
 * A field is rare when one document has it, or no more than one in twenty
 * — the mark of a map written as top-level keys, `{uid_8f2: true}`, where
 * every document has its own. Nothing is folded while the collection has
 * `FOLD_AFTER` columns or fewer: a field one document of three has is
 * worth its column when there are only six of them.
 */
export function foldRare(columns: readonly InferredColumn[]): {
  shown: InferredColumn[]
  folded: InferredColumn[]
} {
  if (columns.length <= FOLD_AFTER) return { shown: [...columns], folded: [] }
  const shown: InferredColumn[] = []
  const folded: InferredColumn[] = []
  for (const column of columns) {
    if (column.present <= Math.max(1, Math.floor(column.of * RARE_SHARE))) folded.push(column)
    else shown.push(column)
  }
  return { shown, folded }
}
