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
 * `mixed` is the something: the breakdown of a column that holds values of
 * two different types, which is the one case worth a mark. It is the only
 * coloured badge in the grid, and the odd cells beneath it carry the same
 * amber. What counts as that case is the caller's to decide — a column of
 * timestamps and nulls does not.
 * @category Data
 */
export function TypeBadge({
  type,
  mixed,
}: {
  type: FirestoreValueType
  mixed?: string | undefined
}) {
  return (
    <span
      // Both places this sits are hover targets that light up in the same
      // tint, which would swallow the chip; it takes the ground back by
      // going the other way. The amber keeps its own, being the point.
      className={`flex h-4.5 shrink-0 items-center gap-1 rounded px-1 font-mono text-[11px] ${
        mixed
          ? 'bg-kumo-warning-tint text-kumo-default'
          : 'bg-kumo-tint text-kumo-subtle group-hover:bg-kumo-base'
      }`}
      title={mixed ? `More than one type here: ${mixed}` : undefined}
      data-testid="type-badge"
      data-mixed={mixed ? '' : undefined}
    >
      {mixed && <span className="size-1.5 shrink-0 rounded-full bg-kumo-warning" />}
      {type}
    </span>
  )
}
