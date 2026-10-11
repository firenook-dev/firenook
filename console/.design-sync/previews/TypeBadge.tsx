import { TypeBadge } from '@firenook/kit'

/** One colour per Firestore value type, used in grid headers and the inspector. */
export function AllTypes() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {(
        [
          'string',
          'number',
          'boolean',
          'timestamp',
          'reference',
          'geopoint',
          'map',
          'array',
          'bytes',
          'vector',
          'null',
        ] as const
      ).map((type) => (
        <TypeBadge key={type} type={type} />
      ))}
    </div>
  )
}
