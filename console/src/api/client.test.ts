import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, apiGet, apiSend, nativeFetch, parseErrorBody } from './client'

function respond(status: number, body: string, contentType = 'application/json') {
  return new Response(body, { status, headers: { 'content-type': contentType } })
}

function answering(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>): Headers {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
  return new Headers(init?.headers)
}

describe('the console API client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the status document relative to the console mount', async () => {
    const fetchMock = answering(
      respond(
        200,
        JSON.stringify({
          projectId: 'demo',
          engine: { name: 'Firenook', version: '0.2.0-next.2', revision: null },
          services: [],
        }),
      ),
    )
    const status = await api.status()
    expect(status.projectId).toBe('demo')
    expect(fetchMock).toHaveBeenCalledWith('/console/api/v1/status', expect.objectContaining({}))
  })

  it('reads the code, message and fix of the console’s own error body', async () => {
    answering(
      respond(
        503,
        JSON.stringify({
          error: {
            code: 'starting',
            message: 'Functions is still starting.',
            fix: 'This page fills in by itself when it is ready.',
          },
        }),
      ),
    )
    await expect(api.status()).rejects.toMatchObject({
      status: 503,
      code: 'starting',
      message: 'Functions is still starting.',
      fix: 'This page fills in by itself when it is ready.',
    })
  })

  it('maps Google’s numeric code by its status', async () => {
    answering(
      respond(
        404,
        JSON.stringify({ error: { code: 404, message: 'no doc', status: 'NOT_FOUND' } }),
      ),
    )
    await expect(api.status()).rejects.toMatchObject({
      status: 404,
      code: 'not-found',
      message: 'no doc',
      fix: undefined,
    })
  })

  it.each([
    ['NOT_FOUND', 'not-found'],
    ['ALREADY_EXISTS', 'already-exists'],
    ['FAILED_PRECONDITION', 'failed-precondition'],
    ['ABORTED', 'failed-precondition'],
    ['INVALID_ARGUMENT', 'invalid-argument'],
    ['OUT_OF_RANGE', 'invalid-argument'],
    ['PERMISSION_DENIED', 'permission-denied'],
    ['UNAUTHENTICATED', 'permission-denied'],
    ['RESOURCE_EXHAUSTED', 'resource-exhausted'],
    ['UNAVAILABLE', 'unavailable'],
    ['UNIMPLEMENTED', 'unknown'],
    ['INTERNAL', 'unknown'],
    ['UNKNOWN', 'unknown'],
    ['DATA_LOSS', 'unknown'],
  ])('maps Google’s %s to %s', (status, code) => {
    const parsed = parseErrorBody(400, {
      error: { code: 400, message: 'the service said', status },
    })
    expect(parsed).toEqual({ code, message: 'the service said' })
  })

  it('treats a numeric code without a status, and an unknown string code, as unknown', () => {
    expect(parseErrorBody(500, { error: { code: 500, message: 'boom' } })).toEqual({
      code: 'unknown',
      message: 'boom',
    })
    expect(parseErrorBody(400, { error: { code: 'unsupported', message: 'no' } })).toEqual({
      code: 'unknown',
      message: 'no',
    })
    expect(parseErrorBody(418, null).code).toBe('unknown')
    expect(parseErrorBody(418, { error: 'teapot' }).code).toBe('unknown')
  })

  it('reads a non-JSON body as unknown with the status line', async () => {
    answering(respond(503, '<h1>down</h1>', 'text/html'))
    const error = await api.status().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('unknown')
    expect((error as ApiError).message).toMatch(/^503/)
  })

  it('reports a failed fetch as a network error, and lets an abort through', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const error = await apiGet('/status').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 0, code: 'network' })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError')),
    )
    const aborted = await apiGet('/status').catch((caught: unknown) => caught)
    expect(aborted).not.toBeInstanceOf(ApiError)
    expect((aborted as DOMException).name).toBe('AbortError')
  })

  it('leaves undefined parameters out of a GET', async () => {
    const fetchMock = answering(respond(200, '{}'))
    await apiGet('/search', { q: 'ada lovelace', limit: 5, tenant: undefined })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/console/api/v1/search?q=ada+lovelace&limit=5')
  })

  it('sends {} as the JSON body of a change without one, with the console header', async () => {
    const fetchMock = answering(respond(200, '{"ok":true}'))
    await expect(apiSend('POST', '/jobs/j1/cancel', undefined)).resolves.toEqual({ ok: true })
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/console/api/v1/jobs/j1/cancel')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{}')
    const headers = sentHeaders(fetchMock)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-firenook-console')).toBe('1')
  })

  it('names the origin of a change in the console header when asked to', async () => {
    const fetchMock = answering(new Response(null, { status: 204 }))
    await expect(
      apiSend('DELETE', '/auth/users/u1', { tenant: null }, { origin: 'write' }),
    ).resolves.toBeUndefined()
    expect(sentHeaders(fetchMock).get('x-firenook-console')).toBe('write')
  })

  it('sends a native call once under the mount, with the console header unless set', async () => {
    const fetchMock = answering(respond(200, '{}'))
    await nativeFetch('/firestore/v1/projects/p/databases/(default)/documents:commit', {
      method: 'POST',
      body: '{}',
    })
    await nativeFetch('/console/api/v1/storage/native/b/x/o', { method: 'GET' })
    await nativeFetch('storage/native/b', { headers: { 'x-firenook-console': 'try' } })
    expect(fetchMock.mock.calls.map((call) => call[0] as string)).toEqual([
      '/console/api/v1/firestore/v1/projects/p/databases/(default)/documents:commit',
      '/console/api/v1/storage/native/b/x/o',
      '/console/api/v1/storage/native/b',
    ])
    const headers = fetchMock.mock.calls.map((call) =>
      new Headers((call[1] as RequestInit).headers).get('x-firenook-console'),
    )
    expect(headers).toEqual(['1', '1', 'try'])
  })

  it('parses a native call’s Google error the same way', async () => {
    answering(
      respond(
        409,
        JSON.stringify({ error: { code: 409, message: 'exists', status: 'ALREADY_EXISTS' } }),
      ),
    )
    await expect(nativeFetch('/firestore/v1/x', { method: 'POST' })).rejects.toMatchObject({
      status: 409,
      code: 'already-exists',
      message: 'exists',
    })
  })
})
