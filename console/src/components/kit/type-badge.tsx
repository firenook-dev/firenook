export type FirestoreValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'timestamp'
  | 'reference'
  | 'geopoint'
  | 'map'
  | 'array'
  | 'bytes'
  | 'vector'
  | 'null'
  | 'doc'

/**
 * Tags a column or a field with its Firestore value type.
 *
 * One quiet treatment for every type, because the word already says which
 * one it is. A colour per type repeats that in a second channel, and eight
 * saturated chips across a header row is a rainbow with no hierarchy — it
 * also drowns the one colour in there that carries information. Colour in
 * this console means something or it is not spent, and a `null` is a value
 * like any other, not the error its red chip claimed.
 *
 * `mixed` is the something. A column whose documents disagree about a
 * field's type is the one case worth marking, so it is the only coloured
 * badge in the grid, and the odd cells beneath it carry the same amber.
 * @category Data
 */
export function TypeBadge({
  type,
  mixed,
}: {
  type: FirestoreValueType
  mixed?: Partial<Record<FirestoreValueType, number>> | undefined
}) {
  const breakdown = mixed && describeMixed(mixed)
  return (
    <span
      // Both places this sits are hover targets that light up in the same
      // tint, which would swallow the chip; it takes the ground back by
      // going the other way. The amber keeps its own, being the point.
      className={`flex h-4.5 shrink-0 items-center gap-1 rounded px-1 font-mono text-[11px] ${
        breakdown
          ? 'bg-kumo-warning-tint text-kumo-default'
          : 'bg-kumo-tint text-kumo-subtle group-hover:bg-kumo-base'
      }`}
      title={breakdown ? `More than one type here: ${breakdown}` : undefined}
      data-testid="type-badge"
      data-mixed={breakdown ? '' : undefined}
    >
      {breakdown && <span className="size-1.5 shrink-0 rounded-full bg-kumo-warning" />}
      {type}
    </span>
  )
}

/** `timestamp ×17, null ×2`, commonest first — what the column actually holds. */
export function describeMixed(mixed: Partial<Record<FirestoreValueType, number>>): string {
  return Object.entries(mixed)
    .toSorted(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .map(([name, count]) => `${name} ×${count}`)
    .join(', ')
}
