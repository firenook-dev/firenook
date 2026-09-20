import { Badge } from '@cloudflare/kumo'

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

const VARIANT: Record<
  FirestoreValueType,
  'blue' | 'teal' | 'green' | 'purple' | 'orange' | 'neutral' | 'red'
> = {
  string: 'blue',
  number: 'teal',
  boolean: 'green',
  timestamp: 'purple',
  reference: 'orange',
  geopoint: 'purple',
  map: 'neutral',
  array: 'neutral',
  bytes: 'neutral',
  vector: 'teal',
  null: 'red',
  doc: 'neutral',
}

/**
 * Tags a column or a field with its Firestore value type, using one colour
 * per type so a grid reads at a glance: blue string, teal number, green
 * boolean, purple timestamp, orange reference, neutral map and array.
 * @category Data
 */
export function TypeBadge({ type }: { type: FirestoreValueType }) {
  return <Badge variant={VARIANT[type]}>{type}</Badge>
}
