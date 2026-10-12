// Every view is a link: a page keeps what it shows in its search params,
// read and written through one hook. `update` merges a patch and drops what
// is empty, so defaults never appear in the address and a link carries only
// what makes the view different. Generalized from the rules page's own
// `useRulesSearch`, which is now a one-line call to this.

import {
  type RegisteredRouter,
  type RouteIds,
  useNavigate,
  useSearch,
} from '@tanstack/react-router'
import { z } from 'zod'

type RouteId = RouteIds<RegisteredRouter['routeTree']>

/** `patch` over `previous`, with `undefined`, `''`, `false` and `[]` removed. */
export function mergeSearch(
  previous: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...previous, ...patch }
  for (const [key, value] of Object.entries(next))
    if (
      value === undefined ||
      value === '' ||
      value === false ||
      (Array.isArray(value) && value.length === 0)
    )
      delete next[key]
  return next
}

/** Search state for a route, with a patch-style updater that drops empty values. */
export function useRouteSearch<S extends Record<string, unknown>>(
  /** The route id: `'/auth'`, or `'/auth_/inbox'` for a sibling page. */
  routeId: RouteId,
  /** The path, for navigate(): `'/auth'`, `'/auth/inbox'`. */
  path: string,
): {
  search: S
  /** Merges `patch`; `undefined`, `''`, `false` and `[]` are removed. Pushes unless `replace`. */
  update: (patch: Partial<S>, options?: { replace?: boolean }) => void
} {
  const search = useSearch({ from: routeId }) as unknown as S
  // The route's own path, so the navigation stays on the page whatever
  // the caller's place in the tree.
  const navigate = useNavigate({ from: path as never })
  const update = (patch: Partial<S>, options?: { replace?: boolean }) =>
    void navigate({
      search: ((previous: Record<string, unknown>) =>
        mergeSearch(previous, patch as Record<string, unknown>)) as never,
      replace: options?.replace ?? false,
    })
  return { search, update }
}

/**
 * A flag: `?paused=true`, absent when false (`update` drops `false`, so the
 * flag in the address is always the state that differs from the default).
 */
export const zFlag = z.boolean().optional()

const SORT = /^[^:\s]+:(asc|desc)$/

/** A table's server-side order, `<column>:asc` or `<column>:desc`. */
export const zSort = z.string().regex(SORT).optional()

export function parseSort(
  raw: string | undefined,
): { column: string; direction: 'asc' | 'desc' } | undefined {
  if (!raw || !SORT.test(raw)) return undefined
  const at = raw.lastIndexOf(':')
  return { column: raw.slice(0, at), direction: raw.slice(at + 1) as 'asc' | 'desc' }
}

export function printSort(
  sort: { column: string; direction: 'asc' | 'desc' } | undefined,
): string | undefined {
  return sort ? `${sort.column}:${sort.direction}` : undefined
}
