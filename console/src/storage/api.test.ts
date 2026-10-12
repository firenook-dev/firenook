import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { RulesCompileError } from '@/rules/text'
import {
  STORAGE_API,
  StorageApiError,
  type UploadTransport,
  encodeMetadataHeader,
  exportUrl,
  getDecision,
  getObject,
  isFastPath,
  listObjects,
  mediaUrl,
  previewBulk,
  queryString,
  startBulk,
  storageError,
  thumbnailUrl,
  uploadHeaders,
  uploadObject,
} from './api'

afterEach(() => vi.unstubAllGlobals())

/** The engine's answers, in order, and what each request was. */
function answering(...answers: Array<{ status: number; body?: unknown }>) {
  const requests: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    const answer = answers.shift() ?? { status: 200, body: {} }
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
    })
  })
  return requests
}

function decode(header: string): unknown {
  const base64 = header.slice('b64.'.length).replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))))
}

describe('the upload metadata header', () => {
  it('is b64. and the base64url of the JSON, so any text survives a header', () => {
    const header = encodeMetadataHeader({
      cacheControl: 'public, max-age=3600',
      customMetadata: { place: 'été', ownerUid: 'u_9f3k2' },
    })
    expect(header).toMatch(/^b64\.[A-Za-z0-9_-]+$/)
    expect(decode(header)).toEqual({
      cacheControl: 'public, max-age=3600',
      customMetadata: { place: 'été', ownerUid: 'u_9f3k2' },
    })
  })

  it('leaves out what is not set, and goes out only when something is', () => {
    expect(decode(encodeMetadataHeader({ customMetadata: {} }))).toEqual({})
    expect(uploadHeaders({ bucket: 'b', name: 'a.png', metadata: {} })).not.toHaveProperty(
      'x-firenook-metadata',
    )
  })
})

describe('an upload’s request', () => {
  it('carries the type, the console header, who asks and what it asks for', () => {
    expect(
      uploadHeaders({
        bucket: 'b',
        name: 'a.png',
        contentType: 'image/png',
        metadata: { contentLanguage: 'en' },
        ifNoneMatch: true,
        keepTokens: true,
        authorization: 'Bearer token',
      }),
    ).toEqual({
      accept: 'application/json',
      'content-type': 'image/png',
      'x-firenook-console': '1',
      authorization: 'Bearer token',
      'x-firenook-metadata': encodeMetadataHeader({ contentLanguage: 'en' }),
      'if-none-match': '*',
      'x-firenook-keep-tokens': 'true',
    })
    expect(uploadHeaders({ bucket: 'b', name: 'x' })['content-type']).toBe(
      'application/octet-stream',
    )
  })
})

/** An XHR stand-in that answers when the test says. */
function fakeTransport() {
  const sent: { method?: string; url?: string; headers: Record<string, string>; body?: unknown } = {
    headers: {},
  }
  const listeners = new Map<string, Array<(event?: never) => void>>()
  const on = (type: string, listener: (event?: never) => void) =>
    listeners.set(type, [...(listeners.get(type) ?? []), listener])
  const fire = (type: string, event?: unknown) => {
    for (const listener of listeners.get(type) ?? []) (listener as (event?: unknown) => void)(event)
  }
  const transport: UploadTransport & {
    answer(status: number, body?: unknown): void
    progress(loaded: number, total: number): void
  } = {
    status: 0,
    statusText: '',
    responseText: '',
    upload: { addEventListener: (type, listener) => on(`upload:${type}`, listener as never) },
    addEventListener: (type, listener) => on(type, listener),
    open(method, url) {
      sent.method = method
      sent.url = url
    },
    setRequestHeader(name, value) {
      sent.headers[name] = value
    },
    send(body) {
      sent.body = body
    },
    abort() {
      fire('abort')
    },
    answer(status, body) {
      Object.assign(this, { status, responseText: body === undefined ? '' : JSON.stringify(body) })
      fire('load')
    },
    progress(loaded, total) {
      fire('upload:progress', { loaded, total, lengthComputable: true })
    },
  }
  return { transport, sent }
}

describe('uploading a file', () => {
  it('streams it with progress and answers the stored object', async () => {
    const { transport, sent } = fakeTransport()
    const progress: number[] = []
    const done = uploadObject(
      'bytes',
      { bucket: 'demo-media', name: 'banners/a b.png', contentType: 'image/png' },
      { transport: () => transport, onProgress: (loaded) => progress.push(loaded) },
    )
    transport.progress(2, 5)
    transport.progress(5, 5)
    transport.answer(200, { name: 'banners/a b.png', generation: '7' })
    await expect(done).resolves.toMatchObject({ generation: '7' })
    expect(progress).toEqual([2, 5])
    expect(sent.method).toBe('PUT')
    expect(sent.url).toBe(`${STORAGE_API}/object?bucket=demo-media&name=banners%2Fa+b.png`)
    expect(sent.headers['x-firenook-console']).toBe('1')
  })

  it('rejects with the refusal and its explanation', async () => {
    const { transport } = fakeTransport()
    const done = uploadObject(
      'x',
      { bucket: 'b', name: 'users/u2/a.png' },
      { transport: () => transport },
    )
    transport.answer(403, {
      error: {
        code: 'permission-denied',
        message: 'Permission denied.',
        fix: 'Line 6 refused it.',
      },
      decision: 's12',
      line: 6,
      noRuleset: false,
      evaluation: { outcome: 'deny' },
      request: { method: 'create', bucket: 'b', path: 'users/u2/a.png' },
    })
    const error = await done.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(StorageApiError)
    expect(error).toMatchObject({
      status: 403,
      code: 'permission-denied',
      refused: true,
      fix: 'Line 6 refused it.',
      extras: { decision: 's12', line: 6, noRuleset: false, request: { method: 'create' } },
    })
  })

  it('stops when cancelled, and never starts once cancelled', async () => {
    const { transport } = fakeTransport()
    const controller = new AbortController()
    const done = uploadObject(
      'x',
      { bucket: 'b', name: 'a' },
      { transport: () => transport, signal: controller.signal },
    )
    controller.abort()
    await expect(done).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      uploadObject(
        'x',
        { bucket: 'b', name: 'a' },
        { transport: () => transport, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('a Storage error', () => {
  it('keeps every extra the engine sent beside the message', () => {
    const error = storageError(412, 'Precondition Failed', {
      error: { code: 'failed-precondition', message: 'This file changed since you opened it.' },
      current: '5',
    })
    expect(error).toMatchObject({ code: 'failed-precondition', extras: { current: '5' } })
  })

  it('is the rules kit’s compile error for a draft that does not compile', () => {
    const error = storageError(400, 'Bad Request', {
      error: { code: 'invalid-argument', message: 'The rules do not compile.' },
      diagnostics: [
        {
          severity: 'error',
          message: "expected '{'",
          line: 2,
          column: 1,
          from: 3,
          to: 3,
          code: null,
        },
      ],
    })
    expect(error).toBeInstanceOf(RulesCompileError)
  })

  it('says the engine did not answer when it did not', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))
    await expect(getObject('b', 'a')).rejects.toMatchObject({ code: 'network' })
  })
})

describe('the routes', () => {
  it('list a folder with only what differs from the defaults, as the identity asks', async () => {
    const requests = answering({ status: 200, body: { items: [] } })
    await listObjects(
      { bucket: 'b', prefix: 'users/', flat: true, kind: 'all', sort: 'name:asc', q: '  ' },
      { cursor: 'v1.abc' },
      { authorization: 'Bearer owner' },
    )
    expect(requests[0]?.url).toBe(
      `${STORAGE_API}/objects?bucket=b&prefix=users%2F&flat=true&cursor=v1.abc`,
    )
    expect(new Headers(requests[0]?.init.headers).get('authorization')).toBe('Bearer owner')
    expect(new Headers(requests[0]?.init.headers).get('x-firenook-console')).toBe('1')
  })

  it('preview bulk work without starting it, and start it as a job', async () => {
    const requests = answering(
      { status: 200, body: { objects: 3, bytes: 9, folders: 1, conflicts: 0, conflictSample: [] } },
      { status: 202, body: { id: 'j1', kind: 'storage.delete' } },
    )
    const body = {
      bucket: 'b',
      target: { by: 'keys' as const, keys: ['users/'] },
      onConflict: 'skip' as const,
    }
    await expect(previewBulk('delete', body)).resolves.toMatchObject({ objects: 3 })
    await expect(startBulk('delete', body)).resolves.toMatchObject({ id: 'j1' })
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({ dryRun: true })
    expect(JSON.parse(String(requests[1]?.init.body))).toMatchObject({ dryRun: false })
    expect(requests[1]?.url).toBe(`${STORAGE_API}/objects:delete`)
  })

  it('answer null for a decision the engine no longer keeps', async () => {
    answering({ status: 404, body: { error: { code: 'not-found', message: 'gone' } } })
    await expect(getDecision('s1')).resolves.toBeNull()
    answering({ status: 503, body: { error: { code: 'unavailable', message: 'off' } } })
    await expect(getDecision('s1')).rejects.toBeInstanceOf(ApiError)
  })

  it('build the plain URLs an img, a video and a download link take', () => {
    expect(mediaUrl({ bucket: 'b', name: 'a/x.png', generation: '3', download: true })).toBe(
      `${STORAGE_API}/object/media?bucket=b&name=a%2Fx.png&g=3&download=1`,
    )
    expect(thumbnailUrl({ bucket: 'b', name: 'x.png', generation: '3' })).toBe(
      `${STORAGE_API}/object/thumbnail?bucket=b&name=x.png&g=3&w=320`,
    )
    expect(exportUrl('b')).toBe(`${STORAGE_API}/objects:export?bucket=b`)
    expect(exportUrl('b', 'users/')).toBe(`${STORAGE_API}/objects:export?bucket=b&prefix=users%2F`)
  })

  it('tell a listing by name from a view', () => {
    expect(isFastPath({})).toBe(true)
    expect(isFastPath({ sort: 'name:asc', q: ' ' })).toBe(true)
    expect(isFastPath({ sort: 'size:desc' })).toBe(false)
    expect(isFastPath({ q: 'type:image/*' })).toBe(false)
    expect(queryString({ a: undefined, b: null })).toBe('')
  })
})
