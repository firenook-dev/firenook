import { beforeEach, describe, expect, it } from 'vitest'
import {
  REQUEST_LIMIT,
  base64Utf8,
  bodyOf,
  byteLength,
  deadlineOf,
  delayOf,
  draftFrom,
  emptyDraft,
  enqueueBody,
  recentPayloads,
  rememberPayload,
  requestSize,
  sizeProblem,
  taskIdProblem,
  urlProblem,
} from './payload'
import { NOW, testDetail } from './fixtures.test-support'

/** Base64 of a string's UTF-8 bytes, written independently of the code under test. */
const b64 = (text: string) =>
  btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(''))

const PARTS = { project: 'demo-console', location: 'us-central1', id: 'processOrder' }

/** The request the Admin SDK sends for `task`, measured as express.json counts it. */
function sdkRequest(task: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify({ task })).length
}

describe('the Admin SDK body (U-12)', () => {
  it('wraps data as { data } and sends a raw body as it is', () => {
    expect(bodyOf({ sendAs: 'data', text: '{ "orderId": "o_1" }' })).toEqual({
      ok: true,
      value: '{"data":{"orderId":"o_1"}}',
    })
    expect(bodyOf({ sendAs: 'data', text: '  ' })).toEqual({ ok: true, value: '{}' })
    expect(bodyOf({ sendAs: 'data', text: '"text"' })).toEqual({
      ok: true,
      value: '{"data":"text"}',
    })
    expect(bodyOf({ sendAs: 'raw', text: '{ "a": [1, 2] }' })).toEqual({
      ok: true,
      value: '{"a":[1,2]}',
    })
  })

  it('says why text is not JSON, in the parser’s words', () => {
    const data = bodyOf({ sendAs: 'data', text: '{"orderId": }' })
    expect(data.ok).toBe(false)
    expect(!data.ok && data.message).toMatch(/^The data is not valid JSON: /)
    const raw = bodyOf({ sendAs: 'raw', text: '' })
    expect(raw).toEqual({ ok: false, message: 'A raw body needs some JSON.' })
  })

  it('encodes the body as base64 of its UTF-8 bytes', () => {
    expect(base64Utf8('{"data":{"orderId":"o_1"}}')).toBe(b64('{"data":{"orderId":"o_1"}}'))
    expect(base64Utf8('{"data":"héllo ✓"}')).toBe(b64('{"data":"héllo ✓"}'))
    expect(byteLength('✓')).toBe(3)
  })

  it('measures the request exactly as the Admin SDK would send it', () => {
    const draft = {
      ...emptyDraft(),
      text: '{"orderId":"o_1"}',
      id: 'order-1',
      headers: [{ name: 'x-synthetic-header', value: 'console' }],
      delay: '30',
      deadline: '120',
      url: 'http://127.0.0.1:5001/demo-console/us-central1/processOrder',
    }
    const body = '{"data":{"orderId":"o_1"}}'
    const expected = sdkRequest({
      httpRequest: {
        url: draft.url,
        oidcToken: { serviceAccountEmail: 'emulated-service-acct@email.com' },
        body: b64(body),
        headers: { 'Content-Type': 'application/json', 'x-synthetic-header': 'console' },
      },
      scheduleTime: new Date(NOW + 30_000).toISOString(),
      dispatchDeadline: '120s',
      name: 'projects/demo-console/locations/us-central1/queues/processOrder/tasks/order-1',
    })
    expect(requestSize(draft, PARTS, NOW)).toEqual({ ok: true, value: expected })
  })

  it('holds the request to 100 KiB, with the figure', () => {
    const big = { ...emptyDraft(), text: JSON.stringify('x'.repeat(100 * 1024)) }
    const size = requestSize(big, PARTS, NOW)
    expect(size.ok && size.value).toBeGreaterThan(REQUEST_LIMIT)
    expect(size.ok && sizeProblem(size.value)).toMatch(
      /^The Tasks port accepts requests up to 100 KiB, as express.json does; this one would be 13\d KiB\.$/,
    )
    expect(sizeProblem(REQUEST_LIMIT)).toBeUndefined()
  })

  it('checks ids, delays, deadlines and URLs the way the engine does', () => {
    expect(taskIdProblem('order-1_b')).toBeUndefined()
    expect(taskIdProblem('order 1')).toMatch(/letters, digits, hyphens and underscores/)
    expect(taskIdProblem('x'.repeat(501))).toBeDefined()
    expect(delayOf('')).toEqual({ ok: true, value: undefined })
    expect(delayOf('0')).toEqual({ ok: true, value: undefined })
    expect(delayOf('1.5')).toEqual({ ok: true, value: 1.5 })
    expect(delayOf('-1').ok).toBe(false)
    expect(deadlineOf('14').ok).toBe(false)
    expect(deadlineOf('1800')).toEqual({ ok: true, value: 1800 })
    expect(deadlineOf('20.5').ok).toBe(false)
    expect(urlProblem('ftp://x')).toBeDefined()
    expect(urlProblem('http://127.0.0.1:5001/x')).toBeUndefined()
    expect(urlProblem('')).toBeUndefined()
  })

  it('builds the console enqueue body from the draft', () => {
    expect(
      enqueueBody('queue:k', {
        ...emptyDraft(),
        text: ' {"a":1} ',
        id: ' order-1 ',
        headers: [
          { name: 'x-a', value: '1' },
          { name: '', value: 'ignored' },
        ],
        delay: '30',
        deadline: '',
      }),
    ).toEqual({
      queue: 'queue:k',
      data: '{"a":1}',
      name: 'order-1',
      headers: [{ name: 'x-a', value: '1' }],
      scheduleDelaySeconds: 30,
    })
    expect(enqueueBody('queue:k', { ...emptyDraft(), sendAs: 'raw', text: '[1]' })).toEqual({
      queue: 'queue:k',
      rawBody: '[1]',
      headers: [],
    })
  })

  it('prefills a copy from a task: its data, caller headers and deadline, never its name', () => {
    expect(draftFrom(testDetail())).toEqual({
      sendAs: 'data',
      text: '{\n  "orderId": "o_20251",\n  "fail": true\n}',
      id: '',
      headers: [{ name: 'x-synthetic-header', value: 'console' }],
      delay: '',
      deadline: '',
      url: '',
    })
    const raw = draftFrom(testDetail({ data: null, body: '[1,2]' }))
    expect(raw.sendAs).toBe('raw')
    expect(raw.text).toBe('[\n  1,\n  2\n]')
  })
})

describe('recent payloads (TK-43)', () => {
  beforeEach(() => localStorage.clear())

  it('keep the ten newest per queue, the same text once', () => {
    for (let index = 0; index < 12; index += 1)
      rememberPayload('queue:a', { sendAs: 'data', text: `{"n":${index}}` }, NOW + index)
    rememberPayload('queue:a', { sendAs: 'data', text: '{"n":5}' }, NOW + 20)
    const kept = recentPayloads('queue:a')
    expect(kept).toHaveLength(10)
    expect(kept[0]?.text).toBe('{"n":5}')
    expect(kept.filter((entry) => entry.text === '{"n":5}')).toHaveLength(1)
    expect(recentPayloads('queue:b')).toEqual([])
  })

  it('ignore what another version stored', () => {
    localStorage.setItem('firenook.console.tasks.payloads.queue:a', '{"not":"a list"}')
    expect(recentPayloads('queue:a')).toEqual([])
  })
})
