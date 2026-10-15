// What Pub/Sub's message and backlog lists do to their rows before drawing
// them. The engine pages live queues by a key the queue is ordered by —
// message ids and backlog positions — so pages fetched at different
// moments never overlap or skip by position; but a row that moved between
// two reads can still be in two pages for a moment (its old key not yet
// patched away), and React keys must be unique. And a backlog's places are
// consecutive in delivery order, so a patch that removes or adds an
// available row above renumbers the ones below without asking the engine.

/**
 * `rows` with each id once: the first copy is kept. The window is ordered
 * newest-read first where it matters (a list's head is read again on every
 * change, its tail only when scrolled to), so the first copy is the one
 * read last. Answers the same array when there was nothing to drop.
 */
export function dedupeRows<T>(rows: readonly T[], idOf: (row: T) => string): readonly T[] {
  const seen = new Set<string>()
  let kept: T[] | undefined
  rows.forEach((row, index) => {
    const id = idOf(row)
    if (seen.has(id)) {
      kept ??= rows.slice(0, index)
      return
    }
    seen.add(id)
    kept?.push(row)
  })
  return kept ?? rows
}

/** A row that may hold a place in the delivery order. */
export interface Placed {
  state: string
  place: number | null
}

/**
 * The window's available rows numbered consecutively in the order they
 * stand: from 1 when the window starts at the head of the backlog, else
 * from the engine's place for the first available row it holds. Rows in
 * other states hold no place. Answers the same array when every place was
 * already right.
 */
export function renumberPlaces<T extends Placed>(
  rows: readonly T[],
  atStart: boolean,
): readonly T[] {
  const first = rows.find((row) => row.state === 'available')
  if (!first) return rows
  let next = atStart ? 1 : (first.place ?? 1)
  let changed: T[] | undefined
  rows.forEach((row, index) => {
    if (row.state !== 'available') return
    if (row.place !== next) {
      changed ??= [...rows]
      changed[index] = { ...row, place: next }
    }
    next += 1
  })
  return changed ?? rows
}

/**
 * Compares two decimal ids, which may pass 2^53 and so are never read as
 * numbers: the longer one is larger, then the larger digits.
 */
export function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The ids at the head of a newest-first list that are newer than the head
 * it last drew — what flashes after the head is read again. Ids are one
 * counter shared by every topic, so another topic's publishes between two
 * reads leave gaps; only "newer than what was drawn" decides.
 */
export function idsAbove<T>(
  rows: readonly T[],
  idOf: (row: T) => string,
  lastHead: string | undefined,
): string[] {
  if (lastHead === undefined) return []
  const above: string[] = []
  for (const row of rows) {
    const id = idOf(row)
    if (compareIds(id, lastHead) <= 0) break
    above.push(id)
  }
  return above
}
