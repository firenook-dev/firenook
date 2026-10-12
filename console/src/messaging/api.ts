// What the Pub/Sub and Cloud Tasks API clients share: a route with its query
// string, and where a cursor page starts.

type Params = Record<string, string | number | boolean | undefined>

/** `path` with `params` as its query string; `undefined` and `''` are left out. */
export function withQuery(path: string, params: Params): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== '') search.set(key, String(value))
  return search.size > 0 ? `${path}?${search}` : path
}

/** Where a cursor page starts (the first page has neither), and how long it is. */
export interface PageAt {
  cursor?: string | undefined
  before?: string | undefined
  limit?: number | undefined
}
