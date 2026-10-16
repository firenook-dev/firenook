// Calls straight to an engine, as an app or a test harness would, for what a
// journey sets up or checks behind the page's back.

/**
 * `fetch` to the console API (`/console/api/v1/...`) or a native mount on
 * the engine's console origin, as the owner: `Authorization: Bearer owner`,
 * a JSON body and the console's own header, which the request guard asks of
 * every change.
 */
export function ownerFetch(
  engine: { origin: string },
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has('authorization')) headers.set('authorization', 'Bearer owner')
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  if (!headers.has('x-firenook-console')) headers.set('x-firenook-console', '1')
  const url = path.startsWith('/console/')
    ? path
    : `/console/api/v1${path.startsWith('/') ? '' : '/'}${path}`
  return fetch(`${engine.origin}${url}`, { ...init, headers })
}
