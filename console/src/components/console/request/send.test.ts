import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeBody, isTextual, sendComposed } from './send'
import type { ComposedRequest, ResponseRecord } from './types'

const request: ComposedRequest = {
  method: 'POST',
  url: '/console/api/v1/functions/native/demo-x/us-central1/stream',
  codeUrl: 'http://127.0.0.1:5001/demo-x/us-central1/stream',
  query: [{ key: 'n', value: '3', enabled: true }],
  headers: [{ key: 'x-trace', value: 'abc', enabled: true }],
  body: { kind: 'json', text: '{"a":1}' },
  identity: { kind: 'owner' },
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** A response whose body arrives in `parts`, one per macrotask. */
function streamed(parts: readonly string[], init: ResponseInit) {
  const encoder = new TextEncoder()
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      const part = parts[index]
      index += 1
      if (part === undefined) controller.close()
      else controller.enqueue(encoder.encode(part))
    },
  })
  return new Response(body, init)
}

describe('sending a composed request', () => {
  it('reports a chunked answer chunk by chunk with first-byte and total times', async () => {
    const fetch = vi.fn(async () =>
      streamed(['data: one\n\n', 'data: two\n\n', 'data: three\n\n'], {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const updates: ResponseRecord[] = []
    const record = await sendComposed(request, 'demo-x', {
      onUpdate: (partial) => updates.push(partial),
    })
    expect(updates.map((update) => update.chunks?.length)).toEqual([1, 2, 3])
    expect(updates.every((update) => update.receiving)).toBe(true)
    expect(record.receiving).toBeUndefined()
    expect(record.status).toBe(200)
    expect(record.bodyText).toBe('data: one\n\ndata: two\n\ndata: three\n\n')
    expect(record.chunks?.map((chunk) => chunk.text)).toEqual([
      'data: one\n\n',
      'data: two\n\n',
      'data: three\n\n',
    ])
    expect(record.firstByteMs).toBeGreaterThan(0)
    expect(record.durationMs).toBeGreaterThanOrEqual(record.firstByteMs ?? 0)
    expect(record.sizeBytes).toBe(35)
    // Sent same-origin with the query, the headers, the body's type, the
    // console marker and the identity's token.
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/console/api/v1/functions/native/demo-x/us-central1/stream?n=3')
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer owner')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-trace')).toBe('abc')
    expect(headers.get('x-firenook-console')).toBe('1')
    expect(init.body).toBe('{"a":1}')
  })

  it('records an aborted request as an error, not a throw', async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('partial'))
            init.signal?.addEventListener('abort', () =>
              stream.error(new DOMException('Aborted', 'AbortError')),
            )
          },
        })
        return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })
      }),
    )
    const sent = sendComposed(request, 'demo-x', {
      signal: controller.signal,
      onUpdate: () => controller.abort(),
    })
    const record = await sent
    expect(record.error).toBe('Stopped before the answer finished.')
    expect(record.status).toBe(200)
    expect(record.chunks?.[0]?.text).toBe('partial')
  })

  it('says a network failure in a sentence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    )
    const record = await sendComposed(request, 'demo-x')
    expect(record.status).toBe(0)
    expect(record.error).toBe('The request did not reach the engine: Failed to fetch')
  })

  it('keeps bytes as base64 and decodes a base64 body before sending', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    )
    vi.stubGlobal('fetch', fetch)
    const record = await sendComposed(
      { ...request, body: { kind: 'base64', text: 'AAEC' } },
      'demo-x',
    )
    expect(record.bodyBase64).toBe('iVBORwD/')
    expect(record.bodyText).toBeUndefined()
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(Array.from(init.body as Uint8Array)).toEqual([0, 1, 2])
    expect(encodeBody({ method: 'POST', body: { kind: 'base64', text: '***' } })).toEqual({
      error: 'The body is not base64. Paste the bytes as base64, or pick another body type.',
    })
    expect(encodeBody({ method: 'GET', body: { kind: 'json', text: '{}' } })).toEqual({})
  })

  it('lets a header the person set override the identity', async () => {
    const fetch = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await sendComposed(
      { ...request, headers: [{ key: 'Authorization', value: 'Bearer mine', enabled: true }] },
      'demo-x',
    )
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer mine')
  })

  it('knows text from bytes by the content type', () => {
    expect(isTextual('application/json; charset=utf-8')).toBe(true)
    expect(isTextual('application/vnd.api+json')).toBe(true)
    expect(isTextual('text/event-stream')).toBe(true)
    expect(isTextual('application/x-ndjson')).toBe(true)
    expect(isTextual('image/png')).toBe(false)
    expect(isTextual(undefined)).toBe(false)
  })
})
