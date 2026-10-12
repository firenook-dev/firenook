import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UploadTransport } from './api'
import { useUploadQueue } from './upload-queue-store'
import {
  type UploadPlan,
  cancelUpload,
  createRequest,
  enqueueUploads,
  failureOf,
  keepBothName,
  resolveConflicts,
  retryUpload,
  setUploadTransport,
} from './uploads'
import { StorageApiError } from './api'

vi.mock('./api', async (original) => {
  const real = await original<typeof import('./api')>()
  return {
    ...real,
    evaluateRules: vi.fn(async (body: { requests: { path: string }[] }) => ({
      results: body.requests.map((request) => ({
        outcome: request.path.endsWith('.mov') ? 'deny' : 'allow',
        error: null,
        allows: request.path.endsWith('.mov') ? [{ line: 6, from: 0, to: 1, outcome: 'deny' }] : [],
        explanation: [],
        truncated: false,
        documentAccesses: 0,
        documentAccessLimit: 0,
        resource: null,
        requestResource: null,
        changedKeys: null,
      })),
    })),
  }
})

/** A fake XHR the test drives: each one waits until `finish` or `abort`. */
class FakeRequest implements UploadTransport {
  static open: FakeRequest[] = []
  static all: FakeRequest[] = []
  headers: Record<string, string> = {}
  url = ''
  status = 0
  statusText = ''
  responseText = ''
  private listeners: Record<string, () => void> = {}
  private progress:
    | ((event: { loaded: number; total: number; lengthComputable: boolean }) => void)
    | undefined
  upload = {
    addEventListener: (
      _type: 'progress',
      listener: (event: { loaded: number; total: number; lengthComputable: boolean }) => void,
    ) => {
      this.progress = listener
    },
  }
  open(_method: string, url: string) {
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  send() {
    FakeRequest.open.push(this)
    FakeRequest.all.push(this)
  }
  abort() {
    FakeRequest.open = FakeRequest.open.filter((request) => request !== this)
    this.listeners.abort?.()
  }
  addEventListener(type: 'load' | 'error' | 'abort', listener: () => void) {
    this.listeners[type] = listener
  }
  report(loaded: number, total: number) {
    this.progress?.({ loaded, total, lengthComputable: true })
  }
  finish(status = 200, body: unknown = {}) {
    FakeRequest.open = FakeRequest.open.filter((request) => request !== this)
    this.status = status
    this.responseText = JSON.stringify(body)
    this.listeners.load?.()
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

function plan(name: string, size = 10): UploadPlan {
  return { file: new Blob(['x'.repeat(size)]), name, size, contentType: 'text/plain', metadata: {} }
}

const context = { bucket: 'b', project: 'demo', viewAs: { kind: 'owner' as const } }

beforeEach(() => {
  FakeRequest.open = []
  FakeRequest.all = []
  setUploadTransport(() => new FakeRequest())
  useUploadQueue.setState({
    items: [],
    totals: { files: 0, bytes: 0, finished: 0, sentBytes: 0 },
    open: false,
    collapsed: false,
  })
})
afterEach(async () => {
  // Every request still open gives its slot back before the next test.
  for (const request of FakeRequest.open) request.abort()
  await settle()
  setUploadTransport(undefined)
})

describe('keeping both', () => {
  it('names the new file after the first free number, keeping the extension', () => {
    expect(keepBothName('a.png', new Set(['a.png']))).toBe('a (1).png')
    expect(keepBothName('a.png', new Set(['a.png', 'a (1).png']))).toBe('a (2).png')
    expect(keepBothName('dir/Makefile', new Set())).toBe('dir/Makefile (1)')
    expect(keepBothName('.env', new Set())).toBe('.env (1)')
  })

  it('replaces, skips or renames taken names for a whole drop', () => {
    const plans = [plan('a.png'), plan('b.png')]
    const existing = new Set(['a.png'])
    expect(resolveConflicts(plans, existing, 'replace').send.map((item) => item.name)).toEqual([
      'a.png',
      'b.png',
    ])
    const skipped = resolveConflicts(plans, existing, 'skip')
    expect(skipped.send.map((item) => item.name)).toEqual(['b.png'])
    expect(skipped.skipped.map((item) => item.name)).toEqual(['a.png'])
    expect(resolveConflicts(plans, existing, 'keep').send.map((item) => item.name)).toEqual([
      'a (1).png',
      'b.png',
    ])
  })
})

describe('the upload queue', () => {
  it('sends at most three at once, the rest as slots free', async () => {
    await enqueueUploads([plan('1'), plan('2'), plan('3'), plan('4')], context)
    await settle()
    expect(FakeRequest.open).toHaveLength(3)
    FakeRequest.open[0]?.finish(200, { name: '1' })
    await settle()
    expect(FakeRequest.open).toHaveLength(3)
    expect(useUploadQueue.getState().items.filter((item) => item.state === 'done')).toHaveLength(1)
  })

  it('marks every request as the console’s and as the identity', async () => {
    await enqueueUploads([plan('a.txt')], context)
    await settle()
    const request = FakeRequest.all[0]
    expect(request?.headers['x-firenook-console']).toBe('1')
    expect(request?.headers.authorization).toBe('Bearer owner')
    expect(request?.headers['content-type']).toBe('text/plain')
  })

  it('reports progress and finishes with the size', async () => {
    await enqueueUploads([plan('a.txt', 100)], context)
    await settle()
    FakeRequest.open[0]?.report(100, 100)
    expect(useUploadQueue.getState().items[0]?.loaded).toBe(100)
    FakeRequest.open[0]?.finish()
    await settle()
    expect(useUploadQueue.getState().items[0]).toMatchObject({ state: 'done', loaded: 100 })
    expect(useUploadQueue.getState().totals.sentBytes).toBe(100)
  })

  it('cancels, and sends a cancelled upload again', async () => {
    await enqueueUploads([plan('a.txt')], context)
    await settle()
    const id = useUploadQueue.getState().items[0]?.id ?? ''
    cancelUpload(id)
    await settle()
    expect(useUploadQueue.getState().items[0]?.state).toBe('cancelled')
    retryUpload(id)
    await settle()
    expect(FakeRequest.open).toHaveLength(1)
    expect(useUploadQueue.getState().items[0]?.state).toBe('uploading')
  })

  it('dry-runs a client’s drop and never sends what the rules refuse', async () => {
    await enqueueUploads([plan('ok.png'), plan('big.mov')], {
      ...context,
      viewAs: { kind: 'anonymous' },
    })
    await settle()
    expect(FakeRequest.all.map((request) => request.url)).toEqual([
      expect.stringContaining('name=ok.png'),
    ])
    const refused = useUploadQueue.getState().items.find((item) => item.name === 'big.mov')
    expect(refused).toMatchObject({ state: 'refused', notSent: true, line: 6 })
    expect(refused?.message).toBe('Refused by line 6 — not sent')
  })

  it('lists skipped files as skipped', async () => {
    await enqueueUploads([], context, [plan('a.png')])
    expect(useUploadQueue.getState().items[0]).toMatchObject({
      state: 'skipped',
      message: 'Already exists — skipped',
    })
  })
})

describe('what a failed upload says', () => {
  it('tells a cancel, a refusal, a taken name and a failure apart', () => {
    expect(failureOf(new DOMException('x', 'AbortError')).state).toBe('cancelled')
    expect(
      failureOf(new StorageApiError(403, 'no', 'permission-denied', undefined, { line: 5 })),
    ).toMatchObject({ state: 'refused', line: 5, message: 'Refused by line 5' })
    expect(
      failureOf(new StorageApiError(409, 'taken', 'already-exists', undefined, {})).state,
    ).toBe('skipped')
    expect(failureOf(new Error('Disk full')).message).toBe('Disk full')
  })

  it('judges a planned upload as the create the SDK would send', () => {
    expect(
      createRequest(
        { ...plan('a.png', 7), metadata: { cacheControl: 'no-cache', customMetadata: { k: 'v' } } },
        'b',
        'Bearer t',
      ),
    ).toEqual({
      method: 'create',
      bucket: 'b',
      path: 'a.png',
      authorization: 'Bearer t',
      proposed: {
        size: 7,
        contentType: 'text/plain',
        cacheControl: 'no-cache',
        customMetadata: { k: 'v' },
      },
    })
  })
})
