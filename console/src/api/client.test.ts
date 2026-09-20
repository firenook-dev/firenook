import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from './client'

function respond(status: number, body: string, contentType = 'application/json') {
  return new Response(body, { status, headers: { 'content-type': contentType } })
}

describe('the console API client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the status document relative to the console mount', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      respond(
        200,
        JSON.stringify({
          projectId: 'demo',
          engine: { name: 'Firenook', crateVersion: '0.0.1' },
          services: [],
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const status = await api.status()
    expect(status.projectId).toBe('demo')
    expect(fetchMock).toHaveBeenCalledWith('/console/api/v1/status', expect.objectContaining({}))
  })

  it('surfaces the engine error message on a JSON failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          respond(404, JSON.stringify({ error: { message: 'unknown console API route: /x' } })),
        ),
    )
    await expect(api.status()).rejects.toMatchObject({
      status: 404,
      message: 'unknown console API route: /x',
    })
  })

  it('falls back to the status line when the failure body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(503, '<h1>down</h1>', 'text/html')))
    const error = await api.status().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).message).toMatch(/^503/)
  })
})
