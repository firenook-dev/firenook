// The project's databases: `(default)`, whatever firebase.json declares,
// and whatever a client has written to. The list is asked for when the
// panel mounts and again each time the picker opens, so a database a
// client created a moment ago is there when you look for it.

import { queryOptions } from '@tanstack/react-query'
import { API_BASE, ApiError } from '@/api/client'
import type { DatabaseInfo } from '@/api/generated/DatabaseInfo'
import type { DatabaseList } from '@/api/generated/DatabaseList'

export type { DatabaseInfo, DatabaseList }

// Its own key, outside the per-database `fs` keys the live channel sweeps.
export const databasesQuery = queryOptions({
  queryKey: ['databases'],
  queryFn: async () => {
    const response = await fetch(`${API_BASE}/firestore/databases`, {
      headers: { accept: 'application/json' },
    })
    if (!response.ok)
      throw new ApiError(response.status, `${response.status} ${response.statusText}`)
    return (await response.json()) as DatabaseList
  },
  retry: false,
})

/**
 * The picker's items: every listed database, plus the one on screen when
 * it is not listed (a typed URL), so the control always shows its value.
 */
export function databaseItems(
  list: DatabaseList | undefined,
  current: string,
  fallback: string,
): Record<string, string> {
  const ids = list?.databases.map((database) => database.id) ?? [fallback]
  if (!ids.includes(current)) ids.push(current)
  return Object.fromEntries(ids.map((id) => [id, id]))
}
