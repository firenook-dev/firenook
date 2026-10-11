// A document's fields, one per line, as the rules page shows a document a
// request read or would have written: an update's changed fields marked.

import { Text } from '@cloudflare/kumo'
import { type FsValue, displayValue } from '../value'

/** A document's fields, one per line; an update's changed ones marked. */
export function FieldList({
  fields,
  changed,
  absent,
}: {
  fields: Record<string, FsValue> | null | undefined
  changed: string[] | undefined
  absent: string
}) {
  if (!fields) {
    return (
      <Text size="sm" variant="secondary">
        {absent}
      </Text>
    )
  }
  const entries = Object.entries(fields).toSorted(([left], [right]) => left.localeCompare(right))
  if (entries.length === 0) {
    return (
      <Text size="sm" variant="secondary">
        No fields.
      </Text>
    )
  }
  const marked = new Set(changed ?? [])
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
      {entries.map(([key, value]) => (
        <span key={key} className="contents">
          <dt className={`font-mono ${marked.has(key) ? 'text-kumo-warning' : 'text-kumo-subtle'}`}>
            {key}
          </dt>
          <dd
            className={`min-w-0 truncate font-mono ${
              marked.has(key) ? 'text-kumo-default' : 'text-kumo-default'
            }`}
            data-changed={marked.has(key) || undefined}
          >
            {displayValue(value)}
          </dd>
        </span>
      ))}
    </dl>
  )
}
