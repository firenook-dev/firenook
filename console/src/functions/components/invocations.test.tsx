import { describe, expect, it } from 'vitest'
import type { InvocationDetail } from '@/api/generated/compute/InvocationDetail'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import { createFeedStore } from '@/lib/live/feed-store'
import { invocation } from '../fixtures.test-support'
import { causeRefs, refLabel } from './invocation-actions'
import { errorText, eventAttributes, frameOf, frameUrl, invocationCurl } from './invocation-detail'
import { kept, neighbour } from './invocation-list'
import { regionOfId, shortFunction } from './invocation-row'
import { bodyJson, headerItems } from './request-view'

function detail(fields: Partial<InvocationDetail> = {}): InvocationDetail {
  return {
    summary: invocation(9),
    request: {
      target: 'url',
      method: 'POST',
      path: '/orders?x=1',
      headers: [
        { name: 'authorization', value: null, sensitive: true },
        { name: 'x-demo', value: "it's", sensitive: false },
        { name: 'host', value: '127.0.0.1:5001', sensitive: false },
      ],
      contentType: 'application/json',
      body: { size: 7, truncated: false, encoding: 'text', text: '{"n":1}' },
    },
    response: null,
    event: null,
    logs: [],
    logsDropped: 0,
    timings: { workerStartMs: null, firstByteMs: 1, totalMs: 2 },
    replayable: true,
    notReplayable: null,
    liveCursor: '0.0',
    ...fields,
  }
}

describe('an invocation in the console', () => {
  it('links the project frames of a stack to the chosen editor', () => {
    const frame = frameOf('    at handler (/work/app/functions/index.js:42:11)')
    expect(frame).toMatchObject({ path: '/work/app/functions/index.js', line: '42', column: '11' })
    expect(
      frameOf('    at Module._compile (node:internal/modules/cjs/loader:1903:20)'),
    ).toBeUndefined()
    expect(frameOf('    at x (/work/app/functions/node_modules/lib/a.js:1:2)')).toBeUndefined()
    expect(frameUrl('vscode', '/a/b.js', '3', '4')).toBe('vscode://file/a/b.js:3:4')
    expect(frameUrl('cursor', '/a/b.js', '3', '4')).toBe('cursor://file/a/b.js:3:4')
    expect(frameUrl('none', '/a/b.js', '3', '4')).toBeUndefined()
  })

  it("says the error: the handler's own line, the summary's, or what the function answered", () => {
    const thrown = detail({
      logs: [
        {
          index: 0,
          at: '',
          offsetMs: 1,
          level: 'error',
          message: 'logged first',
          kind: null,
          fields: null,
          afterFinish: false,
        },
        {
          index: 1,
          at: '',
          offsetMs: 2,
          level: 'error',
          message: 'Error: boom\n    at x',
          kind: 'function.error',
          fields: null,
          afterFinish: false,
        },
      ],
    })
    expect(errorText(thrown)).toBe('Error: boom\n    at x')
    expect(errorText(detail({ summary: invocation(1, { error: 'Timed out after 60 s' }) }))).toBe(
      'Timed out after 60 s',
    )
    const answered = detail({
      summary: invocation(2, { outcome: 'failed', outcomeClass: 'failed', status: 500 }),
      response: {
        status: 500,
        headers: [],
        contentType: 'text/plain',
        body: { size: 4, truncated: false, encoding: 'text', text: 'boom' },
        chunks: 1,
        streaming: false,
        clientGone: false,
      },
    })
    expect(errorText(answered)).toBe('The function answered 500.\nboom')
    expect(errorText(detail())).toBeUndefined()
  })

  it("reads a CloudEvent's attributes apart from its data", () => {
    expect(eventAttributes({ specversion: '1.0', type: 't', id: 'e1', data: { a: 1 } })).toEqual([
      { label: 'specversion', value: '1.0', copy: '1.0' },
      { label: 'type', value: 't', copy: 't' },
      { label: 'id', value: 'e1', copy: 'e1' },
    ])
    expect(eventAttributes({ value: {}, oldValue: {} })).toBeUndefined()
  })

  it('copies a URL invocation as curl without what the engine or a secret added', () => {
    expect(invocationCurl(detail(), 'http://127.0.0.1:5001/p/us-central1/api')).toBe(
      "curl -X POST 'http://127.0.0.1:5001/p/us-central1/api/orders?x=1' \\\n  -H 'x-demo: it'\\''s' \\\n  --data-raw '{\"n\":1}'",
    )
    expect(
      invocationCurl(detail({ request: { ...detail().request, target: 'trigger' } }), 'http://h'),
    ).toBeUndefined()
  })

  it('masks a sensitive header and reveals it through the engine', () => {
    const items = headerItems('a3f9c1-9', detail().request.headers)
    expect(items[0]).toMatchObject({ label: 'authorization', masked: true })
    expect(typeof items[0]?.reveal).toBe('function')
    expect(items[1]).toMatchObject({ label: 'x-demo', value: "it's", copy: "it's" })
    expect(bodyJson(detail().request.body, 'application/json')).toEqual({ value: { n: 1 } })
    expect(
      bodyJson({ size: 3, truncated: true, encoding: 'text', text: '{"' }, 'application/json'),
    ).toBeUndefined()
  })

  it('names what caused it in words', () => {
    expect(refLabel({ kind: 'firestore.document', key: '(default)|orders/o1' })).toBe('orders/o1')
    expect(refLabel({ kind: 'storage.object', key: 'b|a.png' })).toBe('gs://b/a.png')
    expect(refLabel({ kind: 'pubsub.message', key: 'projects/p/topics/emails|7' })).toBe(
      'message 7 on emails',
    )
    expect(refLabel({ kind: 'tasks.task', key: 'p|us-central1|resize|42' })).toBe('task 42')
    expect(refLabel({ kind: 'auth.user', key: '|u_1', label: 'Ada' })).toBe('Ada')
    expect(
      causeRefs([
        { kind: 'functions.function', key: 'us-central1-api' },
        { kind: 'auth.user', key: '|u' },
      ]),
    ).toEqual([{ kind: 'auth.user', key: '|u' }])
    expect(shortFunction('europe-west1-onOrder')).toBe('onOrder')
    expect(regionOfId('europe-west1-onOrder')).toBe('europe-west1')
  })

  it('steps to the newer and older kept row, past markers', () => {
    const store = createFeedStore<InvocationSummary>({ max: 10, key: (item) => item.id })
    store.push([invocation(1), invocation(2)])
    store.marker({ kind: 'marker', key: 'burst', text: '3 more' })
    store.push([invocation(3)])
    expect(neighbour(store, 'a3f9c1-2', 1)?.id).toBe('a3f9c1-3')
    expect(neighbour(store, 'a3f9c1-2', -1)?.id).toBe('a3f9c1-1')
    expect(neighbour(store, 'a3f9c1-3', 1)).toBeUndefined()
    expect(neighbour(store, 'gone', 1)).toBeUndefined()
    expect(kept(store, 'a3f9c1-3')?.seq).toBe(3)
    expect(kept(store, undefined)).toBeUndefined()
  })
})
