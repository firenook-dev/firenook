// The query line of the Tasks and History tabs (messaging spec §4.4, row
// three): the shared filter grammar with the task fields the engine serves
// (`name:`, `is:generated`, `is:console`, words in the payload), and what
// it matched, in a slot that never moves. Ticked rows lay their selection
// bar over this line.

import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef } from 'react'
import type { Total } from '@/api/generated/Total'
import { FilterField, type FilterFieldSpec } from '@/components/console/filter-field'
import { MatchCount } from '@/components/console/match-count'
import { ToolbarRow } from '@/components/console/toolbar'
import { checkFilter } from '@/lib/filter'
import { listMetaQuery } from '../queries'

/** How long typing settles before the URL follows it, ms. */
const SETTLE_MS = 250

/**
 * The task filter's fields until the engine's list metadata arrives: the
 * same specs (`messaging/tasks/filters.rs`), held to the golden file's by
 * a unit test, so the field never marks a valid filter while it loads.
 */
export const TASK_FIELDS: readonly FilterFieldSpec[] = [
  {
    key: 'name',
    aliases: ['id'],
    kind: 'exact',
    help: 'Task name, full or short (a trailing * matches the start)',
  },
  {
    key: 'is',
    kind: 'enum',
    help: 'Named by the emulator, or enqueued from the console',
    values: ['generated', 'console'],
  },
]

/** The task filter's fields, as the engine validates them. */
export function useTaskFields(project: string): readonly FilterFieldSpec[] {
  const meta = useQuery(listMetaQuery(project))
  return meta.data?.fields ?? TASK_FIELDS
}

/** `q` as a list may send it: undefined while it does not parse (the field says why). */
export function usableQuery(
  q: string | undefined,
  fields: readonly FilterFieldSpec[] | undefined,
): string | undefined {
  const text = q?.trim()
  if (!text) return undefined
  if (fields && !checkFilter(text, { fields }).ok) return undefined
  return text
}

export function FilterLine({
  q,
  onQuery,
  fields,
  total,
  loading,
  noun,
  placeholder,
  aside,
  overlay,
  testId,
}: {
  q: string | undefined
  /** The settled text, for the URL (`replace: true`). */
  onQuery: (q: string | undefined) => void
  fields: readonly FilterFieldSpec[] | undefined
  total: Total | undefined
  loading: boolean
  noun: { one: string; other: string }
  placeholder: string
  /** A switch beside the count (the tab's, when row two has no room). */
  aside?: ReactNode
  overlay?: ReactNode
  testId: string
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const invalid = q !== undefined && q.trim() !== '' && usableQuery(q, fields) === undefined
  return (
    <ToolbarRow variant="line" overlay={overlay} testId={testId}>
      <FilterField
        value={q ?? ''}
        onChange={(text) => {
          clearTimeout(timer.current)
          timer.current = setTimeout(
            () => onQuery(text.trim() === '' ? undefined : text),
            SETTLE_MS,
          )
        }}
        fields={fields ?? TASK_FIELDS}
        placeholder={placeholder}
        ariaLabel={`Filter ${noun.other}`}
        testId={`${testId}-field`}
      />
      {aside && <span className="flex shrink-0 items-center">{aside}</span>}
      <MatchCount
        total={total}
        noun={noun}
        loading={loading}
        widest="00,000"
        hidden={invalid}
        testId={`${testId}-count`}
      />
    </ToolbarRow>
  )
}
