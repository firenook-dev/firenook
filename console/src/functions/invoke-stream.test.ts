import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import type { InvocationFrame } from '@/api/generated/compute/InvocationFrame'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import { longRequests } from '@/lib/long-requests'
import {
  createLineSplitter,
  createResponseBuilder,
  invokeFunction,
  parseFrame,
  replayInvocation,
  sendTestEvent,
  stopWaiting,
  streamFrames,
} from './invoke-stream'

const summary = (overrides: Partial<InvocationSummary> = {}): InvocationSummary => ({
  id: 'a3f9c1-7',
  seq: 7,
  functionId: 'us-central1-api',
  codebase: 'default',
  kind: 'http',
  origin: 'console',
  cause: { type: 'http', method: 'GET', path: '/hello' },
  summary: 'GET /hello',
  startedAt: '2026-10-12T06:00:00.000Z',
  durationMs: null,
  outcome: null,
  outcomeClass: 'running',
  status: null,
  callableStatus: null,
  cold: false,
  attempt: 1,
  eventId: null,
  replayOf: null,
  logCount: 0,
  error: null,
  ...overrides,
})

const done = summary({
  durationMs: 8.1,
  outcome: 'succeeded',
  outcomeClass: 'succeeded',
  status: 200,
})

const line = (frame: InvocationFrame) => `${JSON.stringify(frame)}\n`

/** A response whose body arrives in these pieces, one read each. */
function streamed(pieces: readonly string[], status = 200): Response {
  const encoder = new TextEncoder()
  let at = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const piece = pieces[at]
        at += 1
        if (piece === undefined) controller.close()
        else controller.enqueue(encoder.encode(piece))
      },
    }),
    { status, headers: { 'content-type': 'application/x-ndjson' } },
  )
}

/** A response that never ends until the request is aborted. */
function hanging(signal: AbortSignal, first: string): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(first))
        signal.addEventListener('abort', () =>
          controller.error(new DOMException('Aborted', 'AbortError')),
        )
      },
    }),
    { status: 200 },
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  stopWaiting()
})

describe('reading frames', () => {
  it('cuts text into whole lines, holding a split frame until its newline', () => {
    const lines = createLineSplitter()
    expect(lines.push('{"frame":"st')).toEqual([])
    expect(lines.push('arted"}\n{"frame":"head"')).toEqual(['{"frame":"started"}'])
    expect(lines.push(',"status":200}\n\n')).toEqual(['{"frame":"head","status":200}'])
    expect(lines.push('{"frame":"finished"}')).toEqual([])
    expect(lines.end()).toEqual(['{"frame":"finished"}'])
    expect(lines.end()).toEqual([])
  })

  it('reads a frame, and nothing that is not one', () => {
    expect(parseFrame('{"frame":"truncated","total":5}')).toEqual({ frame: 'truncated', total: 5 })
    expect(parseFrame('{"total":5}')).toBeUndefined()
    expect(parseFrame('not json')).toBeUndefined()
  })
})

describe('an invoke stream', () => {
  it('hands each frame over as it arrives, frames split across reads included', async () => {
    const text = [
      line({ frame: 'started', invocation: summary() }),
      line({
        frame: 'head',
        status: 200,
        headers: [{ name: 'content-type', value: 'text/plain', sensitive: false }],
      }),
      line({ frame: 'chunk', text: 'one ', encoding: 'text' }),
      line({ frame: 'chunk', text: 'two', encoding: 'text' }),
      // The last frame without its newline: the stream's end delivers it.
      JSON.stringify({ frame: 'finished', invocation: done }),
    ].join('')
    const pieces = [text.slice(0, 17), text.slice(17, 160), text.slice(160)]
    const requests: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url, init })
        return streamed(pieces)
      }),
    )
    const frames: string[] = []
    const outcome = await invokeFunction(
      'us-central1-api',
      { target: 'url', method: 'GET', path: '/hello', headers: [], body: '', encoding: 'empty' },
      { onFrame: (frame) => frames.push(frame.frame) },
    )
    expect(frames).toEqual(['started', 'head', 'chunk', 'chunk', 'finished'])
    expect(outcome).toEqual({ stopped: false, started: summary(), finished: done })
    expect(requests[0]?.url).toBe('/console/api/v1/functions/us-central1-api/invoke')
    expect(requests[0]?.init.method).toBe('POST')
    const headers = new Headers(requests[0]?.init.headers)
    expect(headers.get('x-firenook-console')).toBe('1')
    expect(headers.get('accept')).toBe('application/x-ndjson')
    expect(longRequests.inUse()).toBe(0)
  })

  it('posts test events and replays to their own routes', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        return streamed([line({ frame: 'finished', invocation: done })])
      }),
    )
    await sendTestEvent('us-central1-onOrderCreated', { body: { data: {} }, headers: [] })
    await replayInvocation('a3f9c1-7')
    expect(urls).toEqual([
      '/console/api/v1/functions/us-central1-onOrderCreated/send-event',
      '/console/api/v1/functions/invocations/a3f9c1-7/replay',
    ])
  })

  it('says how it failed: a failed frame, a line that is not a frame, an early end', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamed([line({ frame: 'failed', message: 'The worker did not start.' })]),
      ),
    )
    expect(await streamFrames('/functions/x/invoke', {})).toEqual({
      stopped: false,
      failed: 'The worker did not start.',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamed(['oops\n'])),
    )
    expect((await streamFrames('/functions/x/invoke', {})).failed).toBe(
      'The engine sent a line that is not a frame; the stream was stopped.',
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamed([line({ frame: 'started', invocation: summary() })])),
    )
    expect((await streamFrames('/functions/x/invoke', {})).failed).toBe(
      'The stream ended before the invocation finished.',
    )
  })

  it('throws a refusal before the stream as the engine worded it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'not-found', message: 'There is no function us-central1-x.' },
            }),
            {
              status: 404,
            },
          ),
      ),
    )
    const error = await streamFrames('/functions/us-central1-x/invoke', {}).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      code: 'not-found',
      message: 'There is no function us-central1-x.',
    })
    expect(longRequests.inUse()).toBe(0)
  })

  it('keeps one per tab: a second stops waiting on the first, which the engine still finishes', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        calls += 1
        if (calls === 1)
          return hanging(
            init.signal as AbortSignal,
            line({ frame: 'started', invocation: summary() }),
          )
        return streamed([line({ frame: 'finished', invocation: done })])
      }),
    )
    const first = streamFrames('/functions/a/invoke', {})
    // The first is open and reading.
    await vi.waitFor(() => expect(calls).toBe(1))
    const second = await streamFrames('/functions/b/invoke', {})
    expect(await first).toEqual({ stopped: true, started: summary() })
    expect(second).toEqual({ stopped: false, finished: done })
    expect(longRequests.inUse()).toBe(0)
  })

  it("stops waiting on the caller's signal", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => hanging(init.signal as AbortSignal, '')),
    )
    const controller = new AbortController()
    const waiting = streamFrames('/functions/a/invoke', {}, { signal: controller.signal })
    await vi.waitFor(() => expect(longRequests.inUse()).toBe(1))
    controller.abort()
    expect(await waiting).toEqual({ stopped: true })
    expect(longRequests.inUse()).toBe(0)
  })
})

describe('the answer as the request kit shows it', () => {
  it('fills in as the frames come: head, chunks, then the end', () => {
    let clock = 0
    const builder = createResponseBuilder('2026-10-12T06:00:00.000Z', () => clock)
    builder.apply({ frame: 'started', invocation: summary() })
    clock = 3
    let record = builder.apply({
      frame: 'head',
      status: 200,
      headers: [
        { name: 'content-type', value: 'text/plain', sensitive: false },
        { name: 'set-cookie', value: null, sensitive: true },
      ],
    })
    expect(record).toMatchObject({
      status: 200,
      contentType: 'text/plain',
      headers: [
        ['content-type', 'text/plain'],
        ['set-cookie', ''],
      ],
      receiving: true,
    })
    clock = 5
    builder.apply({ frame: 'chunk', text: 'one ', encoding: 'text' })
    clock = 405
    record = builder.apply({ frame: 'chunk', text: 'two', encoding: 'text' })
    expect(record).toMatchObject({
      bodyText: 'one two',
      firstByteMs: 5,
      sizeBytes: 7,
      chunks: [
        { atMs: 5, text: 'one ' },
        { atMs: 405, text: 'two' },
      ],
    })
    record = builder.apply({ frame: 'finished', invocation: { ...done, durationMs: 406.2 } })
    expect(record.receiving).toBeUndefined()
    expect(record.durationMs).toBe(406.2)
  })

  it('keeps bytes as base64, says what was cut, and says a failure', () => {
    const builder = createResponseBuilder('2026-10-12T06:00:00.000Z', () => 0)
    builder.apply({ frame: 'head', status: 200, headers: [] })
    builder.apply({ frame: 'chunk', text: btoa('\u0000\u0001'), encoding: 'base64' })
    let record = builder.apply({ frame: 'chunk', text: btoa('ÿ'), encoding: 'base64' })
    expect(record.bodyBase64).toBe(btoa('\u0000\u0001ÿ'))
    expect(record.bodyText).toBeUndefined()
    record = builder.apply({ frame: 'truncated', total: 5_000_000 })
    expect(record).toMatchObject({ truncated: true, sizeBytes: 5_000_000 })
    record = builder.apply({ frame: 'failed', message: 'The function timed out after 60 s.' })
    expect(record.error).toBe('The function timed out after 60 s.')
  })

  it('takes the status from the finished invocation when no head came (a background function)', () => {
    const builder = createResponseBuilder('2026-10-12T06:00:00.000Z', () => 0)
    const record = builder.apply({ frame: 'finished', invocation: { ...done, status: 204 } })
    expect(record.status).toBe(204)
  })
})
